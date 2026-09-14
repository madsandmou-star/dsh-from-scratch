# 7.1 第二个入口把装配抄了一遍

阶段 6 的验收里我说 `src/index.ts` 有三个问题，但都"还没疼到不能忍"。这一课把第一个疼**做出来**。

## 痛点：写第二个入口

dsh 有一个 headless profile：`pnpm dsh --profile headless "task"`——跑一个任务就退出，不进交互循环。CI、脚本、subagent 都用它。

我们也写一个。`src/headless.ts`，已经在仓库里了：

```sh
node --import tsx src/headless.ts "把 a.txt 抄到 b.txt"
```

它和 `index.ts` 的差别只有两处：没有 readline 循环，不支持 `--resume`。**但它的上半截是一字不差抄过来的。**

不靠感觉，数出来：

```sh
node --import tsx demos/07-cordis/02-duplicated-assembly.mjs
```

```
=== 两个入口的装配段 ===
  src/index.ts      49 行有效代码
  src/headless.ts   21 行有效代码
  **完全一样的**     17 行  （占 headless 的 81%）

=== 一字不差抄过来的那些 ===
  const config = loadConfig()
  const guards = [accounting(config.accounting), readOnlyGuard(config.readOnly), outputBackstop()]
  const prompt = new PromptRegistry()
  prompt.variable('cwd', () => process.cwd())
  prompt.variable('model', () => config.model)
  prompt.register(identitySection)
  prompt.register({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: config.systemPrompt })
  prompt.register(toolGuidanceSection)
  prompt.register(readOnlyNotice(config.readOnly))
  prompt.context({ name: 'time', order: 0, text: () => `现在是 ${new Date().toISOString()}。` })
  const SESSION_ROOT = join(process.cwd(), '.dsh-learn', 'sessions')
  const logPath = sessionLogPath(SESSION_ROOT, sessionId)
```

### 具体到"加一个功能要改几处"

| 改动 | 要改几处 |
|---|---|
| 加第七个工具 | 1 处（`tool.ts` 的数组，两个入口都自动拿到） |
| **加一道护栏** | **2 处**（两个 `guards` 数组各一次） |
| **加一段 system prompt** | **2 处**（两处 `prompt.register()` 各一次） |
| **改会话存放位置** | **2 处**（两处 `SESSION_ROOT`） |

再加一个 ACP server 入口、一个 JSON-RPC 入口（dsh 都有），就是 4 处、5 处。

**漏改一处的表现是"某个入口少了一个功能"**——不报错，不崩溃，只是那个入口的 agent 行为和另一个不一样。这是最难查的一类 bug：你在 CLI 里测得好好的，CI 里跑出来结果不对，而两边"代码是一样的"。

### 为什么抽个函数解决不了

你的第一反应大概是：把那 17 行抽成 `function assemble() { … }`，两个入口都调它。

这解决了**重复**，但没解决**耦合**。那个函数仍然必须 import 每一个部件、知道每一个部件的初始化顺序：

```ts
function assemble() {
  const config = loadConfig()
  const guards = [accounting(…), readOnlyGuard(…), outputBackstop()]   // 认识所有护栏
  const prompt = new PromptRegistry()
  prompt.register(identitySection)                                     // 认识所有 prompt 段落
  prompt.register(toolGuidanceSection)
  const session = new Session()
  const persistence = attachJsonlPersistence(session, …)               // 认识持久化
  return { config, guards, prompt, session, persistence }
}
```

问题一个都没走：**加一个功能还是要改这个文件**。而且它还多了一个新问题——返回值里要塞进每个部件，这个返回类型会随功能数量一直长大。

dsh 有两百多个包。不可能有一个函数认识它们全部。

> 真正要解决的不是"代码重复"，是**"入口必须认识每一个部件"这个方向**。

## 解法：一句话和一张图

**一句话：把方向倒过来——不是入口去认识部件，而是每个部件自己声明"我要往这个应用里加什么"，入口只负责列出要装哪些。**

那个自己声明的东西叫**插件**：

```ts
function 某个插件(ctx, config) {
  // 用 ctx 把自己的贡献加进去
}
```

应用就是**一棵插件树**：入口装几个插件，插件自己再装子插件。

### 改前 / 改后

```
改前：入口认识所有部件
                  ┌─→ loadConfig()
   index.ts ──────┼─→ new PromptRegistry() + 4 次 register
   headless.ts ───┼─→ [accounting, readOnlyGuard, outputBackstop]
   （各抄一遍）     └─→ new Session() + attachJsonlPersistence()

改后：部件自己声明，入口只列清单
   index.ts ────→ ctx.plugin(configPlugin)
                  ctx.plugin(promptPlugin)      ← 每个插件自己知道要 register 什么
                  ctx.plugin(guardsPlugin)
                  ctx.plugin(sessionPlugin)
   headless.ts ─→ （同一份清单）
```

**这一课只做左边那半**：定义"插件是什么"和"插件树怎么长"。真正把 `index.ts` 拆掉是 7.3——因为还缺一样东西：插件之间怎么互相拿到对方的产出（那是阶段 8 的服务）。

### 一屏看完的完整实现

`src/cordis.ts`，全部代码：

```ts
export class Context {
  /** 这个 context 属于哪个插件。只用于诊断输出，不参与任何逻辑。 */
  readonly name: string
  readonly parent: Context | undefined
  private readonly children: Context[] = []

  constructor(name = 'root', parent?: Context) {
    this.name = name
    this.parent = parent
  }

  plugin<T>(plugin: Plugin<T>, config?: T): void {
    const apply = typeof plugin === 'function' ? plugin : plugin.apply
    if (typeof apply !== 'function') {
      throw new Error(`不是一个插件：需要函数或带 apply 方法的对象，收到 ${typeof plugin}`)
    }
    const name = (typeof plugin === 'function' ? plugin.name : plugin.name ?? plugin.apply.name) || '(匿名)'
    const child = new Context(name, this)          // ① 造一个子 context
    this.children.push(child)                      // ② 记进插件树
    apply(child, config as T)                      // ③ 调它的 apply
  }

  /** 把这棵插件树画成文本。装配出了问题，先看看到底装了什么。 */
  inspect(indent = ''): string {
    const lines = [`${indent}${this.name}`]
    for (const child of this.children) lines.push(child.inspect(`${indent}  `))
    return lines.join('\n')
  }
}

export type Plugin<T = unknown> =
  | ((ctx: Context, config: T) => void)
  | { name?: string, apply: (ctx: Context, config: T) => void }
```

**`plugin()` 就三行**：造子 context、记进树、调 apply。这一课的全部机制就是这三行。

### 用起来是几行

```ts
const root = new Context()

function hello(ctx) { console.log('hello') }

const greeter = {
  name: 'greeter',
  apply(ctx, config) {
    console.log(`配置是 ${JSON.stringify(config)}`)
    ctx.plugin(hello)          // 插件里可以装子插件——树就是这么长出来的
  },
}

root.plugin(greeter, { tone: 'friendly' })
```

### 产出长什么样

```sh
node --import tsx demos/07-cordis/01-first-plugin.mjs
```

```
=== 装载顺序（apply 是同步调用的）===
  assembly 说：我来组装
  greeter 说：我的配置是 {"tone":"friendly"}
  hello 说：我被装上了
  noisy 说：只有 verbose 时才有我
  hello 说：我被装上了

=== 插件树 ===
root
  assembly
    greeter
      hello
    noisy
  hello

=== 装配失败当场炸，不是"这一项被跳过了" ===
  捕获：这个插件自己炸了
  捕获：不是一个插件：需要函数或带 apply 方法的对象，收到 object
```

## 三个不那么显然的点

### ① 插件不是"一个类"，是一个函数

没有基类要继承，没有装饰器要贴，没有全局注册表要登记。**一个接受 `ctx` 的函数就是插件。**

这条便宜得可疑，但它买到一样东西：**任何已有的函数都可以变成插件**，只要它愿意接受一个 `ctx`。反过来，如果插件必须 `extends PluginBase`，那么框架就侵入了每一个部件的类型。

dsh 的 Cordis 接受三种形态（`dsh/docs/cordis-tutorial/01-first-plugin.md`）：

```ts
// 1. 函数插件
export function apply(ctx: Context) {}

// 2. 对象插件：一个带 apply 方法的对象
export const objectPlugin = { name: 'object-plugin', apply(ctx: Context) {} }

// 3. 类插件：一个 Service 子类（阶段 8 讲）
export class MyService extends Service { … }
```

教程里那句建议值得照抄：

> 在你需要公开服务之前，请一直使用函数形态。

对象形态多的那个 `name` 不是装饰：**函数名会被打包工具改掉**，而插件名要出现在诊断输出里。想让插件树在压缩后的产物里还认得出人，就得显式写 `name`。

### ② 树是"装出来的"，不是声明出来的

没有任何地方写着"greeter 的父节点是 assembly"。父子关系来自一个事实：**assembly 在自己的 `apply` 里调了 `ctx.plugin(greeter)`，而它调用的 `ctx` 是 assembly 自己那一个**。

这就是为什么 `plugin()` 要给每个插件**造一个新的 context** 而不是把自己传下去。如果传的是同一个 `root`，那 `greeter` 装的 `hello` 就会挂在 `root` 下面，树就塌成一层了。

**"谁装的谁"这个信息，就存在于 context 的父子关系里。** 7.2 会讲这件事的全部重量：它决定了卸载的时候该收谁的东西。

### ③ 装配失败必须当场炸

```ts
apply(child, config as T)      // 不 try/catch
```

一个插件的 `apply` 抛异常，整个进程终止。dsh 的教程第一章专门演示了这一点，并且点出了一个例外：

> 如果某个配置项的模块无法被**解析**（路径或包名拼错），Cordis 会通过 logger 报告错误，而不会使进程崩溃。……**如果新增配置项似乎没有任何效果，请先检查拼写。**

这个例外本身就是一个教训：**它是启动期唯一"安静失败"的地方，也因此是最容易踩的坑**——教程不得不专门警告读者。

启动期的错误必须吵。"跳过这一项"的代价是你在半夜排查"为什么这个功能没生效"，而那时早就没有现场了。

> 这条和 6.4 的 `ignorable` 是同一个判断：**默认值要选在出错时代价小的那一边。** 装不上就崩，比装不上却继续跑便宜得多。

## 教 debug：先看插件树

```ts
console.log(root.inspect())
```

```
root
  assembly
    greeter
      hello
    noisy
  hello
```

这是整个阶段 7 最有用的一条：**装配出了问题，先看看到底装了什么。**

三种典型症状，三种读法：

**某个功能完全没生效** → 树里有没有它？没有就是**根本没装上**（配置里拼错了名字、条件分支没走到），不是它的逻辑有 bug。直接去看装它的那一行。

**同一个插件出现了两次** → 被装了两遍。在我们这个迷你版里它就真的跑两遍（看上面那个 `hello`，它在树里出现了两次，也确实打了两行）。dsh 里同一个插件可以被合法地装多次（不同配置），所以这不一定是错——但**你得先看见它**才能判断。

**顺序不对** → 我们这一版是同步、深度优先、按 `ctx.plugin()` 的书写顺序。dsh 不是：它的配置项**并发启动**，顺序由服务依赖（`inject`）决定，不由书写位置决定。这是阶段 8 的内容，但现在就要记住：**在真 Cordis 里靠书写顺序来保证初始化顺序，是错的。**

## 对照 dsh

`dsh/vendor/cordis/src/` 一共 2693 行，我们这一版 80 行。差在哪：

| | 我们的 | dsh 的 | 哪个阶段补齐 |
|---|---|---|---|
| 插件形态 | 函数 / 对象 | 函数 / 对象 / `Service` 子类 | 阶段 8 |
| ctx 是什么 | 一个普通对象 | 一个 **Proxy**，属性读取走服务解析器 | 阶段 8 |
| 子 context | `new Context(name, this)` | `extend()`，**原型链继承**父的一切 | 7.2 |
| 装载 | 同步，深度优先 | 每个插件一个 `Fiber`，**并发启动**，顺序由 `inject` 决定 | 阶段 8 |
| 卸载 | 没有 | `ctx.plugin()` 返回的 fiber 可以 dispose，注册全部回收 | 阶段 9 |
| 配置 | 原样传给 `apply` | `Config` schema 校验 + `intercept()` 分层合并 | 阶段 11 |
| 应用怎么组合 | 代码里写 `ctx.plugin(...)` | **一个 `cordis.yml`**，loader 读它 | 阶段 11 |

最后一行是终点的样子。dsh 的应用装配长这样（`dsh/packages/bundle/base/cordis.patch.yml`）：

```yaml
- name: './hello.ts'
```

**入口文件里一行框架代码都没有**——插件描述自己的贡献，`cordis.yml` 组合应用。教程原话：

> 你的文件中没有框架启动代码：插件描述自己的贡献，`cordis.yml` 则组合应用。

我们现在离那儿还有四个阶段，但方向已经定了。

## 这一课改了什么

| 文件 | 改动 |
|---|---|
| `src/headless.ts` | **新增**：第二个入口，装配段落是从 `index.ts` 抄的（带 `XXX(阶段 7.3)` 标记） |
| `src/cordis.ts` | **新增**：迷你 `Context`、`plugin()`、`inspect()`、`Plugin` 类型 |
| `demos/07-cordis/01-first-plugin.mjs` | 新增：三种形态、插件树、两种装配失败 |
| `demos/07-cordis/02-duplicated-assembly.mjs` | 新增：数出两个入口重了多少行 |
| `demos/harness.mjs` | 支持 `entry` 选项（要能跑 `headless.ts`） |

`src/headless.ts` 是**故意留着不改的**。它现在是这个阶段的痛点标本，7.3 会把它缩到十几行——那时再回来看这个文件的 diff，就是这个阶段的全部价值。

## 下一课的痛点

我们的 `plugin()` 给每个插件造了一个**新的空 context**：

```ts
const child = new Context(name, this)
```

它除了名字和父指针什么都没有。那么问题来了：**插件怎么用到父 context 上的东西？**

如果答案是"把父对象整个传下去"，那子 context 就没有意义了；如果答案是"每个插件自己造"，那就退回到了 import 具体实现。

**7.2 讲 `extend()`**：子 context **原型链继承**父的一切，自己的属性遮住继承来的，而且**父一个字节都不变**。这一个选择同时解决了"看得见"和"改不到"两件事。
