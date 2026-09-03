# 2.4b 流到底怎么算结束

> 本课目标：`[DONE]` 缺失是怎么被发现的、"流结束"对应哪个物理事件、以及对端**既不发数据也不关连接**时靠什么兜底。
>
> 这一节从 [2.4 阶段验收](01-stage-review.md) 拆出来，因为它是一个独立的问题。

## 它怎么知道"缺" `[DONE]`

**"缺失"是观测不到的。** 你没法在某一刻断言"后面不会再来 `[DONE]` 了"——除非流已经结束。所以代码结构必然是：

```ts
let sawDone = false
for await (const payload of parseSse(response.body)) {
  if (payload === '[DONE]') { sawDone = true; break }
  ...
}
if (!sawDone) throw new Error('流在收到 [DONE] 之前就结束了')   // ← 回头看
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
# [8 秒后被强行掐断，code 143]
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


## 教 debug：怀疑"流没正常结束"时看什么

三种结束（收到 `[DONE]`、连接关闭、对端不发也不关）在代码里是三条不同的路径，但症状都表现为"回复不完整"。分辨它们只要一件事：**把每一条到达的原始事件和到达时刻都打出来**。

```ts
for await (const data of parseSse(response.body)) {
  console.error(`[${Date.now() - t0}ms] ${JSON.stringify(data)}`)   // 走 stderr，别污染对话
}
```

看这三样：

- **最后一条是不是 `[DONE]`** —— 不是就说明被截断了
- **两条之间的间隔** —— 突然从 20ms 变成十几秒还没有下一条，那是对端挂住了（需要空闲看门狗）
- **有没有 `finish_reason`** —— `length` 说明被最大长度截断，这不是传输问题，是 `max_tokens` 太小

**先分清"传输坏了"和"内容就是这样"**，再决定是重试还是改参数。


---

回到 [2.4 阶段验收](01-stage-review.md)。
