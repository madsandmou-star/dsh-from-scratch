# 附录：内存日志什么时候真的落盘

> 起因是一个课堂问题：既然 `session.append()` 写的是内存日志、UI 看到的是广播，那**磁盘**上的东西什么时候写？
>
> 这一篇属于阶段 12 的内容，提前拆出来回答。读它只需要知道 [2.4](../02-streaming/04-stage-review/01-stage-review.md) 讲过的两件事：`append` 先入内存日志再同步广播；持久化是订阅 `session/event` 的另一个插件。所引源码是 dsh 0.2.0-rc.2。

## 三条路径把内存里的事件推到磁盘

### ① 攒批写（write-behind）

`dsh/packages/session/session-persistence-jsonl/src/storage.ts` 的 `JsonlBackendTracker.install()` 注册的监听器只做一件事——把事件交给这个会话的写句柄：

```ts
ctx.on('session/event', (session: Session, event) => {
  this.writers.get(session.id)?.enqueueLive(event, (error) => {
    ctx.logger.warn(`session-persistence: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`)
  })
})
```

`enqueueLive()` 把事件复制进句柄自己的缓冲区，空闲时起一个定时器：

```ts
enqueueLive(event: SessionEvent, reportBackgroundFailure: (error: unknown) => void): void {
  this.buffered.push(structuredClone(event))
  if (this.batchTimer !== undefined || this.drainPaused) return
  this.batchTimer = setTimeout(() => {
    this.batchTimer = undefined
    this.drainLive().catch(reportBackgroundFailure)
  }, LIVE_WRITE_BATCH_MAX_DELAY_MS)
}
```

同一个文件顶部：

```ts
/** Maximum intentional wait before a routed live session batch starts writing. */
export const LIVE_WRITE_BATCH_MAX_DELAY_MS = 200
```

**所以正常情况下事件是攒批落盘的，不是一条一次 I/O。** 200ms 是"空闲缓冲收到第一条事件之后最多等多久就开写"。

dsh 0.1 时这一层更要紧：那时每个 token 一条 `assistant/chunk` 事件，攒批是把几百次写压成几次的唯一办法。0.2 把流改成整步一条事件（[2.4](../02-streaming/04-stage-review/01-stage-review.md) 讲过），事件数量本身就少了一两个数量级；攒批还在，但它现在压的是 `step/start`、`tool/call`、`tool/result` 这些，量级小得多。

注意定时器那一路失败时的处理：错误交给 `reportBackgroundFailure`（打一行 warn），缓冲里的事件**原样保留**，自动写暂停（`drainPaused`），等下一次显式 flush 再试——**那一次有人在 `await`，错误才抛得出去**。

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

`install()` 的最后一行：

```ts
ctx.effect(() => async () => {
  const errors: unknown[] = []
  for (const handle of [...this.openHandles]) {
    try {
      await handle.close()
    } catch (error: unknown) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `${this.name} dispose failed`)
}, `${this.name} open handles`)
```

卸载时逐个关闭还开着的句柄。关写句柄之前先把缓冲排干，`close()` 的注释：

> A write handle first drains its routed live buffer through the still-open storage, so backend teardown loses nothing regardless of which fiber unwinds first

（写句柄先通过还开着的存储把缓冲排干，所以不管哪个 fiber 先拆，后端拆卸都不丢东西。）

这里有一个**跟注册顺序有关的坑**，而 dsh 两个版本的解法不一样，很值得对比：

- **监听器和 disposer 谁先拆？** Cordis 按注册的**反序**拆卸。`install()` 先注册三个 `ctx.on`，最后才注册这个 `ctx.effect`——所以拆的时候 **disposer 先跑，监听器后关**。排干跑完之后，监听器理论上还能再收到事件。
- **dsh 0.1 的解法：调注册顺序。** 当时的 coordinator 故意**先**注册 disposer、**后**注册监听器，注释写着 "Register the disposer BEFORE the listeners. Cordis tears effects down in reverse registration order, so event admission closes before this final drain"——让监听器先关，再排干。
- **dsh 0.2 的解法：不依赖顺序。** `close()` 里是一个循环："drain again until a full pass leaves the routed buffer empty"（一直排，直到完整一轮之后缓冲是空的），注释说理由是 "Producers on other fibers may still publish while close waits"。而且句柄一关，它就从 `writers` 里被删掉——之后再来的 `session/event`，`this.writers.get(session.id)` 拿到 `undefined`，`?.` 直接跳过。

**0.1 靠"顺序对了才对"，0.2 靠"顺序怎样都对"。** 后者更稳：注册顺序是一件很容易在重构时被悄悄改掉的事，而"关了就查不到"是数据结构保证的。阶段 9 讲可逆注册时会正面讲"注册顺序即拆卸顺序"。

## 一次完整的 turn，磁盘视角

```
agent/pre-step   → flush（把上一步提交的东西刷干净）
  append user/message、request/header …          ← 内存
llm/stream 前    → flush（请求前缀必须耐久，否则不发请求）
  （流式 chunk 只发临时帧，不进日志）
  append assistant/message（带整条 stream）       ← 内存，200ms 攒批写
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
4. **卸载要么靠顺序，要么不依赖顺序**：dsh 0.1 靠"先注册 disposer"让监听器先关；0.2 让排干循环到空、关掉的句柄查不到，顺序怎样都对。后者更不容易被重构弄坏。

---

回到 [2.4 阶段验收](../02-streaming/04-stage-review/01-stage-review.md)
