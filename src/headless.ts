// 阶段 7.1：第二个入口——跑一次任务就退出，不进交互循环。
//
// 跑它：
//   node --import tsx src/headless.ts "把 a.txt 抄到 b.txt"
//
// XXX(阶段 7.3)：这个文件的上半截是从 src/index.ts **抄过来的**。
// 抄的是"装配"：读配置、拼护栏、注册 system prompt 段落、建会话、挂持久化。
// 它和 index.ts 那一段除了不支持 --resume 之外一模一样。
//
// 这就是阶段 7 要解决的痛：**每个部件都必须被入口文件亲自认识**。
// 加第七个工具、加一道护栏、加一段 system prompt，都要在这里和 index.ts 里各改一遍，
// 而漏改一处的表现是"某个入口少了一个功能"——没有任何东西会报错。
// 7.3 把这段拆成插件之后，这个文件会缩到十几行。

import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { chatStream } from './llm.ts'
import { accounting, outputBackstop, readOnlyGuard, readOnlyNotice } from './guard.ts'
import { runTool } from './pipeline.ts'
import { Session, deriveMessages } from './session.ts'
import { SESSION_FORMAT_VERSION, attachJsonlPersistence, newSessionId, sessionLogPath } from './persistence.ts'
import { PERSONA_SECTION, PERSONA_ORDER, PromptRegistry, CONTEXT_CLEARED, identitySection } from './system-prompt.ts'
import { tools, toolGuidanceSection } from './tool.ts'
import type { ToolCall } from './types.ts'

// ── 装配开始：以下全部抄自 src/index.ts ──────────────────────────────
const config = loadConfig()

const guards = [accounting(config.accounting), readOnlyGuard(config.readOnly), outputBackstop()]

const prompt = new PromptRegistry()
prompt.variable('cwd', () => process.cwd())
prompt.variable('model', () => config.model)
prompt.register(identitySection)
prompt.register({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: config.systemPrompt })
prompt.register(toolGuidanceSection)
prompt.register(readOnlyNotice(config.readOnly))
prompt.context({
  name: 'time',
  order: 0,
  text: () => `现在是 ${new Date().toISOString()}。`,
})

const SESSION_ROOT = join(process.cwd(), '.dsh-learn', 'sessions')
const sessionId = newSessionId()
const logPath = sessionLogPath(SESSION_ROOT, sessionId)
const session = new Session()
const persistence = attachJsonlPersistence(session, logPath, {
  type: 'session', version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: Date.now(), cwd: process.cwd(),
})
// ── 装配结束 ───────────────────────────────────────────────────────

const MAX_STEPS = 10

/** 这个入口只跑一个 turn，跑完就退出。 */
async function runOnce(input: string): Promise<void> {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', { text: input })

  for (let step = 1; step <= MAX_STEPS; step++) {
    const snapshot = prompt.assembleContext()
    session.append('context/snapshot', { text: snapshot === '' ? CONTEXT_CLEARED : snapshot })
    await persistence.flush()

    let text = ''
    let toolCalls: ToolCall[] = []
    for await (const event of chatStream(deriveMessages(session.events, prompt.assemble()), config)) {
      if (event.type === 'text') { process.stdout.write(event.text); text += event.text; continue }
      toolCalls = event.calls
    }

    session.append('assistant/message', {
      turn: 1, step,
      text: text === '' ? null : text,
      ...toolCalls.length === 0 ? {} : { toolCalls },
    })
    if (toolCalls.length === 0) { console.log(); return }

    for (const call of toolCalls) {
      console.error(`  [工具] ${call.name}(${call.arguments})`)
      session.append('tool/call', { callId: call.id, name: call.name, arguments: call.arguments })
      await persistence.flush()
      const result = await runTool(call.name, call.arguments, guards)
      session.append('tool/result', { callId: call.id, content: result })
    }
  }
  console.error(`\n[已达最大步数 ${MAX_STEPS}，停止]`)
}

const task = process.argv.slice(2).join(' ').trim()
if (task === '') {
  console.error('用法：node --import tsx src/headless.ts "要做的事"')
  process.exit(2)
}
await runOnce(task)
await persistence.close()
