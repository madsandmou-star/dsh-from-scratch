# 8.3 插件可以是异步的

8.2 解放了顺序。还剩一样东西没解放：**`apply` 必须是同步的。**

## 痛点：一行还了两课的债

7.3 在 `src/plugins.ts` 里留下了这个：

```ts
// 同步 apply 里发不出 await，但下一个插件才会挂持久化，所以这个 promise
// 一定在第一次写之前完成——它俩之间没有任何 await。
void repairLog(logPath, loaded.committedBytes)
```

它要保证的事情很实在：6.4 讲过，**截断必须发生在挂持久化之前**，否则新事件会接在半行残骸后面，把一次可恢复的崩溃变成永久损坏。

当时的论证是：`sessionPlugin` 和 `persistencePlugin` 之间没有任何 `await`，所以那个 promise 一定在第一次写盘之前跑完。

**8.2 之后这个论证连前提都没了。** "下一个插件是谁"现在由依赖关系算出来，作者不再控制。前提**碰巧**还成立（我们的插件都是同步的），但它已经从"设计"退化成了"巧合"。

而且这不只是一行债。同步的 `apply` 挡住的是**一整类插件**：

- 读一个配置文件、连一个数据库、探测本地有没有装 ripgrep
- 向模型服务要一次能力清单，再决定注册哪些工具
- 启动一个子进程（LSP、沙箱）并等它就绪

**dsh 里绝大多数真实插件都要做这类事。** 一个不许 `await` 的装载器，只能装那些"纯内存拼装"的插件。

## 解法：一句话和一张图

**一句话：`apply` 可以返回 promise；在它 resolve 之前，这个插件 provide 的服务还不存在，依赖它的插件就继续挂着。**

```
   plugin(slowConfig)  ──→ apply 返回一个 promise ──→ 记进 inflight
   plugin(consumer)    ──→ inject: ['config'] 还没有 ──→ 挂进 pending
        │
        │  （两次调用都立刻返回了，但 consumer 还没装）
        │
        └─→ await root.ready()
                 │
                 └─ 等 inflight 里的 promise
                        │
                        └─ slowConfig 跑完 → provide('config') → drain() → 装上 consumer
```

**"调用返回"和"装配完成"从此是两件事**，所以必须有一个显式的汇合点：`ready()`。

### 一屏看完的完整实现

`src/cordis.ts` 里三处改动。

**① 类型放宽：**

```ts
export type Plugin<T = unknown> =
  | ((ctx: Context, config: T) => void | Promise<void>)
  | { name?: string, inject?: readonly string[], apply: (ctx: Context, config: T) => void | Promise<void> }
```

**② `install()` 记下这个 promise：**

```ts
private install(entry: PendingPlugin): void {
  const child = entry.ctx.extend({ … })
  entry.ctx.children.push(child)
  const result = entry.apply(child, entry.config)
  // 它跑完之前，它 provide 的服务还不存在，所以依赖它的插件仍然挂着——
  // **"依赖就绪"从此包含了"提供者真的跑完了"**。
  if (result instanceof Promise) this.root.inflight.push(result)
}
```

**③ 一个显式的汇合点：**

```ts
/**
 * 等到装配真正结束：所有异步 `apply` 都跑完，而且再没有插件能被唤醒。
 *
 * 循环是必须的：等一批 promise 的过程中，它们 provide 的服务会唤醒更多插件，
 * 而那些插件可能又是异步的。**一轮等不干净。**
 */
async ready(): Promise<void> {
  for (;;) {
    const tasks = this.root.inflight.splice(0)
    if (tasks.length === 0) return
    // 不用 allSettled：装配失败要当场炸，不要"记下来最后一起报"。
    await Promise.all(tasks)
  }
}
```

**注意 `drain()` 一行没改。** 唤醒机制早就在 `provide()` 里了——异步插件跑完之后调 `provide`，`provide` 调 `drain`，等它的插件就装上了。**这一课加的只是"等"这件事，不是"唤醒"。**

### 用起来：那行债还清了

```ts
export const sessionPlugin = {
  name: 'sessionPlugin',
  async apply(ctx: Context): Promise<void> {
    …
    ctx.provide('session', resumeId === undefined ? new Session() : new Session(await loadAndRepair(logPath)))
    //                                                              ^^^^^ 从 void 变回 await
  },
}
```

保证也换了个说法——**从一段关于装载顺序的论证，变成语言本身的语义**：

> 在这个 promise resolve 之前，`session` 服务不存在，而 `persistencePlugin` inject 了它，所以它一定还挂着。

两个入口各加一行：

```ts
root.plugin(assemble(cli))
await root.ready()      // 装配现在可能是异步的：等它真正完成
```

### 产出长什么样

```sh
node --import tsx demos/08-services/05-async-plugins.mjs
```

```
=== ① 依赖一个异步插件：等它跑完才装 ===
  此刻 consumer 装了吗？ 还挂着
    1ms slowConfig 开始读文件…
    1ms 两次 plugin() 都返回了
   51ms consumer 装上了，读到 deepseek-chat
   52ms slowConfig 提供了 config
```

```
=== ② 三个异步插件互相依赖，ready() 要等好几轮 ===
    0ms A 开始
   31ms B 开始
   31ms A 提供了 a
   61ms C 开始
   61ms B 提供了 b
   92ms C 提供了 c
```

倒着写的 C → B → A，跑出来是 A → B → C，而且**串成了三轮**。

## 三个要看懂的点

### ① `provide()` 是**同步**唤醒的

演示 ① 的输出里有一处看起来像 bug：

```
   51ms consumer 装上了，读到 deepseek-chat
   52ms slowConfig 提供了 config
```

consumer 那行**排在 slowConfig 最后一行前面**。

不是打错了。`provide()` 里那句 `this.drain()` 是同步调用的，所以：

```ts
ctx.provide('config', { … })      // ← 这一行返回之前，consumer 已经装完了
log.push('slowConfig 提供了 config')   // ← 才轮到这一行
```

**"异步"只发生在插件自己的 `apply` 里；唤醒那一步从头到尾是同步的。** 这个区分很重要：它意味着 `provide()` 返回之后，所有因它而就绪的插件都已经装好了——不会有"过一会儿才装上"的中间态。

### ② `ready()` 为什么是个循环

```ts
for (;;) {
  const tasks = this.root.inflight.splice(0)
  if (tasks.length === 0) return
  await Promise.all(tasks)
}
```

一轮不够，因为**等待的过程中会长出新的 promise**：A 跑完 → 唤醒 B → B 是异步的 → 新的 promise 进了 `inflight`。演示 ② 那三轮就是这个。

`splice(0)` 是"取走全部并清空"——必须先取走再等，否则等待期间新加进来的会被下一轮漏掉或者重复等。

**判断这类循环要不要写，只有一个问题：等待期间，被等的那个集合会变吗？** 会，就得循环。

### ③ `Promise.all` 而不是 `Promise.allSettled`

`allSettled` 会等所有的都结束，然后把成功和失败一起给你。听起来更周全，但在装配这个场景是错的：

**第一个插件炸了之后，后面那些插件在一个已经不完整的应用上继续初始化**——它们可能连上数据库、起了子进程、写了文件，而这整个装配马上就要被放弃。

`Promise.all` 在第一个 reject 时立刻 reject。这和 7.1 那条"装配失败当场炸"是同一条规矩，只是出口从 `plugin()` 变成了 `ready()`。

（一个诚实的说明：`Promise.all` 只是**立刻把错误报上来**，它并不能取消其他已经在跑的 promise——那些插件还会继续跑完。要真正取消得靠 `AbortSignal`，dsh 的 fiber 有这一层，我们没有。）

## 教 debug：装配卡住了怎么办

异步装载带来一类新问题：**`await root.ready()` 永远不返回。**

排查顺序：

**① 先看挂起清单。** `ready()` 只等 `inflight`，不等 `pending`——**一个永远等不到依赖的插件不会让 `ready()` 卡住**，它只是永远不装。所以 `ready()` 返回了但功能没生效，答案在 `pendingPlugins()` 里（8.2 讲过）。

**② `ready()` 真的不返回，那就是某个 `apply` 的 promise 不 resolve。** 典型原因：忘了 resolve 的手写 promise、没设超时的网络请求、等一个永远不来的子进程信号。

定位手法：在 `install()` 里给每个 promise 包一层计时——

```ts
if (result instanceof Promise) {
  const timer = setTimeout(() => console.error(`[装配慢] ${entry.name} 已经跑了 5 秒还没完`), 5000)
  this.root.inflight.push(result.finally(() => { clearTimeout(timer) }))
}
```

**给"可能永远不结束"的等待加一个会说话的计时器**，比对着一个不动的进程猜快得多。这条对所有异步初始化都适用，不限于插件系统。

（dsh 走得更远：它的每个 fiber 有状态机和 logger，`ctx.logger` 能直接打出谁卡在哪一步。）

## 对照 dsh

dsh 的插件天生是异步的——每个插件一个 **Fiber**（`dsh/vendor/cordis/src/fiber.ts`，754 行）。`ctx.plugin()` 返回的那个东西可以被 await：

```ts
const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack)
const wrapped = Object.create(fiber) as Fiber & PromiseLike<Fiber>
wrapped.then = (onFulfilled, onRejected) => {
  return fiber.await().then(onFulfilled, onRejected)
}
return wrapped
```

这几行很值得读：它返回的是一个**以 fiber 为原型的对象**（7.2 那个 `Object.create` 又出现了），只多挂了一个 `then`。于是 `ctx.plugin(p)` 既可以当普通值用（读它的属性），也可以 `await` 它——**一个对象只要有 `then` 方法，`await` 就认它**，这种东西叫 *thenable*。

| | 我们的 | dsh 的 | 哪个阶段补齐 |
|---|---|---|---|
| 等待的单位 | 整棵树一个 `ready()` | **每个插件**一个可 await 的 fiber | 不复刻 |
| 并发 | `Promise.all`，但唤醒是串行的 | fiber 各自独立推进 | 不复刻 |
| 取消 | 没有 | fiber 有 `AbortSignal`，卸载即中止 | 阶段 9 |
| 失败隔离 | 整个装配炸 | 失败的 fiber 单独标记，不一定拖垮全局 | 阶段 9 |
| 卡住的诊断 | 自己加计时器 | fiber 状态机 + logger | 不复刻（外围） |

第三行是真正的差距：我们的异步插件**跑起来就没法叫停**。一个在 `await` 里等网络的插件，如果这时要卸载它所属的那棵子树，我们只能干等。dsh 的 fiber 持有一个 `AbortSignal`，卸载时一并中止——**这是阶段 9 那条"注册即 effect、卸载即回收"的另一半**。

## 这一课改了什么

| 文件 | 改动 |
|---|---|
| `src/cordis.ts` | `Plugin` 的 `apply` 可返回 promise；`install()` 收集 `inflight`；新增 `ready()` |
| `src/plugins.ts` | `sessionPlugin` 变成 `async`；`loadAndRepair` 里 `void` 变回 `await`——**7.3 的债还清** |
| `src/index.ts` / `src/headless.ts` | 末尾加 `await root.ready()` |
| `demos/08-services/05-async-plugins.mjs` | 新增：等异步依赖、三轮串联、失败当场炸 |

## 下一课

`src/plugins.ts` 里六个插件现在长得很像：**都是"造一个东西，然后 `provide` 出去"**。而且它们都还缺同一样东西——卸载。

**8.4 讲 `Service` 类**：为什么这三件事（注册、命名、卸载）值得一个基类把它们绑在一起，以及 `super(ctx, name)` 那一行到底做了什么。
