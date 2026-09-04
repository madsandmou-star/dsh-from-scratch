// 阶段 1.4：多轮对话 CLI —— 这门课的第一个"循环"。
//
// 跑它：
//   export DEEPSEEK_API_KEY=sk-...
//   node --import tsx src/index.ts
//
// 退出：输入 /exit，或按 Ctrl-C。

import { createInterface } from 'node:readline/promises'
import { loadConfig } from './config.ts'
import { chatStream } from './llm.ts'
import { accounting, outputBackstop, readOnlyGuard, readOnlyNotice } from './guard.ts'
import { runTool } from './pipeline.ts'
import { Session, deriveMessages, summarizeEvent } from './session.ts'
import { PERSONA_SECTION, PERSONA_ORDER, PromptRegistry, CONTEXT_CLEARED, identitySection } from './system-prompt.ts'
import { tools, toolGuidanceSection } from './tool.ts'
import type { ToolCall } from './types.ts'

const config = loadConfig()

// 这一次装配启用哪些护栏——顺序就是执行前钩子的求值顺序。
// 换一套护栏不用改任何工具，也不用改这个循环：这就是 4.4 把它们抽出来的意义。
const guards = [accounting(config.accounting), readOnlyGuard(config.readOnly), outputBackstop()]

// system prompt 也是装配出来的（5.1）：每个部件塞一段自己的话，按 顺序 拼起来。
// 注意这里没有一个地方"知道"最终的 prompt 长什么样——它是这几行的和。
const prompt = new PromptRegistry()
// 变量的取值函数在**每次组装**时才跑：cwd 会变（阶段 13 支持换目录），
// 而且测试里换掉这个函数就能把它固定住，不用去 monkeypatch process。
prompt.variable('cwd', () => process.cwd())
prompt.variable('model', () => config.model)
prompt.register(identitySection)
prompt.register({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: config.systemPrompt })
prompt.register(toolGuidanceSection)
prompt.register(readOnlyNotice(config.readOnly))

// 动态上下文（5.3）：每轮都可能变的事实。它们**不进 system prompt**——
// 三个理由见 docs/05-system-prompt/03-runtime-context/。
prompt.context({
  name: 'time',
  order: 0,
  text: () => `现在是 ${new Date().toISOString()}。`,
})

// 最有用的一个 debug 开关：agent 行为不对时，先看它到底收到了什么 system prompt。
if (process.env['DSH_SHOW_PROMPT'] !== undefined) {
  console.error('[system prompt 清单]')
  for (const item of prompt.inventory()) console.error(`  ${String(item.order).padStart(5)}  ${item.name}  (${item.chars} 字符)${item.active ? '' : '  ← 未生效'}`)
  console.error(`--- 拼出来的 system prompt（${prompt.assemble().length} 字符）---\n${prompt.assemble()}\n---`)
}

// 模型本身是无状态的：它不记得上一次你说了什么。
// 所谓"多轮对话"，就是每一轮都把**整个历史**重新发一遍。
// 这也是为什么长对话会越来越贵、越来越慢——阶段 16 讲 compaction 时会回到这里。
// 阶段 6.1：日志是权威，messages 是它的投影。
// 到阶段 5 为止这里是一个 messages 数组，它同时是请求内容、显示内容和历史记录。
// 现在换成一条只增不改的事件日志：发生什么就 append 一条，
// 每次要发请求时再 deriveMessages() 投影一次。
const session = new Session()

// readline 接口。用 `for await (const line of rl)` 迭代输入行，而不是反复调 rl.question()：
// question() 在 stdin 结束后就不能再用了（会抛 ERR_USE_AFTER_CLOSE），
// 而迭代写法对交互式终端和管道输入（`echo "你好" | npm run dev`）都成立。
const rl = createInterface({ input: process.stdin, output: process.stdout })

process.stdout.write('\n你 > ')

/**
 * 一个 turn 里最多允许多少个 step。
 *
 * 防的是"模型反复调工具但永远不给最终回答"——它可能陷在一个自己看不出来的循环里
 * （读 A 发现要读 B，读 B 发现要读 A）。没有这个上限，agent 会一直烧钱直到你按 Ctrl-C。
 */
const MAX_STEPS = 10

/**
 * 跑完一个 turn：不断执行 step，直到模型不再要求调用工具。
 *
 * 一个 **step** = 一次模型请求 + 它这一轮要求的工具执行（1.4 定义过）。
 * 一个 **turn** = 从一条用户输入开始，到没有任何未了结的事为止。
 * 阶段 1 的每个 turn 只有一个 step；工具循环让"一个 turn 多个 step"第一次真的发生。
 */
/**
 * 上一次发出去的快照文本，**从日志里查**而不是记在旁边。
 *
 * 5.3 那版用一个变量记它，结果错误回滚会把日志里那条弹掉、变量却还记着，两边对不上。
 * 现在日志只增不改，倒着找一条就是权威答案——那个变量连同它的 bug 一起消失了。
 * @returns 最后一条快照的文本；从来没发过就是 undefined。
 */
function lastSnapshotInLog(): string | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event?.type === 'context/snapshot') return event.data.text
  }
  return undefined
}

/**
 * 如果这一轮的快照和上次发出去的不一样，就往日志里追加一条。
 *
 * 一样就什么都不做——**每轮重发一份一模一样的快照，是在白烧 token**，
 * 而且会让模型以为"又有新情况了"。
 */
function appendContextSnapshot(): void {
  const snapshot = prompt.assembleContext()
  // 从"有"变成"没有"时要显式说一声。什么都不发的话，模型会继续拿旧快照当真。
  const toSend = snapshot === '' ? CONTEXT_CLEARED : snapshot
  const previous = lastSnapshotInLog()
  if (toSend === previous) return
  if (snapshot === '' && previous === undefined) return   // 从来没有过上下文，不用宣布"没有了"
  session.append('context/snapshot', { text: toSend })
}

async function runTurn(turn: number, input: string): Promise<void> {
  // turn/start 先落，用户那句话再落：日志的顺序就是发生的顺序，
  // 一个 turn 里的所有事件都排在它的 turn/start 后面。阶段 12 靠这条边界回退。
  session.append('turn/start', { turn })
  session.append('user/message', { text: input })
  for (let step = 1; step <= MAX_STEPS; step++) {
    // 快照在**每个 step 之前**重算：一个 turn 可能跑十分钟，时间早就变了。
    appendContextSnapshot()
    process.stdout.write(`\n模型 > `)
    let text = ''
    let toolCalls: ToolCall[] = []

    // 每一步都重新投影一次：日志变了，发出去的东西才跟着变。
    const messages = deriveMessages(session.events, prompt.assemble())

    for await (const event of chatStream(messages, config)) {
      if (event.type === 'text') {
        process.stdout.write(event.text)
        text += event.text
        continue
      }
      toolCalls = event.calls
    }

    // 把模型这一轮的产出记进日志。content 可能是 null——模型只调工具不说话时就是这样。
    session.append('assistant/message', {
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
      session.append('tool/call', { callId: call.id, name: call.name, arguments: call.arguments })
      const result = await runTool(call.name, call.arguments, guards)
      // 摘要归工具自己管：通用的"取首行"对 bash 没用（首行可能是 `[stderr]`）。
      const oneLine = tools.find(t => t.name === call.name)?.summarize?.(result) ?? result.split('\n')[0] ?? ''
      console.log(`         → ${oneLine.slice(0, 90)}${oneLine.length > 90 ? ' …' : ''}`)
      session.append('tool/result', { callId: call.id, content: result })
    }
    // 带着工具结果再问一轮 —— 这就是 tool loop。
  }

  console.error(`\n[已达最大步数 ${MAX_STEPS}，停止本轮]`)
}

let turn = 0
for await (const line of rl) {
  const input = line.trim()
  if (input === '/exit') break
  if (input === '') { process.stdout.write('\n你 > '); continue }

  try {
    await runTurn(++turn, input)
  } catch (error) {
    // 中断了就是中断了——**日志不回滚**。1.4 那版在这里 pop 掉几条消息，
    // 一次抹掉了请求内容、显示内容和历史记录三样东西。
    // 现在日志照样记着"模型要求过这个调用"，而 deriveMessages() 会在投影时
    // 给没有结果的调用补一条合成的结果，让发出去的 messages 重新合法。
    console.error(`\n[本轮中断] ${error instanceof Error ? error.message : String(error)}`)
  }
  process.stdout.write('\n你 > ')
}

rl.close()

// 6.1 之后最有用的 debug 开关：把**日志**和**它的投影**并排打出来。
//
//   DSH_DUMP_LOG=1 npm run dev
//
// 两边对不上时，错的几乎总是投影规则，而不是日志——日志只增不改，
// 它记的就是真的发生过的事；messages 是一个函数的输出，函数才会写错。
// 具体到怎么读这两栏，见 docs/06-session/01-event-log/01-event-log.md。
if (process.env['DSH_DUMP_LOG'] !== undefined) {
  console.error(`\n[会话日志] ${session.events.length} 条 —— 发生了什么（权威）`)
  for (const event of session.events) {
    console.error(`  ${String(event.seq).padStart(3)}  ${event.type.padEnd(18)} ${summarizeEvent(event).slice(0, 80)}`)
  }
  const projected = deriveMessages(session.events, prompt.assemble())
  console.error(`\n[投影出来的 messages] ${projected.length} 条 —— 发给模型什么`)
  for (const message of projected) {
    console.error(`       ${message.role.padEnd(18)} ${String(message.content ?? '(null)').replace(/\n/g, ' ⏎ ').slice(0, 80)}`)
  }
}
