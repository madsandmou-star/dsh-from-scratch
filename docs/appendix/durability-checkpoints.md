# 附录：内存日志什么时候真的落盘

> 起因是一个课堂问题：既然 `session.append()` 写的是内存日志、UI 看到的是广播，那**磁盘**上的东西什么时候写？
>
> 这一篇属于阶段 12 的内容，提前拆出来回答。读它只需要知道 [2.4](../02-streaming/04-stage-review/01-stage-review.md) 讲过的两件事：`append` 先入内存日志再同步广播；持久化是订阅 `session/event` 的另一个插件。所引源码是 dsh 0.2.1-alpha.3。

## 三条路径把内存里的事件推到磁盘

### ① 攒批写（write-behind）

`dsh/packages/session/session-persistence-jsonl/src/storage.ts` 的 `JsonlBackendTracker.install()` 注册的 `session/event` 监听器只做一件事——把事件交给这个会话的写句柄（前面那个 `yield` 是 ③ 要讲的写法，先忽略）：

```ts
yield ctx.on('session/event', (session: Session, event) => {
  writers.get(session.id)?.enqueueLive(event, (error) => {
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

关句柄的代码也在 `install()` 里，而且整个 `install()` 现在就是一个 effect：

```ts
install(ctx: Context): () => Promise<void> {
  const { writers, openHandles, name } = this
  return ctx.effect(function* () {
    yield async () => {                                  // 第一个交出去：关掉所有还开着的句柄
      const errors: unknown[] = []
      for (const handle of [...openHandles]) {
        try {
          await handle.close()
        } catch (error: unknown) {
          errors.push(error)
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, `${name} dispose failed`)
    }
    yield ctx.on('session/event', …)                     // 然后才是三个监听器
    yield ctx.on('session/flush', …)
    yield ctx.on('session/disposed', …)
  }, `${this.name} live routing and open handles`)
}
```

`ctx.effect(function* () { … })` 是 effect 的生成器写法（9.1 讲的是普通写法）：生成器每 `yield` 一个归还函数，Cordis 就记一笔；卸载时**倒着、一个等一个**地跑（`dsh/vendor/cordis/src/fiber.ts` 的 `effect()` 里，`disposables.splice(0).reverse()`，异步的那些用 `then` 串成一条链）。所以这里是**先摘掉三个监听器，最后才关句柄**。JSDoc 原话："The returned effect removes listeners before closing handles."

关写句柄时先把缓冲排干，`close()` 的注释：

> A write handle first drains its routed live buffer through the still-open storage, so backend teardown loses nothing regardless of which fiber unwinds first

（写句柄先通过还开着的存储把缓冲排干，所以不管哪个 fiber 先拆，后端拆卸都不丢东西。）

**难点不在自己的缓冲，在别人的最后几条事件。** 别的插件卸载时还会往日志里追加东西：一轮被打断时的收尾事件、恢复出来的工具结果。agent 循环的卸载代码（`dsh/packages/core/agent-loop/src/index.ts`）注释里写着它的要求："The backend's live-event listeners must stay mounted through driver shutdown to receive all closing events."——持久化的监听器和写句柄，得**活到这些插件收尾结束之后**。dsh 为这件事换过三种做法，放在一起看最能说明问题：

- **0.1：靠注册顺序。** 当时的 coordinator 故意**先**注册 disposer、**后**注册监听器，注释写着 "Register the disposer BEFORE the listeners. Cordis tears effects down in reverse registration order, so event admission closes before this final drain"——让监听器先摘掉，再排干，排干时不会有新东西进来。
- **0.2.0 ～ 0.2.1-alpha.1：不依赖顺序。** `close()` 里加了一个循环："drain again until a full pass leaves the routed buffer empty"（一直排，直到完整一轮之后缓冲是空的），理由是 "Producers on other fibers may still publish while close waits"；句柄一关就从 `writers` 里删掉，之后再来的事件 `writers.get(session.id)` 拿到 `undefined`，`?.` 直接跳过。设计笔记（`dsh/.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.md`）说得很直接："Root-fiber disposal runs every fiber's disposers concurrently"——整个应用关闭时，所有插件的 disposer 并发跑，一个插件把自己的注册顺序排对了，管不住别的插件。
- **0.2.1-alpha.3：把顺序"组合"出来。** 持久化插件的 `apply()`（`dsh/packages/session/session-persistence-jsonl/src/index.ts`）变成了这样：

```ts
ctx.effect(function* () {
  const tracker = new JsonlBackendTracker(name)
  yield tracker.install(ctx)                 // ① 监听器 + 句柄
  service = ctx.plugin({
    name: 'session-persistence-jsonl-service',
    apply(serviceCtx: Context) {
      new JsonlSessionPersistence(serviceCtx, config, tracker)
    },
  })
  yield service.dispose                      // ② 真正提供 sessionPersistence 的那个子插件
}, 'session-persistence-jsonl resources')
```

倒着拆：先 ② 撤掉 `sessionPersistence` 服务——Cordis 会卸载所有注入了它的插件，并**等它们收尾完**；然后才是 ①：摘监听器、排干、关句柄。README 的原话："Unloading the backend waits for the consumer unloads it triggers through `sessionPersistence` injection before removing live-event listeners and draining and closing remaining handles." 配套的测试（`dsh/packages/session/session-persistence-jsonl/tests/teardown-loader.e2e.ts`）就是这个场景：一个消费者在自己的异步收尾里，等了一会儿才追加 `turn/end`，测试要求这条事件落了盘。

**排干循环没有删。** 它还在 `close()` 里，因为新做法只覆盖一种情况。README 的 Known Limitations 写着："Concurrent root disposal is not ordered — Cordis can remove already-disposing consumers from its registry before the provider can join their cleanup."——"撤掉这个服务"触发的卸载有顺序可言；整个应用一起关的时候没有。

**为什么非得"组合"，排好注册顺序不行吗？** 答案在 Cordis 本身。`dsh/vendor/cordis/src/fiber.ts` 的 `_unload()` 卸载一个插件时，是用 `Promise.all` 把它身上的 effect **同时**启动的，每个各自 `try/catch`；倒序只决定它们**开始**的先后。从代码看，同步的归还函数（摘监听器）一开始就做完了，所以 0.1 那招对"自己的监听器先摘"有效；但只要中间有一步要 `await`，后面的就不会等它。只有放进**同一个** effect 里 `yield` 出来的归还函数，才是"倒着、一个等一个"。一份还在提案阶段的笔记（`dsh/.agents/notes/proposed/architecture/2026-10-09-cordis-cleanup-dependency-lifetimes.md`）把这件事审了一遍，否掉"调整注册顺序"的理由就是这一句："reverse invocation still starts sibling async cleanup concurrently"。它也指出整个应用关闭时仍然可能丢——agent 循环收尾时发出的最后几条事件，可能赶上监听器已经摘掉——并把它列为 P0（笔记说明这一条是从源码推出来的，完整的会话复现还没做），给的规则是："Stop admitting new work, settle accepted work and final publication, then drain and release the resource."（先停止接新活，把已经接下的活和最后的发布做完，再排干、释放资源。）

前面那份 handle-based 笔记里有一句："a root dispose mid-turn still loses the turn's unemitted remainder by design"——一轮进行到一半被关掉，还没发出来的事件就没了，下次续聊时由 `interruptedTurnClosers` 把这一轮补上收尾。0.2.1-alpha.3 给这份笔记加了一行链接，指向上面那份提案，说它 "tightening this decision's permitted root-disposal tail loss"——**原来"设计上允许丢"的那部分，dsh 打算收紧。**

阶段 9 讲卸载时会正面讲"注册顺序即拆卸顺序"，以及它管得到哪里、管不到哪里。

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
4. **拆卸顺序要靠"组合"，不能靠"注册的先后"**：同一个插件上分别注册的 effect，卸载时是并发启动的，倒序只排了起跑顺序。dsh 0.1 靠注册顺序让自己的监听器先摘；0.2 加了"排干到空"，不依赖顺序；0.2.1-alpha.3 再把"先撤服务、等消费者收尾 → 摘监听器 → 排干关句柄"写进同一个生成器 effect，顺序才真正成立——但只限于"撤掉这个服务"触发的卸载，整个应用一起关时仍然没有顺序，所以排干循环还留着。

---

回到 [2.4 阶段验收](../02-streaming/04-stage-review/01-stage-review.md)
