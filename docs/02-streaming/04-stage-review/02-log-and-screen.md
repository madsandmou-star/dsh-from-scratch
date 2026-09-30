# 2.4a 内存日志、落盘、和用户看到的东西

> 本课目标：一个 SSE 增量到达之后到底经过了哪几手——先进哪儿、谁广播、什么时候真正落到文件里——以及流到一半出错时，日志和屏幕各自是什么样。
>
> 这一节从 [2.4 阶段验收](01-stage-review.md) 拆出来，因为它是一个独立的问题。

## 用户看到的和落盘的，怎么保证一致

流式有个绕不开的问题：**用户在流结束之前就看到内容了，而"完整消息"要等流结束才能组装。** 万一中途断了，用户看到的和落盘的就对不上——屏幕上有半句话，历史里什么都没有。

我们的代码正是这个毛病（2.3 亲历过）。dsh 的做法是：**承认屏幕和日志是两条不同的通道，然后让两条通道在每一次尝试结束时明确地对一次账。**

### ① 两条通道：临时广播和日志

`dsh/packages/core/agent-loop/src/agent.ts` 的流循环：

```ts
live.start()
started = true
for await (const chunk of stream) {
  signal.throwIfAborted()
  live.push(chunk)
}
```

`live` 是一个 `AssistantStreamAttempt`（同目录的 `assistant-stream.ts`），代表"一次模型调用尝试"。`push()` 对每个 chunk 做三件事：

```ts
push(chunk: StreamChunk): void {
  const timed = this.accumulator.push({ time: Date.now(), chunk })   // ① 压进内存里的紧凑记录（2.4 讲过）
  this.assembler.push(timed.chunk)                                  // ② 喂给装配器，拼完整消息
  this.emit({ type: 'chunk', attemptId: this.attemptId, ... })      // ③ 临时广播给 UI
}
```

**注意这里没有 `session.append`。** 第 ③ 步发的是 `agent/assistant-stream` 事件，它的 JSDoc 说得很直白：

> Process-local assistant-stream publication. Chunk frames are transient; the loop appends one final v2 `assistant/message` or `assistant/attempt` with the same stream before a committed end frame.
>
> （进程内的助手流广播。chunk 帧是临时的；循环会先追加一条最终的 `assistant/message` 或 `assistant/attempt`，带着同一条流，然后才发"已提交"的结束帧。）

所以一个 chunk 到达时，**用户已经能看到它，而日志里还没有它**。它进日志要等这一步结束，而且是连同整条流一起、作为一条事件进去。

### ② 对账：结束帧说清楚"这次尝试最后变成了什么"

对账发生在 `settle()`：

```ts
settle(eventType: 'assistant/message' | 'assistant/attempt', append: () => SessionSeq): void {
  let seq: SessionSeq
  try {
    seq = append()             // ① 先写日志
  } catch (error: unknown) {
    this.abandon()             //    写不进去：发一个 abandoned 结束帧
    throw error
  }
  this.terminal = true
  this.emit({ type: 'end', ..., outcome: { kind: 'committed', eventType, seq } })   // ② 再告诉 UI
}
```

顺序是关键：**先写日志，再发结束帧，结束帧里带着那条日志事件的 `seq`**。UI 收到 `committed` 时，可以把刚才那串临时 chunk 换成日志里那条正式事件；收到 `abandoned` 时，就知道刚才屏幕上那些字**没有成为记录**。

`session.append` 本身（`dsh/packages/core/session/src/index.ts`）的顺序也值得逐行看：

```ts
this.surfaceManager.validateNext(event)     // ① 校验：不合规直接抛，根本不进日志
...
callbacks = collectSessionCallbacks(...)    // ② 先固定订阅者名单
this.log.push(event)                        // ③ 进日志——此刻它成为事实
invokeContainedSessionObservers(...)        // ④ 再同步广播 session/event
```

四个细节：

- 事件是 `deepFreeze` 的，`seq` 就是它在日志里的位置——**不可变、有序、可引用**。
- 校验在入库之前：不合规的事件不会污染日志。
- **订阅者名单在 push 之前就固定**，避免监听器在广播中途注册/注销影响本次派发。
- 有重入保护：广播期间再调 `append` 会直接抛 `session append cannot reenter while another append is being published`，防止监听器递归写日志把顺序搞乱。

### ②′ "落盘"这个词要小心

`append` 写的是**内存日志**，不是磁盘。磁盘持久化是**另一个插件**的事——`session` 的模块注释写得很清楚：

> Persistence is a plugin concern (subscribe to `session/event`, drain on `session/flush`).
>
> （持久化是插件的事：订阅 `session/event`，在 `session/flush` 时排干。）

所以准确的图是这样：

```
模型流 → live.push ──→ agent/assistant-stream（临时帧）──→ UI：用户马上看到
            │
            └─ 攒在 live 里，这一步结束时 ↓
               session.append(assistant/message 或 assistant/attempt，带整条 stream)
                  │
                  └─ emit session/event ─┬→ UI / ACP / SDK：把临时帧换成正式事件
                                         └→ 持久化插件（缓冲）──→ session/flush 时落盘
               然后发结束帧 end{ committed, seq }
```

> 那磁盘写到底发生在什么时候？攒批、语义检查点、卸载 drain 三条路径，见附录：[内存日志什么时候真的落盘](../../appendix/durability-checkpoints.md)。
>
> opencode 在这四段链路上的选择，逐段对比见附录：[流式的四段链路](../../appendix/streaming-opencode-vs-dsh.md)。

我们的课程代码两条通道都没有设计过：`process.stdout.write(delta)` 直接把模型流泼到屏幕，历史最后才写，中间没有任何对账。不一致正是这么来的。

### ③ 两层不同的真相，各自完整

| 层 | 在哪 | 记录什么 | 谁消费 |
|---|---|---|---|
| **过程层（活的）** | `agent/assistant-stream` 的 chunk 帧 | 正在到达的碎片 | UI 实时渲染 |
| **过程层（留档）** | 事件里的 `stream` 字段 | 同一批碎片，带时间，可还原 | 重放、快照测试、审计 |
| **事实层** | `assistant/message` 的 `message` 字段 | 组装好的完整消息 | `deriveMessages()` → 模型下一轮 |

`dsh/packages/core/session/src/surface.ts` 规定，只有五种事件进入"模型可见面"：`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`。**`assistant/attempt` 不在其中**——失败的尝试留档，但模型看不到。

所以"用户看到的"和"模型下一轮看到的"**本来就是两个东西**，不需要逐字相等。要求它们相等才是设计错误。

### ③′ 派生关系：从"引用"变成"包含"

一条模型可见的事件，要说清楚自己是从哪儿来的。`tool/result` 这类事件用 `sourceEventSeqs` 列出它依据的那些事件的 `seq`。而 `assistant/message` 在类型上**禁止**带这个字段（`dsh/packages/core/session/src/types.ts` 的 `SurfaceIntent`）：

```ts
} & (T extends 'assistant/message' ? {
  /** Assistant messages embed their provider stream instead of citing source events. */
  sourceEventSeqs?: never
```

理由就在注释里：**它把自己的来源直接装在身上了**（`stream` 字段），不需要再指向别的事件。碎片和成品在同一条事件里，不可能对不上。

### ③″ 举例：流到一半出错时，日志和屏幕各是什么样

先看错误路径的骨架（`agent.ts`），两个 `finally` 是关键：

```ts
this.session.append('step/start', { turn, step })
try { ... } finally {
  this.session.append('step/end', { turn, step })        // ← 无论如何都写
}
...
} catch (error: unknown) {
  const cause = abortedCancelCause(signal)
  if (cause !== undefined) { turnEnds = { kind: 'aborted', reason: cause }; throw error }
  turnEnds = { kind: 'error', error: error instanceof LlmError
    ? error.failure                                       // LlmError 保留它的分类码
    : { message: errorChain(error), code: 'UNKNOWN' } }   // 其他错误压成文本
  this.throwError(error)
} finally {
  this.session.append('turn/end', { turn, reason: turnEnds! })   // ← 无论如何都写
}
```

**失败不是"什么都没发生"，失败本身也是一条要记录的事实。**

假设模型正在回答"agent 是能自己调用工具的程序"，吐到"agent 是能自己"的时候出事了。四种情况对比：

#### A. 正常完成

| 时刻 | 日志追加了什么 | 临时帧 | 用户屏幕 |
|---|---|---|---|
| t0 | `turn/start` `step/start` | `start` | （空） |
| t1..t5 | （什么都没有） | `chunk` × 5 | `agent 是能自己调用工具去完成任务的程序。` |
| t6 | `assistant/message`（`stream` 里是那 5 块） | `end{ committed }` | 同上 |
| t7 | `step/end` `turn/end{completed}` | | 同上 |

模型下一轮看到：完整回复。

#### B. 传输截断（缺 `message_stop` 或连接断）

| 时刻 | 日志追加了什么 | 临时帧 | 用户屏幕 |
|---|---|---|---|
| t0 | `turn/start` `step/start` | `start` | （空） |
| t1..t3 | （什么都没有） | `chunk` × 3 | `agent 是能自己` |
| t4 | `assistant/attempt`（`stream` 里是那 3 块） | `end{ committed, eventType: 'assistant/attempt' }` | 同上（字还在屏幕上） |
| t5 | `step/end` | | 同上 |
| t6 | `turn/end{ kind:'error', error:{ code:'STREAM_CLOSED', … } }` | | UI 渲染出错误状态 |

`STREAM_CLOSED` 不在默认可重试的错误码里（`dsh/packages/llm/llm/src/retry-policy.ts` 的 `DEFAULT_RETRYABLE_CODES` 是 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`），所以这一轮就此结束。

**模型下一轮看到：什么都没有。** `assistant/attempt` 不是模型可见的事件。

于是三方各自正确且互不矛盾：

- **屏幕**：用户看到了"agent 是能自己"——这是事实，收不回来，也不必收回
- **日志**：那 3 块在 `assistant/attempt` 里（可重放、可审计），外加一条明确的失败记录
- **模型**：完全不知道有过这段残片，下一轮不会被半句话污染

#### C. 用户取消（Ctrl-C / 点停止）

| 时刻 | 日志追加了什么 | 临时帧 | 用户屏幕 |
|---|---|---|---|
| t1..t3 | （什么都没有） | `chunk` × 3 | `agent 是能自己` |
| t4 | `assistant/message{ interrupted: true }`（带 `stream`） | `end{ committed }` | 同上 |
| t5 | `step/end` `turn/end{ kind:'aborted', reason }` | | UI 渲染"已中断" |

**模型下一轮看到：`agent 是能自己`**，并且知道它是被打断的。（如果取消时一个字都还没交付，写的是 `assistant/attempt`，模型什么也看不到。）

B 和 C 的区别只在于写的是 `assistant/attempt` 还是 `assistant/message`，但语义天差地别——**这就是 2.4 反复强调的"已提交的事实 vs 不可信的残片"在数据上的样子**。

#### D. 进程在 t3 被杀

| 时刻 | 日志追加了什么 | 临时帧 | 用户屏幕 |
|---|---|---|---|
| t0 | `turn/start` `step/start` | `start` | （空） |
| t1..t3 | （什么都没有） | `chunk` × 3 | `agent 是能自己` |
| 💥 | — | — | — |

**用户看到过的那 3 块，日志里没有。** 它们只在进程内存里，进程没了它们就没了。下次打开会话时，dsh 用 `interruptedTurnClosers()`（`dsh/packages/core/session/src/repair.ts`，6.4 会讲）补上 `step/end` 和 `turn/end`，但那半句话找不回来。

这是 0.2 这种设计明确付出的代价：**每一步只写一次日志，换来的是"写之前崩溃，这一步正在流的内容整个丢掉"。** dsh 0.1 每个 chunk 写一条 `assistant/chunk`，那时 D 情况下碎片是在日志里的（附录[流式的四段链路](../../appendix/streaming-opencode-vs-dsh.md)里有这个取舍的对比）。

#### 对照我们的课程代码

| | dsh | 我们（阶段 2 结束时） |
|---|---|---|
| 流的碎片 | 这一步结束时整条进日志（`message` 或 `attempt`） | **不存在**——直接 `stdout.write` 泼出去了 |
| 失败记录 | `turn/end{error, code}` 进日志 | 一行 `console.error`，进程退出就没了 |
| 模型下一轮 | 干净（`attempt` 不可见） | 干净（我们 `messages.pop()`） |
| 能否事后追查"用户当时看到了什么" | 能（进程没被杀的前提下） | **不能** |

最后一行是真正的差距。**我们只做对了"模型不被污染"，没做到"发生过什么有据可查"。** 阶段 12 补上。

### ④ 断掉的时候，三方各自正确

| 情况 | 日志里有 | 模型下一轮看到 | 用户看到 |
|---|---|---|---|
| **正常完成** | `assistant/message`（带 stream） | message | 全部内容 |
| **传输截断**（缺 `message_stop`） | `assistant/attempt`（带 stream） | **什么都没有** | 半句话，带错误提示 |
| **用户取消** | `assistant/message{ interrupted: true }` | 已交付前缀 | 半句话 |
| **进程被杀** | 只有 `turn/start` `step/start`，续聊时补齐收尾 | 什么都没有 | 半句话（进程没了，屏幕也没了） |

**"一致性"不是"三者内容相同"，而是每一层都能说清自己的状态，且层与层之间有明确的派生关系。** 这是流式系统里唯一站得住的一致性定义——因为"用户已经看到"这件事不可撤销，你只能让它在正确的层里被承认。

### 代价

dsh 0.1 付的是事件数量：每个 chunk 一次 `append`，一次回答几百条事件。0.2 把它压到每一步一条，付的是 D 那一行：**正在流的那一步，崩溃时整个丢掉**。token 级保真两个版本都有；变的是"它在什么时刻成为记录"。

阶段 12 你会自己搭这套两层结构，那时候再回头看这一节。


## 教 debug：怀疑"屏幕和日志对不上"时看什么

这一节讲的几层（临时帧、内存日志、广播、落盘）出问题时，症状都长得像"UI 显示不对"，但根因在完全不同的地方。分辨方法是**逐层往下问**：

| 现象 | 先看哪一层 | 怎么看 |
|---|---|---|
| 屏幕上有，重开会话就没了 | **对账** | 那次尝试有没有收到 `end{ committed }`？没有就是那一步根本没进日志（`abandoned`，或者进程在步结束前没了） |
| 收到了 `committed`，重开还是没了 | **落盘** | 去日志文件里 grep 那段文本；找不到就是内存里有、没刷到盘 |
| 日志里有，屏幕上没有 | **广播/订阅** | 看那个订阅者是不是在事件发生之后才注册的 |
| 两边都有但顺序不对 | **append 的调用点** | 打印每条事件的 `seq`，看追加顺序和你以为的是否一致 |

**先确定"谁是权威"，再顺着它往下查。** 权威是那条只增不改的日志——临时帧只是"还没对账的预览"，文件只是日志的副本，出错的往往是预览和副本，不是源头。


---

回到 [2.4 阶段验收](01-stage-review.md)，或者继续看 [2.4b 流到底怎么算结束](03-stream-end-detection.md)。
