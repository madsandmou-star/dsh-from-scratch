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

---

回到 [2.4 阶段验收](../02-streaming/04-stage-review/01-stage-review.md) · 相关：[opencode 与 dsh 的体量与架构对比](opencode-vs-dsh.md)
