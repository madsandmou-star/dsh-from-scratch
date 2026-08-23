# 2.4 阶段 2 验收

> 本课目标：验收流式，并回答攒了三节课的问题——dsh 为什么干脆不提供非流式接口。

## 验收清单

```sh
# ① 打字机效果：增量逐个到达，不是一次性出现
printf '解释 agent\n' | node --import tsx src/index.ts
# [ 548ms] "agent "   [ 742ms] "是能"   [ 941ms] "自己调用"  ...

# ② 连接被掐（服务器 destroy / 网络断）
# [本轮中断，已丢弃] terminated

# ③ 干净结束但缺 [DONE]——最阴的一种
# [本轮中断，已丢弃] 流在收到 [DONE] 之前就结束了：这次回复不完整，不可信

# ④ 分帧器扛住恶意切分（三条挤一起 / 切在 JSON 中间 / 切开中文字）
# 五条事件一条不少

# ⑤⑥
npm run typecheck && npm run check
```

| 验收项 | |
|---|---|
| 知道 SSE 的线格式与空行分帧 | ✓ |
| 知道网络分块 ≠ 协议分帧 | ✓ |
| `TextDecoder({ stream: true })` 接住被切开的多字节字符 | ✓ |
| 流末未终止残片必须丢弃 | ✓ |
| 缺 `[DONE]` 当成错误，而不是正常结束 | ✓ |
| 流式接口用异步生成器，调用方自己攒完整文本 | ✓ |
| 断流时保历史干净 | ✓ |

## 本阶段产出

```
src/sse.ts       # 新增：SSE 分帧器
src/llm.ts       # 改：chat() → chatStream()，异步生成器
src/index.ts     # 改：逐字上屏 + 自攒完整文本 + 断流丢弃
src/types.ts     # 改：新增 StreamChunk
```

## dsh 为什么没有非流式接口

`dsh/packages/llm/llm/src/index.ts` 里的 `LlmAdapter` 抽象类，只有**一个**抽象方法：

```ts
abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
```

没有 `generate()`，没有 `complete()`。**想要完整文本？自己把流收集起来。**

四条理由，前两条是这一阶段亲身体会到的：

1. **流式是非流式的超集。** 收集所有增量就得到完整文本；反过来做不到。提供两条路径，等于让上层在"我要哪一种"上做一个本可以不做的决定。
2. **两条路径就是两套 bug。** 非流式路径在一个流式为主的产品里必然缺乏使用，缺乏使用就缺乏测试，缺乏测试就在某次重构后悄悄坏掉——直到某个用户走到那条路上。dsh 那次 Node 26 事故（0.1 讲过）的教训正是这个：**没人走的路径 = 没人测的路径 = 会坏的路径**。
3. **下游全都需要增量。** UI 要实时渲染，工具调用的参数分块到达（阶段 3），持久化要留原始增量做重放。给它们一个"完整字符串"等于把信息丢掉之后再让它们想办法。
4. **代价是真实的**，我们这一阶段付过了：调用方从一行 `await` 变成一个 `for await` 循环加手动累积。dsh 认为这个代价值得——**它把复杂度放在了一个地方（调用约定），而不是散布在"两条路径的差异"里**。

## StreamChunk：我们有一种，dsh 有七种

我们的生成器只产出一样东西：文本增量（`string`）。dsh 的 `StreamChunk` 是个七成员的联合类型：

```ts
| { type: 'block-start';       index: number; blockType: ContentBlockType }
| { type: 'text-delta';        index: number; text: string }
| { type: 'reasoning-delta';   index: number; text: string }
| { type: 'tool-call-delta';   index: number; id: CallId; name?: string; argumentsDelta: string }
| { type: 'block-end';         index: number; block: ContentBlock }
| { type: 'usage';             usage: TokenUsage }
| { type: 'finish';            reason: FinishReason; replayState?: ReplayEnvelope }
```

注意那个反复出现的 **`index`**。它存在的原因是：**一次响应里可以有多个"块"并行流动**——一段可见文本、一段思维链、三个工具调用，它们的增量交错到达。`index` 是把交错的碎片归位的钥匙。

`block-start` / `block-end` 则把"这一块开始了/结束了"变成显式事件，下游不用靠猜。阶段 3 你手写工具调用累积时会体会到没有这两个事件有多难受——你得自己判断"参数收全了没有"。

`translate.ts`（185 行）干的就是这件事：**把 DeepSeek 的 wire chunk 翻译成这套内部协议**，一个有状态的块装配器。它的模块注释里有一句很精确的话：**"finish reason 和最新的 usage 被推迟到 `[DONE]` 才产出，以便同时覆盖 finish 附带 usage 和尾部单独 usage 两种形态，并确保 `finish` 之后不再有任何 chunk。"**

"确保 finish 之后不再有 chunk"——这是一条**协议不变量**。有了它，下游可以放心地把 `finish` 当作终点。

## 原始增量要落盘

dsh 的 session 日志里有这么一个事件类型：

```ts
/** Raw stream chunk — token-level replay fidelity. */
'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
```

**每一个原始增量都会被写进持久化日志。** 不是"组装好的完整回复"，是 token 级别的原始碎片。

为什么值得存这么细：

- **重放 UI**：恢复一个历史会话时，能重现当时逐字出现的过程，而不是"啪"地出现全文
- **快照测试**：dsh 的 keyless 快照测试要重放真实的流，粒度不够就没法比对
- **审计**：模型到底吐了什么，原样留档

这就是 dsh 那条"**模型可见 ⟺ 已记录**"规矩的一个侧面：**不仅记录模型看到了什么，也记录模型产出的过程**。

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

## 它怎么知道"缺" `[DONE]`

**"缺失"是观测不到的。** 你没法在某一刻断言"后面不会再来 `[DONE]` 了"——除非流已经结束。所以代码结构必然是：

```ts
let 见过DONE = false
for await (const payload of parseSse(response.body)) {
  if (payload === '[DONE]') { 见过DONE = true; break }
  ...
}
if (!见过DONE) throw new Error('流在收到 [DONE] 之前就结束了')   // ← 回头看
```

**记一个标记 → 等循环退出 → 回头检查。** 所有"必须出现的终止标记"类协议都是这个形状。dsh 的 `sse.ts` 同构：`yield data; if (data === DONE) return`，循环外 `throw new LlmError(..., 'STREAM_CLOSED')`。

### "流结束"到底是哪个物理事件

三种，走的是两条不同代码路径：

| 物理事件 | 迭代器行为 | 谁抛错 |
|---|---|---|
| 服务器发 FIN（干净关闭） | 正常 `done` | **我们的标记检查**（`STREAM_CLOSED`） |
| 连接 RST / `destroy()` | 迭代器抛异常 | fetch 底层（我们实测到的 `terminated`） |
| 客户端主动 abort | 迭代器抛 `AbortError` | AbortSignal |

2.3 实测的那两条，正好是前两行。

### 第三种情况：对端**既不发数据也不关连接**

这才是真正的坑：**没有任何"结束"事件**，`for await` 永远等在那里，标记检查那行代码**永远不会执行**。

实测我们现在的代码（服务器发一块然后装死）：

```sh
timeout 8 sh -c "printf '你好\n' | node --import tsx src/index.ts"
# Terminated
# [8 秒后被强行掐断，退出码 143]
```

**挂死。** 这是本课程当前的一个已知缺口。

### dsh 的解法：空闲看门狗

`dsh/packages/llm/llm-deepseek/src/adapter.ts`：

```ts
using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
...
const result = await watchdog.next(iterator)
```

`idleWatchdog` 的 JSDoc 点出了它和"总超时"的关键区别：

> 计时器**只在 `next()` 未完成期间存在**，所以**消费者的思考时间不算作供应商的空闲时间**。

这个区分很实在：如果用总超时，一次长回答（模型正常吐 3 分钟）会被误杀；如果计时器把消费者处理时间也算进去，UI 渲染慢或落盘慢也会误杀。**空闲超时只问一件事：距离上一块数据到现在，对端沉默了多久。**

还有一个 `pulse()`，适配器把它作为回调传进请求：

```ts
() => { watchdog.pulse() }
```

SSE 规范允许 `:` 开头的**注释行**当心跳——它不产生任何数据，但证明对端还活着。收到注释就 `pulse()` 重新计时。（2.1 提过 `sse.ts` 的注释"只通过 transport-activity 回调报告"，用途就在这里。）

### 超时之后，错误要能被区分

```ts
if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
  throw new LlmError(`DeepSeek stream idle timeout after ${...}ms`, 'TIMEOUT', { cause: error })
}
if (options.signal?.aborted) {
  throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', { cause: error })
}
```

看门狗的 signal 是**上游取消**和**超时**融合出来的（`AbortSignal.any`），所以中断之后必须回头问："到底是谁赢了？"`timeoutOf()` 就是干这个的。

分成 `TIMEOUT` 和 `ABORTED` 两个码，是 1.3 讲过的"错误分类"的又一次兑现：**超时可以重试，用户取消绝对不能重试。**

## 一处我们和 dsh 不同的选择

我们决定：断流时**丢弃**半句话，不进历史。

dsh 的做法更细。看 `assistant/message` 事件的 JSDoc：

> 一个在流中途被**取消**的 turn，会把已交付的文本/思维链前缀作为这个事件落盘，并带上 `interrupted: true`；未派发的工具调用不写入。这个标记用来区分那段前缀，而不必从 turn 边界去反推是否发生过中断。

也就是说 dsh **保留**已交付的前缀，但**明确标记**它是被打断的。

看起来和我们相反，其实是因为**区分了两种情况**：

| | 谁触发的 | 已交付的内容算什么 | 处理 |
|---|---|---|---|
| **用户取消**（Ctrl-C、点停止） | 用户 | **已经发生的事实**——用户看到了，而且是他自己喊停的 | 保留 + `interrupted: true` |
| **传输截断**（缺 `[DONE]`、连接断） | 意外 | **不可信的残片**——可能停在半个 JSON 上 | 丢弃 |

**"半成品状态"不是一刀切地丢。** 判断标准是：这段内容是"确实发生过的事实"，还是"可能残缺的数据"。用户主动取消属于前者，传输故障属于后者。

我们现在只有传输故障这一种，所以只有"丢弃"这一条路径。阶段 13 加了取消之后，你会需要把这个区分补上——**到时候记得回来看这一节**。

## 工程思维总结

### 1. 少一条路径，少一半 bug

`LlmAdapter` 只有 `stream()` 一个方法，这是"**不给选择**"式的 API 设计。它不是限制表达力（流式能表达非流式），而是消除一整类"两条路径行为不一致"的 bug。

判断标准：**当 A 能完全表达 B、且 B 的使用场景不占主导时，删掉 B**。多出来的便利换不回它带来的维护成本。

### 2. 协议不变量比文档管用

"`finish` 之后不再有任何 chunk"——这一句让所有下游代码都能简单地写。没有这条保证，每个消费者都得自己防"finish 之后又来了一块"。

**把约束放进协议，而不是放进每个消费者的脑子里。**

### 3. 记录过程，不只记录结果

`assistant/chunk` 存的是 token 级碎片。多花的存储换来了重放、快照测试和审计——**三个你在写代码时想不到、但产品成熟后一定会需要的能力**。

## 阶段 2 学了什么

| 课 | 你现在应该能回答 |
|---|---|
| **2.1** | SSE 线格式与空行分帧；`delta` 不是 `message`；缺 `[DONE]` 意味着截断；缓冲会伪造延迟 |
| **2.2** | 网络分块 ≠ 协议分帧；`TextDecoder({stream:true})`；分帧 = 缓冲+找终止符+留残片；残片必须丢 |
| **2.3** | 异步生成器 vs 回调的三条取舍；调用方自攒完整文本；两种断流的区别；诊断走 stderr |
| **2.4** | dsh 为什么只有流式接口；`StreamChunk` 七种类型与 `index` 的作用；原始增量为什么落盘；取消与截断的区别 |

## 下一阶段的痛点预告

现在的 agent 只能**说话**。你问它"src/llm.ts 里写了什么"，它只能说"我看不到你的文件"。

阶段 3 要给它装上手脚：**工具调用**。这是 agent 和聊天机器人的分界线。

而你会立刻撞上流式留下的债——**工具调用的参数是分块到达的**：

```
delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }
delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "sr' } }] }
delta: { tool_calls: [{ index: 0, function: { arguments: 'c/llm.ts"}' } }] }
```

三块拼起来才是 `{"path": "src/llm.ts"}`。你得按 `index` 累积、判断收全了没有、然后才能 `JSON.parse`。

**这就是 2.4 里 dsh 那个 `block-end` 事件解决的问题**——它明确告诉你"这一块结束了"，而我们要自己判断。

---

下一阶段：阶段 3 工具循环（进入前先在 [COURSE.md](../../../COURSE.md) 细化小课）
