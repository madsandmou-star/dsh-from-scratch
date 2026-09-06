# 6.2 落盘：JSONL 与重启续聊

6.1 把 `messages` 拆成了日志和投影，日志成了唯一的权威。但那条日志活在内存里的一个数组里。

## 痛点：进程一退，权威就没了

跑一次 6.1 的演示，退出，再跑一次——**十二条事件一条不剩**。这有三层代价，一层比一层贵：

**① 上下文全丢。** 模型读过的文件、跑过的测试、你解释过的需求，全部要重来一遍。这不只是烦，是真金白银——重建上下文要重新读文件、重新跑命令，每一次都在烧 token。

**② 崩溃恢复的规则永远用不上。** 6.1 写了 `TOOL_OUTCOME_UNKNOWN` 那条补齐规则，专门对付"工具跑到一半进程死了"。但日志在内存里，**能触发那条规则的崩溃，同时也带走了日志本身**。那段代码现在只能靠手工构造的日志来演示，它在真实世界里一次都不会被执行到。

**③ 什么都审计不了。** "agent 昨天下午到底 `rm` 了什么"——现在的答案是：不知道。

> 6.1 说日志是权威。**一个进程退出就消失的权威，不是权威。**

## 解法：一句话和一张图

**一句话：每追加一条事件，就往一个文件末尾写一行 JSON；启动时把这些行读回来当种子。**

格式叫 **JSONL**（JSON Lines）：一行一条 JSON，不是一个大 JSON 数组。第一行例外，它是**会话头**（格式版本、id、创建时间、cwd）。

### 改前 / 改后

```
改前：
  append ──→ [ 内存数组 ] ──→ deriveMessages()
                  ✗ 进程退出即消失

改后：
  append ──→ [ 内存数组 ] ──→ deriveMessages()
               │
               └─(订阅者)──→ appendFileSync(一行) ──→ .dsh-learn/sessions/<id>.jsonl
                                                              │
  启动 --resume ←── new Session(读回来的事件) ←── loadSession() ┘
```

注意那个 **(订阅者)**：落盘不是写在 `append()` 里的一段代码，而是挂在 6.1 那个 `on()` 上的一个监听器。`Session` 因此完全不知道磁盘存在——阶段 12 换成 SQLite 时，`session.ts` 一个字都不用改。

### 一屏看完的完整实现

`src/persistence.ts`（省略 JSDoc）：

```ts
export const SESSION_FORMAT_VERSION = 0

export interface SessionHeader {
  type: 'session'          // 固定值，让读的人分得清头和事件行
  version: number
  id: string
  createdAt: number
  cwd: string
}

const SESSION_ID = /^[0-9a-z-]{1,64}$/

export function sessionLogPath(root: string, id: string): string {
  // id 来自命令行，是不可信输入：不检查的话 `--resume ../../etc/passwd` 会读到仓库外
  if (!SESSION_ID.test(id)) throw new Error(`不是合法的会话 id：${JSON.stringify(id)}`)
  return join(root, `${id}.jsonl`)
}

/** 落盘就是一个订阅者。返回值是停止持久化的函数。 */
export function attachJsonlPersistence(session: Session, path: string, header?: SessionHeader): () => void {
  mkdirSync(dirname(path), { recursive: true })
  if (header !== undefined) appendFileSync(path, `${JSON.stringify(header)}\n`, 'utf8')
  return session.on(event => { appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8') })
}

export function loadSession(path: string): { header: SessionHeader, events: SessionEvent[] } {
  const lines = readFileSync(path, 'utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()

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
      throw new Error(`第 ${index + 2} 行不是合法的 JSON：${…}`)
    }
    // seq 必须等于它在日志里的位置。对不上说明文件被手改过，或者拼接错了两个会话。
    if (event.seq !== index) throw new Error(`第 ${index + 2} 行的 seq 是 ${event.seq}，按位置应该是 ${index}`)
    events.push(event)
  }
  return { header, events }
}
```

`Session` 那边只多了一个构造参数：

```ts
constructor(seed: readonly SessionEvent[] = []) {
  this.log = [...seed]
}
```

**种子事件不触发订阅者**——重放已经发生过的事，不该再写一遍磁盘，也不该再通知任何人。这一行的顺序（直接塞进 `log`，不走 `append`）就是这条语义。

### 用起来是几行

`src/index.ts`：

```ts
const SESSION_ROOT = join(process.cwd(), '.dsh-learn', 'sessions')

const resumeId = resumeTarget()                       // 解析 --resume [id]
const sessionId = resumeId ?? newSessionId()
const logPath = sessionLogPath(SESSION_ROOT, sessionId)

const session = resumeId === undefined ? new Session() : new Session(loadSession(logPath).events)
attachJsonlPersistence(session, logPath, resumeId === undefined
  ? { type: 'session', version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: Date.now(), cwd: process.cwd() }
  : undefined)
```

三行：决定 id、读回历史（如果是续聊）、挂上落盘。**`runTurn()` 一个字都没改**——它照样只管 `session.append()`。

### 产出长什么样

```sh
node --import tsx demos/06-session/03-jsonl-and-resume.mjs
```

```
=== 磁盘上的 20260906-1512-dc35.jsonl（9 行）===
  第  1 行  (会话头)  {"type":"session","version":0,"id":"20260906-1512-dc35","createdAt":…,"cwd":"/tmp/ds …
  第  2 行  seq 0     {"type":"turn/start","seq":0,"time":…,"data":{"turn":1}}
  第  3 行  seq 1     {"type":"user/message","seq":1,"time":…,"data":{"text":"note.txt 里写了什么"}}
  第  4 行  seq 2     {"type":"context/snapshot","seq":2,…}
  第  5 行  seq 3     {"type":"assistant/message","seq":3,"time":…,"data":{"turn":1,"step":1,"text":null,…
  第  6 行  seq 4     {"type":"tool/call","seq":4,…}
  第  7 行  seq 5     {"type":"tool/result","seq":5,…,"data":{"callId":"call_1","content":"   1: 会议 …
  第  8 行  seq 6     {"type":"context/snapshot","seq":6,…}
  第  9 行  seq 7     {"type":"assistant/message","seq":7,…,"data":{"turn":1,"step":2,"text":"看到了，n …

=== 续聊（--resume）：模型收到的 messages ===
  system    你是一个跑在命令行里的编码助手。…
  user      note.txt 里写了什么
  user      当前运行时上下文。…
  assistant (null)
  tool         1: 会议改到周四下午三点
  user      当前运行时上下文。…
  assistant 看到了，note.txt 里写着一句话。
  user      再说一遍刚才看到的那句话
  user      当前运行时上下文。…

同一个文件，从 9 行长到了 13 行——续聊是**往后追加**，不是新开一个。
```

最后一行是重点：续聊没有产生新文件，也没有重写旧文件。**一条会话日志从生到死只被追加。**

## 为什么是一行一条，而不是一个大 JSON 数组

这是这一课唯一真正的格式选择，两个理由都可以量出来：

```sh
node --import tsx demos/06-session/04-why-jsonl.mjs
```

```
=== 追加 2000 条事件，两种格式 ===
  JSON 数组   写了  565.4 MB   耗时   3454 ms   最终文件 0.6 MB
  JSONL       写了    0.6 MB   耗时     10 ms   最终文件 0.6 MB

  写入量差 998 倍，耗时差 331 倍。
```

**① 追加的代价。** 一个 JSON 数组是一个整体：要往里加一条，就得**把整个文件读回来、解析、push、再整个写回去**。第 n 次追加要写 n 条的量，总量是 O(n²)。最终文件都是 0.6 MB，但数组那边一路写了 565 MB。

而会话恰恰是那种"一直变长"的东西。一次长任务几千条事件很正常，那时数组版每追加一条要重写几 MB——**agent 会在你打字的间隙卡住**。

JSONL 的追加是 `appendFileSync(一行)`：写多少就是多少，O(1)。

**② 被杀之后还剩什么。**

```
=== 写到一半进程被杀，文件还剩什么 ===
  JSON 数组    截断后能读回 0 条完整记录（原本 5 条）
  JSONL      截断后能读回 3 条完整记录（原本 5 条）
```

数组少一个 `]` 就整个解析失败，**五条全丢**。JSONL 的每一行独立成立，坏的只有最后那行。

这条不只是"损失小一点"——它是 6.4 那个截断修复**能够存在的前提**。修复的前提是能分清"哪些是好的、哪里开始坏的"，而只有一行一条的格式能给出这个分界点。

> **格式选择的通用判据：它把失败的粒度定成了多大。** JSON 数组把粒度定成"整个文件"，JSONL 定成"一行"。粒度越小，能救回来的越多。

## 会话头为什么单独占一行

第一行不是事件，是会话头：

```json
{"type":"session","version":0,"id":"20260906-1512-dc35","createdAt":1788707571300,"cwd":"/tmp/dsh-demo-xxx"}
```

它带的四样东西各有各的用：

**`version`——读到不认识的日志时拒绝，而不是猜。** 猜错的代价是把一段历史悄悄读歪，而"历史不会在你背后变"正是整套设计的地基。这个版本号只在**结构性**改动时才动（比如事件包装从 `{type,seq,time,data}` 变形）；往 `SessionEventMap` 里加一个新事件类型不算，6.4 会讲那种情况怎么办。

**`cwd`——同一个 id 在不同项目下是不同的会话。** 我们把会话存在 `工作目录/.dsh-learn/sessions/` 下，本身已经按项目分开了；`cwd` 记在头里是为了将来把它们集中存放时还认得出归属。

**`createdAt` 和 `id`。** id 前半截是时间戳（`20260906-1512`），所以 `ls` 出来就是时间序，`listSessions()` 靠文件名排序而不是 mtime——**mtime 会被 `cp`、备份、同步工具改掉，文件名不会**。

`type: 'session'` 这个固定值让读的人一眼分得清头和事件行。听起来多余（第一行当然是头），但 6.4 要处理"文件开头就是坏的"这种情况，那时需要一个能验证的标记。

## 三个不那么显然的决定

**① id 是不可信输入。**

```ts
if (!SESSION_ID.test(id)) throw new Error(`不是合法的会话 id：${JSON.stringify(id)}`)
```

`--resume` 后面跟的东西来自命令行。不检查就直接 `join(root, id + '.jsonl')` 的话，`--resume ../../../etc/passwd` 会让程序去读仓库外的文件——将来支持删除会话时，同样的路径会变成**写**。这类问题叫 path traversal，**修它的时机是第一次把外部字符串拼进路径的那一刻**，不是等出事之后。

我们的做法是拒绝。dsh 的做法是**转义**（`dsh/packages/session/session-persistence-jsonl/src/format.ts` 里的 `encodeSegment`），把任意字符串无损编码成一个安全的路径段：

> Encode an arbitrary string as a single safe path segment, injectively over ALL JS (UTF-16) strings — including lone surrogates. A `SessionId` is an unvalidated branded string, so this neutralizes `../`, absolute paths, NUL, and separators before any filesystem use.

为什么它不能像我们一样简单拒绝？因为 **dsh 的会话 id 可能来自别的系统**（父会话派生、外部工具导入），它没有资格要求对方遵守自己的命名规矩。**能定规矩的时候拒绝，不能定规矩的时候转义。**

**② 读日志时严格，不"能读多少算多少"。**

任何一行读不动就抛错。跳过坏行看起来更"健壮",实际上是最坏的选择：它会给你一段**看起来正常、其实缺了几条**的历史，而你无从发现——模型会基于一段被悄悄改过的历史继续工作。

**失败要么彻底，要么被明确地标记出来。** 6.4 会给出那个"明确标记"的版本：末行残缺是可修的，其余的坏是必须拒绝的。

**③ `seq` 要和行号对上。**

```ts
if (event.seq !== index) throw new Error(`第 ${index + 2} 行的 seq 是 ${event.seq}，按位置应该是 ${index}`)
```

这是一个几乎不要钱的一致性检查，能抓住两类事故：文件被手工编辑过（删了中间一行），以及两个会话的日志被拼在了一起。**冗余信息的价值就在于它能互相验证**——`seq` 本来就等于位置，正因为如此，它们对不上就一定是出事了。

## 教 debug：日志文件就是最好的现场

```sh
ls -lt .dsh-learn/sessions/                                  # 最近的会话
tail -3 .dsh-learn/sessions/<id>.jsonl                       # 最后发生了什么
grep '"type":"tool/call"' .dsh-learn/sessions/<id>.jsonl     # 它到底调了哪些工具
head -1 .dsh-learn/sessions/<id>.jsonl                       # 会话头：版本、cwd
```

**选 JSONL 的第三个理由在这里**：它是**面向行的文本**，所以 `grep`、`tail`、`wc -l`、`sed -n '42p'` 全都直接可用。一个 JSON 数组要看第 42 条得先写个脚本。

三条具体的定位路径：

**`--resume` 报错说某一行不是合法 JSON。** 错误信息里的行号是从 1 数的（头是第 1 行），直接 `sed -n '42p' <文件>` 就能看到那一行。多半是 6.3/6.4 要讲的写到一半。

**续聊之后模型好像不记得之前的事。** 用 `DSH_DUMP_LOG=1` 看两栏：日志那栏有没有旧事件？没有 → 是读的问题（文件路径不对、`--resume` 没生效）；有但 messages 那栏没有 → 是投影的问题。**6.1 那个"先信日志再查投影"的顺序，在这里多了一层"先确认日志真的读回来了"。**

**文件在增长但内容不对。** `wc -l` 数一下行数，和 `session.events.length` 对比。多了说明写了两遍（比如种子事件也被写了一次——这正是构造函数不走 `append` 的原因）。

## 对照 dsh

dsh 的 JSONL 后端在 `dsh/packages/session/session-persistence-jsonl/`。同一个包里，我们那 40 行对应的是 `format.ts` 加一整套写入调度。

| | 我们的 | dsh 的 | 为什么 dsh 更复杂 |
|---|---|---|---|
| 存放位置 | `工作目录/.dsh-learn/sessions/<id>.jsonl` | `<root>/<项目目录>/<会话目录>/` | 会话集中存放，还要留位置放会话本地的其他产物 |
| id 进路径 | 不合法就拒绝 | `encodeSegment()` 无损转义 | id 可能来自外部系统，无权要求对方守规矩 |
| 写入 | 每条一次 `appendFileSync` | 批量写 + 检查点策略 | 同步写会卡住事件循环（6.3） |
| 物理编码 | 纯文本 | 可选 zstd 压缩（`logSuffix()`） | 长会话的日志会很大 |
| 头的校验 | 三个字段 | `isHeaderLine()` 逐字段类型守卫 | 文件是不可信输入，`JSON.parse` 之后什么都可能 |
| 坏文件 | 一律拒绝 | 截断修复 vs 拒绝，分开处理（6.4） | 崩溃是常态，不该让用户丢掉整个会话 |
| 后端 | 只有 JSONL | JSONL / SQLite 两个提供者 | 落盘方式是一个 capability seam（阶段 14） |

`isHeaderLine()` 那一行值得单独看——它检查 `createdAt` 是不是安全整数、是不是非负、**是不是负零**：

```ts
&& !Object.is((value as { createdAt: number }).createdAt, -0)
```

看着偏执。但这正好落在 `dsh/CLAUDE.md` 那条规矩的边界上：**"在同进程的类型化边界上信任 TypeScript"，而文件是不可信边界**。`JSON.parse` 的返回值是 `unknown`，磁盘上的字节可能被任何东西写过——手工编辑、磁盘错误、另一个版本的程序。跨过这条边界就必须逐字段检查。

我们的 `loadSession()` 只检查了三个字段，这是简化，不是不同的判断：同一条规矩，我们做了一部分。

## 这一课改了什么

| 文件 | 改动 |
|---|---|
| `src/persistence.ts` | 新增：`SESSION_FORMAT_VERSION`、`SessionHeader`、`attachJsonlPersistence()`、`loadSession()`、`listSessions()` |
| `src/session.ts` | `Session` 构造函数接受种子事件（重放不触发订阅者） |
| `src/index.ts` | `--resume [id]`；挂上持久化；turn 编号从日志里查 |
| `demos/06-session/03-jsonl-and-resume.mjs` | 新增：写盘、看文件、续聊、再追加 |
| `demos/06-session/04-why-jsonl.mjs` | 新增：数组 vs JSONL 的写入量、耗时、截断后能救回多少 |
| `.gitignore` | 加上 `.dsh-learn/` |

## 下一课的痛点

`appendFileSync` 返回了，事件就安全了吗？

**没有。** `write()` 返回只意味着数据交给了内核，不等于落到了盘上。`kill -9` 之后那几条可能根本不在文件里。而且每条事件一次系统调用——它会在模型吐字的间隙**卡住整个事件循环**。

**6.3 讲两件事**：写入批处理（怎么把 1000 次系统调用变成 10 次），以及**语义检查点**（哪些时刻必须真的落盘再往下走——比如执行一个不可逆的 `rm` 之前）。
