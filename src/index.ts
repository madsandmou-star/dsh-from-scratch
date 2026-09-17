// 交互式 CLI 入口。
//
// 跑它：
//   export DEEPSEEK_API_KEY=sk-...
//   node --import tsx src/index.ts
//   node --import tsx src/index.ts --resume     # 续上最近一次会话
//
// 退出：输入 /exit，或按 Ctrl-C。
//
// 阶段 7.3 之后，这个文件里**没有装配**：配置、system prompt、护栏、会话、
// 持久化全是插件，和 headless.ts 共用同一份 corePlugins 清单。
// 这里只剩下这个入口自己特有的东西：一个 readline 循环。

import { createInterface } from 'node:readline/promises'
import { Context } from './cordis.ts'
import { assemble } from './plugins.ts'
import { chatStream } from './llm.ts'
import { runTool } from './pipeline.ts'
import { deriveMessages, summarizeEvent } from './session.ts'
import { CONTEXT_CLEARED } from './system-prompt.ts'
import { tools } from './tool.ts'
import type { ToolCall } from './types.ts'

/**
 * 一个 turn 里最多允许多少个 step。
 *
 * 防的是"模型反复调工具但永远不给最终回答"——它可能陷在一个自己看不出来的循环里
 * （读 A 发现要读 B，读 B 发现要读 A）。没有这个上限，agent 会一直烧钱直到你按 Ctrl-C。
 */
const MAX_STEPS = 10

/**
 * 交互式主循环。它是这条插件链的最后一环，所以 ctx 上已经有全部装配结果。
 * @param ctx - 装配完成的 context。
 */
function cli(ctx: Context): void {
  // 最有用的一个 debug 开关：agent 行为不对时，先看它到底收到了什么 system prompt。
  if (process.env['DSH_SHOW_PROMPT'] !== undefined) {
    console.error('[system prompt 清单]')
    for (const item of ctx.prompt.inventory()) console.error(`  ${String(item.order).padStart(5)}  ${item.name}  (${item.chars} 字符)${item.active ? '' : '  ← 未生效'}`)
    console.error(`--- 拼出来的 system prompt（${ctx.prompt.assemble().length} 字符）---\n${ctx.prompt.assemble()}\n---`)
  }

  // 只在交互式终端里报会话 id：它是给人看的、方便复制的东西。
  // 管道运行（演示脚本、CI）不打，否则每次跑出来的文字都因为 id 不同而不一样。
  if (process.stdin.isTTY === true) {
    console.error(ctx.session.events.length === 0
      ? `[会话 ${ctx.sessionId}]  下次接着聊：npm run dev -- --resume`
      : `[续上会话 ${ctx.sessionId}]  已读回 ${ctx.session.events.length} 条事件`)
  }

  void loop(ctx)
}

/**
 * 一个**语义检查点**：这里之前的事件必须真的在盘上，才能往下走（6.3）。
 * @param ctx - 装配完成的 context。
 * @throws 写盘失败时抛出，调用方因此不会执行下一步（fail-closed）。
 */
async function checkpoint(ctx: Context): Promise<void> {
  // 只为演示存在的开关：关掉检查点，好让 06-checkpoints.mjs 对照出差别。
  if (process.env['DSH_NO_CHECKPOINT'] !== undefined) return
  await ctx.persistence.flush()
}

/**
 * 上一次发出去的快照文本，**从日志里查**而不是记在旁边（6.1）。
 * @param ctx - 装配完成的 context。
 * @returns 最后一条快照的文本；从来没发过就是 undefined。
 */
function lastSnapshotInLog(ctx: Context): string | undefined {
  for (let i = ctx.session.events.length - 1; i >= 0; i--) {
    const event = ctx.session.events[i]
    if (event?.type === 'context/snapshot') return event.data.text
  }
  return undefined
}

/**
 * 如果这一轮的快照和上次发出去的不一样，就往日志里追加一条（5.3）。
 * @param ctx - 装配完成的 context。
 */
function appendContextSnapshot(ctx: Context): void {
  const snapshot = ctx.prompt.assembleContext()
  // 从"有"变成"没有"时要显式说一声。什么都不发的话，模型会继续拿旧快照当真。
  const toSend = snapshot === '' ? CONTEXT_CLEARED : snapshot
  const previous = lastSnapshotInLog(ctx)
  if (toSend === previous) return
  if (snapshot === '' && previous === undefined) return   // 从来没有过上下文，不用宣布"没有了"
  ctx.session.append('context/snapshot', { text: toSend })
}

/**
 * 从日志里查出上一个 turn 编号（6.2）。
 * @param ctx - 装配完成的 context。
 * @returns 最后一个 turn 的编号；一次都没聊过就是 0。
 */
function lastTurnInLog(ctx: Context): number {
  for (let i = ctx.session.events.length - 1; i >= 0; i--) {
    const event = ctx.session.events[i]
    if (event?.type === 'turn/start') return event.data.turn
  }
  return 0
}

/**
 * 跑完一个 turn：不断执行 step，直到模型不再要求调用工具。
 *
 * 一个 **step** = 一次模型请求 + 它这一轮要求的工具执行（1.4 定义过）。
 * 一个 **turn** = 从一条用户输入开始，到没有任何未了结的事为止。
 * @param ctx - 装配完成的 context。
 * @param turn - 这是第几个 turn。
 * @param input - 用户这一轮说的话。
 */
async function runTurn(ctx: Context, turn: number, input: string): Promise<void> {
  // turn/start 先落，用户那句话再落：日志的顺序就是发生的顺序，
  // 一个 turn 里的所有事件都排在它的 turn/start 后面。阶段 12 靠这条边界回退。
  ctx.session.append('turn/start', { turn })
  ctx.session.append('user/message', { text: input })
  for (let step = 1; step <= MAX_STEPS; step++) {
    // 快照在**每个 step 之前**重算：一个 turn 可能跑十分钟，时间早就变了。
    appendContextSnapshot(ctx)

    // 检查点①：发请求之前，把这次请求依据的整段日志刷到盘上（6.3）。
    // 理由不是"怕丢"，是**因果顺序**：模型的回答是这段历史的后果，
    // 后果不能比原因先落盘。刷失败就不发——fail-closed，异常向上抛。
    await checkpoint(ctx)

    process.stdout.write(`\n模型 > `)
    let text = ''
    let toolCalls: ToolCall[] = []

    // 每一步都重新投影一次：日志变了，发出去的东西才跟着变。
    const messages = deriveMessages(ctx.session.events, ctx.prompt.assemble())

    for await (const event of chatStream(messages, ctx.config)) {
      if (event.type === 'text') {
        process.stdout.write(event.text)
        text += event.text
        continue
      }
      toolCalls = event.calls
    }

    // 把模型这一轮的产出记进日志。content 可能是 null——模型只调工具不说话时就是这样。
    ctx.session.append('assistant/message', {
      turn, step,
      text: text === '' ? null : text,
      ...toolCalls.length === 0 ? {} : { toolCalls },
    })

    // 模型没要求调工具 = 它给出了最终回答 = 这个 turn 结束了。
    if (toolCalls.length === 0) { console.log(); return }

    // 执行这一轮的每个工具，结果作为 tool 消息喂回历史。
    for (const call of toolCalls) {
      console.log(`\n  [工具] ${call.name}(${call.arguments})`)
      // 先记"开始了"，再记结果。两条分开，才分得清"从没开始"和"开始了但没结果"——
      // 投影补齐时要靠这个区分说出不同的话。
      ctx.session.append('tool/call', { callId: call.id, name: call.name, arguments: call.arguments })
      // 检查点②：跑工具之前，把这条 tool/call 刷到盘上（6.3）。
      // 只有"我要开始跑了"先落盘，崩溃之后才分得清
      // TOOL_OUTCOME_UNKNOWN（可能已经改了磁盘）和 TOOL_NOT_STARTED（重试安全）。
      await checkpoint(ctx)
      const result = await runTool(call.name, call.arguments, ctx.guards)
      // 摘要归工具自己管：通用的"取首行"对 bash 没用（首行可能是 `[stderr]`）。
      const oneLine = tools.find(t => t.name === call.name)?.summarize?.(result) ?? result.split('\n')[0] ?? ''
      console.log(`         → ${oneLine.slice(0, 90)}${oneLine.length > 90 ? ' …' : ''}`)
      ctx.session.append('tool/result', { callId: call.id, content: result })
    }
    // 带着工具结果再问一轮 —— 这就是 tool loop。
  }

  console.error(`\n[已达最大步数 ${MAX_STEPS}，停止本轮]`)
}

/**
 * 读一行、跑一个 turn、再读一行，直到 `/exit` 或 stdin 结束。
 *
 * 用 `for await (const line of rl)` 迭代输入行，而不是反复调 `rl.question()`：
 * question() 在 stdin 结束后就不能再用了（会抛 ERR_USE_AFTER_CLOSE），
 * 而迭代写法对交互式终端和管道输入（`echo "你好" | npm run dev`）都成立。
 * @param ctx - 装配完成的 context。
 */
async function loop(ctx: Context): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  process.stdout.write('\n你 > ')

  let turn = lastTurnInLog(ctx)
  for await (const line of rl) {
    const input = line.trim()
    if (input === '/exit') break
    if (input === '') { process.stdout.write('\n你 > '); continue }

    try {
      await runTurn(ctx, ++turn, input)
    } catch (error) {
      // 中断了就是中断了——**日志不回滚**（6.1）。日志照样记着"模型要求过这个调用"，
      // deriveMessages() 会在投影时给没有结果的调用补一条合成的结果。
      console.error(`\n[本轮中断] ${error instanceof Error ? error.message : String(error)}`)
    }
    process.stdout.write('\n你 > ')
  }

  rl.close()
  // 退出前最后刷一次：200ms 的批处理里可能还压着最后几条事件。
  await ctx.persistence.close()

  // 6.1 之后最有用的 debug 开关：把**日志**和**它的投影**并排打出来。
  // 两边对不上时，错的几乎总是投影规则，而不是日志。
  if (process.env['DSH_DUMP_LOG'] !== undefined) {
    console.error(`\n[会话日志] ${ctx.session.events.length} 条 —— 发生了什么（权威）`)
    for (const event of ctx.session.events) {
      console.error(`  ${String(event.seq).padStart(3)}  ${event.type.padEnd(18)} ${summarizeEvent(event).slice(0, 80)}`)
    }
    const projected = deriveMessages(ctx.session.events, ctx.prompt.assemble())
    console.error(`\n[投影出来的 messages] ${projected.length} 条 —— 发给模型什么`)
    for (const message of projected) {
      console.error(`       ${message.role.padEnd(18)} ${String(message.content ?? '(null)').replace(/\n/g, ' ⏎ ').slice(0, 80)}`)
    }
  }
}

// 整个入口就这三行：造一个根 context，按顺序装上共用的插件，最后挂自己的循环。
// 插件树可以打出来看：见 demos/07-cordis/05-assembled.mjs。
export const root = new Context()
root.plugin(assemble(cli))
