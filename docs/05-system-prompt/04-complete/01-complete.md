# 5.4 谁能替换整个 prompt

> 本课目标：让"换掉某一段"和"这一段就是全部"成为可能，并说清为什么这两件事需要两个不同的机制。

## 痛点：注册表只能往上加

到 5.3 为止，注册表只有一个动作：**加一段**。两个真实场景卡在这里。

### 场景一：subagent 不需要通用身份

阶段 19 会做 subagent——派一个子 agent 去干一件窄活，比如"把这个文件总结成三句话"。它拿到的 system prompt 现在是这样：

```
你是一个跑在命令行里的编码助手。你可以读写文件、执行命令、搜索代码。…
你在帮一个 Python 背景的人读 TypeScript 代码。

选工具的优先级：
- 读文件用 read（它带行号），不要用 `cat`。
- 改已有文件用 edit（唯一字面匹配）…
- 按内容找代码用 grep…
- bash 用来跑那些没有专门工具的事…
```

**它一个工具都不需要用，却读了四条选工具的规矩。** 这不只是浪费 token——**无关的指令会把模型往错的方向拽**：它读完会觉得自己应该去搜代码、去改文件，而它的任务只是总结。

### 场景二：想换掉 persona，只能报错

阶段 18 的 preset 要给某个 agent 换一个 persona。试一下：

```
=== ① 痛点：想换掉 persona，但只能"push" ===
  ❌ system prompt 段落重名：deployment:persona
```

5.1 那条"重名抛错"在这里挡住了路。**换个名字加一段呢？** 那模型会同时读到两个人设，而且都是"你是……"，它得自己猜听谁的。

**注意这两个场景要的是不同的东西**：场景二是"把 A 换成 B"，场景一是"只要 B，其余全丢掉"。用一个机制硬凑，会得到一个两边都别扭的 API。

## 解法：一句话和一张图

**加两个正交的东西：一个显式的"替换"动作（换掉具名槽位里的那一段），和段落上的一个 `complete` 标记（这一段就是全部）。**

```
只能加（5.3）：
  身份(-100) + persona(0) + 工具指引(100) + readOnly(110)  ──全部拼起来──→ system prompt

replace（换掉槽位里的内容，其余不动）：
  身份(-100) + 【新 persona】(0) + 工具指引(100) + readOnly(110)  ──全部拼起来──→ system prompt

complete（只留这一段，其余照样求值但不进 prompt）：
  身份(-100) + 【persona 带 complete:true】(0) + 工具指引(100)  ──只留中间那段──→ system prompt
```

### 全部代码，一眼看完

`replace` 只有六行：

```ts
replace(section: PromptSection): () => void {
  const previous = this.sections.get(section.name)
  if (previous === undefined) throw new Error(`没有名为 ${section.name} 的段落可替换（要新增请用 register）`)
  this.sections.set(section.name, section)
  return () => { this.sections.set(section.name, previous) }   // 注销 = 把原来那段放回去
}
```

`complete` 是组装时的一个分支：

```ts
assemble(): string {
  const values = this.resolveVariables()
  const ordered = [...this.sections.values()].sort((a, b) => a.order - b.order)

  // 两段都说"我是全部"是配置错误：没有任何规则能决定听谁的。
  const completeOnes = ordered.filter(section => section.complete === true)
  if (completeOnes.length > 1) throw new Error(`同时有多段声明了"complete"：${completeOnes.map(section => section.name).join('、')}`)

  // 注意变量照样插值：`complete` 换掉的是"哪些段进 prompt"，不是"要不要处理模板"。
  const onlyOne = completeOnes[0]
  if (onlyOne !== undefined) return this.renderSection(onlyOne, values)

  return ordered.map(section => this.renderSection(section, values)).filter(text => text !== '').join('\n\n')
}
```

外加一个和 `complete` **正交**的开关：

```ts
suppressContext(): () => void {
  this.contextSuppressed = true
  return () => { this.contextSuppressed = false }
}
```

以及一个导出的常量——它比上面所有代码都重要：

```ts
export const PERSONA_SECTION = 'deployment:persona'
export const PERSONA_ORDER = 0
```

### 用起来

换掉 persona：

```ts
const restore = prompt.replace({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: '你在帮一个前端工程师读后端代码。' })
```

一个最小的 subagent：

```ts
prompt.replace({ name: PERSONA_SECTION, order: PERSONA_ORDER, complete: true, text: '你只做一件事：把给你的文件总结成三句话。' })
prompt.suppressContext()
```

### 产出

```
── subagent 的装配 ──
   -100  harness:identity      111 ch  ← 未生效
      0  deployment:persona     20 ch
    100  tools:guidance        214 ch  ← 未生效
  system prompt（20 ch）：
    你只做一件事：把给你的文件总结成三句话。
  运行时快照：（无）
```

**从 345 字符降到 20 字符**，而且没有一句话在把它往别的方向拽。

下面看这几个选择。

## 为什么 `replace` 是另一个方法，而不是"注册时允许覆盖"

最省事的改法是把 5.1 那句抛错删掉，让后注册的覆盖先注册的。**不行**，因为那样就分不清两种情况了：

| 意图 | 现在的行为 |
|---|---|
| 我不知道有人占了这个名字 | `register` → **抛错**（5.1 那条规矩，静默覆盖会让人查半天） |
| 我就是要换掉它 | `replace` → 换掉，并给回一个恢复函数 |

**同一个动作，两种意图，就该是两个方法。** 读代码的人看到 `replace(...)` 就知道这里是有意为之；看到 `register(...)` 撞名字炸了，就知道是撞车了。

> 这条比看起来通用：**当一个 API 的行为取决于"调用者是不是知道自己在做什么"时，把它拆成两个名字，而不是加一个 `force: true` 参数。**

## 具名槽位：那个导出的常量才是关键

`replace` 能工作，前提是**两边用的是同一个名字**。所以名字不能各处各写一遍字符串字面量，得是一个导出的常量：

```ts
prompt.register({ name: PERSONA_SECTION, ... })      // 装配时
prompt.replace({ name: PERSONA_SECTION, ... })      // preset 覆盖时
```

写错一个字母，`replace` 会抛"没有这个段落可替换"——**这比静默地多出一段人设好得多**。

dsh 把这条写在常量的 JSDoc 里，说得很清楚：

> Exported because a composition can replace this slot — an agent preset shadows the deployment's persona with its own — and **both sides naming the same section is what makes the replacement work rather than duplicate.**

（导出它，是因为一个组合可以替换这个槽位——agent preset 用自己的 persona 遮蔽部署方的——而**两边写同一个 section 名，正是"替换"而不是"重复"的原因**。）

`dsh/packages/preset/persona/src/index.ts` 里就是这么用的：

```ts
import { PERSONA_ORDER, PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt'

ctx.effect(() => ctx.systemPrompt.section({
  name: PERSONA_SECTION,
  order: PERSONA_ORDER,
  text: config.text,
  ...(config.complete ? { complete: true } : {}),
}), 'persona.section()')
```

**"槽位"就是一个约定好名字的位置。** 它不是语言特性，就是一个大家都同意去写的字符串——而把它变成导出常量，是让这个约定**能被编译器和 IDE 帮忙检查**的唯一办法。

## `complete` 换掉的是"哪些段进 prompt"，不是"要不要处理模板"

```
=== ③ complete：这一段就是全部 ===
  system prompt（47 ch）：
    你只做一件事：把给你的文件总结成三句话。工作目录是 /home/me/项目。不要调用任何工具。
```

那个 `{{cwd}}` **仍然被插值了**。组装的其余部分照跑不误：变量要解析、动态上下文要拼、工具要排序——只有最后一步"哪些段拼进 prompt"被这一段顶掉。

dsh 的 JSDoc 是同一句话：

> Assembly still runs the cooperative waterfall so tools, contexts, and variables can be resolved, then restores this exact section as the sole prompt section.

**为什么不干脆跳过整个组装？** 因为一个"完整 prompt"的 agent 照样要用工具、照样要看运行时上下文、照样要 `{{cwd}}`。**`complete` 说的只是"system prompt 的内容由我一个人定"，不是"我不需要这个 harness 的其余部分"。**

## 两段都说"我是全部" → 抛错

```
=== ④ 两段都说"我是全部" ===
  ❌ 同时有多段声明了"complete"：deployment:persona、tools:guidance
```

**没有任何规则能决定听谁的。** 按 order 取第一个？那是随便挑一个然后假装有道理。按注册顺序？那让结果取决于插件加载顺序，是这门课一路在避免的那种脆弱。

**当两个配置项互相矛盾且没有自然的优先级时，正确的行为是拒绝启动。** dsh 一模一样：`multiple complete prompt sections are active: …`。

## 顺手：让 debug 清单别说谎

加了 `complete` 之后，`inventory()` 出了个问题——它会列出所有段落，包括那些**根本不会进 prompt** 的：

```
   -100  harness:identity      111 ch  ← 未生效
      0  deployment:persona     20 ch
    100  tools:guidance        214 ch  ← 未生效
```

那个 `← 未生效` 是补上去的。**一个会说谎的 debug 工具比没有更糟**：你盯着"harness:identity 111 字符"，以为模型读到了身份说明，实际它一个字都没看到。

同一条也适用于空段落——5.1 的 `生效: false` 现在统一表示"这一段不会出现在最终 prompt 里"，不管原因是空还是被 `complete` 顶掉了。

## `complete` 和 `suppressContext` 是两个开关

```
=== ⑤ 一个最小的 subagent：complete + suppressContext ===
  system prompt（20 ch）：
    你只做一件事：把给你的文件总结成三句话。
  运行时快照：（无）
```

一个管 system prompt 里留什么，一个管**要不要发那条运行时快照**（5.3）。**它们可以任意组合**：

| 完整 | 抑制上下文 | 什么场景 |
|---|---|---|
| ✗ | ✗ | 普通装配 |
| ✓ | ✗ | 换一个人设，但仍然要知道现在几点、在哪个目录 |
| ✗ | ✓ | 保留完整身份，但这个 agent 不该看到运行时状态（比如一个纯离线的评审 agent） |
| ✓ | ✓ | 最小的 subagent |

dsh 的 persona preset 把两者都暴露成配置项：

```ts
complete: z.boolean().default(false),
includeRuntimeContext: z.boolean().default(true),
```

**两个正交的关注点就该是两个开关。** 把它们合成一个"精简模式"会让第二、三行那两种组合变得不可表达。

## 对照 dsh

| | 我们的 | dsh |
|---|---|---|
| 替换机制 | 显式的 `replace()`，换掉 Map 里的值 | **作用域遮蔽**：scoped 层的同名 section 盖住 global 层的 |
| 撤销 | 手动拿回恢复函数 | Cordis 的 effect disposer，插件卸载自动恢复 |
| 多个完整段 | 抛错 | 抛错（`multiple complete prompt sections are active`） |
| 变更通知 | 无 | `system-prompt/change` 事件——因为装配可以在运行时变 |

最大的差别是**替换的实现方式**。我们是"覆盖同一个 Map 的同一个键"，dsh 是**分层**：

```ts
return this.layers.effect(
  this.ctx,
  layer => layer.sections.insert(section.name, section),
  { label: 'systemPrompt.section()' },
)
```

全局注册进全局层，agent 作用域的注册进那个 agent 的层。组装时按作用域把层链起来，**同名时上层盖住下层**。

这样有两个我们做不到的好处：

**① 同一份注册表能同时服务多个 agent。** 主 agent 用全局 persona，subagent 用它自己那层的 persona，两者**同时存在**、互不影响。我们的 `replace()` 是破坏性的——换了就换了，主 agent 也跟着变。

**② 撤销是自动的。** 我们要求调用方拿住那个恢复函数并记得调用；dsh 里它是 Cordis 的 effect，**插件被卸载时自动执行**。5.1 那句"注册即效果"到这里终于兑现了完整的价值——不只是"能撤销"，而是"撤销这件事不需要任何人记得"。

分层这件事要等阶段 7 引入 Cordis、阶段 19 引入 subagent 之后才有意义。**现在做，是给一个还不存在的问题写代码。**

---

下一课：**5.5 阶段验收** —— 回头看 system prompt 这件事：它从一个字符串常量变成了一个有注册表、有变量、有动态上下文、有槽位和整体替换的小系统。为什么这些机制都是必须的，以及 dsh 的 `system-prompt/assemble` waterfall 又在这之上多买了什么。
