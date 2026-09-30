# 9.1 注册了就撤不回来

阶段 8 让插件能互相用了。但**装上去的东西，还没有一样能真正撤下来**。

## 痛点：七个注销函数，七个都被丢了

`promptPlugin` 往 `PromptRegistry` 里塞了七样东西：

```ts
prompt.variable('cwd', () => process.cwd())
prompt.variable('model', () => ctx.config.model)
prompt.register(identitySection)
prompt.register({ name: PERSONA_PREFIX_SECTION, … })
prompt.register(toolGuidanceSection)
prompt.register(readOnlyNotice(ctx.config.readOnly))
prompt.context({ name: 'time', … })
```

这七个方法**每一个都返回了注销函数**——5.1 写的时候就是这么设计的：

```ts
register(section: PromptSection): () => void { … }
variable(name: string, provide: …): () => void { … }
context(section: PromptContext): () => void { … }
```

`src/system-prompt.ts` 里这样的返回值有四个，`session.ts` 里还有一个 `on()`。

**从第一天起，它们一次都没被接住过。**

于是这个插件是不可逆的：装上就下不来。具体后果：

- **阶段 14 要给 subagent 换一套工具和 prompt**——换不了，因为旧的撤不掉，新的只能叠上去。
- **HMR**（改一个文件只重载相关插件）无从谈起。
- **测试里装一次卸一次**做不到，只能每次重建整个应用。

一个能注册不能注销的注册表，**等于一个只能变大的全局状态**。

### 自己记账行不行

第一反应是每个插件自己维护一个数组：

```ts
function manual(ctx) {
  const undo = []
  const timer = setInterval(() => {}, 1000)
  undo.push(() => { clearInterval(timer) })
  undo.push(() => 撤销注册B())
  // 还得自己暴露一个收尾入口——而且不能写在自己的 ctx 上（7.2：父看不见子），
  // 得 provide 出去才有人调得到。
  ctx.provide('cleanup', async () => {
    for (const fn of undo.reverse()) await fn()
  })
}
```

它能跑。但这段账本是**每个插件都要抄一遍**的样板，而且每一处都能写错：

| 要自己管的事 | 写错的后果 |
|---|---|
| 别忘了 push | 那样资源永远泄漏，而且**没有任何东西会提醒你** |
| 顺序要倒过来 | 先收了被依赖的那个 |
| 重复调用要挡 | 关一个已经关了的句柄会抛 |
| 暴露一个收尾入口 | 还得解决"外面怎么调到我"（又是一道可见性题） |

最要命的是第一行：**申请和归还在代码里隔着几行甚至几个函数，中间可以插进任何东西——包括一个提前 `return`。**

## 解法：一句话和一张图

**一句话：申请和归还写在同一个表达式里，中间隔不进任何东西。**

```ts
ctx.effect(() => {
  const timer = setInterval(tick, 200)      // 申请
  return () => { clearInterval(timer) }     // 归还
})
```

```
改前：申请在这儿，归还在别处
   apply() { const t = setInterval(…);  undo.push(() => clearInterval(t))  …  }
             ↑ 申请                      ↑ 归还（可能忘、可能顺序错）
   收尾：自己写一个 cleanup，还要让别人调得到

改后：一个动作的两半
   apply() { ctx.effect(() => { const t = …; return () => clearInterval(t) }) }
                          └──── 申请和归还绑在一起 ────┘
   收尾：ctx.dispose() 逆序跑完这个 context 上登记的一切
```

### 一屏看完的完整实现

`src/cordis.ts`：

```ts
/** 归还一样资源的函数。同步异步都行。 */
export type Disposer = () => void | Promise<void>

/**
 * 这个 context 上注册过的、卸载时要回收的东西。
 * **每个 context 一份**：回收的单位是"一个插件"，所以账记在插件自己的 context 上。
 */
private readonly disposables: Disposer[] = []

// 而"每个一份"**不能只靠这个字段初始化器**——`extend()` 走的是 `Object.create`，
// 它不跑初始化器。所以 `install()` 里必须和 `children` 一样显式给一个新数组：
const child = entry.ctx.extend({
  name: entry.name,
  parent: entry.ctx as Context,
  children: [] as Context[],
  disposables: [] as Disposer[],     // ← 漏了它，所有插件的 effect 记在同一个账本上
})

effect(execute: () => Disposer | void): Disposer {
  const disposer = execute()
  if (disposer === undefined) return () => {}
  let disposed = false
  const wrapped: Disposer = async () => {
    // 幂等：手动调过一次之后，插件卸载时还会再调一次。
    if (disposed) return
    disposed = true
    await disposer()
  }
  this.disposables.push(wrapped)
  return wrapped
}

async dispose(): Promise<void> {
  // 先收子树，再收自己：后装上的先收，和 effect 的逆序是同一条理由。
  for (const child of [...this.children].reverse()) await child.dispose()
  for (const disposer of this.disposables.splice(0).reverse()) await disposer()
}
```

**二十行。** 三件事：跑一次申请、把归还登记到这个 context 上、返回一个幂等的手动归还入口。

### 用起来：七行 `ctx.effect`

`promptPlugin` 现在长这样：

```ts
// 每一处注册都过一遍 ctx.effect：5.1 里这些方法从第一天就返回注销函数，
// 到这里才第一次被接住。这个插件被卸载时，它塞进去的七样东西按逆序自动撤回。
ctx.effect(() => prompt.variable('cwd', () => process.cwd()))
ctx.effect(() => prompt.variable('model', () => ctx.config.model))
ctx.effect(() => prompt.register(identitySection))
ctx.effect(() => prompt.register({ name: PERSONA_PREFIX_SECTION, … }))
ctx.effect(() => prompt.register(toolGuidanceSection))
ctx.effect(() => prompt.register(readOnlyNotice(ctx.config.readOnly)))
ctx.effect(() => prompt.context({ name: 'time', … }))
```

**注册的写法一个字没改**，只是外面套了一层 `ctx.effect(…)`——因为 `register()` 本来就返回归还函数，`effect` 要的正好是它。

> **一个返回 disposer 的 API，天生就是一个 effect。** 5.1 的设计到这一刻才被兑现。

### 产出长什么样

```sh
node --import tsx demos/09-effects/02-prompt-effects.mjs
```

```
=== 装上之后 ===
  清单：4 段 —— harness:identity、deployment:persona-prefix、tools:guidance、guard:read-only
    拼出来 336 字符；运行时上下文 60 字符

=== 收掉整棵树 ===
  清单：0 段
    拼出来 0 字符；运行时上下文 0 字符
```

**七样东西全撤回去了，而 `promptPlugin` 里没有一行"撤销"的代码。**

## 四个必须讲清楚的点

### ① 逆序，而且子树先收

```ts
for (const child of [...this.children].reverse()) await child.dispose()
for (const disposer of this.disposables.splice(0).reverse()) await disposer()
```

两个 `reverse()` 是同一条理由：**后来的可能用着先来的。**

- effect 之间：先注册数据库连接，再注册一个用它的定时器 → 先停定时器。
- 父子之间：子插件用着父提供的服务 → 先收子插件。

（`[...this.children]` 复制一份再 `reverse()`，因为 `reverse()` 会**原地**改数组——直接 `this.children.reverse()` 会把插件树的顺序永久打乱。这是 JS 数组方法一个经典的坑：`sort` / `reverse` 原地改，`map` / `filter` 返回新的。）

### ② 幂等不是洁癖

```ts
if (disposed) return
disposed = true
```

演示 ④：手动收过一次，再 `dispose()` 整棵树，那行只打印一次。

为什么必须挡：`clearInterval` 调两次无所谓，但**关一个已经关了的文件句柄会抛，删一个已经删了的临时文件会抛，从一个已经清空的注册表里注销会抛**。

而"手动收一次 + 卸载时再收一次"是**正常路径**，不是异常：一个插件可能因为配置变化主动撤掉某个注册，之后它自己又被卸载。

### ③ `splice(0)` 而不是只读一遍

```ts
this.disposables.splice(0).reverse()
```

`splice(0)` 是"取走全部并清空"。清空是必要的——否则 `dispose()` 调两次会把同一批归还函数再跑一遍（虽然每个都幂等，但白跑一趟，而且如果期间又注册了新的 effect，账就乱了）。

这个手法和 8.3 的 `ready()` 里那个 `inflight.splice(0)` 是同一个：**先取走，再处理**。

### ④ 这个字段差点就写错了：7.2 那个坑第三次出现

`disposables` 是一个**每层一份**的可变数组，而 `services` / `pending` / `inflight` 是**整棵树一份**的。它们都写成了字段初始化器，但 `extend()` 用 `Object.create` 派生子 context，**初始化器一次都不会跑**——所以字段初始化器只对根有效，子 context 拿到的永远是父那一份。

于是"每层一份"必须在 `install()` 里显式给：

```ts
children: [] as Context[],
disposables: [] as Disposer[],
```

漏掉任何一个的症状完全不同，但都很隐蔽：

| 漏掉 | 症状 |
|---|---|
| `children` | 插件树塌成一层（7.2 演示过） |
| `disposables` | **所有插件的 effect 记在同一个账本上，卸载一个等于卸载全部** |

第二个尤其阴：小例子里只有一个 effect 时**完全看不出来**，要等到"只想卸载 A，结果 B 也被收了"才暴露——而那正是 9.2 整课的前提。

> 同一条规则（`Object.create` 不跑字段初始化器）在这门课里已经咬了三次：7.2 的 `children`、8.1 故意利用它共享 `services`、9.1 的 `disposables`。**每次加一个新字段，都要先问一句：它该是整棵树一份，还是每层一份？**

### ⑤ 服务的收尾也变成了 effect

`Service` 的构造函数多了一行：

```ts
constructor(protected readonly ctx: Context, name: string) {
  this.name = name
  ctx.provide(name, this)
  // 收尾也是一个 effect。**不用任何人记得调**——这个 context 被收时它自然被叫到。
  ctx.effect(() => () => this.dispose?.())
}
```

对比 8.4 那版：那时 `Context.dispose()` 要**专门去遍历服务表**，找出哪些实现了 `dispose`。现在服务和别的注册走**同一条回收路径**——**收尾不再是服务的特权**。

这一步顺带解决了 8.4 记下的一个问题：那时的遍历是按服务表的注册顺序，而服务和非服务的注册之间没有统一的顺序。现在只有一条时间线。

（`ctx.effect(() => () => this.dispose?.())` 这个双层箭头看着别扭：外层是"申请"（这里什么都不申请），内层是"归还"。dsh 里同样的地方写法也一样。）

## 教 debug：泄漏怎么查

不可逆的注册有一个共同症状：**跑久了越来越慢/越来越占内存，而且重启就好了**。

**① 先确认是不是注册泄漏。** 在一个循环里装卸同一个插件一百次，看一个能观察的计数器涨不涨：

```ts
for (let i = 0; i < 100; i++) {
  const ctx = root.extend({ name: 'probe', parent: root, children: [] })
  somePlugin(ctx)
  await ctx.dispose()
}
console.log(prompt.inventory().length)    // 应该回到 0
```

**装一次卸一次，任何计数器都该回到原值。** 回不去的差值就是每次泄漏的量。

**② 定位是哪一处注册漏了。** 逐个把 `ctx.effect(...)` 的外壳拆掉再跑上面那个循环——涨起来的那一次就是它。反过来也行：给 `effect` 临时加一个 `label` 参数，`dispose` 时打出来，看谁没被打到。

（dsh 的 `effect()` 就有这个 `label` 参数，还会挂一棵 `EffectMeta` 树供诊断。我们没做——**这是一处有意的简化，因为诊断结构本身会让这二十行变成两百行**。）

**③ 一个通用判据。** 任何"注册/订阅/分配"的 API，**如果它不返回归还的方式，它就是一个设计缺陷**——哪怕当下没人需要卸载。因为"需要卸载"这件事永远是后来才出现的，而那时改 API 已经晚了。

## 对照 dsh

dsh 的教程第二章开宗明义：

> Cordis 插件可能因修改配置、热重载、显式资源释放或所需服务消失而卸载。**通过 Cordis API 建立的注册属于 effect，会在所属插件卸载时撤销；在这些 API 之外管理的资源必须包装在 `ctx.effect()` 中。**

这句话把 effect 的适用范围说清楚了：`ctx.on()`、`ctx.plugin()`、`ctx.provide()` 这些**本身就是 effect**，不用再包；定时器、连接、watcher 这类 Cordis 不知道的东西才需要你自己包。

它的 `effect()` 在 `dsh/vendor/cordis/src/fiber.ts`，核心几行和我们一样：

```ts
const dispose = () => {
  if (disposing) return disposalTask          // ← 幂等
  disposing = true
  let task!: void | Promise<void>
  for (const disposable of disposables.splice(0).reverse()) {   // ← 取走 + 逆序
    …
  }
  return disposalTask = task
}
```

`splice(0).reverse()`、幂等标志——一字不差是同一个手法。多出来的部分：

| | 我们的 | dsh 的 | 哪个阶段补齐 |
|---|---|---|---|
| 幂等 | 一个布尔 | 一个布尔 + **返回同一个 promise** | 不复刻 |
| 嵌套 effect | 没有 | effect 里可以再建 effect，形成一棵 `EffectMeta` 树 | 不复刻 |
| 诊断 | 没有 | `label` + `Context.effect` 符号挂出整棵 effect 树 | 不复刻 |
| 卸载中再注册 | 不管 | 抛 `INACTIVE_EFFECT` | **9.2** |
| 异步归还 | 串行 `await` | 链式 `then`，同步的不强制变异步 | 不复刻 |
| 失败隔离 | 没有（一个抛错后面全不收） | 有 | 9.2 |

第四行值得留意：dsh 里**卸载进行中再调 `ctx.effect()` 会直接抛错**。想想为什么——一个正在被收掉的 context 上又登记了新资源，那个资源永远不会被收。9.2 讲卸载时会回到这里。

**第一行那个"返回同一个 promise"也不只是优化**：两个地方同时调 `dispose()`，它们该等同一件事完成，而不是各跑一遍。我们的版本第二次调用直接返回，**不等第一次跑完**——这是一处真实的简化，在异步归还的场景下可能咬人。

## 这一课改了什么

| 文件 | 改动 |
|---|---|
| `src/cordis.ts` | 新增 `Disposer` 类型、`disposables` 字段、`effect()`；`dispose()` 改成收整棵子树的 effect；`Service` 把自己的 `dispose` 登记成 effect |
| `src/plugins.ts` | `promptPlugin` 的七处注册全部过 `ctx.effect()` |
| `demos/09-effects/01-effect.mjs` | 新增：自己记账 vs effect、逆序、幂等、服务收尾 |
| `demos/09-effects/02-prompt-effects.mjs` | 新增：七样东西整个撤回去 |

## 下一课的痛点

`ctx.dispose()` 现在能收掉**一棵子树**。但我们还没有办法说"卸载某一个插件"——`ctx.plugin()` 返回的是 `void`，装完之后你手里没有任何能指向它的东西。

```ts
ctx.plugin(somePlugin)       // 装上了。然后呢？
```

而 HMR 要的恰恰是这个：改一个文件，**只把那个插件卸下来再装回去**，其余的原样不动。

**9.2 让 `ctx.plugin()` 返回一个 disposer**，并处理两件随之而来的事：卸载一棵子树时的顺序，以及**一个已经被卸载的 ctx 上再注册东西该怎么办**——那正是 dsh 抛 `INACTIVE_EFFECT` 的地方。
