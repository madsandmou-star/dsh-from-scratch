# 8.2 顺序由依赖算出来

8.1 让兄弟之间看得见了，树也变平了。但清单还剩最后一个约束：

```ts
export const corePlugins = [
  configPlugin, promptPlugin, guardsPlugin, sessionPlugin, persistencePlugin,
]
```

**这个数组的顺序仍然重要。**

## 痛点：顺序只存在于作者脑子里

装载是同步的，所以 `guardsPlugin` 跑的时候 `configPlugin` 必须已经跑完。把两项对调：

```
TypeError: Cannot read properties of undefined (reading 'readOnly')
```

三个具体的疼：

**① 规则没有写在任何地方。** "`persistencePlugin` 要在 `sessionPlugin` 后面"——这条约束不在代码里，它只是"数组里排在后面"这个事实。新人加一个插件，只能靠猜或者试。

**② 错误信息不指向原因。** 它说的是"某个属性不存在"，而真正的原因是"你把提供者排到了使用者后面"。这两者之间隔着一次推理，而且是在运行时才发生。

**③ 约束是 N 对 N 的。** 加一个既要 `config` 又要 `session` 的插件，你得同时满足两个约束。插件一多，排这个数组就是一道人肉拓扑排序题——而且**没有任何工具会告诉你排错了**。

> 一条真实的约束，如果只表现为"某个列表里的位置"，那它迟早会被破坏。

## 解法：一句话和一张图

**一句话：插件声明自己要哪些服务；装载器发现依赖没齐就把它挂起来，等那个服务被 provide 的时候再装。**

```
  ctx.plugin(guardsPlugin)      inject: ['config']
        │
        ├─ config 已经有了？ ──是──→ 立刻装
        │
        └─ 没有 ──→ 挂进 pending 队列
                        ↑
                        │  有人 provide('config', …) 时
                        └──────── 回头把等齐了的全装上
```

**顺序不再由书写位置决定，由依赖关系决定。**

### 一屏看完的完整实现

`src/cordis.ts` 里，`plugin()` 多了两行分支，外加三个小方法：

```ts
plugin<T>(plugin: Plugin<T>, config?: T): void {
  …解析 apply 和 name…
  const inject = typeof plugin === 'function' ? [] : plugin.inject ?? []
  const entry: PendingPlugin = { name, inject, apply, config, ctx: this }
  // 依赖齐了就立刻装；差一个就挂起，等 provide 把它唤醒。
  if (this.missing(inject).length > 0) this.root.pending.push(entry)
  else this.install(entry)
}

/** 真正把一个插件装上：派生子 context、记进树、调 apply。 */
private install(entry: PendingPlugin): void {
  const child = entry.ctx.extend({ name: entry.name, parent: entry.ctx, children: [] })
  entry.ctx.children.push(child)
  entry.apply(child, entry.config)
}

/** 这些依赖里，哪些还没被提供。 */
private missing(inject: readonly string[]): string[] {
  return inject.filter(name => !this.root.services.has(name))
}

/**
 * 把挂起队列里依赖已经齐了的插件装上，直到装不动为止。
 * 每装一个就**重新扫一遍**：一个插件装上时可能又提供了新服务。
 */
private drain(): void {
  for (;;) {
    const index = this.root.pending.findIndex(entry => this.missing(entry.inject).length === 0)
    if (index === -1) return
    const [entry] = this.root.pending.splice(index, 1)
    if (entry !== undefined) this.install(entry)
  }
}
```

`provide()` 末尾多一行：

```ts
    // 有新服务了，看看有没有插件正等着它。
    this.drain()
```

还有一个诊断方法，这一课的 debug 全靠它：

```ts
/** 还挂着没装的插件，以及各自在等什么。 */
pendingPlugins(): { name: string, waitingFor: string[] }[] {
  return this.root.pending.map(entry => ({ name: entry.name, waitingFor: this.missing(entry.inject) }))
}
```

### 用起来是一行声明

插件从函数形态换成对象形态（7.1 讲过的第二种），多一个 `inject` 字段：

```ts
export const promptPlugin = {
  name: 'promptPlugin',
  inject: ['config'],           // ← 全部改动就是这一行
  apply(ctx: Context): void {
    prompt.variable('model', () => ctx.config.model)
    …
    ctx.provide('prompt', prompt)
  },
}

export const persistencePlugin = {
  name: 'persistencePlugin',
  inject: ['session', 'logPath', 'sessionId'],
  apply(ctx: Context): void { … },
}
```

`configPlugin` 和 `sessionPlugin` 不依赖任何服务，所以没有 `inject`。

**这一行同时干了三件事**：告诉装载器什么时候能装我、告诉读代码的人我用了什么、以及——它就在插件自己的文件里，**跟着插件一起被复制、被删除、被审查**。

### 产出长什么样

```sh
node --import tsx demos/08-services/03-inject.mjs
```

```
=== ① 故意按**最坏**的顺序装：使用者全排在提供者前面 ===
  实际装载顺序：session → config → guards → loop
  写下的顺序：loop → guards → session → config
  **装载顺序由依赖算出来，和书写顺序无关。**
```

真实的装配也一样：

```sh
node --import tsx demos/08-services/04-shuffled.mjs
```

```
=== 随机打乱 20 次 ===
  20 次全部提供了**同一组服务**，一个插件都没挂住。

=== 看一次打乱后的实际装载顺序 ===
  写下的顺序：persistencePlugin → sessionPlugin → guardsPlugin → promptPlugin → configPlugin
  装出来的树：
  root
    app
      sessionPlugin
      persistencePlugin
      configPlugin
      guardsPlugin
      promptPlugin
      leaf
```

**倒着写，装出来的顺序是对的。**

## 四个必须讲清楚的点

### ① `inject` 保证的是"该在前面的一定在前面"，不是"每次都一样"

打乱 20 次，`provide` 的先后**每次都可能不同**——所以那个演示比的是**集合**而不是顺序。

这不是实现不够严格，是**互不依赖的插件之间，先后本来就没有规定**。`promptPlugin` 和 `guardsPlugin` 谁先谁后都对，因为它们之间没有任何约束。

**一个好的依赖系统只保证被声明的约束，不会顺手强加没被声明的。** 强加了反而糟糕：你会开始依赖一个没人承诺过的顺序，而它随时会变。

（dsh 更彻底：它的配置项是**并发启动**的，教程第一章就写着"各项会并发启动，因此它们在列表中的位置不保证插件的加载先后"。）

### ② 装载顺序变了，但父子关系没变

```
  注意 guards 和 loop 都挂在 root 下——它们是被 provide 唤醒后才装的，
  但"当初在哪调的 plugin()"决定父节点是谁，跟什么时候装无关。
```

`PendingPlugin` 里存了 `ctx`：

```ts
interface PendingPlugin {
  …
  /** 当初调 `ctx.plugin()` 的那个 context——装上时它才是父节点。 */
  ctx: Context
}
```

挂起的时候必须把"当初是谁调的"记下来，否则唤醒时就不知道该把它挂在哪。

**"谁装的谁"（结构）和"什么时候装"（时序）是两件独立的事。** 7.1 定下的那条规则没有被 8.2 推翻——只是现在两者不再重合了。

### ③ 依赖永远不来：挂着，不报错

```
  还挂着的插件：
    needsLlm  还在等：llm
```

为什么不抛错？因为**"等一个还没装的服务"是合法的**：那个提供者可能在清单更后面，也可能要等用户做完某个操作（登录、选择模型）才装上。装载器在装配过程中**分不清"还没到"和"永远不会到"**。

所以它只做一件事：**如实记下谁在等谁**。判断"这是不是错"是调用方的事——装配结束后 `pendingPlugins()` 应该是空的，不空就是有依赖没人提供。

> 这条和 6.4 那个 `ignorable` 是**相反**的选择，值得对比：那里默认拒绝（因为"读到不认识的事件"一定是错的），这里默认等待（因为"依赖还没到"经常是对的）。**默认值要看那个情况正常不正常，不是看它方不方便。**

### ④ 循环依赖就是"永远等不到"

```
    A  还在等：b
    B  还在等：a
```

和上一条长得**一模一样**——因为在这个机制里它们就是同一件事。

有人会想加一个环检测。但仔细想：装载器在装配**进行中**看到 A 等 b、B 等 a，它能断定这是环吗？不能——`b` 可能由第三个还没被装的插件提供。**只有"装配彻底结束、再也没有新插件要装"之后，剩下的挂起才构成错误**，而那时看诊断清单就够了。

**它只能如实报告谁在等谁，让人去看。** 加一个会误报的环检测，比不加更糟。

## 教 debug：两个清单回答两个问题

阶段 8 的诊断是两句话：

```ts
console.log(ctx.listServices())        // 提供了什么
console.log(ctx.pendingPlugins())      // 谁还在等什么
```

**"我的插件没跑"** —— 以前要翻树、翻缩进、猜顺序，现在是一句话：

```
    needsLlm  还在等：llm
```

它在等 `llm`。接着只有两种可能：**没人提供 `llm`**（那个插件没装上），或者**名字写错了**（提供的叫 `llmService`，你写的是 `llm`）。看一眼 `listServices()` 就能分辨。

**"我读到 undefined"** —— 如果你的插件跑起来了，说明 `inject` 里声明的服务都在。那读到 `undefined` 的那个东西，**多半是你忘了写进 `inject`**。这是新的头号可疑对象。

> 这就是把约束显式化的收益：**问题从"运行时某处报了个属性不存在"，变成了一张能直接读出答案的清单。**

## 对照 dsh

dsh 的对应机制在 `dsh/vendor/cordis/src/fiber.ts`（754 行）。同一个想法，规模差了两个量级。

教程（`dsh/docs/cordis-tutorial/01-first-plugin.md`）里那句话现在可以完全读懂了：

> 各项会并发启动，因此它们在列表中的位置不保证插件的加载先后；**顺序由服务依赖（`inject`）决定，而非文件中的位置。**

| | 我们的 | dsh 的 | 哪个阶段补齐 |
|---|---|---|---|
| 挂起与唤醒 | 一个 `pending` 数组 + `drain()` | 每个插件一个 `Fiber`，有自己的状态机 | — |
| 装载 | 同步、串行 | **并发**，插件可以是异步的 | **8.3** |
| 依赖消失时 | 不管（服务不会消失） | 依赖被撤销 → 依赖它的插件**自动卸载** | 阶段 9 |
| 可选依赖 | 没有 | `inject: { required: [], optional: [] }` | 阶段 9 顺带 |
| 依赖就绪的判据 | 服务名在表里 | 表里有 **且** `check` 谓词通过 | 阶段 14 |
| 诊断 | `pendingPlugins()` | logger + fiber 状态 | 不复刻（外围） |

**第三行是最大的差距，也是最能说明 dsh 为什么复杂的一行。**

我们的服务只会出现、不会消失，所以"等到了就装上"是个单向过程。dsh 不是：一个插件被卸载时，它 provide 的服务会被撤销，而**依赖那个服务的插件必须跟着卸载**——否则它们手里就攥着一个已经无效的东西。

这条"依赖消失就跟着走"是 HMR（改一个文件，只重载相关的那几个插件）能成立的全部原因。阶段 9 会实现它。

## 这一课改了什么

| 文件 | 改动 |
|---|---|
| `src/cordis.ts` | `Plugin` 类型加 `inject`；`plugin()` 分流到挂起队列；新增 `install()`、`missing()`、`drain()`、`pendingPlugins()`、`PendingPlugin` |
| `src/plugins.ts` | 五个插件改成对象形态并声明 `inject`；`corePlugins` 的注释从"按依赖顺序"改成"顺序无所谓" |
| `demos/08-services/03-inject.mjs` | 新增：最坏顺序、挂起诊断、循环依赖 |
| `demos/08-services/04-shuffled.mjs` | 新增：真实装配随机打乱 20 次 |

## 下一课的痛点

`corePlugins` 的顺序解放了，但还有一样东西没解放：**`apply` 必须是同步的**。

7.3 留下的那行债还在 `plugins.ts` 里：

```ts
// 同步 apply 里发不出 await，但下一个插件才会挂持久化，所以这个 promise
// 一定在第一次写之前完成——它俩之间没有任何 await。
void repairLog(logPath, loaded.committedBytes)
```

这个论证**现在更站不住了**：8.2 之后，"下一个插件是谁"这件事连作者都不再控制——装载顺序是算出来的。论证依赖的前提（中间没有 await）碰巧还成立，但它已经从"设计"退化成了"巧合"。

**8.3 让插件可以是异步的**：`apply` 返回 promise 时，装载器等它完成再算下一轮依赖。那行 `void` 会变回 `await`，而这一步顺带打开了另一扇门——**一个插件可以在装载过程中做 I/O**（读文件、连数据库、探测能力），这是 dsh 里绝大多数真实插件的形态。
