# 7.3 把装配拆成插件

7.1 数出了痛：两个入口的装配一字不差重了 17 行，占 `headless.ts` 的 81%。7.2 给了工具：子 context 能继承父的一切。

这一课把它们合起来用。

## 痛点回顾

```sh
node --import tsx demos/07-cordis/02-duplicated-assembly.mjs
```

```
  index.ts（7.1 版）  49 行有效代码
  headless.ts（7.1 版） 21 行有效代码
  **完全一样的**     17 行  （占 headless 的 81%）
```

> 这个演示读的是 `demos/07-cordis/fixtures/` 里**冻结的 7.1 版本**。`src/` 里的代码是原地演进的，而这一课要讲的正是"当时的重复有多少"，所以它需要一份不会变的标本。

加一道护栏要改 2 处，加一段 system prompt 要改 2 处，再加一个入口就是 3 处。**漏改一处不报错，只是那个入口的 agent 行为和另一个不一样。**

## 解法：一句话和一张图

**一句话：把那 17 行拆成六个插件，每个插件只回答"我往这个应用里加什么"；两个入口各自装上同一份清单，再挂自己特有的那一环。**

```
改前：
   index.ts ────→ 17 行装配 + readline 循环
   headless.ts ─→ 17 行装配（抄的）+ 一次性任务

改后：
   plugins.ts ──→ configPlugin → promptPlugin → guardsPlugin → sessionPlugin → persistencePlugin
                  └────────────────── corePlugins ──────────────────┘
                         ↑                              ↑
   index.ts ─────────────┘ + cli 循环                    │
   headless.ts ───────────────────────────────────────── ┘ + 一次性任务
```

### 一屏看完：六个插件

`src/plugins.ts`（省略 JSDoc）：

```ts
export const SESSION_ROOT = join(process.cwd(), '.dsh-learn', 'sessions')

/** 读配置。它不依赖任何东西，所以排在链条最前面。 */
export function configPlugin(ctx: Context): void {
  ctx.config = loadConfig()
}

/** 组装 system prompt。它只**读** ctx.config，不关心那份配置是谁提供的。 */
export function promptPlugin(ctx: Context): void {
  const prompt = new PromptRegistry()
  prompt.variable('cwd', () => process.cwd())
  prompt.variable('model', () => ctx.config.model)
  prompt.register(identitySection)
  prompt.register({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: ctx.config.systemPrompt })
  prompt.register(toolGuidanceSection)
  prompt.register(readOnlyNotice(ctx.config.readOnly))
  prompt.context({ name: 'time', order: 0, text: () => `现在是 ${new Date().toISOString()}。` })
  ctx.prompt = prompt
}

/** 这次装配启用哪些护栏。顺序就是执行前钩子的求值顺序。 */
export function guardsPlugin(ctx: Context): void {
  ctx.guards = [accounting(ctx.config.accounting), readOnlyGuard(ctx.config.readOnly), outputBackstop()]
}

/** 建会话，或者读回要续的那个。--resume 的解析也在这里。 */
export function sessionPlugin(ctx: Context): void {
  const resumeId = resumeTarget()
  ctx.sessionId = resumeId ?? newSessionId()
  ctx.logPath = sessionLogPath(SESSION_ROOT, ctx.sessionId)
  ctx.session = resumeId === undefined ? new Session() : new Session(loadAndRepair(ctx.logPath))
}

/** 把会话挂到磁盘上。它要读 session 和 logPath，所以排在会话后面。 */
export function persistencePlugin(ctx: Context): void {
  const isNew = ctx.session.events.length === 0
  ctx.persistence = attachJsonlPersistence(ctx.session, ctx.logPath, isNew ? { … } : undefined)
}

/** 两个入口共用的那份清单，**按依赖顺序**排列。 */
export const corePlugins = [
  configPlugin, promptPlugin, guardsPlugin, sessionPlugin, persistencePlugin,
] as const
```

### 用起来是两行

`src/index.ts` 的**最后两行**：

```ts
export const root = new Context()
root.plugin(nest(...corePlugins, cli))
```

`src/headless.ts` 的最后两行：

```ts
export const root = new Context()
root.plugin(nest(...corePlugins, headless))
```

**一模一样，只差最后那一环。**

### 产出长什么样

```sh
node --import tsx demos/07-cordis/05-assembled.mjs
```

```
=== 装配树（嵌套的深度就是手写的依赖顺序）===
root
  configPlugin   + config
    promptPlugin   + prompt
      guardsPlugin   + guards
        sessionPlugin   + sessionId, logPath, session
          persistencePlugin   + persistence
            cli

=== 两个入口的体量：7.1 版 → 7.3 版 ===
  src/index.ts       151 行 → 116 行
  src/headless.ts     68 行 →  47 行
  src/plugins.ts     （新）  83 行  ← 装配搬到了这里，两个入口共用

=== 现在加一个功能要改几处 ===
  加一道护栏          → 1 处
  加一段 system prompt → 1 处
  改会话存放位置       → 1 处
```

**三项都从 2 处变成了 1 处，而且再加第三个入口它还是 1 处。**

## 三个设计决定

### ① `nest()`：为什么是嵌套，不是并列

7.2 演示过：兄弟插件互相看不见。所以 `corePlugins` 不能平铺着装——`guardsPlugin` 读不到 `configPlugin` 写的东西。

`src/cordis.ts` 加了一个组合函数：

```ts
export function nest(...plugins: Plugin<void>[]): Plugin<void> {
  const [head, ...rest] = plugins
  if (head === undefined) return function empty() {}
  const apply = typeof head === 'function' ? head : head.apply
  const name = …
  return {
    name,
    apply(ctx) {
      apply(ctx, undefined)
      if (rest.length > 0) ctx.plugin(nest(...rest))   // 递归：把剩下的装成自己的子插件
    },
  }
}
```

装出来就是上面那棵一路往右缩进的树。**嵌套的深度就是手写的依赖顺序**——这个丑陋不是偶然，它是"我们还没有服务"这件事在树形上的样子。

阶段 8 之后这棵树会被拍平成兄弟，顺序由 `inject` 算出来。**现在这个形状是一个诚实的过渡态，不是终态。**

### ② declaration merging：插件自己声明自己的贡献

`ctx.config = loadConfig()` 这一行要编译得过，`Context` 上就得有 `config` 这个属性。但 `cordis.ts` 是通用的插件系统，它凭什么知道有个东西叫 config？

答案是**不用它知道**：

```ts
declare module './cordis.ts' {
  interface Context {
    /** 解析好的配置（configPlugin 提供）。 */
    config: ResolvedConfig
    /** system prompt 注册表（promptPlugin 提供）。 */
    prompt: PromptRegistry
    …
  }
}
```

这段写在 `plugins.ts` 里。TypeScript 会把同名 `interface` **合并**（declaration merging），于是这些字段长到了 `cordis.ts` 里那个 `Context` 上——**而 `cordis.ts` 一个字都不用改**。

方向对了：**插件自己声明自己往 ctx 上加什么。** dsh 的 `Context` 接口注释里写的就是这件事：

> The concrete `Context` class is proxied at runtime, so this interface is **augmented by core services and plugins** to describe the properties that may be read from `ctx`.

阶段 8 会看到 dsh 的每个包都在自己的文件里往 `Context` 上加一行，核心包一个字不用改。

> Python 类比：最接近的是往一个类上 monkeypatch 属性，然后用 `.pyi` 存根告诉类型检查器。失效点在于 monkeypatch 是**运行时**真的改了那个类，所有实例都受影响；而 declaration merging **只发生在类型层**，编译完什么都不剩——运行时 `ctx.config` 能不能读到，完全取决于那个插件装没装上。

### ③ `--resume` 搬进了 `sessionPlugin`

7.1 版里，`--resume` 的解析写在 `index.ts` 里——因为只有 CLI 入口支持续聊。

现在它在 `sessionPlugin` 里。为什么？**因为它是"会话"这件事的一部分，不是某个入口特有的。** headless 入口只是碰巧不传这个参数而已；将来如果要支持 `headless --resume <id> "接着干"`，什么都不用改。

判据：**一样东西该放在哪个插件里，看它属于哪个概念，不看目前是谁在用它。** 按"谁在用"分，你会得到一堆按调用方切开的碎片；按概念分，才得到能替换的部件。

## 一个被压住的问题

`loadAndRepair()` 里有一行值得说明：

```ts
// 同步 apply 里发不出 await，但下一个插件才会挂持久化，所以这个 promise
// 一定在第一次写之前完成——它俩之间没有任何 await。
void repairLog(logPath, loaded.committedBytes)
```

`apply` 是同步的，而 6.4 的截断修复是异步的。这里靠的是一个**时序论证**而不是 `await`：`persistencePlugin` 在下一层，它中间没有任何 `await`，所以那个截断在第一次写盘之前一定完成。

论证成立，但它**依赖了"下一个插件是谁"这个知识**——正是插件系统想消灭的那种知识。这是一处真实的债，记在这里：**阶段 8 的插件可以是异步的（dsh 的每个插件是一个 `Fiber`），那时这行会变回 `await`。**

（课程约定：这类"知道但还不能修"的地方要在代码里留标记，所以 `src/plugins.ts` 那段注释是刻意写长的。）

## 教 debug：三栏，三个问题

阶段 7 的诊断现在凑齐了三层：

```
root
  configPlugin   + config
    promptPlugin   + prompt
      …
```

| 看什么 | 回答什么 | 出自 |
|---|---|---|
| 树的形状 | **装了什么** | 7.1 |
| `+ xxx` | **每一层贡献了什么** | 7.2 |
| 最后一环读到的 | **装配的产物齐不齐** | 7.3 |

第三栏就是 `05-assembled.mjs` 开头那段：

```
  ctx.config       ✓
  ctx.prompt       ✓
  ctx.guards       ✓
  …
```

**任何一项是 ✗，就顺着树往上找是哪一层该提供它。** 三种可能：那个插件没在清单里（看树）、它提供了但名字写错了（看 `+`）、它在链条里排得太靠后（看缩进顺序——提供者必须在使用者上面）。

第三种最阴，因为它的表现是 `undefined` 而不是报错。把 `sessionPlugin` 和 `persistencePlugin` 在 `corePlugins` 里对调一下，就能当场看到：`persistencePlugin` 读 `ctx.session` 读到 `undefined`。**顺序错了不会报"顺序错了"，只会报某个属性不存在。**

## 对照 dsh

dsh 的应用装配长这样（`dsh/packages/bundle/base/cordis.patch.yml` 是真实的一份）：

```yaml
- name: './hello.ts'
```

| | 我们的 | dsh 的 | 哪个阶段补齐 |
|---|---|---|---|
| 清单在哪 | `corePlugins` 数组，写在代码里 | `cordis.yml`，loader 读它 | 阶段 11 |
| 顺序 | **手写的嵌套链** | 并发启动，顺序由 `inject` 决定 | 阶段 8 |
| 插件之间怎么互相用 | 原型链继承（只能父→子） | 服务挂在 `ctx.<key>`，对整棵树可见 | 阶段 8 |
| 插件能不能是异步的 | 不能（`apply` 同步） | 每个插件一个 `Fiber` | 阶段 8 |
| 装了什么能不能改 | 不能（没有卸载） | fiber 可 dispose，注册全部回收 | 阶段 9 |
| 入口文件 | 两行 `new Context()` + `plugin()` | **零行框架代码** | 阶段 11 |

两行已经很接近终点了。剩下那两行会在阶段 11 被 `cordis.yml` 吃掉。

## 这一课改了什么

| 文件 | 改动 |
|---|---|
| `src/plugins.ts` | **新增 83 行**：六个装配插件、`corePlugins` 清单、`Context` 的 declaration merging |
| `src/cordis.ts` | 新增 `nest()` |
| `src/index.ts` | 151 → 116 行：装配全部移走，只剩 readline 循环；最后两行是插件装载 |
| `src/headless.ts` | 68 → 47 行：同上 |
| `demos/07-cordis/fixtures/` | **新增**：7.1 版的两个入口，冻结成标本 |
| `demos/07-cordis/05-assembled.mjs` | 新增：装配树、前后体量、现在改几处 |

## 下一课

**7.4 阶段验收**：把 7.1–7.3 串起来，对照 `dsh/vendor/cordis/`，并把阶段 8 的痛点摆出来——`corePlugins` 那个手写的顺序，以及"插件必须知道下一个插件是谁"这件事。
