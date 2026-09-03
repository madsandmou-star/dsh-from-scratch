# 3.4 tool loop：agent 的本质

> 本课目标：把工具结果喂回模型再问一轮，直到它给出最终回答。1.4 定义的 turn / step 在这里第一次真正兑现。
>
> **跑一下**：`npm run demo demos/03-tool-loop/04-max-steps.mjs` —— 模型陷在 a↔b 的环里，`MAX_STEPS` 是这个 turn 唯一的出口。

## 循环长什么样

```
收用户输入
   │
   ▼
┌─ step：请求模型 ──────────────────┐
│      │                            │
│      ├─ 没要求调工具 → 打印回答，turn done
│      │                            │
│      └─ 要求调工具                 │
│            ├─ 把 assistant(tool_calls) 记进历史
│            ├─ 执行每个工具         │
│            ├─ 把 tool 结果记进历史 │
│            └─ 回到 step open ──────┘
└─ 超过最大步数 → 强制停止
```

代码是 [`src/index.ts`](../../../src/index.ts) 里的 `runTurn()`。核心只有一句话：**没有工具调用就返回，有就执行完再来一轮。**

## 用户视角 vs 模型视角

用户看到的：

```
模型 > 我先看看这个文件。
  [工具] read({"path": "src/types.ts"})
         →    1: // 阶段 1.3：先给"消息"一个类型。 …

模型 > 再看一个。
  [工具] read({"path": "src/tool.ts"})
         →    1: // 阶段 3.3：工具的定义与执行。 …

模型 > types.ts 定义了消息与流事件类型，tool.ts 定义了 Tool 接口和 read 工具。
```

同一次交互，服务器看到的：

```
【第 1 次请求，历史 2 条】
   system   | 你是助手
   user     | types.ts 和 tool.ts 分别是干什么的？

【第 2 次请求，历史 4 条】
   system   | 你是助手
   user     | types.ts 和 tool.ts 分别是干什么的？
   assistant| tool_calls:[read]
   tool     |    1: // 阶段 1.3：先给"消息"一个类型。⏎ …  (回应 c1)

【第 3 次请求，历史 6 条】
   … 上面四条 …
   assistant| tool_calls:[read]
   tool     |    1: // 阶段 3.3：工具的定义与执行。⏎ …  (回应 c2)
```

**一次用户输入 = 一个 turn = 三个 step。** 每个 step 往历史里加两条（assistant + tool），最后一个 step 只加一条（assistant 的最终回答）。

这就是 1.2 那句话的终点：**模型能看到的全部就是 messages 数组**。工具没有给模型开任何后门——它只是让这个数组按规律长大。

## 三个必须做对的细节

### ① `content: null` 的 assistant 消息**必须**进历史

模型只调工具不说话时，这条消息看起来是空的，删掉它似乎没损失。**不能删**——下一轮请求里每条 `tool` 结果都要能找到它对应的 `tool_calls`。少了它，供应商会拒绝整个请求。

```ts
messages.push({
  role: 'assistant',
  content: text === '' ? null : text,
  ...toolCalls.length === 0 ? {} : { tool_calls: ... },
})
```

### ② 配对靠 `tool_call_id`，不靠顺序

```ts
messages.push({ role: 'tool', tool_call_id: call.id, content: result })
```

一轮里可以有多个工具并行调用，结果的顺序不保证与调用顺序一致（真实实现里往往是并发执行，谁先完成谁先回）。**id 是唯一可靠的配对方式。**

### ③ 最大步数不是可选项

```ts
const MAX_STEPS = 10
```

防的是"模型反复调工具但永远不给最终回答"——它可能陷在自己看不出来的循环里（读 A 发现要读 B，读 B 发现要读 A）。**没有这个上限，agent 会一直烧钱直到你按 Ctrl-C。**

这是 agent 和普通程序的一个根本差别：**循环的终止条件由模型决定，而模型不保证会终止。** 所以终止条件必须由外部兜底。

## 中途失败：悬空的工具调用

这是本课最值得想的一处。

假设第 2 个 step 里模型要求调 3 个工具，执行第 2 个时进程出错了。此时历史里是：

```
assistant | tool_calls: [A, B, C]
tool      | A 的结果
                              ← B、C 的结果永远不会来了
```

**这是一个非法状态。** 下一次请求发出去，供应商会拒绝：每个 `tool_calls` 都必须有配对的结果。

我们的处理是最朴素的：**把这个 turn 期间追加的消息全部回滚**。

```ts
const rollbackTo = messages.length
messages.push({ role: 'user', content: input })
try { await runTurn() } catch (error) {
  console.error(`[本轮中断，已回滚] …`)
  while (messages.length > rollbackTo) messages.pop()
}
```

代价很清楚：**模型已经做过的工作全丢了**。它读了两个文件、想了两轮，用户下次得从头再来。

> **半成品状态，第五次出现。** 1.4 悬空 user 消息 → 2.1 缺 `[DONE]` → 2.2 未终止残片 → 2.3 断流半句话 → 现在是悬空工具调用。
>
> 而这一次"丢掉"的代价明显更高了——前四次丢的是几十个 token，这次丢的是几次工具执行和几轮推理。

## 对照 dsh：不回滚，而是**补齐**

dsh 有一个专门的模块处理这件事：`dsh/packages/core/session/src/repair.ts`，模块注释写着：

> Crash-recovery repair for an interrupted session log. It **preserves a fully written final turn** and **supplies the missing tool, step, and turn boundaries** needed to resume with a provider-valid transcript.
>
> （对被打断的会话日志做崩溃恢复：**保留已完整写入的最后一个 turn**，并**补上缺失的工具、step、turn 边界**，好让恢复后的对话记录对供应商合法。）

它导出两个恢复码：

```ts
/** Recovery code for an assistant tool request that never reached a recorded call start. */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/** Recovery code for a recorded tool call whose completed outcome was not durably recorded. */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'
```

而 `interruptedTurnClosers()` 的说明是：

> 返回一组确定性的合成事件来闭合一个开着的尾部 turn。**未配对的调用先收到错误结果**，随后是一个 `step/end` 和一个 interrupted 的 `turn/end`；序号接着日志继续，时间戳复用最后一条真实事件。日志本身平衡或为空时不返回任何事件。

翻译成人话：**dsh 不删任何东西，它往日志里补几条"这次调用失败了"的合成结果，把非法状态补成合法状态。**

两种办法的对照：

| | 我们（回滚） | dsh（补齐） |
|---|---|---|
| 已完成的工具结果 | **丢掉** | 保留 |
| 模型的推理过程 | 丢掉 | 保留 |
| 未完成的调用 | 一并删除 | 补一条错误结果 |
| 恢复后模型知道发生了什么 | 不知道（历史干净得像没发生过） | **知道**——它看到那次调用失败了 |
| 实现复杂度 | 三行 | 一个模块 + 两个恢复码 + 确定性合成 |

**"确定性"（deterministic）那个词是关键**：合成事件的序号接着日志继续、时间戳复用最后一条真实事件——所以同一份残缺日志，无论修复多少次，结果完全一样。这让崩溃恢复本身可测试、可重放。

为什么 dsh 值得付这个复杂度？因为它的场景里，一个 turn 可能已经跑了几分钟、改了十几个文件。**丢掉重来不是"用户体验差一点"，是"用户的工作没了"。**

我们现在是玩具，回滚够用。**记住这个疼——阶段 12 你会自己实现补齐。**

---

下一课：**3.5 阶段验收** —— 会正面回答一个攒了两课的问题：dsh 为什么把一次工具执行拆成 `pre-execute` / `execute` / `post-execute` 三段事件。
