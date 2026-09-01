# 5.3 动态上下文不进 system prompt

> 本课目标：把"每一轮都在变的事实"从 system prompt 里赶出去，改成一条会自我取代的 user 消息，并说清三条硬理由。

## 痛点：给 system prompt 加一句"现在几点"

模型不知道现在几点——它只知道训练截止到哪。所以很自然会想加一段：

```ts
提示.注册({ 名字: 'time', 顺序: 50, 文本: () => `现在是 ${new Date().toISOString()}。` })
```

一跑就出事（`demos/05-system-prompt/06-why-not-system-prompt.mjs`）：

```
=== 痛点：时间作为 system prompt 的一段 ===
  两个 step 的 system prompt 一样吗？ ★ 不一样
  相同前缀只有 139 / 142 字符——后面全部要重新计算。
```

三个问题，一个比一个深。

### ① 缓存前缀被打断

模型服务商普遍支持 **prompt 缓存**：这次请求的开头如果和上次一模一样，那一段就不用重新计算，又快又便宜。而 system prompt 在**整个对话的最前面**——它变了，**后面所有消息的缓存全部作废**，包括那 50 条工具结果。

一个 20 步的 turn，每一步都改一次 system prompt，等于 20 次全量重算。

这不是我推测的，dsh 的 `user-approval` 包里有一句注释把它说得很直白：

```ts
// The complete current value travels after retained history, so switching
// policy does not rewrite the stable system-prompt cache prefix.
```

（完整的当前值跟在已保留的历史**后面**走，这样切换策略不会改写稳定的 system-prompt 缓存前缀。）

### ② 位置不对：最新的事实待在最老的位置

一个 50 轮的会话，system prompt 在第 0 条。模型读到"现在是 03:47"这句话时，它前面还压着 100 条消息。**最需要新鲜的信息，放在了最陈旧的位置。**

而且它是**被覆盖**的：第 3 步那句"现在是 03:47"和第 1 步那句长得一样，都在同一个位置，模型没有任何线索知道哪个是最新的。

### ③ 最深的一条：它没落日志

我们现在的历史 `messages` 里有 system、user、assistant、tool 四种消息。阶段 6 会把它们写进会话日志，然后你就能重放一个历史会话。

**但 system prompt 是每次现拼出来的。** 日志里只有"第一条是 system"，重放时你重新组装一次，拿到的是**今天的时间**，不是当时的。

> 这门课有一条从阶段 2 就在的规矩：**模型可见 ⟺ 已落日志**。凡是进了模型请求的东西，都必须能从日志里重建出来。
>
> 一句写死的 persona 满足这条（它在配置里，不会变）。**一句"现在是 03:47"不满足**——它每次组装都不同，而组装过程没有留下任何痕迹。

## 解法：一句话和一张图

**每轮都在变的事实不拼进 system prompt，而是拼成一条 user 消息，追加在这一步消息的最后；和上一条一样就不重发，开头写明"这份取代之前的"。**

```
改之前：
  [system] 身份 + persona + 工具指引 + 【现在是 03:47】   ← 每步都变，缓存全废
  [user]   读一下 a.txt
  [tool]   …

改之后：
  [system] 身份 + persona + 工具指引                     ← 从头到尾不变
  [user]   读一下 a.txt
  [user]   【当前运行时上下文。这份快照取代之前所有的快照。现在是 03:47】
  [tool]   …
  [user]   【…取代之前的…现在是 03:48】                   ← 新的一条，旧的自动失效
```

### 全部代码，一眼看完

注册表这边加一种新的注册和一个新的组装：

```ts
export interface 上下文段 {
  名字: string
  顺序: number
  文本: string | (() => string)
}

const 快照开头 = '当前运行时上下文。这份快照取代之前所有的运行时上下文快照。'
export const 快照已清空 = '当前运行时上下文：没有。之前的运行时上下文快照都不再适用。'

上下文(段: 上下文段): () => void {
  if (this.上下文们.has(段.名字)) throw new Error(`上下文段落重名：${段.名字}`)
  this.上下文们.set(段.名字, 段)
  return () => { this.上下文们.delete(段.名字) }
}

组装上下文(): string {
  const 变量表 = this.取这次的变量()          // 和 组装() 共用同一份变量快照
  const 正文 = [...this.上下文们.values()]
    .sort((甲, 乙) => 甲.顺序 - 乙.顺序)
    .map(段 => 插值(段.名字, 求值(段), 变量表))
    .filter(文本 => 文本 !== '')
    .join('\n\n')
  return 正文 === '' ? '' : `${快照开头}\n\n${正文}`
}
```

循环那边加一个"变了才发"：

```ts
let 上次发出的快照: string | undefined

function 追加上下文快照(): void {
  const 快照 = 提示.组装上下文()
  if (快照 === (上次发出的快照 ?? '')) return
  // 从"有"变成"没有"时要显式说一声。什么都不发的话，模型会继续拿旧快照当真。
  messages.push({ role: 'user', content: 快照 === '' ? 快照已清空 : 快照 })
  上次发出的快照 = 快照
}
```

### 用起来是一段注册 + 一行调用

```ts
提示.上下文({ 名字: 'time', 顺序: 0, 文本: () => `现在是 ${new Date().toISOString()}。` })
```

```ts
for (let step = 1; step <= 最大步数; step++) {
  追加上下文快照()      // ← 每个 step 之前重算：一个 turn 可能跑十分钟
  ...
}
```

### 产出

一个 turn 里三次请求（`demos/05-system-prompt/05-runtime-context.mjs`）：

```
── 第 3 次请求的 messages（9 条）──
  system    你是一个跑在命令行里的编码助手。…当前工作目录是 /tmp/…
  user      读一下 a.txt 和 b.txt
  user      当前运行时上下文。这份快照取代之前所有的运行时上下文快照。 ⏎ 现在是 …:25.409Z。
  assistant (null)
  tool         1: hello
  user      当前运行时上下文。…现在是 …:25.487Z。
  assistant (null)
  tool         1: world
  user      当前运行时上下文。…现在是 …:25.491Z。
```

三件事同时成立：**system 那条从头到尾一个字没变**；快照在**每一步的末尾**；每份快照都自带"取代之前的"。

对照组：

```
=== 解法：时间作为动态上下文 ===
  两个 step 的 system prompt 一样吗？ ★ 一样，缓存前缀完整
  两个 step 的快照一样吗？           不一样，会作为新的一条 user 消息追加
```

下面看这几十行里的选择。

## 为什么是 user 消息，不是别的

它明明是 harness 生成的，为什么挂在 `user` 这个 role 下面？

因为 wire 协议只有四种 role（`system` / `user` / `assistant` / `tool`），而这条消息：

- 不是 `system`——那就回到痛点了
- 不是 `assistant`——那是模型自己说的话，冒充它会污染模型对"我说过什么"的判断
- 不是 `tool`——`tool` 消息必须有一个 `tool_call_id` 和之配对（3.4 讲过），它不是任何调用的结果

**剩下只有 `user`。** 这是一个协议限制下的务实选择，不是说它"是用户说的"。dsh 在这里更进一步：它的会话日志里，这条消息带着来源标记

```ts
source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections }
```

**wire 上是 user，日志里知道它是插件生成的快照，还知道由哪几个部分拼成。** 界面因此可以把它折叠起来、单独渲染，而不是当成用户真的说了一句话。这就是「模型可见 ⟺ 已落日志」在这里的完整形态——不只是"记下来了"，还包括"记下了它是谁"。

## "取代之前的"这句话在干活

```
当前运行时上下文。这份快照取代之前所有的运行时上下文快照。
```

历史是**只增不改**的：第 1 步那份"现在是 03:47"永远留在那儿。所以模型会同时看到三份时间，而且都是"当前"。

这句开场白就是告诉它：**往下看，最后一份才算数。**

dsh 的原文是同一个意思：

```
Current runtime context. This snapshot supersedes earlier runtime-context snapshots.
```

**为什么不干脆把旧的删掉？** 因为历史一旦可以改，两件事就崩了：一是缓存前缀（改中间等于改前缀），二是可重放性（阶段 6 的日志是**追加式**的，改历史意味着日志要支持"撤销")。**用一句话解决，比让整个数据结构变可变要便宜得多。**

## 从"有"变成"没有"要显式说

```
=== 从"有"变成"没有"：必须显式说一声 ===
  step 1 的快照：当前分支是 main。
  step 2 的快照：（空）→ 要发的是："当前运行时上下文：没有。之前的运行时上下文快照都不再适用。"
  什么都不发的话，模型会继续拿 step 1 那份当真。
```

这一格容易漏。上下文从有变成无（退出了 git 仓库、关掉了某个功能）时，**"什么都不发"和"没有变化"在模型看来一模一样**——它会继续相信 step 1 那份。

所以要发一句显式的"没有了"。dsh 也有这么一个常量：

```ts
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'
```

> **"状态消失"是一个需要被广播的事件，不是"不广播"。** 这条在任何有订阅者的系统里都成立。

## 去重不是优化，是正确性

```
=== 去重：上下文没变就不重发 ===
  step 1：发一条 user 消息
  step 2：和上次一样，不发
  step 3：和上次一样，不发
```

省 token 只是顺带的。真正的理由是：**重复发一份一模一样的快照，等于在告诉模型"情况又变了"**——而它其实没变。模型会去找不同，找不到，然后浪费注意力。

## 我们的做法有一个 bug（而且我留着）

`上次发出的快照` 是一个**记在旁边的变量**。1.4 那个错误回滚会把这轮追加的消息全弹掉：

```ts
while (messages.length > 回滚点) messages.pop()
```

**快照消息被弹掉了，但那个变量还记着它。** 不处理的话，下一轮 `追加上下文快照()` 会认为"和上次一样"，于是不发——模型永远见不到那份上下文。

我加了一行补丁：

```ts
上次发出的快照 = undefined
```

但这只是**堵住了我知道的那一个洞**。任何别的地方动了 `messages`，这个变量就又对不上了。

dsh 的解法是根本不留这个变量：

```ts
/** `undefined` 表示从来没有过快照；`null` 表示当前没有保留任何快照。 */
private retained: { seq: number; text: string | undefined } | null | undefined

ctx.on('session/event', (subject, event) => {
  if (event.type === 'user/message' && isOwned(event.data)) {
    this.retained = { seq: event.seq, text: textOf(event.data) }
  } else if (this.retained && isReplacementSurfaceEvent(event) && ...) {
    this.retained = null
  }
})
```

**它从权威事件流里推导"上次发了什么"**，而不是自己记一份。构造时先把已有日志倒着扫一遍恢复状态，之后跟着 `session/event` 更新。

> **一份记在旁边的状态，迟早会和真相对不上。** 唯一可靠的做法是：认定一个权威来源，其余全部从它推导出来。
>
> 我们现在没有会话日志（阶段 6 才做），所以只能先记一个变量。**阶段 6 会回来把它换掉**——那时候 `messages` 数组本身也会退位，让位给事件日志。

## 对照 dsh

| | 我们的 | dsh |
|---|---|---|
| 注册 | `提示.上下文()` | `ctx.systemPrompt.context()`，绑插件生命周期 |
| 求值 | `() => string` | `(context: AssembleContext) => string`，能看到 agent 和 session |
| 拼装 | 一个字符串 | `AssembledContext[]`，**保留每段的名字**，界面能逐段归属 |
| 变成消息 | `messages.push()` | `RuntimeContextProjection.project()` 产出一条带 `source` 的 `UserMessage` |
| "上次发了什么" | 一个变量 | 从 `session/event` 推导 |
| 插入位置 | 历史末尾 | `agent/pre-step` waterfall 的默认决定：`[...claimed, context]` |
| 还有别的产生方式吗 | 没有 | 有——插件可以直接挂 `agent/pre-step` 自己追加（`time-context` 就是，它还带自己的刷新间隔） |

两处值得展开：

**① 保留每段的名字。** dsh 的快照不是一个字符串，是一串 `{ name, text }`：

```ts
source: { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections }
```

界面拿到这条消息时，能说清"这一段来自 sandbox 策略、那一段来自审批策略"，而不用去反向切分那段拼好的散文。**又是 4.1 讲过的那条：一旦返回值要同时服务模型和界面，字符串就不够用了。**

**② 插入点是一个 waterfall 的默认值。** `agent/pre-step` 的默认决定是 `{ kind: 'enter', messages: [...claimed, context] }`——也就是说，**插件可以改这个决定**：可以在快照前面再插点东西，也可以整个拒绝这一步（`kind: 'reject'`）。我们那句 `追加上下文快照()` 是写死的，dsh 那句是一个可以被接管的默认值。

顺带一提，真实的 dsh 里"当前时间"**不走** `systemPrompt.context()`——它是一个独立的包 `dsh/packages/context/time-context/`，直接挂 `agent/pre-step`，因为它有自己的刷新节奏（不是每步都发，而是超过一个间隔才发）。**同一个位置有两条路：统一快照，和自己接管。** 前者简单，后者能带自己的策略。

---

下一课：**5.4 谁能替换整个 prompt** —— 到现在为止，段落只能往上加。但有些场景需要"这一段就是全部"：一个跑固定任务的 subagent 不需要通用的编码助手身份。dsh 有 `complete: true` 和一个叫 `deployment:persona` 的**具名槽位**，后者解决的是"preset 想换掉 persona，而不是再加一段"。
