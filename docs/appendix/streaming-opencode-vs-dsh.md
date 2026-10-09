# 附录：流式的四段链路，opencode 与 dsh 的对比

> SSE 解析 → 内存状态 → 落盘 → 用户可见，两边在**每一段**都做了不同的选择。全部结论来自现场读源码（opencode `v1.18.20`，dsh `0.2.1-alpha.1`；这几段源码和 `0.2.0-rc.2` 完全相同）。这篇最早是对着 dsh `0.1.0-rc.8` 写的；dsh 在两个版本之间改了落盘这一段，改动本身很有教学价值，下面会单独讲。

## 一句话总结

**两边都把流的碎片当成过场，实时广播、不单独落盘；区别在收尾那条记录：opencode 只记完整文本，dsh 把整条带时间的碎片流一起装进去。**

## ① SSE 解析：终止标记的地位完全相反

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

dsh 0.2 已经不走 OpenAI 协议了：它连的是 DeepSeek 的 Anthropic 兼容 Messages 接口，那里根本没有 `[DONE]`，终止标记是一个有名字的 `message_stop` 事件。`translate.ts` 循环外那一行：

```ts
throw new LlmError('DeepSeek Messages stream ended before message_stop', 'STREAM_CLOSED')
```

（0.1 时 dsh 走 OpenAI 协议，`sse.ts` 把 `[DONE]` 当终止符，缺了同样抛 `STREAM_CLOSED`——判断没变，只是标记换了。）

| | opencode | dsh |
|---|---|---|
| 终止标记 | `[DONE]` 当噪音过滤掉 | `message_stop`，缺失即 `STREAM_CLOSED` |
| 判断流是否完整 | 靠协议层的 finish 事件 | 靠 `message_stop` 到达时"所有块已关闭、有停止原因"（否则 `MALFORMED_RESPONSE`） |
| 分帧实现 | Effect `Stream.pipeThroughChannel(Sse.decode())` | `eventsource-parser` + 手写终止语义 |

两边都没手写分帧（都用库）。**dsh 对"结束"要求一个显式标记，并且在标记到达时再核对一遍状态**；opencode 少一道检查，代价是纯传输截断更难被当场识别。

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

dsh 0.2 的做法和它**一半相同**：碎片也是 live-only，走的是进程内的 `agent/assistant-stream` 事件（JSDoc 原话："Chunk frames are transient"）。**另一半不同**：收尾那条 `assistant/message` 不只带完整消息，还带着整条流：

```ts
/** Exact timed model stream, compacted without joining delta boundaries. */
stream: AssistantStreamRecord[]
```

每个增量的原文和到达时刻都在里面，能原样还原（2.4 讲过它怎么压紧）。

| | opencode | dsh 0.2 |
|---|---|---|
| 每个 token 碎片 | **不单独落盘**（live-only） | **不单独落盘**（临时帧） |
| 收尾记录 | `Text.Ended` 携带 `text` 全文 | `assistant/message` 携带完整消息 **和** 带时间的整条流 |
| 失败的尝试 | 没有 `Ended` | `assistant/attempt`，同样带整条流，模型不可见 |
| 写入时机 | 投影器写 SQLite（Drizzle） | 追加进内存日志，JSONL 后端攒批（200ms）+ 语义检查点 fail-closed flush |
| 重放粒度 | 消息级 | **token 级**（只要那一步写完了） |

### dsh 自己在这一段改过主意

dsh 0.1 的 `assistant/chunk` 是**正经的 durable 事件**：每个增量一条，一次回答几百条。会话格式 v2（`dsh-v0.1.3-alpha.1`）删掉了它，换成上面这种"整步一条、流装在里面"的形状（`dsh/docs/persistence-changes/releases/dsh-v0.1.3-alpha.1.md`）。

这次改动的得失可以说得很具体：

| | 0.1（每块一条事件） | 0.2（每步一条事件） |
|---|---|---|
| token 级重放 | 有 | 有 |
| 一次回答的事件数 | 几百 | 1 |
| 进程在一步中间被杀 | 已到达的碎片多半已经刷到盘上（攒批写不必等这一步结束） | **那一步的碎片全丢** |
| 屏幕和日志的一致性 | 日志是广播的上游，屏幕上的必在日志里 | 靠结束帧对账（2.4a） |

dsh 自己的设计笔记（`dsh/.agents/notes/implemented/architecture/2026-09-01-v2-embedded-assistant-streams.md`）把两边的理由都写了。反对"每块一条事件"：

> making each chunk a top-level Session event repeats envelopes throughout persistence, telemetry, history transport, indexing, and client assembly.
>
> （每块一条顶层事件，意味着每一块都要在持久化、遥测、历史传输、索引、客户端组装里各背一份事件外壳。）

反对"干脆只存组装好的消息"（也就是 opencode 的做法）：

> Storing only assembled successful messages would remove that overhead but lose failed and abandoned output, token boundaries, timestamps, and deterministic provider replay.
>
> （只存成功组装的消息能省掉开销，但会丢掉失败和中途放弃的输出、token 边界、时间戳，以及可确定地向供应商重放的能力。）

代价它也认了："A hard process or host loss before settlement discards the complete in-flight stream; `agent/assistant-stream` is not a write-ahead log."（一步结束之前进程或机器挂掉，这一步正在流的内容全部丢失；临时帧不是预写日志。）

量级有多大？同一批笔记里记了一个真实会话：旧格式下展开是**约 914 万条**事件，转成新格式后是 **72,784 条**（`dsh/.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md`）。

**dsh 保住了它真正在乎的东西（token 级重放），放弃了一个代价很高的附带性质（崩溃瞬间的碎片）。** 这和 opencode 当初的判断是同一个方向，只是 dsh 多留了一样：时间和边界。

## ④ 用户可见：两边都是"从事件流渲染"

opencode 的 `Text.Delta` 虽然不落盘，但**照样 publish 到事件总线**，UI 订阅它做实时渲染。dsh 的临时帧走 `agent/assistant-stream`，UI 订阅它；一步结束时，`assistant/message` 进日志、广播 `session/event`，然后一个带 `seq` 的结束帧告诉 UI"刚才那串已经成了第几号事件"。

**所以"用户看到的"这条链两边是同构的：都不是直接读模型流，都是读事件。**

于是"事后能否重现用户当时看到的画面"这个问题：

| 问题 | opencode | dsh 0.2 |
|---|---|---|
| 能否重放出逐字打字的过程 | **不能**（碎片没了） | 能（`stream` 字段） |
| 能否恢复出完整消息 | 能（`Text.Ended`） | 能（`assistant/message`） |
| 流到一半崩溃，已显示的半句话在磁盘上 | **不在**（`Ended` 没发出） | **不在**（那一步没写完）；dsh 0.1 时多半在 |

## 这是一次真实的取舍，不是谁做错了

**opencode 的账**：省掉 token 级 I/O 与存储；事件表干净（一次回答一条 `Text.Ended`，不是几百条 delta）；代价是崩溃现场无法逐字重建，快照测试只能到消息粒度。

**dsh 的账**：token 级重放、审计、能做流级快照测试（它的 keyless 快照要重放真实的流）；代价是每条收尾记录更大（带着整条流），外加结束帧对账和 `assistant/attempt` 这些额外概念。0.1 时的代价更重——事件量级大一到两个数量级，全靠攒批写来压成本；0.2 把这一项砍掉了。攒批和检查点这套机制本身还在，见[附录：内存日志什么时候真的落盘](durability-checkpoints.md)。

**判断依据是"崩溃现场值多少钱"**：

- 如果产品的核心资产是**会话结果**（用户要的是最终代码），消息级足够。
- 如果核心资产包括**过程**（要审计 agent 做过什么、要用真实流回归测试、要向用户证明"当时确实是这么输出的"），就得付 token 级的价。

dsh 选了后者——它的 319 个包里有 1,374 个测试文件、约 42.6 万行测试代码（按 `*.test.ts`/`*.spec.ts` 后缀统计，0.2.1-alpha.1），其中快照测试要重放真实的流。**token 级日志不是洁癖，是那套测试策略的物理前提。**

## 如果非要选一边（教师判断，不是事实）

以下是判断，不是源码事实，读的时候请带着怀疑。

**① SSE 语义：dsh 略胜。** `[DONE]` 是 OpenAI 系事实标准的终止符，把它降级成 keep-alive 就放弃了唯一能区分"干净结束"和"干净截断"的显式信号。opencode 大概率靠 finish 事件缺失达到类似效果，但那是隐式的——我在它源码里没找到显式的截断检测。**对"这段数据可不可信"这种判断，显式优于隐式。**

**② 内存态：dsh 明显更好，这条我最有把握。** opencode 同时有事件溯源**和**可变投影缓存（`updateAssistant` 原地改写），等于**两套真相要保持一致**；源码里 "A newer turn supersedes stale incomplete rows; never resume an older assistant projection" 这类注释，就是在手工处理这种不一致。dsh 只有一套真相加纯函数投影，所以"每一次请求都能从日志算回来"能被写成**一条可以机械检查的断言**——到 0.2.0-rc.2 为止，dsh 确实有这么一条运行时断言（`agent-loop` 的 `invariant.ts`；0.2.1-alpha.1 随整套运行时不变量一起删掉了，规矩本身仍写在架构文档里）。**在可变投影的架构里，这句话连写成断言都做不到。**

代价要说清楚：纯投影每次都要 fold 日志，dsh 为此额外做了 `session-projection-cache`。它没有免费。

**③ 落盘粒度：看产品，但 dsh 的选择更有杠杆。** 理由不是"记得更全"，而是它让一整类实践成为可能：**流级快照测试**。dsh 的 keyless 快照要重放真实的流，物理前提就是 token 级记录。opencode 只能做到消息级回归。

反过来说，绝大多数产品不需要 token 级重放，而 dsh 为此付的复杂度（紧凑流编码 + 结束帧对账 + 检查点策略 + provenance 校验）是实打实的。dsh 自己从 0.1 到 0.2 砍掉"每块一条事件"，也说明第一版付的价确实偏高。**团队小、迭代快的产品，这套机制的维护成本可能超过收益。**

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

dsh 的 `sse.ts` 是 `llm-deepseek` 包**私有**的。今天没有重复代码（另一个适配器 `llm-pi-ai` 走 pi-ai 库，不碰 SSE），但结构上，第三个直连供应商如果用别的分帧方式，dsh 只能在那个适配器内部再写一份。

**这一刀正好砍在 dsh 最引以为傲的地方**：它在 fs / shell / subprocess 这些能力上把 seam 拆得很干净，却在 provider 内部留了一块没有拆的 transport 层。opencode 反过来——产品面的 seam 更粗，provider 面的组合更细。

## 总的判断

**dsh 在"正确性可论证"这个维度上明显更好；opencode 在"用最少机制交付产品"这个维度上更好。**

我个人倾向 dsh 的路线，理由是一个具体观察：**dsh 的每个关键决定都被一条机器检查钉住**——日志入口先校验、不合规的事件进不了日志，类型和校验强制 `sourceEventSeqs` 非空且密集（`assistant/message` 则直接禁止它、改为自带流），检查点 fail-closed（rc.8 时还有一层运行时 invariant 核对投影一致，0.2.1 删了）；而 opencode 的对应保证多数活在注释和约定里（"A newer turn supersedes stale incomplete rows" 是注释，不是断言）。

**在一个大量由 AI 编写和修改的代码库里，这个区别会被放大：注释约束不住 AI，机器检查能。**

---

回到 [2.4 阶段验收](../02-streaming/04-stage-review/01-stage-review.md) · 相关：[opencode 与 dsh 的体量与架构对比](opencode-vs-dsh.md)
