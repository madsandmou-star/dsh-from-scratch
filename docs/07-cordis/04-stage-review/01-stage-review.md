# 7.4 阶段验收

阶段 7 做完了一件事：**把"入口必须认识每一个部件"这个方向倒过来——部件自己声明贡献，入口只列清单。**

## 验收清单

```sh
# ① 插件与插件树：三种形态、装配失败当场炸
npm run demo demos/07-cordis/01-first-plugin.mjs
# root
#   assembly
#     greeter
#       hello

# ② 痛点度量（读的是 fixtures/ 里冻结的 7.1 版）
npm run demo demos/07-cordis/02-duplicated-assembly.mjs
# **完全一样的** 17 行（占 headless 的 81%）

# ③ 子 context 的三个性质 + 两个坑
npm run demo demos/07-cordis/03-extend.mjs
# ② 遮得住：自有属性：["logger"]
# ④ 但"改不到"只对重新赋值成立：父看到的 readOnly = true ← 被改了！
# ⑤ 继承是活的：之后 captured.tools = ["read","write"] ← 看得见

# ④ 树 + 每层贡献；兄弟互不相见
npm run demo demos/07-cordis/04-who-added-what.mjs
# TypeError: Cannot read properties of undefined (reading 'readOnly')

# ⑤ 重构之后：装配树、前后体量、现在改几处
npm run demo demos/07-cordis/05-assembled.mjs
# root → configPlugin → promptPlugin → guardsPlugin → sessionPlugin → persistencePlugin → cli
# src/index.ts 151 行 → 116 行

# ⑥ 两个入口都还能跑
npm run dev                                        # 交互
node --import tsx src/headless.ts "读一下 README.md"  # 一次性任务
npm run dev -- --resume                            # 续聊照旧

# ⑦ 故意把顺序改错，看它怎么报
#    把 corePlugins 里 sessionPlugin 和 persistencePlugin 对调，再跑 ⑤
#    → TypeError: Cannot read properties of undefined (reading 'events')

# ⑧
npm run typecheck && npm run check
```

| 验收项 | |
|---|---|
| 能说出"抽一个 assemble() 函数"为什么不够 | ✓ |
| 知道插件就是一个 `apply(ctx, config)` 函数，没有基类 | ✓ |
| 知道插件树是**装出来的**，父子关系存在于"拿到的是哪个 ctx"里 | ✓ |
| 知道装配失败为什么必须当场炸 | ✓ |
| 能说出"复制父的属性"为什么不行（继承是活的） | ✓ |
| 知道 `ctx.config.x = 1` 和 `ctx.config = {...}` 的区别 | ✓ |
| 知道可变对象为什么不能靠继承共享 | ✓ |
| 能说出兄弟插件为什么互相看不见 | ✓ |
| 知道 `nest()` 那条嵌套链是过渡态，以及它在替代什么 | ✓ |
| 知道 declaration merging 让插件自己声明贡献，核心文件不用改 | ✓ |
| 会用三栏诊断：树 / `+ 贡献` / 最后一环读到的 | ✓ |

## 本阶段产出

| 文件 | 改动 |
|---|---|
| `src/cordis.ts` | **新增 132 行**：`Context`、`plugin()`、`extend()`、`inspect()`、`ownKeys()`、`nest()`、`Plugin` 类型 |
| `src/plugins.ts` | **新增 156 行**：六个装配插件、`corePlugins`、`Context` 的 declaration merging |
| `src/index.ts` | 装配全部移走；最后两行是插件装载 |
| `src/headless.ts` | **新增**：第二个入口。7.1 写成抄的，7.3 缩成 47 行 |
| `demos/07-cordis/` | 5 个演示 + `fixtures/` 里冻结的 7.1 版两个入口 |

**`src/` 从 2408 行长到 2891 行**，多出来的大半是新增的第二个入口和插件系统本身。这个阶段没有让代码变少——它让**加下一个功能要改的地方**变少了。

## 一条主线：三节课在拆同一个方向

| 课 | 这一步做什么 | 拆掉了什么 |
|---|---|---|
| 7.1 | 插件 = `apply(ctx)`，应用 = 一棵插件树 | "入口必须 import 每一个部件" |
| 7.2 | 子 context 原型链继承父 | "插件要用东西只能自己造" |
| 7.3 | 装配拆成六个插件，两个入口共用 | "加一个功能要改 N 处" |

**三步合起来才换来一件事**：`加一道护栏` 从改 2 处变成改 1 处，而且再加第三个入口它还是 1 处。

但这条主线**没走完**。7.3 那棵一路往右缩进的树就是证据：

```
root
  configPlugin   + config
    promptPlugin   + prompt
      guardsPlugin   + guards
        sessionPlugin   + sessionId, logPath, session
          persistencePlugin   + persistence
            cli
```

**这个形状是"我们还没有服务"在树上的样子。** 阶段 8 会把它拍平。

## 工程思维总结

### ① 要解决的常常不是重复，是方向

7.1 的第一反应是"抽个 `assemble()` 函数"。它消灭了重复，但那个函数仍然要 import 每一个部件、知道每一个部件的初始化顺序，**加一个功能还是要改它**。

判断一个重构够不够，看的不是"重复没了吗"，是**"下一个功能要改哪些文件"**。答案里如果还有一个"中心文件"，那这个重构只做了表面。

> 重复是症状，**依赖方向**才是病。

### ② 让部件声明自己，而不是让中心认识部件

这是整个插件架构的一句话。它有两个具体形态，这个阶段各出现了一次：

- **运行时**：`apply(ctx)` 里 `ctx.config = …`——插件自己往应用里加东西。
- **类型层**：`declare module './cordis.ts' { interface Context { config: … } }`——插件自己声明它加了什么。

两者方向一致，所以 `cordis.ts` 从头到尾不知道有 config、prompt、session 这些东西存在。**一个通用的机制，不该认识任何一个具体的用户。**

### ③ 原型链给的是绑定隔离，不是值隔离

7.2 那个演示里最该记住的是失败的那一条：

```ts
ctx.config = { ...ctx.config, readOnly: true }   // ✓ 父不受影响
ctx.config.readOnly = true                       // ✗ 父被改了
```

**继承共享的是引用。** 子改不了"`ctx.config` 指向谁"，但照样能改那个对象里面的东西。

这条对所有"继承/派生/覆盖"机制都成立——包括 Python 的类属性、React 的 context、环境变量的父子进程继承。**凡是"子能看见父"的机制，都要单独问一句：子能改到父的内部吗？**

### ④ 可变对象不能靠继承共享

`children: []` 那一行是这条的具体形态：忘了给，整棵树塌成一层。

判据很干脆：**这个属性会被原地修改吗？会的话，每一层都必须有自己的一份。** 函数、字符串、只读配置可以放心继承；数组、Map、Set 不行。

（JS 里这个坑最出名的版本是"把数组放在 `prototype` 上，所有实例共享它"。Python 里对应的是"可变的默认参数"和"可变的类属性"。）

### ⑤ 过渡态要留下标记，而不是假装没有

这个阶段留了两处**故意不修**的东西：

- `nest()` 那条嵌套链——它是"手写依赖顺序"的具象形式。
- `plugins.ts` 里那行 `void repairLog(...)`——它靠"下一个插件才挂持久化"这个时序论证成立，而这**正是插件系统想消灭的那种知识**。

两处都在代码注释里写清了"它为什么现在长这样、哪个阶段会变"。这不是拖延，是**让下一个读代码的人知道这里的丑陋是已知的、有期限的**。

> 代码里最危险的不是丑陋，是**看不出是有意还是失误的丑陋**。

### ⑥ 演进中的课程，需要冻结的标本

7.3 一改，7.1 那个"重了 17 行"的演示就变成 0 了。

解法是 `demos/07-cordis/fixtures/`：把 7.1 版的两个入口冻结成标本。7.1 的演示读标本，7.3 的演示读 `src/`。

这和 `dsh/` 被钉在固定 commit 是同一条理由：**对照面不能随着被对照的东西一起漂。**

## 与 dsh 的差距

规模：我们 **132 行**（`cordis.ts`）对着 `dsh/vendor/cordis/src/` 的 **2693 行**。

| | 我们的 | dsh 的 | 哪个阶段补齐 |
|---|---|---|---|
| 插件形态 | 函数 / 对象 | 函数 / 对象 / `Service` 子类 | 阶段 8 |
| ctx 是什么 | 普通对象 | **Proxy**，属性读取走 `ReflectService` 解析 | 阶段 8 |
| 派生子 context | `Object.create` + `Object.assign` | + `Reflect.ownKeys`（symbol 键）+ `defineProperty`（保住 getter） | 不补 |
| 插件之间怎么互相用 | 原型链，只能父→子 | 服务挂 `ctx.<key>`，**整棵树可见** | **阶段 8** |
| 装载 | 同步、深度优先、按书写顺序 | 每插件一个 `Fiber`，**并发**，顺序由 `inject` 算 | 阶段 8 |
| 插件能不能异步 | 不能 | 能 | 阶段 8 |
| 卸载 | 没有 | fiber 可 dispose，注册全部回收 | 阶段 9 |
| 服务隔离 | 没有 | `isolate()` | 阶段 14 |
| 分层配置 | 原样传给 `apply` | `Config` schema + `intercept()` | 阶段 11 |
| 事件 | 没有 | `ctx.on` / `emit` / `waterfall` 四种派发 | 阶段 10 |
| 日志 | 没有 | `ctx.logger(name)` | 不复刻（外围） |
| 应用怎么组合 | `corePlugins` 数组 | **`cordis.yml`**，loader 读它 | 阶段 11 |

对应源码位置：

- `dsh/vendor/cordis/src/context.ts` —— `Context`、`extend()`、`isolate()`、`intercept()`
- `dsh/vendor/cordis/src/registry.ts` —— `ctx.plugin()`、插件解析
- `dsh/vendor/cordis/src/fiber.ts` —— 每个插件的生命周期（754 行，阶段 8–9 的主场）
- `dsh/vendor/cordis/src/reflect.ts` —— ctx 那个 Proxy 的处理器
- `dsh/vendor/cordis/src/service.ts` —— `Service` 基类
- `dsh/vendor/cordis/src/events.ts` —— 四种事件派发
- `dsh/docs/cordis-tutorial/` —— dsh 自己的七章教程，从第一个插件讲到 HMR

## 本阶段的 debug 手法

| 手法 | 回答什么问题 | 哪一课 |
|---|---|---|
| `console.log(root.inspect())` | **装了什么**——功能没生效先看它在不在树里 | 7.1 |
| `ctx.ownKeys()` | **每一层贡献了什么**——读到 `undefined` 时顺着树往上数 | 7.2 |
| 最后一环逐项打勾 | **装配的产物齐不齐** | 7.3 |
| 把清单里两项对调再跑 | 验证"顺序错了只会报某个属性不存在" | 7.3 |

三栏一起看，三类问题各有归属：**不在树里** = 没装上；**在树里但没贡献那个属性** = 名字写错了；**贡献了但在兄弟节点上** = 继承够不着（阶段 8）。

## 下一阶段的痛点预告

阶段 7 换来的那棵树，本身就是下一个痛：

```ts
export const corePlugins = [
  configPlugin, promptPlugin, guardsPlugin, sessionPlugin, persistencePlugin,
] as const
```

**这个数组的顺序是手写的，而且写错了不会报"顺序错了"。**

三个具体的疼：

**① 顺序只存在于作者脑子里。** `persistencePlugin` 要在 `sessionPlugin` 后面——这条规则没有写在任何一个地方，它只是"数组里排在后面"这个事实。新人加一个插件，只能靠猜或者试。

**② 一个插件的位置由它的**所有**依赖决定。** 加一个既要读 `config` 又要读 `session` 的插件，你得同时满足两个约束。插件一多，这就是一道人肉拓扑排序题。

**③ 兄弟之间根本没法互相用。** 7.2 那个 `TypeError` 还在那里。我们靠嵌套绕开了它，代价是所有插件被串成一条线——**明明 `promptPlugin` 和 `guardsPlugin` 之间毫无关系，却因为串在一条链上而有了先后**。

**阶段 8 引入服务**：写在 `ctx.<名字>` 上的东西对**整棵树**可见，依赖用 `inject` 声明，装载顺序由依赖**算**出来。那时 `corePlugins` 里的顺序会变得无所谓，而 `nest()` 会退休。
