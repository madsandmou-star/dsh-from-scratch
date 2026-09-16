// 阶段 7.3：把装配拆成插件。
//
// 到 7.2 为止，`index.ts` 和 `headless.ts` 各自抄了一遍装配（17 行，81%）。
// 这个文件把那 17 行拆成六个插件，两个入口共用同一份清单。
//
// 每个插件只回答一个问题："我往这个应用里加什么"。它们都不认识别人，
// 只认识自己那一样东西，以及它需要从 ctx 上读什么。

import { join } from 'node:path'
import { Context } from './cordis.ts'
import { loadConfig } from './config.ts'
import { accounting, outputBackstop, readOnlyGuard, readOnlyNotice } from './guard.ts'
import type { Guard } from './pipeline.ts'
import { Session } from './session.ts'
import {
  SESSION_FORMAT_VERSION, attachJsonlPersistence, listSessions, loadSession,
  newSessionId, repairLog, sessionLogPath,
} from './persistence.ts'
import type { SessionPersistence } from './persistence.ts'
import { PERSONA_SECTION, PERSONA_ORDER, PromptRegistry, identitySection } from './system-prompt.ts'
import { toolGuidanceSection } from './tool.ts'
import type { ResolvedConfig } from './config.ts'

/**
 * 声明这些插件会往 `Context` 上加什么。
 *
 * 这个语法叫 **declaration merging**：同名的 `interface` 会被合并，
 * 所以这里写的字段会长到 `cordis.ts` 里那个 `Context` 类上去，而不用去改那个文件。
 * **插件自己声明自己的贡献**——这正是插件系统该有的方向。
 *
 * 阶段 8 会看到 dsh 用同一个手法声明服务；那时每个包都在自己的文件里
 * 往 `Context` 上加一行，核心包一个字都不用改。
 */
declare module './cordis.ts' {
  interface Context {
    /** 解析好的配置（{@link configPlugin} 提供）。 */
    config: ResolvedConfig
    /** system prompt 注册表（{@link promptPlugin} 提供）。 */
    prompt: PromptRegistry
    /** 这次装配启用的护栏，按求值顺序（{@link guardsPlugin} 提供）。 */
    guards: readonly Guard[]
    /** 这次会话的事件日志（{@link sessionPlugin} 提供）。 */
    session: Session
    /** 会话 id（{@link sessionPlugin} 提供）。 */
    sessionId: string
    /** 日志文件路径（{@link sessionPlugin} 提供）。 */
    logPath: string
    /** 刷盘与关闭的手柄（{@link persistencePlugin} 提供）。 */
    persistence: SessionPersistence
  }
}

/** 会话日志存在工作目录下——"上次我们在这个仓库里聊到哪"是和仓库绑定的事实。 */
export const SESSION_ROOT = join(process.cwd(), '.dsh-learn', 'sessions')

/** 读配置。它不依赖任何东西，所以排在链条最前面。 */
export function configPlugin(ctx: Context): void {
  ctx.config = loadConfig()
}

/**
 * 组装 system prompt（5.1–5.3）。
 *
 * 注意它只**读** `ctx.config`，不关心那份配置是谁提供的、从哪来的。
 * 这就是拆插件买到的东西：换一个从环境变量读配置的 `configPlugin`，这里一个字不用改。
 */
export function promptPlugin(ctx: Context): void {
  const prompt = new PromptRegistry()
  prompt.variable('cwd', () => process.cwd())
  prompt.variable('model', () => ctx.config.model)
  prompt.register(identitySection)
  prompt.register({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: ctx.config.systemPrompt })
  prompt.register(toolGuidanceSection)
  prompt.register(readOnlyNotice(ctx.config.readOnly))
  prompt.context({
    name: 'time',
    order: 0,
    text: () => `现在是 ${new Date().toISOString()}。`,
  })
  ctx.prompt = prompt
}

/** 这次装配启用哪些护栏（4.4）。顺序就是执行前钩子的求值顺序。 */
export function guardsPlugin(ctx: Context): void {
  ctx.guards = [accounting(ctx.config.accounting), readOnlyGuard(ctx.config.readOnly), outputBackstop()]
}

/**
 * 建会话，或者读回要续的那个（6.1–6.4）。
 *
 * `--resume` 的解析放在这里而不是入口文件里：**它是会话这件事的一部分**，
 * 不是某个入口特有的。headless 入口只是不传这个参数而已。
 */
export function sessionPlugin(ctx: Context): void {
  const resumeId = resumeTarget()
  ctx.sessionId = resumeId ?? newSessionId()
  ctx.logPath = sessionLogPath(SESSION_ROOT, ctx.sessionId)
  ctx.session = resumeId === undefined ? new Session() : new Session(loadAndRepair(ctx.logPath))
}

/**
 * 解析 `--resume [id]`。不带 id 就是"续最近的那次"。
 * @returns 要续的会话 id；不续就是 undefined。
 * @throws `--resume` 指定了 id 但那个会话不存在，或者一次都没聊过。
 */
function resumeTarget(): string | undefined {
  const index = process.argv.indexOf('--resume')
  if (index === -1) return undefined
  const explicit = process.argv[index + 1]
  // 下一个参数以 `-` 开头的话，它是另一个选项，不是 id。
  if (explicit !== undefined && !explicit.startsWith('-')) return explicit
  const latest = listSessions(SESSION_ROOT)[0]
  if (latest === undefined) throw new Error(`${SESSION_ROOT} 下还没有任何会话，没有可以续的。`)
  return latest
}

/**
 * 读回日志，顺便修掉末尾的崩溃残骸（6.4）。
 *
 * 修在这里同步做完，因为 `apply` 是同步的，而**修必须发生在挂持久化之前**：
 * 不截断就追加会把一次可恢复的崩溃变成永久损坏。
 * @param logPath - 日志文件路径。
 * @returns 读回来的事件。
 */
function loadAndRepair(logPath: string): ReturnType<typeof loadSession>['events'] {
  const loaded = loadSession(logPath)
  if (loaded.tornBytes > 0) {
    console.error(`[修复] 日志末尾有 ${loaded.tornBytes} 字节没写完的残骸（多半是上次被强杀），已丢弃。`)
    // 同步 apply 里发不出 await，但下一个插件才会挂持久化，所以这个 promise
    // 一定在第一次写之前完成——它俩之间没有任何 await。
    void repairLog(logPath, loaded.committedBytes)
  }
  return loaded.events
}

/** 把会话挂到磁盘上（6.2–6.3）。它要读 session 和 logPath，所以排在会话后面。 */
export function persistencePlugin(ctx: Context): void {
  const isNew = ctx.session.events.length === 0
  ctx.persistence = attachJsonlPersistence(ctx.session, ctx.logPath, isNew
    ? { type: 'session', version: SESSION_FORMAT_VERSION, id: ctx.sessionId, createdAt: Date.now(), cwd: process.cwd() }
    : undefined)
}

/**
 * 两个入口共用的那份清单，**按依赖顺序**排列。
 *
 * 顺序是手写的，因为兄弟插件互相看不见（7.2），只能靠嵌套让后面的读到前面的。
 * 阶段 8 的 `inject` 会让这个数组的顺序变得无所谓。
 */
export const corePlugins = [
  configPlugin,
  promptPlugin,
  guardsPlugin,
  sessionPlugin,
  persistencePlugin,
] as const
