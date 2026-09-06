// 阶段 6.2：把事件日志写到磁盘，重启能续。
//
// 6.1 的日志活在内存里。进程一退，十二条事件全没了——连那条
// TOOL_OUTCOME_UNKNOWN 的补齐规则都用不上：能触发它的崩溃同时带走了日志本身。
//
// 落盘格式选 JSONL：**一行一条 JSON**，而不是一个大 JSON 数组。理由见讲义，
// 一句话是——追加一条事件只要 `appendFileSync(一行)`，不用把整个文件读回来、
// 改一改、再整个写回去。

import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Session, SessionEvent } from './session.ts'

/**
 * 磁盘格式的版本号。
 *
 * 它回答一个问题：**读到一个不认识的日志时，是该猜着读，还是该拒绝？**
 * 答案是拒绝——猜错的代价是把一段历史悄悄读歪，而那正是这套设计要杜绝的。
 * 只有**结构性**的改动才动它（比如事件包装从 `{type,seq,time,data}` 变形）；
 * 往 `SessionEventMap` 里加一个新事件类型不算，6.4 会讲为什么。
 */
export const SESSION_FORMAT_VERSION = 0

/** 日志文件的第一行：这次会话的不可变元信息。 */
export interface SessionHeader {
  /** 固定为 `'session'`，让读的人一眼分得清头和事件行。 */
  type: 'session'
  version: number
  id: string
  /** Unix 毫秒。 */
  createdAt: number
  /** 这次会话在哪个目录里跑的。同一个 id 在不同项目下是不同的会话。 */
  cwd: string
}

/** 会话 id 的合法写法：日期 + 随机后缀，只含这几种字符。 */
const SESSION_ID = /^[0-9a-z-]{1,64}$/

/**
 * 生成一个新的会话 id。
 *
 * 前半截是可读的时间戳，方便你在 `ls` 里一眼找到"昨天下午那次"；
 * 后半截是随机数，防止同一秒起两个会话时撞名。
 * @returns 形如 `20260906-1030-4f2a` 的 id。
 */
export function newSessionId(): string {
  // 2026-09-06T15:12:51.300Z → 20260906-1512
  const iso = new Date().toISOString()
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 16).replace(':', '')}`
  return `${stamp}-${Math.random().toString(16).slice(2, 6)}`
}

/**
 * 把会话 id 变成日志文件路径。
 *
 * **id 在这里是不可信输入**——`--resume` 后面跟的东西来自命令行。
 * 不检查的话，`--resume ../../../etc/passwd` 会让我们去读（将来还会写）仓库外的文件。
 * 我们的做法是**拒绝**任何不合规的 id；dsh 的做法是把任意 id 无损转义成一个安全段
 * （`dsh/packages/session/session-persistence-jsonl/src/format.ts` 的 `encodeSegment`），
 * 因为它的 id 可能来自别的系统，不能要求对方守我们的规矩。
 * @param root - 存放会话的根目录。
 * @param id - 会话 id。
 * @returns 该会话的 JSONL 路径。
 * @throws id 不合法时抛错，绝不拼进路径。
 */
export function sessionLogPath(root: string, id: string): string {
  if (!SESSION_ID.test(id)) throw new Error(`不是合法的会话 id：${JSON.stringify(id)}`)
  return join(root, `${id}.jsonl`)
}

/**
 * 把一条事件写成一行 JSON。
 *
 * `JSON.stringify` 产出的字符串里不会有裸换行（`\n` 会被转义成 `\\n`），
 * 所以"一行一条"这个约定是**安全**的：任何事件内容都不可能把一行撑成两行。
 * @param event - 要序列化的事件。
 * @returns 带结尾换行的一行。
 */
function toLine(event: SessionEvent | SessionHeader): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * 让一个会话开始往磁盘上写。
 *
 * 这是 6.1 那个 `on()` 的第一个真实用户：**落盘是一个订阅者**，
 * 而不是 `append()` 里的一段代码。`Session` 因此完全不知道磁盘的存在——
 * 阶段 12 换成 SQLite 时，`session.ts` 一个字都不用改。
 * @param session - 要持久化的会话。
 * @param path - 日志文件路径。
 * @param header - 新会话的头；续聊时传 undefined（文件里已经有头了）。
 * @returns 停止持久化的函数。
 */
export function attachJsonlPersistence(session: Session, path: string, header?: SessionHeader): () => void {
  mkdirSync(dirname(path), { recursive: true })
  if (header !== undefined) appendFileSync(path, toLine(header), 'utf8')
  // 同步写：一条事件一次系统调用。它慢，而且会卡住事件循环——
  // 但它保证了**顺序**和"函数返回时已经交给内核了"。6.3 会量出它有多慢，
  // 并给出批量写的做法，以及为什么"交给内核"还不等于"落到盘上"。
  return session.on(event => { appendFileSync(path, toLine(event), 'utf8') })
}

/** 从磁盘读回来的一次会话。 */
export interface LoadedSession {
  header: SessionHeader
  events: SessionEvent[]
}

/**
 * 读回一个会话日志。
 *
 * 严格：任何一行读不动就抛错，不跳过、不猜。**"能读多少算多少"是最坏的选择**——
 * 它会给你一段看起来正常、其实缺了几条的历史，而你无从发现。
 * 6.4 会区分两种坏行：进程被杀在写一半（末行残缺，可以修）和真的损坏（必须拒绝）。
 * @param path - 日志文件路径。
 * @returns 头和全部事件。
 * @throws 文件不存在、缺头、版本不认识、或任何一行不是合法 JSON。
 */
export function loadSession(path: string): LoadedSession {
  if (!existsSync(path)) throw new Error(`找不到会话日志：${path}`)
  const text = readFileSync(path, 'utf8')
  // 末尾那个换行会切出一个空串，去掉它。中间不该有空行——有就是坏了。
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new Error(`会话日志是空的：${path}`)

  const header = JSON.parse(lines[0] ?? '') as SessionHeader
  if (header.type !== 'session') throw new Error(`会话日志的第一行不是会话头：${path}`)
  if (header.version !== SESSION_FORMAT_VERSION) {
    throw new Error(`会话日志的格式版本是 ${header.version}，这个程序只认 ${SESSION_FORMAT_VERSION}：${path}`)
  }

  const events: SessionEvent[] = []
  for (const [index, line] of lines.slice(1).entries()) {
    let event: SessionEvent
    try {
      event = JSON.parse(line) as SessionEvent
    } catch (error) {
      // 行号从 1 数（头是第 1 行），这样报出来的数字能直接拿去 `sed -n '42p'`。
      throw new Error(`第 ${index + 2} 行不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
    // seq 必须等于它在日志里的位置。对不上说明文件被人手改过，或者拼接错了两个会话。
    if (event.seq !== index) throw new Error(`第 ${index + 2} 行的 seq 是 ${event.seq}，按位置应该是 ${index}`)
    events.push(event)
  }
  return { header, events }
}

/**
 * 列出一个目录下所有会话，最近的排在最前。
 *
 * 靠文件名排序而不是靠 mtime：id 的前半截是时间戳，所以字典序就是时间序，
 * 而 mtime 会被 `cp`、备份、同步工具改掉。
 * @param root - 存放会话的根目录。
 * @returns 会话 id，最近的在前；目录不存在时是空数组。
 */
export function listSessions(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => name.slice(0, -'.jsonl'.length))
    .sort()
    .reverse()
}
