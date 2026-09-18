# 8.5 阶段验收

阶段 8 做完了一件事：**让插件之间能互相用，而且"谁要用谁"这件事被写进了代码，不再只存在于列表的顺序里。**

## 验收清单

```sh
# ① 兄弟可见、整棵树可见、重名抛错
npm run demo demos/08-services/01-provide.mjs
# guardsPlugin 读到 config.readOnly = true
# 服务重名：tools 已经被提供过了

# ② 真实装配：树变平了，服务表有七项
npm run demo demos/08-services/02-assembled-flat.mjs
# root → app → configPlugin / promptPlugin / guardsPlugin / sessionPlugin / …（平铺）

# ③ 最坏顺序照样装对；挂起诊断；循环依赖
npm run demo demos/08-services/03-inject.mjs
# 写下的顺序：loop → guards → session → config
# 实际装载顺序：session → config → guards → loop

# ④ 随机打乱 20 次
npm run demo demos/08-services/04-shuffled.mjs
# 20 次全部提供了同一组服务，一个插件都没挂住

# ⑤ 异步插件：等依赖、三轮串联、失败当场炸
npm run demo demos/08-services/05-async-plugins.mjs

# ⑥ 类插件、逆序收尾、构造窗口
npm run demo demos/08-services/06-service-class.mjs
# 注册顺序：a → b     dispose 顺序：B.dispose → A.dispose

# ⑦ 两个入口都还能跑，续聊照旧
npm run dev
node --import tsx src/headless.ts "读一下 README.md"
npm run dev -- --resume

# ⑧ 自己把 corePlugins 倒过来写，再跑 ④ —— 结果一样
# ⑨
npm run typecheck && npm run check
```

| 验收项 | |
|---|---|
| 能说出"继承"和"服务"在可见性上的区别 | ✓ |
| 知道服务表为什么故意让整棵树共享（7.2 那个坑在这里是工具） | ✓ |
| 知道为什么用 getter 而不是直接赋值 | ✓ |
| 知道服务重名为什么抛错而不是覆盖 | ✓ |
| 能说出 `inject` 保证什么、不保证什么 | ✓ |
| 知道挂起为什么不报错，以及循环依赖为什么不单独检测 | ✓ |
| 知道 `provide()` 的唤醒是**同步**的 | ✓ |
| 知道 `ready()` 为什么必须是循环 | ✓ |
| 知道装配为什么用 `Promise.all` 而不是 `allSettled` | ✓ |
| 知道类插件的判据是原型链而不是 `typeof` | ✓ |
| 知道 `super(ctx, name)` 之后到构造结束之间有一个窗口 | ✓ |
| 知道 `dispose` 为什么按逆序 | ✓ |
| 能说出什么时候**不**该用 `Service` 子类 | ✓ |

## 本阶段产出

| 文件 | 改动 |
|---|---|
| `src/cordis.ts` | 132 → **337 行**：服务表、`provide()`、`listServices()`、`inject` 与挂起队列、`install()`/`missing()`/`drain()`/`pendingPlugins()`、异步 `apply` 与 `ready()`、`Service` 基类与 `dispose()`；**删掉 `nest()`** |
| `src/plugins.ts` | 六个插件改用 `provide`、声明 `inject`、`sessionPlugin` 变 async、`persistencePlugin` 变 `PersistenceService` |
| `src/index.ts` / `src/headless.ts` | `assemble(leaf)` + `await root.ready()`；`close()` → `ctx.dispose()` |
| `demos/08-services/` | 6 个演示 |

被**删掉**的东西：

```ts
nest(...corePlugins, cli)                    // 7.3 出生，8.1 退休
void repairLog(logPath, loaded.committedBytes)   // 7.3 的债，8.3 还清
await ctx.persistence.close()                // 两个入口各一次，8.4 收回服务自己身上
```

三样都是**上一个阶段的过渡态**。它们的注释从第一天就写着"哪个阶段会变"——这一阶段兑现了三张支票。

## 一条主线：四节课在补同一条链

7.4 说过阶段 7 的主线没走完。阶段 8 走完了它，而且能看清这条链是怎么一节节接上的：

| 课 | 解放了什么 | 之前靠什么顶着 |
|---|---|---|
| 8.1 | **可见性**：兄弟能互相用 | `nest()` 把清单串成一条假的依赖链 |
| 8.2 | **顺序**：由依赖算出来 | 手写数组顺序，写错只报"属性不存在" |
| 8.3 | **异步**：装载中可以做 I/O | 一句关于"下一个插件是谁"的时序论证 |
| 8.4 | **收尾**：服务自己管 | 每个入口各记得调一次 `close()` |

四节课解放了四样东西，而**每一样在解放之前，都由一个"看起来能用"的权宜之计顶着**。这些权宜之计的共同点是：**它们都把某个约束藏在了代码结构里，而不是写成代码本身。**

- 嵌套的树形 = 藏起来的可见性需求
- 数组的顺序 = 藏起来的依赖关系
- "中间没有 await" = 藏起来的时序假设
- "记得调 close" = 藏起来的资源所有权

**这一阶段的全部工作，就是把这四件事从结构里挖出来，写成 `provide` / `inject` / `async` / `dispose`。**

## 工程思维总结

### ① 同一条语言规则，一次是坑，一次是工具

7.2 说"可变对象不能靠继承共享"，所以 `children` 每层必须有自己的一份。8.1 让 `services` 这个 Map **故意**被整棵树共享——用的是同一条规则，答案相反。

判据不是"该不该共享继承来的可变对象"，而是**"这个东西应该整棵树只有一份吗"**。问对了问题，两次的答案都是显然的。

> 一条规则被总结成"不要做 X"时，八成是把判据丢了。**找回那个判据，比记住那条禁令有用。**

### ② 约束要写成代码，不能藏在结构里

上面那张表里四条都是这个形状。最能说明问题的是 8.2：

```ts
// 藏在结构里
export const corePlugins = [configPlugin, promptPlugin, guardsPlugin, …]   // 顺序即约束

// 写成代码
inject: ['config']
```

差别不只是"更清楚"。写成代码之后：**工具能检查它**（挂起清单）、**它跟着插件走**（复制插件时约束一起被复制）、**错误信息能直接指向原因**（"还在等 config"而不是"属性不存在"）。

**判断一个约束有没有被真正表达出来，问一句：如果有人违反它，谁会告诉他？** 答案是"没人，直到运行时某处炸掉"，那它就还藏着。

### ③ 默认值要看那个情况正不正常

这一阶段出现了两个方向相反的默认值，放在一起看特别清楚：

| | 情况 | 默认 | 理由 |
|---|---|---|---|
| 6.4 `ignorable` | 读到不认识的事件 | **拒绝** | 这种情况一定是错的 |
| 8.2 挂起 | 依赖还没到 | **等待** | 这种情况经常是对的 |
| 8.1 重名 | 两个插件提供同一个服务 | **抛错** | 静默覆盖会让"谁在生效"变成考古题 |

三条用的是同一条判据，得出三个不同的答案。**不是"要宽容"或者"要严格"，是"这种情况正常吗"。**

### ④ 分不清的两种失败，就别假装分得清

8.2 的循环依赖：装载器看到 A 等 b、B 等 a，它**不能**断定这是环——`b` 可能由第三个还没装的插件提供。

所以它什么都不判断，只**如实记下谁在等谁**。

> 一个会误报的检测，比没有检测更糟：它会让人学会忽略告警。

这条和 6.4 的"能自动修的只有你自己会造成的那种坏"是同一个形状：**在信息不足以做判断的地方，把信息如实交出去，让能判断的人判断。**

### ⑤ "构造即注册"有一个窗口，而便利总有代价

`super(ctx, name)` 一行做三件事很方便，代价是从那一行返回到构造函数结束之间，**服务表里的那个名字指向一个半成品**。

dsh 用 `Service.init` 和 `check` 谓词来缩小这个窗口，但**窗口本身消不掉**——只要"注册"和"初始化完成"是两个时刻，中间就有缝。

**看到一个特别方便的 API 时，问一句：它把哪两件事合并了？合并处有没有缝？**

### ⑥ 退出路径和启动路径的取舍不一样

装配用 `Promise.all`——第一个错就炸，因为后面那些插件在一个不完整的应用上初始化没有意义。

收尾我们也用了"第一个错就中断"，而**这个取舍在退出路径上是可疑的**：一个日志服务关闭失败，不该让数据库连接漏掉。

**启动时"早失败"是对的，收尾时"尽力而为"往往才对。** 我们照搬了启动的做法，这是一处明确记下的欠账。

## 与 dsh 的差距

规模：我们 **337 行**（`cordis.ts`）对着 `dsh/vendor/cordis/src/` 的 **2693 行**。

| | 我们的 | dsh 的 | 哪个阶段补齐 |
|---|---|---|---|
| 服务存在哪 | 根上一个 Map + 根上的访问器 | `ReflectService` + ctx **Proxy** | 不复刻 |
| **卸载** | `dispose()`，**要有人记得调** | **注册即 effect**，fiber 卸载自动回收 | **阶段 9** |
| 依赖消失时 | 不管（服务不会消失） | 依赖它的插件**跟着卸载** | 阶段 9 |
| 可选依赖 | 没有 | `inject: { required, optional }` | 阶段 9 |
| 失败隔离 | 没有 | 失败的 fiber 单独标记 | 阶段 9 |
| 取消 | 没有 | fiber 持 `AbortSignal` | 阶段 9 |
| 等待的单位 | 整棵树一个 `ready()` | 每个插件一个可 await 的 fiber | 不复刻 |
| 服务隔离 | 没有 | `isolate()`，子树换实现 | 阶段 14 |
| 可用性谓词 | 没有 | `check` | 阶段 14 |
| 名字/类型校验 | `string` + `unknown` | `keyof this` + `this[K]` | 阶段 9 顺带 |
| 可调用的服务 | 没有 | `[Service.invoke]` | 不复刻 |
| 配置合并 | 没有 | `[Service.resolveConfig]` + `intercept()` | 阶段 11 |

**五行指向阶段 9**——这不是巧合：它们其实是同一件事的五个侧面，而那件事叫"可逆"。

### dsh 里的服务长什么样

我们那段 `declare module` 在 dsh 里是同一个形状，只是散在各个包里：

```ts
// dsh/packages/core/tools/src/index.ts
interface Context {
  tools: ToolRuntime
}

// dsh/packages/core/session/src/index.ts
interface Context {
  sessions: SessionStore
}
```

**每个包在自己的文件里往 `Context` 上加一行。** `vendor/cordis` 从头到尾不知道有 `tools`、`sessions` 这些东西——这正是 7.3 讲 declaration merging 时说的那个方向。

值得注意的是，这两处 `interface Context` 的**紧邻下方都跟着一个 `interface Events`**：

```ts
interface Events {
  /** Allow, deny, or ask before dispatch. `next()` delegates to allow; … */
```

那是阶段 10 的内容。**一个包声明的不只是"我提供什么服务"，还有"我发什么事件、别人能在哪里插进来"**——服务是"能调用什么"，事件是"能改变什么"。

## 本阶段的 debug 手法

| 手法 | 回答什么问题 | 哪一课 |
|---|---|---|
| `ctx.listServices()` | **提供了什么**——读到 undefined 时的第一问 | 8.1 |
| `ctx.pendingPlugins()` | **谁还在等什么**——"我的插件没跑"一句话有答案 | 8.2 |
| 给 `inflight` 的 promise 加计时器 | **装配卡在哪个插件** | 8.3 |
| 在每个 `dispose` 里打一行 | **收尾跑没跑、顺序对不对** | 8.4 |

诊断路径现在很短。**读到 `undefined`**：服务表里有吗？没有 → 提供者没装上（看挂起清单）或名字写错；有 → **你忘了写进 `inject`**。

对比阶段 7 那三栏（树 / 贡献 / 产物齐不齐）：那时要靠位置和缩进推理，现在两句话直接给出答案。**把约束显式化之后，诊断也跟着变短了——这不是巧合，它们是同一件事的两面。**

## 下一阶段的痛点预告

阶段 8 让插件能互相用了。但**装上去的东西，还没有一样能真正撤下来**。

`Service.dispose()` 只是个开头，它有三个洞：

**① 要有人记得调。** 8.4 只是把"每个入口记得调 close"变成了"每个入口记得调 dispose"——重复少了一处，**性质没变**。真正的答案是：**服务是在某个插件里注册的，那个插件被卸载时，它注册过的一切自动回收**，谁都不用记得。

**② 只管服务，不管别的注册。** 一个插件除了 provide 服务，还会：往 `PromptRegistry` 里 `register` 一段、往 `Session` 上 `on` 一个监听器、起一个 `setInterval`、开一个子进程、建一个临时文件。**这些一样都收不回来。**

回头看 5.1 和 6.1 埋下的伏笔——那两处的 `register()` 和 `on()` **都返回了注销函数**，而我们一次都没用过：

```ts
context(section: PromptContext): () => void { … }    // 5.1，返回注销函数
on(listener: SessionListener): () => void { … }      // 6.1，返回取消订阅
```

**那两个返回值从第一天起就在等阶段 9。**

**③ 没有"卸载"这个动作。** `ctx.dispose()` 是把**整棵树**收掉，不是卸载**某一个插件**。而 HMR（改一个文件，只重载相关的那几个插件）要的恰恰是后者。

**阶段 9：可逆注册。** `ctx.effect()` 把"申请资源"和"归还资源"绑成一个不可分割的动作；插件卸载时，它注册过的一切按逆序自动回收；一个服务被撤销时，依赖它的插件跟着卸载。dsh 那条硬规矩——**"Registrations are effects: every contribution goes through `ctx.effect()` / `ctx.on()`, and a registry's `register()` returns the disposer"**——到那时才真正成立。
