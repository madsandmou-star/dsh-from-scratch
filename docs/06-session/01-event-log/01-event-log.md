# 6.1 一个数组承担了三个角色

到阶段 5 为止，整个 agent 的记忆是 `src/index.ts` 里的一个数组：

```ts
const messages: Message[] = []
```

它工作得很好，好到我们已经在它身上加了五个阶段的功能。这一课把它拆掉。

## 痛点：三个角色，一个可变数组

`messages` 同时是三样东西：

1. **发给模型的请求内容**——`chatStream(messages, config)` 直接把它序列化进 HTTP body。
2. **给用户显示的对话**——屏幕上滚过的每一句，都是它的某一条。
3. **"发生过什么"的记录**——这次会话到底做了哪些事，只能从它里面看。

三个角色共用一个可变数组，于是**任何一个角色的需求去改它，另外两个都跟着变**。这不是理论上的风险，它已经在课程里造成了三处具体的伤：

**① 1.4 的回滚一次抹掉三样东西。** 一个 turn 中途失败时，我们把这轮追加的消息全弹掉：

```ts
const rollbackTo = messages.length
messages.push({ role: 'user', content: input })
try { await runTurn() } catch (error) {
  console.error(`[本轮中断，已回滚] …`)
  while (messages.length > rollbackTo) messages.pop()
}
```

理由只有一个：**请求内容**不能非法（悬空的 `tool_calls` 会被供应商 400）。但代价落在另外两个角色身上——模型读过的两个文件、想过的两轮，从"发生过什么"里彻底消失了；而用户在屏幕上明明见过它们。**为了让请求合法，我们篡改了历史。**

**② 5.3 的 `lastSentSnapshot` 是一个记在旁边的变量。** 上次发出去的运行时快照是什么，`messages` 里其实有，但因为回滚会把它弹掉、变量却还记着，两边会对不上。我当时打了一行补丁 `lastSentSnapshot = undefined`，并明说那只是堵住了我知道的那一个洞。**只要 `messages` 还能被改，所有"记在旁边"的东西就都不可信。**

**③ 想加任何新功能都得改这个数组的含义。** 压缩要"把十条换成一条摘要"，分支要"从第 7 条重新开始"，撤销要"回到刚才那个状态"——三件事都得在这个数组上原地动手，而它同时还是屏幕内容和请求内容。

> 判断一个数据结构该不该拆，不看它有多长，看**有几个互相冲突的理由在改它**。这里是三个。

## 解法：一句话和一张图

**一句话：让"发生了什么"成为唯一的权威，"发给模型什么"降级成它的一个函数。**

具体到代码：一条**只增不改**的事件日志（`Session`），加一个把日志算成 messages 的**纯函数**（`deriveMessages`）。发生什么就往日志里 append 一条，永不修改、永不删除；每次要发请求时，现算一次 messages。

### 改前 / 改后的数据流

```
改前：
  用户输入 ─┐
  模型产出 ─┼→ [ messages ] ─→ 发请求
  工具结果 ─┘        ↑ ↓
                  回滚在这里原地动手（三个角色一起遭殃）

改后：
  用户输入 ─┐                        ┌→ deriveMessages() ─→ 发请求
  模型产出 ─┼→ [ 事件日志 append ] ──┼→ （阶段 6.2）写盘
  工具结果 ─┘     只增不改            └→ （阶段 12）压缩 / 分支 / 撤销
```

右边那一列是重点：**投影有很多个，日志只有一个。** 压缩不是"改历史"，是换一种投影方式；分支不是"截断数组"，是投影日志的一个前缀。阶段 12 会真的做这两件事，而那时**日志一个字都不用动**。

### 一屏看完的完整实现

`src/session.ts`（省略了 JSDoc，完整版在文件里）：

```ts
/** 会话里可能发生的事情，以及每种事情要记下什么。 */
export interface SessionEventMap {
  'turn/start': { turn: number }
  'user/message': { text: string }
  'context/snapshot': { text: string }
  'assistant/message': { turn: number, step: number, text: string | null, toolCalls?: ToolCall[] }
  'tool/call': { callId: string, name: string, arguments: string }
  'tool/result': { callId: string, content: string }
}

export type SessionEventType = keyof SessionEventMap

/** 日志里的一条记录：类型 + 序号 + 时间 + 这类事件自己的数据。 */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: { type: K, seq: number, time: number, data: SessionEventMap[K] }
}[T]

export class Session {
  private readonly log: SessionEvent[] = []
  private readonly listeners = new Set<SessionListener>()

  /** 已经发生的全部事情，按发生顺序。调用方只读。 */
  get events(): readonly SessionEvent[] {
    return this.log
  }

  append<T extends SessionEventType>(type: T, data: SessionEventMap[T]): SessionEvent<T> {
    const event = { type, seq: this.log.length, time: Date.now(), data } as SessionEvent<T>
    this.log.push(event)                                      // 先入日志
    for (const listener of this.listeners) listener(event)    // 再广播
    return event
  }

  on(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

export function deriveMessages(events: readonly SessionEvent[], systemPrompt: string): Message[] {
  const messages: Message[] = [{ role: 'system', content: systemPrompt }]
  const settled = new Set<string>()   // 已经有结果的 callId
  const started = new Set<string>()   // 记录过"开始执行"的 callId
  for (const event of events) {
    if (event.type === 'tool/result') settled.add(event.data.callId)
    if (event.type === 'tool/call') started.add(event.data.callId)
  }

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
      case 'tool/call':
        break                                    // 只进日志，不进请求

      case 'user/message':
      case 'context/snapshot':
        messages.push({ role: 'user', content: event.data.text })
        break

      case 'assistant/message': {
        const { text, toolCalls } = event.data
        messages.push({ role: 'assistant', content: text, /* …tool_calls… */ })
        // 补齐：这一条要求的调用里，没有结果的那些，就地补一条合成结果。
        for (const call of toolCalls ?? []) {
          if (settled.has(call.id)) continue
          messages.push({
            role: 'tool', tool_call_id: call.id,
            content: started.has(call.id)
              ? `错误：${TOOL_OUTCOME_UNKNOWN} —— 这次调用开始执行了，但结果没有被记录下来…`
              : `错误：${TOOL_NOT_STARTED} —— 这次调用没有被执行。`,
          })
        }
        break
      }

      case 'tool/result':
        messages.push({ role: 'tool', tool_call_id: event.data.callId, content: event.data.content })
        break
    }
  }
  return messages
}
```

八十行，两个概念：**append 只增不改**，**derive 是纯函数**。

### 用起来是几行

`src/index.ts` 里，`const messages: Message[] = []` 变成：

```ts
const session = new Session()
```

发生什么就记一条：

```ts
session.append('turn/start', { turn })
session.append('user/message', { text: input })
…
session.append('assistant/message', { turn, step, text, toolCalls })
session.append('tool/call', { callId: call.id, name: call.name, arguments: call.arguments })
const result = await runTool(call.name, call.arguments, guards)
session.append('tool/result', { callId: call.id, content: result })
```

要发请求时，现算：

```ts
const messages = deriveMessages(session.events, prompt.assemble())
```

而 catch 块里那段回滚**整个删掉了**：

```ts
} catch (error) {
  console.error(`\n[本轮中断] ${error instanceof Error ? error.message : String(error)}`)
}
```

不是"改成别的处理"，是**没有处理**——中断了就是中断了，日志照样记着发生过的事，投影时自然会补齐。

### 产出长什么样

```sh
node --import tsx demos/06-session/01-log-vs-projection.mjs
```

```
[会话日志] 12 条 —— 发生了什么（权威）
    0  turn/start         turn 1
    1  user/message       把 a.txt 的内容抄一份到 b.txt
    2  context/snapshot   当前运行时上下文。这份快照取代之前所有的运行时上下文快照。 ⏎  ⏎ 现在是 …
    3  assistant/message  step 1  (不说话) → read#call_1
    4  tool/call          read#call_1 开始
    5  tool/result        #call_1 ←    1: hello ⏎    2:
    6  context/snapshot   当前运行时上下文。…
    7  assistant/message  step 2  (不说话) → write#call_2
    8  tool/call          write#call_2 开始
    9  tool/result        #call_2 ← 已创建 b.txt（12 字符）
   10  context/snapshot   当前运行时上下文。…
   11  assistant/message  step 3  读完 a.txt，写好了 b.txt。

[投影出来的 messages] 10 条 —— 发给模型什么
       system             你是一个跑在命令行里的编码助手。…
       user               把 a.txt 的内容抄一份到 b.txt
       user               当前运行时上下文。…
       assistant          (null)
       tool                  1: hello ⏎    2:
       …
```

十二条事件，十条消息。差在哪里，就是这一课剩下要讲的东西。

## 细节一：事件表是一张会长大的表

`SessionEventMap` 是一张 **key 是事件名、value 是这类事件要记什么** 的表。它现在有六项，每加一个功能就会多几项：压缩会加一个"这段被摘要取代了"，权限会加一个"用户批准了这次调用"。

关键在于**加项不改旧项**。旧的日志文件里那些事件的含义永远不变，所以三个月前的会话今天还读得懂。这条约束听起来很弱，做起来很难——它意味着你不能"顺手把 `tool/result` 的 content 改成对象"。

TypeScript 这边有两个技巧值得看：

**`SessionEventType = keyof SessionEventMap`** —— 事件类型名不是手写的联合类型，是从表里**算**出来的。往表里加一项，类型自动跟上；写错事件名，`append('tool/reuslt', …)` 直接编译不过。

**`SessionEvent` 用了一个映射类型再取索引**：

```ts
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: { type: K, seq: number, time: number, data: SessionEventMap[K] }
}[T]
```

读法：先对每个 K 造出一个 `{ type: K, …, data: 对应的数据类型 }`，得到一张 **key → 事件对象类型** 的表；最后 `[T]` 从表里取出来。不带参数时 `T` 是全部类型名，取出来就是**六种事件对象的联合**。

这样写的好处是 `type` 和 `data` **绑死了**：

```ts
if (event.type === 'tool/result') {
  event.data.callId       // ✅ TypeScript 知道 data 是 { callId, content }
  event.data.turn         // ❌ 编译错误
}
```

如果写成 `{ type: SessionEventType, data: 某个大联合 }`，这个关联就断了——你得自己 `as` 一下，而 `as` 是错误的温床。这个模式在 TS 里叫 **discriminated union**（可辨识联合），`type` 是那个 discriminant（判别字段）。**投影函数里的 `switch (event.type)` 能逐分支拿到正确的 `data` 类型，全靠它。**

> Python 里最接近的是 `match` 加 `TypedDict` + `Literal`，但 Python 的类型检查在运行时不存在，写错了要跑到那一行才炸；TS 这里是编译期就拦住。

## 细节二：`seq` 和 `time` 为什么是事件自己的字段

`seq` 就是 `this.log.length`——追加时的下标。既然它等于下标，为什么还要存一份？

因为**下标是数组的属性，seq 是事件的属性**。一旦这条事件离开这个数组——写进文件（6.2）、发给另一个进程、被投影函数单独引用——下标就不存在了，而 seq 还在。日志只增不改这条规矩，让 seq 一经分配就永远正确。

6.4 会用到它的第二个作用：一条合成的补齐事件要说明"我是给 seq=4 那次调用补的"，靠的就是这个号。

`time` 是 Unix 毫秒。它不参与投影（模型看不到它），但重放时间线、算"这个工具跑了多久"、在日志里定位"昨晚那次崩溃"都靠它。**记下来几乎不要钱，事后想补是不可能的。**

## 细节三：`append` 里那两行的顺序

```ts
this.log.push(event)                                      // 先入日志
for (const listener of this.listeners) listener(event)    // 再广播
```

反过来写会怎样？订阅者被叫醒，去查 `session.events`，发现**通知它的那条事件还不在里面**。于是每个订阅者都得处理"我拿到的这条比日志新"这种诡异状态。

先入日志，这个状态就不存在了：**任何订阅者被调用时，看到的日志都已经包含了触发它的那条事件。** 这条不变量很便宜（换个行序而已），但它是后面一切订阅者的地基——6.2 的落盘就是一个订阅者。

`on()` 返回一个取消订阅的函数，而不是提供一个 `off(listener)`。理由和 4.4 的护栏一样：**注册的人手里直接握着注销的手柄**，不用记住自己传过去的是哪个函数引用。这个模式在 dsh 里是硬规矩——`ctx.effect()` / `ctx.on()` 一律返回 disposer。

## 细节四：补齐，以及为什么 `tool/call` 必须单独记一条

回到 3.4 留下的那个非法状态：

```
assistant | tool_calls: [A, B, C]
tool      | A 的结果
                              ← B、C 的结果永远不会来了
```

回滚的做法是把这三条全删掉。**补齐的做法是给 B 和 C 各补一条合成的结果。**

补什么内容，取决于那次调用走到了哪一步——这就是为什么日志里 `tool/call`（开始执行）和 `tool/result`（结果）是**两条独立的事件**：

| 日志里有 | 说明发生了什么 | 补出来的话 |
|---|---|---|
| 只有 assistant 的 tool_calls | 模型要求了，但连"开始执行"都没记下 | `TOOL_NOT_STARTED` |
| 还有 `tool/call`，没有 `tool/result` | 开始跑了，中途死了 | `TOOL_OUTCOME_UNKNOWN` |
| 三条都有 | 正常完成 | 用真实结果 |

这个区分不是学术洁癖。看第二行：**这次调用可能已经写了文件、可能已经 `rm` 了东西。** 模型必须知道"它跑过，但我不知道结果"，才不会天真地重试一次 `rm -rf`。而第一行是安全的——没跑就是没跑，重试没有代价。

**一个字段的区分，买到的是"重试是否安全"这个判断。**

```sh
node --import tsx demos/06-session/02-dangling-repair.mjs
```

```
=== 中断于 complete —— 日志 5 条，投影出 4 条 ===
  system    (system prompt)
  user      把 a.txt 抄到 b.txt
  assistant (null)
  tool         1: hello

=== 中断于 after-call —— 日志 4 条，投影出 4 条 ===
  …
  tool      错误：TOOL_OUTCOME_UNKNOWN —— 这次调用开始执行了，但结果没有被记录下来（多半是进程中途退出）。

=== 中断于 before-call —— 日志 3 条，投影出 4 条 ===
  …
  tool      错误：TOOL_NOT_STARTED —— 这次调用没有被执行。
```

注意后两组：**日志比 messages 短。** 投影不只是"过滤"，它会**造出日志里没有的消息**。这是"投影"这个词的完整含义——它是一个函数，不是一个视图切片。

## 细节五：那个"记在旁边的变量"消失了

5.3 的 `lastSentSnapshot` 现在变成了一次查询：

```ts
function lastSnapshotInLog(): string | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event?.type === 'context/snapshot') return event.data.text
  }
  return undefined
}
```

倒着扫，找到第一条 `context/snapshot` 就是答案。它比一个变量慢（O(n) 而不是 O(1)），但它**不可能对不上**——因为日志就是权威本身，没有第二份状态需要同步。

那行 `lastSentSnapshot = undefined` 补丁，连同它堵的那个洞，一起没了。

> **这是事件溯源最实在的好处**：不是"能重放"，是**能删掉的派生状态变多了**。每一个"记在旁边的变量"都是一个待同步的 bug；能从日志里查出来的，就不该另存一份。

## 教 debug：把两栏并排看

`src/index.ts` 里加了一个开关：

```sh
DSH_DUMP_LOG=1 npm run dev
```

退出时它打两栏：**日志**（发生了什么）和**投影**（发给模型什么）。上面那段产出就是它。

出问题时的定位顺序是固定的：

**第一步，看日志那栏有没有该有的事件。** 缺了，说明是**记录**的问题——某个 `append` 没被调用，或者调用它的分支根本没走到。这类 bug 在 `src/index.ts` 里找。

**第二步，日志有但 messages 没有（或者不对）。** 说明是**投影规则**的问题，去 `deriveMessages()` 里找那个 `case`。

**这个顺序很重要，因为日志只增不改，它几乎不会错。** 日志记的是真实发生过的调用；messages 是一个函数的输出，函数才是会写错的那一方。**先信日志，再查投影**——反过来查会浪费很多时间。

第三种情况：两栏都对，模型行为还是不对。那就不是这一层的事了，回 5.1 的 `DSH_SHOW_PROMPT` 去看 system prompt。**三个开关，三层，一层一层往下排。**

## 对照 dsh

dsh 的 `Session` 在 `dsh/packages/core/session/src/index.ts`，事件表在 `dsh/packages/core/session/src/types.ts`，我们抄的 `deriveMessages()` 是它的真实方法名（`dsh/packages/core/session/src/index.ts` 里的 `deriveMessages()`）。三处关键差别：

**① 投影规则被抽成了一个纯函数，而且是"THE 投影规则"。** `dsh/packages/core/session/src/surface.ts` 导出 `deriveEventMessage(event): Message | null`——一次只投影一条事件。它的注释说明了为什么要单独导出：

> This is THE per-node projection rule: `Session.deriveMessages` folds it over the live surface, external reconstructors and pure projections fold the same function over a log prefix's surface to rebuild the exact messages any request was built from.
>
> （这是**唯一**的单条投影规则：`Session.deriveMessages` 把它折叠到活着的 surface 上；外部的重建器和纯投影把**同一个函数**折叠到日志前缀的 surface 上，就能重建出任何一次请求当时是用哪些 messages 拼出来的。）

"重建出任何一次请求当时用的 messages"——这正是 `CLAUDE.md` 里那条 **model-visible ⟺ logged** 规矩的兑现方式：凡是能到达模型的东西，都必须能从日志算回来。我们的 `deriveMessages` 是一整个循环，没法单独复用某一条的规则；dsh 拆成两层，所以"重放第 7 次请求"这件事才可能。

**② surface：投影走的不是全部日志，而是一条"表面"。** dsh 的每条产生消息的事件在 append 时都带一个 `surfaceOp` 标记（`append` 或 `replace`）。压缩要把十条换成一条摘要时，它 append 一条带 `replace` 标记的新事件，**声明自己遮住了哪几条**；投影只走 surface 上的节点，被遮住的那些自动不出现。

日志还是只增不改，"删掉十条"这件事却做到了。我们阶段 12 做压缩时会实现这个机制。

**③ 投影有缓存，而且结果是深冻结的。** `deriveMessages()` 的注释写着 CACHED：每个节点只投影一次，一次调用的开销是 O(新增节点)。我们每个 step 都从头重算整条日志——十条消息无所谓，一万条就不行了。冻结则是另一件事：投影出来的 `Message` 对象是共享且 deep-frozen 的，**调用方拿到手也改不了**，从语言层面挡住"某个插件顺手改了历史"。

| | 我们的 | dsh 的 | 为什么 dsh 更复杂 |
|---|---|---|---|
| 单条投影规则 | 循环里的 `case` | `deriveEventMessage()` 独立导出 | 要能重建任意一次历史请求 |
| 哪些事件参与投影 | 硬编码的几个 `case` | surface + `surfaceOp` 标记 | 压缩要"遮住"而不是"删掉" |
| 重算成本 | 每次 O(全部日志) | 缓存，O(新增) | 长会话下每 step 重算不可接受 |
| 结果能不能被改 | 能（普通对象） | deep-frozen | 插件很多，靠约定不够 |
| 事件表怎么扩展 | 改 `SessionEventMap` 这个文件 | declaration merging，每个插件自己加 | 事件由插件定义，核心不该知道它们 |
| 崩溃补齐 | 投影时即时补 | `repair.ts` 往日志里补**真实事件** | 补出来的东西也要能落盘、能被别人看到 |

最后一行值得多说一句。我们的补齐是**投影时凭空造**的：日志里没有那条 tool 结果，每次投影都重新造一遍。dsh 的 `interruptedTurnClosers()`（`dsh/packages/core/session/src/repair.ts`）返回的是**真的事件**，被 append 进日志——因为在 dsh 里日志要落盘、要给别的进程读、要让用户在 UI 里看到"这次调用被中断了"。**造在投影里的东西，只有投影的人看得见。**

6.2 让日志落到磁盘上之后，这个差别就会开始咬人。

## 这一课改了什么

| 文件 | 改动 |
|---|---|
| `src/session.ts` | 新增：`SessionEventMap`、`Session`、`deriveMessages()`、`summarizeEvent()` |
| `src/index.ts` | `messages` 数组 → `Session`；删掉回滚；删掉 `lastSentSnapshot`；加 `DSH_DUMP_LOG` |
| `demos/06-session/01-log-vs-projection.mjs` | 新增：真实会话的日志与投影并排 |
| `demos/06-session/02-dangling-repair.mjs` | 新增：三种中断位置，三种补齐 |

## 下一课的痛点

现在的日志活在内存里。进程一退，十二条事件全没了——`TOOL_OUTCOME_UNKNOWN` 那条补齐规则写得再好，也没有机会被用上：能触发它的那次崩溃，同时也带走了日志本身。

**6.2 把日志写到磁盘上**，顺便回答一个看起来很小的问题：为什么是一行一条 JSON，而不是一个 JSON 数组。
