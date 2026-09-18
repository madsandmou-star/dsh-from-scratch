# 8.4 Service 类：第三种插件形态

7.1 提过 Cordis 接受三种插件形态，当时说"在你需要公开服务之前，一直用函数形态"。现在到了需要它的时候。

## 痛点：两个入口各自记得收尾

`SessionPersistence` 有一件事必须做：**退出前把 200ms 批处理里压着的最后几条事件刷下去**（6.3）。

8.4 之前，这件事写在两个地方：

```ts
// src/index.ts 的 loop() 末尾
await ctx.persistence.close()

// src/headless.ts 的 runOnce() 末尾
await ctx.persistence.close()
```

**这是 7.1 那个痛点的小型复现**，只是这次重复的不是装配，而是**收尾**。再加一个入口（ACP server、JSON-RPC），就是第三次。漏掉一次的后果是**最后几条事件永远不落盘**——而且不报错，只是那个入口的会话日志总是少一截。

更糟的是这个知识的位置不对：**"退出前要 close" 是持久化自己的事，不是入口的事。** 入口凭什么知道有个东西需要收？将来加一个要关闭子进程的 LSP 服务、一个要断连接的数据库服务，每个都得让每个入口"记得"一次。

> 一样东西需要收尾，而收尾的知识却散落在所有使用者那里——这个形状和 7.1 的"入口必须认识每一个部件"一模一样。

## 顺带看：六个插件长得很像

```ts
export const configPlugin = {
  name: 'configPlugin',
  apply(ctx) { ctx.provide('config', loadConfig()) },
}
```

每个都是"造一个东西，然后 `provide` 出去"。而且有三样信息被拆散在了不同地方：

| 信息 | 现在在哪 |
|---|---|
| 这个服务叫什么 | `provide('config', …)` 那个字符串 |
| 它是什么 | `loadConfig()` 的返回值 |
| 它怎么收尾 | 使用者那里（或者根本没有） |

**服务实例自己不知道自己叫什么**，也拿不到 ctx——它想自己注册点什么（订阅事件、加定时器、开子进程），只能靠调用方喂进来。

## 解法：一句话和一张图

**一句话：让服务类自己成为插件——构造函数里注册自己、记住名字、拿到 ctx，再加一个可选的 `dispose()`。**

```
改前：三处知识，三个地方
   类/工厂函数 ──→ 造出实例
   插件函数   ──→ ctx.provide('名字', 实例)
   每个入口   ──→ await ctx.xxx.close()

改后：一个构造函数
   class PersistenceService extends Service {
     static inject = [...]              ← 依赖
     constructor(ctx) { super(ctx, 'persistence'); … }   ← 注册 + 命名 + 拿 ctx
     async dispose() { … }              ← 收尾
   }
   每个入口 ──→ await ctx.dispose()     ← 只说"该收了"，不知道有谁要收
```

### 一屏看完的完整实现

`src/cordis.ts` 新增一个基类：

```ts
export abstract class Service {
  /** 这个服务注册用的名字。 */
  readonly name: string

  constructor(protected readonly ctx: Context, name: string) {
    this.name = name
    ctx.provide(name, this)       // ← 注册就发生在这里
  }

  /**
   * 收尾。整棵树被 dispose 时按**注册的逆序**调用。
   */
  dispose?(): void | Promise<void>
}
```

`plugin()` 多认一种形态：

```ts
// 类插件：`new` 它，构造函数自己会 provide。
// 判据是原型链而不是 `typeof`——类在 JS 里就是函数，`typeof` 分不开。
if (typeof plugin === 'function' && plugin.prototype instanceof Service) {
  const Ctor = plugin as new (ctx: Context) => Service
  const inject = (plugin as { inject?: readonly string[] }).inject ?? []
  const entry: PendingPlugin = { name: plugin.name || '(匿名服务)', inject, apply: ctx => { new Ctor(ctx) }, config, ctx: this }
  …挂起或立刻装…
  return
}
```

再加一个统一的收尾入口：

```ts
async dispose(): Promise<void> {
  const services = [...this.root.services.values()].reverse()
  for (const value of services) {
    if (value instanceof Service && value.dispose !== undefined) await value.dispose()
  }
}
```

### 用起来：持久化变成一个服务

```ts
export class PersistenceService extends Service {
  /** 类插件的依赖声明写成静态字段。dsh 也是这么写的。 */
  static readonly inject = ['session', 'logPath', 'sessionId']

  private readonly handle: SessionPersistence

  constructor(ctx: Context) {
    super(ctx, 'persistence')
    const isNew = ctx.session.events.length === 0
    this.handle = attachJsonlPersistence(ctx.session, ctx.logPath, isNew ? { … } : undefined)
  }

  flush(): Promise<void> { return this.handle.flush() }

  /** 收尾：取消订阅，最后刷一次。整棵树 dispose 时自动被调到。 */
  async dispose(): Promise<void> { await this.handle.close() }
}
```

清单里它和别的插件平起平坐：

```ts
export const corePlugins = [configPlugin, promptPlugin, guardsPlugin, sessionPlugin, PersistenceService]
```

两个入口各少一行知识：

```ts
await ctx.dispose()        // 原来是 await ctx.persistence.close()
```

**差别不在于短了几个字，在于入口不再需要知道"有个叫 persistence 的东西需要收"。** 再加十个要收尾的服务，这一行也不用改。

### 产出长什么样

```sh
node --import tsx demos/08-services/06-service-class.mjs
```

```
=== ① 类插件：ctx.plugin(类) 会 new 它，构造函数自己 provide ===
  root.clock.name = clock
  服务表：clock

=== ③ 收尾按注册的**逆序** ===
  注册顺序：a → b
  dispose 顺序：
    B.dispose
    A.dispose
```

## 四个要讲清楚的点

### ① 判据是原型链，不是 `typeof`

```
  typeof Clock                       = function   ← 类在 JS 里就是函数
  Clock.prototype instanceof Service = true
```

**类在 JS 里就是一个函数**，`typeof` 分不开它和普通插件函数。分不开的后果很直接：`ctx.plugin(Clock)` 会把它当普通函数调用，而**类不加 `new` 调用会直接抛 `TypeError`**。

`plugin.prototype instanceof Service` 问的是"这个函数的原型对象，在不在 `Service` 的原型链上"——也就是"它是不是 `Service` 的子类"。

（还有一个更粗的办法：`/^class\s/.test(plugin.toString())`。别用——它依赖源码文本，一经压缩或转译就失效。**判断一个值是什么，要看它的结构，不要看它的字面量。**）

### ② `super(ctx, name)` 里就注册了，所以构造期间读自己会拿到半成品

```
=== ④ 构造期间读自己，拿到的是半成品 ===
    构造函数里读 ctx.trap.value = undefined
  构造完之后读 = 42
```

JS 的规矩是：`super()` 必须在子类用 `this` 之前调用，而 `provide` 就在 `super()` 里。所以从 `super()` 返回的那一刻起，**服务表里已经有这个名字了，但子类的字段还一个都没初始化**。

这不是我们实现得草率——dsh 是同一个形状，而且它专门留了一个符号来应对：

```ts
/** Symbol key of an instance method run after construction (class plugins). */
static readonly init: unique symbol = symbols.init
```

**"注册"和"可用"之间有一个窗口**，这是"构造即注册"这个便利的固有代价。实践上的规矩很简单：**构造函数里只做赋值，别在里面触发任何会回头读这个服务的逻辑。**

### ③ `dispose` 按注册的逆序

```
  注册顺序：a → b
  dispose 顺序：B.dispose → A.dispose
```

理由和 `finally` 里关资源、和析构顺序一样：**后注册的可能用着先注册的**。`PersistenceService` 用着 `session`，所以它必须先收。

顺序反了会怎样：`session` 先被收掉，然后 `persistence.dispose()` 想最后刷一次——它要刷的那个东西已经没了。**这类 bug 只在退出路径上出现，而退出路径最少被测到。**

（`[...map.values()].reverse()` 成立，是因为 `Map` 保证**按插入顺序**迭代。JS 的 `Map` 有这个保证，普通对象的键顺序规则则要复杂得多——这也是 8.1 选 `Map` 而不是普通对象的一个附带理由。）

### ④ 什么时候该用类形态，什么时候不该

不是所有服务都该是 `Service` 子类。我们六个里只有一个变了。判据：

| 用类形态 | 用函数插件 |
|---|---|
| 要收尾（关文件、断连接、杀子进程） | 纯数据（`config`、`logPath`） |
| 有方法，调用方要调它 | 造好就不再变 |
| 需要在自己内部用 ctx | 用不到 ctx |

`configPlugin` 提供的是一个普通对象，没有方法、不用收尾、造完就不变——**给它套一个类只会多两层间接**。

dsh 教程那句建议依然成立：

> 在你需要公开服务之前，请一直使用函数形态。

而"需要公开服务"在实践中的意思往往就是上面左栏那三条。

## 教 debug：收尾没跑

`dispose` 的问题有一个共同特征：**只在退出时发生，而且经常悄无声息**。

**"最后几条事件没落盘"** —— 先确认 `dispose()` 到底有没有被调到。最快的办法是在每个 `dispose` 里打一行：

```ts
async dispose(): Promise<void> {
  console.error(`[dispose] ${this.name}`)
  await this.handle.close()
}
```

跑一次退出，看这几行出没出来、顺序对不对。**没出来 = 入口忘了 `await ctx.dispose()`；出来了但顺序反了 = 注册顺序和你以为的不一样**（回去看 `listServices()`）。

**一个 `dispose` 抛错，后面的就不收了。** 我们的实现是串行 `await`，第一个抛错就整个中断——这和装配的 `Promise.all` 是同一个取舍（当场炸而不是全部收完再报）。但**退出路径上这个取舍值得怀疑**：一个日志服务关闭失败，不该让数据库连接漏掉。dsh 在这里做了失败隔离，我们没有——**这是一处明确的欠账**，阶段 9 补。

## 对照 dsh

`dsh/vendor/cordis/src/service.ts`，115 行。构造函数的核心是同一件事：

```ts
constructor(protected ctx: Context, name: string) {
  name ??= this.constructor['provide'] as string
  …
  self.ctx = ctx
  self.name = name
  defineProperty(self, symbols.tracker, tracker)
  self.ctx.reflect.provide(name, self, this[symbols.check])
  return self
}
```

`ctx` + `name` + `provide`——我们抄的就是这三行。多出来的几样各买了什么：

**`name ??= this.constructor['provide']`** —— 名字可以写成静态字段 `static provide = 'llm'`，不用每个子类都在 `super()` 里重复。

**`return self`（构造函数里 return 一个别的对象）** —— 这是 JS 允许的：构造函数返回对象时，`new` 的结果就是那个对象。dsh 用它实现**可调用的服务**——`ctx.logger('agent')` 里 `logger` 既是对象又能被调用，靠的是 `createCallable` 造一个函数再把原型接上去。

**`tracker`** —— 记录"谁通过哪个属性访问了这个服务"，阶段 9 的自动回收要用。

**`[symbols.check]`** —— 可用性谓词。服务可以声明"我现在还不能用"，读的人拿到 `undefined` 而不是半成品——正好对付上面那个"构造窗口"问题。

| | 我们的 | dsh 的 | 哪个阶段补齐 |
|---|---|---|---|
| 注册 | `ctx.provide(name, this)` | 同，外加 `check` 谓词 | 阶段 14 |
| 卸载 | `dispose()`，手动调 `ctx.dispose()` | **fiber 卸载时自动**，注册即 effect | 阶段 9 |
| 失败隔离 | 没有（一个抛错后面全不收） | 有 | 阶段 9 |
| 名字 | 构造参数 | 构造参数或 `static provide` | 不复刻 |
| 可调用的服务 | 没有 | `[Service.invoke]` + `createCallable` | 不复刻（外围） |
| 构造后钩子 | 没有 | `[Service.init]` | 不复刻 |
| 配置合并 | 没有 | `[Service.resolveConfig]` + `intercept()` | 阶段 11 |

**第二行是这一课最大的欠账。** 我们的 `dispose()` 要**有人记得调**——只是从"每个入口记得调 close"变成了"每个入口记得调 dispose"，重复少了一处，但性质没变。dsh 不需要任何人记得：**服务是在某个 fiber 里注册的，那个 fiber 卸载时，它注册过的一切自动回收**。

那才是终点。阶段 9 讲它。

## 这一课改了什么

| 文件 | 改动 |
|---|---|
| `src/cordis.ts` | 新增 `Service` 基类；`plugin()` 认类插件；新增 `Context.dispose()` |
| `src/plugins.ts` | `persistencePlugin` → `PersistenceService extends Service`，带 `static inject` 和 `dispose()` |
| `src/index.ts` / `src/headless.ts` | `await ctx.persistence.close()` → `await ctx.dispose()` |
| `demos/08-services/06-service-class.mjs` | 新增：类插件、静态 inject、逆序收尾、构造窗口、原型链判据 |

## 下一课

**8.5 阶段验收**：把 8.1–8.4 串起来，对照 `ctx.llm` / `ctx.tools` / `ctx.sessions` 在 dsh 里的真实样子，并把阶段 9 的痛点摆出来——**所有注册都还要靠人记得撤销**，而这一课刚刚证明了那条路走不通。
