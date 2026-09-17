# 8.1 兄弟之间看不见

阶段 7 结束时留下了一棵形状很怪的树：

```
root
  configPlugin   + config
    promptPlugin   + prompt
      guardsPlugin   + guards
        sessionPlugin   + sessionId, logPath, session
          persistencePlugin   + persistence
            cli
```

五个插件之间**大部分没有依赖关系**——`promptPlugin` 和 `guardsPlugin` 谁也不用谁。它们被串成一条线，只是因为一件事：**兄弟之间互相看不见。**

## 痛点：继承只朝一个方向走

7.2 的演示：

```ts
ctx.plugin(function configPlugin(c) { c.config = { readOnly: true } })
ctx.plugin(function guardsPlugin(c) { c.guards = c.config.readOnly ? … : … })
```

```
TypeError: Cannot read properties of undefined (reading 'readOnly')
```

`configPlugin` 写的是**它自己的** ctx，`guardsPlugin` 读的是**它自己的** ctx。两个是兄弟，而原型链只能子看父。

我们用 `nest()` 绕开了它——把清单串成一条链，让后面的成为前面的后代。代价有三个：

**① 假的依赖关系。** 那棵树看起来像在说"`guardsPlugin` 依赖 `promptPlugin`"，而这是**假的**。读代码的人会被误导。

**② 顺序全是手写的，而且写错不报"顺序错"。** 7.4 验收里实测过：把 `sessionPlugin` 和 `persistencePlugin` 对调，得到的是

```
TypeError: Cannot read properties of undefined (reading 'events')
```

**③ 根看不见任何东西。** 根是所有插件的祖先，所以插件加的东西它一概读不到。想在装配完成后检查"齐不齐"，只能靠最后一环把自己的 ctx 捞出来——7.3 那个 `cli` 插件干的就是这件事。

> 继承给的是**方向性**的可见：子看得见父。而"插件之间互相用"需要的是**无方向**的可见。用错了工具。

## 解法：一句话和一张图

**一句话：服务不写在自己的 ctx 上，而是写进整棵树共用的一张表；读的那一头在根上定义访问器，于是任何一个 ctx 都读得到。**

```
改前（继承）：只能父 → 子
   root
     A  { config }          ← A 写在自己身上
       B                    ← B 是 A 的后代才读得到
     C                      ← C 是兄弟，读不到

改后（服务）：整棵树共用一张表
   root ── services: Map { 'config' → {...} }
     │      ↑ provide 写进这里
     │      ↓ 根上定义 get config() { return services.get('config') }
     A  provide('config', …)
     C  读 ctx.config ✓     ← 兄弟读得到
   root 自己也读得到 ✓       ← 祖先也读得到
```

### 一屏看完的完整实现

`src/cordis.ts` 新增的全部代码：

```ts
export class Context {
  /**
   * 服务表：**整棵树共用一张**。
   * 只有根真正持有它；子 context 通过原型链拿到的是**同一个 Map**。
   */
  private readonly services = new Map<string, unknown>()

  /** 这棵树的根。服务的访问器都定义在它身上，于是所有后代都读得到。 */
  private get root(): Context {
    let node: Context = this
    while (node.parent !== undefined) node = node.parent
    return node
  }

  provide(name: string, value: unknown): void {
    const root = this.root
    if (root.services.has(name)) throw new Error(`服务重名：${name} 已经被提供过了`)
    root.services.set(name, value)
    Object.defineProperty(root, name, {
      get: () => root.services.get(name),
      configurable: true,      // 阶段 9 要能撤销，所以必须可重新配置
      enumerable: true,
    })
  }

  /** 列出当前已经提供了哪些服务，按提供顺序。 */
  listServices(): string[] {
    return [...this.root.services.keys()]
  }
}
```

**十几行。** 机制就是"一张共用的 Map + 根上的一个 getter"。

### 用起来是一个词的差别

`src/plugins.ts` 里，六个插件把 `=` 换成了 `provide`：

```ts
export function configPlugin(ctx: Context): void {
  ctx.provide('config', loadConfig())          // 原来是 ctx.config = loadConfig()
}

export function guardsPlugin(ctx: Context): void {
  ctx.provide('guards', [accounting(ctx.config.accounting), …])
  //                                 ^^^^^^^^^^ 读兄弟提供的服务，不用是它的后代
}
```

**读的那一头一个字没改**——还是 `ctx.config`。`declare module` 那段声明也一个字没改，因为**从 ctx 上能读到什么**这件事没变，变的只是它怎么被放上去。

`nest()` 因此退休了，两个入口装的是一个平铺的清单：

```ts
export function assemble(leaf: Plugin<void>): Plugin<void> {
  return {
    name: 'app',
    apply(ctx) {
      for (const plugin of corePlugins) ctx.plugin(plugin)
      ctx.plugin(leaf)
    },
  }
}
```

### 产出长什么样

```sh
node --import tsx demos/08-services/02-assembled-flat.mjs
```

```
=== 装配树：7.3 是一路缩进，现在是平的 ===
root
  app
    configPlugin
    promptPlugin
    guardsPlugin
    sessionPlugin
    persistencePlugin
    cli

=== 服务表（整棵树共用一张）===
  config / prompt / guards / sessionId / logPath / session / persistence

=== 谁都读得到，不分位置 ===
  root.config.model          = mock
  root.children[0].sessionId = 20260917-1014-f660
```

**那棵假的依赖链消失了。** 现在的树形说的是真话：六个插件是平级的。

## 四个设计决定

### ① 故意让子共享父的 Map——7.2 那个"坑"在这里是工具

7.2 讲过：可变对象不能靠继承共享，否则子的 `push` 会打到父身上。所以 `plugin()` 里必须显式给每个子一份新的 `children` 数组。

而 `services` 这个 Map **故意不给**：

```ts
private readonly services = new Map<string, unknown>()   // 只有 new Context() 会执行
// extend() 用的是 Object.create(this)，不跑字段初始化 → 子拿到的是父那一个
```

**同一条语言规则，一次是坑，一次是工具；区别只在于你要不要共享。**

判据还是 7.2 那条，只是答案反过来了：**这个东西应该整棵树只有一份吗？** `children` 不是（每层一份），`services` 是。

### ② 为什么用 getter 而不是直接赋值

```ts
Object.defineProperty(root, name, { get: () => root.services.get(name), … })
// 而不是 root[name] = value
```

差别在于**这层间接**：属性读的是 Map 当下的内容，而不是定义那一刻的值。所以将来换实现（阶段 14 的 `isolate()`）、撤销注册（阶段 9）时，只要改 Map，所有已经拿到 ctx 的人立刻看到新的——**不用去追谁手里还攥着旧引用**。

这和 5.2 那条"变量的取值函数在每次组装时才跑"是同一个形状：**多一层间接，换来的是"什么时候取值"这件事归你管**。

### ③ 服务对**整棵树**可见，包括根

```
  先装的那个插件读到：["read","write"]
  它在 tools 被提供之前就装好了，但现在读得到——访问器是活的。
```

访问器定义在根上，而根是所有 ctx 的原型祖先，所以**没有方向**。这正是"服务"和"继承来的属性"的根本区别：

| | 谁看得见 | 什么时候看得见 |
|---|---|---|
| 继承的属性（7.2） | 只有后代 | 父加上之后 |
| 服务（8.1） | **整棵树** | provide 之后 |

注意第三个演示里那句提醒：**"装好之后能读到"不等于"在自己的 apply 里能读到"**。那是时序问题，8.2 才解决。

### ④ 重名抛错，不是"后者覆盖前者"

```
  服务重名：tools 已经被提供过了
```

静默覆盖会让"到底哪个实现在生效"变成一道考古题：两个插件都声称提供 `tools`，谁装得晚谁赢，而装载顺序可能因为一个不相干的改动而变化。

**装配期的冲突必须吵**——和 7.1 那条"装配失败当场炸"、5.1 那条"prompt 段落重名抛错"是同一条规矩。

想合法地换实现要走另一条路：dsh 的 `isolate()` 给子树开一个独立的服务作用域（阶段 14 讲 subagent 换掉 `tools` 时会用到）。**"换实现"和"重名"是两件事，前者要有显式的语法。**

## 教 debug：服务表是新的第一栏

阶段 7 的三栏诊断，现在最前面多了一栏：

```ts
console.log(ctx.listServices())      // ['config', 'prompt', 'guards', …]
```

读到 `undefined` 时的排查顺序变了，而且**比以前短**：

**① 服务表里有它吗？** 没有 → 提供它的那个插件没装上，或者名字写错了。去看插件树。

**② 有，但你读到 `undefined`？** 那就只剩一种可能：**你读的时候它还没被 provide**——提供者排在你后面。这是 8.2 要解决的最后一类问题。

以前还要问的第三个问题——"它是不是提供在兄弟节点上"——**永远消失了**。服务没有方向。

## 对照 dsh

dsh 的对应实现在 `dsh/vendor/cordis/src/reflect.ts` 的 `provide()`，签名多了一个参数：

```ts
provide(name: string, value?: any, check?: () => boolean) {
  return this.ctx.fiber.effect(() => { … })
}
```

三处关键差别：

**① 它返回一个 disposer，而且是通过 `fiber.effect()` 注册的。** 文档说：

> The service becomes visible to dependents in the same isolation scope once the fiber is active; it is **unregistered (waking dependents) when the returned disposer runs or the fiber unloads**.

"注册即 effect、卸载即回收"是 dsh 的硬规矩，阶段 9 的整个主题。我们的 `provide()` 现在没有返回值——**这是一处明确的欠账**。

**② ctx 是一个 Proxy，不是我们这种"在根上定义属性"。** 为什么值得上 Proxy：

- **隔离作用域**：`isolate()` 之后，同一个名字在子树里要解析到另一个实现。属性是定义在根上的，做不到"同一个名字不同答案"。
- **`check` 谓词**：服务可以声明"我现在还不可用"，读的人拿到 undefined 而不是半成品。
- **mixin**：`ctx.on` 其实转发到 `ctx.events.on`，靠的是给 ctx 装转发访问器。
- **追踪**：谁读了哪个服务，要能记下来（阶段 9 的自动回收要用）。

这四样里任何一样，用"在根上 defineProperty"都做不了。**我们的十几行够用，是因为我们只要第一条功能。**

**③ 服务名和类型的关系。** dsh 的 `provide` 有一个重载是 `provide<K extends string & keyof this>(name: K, value: this[K])`——**服务名必须是 `Context` 上声明过的键，值的类型也必须对得上**。我们的 `provide(name: string, value: unknown)` 没有这层保护，写错名字要等到读的时候才发现。

| | 我们的 | dsh 的 | 哪个阶段补齐 |
|---|---|---|---|
| 存在哪 | 根上一个 Map + 根上的访问器 | `ReflectService` + ctx Proxy | 不复刻（我们不需要 Proxy 那四样） |
| 卸载 | **没有** | 返回 disposer，fiber 卸载时自动撤销 | 阶段 9 |
| 隔离作用域 | 没有 | `isolate()` | 阶段 14 |
| 可用性谓词 | 没有 | `check` | 阶段 14 |
| 名字/类型校验 | `string` + `unknown` | `keyof this` + `this[K]` | 阶段 9 顺带 |
| 时序 | 提供者必须先跑 | `inject` 声明依赖，装载器等它 | **8.2** |

## 这一课改了什么

| 文件 | 改动 |
|---|---|
| `src/cordis.ts` | 新增 `services` 表、`root`、`provide()`、`listServices()`；**删掉 `nest()`** |
| `src/plugins.ts` | 六个插件改用 `ctx.provide(...)`；新增 `assemble(leaf)` |
| `src/index.ts` / `src/headless.ts` | `nest(...corePlugins, leaf)` → `assemble(leaf)` |
| `demos/08-services/01-provide.mjs` | 新增：兄弟可见、整棵树可见、重名抛错、时序还没解放 |
| `demos/08-services/02-assembled-flat.mjs` | 新增：真实装配的平树与服务表 |

`nest()` 在 7.3 出生，8.1 退休——**它的全部使命就是在"没有服务"的那两课里顶一下**。这正是 7.4 说的"过渡态要留下标记"：它的 JSDoc 从第一天就写着"阶段 8 之后这些插件会被拍平"。

## 下一课的痛点

平铺之后还剩最后一个约束：

```ts
export const corePlugins = [
  configPlugin, promptPlugin, guardsPlugin, sessionPlugin, persistencePlugin,
] as const
```

**这个数组的顺序仍然重要**，因为装载是同步的：`guardsPlugin` 跑的时候 `configPlugin` 必须已经跑完。演示里最后那段就是证据：

```
=== ⑤ 但顺序还没解放 ===
  TypeError: Cannot read properties of undefined (reading 'readOnly')
```

**[8.2](../02-inject/01-inject.md) 引入 `inject`**：插件声明自己依赖哪些服务，装载器发现依赖没就绪就**挂起**它，等那个服务出现再装。那时这个数组怎么排都行。（7.3 那行 `void repairLog(...)` 的债要等 8.3——那一课让 `apply` 可以是异步的。）
