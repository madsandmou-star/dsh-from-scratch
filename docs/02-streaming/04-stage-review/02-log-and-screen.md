# 2.4a 内存日志、落盘、和用户看到的东西

> 本课目标：一个 SSE 增量到达之后到底经过了哪几手——先进哪儿、谁广播、什么时候真正落到文件里——以及流到一半出错时，日志和屏幕各自是什么样。
>
> 这一节从 [2.4 阶段验收](01-stage-review.md) 拆出来，因为它是一个独立的问题。

## 用户看到的和落盘的，怎么保证一致

流式有个绕不开的问题：**用户在 `[DONE]` 之前就看到内容了，而"完整消息"要等流结束才能组装。** 万一中途断了，用户看到的和落盘的就对不上——屏幕上有半句话，历史里什么都没有。

我们的代码正是这个毛病（2.3 亲历过）。dsh 用三件事把它消解掉了。

### ① 顺序是反的：先入日志，再广播

`dsh/packages/core/agent-loop/src/agent.ts` 的流循环：

```ts
for await (const chunk of stream) {
  signal.throwIfAborted()
  chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
  assembler.push(chunk)
}
```

**每个 chunk 一到，先 `append` 进日志拿到 `seq`，然后才交给装配器。**

`append` 内部的顺序（`dsh/packages/core/session/src/index.ts`）值得逐行看：

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
- 有重入保护：广播期间再调 `append` 会直接抛错，防止监听器递归写日志把顺序搞乱。

### ①′ "落盘"这个词要小心

`append` 写的是**内存日志**，不是磁盘。磁盘持久化是**另一个插件**的事——`session` 的模块注释写得很清楚：

> Persistence is a plugin concern（订阅 `session/event`，在 `session/flush` 时 drain）。

所以准确的图是这样：

```
模型流 → session.append（内存日志，成为事实）
             │
             └─ emit session/event ─┬→ UI / ACP / SDK 传输层  →  用户看到
                                    └→ 持久化插件（缓冲）  ──→ session/flush 时落盘
```

**UI 和持久化是同一次广播的两个并列订阅者**，UI 不需要等磁盘。真正的耐久检查点是 `session/flush`（`@mode parallel`，会被 await）。

> 那磁盘写到底发生在什么时候？攒批、语义检查点、卸载 drain 三条路径，见附录：[内存日志什么时候真的落盘](../../appendix/durability-checkpoints.md)。
>
> opencode 在这四段链路上的选择几乎处处相反，逐段对比见附录：[流式的四段链路](../../appendix/streaming-opencode-vs-dsh.md)。

所以"用户看到了但日志里没有"在物理上不可能——**日志是广播的上游**。但"用户看到了而磁盘还没写完"是完全可能的，那是另一个层次的问题，靠 `session/flush` 收口。

我们的课程代码则连第一层都没有：`process.stdout.write(delta)` 直接把模型流泼到屏幕，历史最后才写。不一致正是这么来的。

### ② 两层不同的真相，各自完整

| 层 | 事件 | 记录什么 | 谁消费 |
|---|---|---|---|
| **过程层** | `assistant/chunk` | token 级碎片，用户看到什么这里就有什么 | UI 渲染与重放 |
| **事实层** | `assistant/message` | 组装好的完整消息 | `deriveMessages()` → 模型下一轮 |

`surface.ts` 明确规定，只有三种事件进入"模型可见面"：`user/message`、`assistant/message`、`tool/result`。**`assistant/chunk` 不在其中。**

所以"用户看到的"和"模型下一轮看到的"**本来就是两个东西**，不需要逐字相等。要求它们相等才是设计错误。

### ③ provenance 把两层钉在一起

```ts
this.session.append('assistant/message', { turn, step, message, ...usage },
  { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
```

组装出的消息**声明自己是由哪些 chunk 事件派生的**。这不是可选注释——`surface.ts` 的校验会拒绝不合规的事件：

- surface-eligible 的事件**必须**带 `surfaceOp`
- `sourceEventSeqs` 必须是密集的非负整数，且不得为空（`assistant/message` 是唯一例外）

于是两层之间有一条**可机器检查的派生链**：UI 能把那批 chunk 折叠成一条消息而不产生歧义，审计时能反查"这条消息是从哪些碎片来的"。

### ③′ 举例：流到一半出错时，日志和屏幕各是什么样

先看错误路径的代码（`agent.ts`），两个 `finally` 是关键：

```ts
this.session.append('step/start', { turn, step })
try { ... } finally {
  this.session.append('step/end', { turn, step })        // ← 无论如何都写
}
...
} catch (error) {
  if (signal.aborted) { turnEnds = { kind: 'aborted', reason: signal.reason }; throw error }
  turnEnds = { kind: 'error', error: error instanceof LlmError
    ? error.failure                                       // LlmError 保留它的分类码
    : { message: errorChain(error), code: 'UNKNOWN' } }   // 其他错误压成文本
  this.throwError(error)
} finally {
  this.session.append('turn/end', { turn, reason: turnEnds! })   // ← 无论如何都写
}
```

**失败不是"什么都没发生"，失败本身也是一条要记录的事实。**

假设模型正在回答"agent 是能自己调用工具的程序"，吐到"agent 是能自己"的时候流断了。三种情况对比：

#### A. 正常完成

| 时刻 | 内存日志追加了什么 | 用户屏幕 |
|---|---|---|
| t0 | `turn/start` `step/start` | （空） |
| t1..t5 | `assistant/chunk` × 5 | `agent 是能自己调用工具去完成任务的程序。` |
| t6 | `assistant/message`（带 `sourceEventSeqs`） | 同上 |
| t7 | `step/end` `turn/end{completed}` | 同上 |

模型下一轮看到：完整回复（来自 `assistant/message`）。

#### B. 传输截断（缺 `[DONE]` 或连接断）

| 时刻 | 内存日志追加了什么 | 用户屏幕 |
|---|---|---|
| t0 | `turn/start` `step/start` | （空） |
| t1..t3 | `assistant/chunk` × 3 | `agent 是能自己` |
| t4 | ✗ **没有 `assistant/message`** | 同上（字还在屏幕上） |
| t5 | `step/end` | 同上 |
| t6 | `turn/end{ kind:'error', error:{ code:'STREAM_CLOSED', message:'SSE stream ended without [DONE]' } }` | UI 收到这条事件，渲染出错误状态 |

**模型下一轮看到：什么都没有。** 因为模型可见面只认 `assistant/message`，而它没被写。

于是三方各自正确且互不矛盾：

- **屏幕**：用户看到了"agent 是能自己"——这是事实，收不回来，也不必收回
- **日志**：三条 chunk 都在（可重放、可审计），外加一条明确的失败记录
- **模型**：完全不知道有过这段残片，下一轮不会被半句话污染

#### C. 用户取消（Ctrl-C / 点停止）

| 时刻 | 内存日志追加了什么 | 用户屏幕 |
|---|---|---|
| t1..t3 | `assistant/chunk` × 3 | `agent 是能自己` |
| t4 | `assistant/message{ interrupted: true, sourceEventSeqs:[…] }` | 同上 |
| t5 | `step/end` `turn/end{ kind:'aborted', reason }` | UI 渲染"已中断" |

**模型下一轮看到：`agent 是能自己`**，并且知道它是被打断的。

B 和 C 的日志差别只有一条事件（`assistant/message` 在不在），但语义天差地别——**这就是 2.4 反复强调的"已提交的事实 vs 不可信的残片"在数据上的样子**。

#### 对照我们的课程代码

| | dsh | 我们（阶段 2 结束时） |
|---|---|---|
| 三条 chunk | 在日志里，可重放 | **不存在**——直接 `stdout.write` 泼出去了 |
| 失败记录 | `turn/end{error, code}` 落盘 | 一行 `console.error`，进程退出就没了 |
| 模型下一轮 | 干净（没有 message） | 干净（我们 `messages.pop()`） |
| 能否事后追查"用户当时看到了什么" | 能 | **不能** |

最后一行是真正的差距。**我们只做对了"模型不被污染"，没做到"发生过什么有据可查"。** 阶段 12 补上。

### ④ 断掉的时候，三方各自正确

| 情况 | 日志里有 | 模型下一轮看到 | 用户看到 |
|---|---|---|---|
| **正常完成** | chunk + message | message | 全部内容 |
| **传输截断**（缺 `[DONE]`） | 只有 chunk | **什么都没有**（surface 只认 message 层） | 半句话，带中断提示 |
| **用户取消** | chunk + message(`interrupted: true`) | 已交付前缀 | 半句话 |

截断那一行是关键：**chunk 在日志里（用户看到的有据可查），但没有 `assistant/message`，所以模型下一轮完全不知道这段残片存在。**

**"一致性"不是"三者内容相同"，而是每一层都能说清自己的状态，且层与层之间有明确的派生关系。** 这是流式系统里唯一站得住的一致性定义——因为"用户已经看到"这件事不可撤销，你只能让它在正确的层里被承认。

### 代价

每个 chunk 一次 `append`。dsh 的 session 是内存日志 + 持久化 seam（JSONL / SQLite 后端），append 先进内存再落盘。token 级保真是花钱买来的——换回的是重放、快照测试和审计。

阶段 12 你会自己搭这套两层结构，那时候再回头看这一节。


---

回到 [2.4 阶段验收](01-stage-review.md)，或者继续看 [2.4b 流到底怎么算结束](03-stream-end-detection.md)。
