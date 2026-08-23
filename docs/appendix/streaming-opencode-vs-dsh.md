# 附录：流式的四段链路，opencode 与 dsh 的对比

> SSE 解析 → 内存状态 → 落盘 → 用户可见，两边在**每一段**都做了不同的选择。全部结论来自现场读源码（opencode `v1.18.20`，dsh `0.1.0-rc.8`）。

## 一句话总结

**dsh 把流的每一个碎片当成事实记录下来；opencode 把碎片当成过场，只记录完整值。**

## ① SSE 解析：`[DONE]` 的地位完全相反

opencode（`packages/llm/src/protocols/shared.ts`）：

```ts
export const sseFraming = (bytes) =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.catchTag("Retry", () => Stream.empty),
    Stream.filter((event) => event.data.length > 0 && event.data !== "[DONE]"),   // ← 丢掉
    Stream.map((event) => event.data),
  )
```

`framing.ts` 的注释把 `[DONE]` 归类为 **keep-alive**：「UTF-8 decode the body, run the SSE channel decoder, **drop empty / `[DONE]` keep-alives**」。

dsh（`sse.ts`）：`[DONE]` 是**协议终止符**，缺了就抛 `LlmError('STREAM_CLOSED')`——「截断，这次模型调用不可信」。

| | opencode | dsh |
|---|---|---|
| `[DONE]` | 噪音，过滤掉 | 终止符，缺失即错误 |
| 判断流是否完整 | 靠协议层的 finish 事件 | 靠 `[DONE]` + finish 双重 |
| 分帧实现 | Effect `Stream.pipeThroughChannel(Sse.decode())` | `eventsource-parser` + 手写 `[DONE]` 语义 |

两边都没手写分帧（都用库），但**对同一个字节串赋予了不同的语义地位**。dsh 多一道检查，代价是要处理"某些兼容实现不发 `[DONE]`"的现实；opencode 少一道检查，代价是纯传输截断更难被当场识别。

## ② 内存状态：追加日志 vs 可变投影

**dsh**：`Session.log` 是 `SessionEvent[]`，只追加、事件 `deepFreeze`、`seq` 即位置。模型可见的历史由 `deriveMessages()` 从日志**投影**出来。

**opencode**：`SessionMessageUpdater` 维护 `MemoryState = { messages: SessionMessage.Message[] }`，用 immer 的 `produce` **原地更新**当前 assistant 消息：

```ts
export interface Adapter {
  readonly getCurrentAssistant: () => Effect.Effect<SessionMessage.Assistant | undefined>
  readonly updateAssistant: (assistant: SessionMessage.Assistant) => Effect.Effect<void>
  readonly appendMessage: (message: SessionMessage.Message) => Effect.Effect<void>
}
```

注意 `updateAssistant`——**opencode 的内存态里，一条 assistant 消息是会被反复改写的对象**；dsh 的内存态里没有任何东西会被改写，只有事件不断追加。

opencode 同时也有事件（`EventV2` + `SessionEvent.*`），并且**是事件溯源的**：durable 事件带 `aggregateID`/`seq`，有 `replay` / `replayAll`。所以它是「事件溯源 + 可变投影缓存」的组合，而 dsh 是「事件溯源 + 纯函数投影」。

## ③ 落盘：谁被写进去了

这是最锋利的一处差别。opencode 的事件定义里，`Started` / `Ended` 带 `...options`（即 `durable: { aggregate: "sessionID", version: 1 }`），而 `Delta` **没有**：

```ts
// Stream fragments are live-only; Text.Ended is the replayable full-value boundary.
export const Delta = Event.define({ type: "session.next.text.delta", schema: { ..., delta: Schema.String } })

export const Ended = Event.define({ type: "session.next.text.ended", ...options,
  schema: { ..., text: Schema.String } })        // ← 全文在这里
```

注释直说了：**流片段是 live-only，`Text.Ended` 才是可重放的完整值边界。**

`projector.ts` 也印证：只投影 `Text.Started` / `Text.Ended`，`Text.Delta` 根本没有 projector。

dsh 则相反——`assistant/chunk` 是**正经的 durable session 事件**：

```ts
/** Raw stream chunk — token-level replay fidelity. */
'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
```

| | opencode | dsh |
|---|---|---|
| 每个 token 碎片 | **不落盘**（live-only） | **落盘**（`assistant/chunk`） |
| 完整值 | `Text.Ended` 携带 `text` 全文 | `assistant/message` + `sourceEventSeqs` 指回碎片 |
| 写入时机 | 投影器写 SQLite（Drizzle） | 攒批 write-behind（默认 200ms）+ 语义检查点 fail-closed flush |
| 重放粒度 | 消息级 | **token 级** |

## ④ 用户可见：两边都是"从事件流渲染"

opencode 的 `Text.Delta` 虽然不落盘，但**照样 publish 到事件总线**，UI 订阅它做实时渲染。dsh 的 `assistant/chunk` 落进日志后同步广播 `session/event`，UI 订阅它。

**所以"用户看到的"这条链两边是同构的：都不是直接读模型流，都是读事件。** 差别在于那条事件之后**还去不去磁盘**。

于是"崩溃后能否重现用户当时看到的画面"这个问题，两边答案不同：

| 问题 | opencode | dsh |
|---|---|---|
| 能否重放出逐字打字的过程 | **不能**（碎片没了） | 能 |
| 能否恢复出完整消息 | 能（`Text.Ended`） | 能（`assistant/message`） |
| 流到一半崩溃，已显示的半句话在磁盘上 | **不在**（`Ended` 没发出） | 碎片在（但没有 message） |

## 这是一次真实的取舍，不是谁做错了

**opencode 的账**：省掉 token 级 I/O 与存储；事件表干净（一次回答一条 `Text.Ended`，不是几百条 delta）；代价是崩溃现场无法逐字重建，快照测试只能到消息粒度。

**dsh 的账**：token 级重放、审计、能做流级快照测试（它的 keyless 快照要重放真实的流）；代价是事件量级大一到两个数量级，需要 write-behind 攒批和语义检查点这套额外机制来把成本压回去——[附录：内存日志什么时候真的落盘](durability-checkpoints.md) 讲的就是这套机制。

**判断依据是"崩溃现场值多少钱"**：

- 如果产品的核心资产是**会话结果**（用户要的是最终代码），消息级足够。
- 如果核心资产包括**过程**（要审计 agent 做过什么、要用真实流回归测试、要向用户证明"当时确实是这么输出的"），就得付 token 级的价。

dsh 选了后者——它的 226 个包里有 796 个测试文件、271k 行测试代码，其中快照测试要重放真实的流。**token 级日志不是洁癖，是那套测试策略的物理前提。**

## 如果非要选一边（教师判断，不是事实）

以下是判断，不是源码事实，读的时候请带着怀疑。

**① SSE 语义：dsh 略胜。** `[DONE]` 是 OpenAI 系事实标准的终止符，把它降级成 keep-alive 就放弃了唯一能区分"干净结束"和"干净截断"的显式信号。opencode 大概率靠 finish 事件缺失达到类似效果，但那是隐式的——我在它源码里没找到显式的截断检测。**对"这段数据可不可信"这种判断，显式优于隐式。**

**② 内存态：dsh 明显更好，这条我最有把握。** opencode 同时有事件溯源**和**可变投影缓存（`updateAssistant` 原地改写），等于**两套真相要保持一致**；源码里 "A newer turn supersedes stale incomplete rows; never resume an older assistant projection" 这类注释，就是在手工处理这种不一致。dsh 只有一套真相加纯函数投影，而且能写出 `deriveMessages()` 结果必须等于实际请求的 runtime invariant——**这条断言在可变投影的架构里根本无法表达**。

代价要说清楚：纯投影每次都要 fold 日志，dsh 为此额外做了 `session-projection-cache`。它没有免费。

**③ 落盘粒度：看产品，但 dsh 的选择更有杠杆。** 理由不是"记得更全"，而是它让一整类实践成为可能：**流级快照测试**。dsh 的 keyless 快照要重放真实的流，物理前提就是 token 级记录。opencode 只能做到消息级回归。

反过来说，绝大多数产品不需要 token 级重放，而 dsh 为此付的复杂度（write-behind + 检查点策略 + 两层事件 + provenance 校验）是实打实的。**团队小、迭代快的产品，这套机制的维护成本可能超过收益。**

**④ 用户可见：平手。** 两边同构。

## 一处 opencode 明显更好

**Provider 层的组合能力。** opencode 把一条 route 拆成四个可组合的轴——`protocol` / `endpoint` / `auth` / `framing`，其中 framing 是有名字的接口：

```ts
export interface Framing<Frame> {
  readonly id: string
  readonly frame: (bytes: Stream.Stream<Uint8Array, LLMError>) => Stream.Stream<Frame, LLMError>
}
export const sse: Framing<string> = { id: "sse", frame: ProviderShared.sseFraming }
```

而且**真有第二个实现**：`protocols/bedrock-event-stream.ts` 里的 `framing()` 返回 `Framing<object>`，处理 AWS 的长度前缀二进制帧。

dsh 的 `sse.ts` 是 `llm-deepseek` 包**私有**的。今天没有重复代码（另一个适配器 `llm-pi-ai` 走 SDK，不碰 SSE），但结构上，第三个直连供应商如果用别的分帧方式，dsh 只能在那个适配器内部再写一份。

**这一刀正好砍在 dsh 最引以为傲的地方**：它在 fs / shell / subprocess 这些能力上把 seam 拆得很干净，却在 provider 内部留了一块没有拆的 transport 层。opencode 反过来——产品面的 seam 更粗，provider 面的组合更细。

## 总的判断

**dsh 在"正确性可论证"这个维度上明显更好；opencode 在"用最少机制交付产品"这个维度上更好。**

我个人倾向 dsh 的路线，理由是一个具体观察：**dsh 的每个关键决定都被一条机器检查钉住**——invariant 断言投影一致、gate 强制 `sourceEventSeqs` 非空且密集、检查点 fail-closed；而 opencode 的对应保证多数活在注释和约定里（"A newer turn supersedes stale incomplete rows" 是注释，不是断言）。

**在一个大量由 AI 编写和修改的代码库里，这个区别会被放大：注释约束不住 AI，机器检查能。**

---

回到 [2.4 阶段验收](../02-streaming/04-stage-review/01-stage-review.md) · 相关：[opencode 与 dsh 的体量与架构对比](opencode-vs-dsh.md)
