// 一次性任务入口：跑一个任务就退出，不进交互循环。
//
// 跑它：
//   node --import tsx src/headless.ts "把 a.txt 抄到 b.txt"
//
// 7.1 写下它的时候，上半截是从 index.ts 抄的——17 行，占这个文件的 81%。
// 7.3 之后那 17 行全在 plugins.ts 里，两个入口共用同一份 corePlugins。
// 这里只剩下这个入口自己特有的东西：读命令行参数，跑一个 turn，退出。

import { Context } from './cordis.ts'
import { assemble } from './plugins.ts'
import { chatStream } from './llm.ts'
import { runTool } from './pipeline.ts'
import { deriveMessages } from './session.ts'
import { CONTEXT_CLEARED } from './system-prompt.ts'
import type { ToolCall } from './types.ts'

const MAX_STEPS = 10

/**
 * 跑一个 turn，跑完关掉持久化。
 * @param ctx - 装配完成的 context。
 * @param input - 要做的事。
 */
async function runOnce(ctx: Context, input: string): Promise<void> {
  ctx.session.append('turn/start', { turn: 1 })
  ctx.session.append('user/message', { text: input })

  for (let step = 1; step <= MAX_STEPS; step++) {
    const snapshot = ctx.prompt.assembleContext()
    ctx.session.append('context/snapshot', { text: snapshot === '' ? CONTEXT_CLEARED : snapshot })
    await ctx.persistence.flush()

    let text = ''
    let toolCalls: ToolCall[] = []
    for await (const event of chatStream(deriveMessages(ctx.session.events, ctx.prompt.assemble()), ctx.config)) {
      if (event.type === 'text') { process.stdout.write(event.text); text += event.text; continue }
      toolCalls = event.calls
    }

    ctx.session.append('assistant/message', {
      turn: 1, step,
      text: text === '' ? null : text,
      ...toolCalls.length === 0 ? {} : { toolCalls },
    })
    if (toolCalls.length === 0) { console.log(); break }

    for (const call of toolCalls) {
      console.error(`  [工具] ${call.name}(${call.arguments})`)
      ctx.session.append('tool/call', { callId: call.id, name: call.name, arguments: call.arguments })
      await ctx.persistence.flush()
      const result = await runTool(call.name, call.arguments, ctx.guards)
      ctx.session.append('tool/result', { callId: call.id, content: result })
    }
  }

  await ctx.dispose()
}

/** 这条链的最后一环：读命令行参数，跑一次。 */
function headless(ctx: Context): void {
  const task = process.argv.slice(2).filter(arg => !arg.startsWith('-')).join(' ').trim()
  if (task === '') {
    console.error('用法：node --import tsx src/headless.ts "要做的事"')
    process.exit(2)
  }
  void runOnce(ctx, task)
}

export const root = new Context()
root.plugin(assemble(headless))
// 装配现在可能是异步的（8.3）：等它真正完成。任何插件 apply 抛的错都从这里出来。
await root.ready()
