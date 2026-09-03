# 附录：内存日志什么时候真的落盘

> 起因是一个课堂问题：既然 `session.append()` 写的是内存日志、UI 看到的是广播，那**磁盘**上的东西什么时候写？
>
> 这一篇属于阶段 12 的内容，提前拆出来回答。读它只需要知道 [2.4](../02-streaming/04-stage-review/01-stage-review.md) 讲过的两件事：`append` 先入内存日志再同步广播；持久化是订阅 `session/event` 的另一个插件。

## 三条路径把内存里的事件推到磁盘

### ① 攒批写（write-behind）

`dsh/packages/session/session-persistence/src/coordinator.ts` 注册的监听器只做一件事——入队：

```ts
ctx.on('session/event', (session, event) => {
  const live = this.initFor(session)
  live.writes.enqueue(event)
})
```

`SessionWriteBehind` 是"每个会话一个的有界写批控制器"，它持有待写事件、一个固定的批量截止时间、当前进行中的写、失败保留和显式静默屏障。默认截止时间：

```ts
/** Default maximum intentional wait before a live session batch starts writing. */
export const DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 200
```

**所以正常情况下 token 级的 chunk 是攒批落盘的，不是一条一次 I/O。** 200ms 是"空闲队列收到活儿之后最多等多久就开写"——这解决了 2.4 末尾那个"每 token 一次 append 是不是太贵"的疑问：贵的是内存追加（很便宜），磁盘写被批量摊薄了。

### ② 语义检查点（这是最值得学的一层）

光有攒批不够。`session-checkpoint-policy` 这个插件在**三个语义边界**上强制 flush，并且 `await` 到真正耐久：

```ts
ctx.on('llm/stream', ...)      // 发请求给模型之前
ctx.on('tools/execute', ...)   // 执行顶层工具之前
ctx.on('agent/pre-step', ...)  // 每个 step 开始之前
```

它的模块注释说明了意图：

> **Delay construction of the downstream model stream until the complete logged request prefix is durable.**（推迟下游模型流的构造，直到已记录的完整请求前缀变得耐久。）
>
> Checkpoint failures are **fail-closed** at the model and tool side-effect boundaries: the downstream adapter or tool body is not invoked.（检查点失败时，下游适配器或工具体根本不会被调用。）

**规则可以这样记：任何不可撤销的外部动作之前，先让记录变耐久。**

为什么锚定在动作边界而不是按时间？设想进程在这两个瞬间崩溃：

| 崩溃时刻 | 后果 |
|---|---|
| 工具 `rm -rf build/` 已执行，日志还在缓冲区 | **副作用发生了，但没有记录** — 重启后系统不知道它跑过 |
| 日志已耐久，工具还没执行 | 记录说"要执行"，实际没执行 — 可以对账、可以重试 |

第一种是灾难，第二种只是不一致但可恢复。**所以顺序必须是"先记录耐久，再产生副作用"**，而不是反过来。发请求给模型也一样：一次模型调用要花钱、可能触发下游动作，属于不可撤销。

`fail-closed` 是这条规则的牙齿：**刷盘失败就不许往下走**。如果只是记个日志继续跑，规则就成了摆设。

### ③ 卸载时的最终 drain

```ts
// Register the disposer BEFORE the listeners. Cordis tears effects down in
// reverse registration order, so event admission closes before this final
// drain reaches quiescence and closes the backend.
ctx.effect(() => async () => {
  const errors = await settledErrors([...this.live.keys()].map(session => this.flush(session)))
  while (this.chains.size > 0) await Promise.allSettled([...this.chains.values()])
  ...
  await this.backend.close?.()
})
```

注释里那句话是本附录的隐藏彩蛋：**disposer 必须比监听器先注册**。Cordis 按注册的**反序**拆卸，所以"先注册 disposer、后注册监听器" ⇒ 拆卸时"监听器先关（不再接收新事件）、disposer 后跑（把已有的排干）"。

顺序反过来的话，最终 drain 跑完之后监听器还活着，又有新事件进来，缓冲区里就会剩下永远写不出去的东西。**这是"注册顺序即拆卸顺序"这类 bug 的活标本**，阶段 9 讲可逆注册时会正面讲它。

## 一次完整的 turn，磁盘视角

```
agent/pre-step   → flush（把上一步提交的东西刷干净）
  append user/message、request/header …          ← 内存
llm/stream 前    → flush（请求前缀必须耐久，否则不发请求）
  append assistant/chunk × N                     ← 内存，200ms 攒批写
  append assistant/message                       ← 内存
tools/execute 前 → flush（副作用之前必须耐久，否则不执行）
  runTool，append tool/result                    ← 内存
  append step/end、turn/end                      ← 内存
（下一个 step 的 pre-step）→ flush
```

**耐久性不是均匀撒在时间轴上的，是钉在几个"过了这条线就回不了头"的位置上。**

## 带走的判断

1. **区分"记录成为事实"和"记录变得耐久"**：前者是内存追加（同步、便宜、立刻广播），后者是磁盘 I/O（异步、贵、攒批）。混为一谈会导致要么性能崩了，要么崩溃后对不上账。
2. **耐久检查点锚定在不可撤销动作之前**，不是按固定时间间隔。
3. **检查点必须 fail-closed**，否则它只是一句祝愿。
4. **卸载顺序要设计**：先注册 disposer，让监听器先于最终 drain 关闭。

---

回到 [2.4 阶段验收](../02-streaming/04-stage-review/01-stage-review.md)
