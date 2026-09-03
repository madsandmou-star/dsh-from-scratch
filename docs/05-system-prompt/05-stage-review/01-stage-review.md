# 5.5 阶段 5 验收

> 本课目标：把 system prompt 这件事串一遍——它从配置里一个字符串常量，长成了一个有注册表、变量、动态上下文、具名槽位和整体替换的小系统。并回答攒了四节课的问题：dsh 为什么把组装做成一个 **waterfall**。

## 验收清单

```sh
# ① 看模型到底收到了什么
DSH_SHOW_PROMPT=1 npm run dev
# [system prompt inventory]
#    -100  harness:identity  (118 ch)
#       0  deployment:persona  (28 ch)
#     100  tools:guidance  (214 ch)
#     110  guard:read-only  (0 ch)  ← 未生效

# ② 注册表的五种情况
npm run demo demos/05-system-prompt/01-assembly.mjs
# 重名抛错、注销恢复、空段落被丢掉

# ③ 只读模式那句话现在在模型**决定之前**就到了
npm run demo demos/05-system-prompt/02-model-sees-it.mjs

# ④ 插值的八种情况
npm run demo demos/05-system-prompt/03-variables.mjs
# ❌ 引用了未注册的变量 "{{cdw}}"。已注册的变量：cwd
# ✅ 工作目录是 /tmp/{{secret}}。      ← 值不会被二次展开

# ⑤ 每段自己取值 vs 注册成变量
npm run demo demos/05-system-prompt/04-variables-pain.mjs
# [spawn 了 2 次 git] → [spawn 了 1 次 git]

# ⑥ 动态上下文的位置与自我取代
npm run demo demos/05-system-prompt/05-runtime-context.mjs
npm run demo demos/05-system-prompt/06-why-not-system-prompt.mjs
# 两个 step 的 system prompt 一样吗？ ★ 一样，缓存前缀完整

# ⑦ 具名槽位与完整 prompt
npm run demo demos/05-system-prompt/07-complete-and-slots.mjs
# ❌ 同时有多段声明了"complete"：deployment:persona、tools:guidance

# ⑧⑨
npm run typecheck && npm run check
```

| 验收项 | |
|---|---|
| 知道为什么工具描述里不该提别的工具 | ✓ |
| 知道"提示是引导，护栏是保证"，两个都要 | ✓ |
| 知道为什么插值不用一行正则 | ✓ |
| 知道替换进去的值为什么不能再扫描 | ✓ |
| 能说出动态上下文不进 system prompt 的三条理由 | ✓ |
| 知道"状态消失"要显式广播 | ✓ |
| 知道具名槽位靠的是导出常量，不是巧合 | ✓ |
| 知道"记在旁边的变量会和真相对不上" | ✓ |

## 本阶段产出

```
src/system-prompt.ts   # 新增：302 line——registry + variable + interpolate + 动态上下文 + 槽位
src/tool.ts            # 改：工具描述瘦身，多出一个 toolGuidanceSection
src/guard.ts           # 改：只读模式多出一个提示段
src/config.ts          # 改：DSH_LEARN_CONFIG（5.2 演示要用）
src/index.ts           # 改：装配注册表、registerVariables、每步追加上下文快照
demos/05-system-prompt/ # 新增：七个演示
```

`src/` 现在 1670 行。**这一个阶段涨了近 400 行，而 agent 的能力一个都没增加**——它还是那六个工具、那一个循环。

这不是浪费。**这 400 行买到的是"谁能对模型说话"这件事的秩序**：五节课之前，那句话要么写死在配置里，要么塞在某个工具的描述里，要么只有出错时才说得出口。

## 一条主线：五节课在解同一个问题

| 课 | 问题 | 答案 |
|---|---|---|
| 5.1 | 一句话该归谁 | 描述回答"这个工具是什么"，system prompt 回答"这套装配下该怎么干活" |
| 5.2 | 值只有运行时才知道 | 段落退回纯文本，值注册成变量，组装时统一替换 |
| 5.3 | 值**每轮都在变** | 那它就不该在 system prompt 里，改成会自我取代的 user 消息 |
| 5.4 | 有人想换掉整段，甚至换掉全部 | 具名槽位 + `complete` 标记 |

**五节课的顺序不是随便排的，是同一条问题链上的四次分叉。** 每一次都是先发现"现在这个位置放不下这句话"，再造一个能放下它的位置。

## 为什么组装是 waterfall

我们的 `assemble()` 是一个函数：进去是注册表，出来是字符串，中间没有第三方插手的余地。

dsh 的组装最后一步是一个 waterfall 事件：

```ts
const transformed = await this.ctx.waterfall(
  scopeTarget(this, scope), 'system-prompt/assemble', assembly, context,
  () => Promise.resolve(assembly),
)
```

**任何插件都可以在这里改写整个 `PromptAssembly`**——段落、动态上下文、工具列表、变量表，四样都能动。

这买到了什么？看一个真实的监听器，`dsh/packages/core/agent/src/model-selection.ts`：

```ts
agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
  const selected = selection.current
  const assembled = await next()          // ← 先让别人都组装完
  selection.assembled = selected          // ← 记下这次用的到底是哪个模型
  if (selected === undefined) return assembled
  return {
    ...assembled,
    variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
  }
})
```

它在干一件我们的注册表做不到的事：**会话中途换了模型时，把 `{{model}}` 和 `{{provider}}` 这两个变量的值在最后一刻改掉**。

为什么必须在最后一刻？因为 `{{model}}` 这个变量是 **agent-loop 注册的**（`ctx.systemPrompt.variable('model', ...)`），而"用户刚才切了模型"这件事是 **model-selection 知道的**。两个插件，一个拥有变量，一个拥有事实。

三条路可以选：

| 做法 | 问题 |
|---|---|
| 让 agent-loop 去问 model-selection | agent-loop 得知道有这么个插件——**核心依赖了一个可选功能** |
| 让 model-selection 去覆盖那个变量的注册 | 那是 5.4 的"替换"，但它要求两边约好名字，而且是破坏性的 |
| **在组装的最后改写结果** | 拥有事实的那一方，在不认识拥有变量的那一方的前提下，修正了结果 |

**waterfall 让"谁拥有事实"和"谁拥有位置"可以是两个互不认识的插件。**

还有一个细节值得看：`await next()` 在**前面**。这个监听器先让整条链跑完，拿到最终结果，再改。这就是 waterfall 和普通事件的区别——**每个监听器都握着"继续往下"这个动作本身**，所以它可以选择在前面干活、在后面干活、或者干脆不往下传（4.4 的执行前钩子就是不往下传的那种）。

顺带看那两行配对：

```ts
selection.assembled = selected     // 组装时记下
...
const disposeRequest = agentCtx.on('agent/request', ...)   // 发请求时用同一个值
```

注释解释得很清楚：**并发的模型切换要在下一个 step 生效，而不是把两个面（prompt 里写的模型、请求里用的模型）劈成两半。** 如果只改 prompt 不改请求，模型会读到"你正在以 A 运行"，而实际跑它的是 B。

> **同一个事实出现在两个地方时，必须有一个动作把两个地方一起更新。** 这条和 5.3 那个"记在旁边的变量"是同一类问题的两个面。

## 工程思维总结

### 1. 一句话放在哪里，取决于它随谁生灭

5.1 那个划分之所以站得住，不是因为"system prompt 更重要"，而是因为：**工具被隐藏时它的描述跟着消失，而装配规则不该跟着消失。**

同一个判据在 5.3 又用了一次：`{{cwd}}` 随会话生灭（放 system prompt），`现在几点` 随每一步生灭（放动态上下文）。

**问"这条信息什么时候失效"，答案就是它该待的地方。**

### 2. 静默失败要换成三条不同的错

5.2 那张表是这条的完整形态：一行正则能跑，但它把三种截然不同的问题压成同一个静默结果。

**判断一个错误处理够不够好，看它能不能让读者知道下一步该干什么。** 这条从 4.1 的 `edit` 一直贯穿到这里，读者从模型换成了写代码的人，规矩没变。

### 3. 别让数据变成代码

这门课第三次遇到：

| 课 | 外部输入 | 进入的语法环境 | 防法 |
|---|---|---|---|
| 4.3 | 模型给的 pattern | shell | 不引入 shell |
| 4.3 | glob 里的 `.` | 正则 | 转义 |
| 5.2 | 变量的值 | `{{}}` 模板 | 替换后不再扫描 |

**每次外部输入进入一个有语法的地方，就问一遍。** 三次的答案都不一样（避开、转义、不递归），但问题是同一个。

### 4. 认定一个权威来源，其余全部推导

5.3 那个 `lastSentSnapshot` 变量是这条的反面教材：它和 `messages` 数组说的是同一件事，于是必然会有对不上的那一天（回滚就是）。

dsh 从 `session/event` 推导它。**一份记在旁边的状态，迟早会和真相对不上。**

阶段 6 会把这条推到底：那时候连 `messages` 数组本身都会退位，让给一个只增不改的事件日志。

### 5. 两种意图，两个名字

5.4 的 `register` vs `replace`：同一个动作，一个是"我不知道有人占了"，一个是"我就是要换掉它"。

**当一个 API 的行为取决于调用者知不知道自己在做什么时，拆成两个名字，而不是加一个 `force` 参数。**

## 阶段 5 学了什么

| 课 | 你现在应该能回答 |
|---|---|
| **5.1** | 一句话该归工具描述还是 system prompt；为什么重名要抛错；为什么 order 用带间隔的数字；提示和护栏的分工 |
| **5.2** | 为什么段落必须能是纯文本；插值为什么不用一行正则；未注册和没取到值为什么是两种错；替换值为什么不能再扫描 |
| **5.3** | 动态上下文不进 system prompt 的三条理由；为什么只能是 user role；"取代之前的"和"已清空"各自在防什么 |
| **5.4** | 具名槽位为什么靠导出常量；`complete` 换掉的是什么、没换掉什么；为什么两段冲突要拒绝启动 |
| **5.5** | waterfall 让"谁拥有事实"和"谁拥有位置"可以是两个互不认识的插件 |

## 下一阶段的痛点预告

按 Ctrl-C，然后重新 `npm run dev`。

**一切都没了。** 刚才那二十轮对话、模型读过的文件、跑过的命令、它总结出来的结论——全部随着进程一起消失。

这只是最表面的一层。真正的问题在这一阶段里已经露头三次了：

**① 5.3 那个变量。** `lastSentSnapshot` 和 `messages` 数组说的是同一件事，回滚时它们对不上。我打了个补丁，但补丁只堵住了我知道的那个洞。

**② 5.3 那条"它没落日志"。** 「模型可见 ⟺ 已落日志」这条规矩，我们到现在**一次都没兑现过**——`messages` 是一个内存数组，进程一死就没了，更谈不上"重建当时模型看到了什么"。

**③ 那个 `messages` 数组本身。** 它同时承担了三个角色：给模型发的请求内容、给用户显示的对话、以及"发生过什么"的记录。**三个角色被同一个可变数组承担，所以谁改了它，另外两个都跟着变。** 1.4 那个 `while (messages.length > 回滚点) messages.pop()` 就是在这个前提下才能存在的——它一次性抹掉了三样东西。

阶段 6 会把这三件事一起解决，用同一个东西：**一条只增不改的事件日志**。

- 发生的每件事追加一条事件（用户说话、模型回复、工具调用、工具结果）
- 发给模型的 `messages` 从日志**投影**出来，不再是权威
- 界面显示的内容也从日志投影出来
- "上次发了什么快照"从日志里查，不再记在旁边

代价是真实的：一个只能追加的日志，怎么表达"这条不算数了"？（5.3 那句"取代之前的快照"其实已经是这个问题的第一个答案。）以及——**日志什么时候真正落到磁盘上**，才能保证进程被 `kill -9` 之后不丢东西。

---

下一阶段：阶段 6 会话落盘（进入前先在 [COURSE.md](../../../COURSE.md) 细化小课）
