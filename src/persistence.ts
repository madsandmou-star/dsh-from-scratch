// 阶段 6.2：把事件日志写到磁盘，重启能续。
//
// 6.1 的日志活在内存里。进程一退，十二条事件全没了——连那条
// TOOL_OUTCOME_UNKNOWN 的补齐规则都用不上：能触发它的崩溃同时带走了日志本身。
//
// 落盘格式选 JSONL：**一行一条 JSON**，而不是一个大 JSON 数组。理由见讲义，
// 一句话是——追加一条事件只要 `appendFileSync(一行)`，不用把整个文件读回来、
// 改一改、再整个写回去。

import { mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { open, truncate } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Session, SessionEvent, SessionEventType } from './session.ts'

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
 * 一批事件攒多久才写。
 *
 * 200ms 是"人感觉不到"和"批得够大"之间的折中：模型吐字的间隙远比这短，
 * 所以一次模型回复期间产生的事件会被攒成一两批，而不是几十次系统调用。
 * dsh 的默认值也是 200（`dsh/packages/session/session-persistence/src/coordinator.ts`
 * 里的 `DEFAULT_WRITE_BATCH_MAX_DELAY_MS`），而且它是**可配置**的——
 * 批多久是部署决定，不是代码常量。
 */
export const WRITE_BATCH_MAX_DELAY_MS = 200

/**
 * 把一批行追加到文件末尾，然后 **fsync**。
 *
 * `write()` 返回只说明数据交给了内核，还躺在 page cache 里。`kill -9` 不影响它
 * （内核还活着），但**断电或内核崩溃就没了**。`handle.sync()` 才是那句
 * "现在真的写到盘上了"。它很贵——所以我们只在检查点上花这笔钱。
 * @param path - 日志文件路径。
 * @param content - 已经拼好的若干行（每行自带结尾换行）。
 */
async function appendAndSync(path: string, content: string): Promise<void> {
  const handle = await open(path, 'a')
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * 一个会话的写入控制器：攒批、定时刷、按需刷。
 *
 * 它自己不知道"什么时候该刷"——那是调用方的语义判断（见 `src/index.ts` 的检查点）。
 * 它只保证两件事：**写出去的顺序和 append 的顺序一致**，以及 {@link flush}
 * 返回时，此刻之前 append 的事件都已经 fsync 过了。
 */
export class SessionWriter {
  private pending: string[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  /** 上一次写入的 promise。新的一批排在它后面，保证不会两批同时写、写串行。 */
  private tail: Promise<void> = Promise.resolve()

  /** @param path - 日志文件路径。 */
  constructor(private readonly path: string) {}

  /**
   * 把一行放进队列，并（如果还没有的话）起一个定时器。
   * @param line - 已经序列化好的一行，自带结尾换行。
   */
  enqueue(line: string): void {
    this.pending.push(line)
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      // 定时刷没有调用方接错误。留在 pending 里，下一次 flush() 会重试；
      // 同时立刻报出来——**悄悄丢事件是这套设计最不能接受的失败**。
      void this.flush().catch(error => {
        console.error(`[会话日志写入失败，将在下一个检查点重试] ${error instanceof Error ? error.message : String(error)}`)
      })
    }, WRITE_BATCH_MAX_DELAY_MS)
    // 不让这个定时器拖住进程退出：该刷的时候我们会显式刷。
    this.timer.unref?.()
  }

  /**
   * 把队列里的全部事件写下去并 fsync。
   *
   * 队列空时也要等 {@link tail}——上一批可能还在写，而调用方要的是
   * "此刻之前的一切都已落盘"，不是"我这一批已落盘"。
   * @returns 全部落盘后 resolve；写失败时 reject，那一批留在队列里等重试。
   */
  flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const batch = this.pending
    this.pending = []
    const done = this.tail.then(async () => {
      if (batch.length === 0) return
      try {
        await appendAndSync(this.path, batch.join(''))
      } catch (error) {
        // 写了一半也算失败：把这批放回队首，让下一次 flush 整批重写。
        // 顺序不能乱，所以是 unshift 不是 push。
        this.pending.unshift(...batch)
        throw error
      }
    })
    // tail 只用来排队。让它吞掉失败，否则一次写失败会让后面每一次 flush 都失败。
    this.tail = done.catch(() => {})
    return done
  }
}

/** 一个挂上了持久化的会话。 */
export interface SessionPersistence {
  /** 把此刻之前的所有事件写下去并 fsync。检查点调它。 */
  flush(): Promise<void>
  /** 停止持久化，最后刷一次。 */
  close(): Promise<void>
}

/**
 * 让一个会话开始往磁盘上写。
 *
 * 这是 6.1 那个 `on()` 的第一个真实用户：**落盘是一个订阅者**，
 * 而不是 `append()` 里的一段代码。`Session` 因此完全不知道磁盘的存在——
 * 阶段 12 换成 SQLite 时，`session.ts` 一个字都不用改。
 *
 * 订阅者只做 {@link SessionWriter.enqueue}（同步、极快），真正的写在批处理里。
 * `append()` 因此不会被磁盘拖慢——6.3 之前它每条都同步写，会卡住事件循环。
 * @param session - 要持久化的会话。
 * @param path - 日志文件路径。
 * @param header - 新会话的头；续聊时传 undefined（文件里已经有头了）。
 * @returns 刷盘与关闭的手柄。
 */
export function attachJsonlPersistence(session: Session, path: string, header?: SessionHeader): SessionPersistence {
  mkdirSync(dirname(path), { recursive: true })
  const writer = new SessionWriter(path)
  if (header !== undefined) writer.enqueue(toLine(header))
  const unsubscribe = session.on(event => { writer.enqueue(toLine(event)) })
  return {
    flush: () => writer.flush(),
    close: async () => { unsubscribe(); await writer.flush() },
  }
}

/**
 * 这个 build 认识的事件类型。
 *
 * 写成 `Record<SessionEventType, true>` 再取键，是为了让**漏写一项编译不过**——
 * 往 `SessionEventMap` 里加事件却忘了加到这里，`tsc` 会当场报缺字段。
 * dsh 那份是脚本生成的（`dsh/packages/core/session/src/known-event-types.ts`
 * 开头就写着 GENERATED），因为它的事件表靠 declaration merging 散在几十个包里，
 * 一个对象字面量看不全。我们只有一个文件，所以类型就够了。
 */
const KNOWN: Record<SessionEventType, true> = {
  'turn/start': true,
  'user/message': true,
  'context/snapshot': true,
  'assistant/message': true,
  'tool/call': true,
  'tool/result': true,
}

/** {@link KNOWN} 的运行时形态：读回来的 `type` 是 string，得用字符串集合比。 */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(KNOWN))

/**
 * 日志坏了：内容本身不可信，不能拿它重建会话。
 *
 * 和 {@link SessionFormatUnsupportedError} 是两码事——那个是"日志好好的，
 * 只是这个程序读不懂"。分成两个类型是因为**用户该做的事不一样**：
 * 损坏要去看备份，读不懂要去换个版本的程序。
 */
export class SessionLogCorruptionError extends Error {
  /** @param message - 坏在哪、哪一行。 */
  constructor(message: string) {
    super(message)
    this.name = 'SessionLogCorruptionError'
  }
}

/** 日志是完好的，但这个 build 解释不了它：版本不认识，或者有不认识的必需事件。 */
export class SessionFormatUnsupportedError extends Error {
  /** @param message - 为什么读不懂。 */
  constructor(message: string) {
    super(message)
    this.name = 'SessionFormatUnsupportedError'
  }
}

/** 从磁盘读回来的一次会话。 */
export interface LoadedSession {
  header: SessionHeader
  events: SessionEvent[]
  /**
   * 可以安全追加的字节偏移——也就是**最后一个完整行的末尾**。
   *
   * 文件比它长，说明末尾有一段崩溃时写了一半的残骸。
   * {@link repairLog} 把文件截到这里，新事件才不会接在半行后面。
   */
  committedBytes: number
  /** 被判定为崩溃残骸、将被丢弃的字节数。0 表示文件是干净的。 */
  tornBytes: number
}

/**
 * 读回一个会话日志，容忍**末尾**的崩溃残骸，拒绝其他一切异常。
 *
 * 全程按**字节**处理而不是按字符。进程可能死在一个 UTF-8 多字节序列的中间，
 * 那几个字节不构成合法字符——`readFileSync(path, 'utf8')` 会把它们换成替换字符 `\uFFFD`，
 * 于是字符串长度和文件长度对不上，算出来的截断偏移就是错的。
 *
 * 三种坏，三种反应：
 * - **末行没有换行符** → 崩溃残骸，丢掉，报告丢了多少字节。这是唯一被容忍的坏。
 * - **完整的行读不动，或 seq 对不上** → {@link SessionLogCorruptionError}。
 * - **版本不认识，或有不认识且没标 ignorable 的事件** → {@link SessionFormatUnsupportedError}。
 * @param path - 日志文件路径。
 * @returns 头、事件、可追加偏移、被丢弃的残骸字节数。
 * @throws 文件不存在、缺头，或上面后两种情况。
 */
export function loadSession(path: string): LoadedSession {
  if (!existsSync(path)) throw new Error(`找不到会话日志：${path}`)
  const buffer = readFileSync(path)

  // 0x0A 就是 '\n'。按字节找，不解码。
  const headerEnd = buffer.indexOf(0x0A)
  if (headerEnd === -1) throw new SessionLogCorruptionError(`会话日志没有完整的会话头：${path}`)

  let header: SessionHeader
  try {
    header = JSON.parse(buffer.subarray(0, headerEnd).toString('utf8')) as SessionHeader
  } catch (error) {
    throw new SessionLogCorruptionError(`会话头不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (header.type !== 'session') throw new SessionLogCorruptionError(`会话日志的第一行不是会话头：${path}`)
  // 版本先判，再往下读：连怎么解释都不确定的时候，读出来的东西没有意义。
  if (header.version !== SESSION_FORMAT_VERSION) {
    throw new SessionFormatUnsupportedError(
      `会话日志的格式版本是 ${header.version}，这个程序只认 ${SESSION_FORMAT_VERSION}：${path}\n`
      + '这多半是更新的版本写的。用那个版本打开它，别用这个。',
    )
  }

  const events: SessionEvent[] = []
  let committedBytes = headerEnd + 1
  let line = 1              // 头是第 1 行，事件从第 2 行起
  while (committedBytes < buffer.length) {
    const lineEnd = buffer.indexOf(0x0A, committedBytes)
    // 没有结尾换行 = 这一行没写完 = 崩溃残骸。前面的都是好的，到此为止。
    if (lineEnd === -1) break
    line += 1

    const text = buffer.subarray(committedBytes, lineEnd).toString('utf8')
    let event: SessionEvent
    try {
      event = JSON.parse(text) as SessionEvent
    } catch (error) {
      // 已经有结尾换行还读不动，就不是"写了一半"，是真的坏了。
      throw new SessionLogCorruptionError(`第 ${line} 行有完整的换行但不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
    if (event.seq !== events.length) {
      throw new SessionLogCorruptionError(`第 ${line} 行的 seq 是 ${event.seq}，按位置应该是 ${events.length}`)
    }
    if (!KNOWN_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
      throw new SessionFormatUnsupportedError(
        `第 ${line} 行是这个程序不认识的事件类型 "${event.type}"，而且没有标 ignorable。\n`
        + '拒绝解释这个日志——跳过一条必需事件，重建出来的会话是错的。',
      )
    }
    events.push(event)
    committedBytes = lineEnd + 1
  }

  return { header, events, committedBytes, tornBytes: buffer.length - committedBytes }
}

/**
 * 把日志截到最后一个完整行，并 fsync。
 *
 * 不截的话，下一条事件会被追加在那半行后面，**拼成一行谁也读不懂的东西**——
 * 一次崩溃就变成了永久损坏。截断必须发生在任何新的追加之前。
 * @param path - 日志文件路径。
 * @param committedBytes - {@link loadSession} 算出来的可追加偏移。
 */
export async function repairLog(path: string, committedBytes: number): Promise<void> {
  await truncate(path, committedBytes)
  // 截断本身也要落盘：否则崩溃两次之后，文件可能还是原来那么长。
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
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
