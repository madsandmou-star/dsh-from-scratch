# 6.3 什么时候真的写到了磁盘

6.2 的落盘只有一行：

```ts
return session.on(event => { appendFileSync(path, toLine(event), 'utf8') })
```

它有两个问题，一个关于**性能**，一个关于**真假**。

## 痛点一：每条一次同步写，卡住的是整个 agent

`appendFileSync` 是同步的。JS 是单线程的，所以它跑着的时候，**事件循环里什么都不能发生**——SSE 的数据包到了没人读，定时器到点了不会响。

```sh
node --import tsx demos/06-session/05-batching.mjs
```

```
=== 写 20000 条事件 ===
  每条同步写   20000 次写调用   耗时   109 ms   事件循环最长被卡  108 ms
  攒 200 条一批    100 次写调用   耗时   172 ms   事件循环最长被卡    1 ms
```

最后一栏是重点。**同步写把 108ms 整段占住了**；批处理那版总耗时更长（多做了 100 次 fsync），但事件循环最长只被卡 1ms——因为它在每个 `await` 处让出。

用户感觉到的不是"总共花了多久"，是"模型吐字卡不卡"。**一个把事件循环占住 100ms 的写操作，等于让模型的输出停顿 100ms。**

（这个测量本身有个手法：起一个 1ms 的定时器，看它实际隔了多久才被叫醒。**迟到的那部分就是被卡住的时间**。同步代码跑着的时候定时器根本没机会执行。）

## 痛点二：`write()` 返回了，数据不一定在盘上

这是更隐蔽的那个。`appendFileSync` 返回时，数据到了哪里？

```
你的进程          内核                      物理磁盘
   │               │                          │
   │ write() ─────→│  page cache（内存）      │
   │←── 返回了      │                          │
   │               │  ……过一会儿……  ────────→ │
   │               │                          │
```

`write()` 返回只说明**数据交给了内核**，它还躺在 page cache 里。三种崩溃，三种结果：

| 崩溃方式 | page cache 里的数据 | 结论 |
|---|---|---|
| 进程异常退出 / `kill -9` | 内核还活着，数据还在，最终会落盘 | **不丢** |
| 内核崩溃 / 断电 / 虚拟机被强杀 | 内存没了 | **丢** |
| 容器被 OOM killer 干掉 | 取决于是杀进程还是整个 VM | 不确定 |

`fsync()` 才是那句"现在真的写到盘上了"——它让内核把 page cache 刷到物理设备，并等待设备确认。

**它很贵。** 一次 fsync 在机械盘上要几毫秒，在 SSD 上也要几十微秒到一毫秒，而且它会阻塞。所以答案不可能是"每条事件都 fsync"。

> 两个痛点指向同一个结论：**落盘的时机需要被决定，而不是让每一次 append 自己决定。**

## 解法：一句话和一张图

**一句话：平时攒批异步写，在少数几个"必须为真"的时刻显式刷盘并 fsync。**

两个机制，各管一件事：

- **写入批处理**（write-behind）：事件先进内存队列，200ms 后或者被显式要求时才真的写。管性能。
- **语义检查点**（checkpoint）：在特定的几个时刻 `await flush()`，等它 fsync 完再往下走。管正确性。

### 改前 / 改后

```
改前：
  append ──→ 订阅者 ──→ appendFileSync ──→ page cache
              （同步、阻塞、每条一次）        （不一定在盘上）

改后：
  append ──→ 订阅者 ──→ enqueue（同步、极快，只是 push 进数组）
                           │
                           ├─ 200ms 定时器到 ──┐
                           └─ checkpoint() ───┴─→ 写一批 + fsync ──→ 物理磁盘

  检查点在哪两个地方：
    ① 发模型请求之前          ② 跑工具之前
```

### 一屏看完的完整实现

`src/persistence.ts` 新增的部分：

```ts
export const WRITE_BATCH_MAX_DELAY_MS = 200

/** 追加一批行然后 fsync。fsync 很贵，所以只在检查点上花这笔钱。 */
async function appendAndSync(path: string, content: string): Promise<void> {
  const handle = await open(path, 'a')
  try {
    await handle.writeFile(content)
    await handle.sync()          // ← 这一行才是"真的在盘上了"
  } finally {
    await handle.close()
  }
}

export class SessionWriter {
  private pending: string[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  /** 上一次写入的 promise。新的一批排在它后面，保证不会两批同时写、写串行。 */
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  enqueue(line: string): void {
    this.pending.push(line)
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      // 定时刷没有调用方接错误：留在 pending 里等下一次 flush 重试，同时立刻报出来。
      void this.flush().catch(error => { console.error(`[会话日志写入失败，将在下一个检查点重试] …`) })
    }, WRITE_BATCH_MAX_DELAY_MS)
    this.timer.unref?.()
  }

  flush(): Promise<void> {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    const batch = this.pending
    this.pending = []
    const done = this.tail.then(async () => {
      if (batch.length === 0) return
      try {
        await appendAndSync(this.path, batch.join(''))
      } catch (error) {
        // 写了一半也算失败：整批放回队首，下一次 flush 重写。顺序不能乱，所以是 unshift。
        this.pending.unshift(...batch)
        throw error
      }
    })
    // tail 只用来排队。让它吞掉失败，否则一次写失败会让后面每一次 flush 都失败。
    this.tail = done.catch(() => {})
    return done
  }
}
```

`attachJsonlPersistence()` 的返回值从"一个取消函数"变成了一个手柄：

```ts
export interface SessionPersistence {
  /** 把此刻之前的所有事件写下去并 fsync。检查点调它。 */
  flush(): Promise<void>
  /** 停止持久化，最后刷一次。 */
  close(): Promise<void>
}
```

### 用起来是三处

`src/index.ts`：

```ts
async function checkpoint(): Promise<void> {
  if (process.env['DSH_NO_CHECKPOINT'] !== undefined) return   // 只为演示存在的开关
  await persistence.flush()
}
```

**检查点①：发请求之前。**

```ts
appendContextSnapshot()
await checkpoint()
process.stdout.write(`\n模型 > `)
```

**检查点②：跑工具之前。**

```ts
session.append('tool/call', { callId: call.id, name: call.name, arguments: call.arguments })
await checkpoint()
const result = await runTool(call.name, call.arguments, guards)
```

**退出前刷最后一次。**

```ts
rl.close()
await persistence.close()
```

三处。`checkpoint()` 抛错时异常会一路向上，`runTurn` 的调用方打印 `[本轮中断]`——**刷不下去就不往下走**。

### 产出长什么样

```sh
node --import tsx demos/06-session/06-checkpoints.mjs
```

这个演示的手法值得单说：**让模型调一个 bash 工具，去数"我自己这次调用"在日志文件里出现了几次**。工具的输出是它在自己执行的那一刻观测到的，没法作假。

```
=== 有检查点（默认）===
  工具看到的：1

=== 关掉检查点（DSH_NO_CHECKPOINT=1）===
  工具看到的：0
```

**1 和 0 的差别就是那一行 `await checkpoint()`。** 关掉之后，`tool/call` 还压在 200ms 的队列里，工具已经在跑了。

## 为什么恰好是这两个时刻

检查点不能多——每个都是一次 fsync。挑哪些，判据是**"崩溃之后，缺了这条事件会不会让恢复出来的历史说谎"**。

### ① 发模型请求之前

理由不是"怕丢"，是**因果顺序**：模型的回答是这段历史的后果。如果回答落盘了、依据的历史没落盘，恢复出来的会话里就会出现一段"没有原因的结果"。

dsh 把这条写在 `dsh/packages/session/session-checkpoint-policy/src/index.ts` 的注释里：

> Delay construction of the downstream model stream until the complete logged request prefix is durable. A checkpoint rejection prevents adapter dispatch.
>
> （推迟下游模型流的构造，直到**已记录的请求前缀完整落盘**。检查点失败会阻止适配器发起调用。）

最后半句就是 fail-closed：**刷不下去，请求就不发**。

### ② 跑工具之前

这是整门课到目前为止最漂亮的一处闭环。

6.1 写了两条恢复码，区别在于"那次调用有没有开始跑"：

- `TOOL_NOT_STARTED`——没跑，重试安全。
- `TOOL_OUTCOME_UNKNOWN`——跑过了，磁盘可能已经变了，别假设它没发生。

这个区分靠的是日志里有没有 `tool/call`。**而如果那条事件只在内存里，崩溃时它跟着一起没了**——恢复的人会看到 `TOOL_NOT_STARTED`，然后放心地重试一次已经执行过的 `rm -rf build/`。

**没落盘的事件，恢复时等于没发生过。** 所以那条区分要成立，`tool/call` 必须在工具跑起来之前就是真的。

dsh 的对应代码：

```ts
ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
  if (exec.agent === undefined || exec.parent !== undefined) return next()
  await ctx.sessions.flush(exec.agent.session)
  if (exec.signal.aborted) return abortedBeforeDispatchResult()
  return next()
})
```

`exec.parent !== undefined` 那一句是"嵌套的工具调用不重复检查点"——外层那次已经落盘了，里层复用它。

### 为什么不在别的地方检查点

**工具结果之后不用。** 结果丢了顶多重跑一次工具；而"调用发生过"这件事丢了会导致重复执行副作用。**丢了要重做的事，和丢了会做错的事，是两个量级。**

**用户输入之后不用。** 下一个检查点（发请求之前）马上就到了，中间那几微秒不值一次 fsync。

## 三个实现上的坑

**① `flush()` 在队列空的时候也要等 `tail`。**

调用方要的是"此刻之前的一切都已落盘",不是"我这一批已落盘"。上一批可能还在写——直接返回就是撒谎。

**② 两批不能同时写。**

`tail` 那个 promise 链就是干这个的：新的一批 `.then()` 在上一批后面。少了它，两次 `writeFile` 会交错，文件里的行会串——而我们整个格式依赖"一行一条、顺序即 seq"。

**③ 写失败时整批放回队首。**

```ts
this.pending.unshift(...batch)
```

写了一半也算失败。放回去让下一次整批重写——`unshift` 不是 `push`，因为顺序不能乱。

dsh 更彻底：它先记下文件原来的大小，失败时 **truncate 回去再 fsync**，理由写在注释里：

> On a partial write or sync failure, restore the previous size before rethrowing because the unchanged cursor will retry the batch; leaving partial bytes would create duplicate sequence numbers.
>
> （写了一半或 sync 失败时，先把文件恢复成原来的大小再抛——因为游标没动，这一批会被重试；留着那些半截字节会造成重复的序号。）

我们没做这一步，所以我们的日志在这种情况下会留下一段坏字节。**6.4 会讲怎么读回这样的文件。**

## 教 debug：三个问题，三个手法

**"agent 卡了一下"** → 用 05-batching 那个手法量事件循环：起一个 1ms 定时器，看它迟到多久。**迟到就是被同步代码占住了**。这个手法对任何"莫名卡顿"都有效，不限于写盘。

**"崩溃之后日志少了最后几条"** → 正常。它们还在 200ms 的队列里。要确认某一条一定在盘上，看它前面有没有检查点。用 `DSH_NO_CHECKPOINT=1` 跑一次对照，差别就是检查点买到的东西。

**"文件在长但内容不对"** → `wc -l` 数行数，和 `session.events.length` 比。多了说明写了两遍（种子事件也被写了？——那正是构造函数不走 `append` 的原因）；少了就是队列里还压着。

一个通用判断：**"它返回了"和"它生效了"是两件事，中间隔着几层缓冲。** 写盘隔着 page cache，网络隔着发送缓冲区，`console.log` 隔着 stdout 缓冲。排查"明明做了却没效果"的时候，先问这一层。

## 对照 dsh

| | 我们的 | dsh 的 | 为什么 dsh 更复杂 |
|---|---|---|---|
| 批处理延迟 | `WRITE_BATCH_MAX_DELAY_MS = 200` 常量 | `writeBatchMaxDelayMs` 可配置，默认 200 | 批多久是**部署决定**，不是代码常量 |
| 批处理归属 | 一个 `SessionWriter` | `SessionWriteBehind` + 共享 coordinator | 多个会话共用一套调度和背压 |
| 写失败 | 整批放回队首 | truncate 回原大小再 fsync 再重试 | 半截字节会造出重复序号 |
| 后台写失败 | 打一行日志 | `reportBackgroundFailure` 回调 | 上层要能决定怎么处理（告警？降级？） |
| 检查点位置 | 两处，写在 `index.ts` 里 | 三处，一个独立插件 | 检查点策略是可替换的——不需要就不装 |
| 嵌套工具 | 没有嵌套 | `exec.parent !== undefined` 时跳过 | subagent 的工具调用不重复付 fsync |

最后一行的那个"独立插件"值得记住：dsh 把检查点做成了 `session-checkpoint-policy` 这个包，靠三个监听器挂在 `llm/stream`、`tools/execute`、`agent/pre-step` 上。**它可以整个不装**——比如一个跑在内存里的测试装配，根本不需要 fsync。

我们写死在 `index.ts` 里是简化。阶段 7 引入 Cordis 之后，这段会变成一个插件；阶段 10 讲 waterfall 时，你会认出 `ctx.on('tools/execute', (exec, next) => …)` 正是我们 4.4 那个"环绕包装器"的真身。

## 这一课改了什么

| 文件 | 改动 |
|---|---|
| `src/persistence.ts` | 新增 `SessionWriter`（攒批 + 串行 + 失败回滚）、`appendAndSync()`；`attachJsonlPersistence()` 返回 `SessionPersistence` 手柄 |
| `src/index.ts` | `checkpoint()`；发请求前和跑工具前各一处；退出前 `close()` |
| `demos/06-session/05-batching.mjs` | 新增：写调用次数、耗时、事件循环被卡多久 |
| `demos/06-session/06-checkpoints.mjs` | 新增：工具观测自己这次调用有没有落盘（1 vs 0） |

## 下一课的痛点

现在崩溃是安全的了——但**读回来还不是**。

进程被杀在写一半，文件末尾会留下半行残缺的 JSON。6.2 的 `loadSession()` 遇到它直接抛错，于是**一次崩溃让整个会话读不回来**——我们花了一整课保证的落盘，最后卡在读的那一步。

**6.4 讲三件事**：截断修复（末行残缺可以修，其余的坏必须拒绝）、遇到不认识的事件类型该跳过还是该拒绝（`ignorable`）、以及格式版本什么时候必须拒绝读一个旧日志。
