# 3.5 阶段 3 验收

> 本课目标：验收 tool loop，并回答攒了两课的问题——dsh 为什么把一次工具执行拆成三段事件。

## 验收清单

```sh
# ① 多 step 的 turn：一次输入触发多轮工具调用
#    用户看到三段回答，服务器看到三次请求（历史 2 → 4 → 6 条）

# ② 工具参数校验（不经过模型直接试）
#    正常路径 → content；路径越界 → 拒绝；类型不对 → 拒绝；缺参数 → 拒绝

# ③ 失控的模型：永远调工具不给回答
#    执行了几次工具: 10
#    [已达最大步数 10，停止本轮]

# ④ 中途断流：回滚生效
#    [本轮中断，已回滚] fetch failed
#    → 下一轮输入时，服务器看到的历史是干净的

# ⑤⑥
npm run typecheck && npm run check
```

| 验收项 | |
|---|---|
| 工具定义的四件套，前三样给模型、第四样给自己 | ✓ |
| 流式工具调用按 `index` 累积，`id`/`name` 不被覆盖 | ✓ |
| 收全判断靠协议信号（流结束），不靠 `JSON.parse` 成功 | ✓ |
| 模型参数是不可信输入：四种废话都被拦住 | ✓ |
| 路径越界用 `resolve` + `relative` 判定，不用字符串匹配 | ✓ |
| 工具失败变成文本喂回模型，不抛异常打断 agent | ✓ |
| `content: null` 的 assistant 消息进历史，`tool_call_id` 配对 | ✓ |
| 最大步数拦住不终止的模型 | ✓ |
| 中途失败回滚，历史不留悬空调用 | ✓ |

## 本阶段产出

```
src/tool.ts      # 新增：Tool 接口 + read 工具 + 参数校验 + wire 格式转换
src/llm.ts       # 改：请求带 tools；流式累积工具调用；产出带标签联合
src/index.ts     # 改：runTurn()（tool loop）、runTool、失败回滚
src/types.ts     # 改：ToolCall、StreamEvent、Message 长出 tool_calls/tool_call_id
```

**你现在有一个能自己读文件回答问题的 agent。** 这是阶段 3 的分水岭意义：前两个阶段它只能说话。

## 为什么 dsh 把一次工具执行拆成三段事件

我们的执行是一行：

```ts
return await tool.execute(args)
```

dsh 是三个 waterfall 事件。把它们的 JSDoc 摆在一起看，设计意图非常清楚：

### `tools/pre-execute` —— 允许、拒绝，还是询问

> Allow, deny, or ask before dispatch. `next()` delegates to allow; **missing approval support turns `ask` into denial**. Async gates must observe `exec.signal`; the registry rechecks cancellation after they settle but never abandons their promise.

三个细节值得学：

- **`next()` 表示放行**——waterfall 的语义是"不调 `next()` 就短路"，所以一个什么都不做的监听器天然是放行的。
- **没有审批能力时，`ask` 退化成拒绝**（fail-closed）。如果一个部署没装审批插件，需要询问的工具直接不执行，而不是"没人管所以放行"。
- **异步的门必须观察 `exec.signal`**，但注册表**从不抛弃它们的 promise**——即使已经取消，也要等它们自己结束。这是"取消不等于忘记"，阶段 13 会讲。

### `tools/execute` —— 环绕式包裹

> Around-dispatch waterfall for timeout, retry, or metrics. `next()` returns a normalized result; **wrappers may change only `exec.signal`**, while call identity remains immutable. The registry **re-fuses the original caller signal before the body**, so replacement cannot detach caller cancellation.

这是三段里最精妙的一段：

- 包裹器**只能改 `exec.signal`**，调用的身份（名字、参数）不可变——所以超时插件能加一个 deadline，却不能偷偷改模型要读的文件。
- **注册表在执行工具体之前会把原始的调用方信号重新融合进去**。意思是：就算某个包裹器把 signal 换成了自己的，用户按 Ctrl-C 依然能中断工具。**这是防御性设计——不信任中间层会做对事。**

### `tools/post-execute` —— 接受、替换、丰富或拦下结果

> Accept, replace, enrich, or block a normalized dispatch result. `next()` accepts it unchanged; **thrown tools still reach this waterfall as errors**.

- **抛异常的工具也会走到这里**——所以日志、遥测、spill 不需要在两个地方各写一遍逻辑。
- 结果可以被**替换**：spill 策略正是在这里把超大输出转存并换成一个引用。

## 一行函数调用 vs 三段事件：到底买到了什么

| 关注点 | 关心的时刻 | 我们的做法 | dsh 的做法 |
|---|---|---|---|
| 权限审批 | 执行**之前** | 无 | `pre-execute` 监听器 |
| 执行超时 | 执行**期间** | 无 | `execute` 包裹器改 signal |
| 输出过大 | 执行**之后** | 硬编码 50KB 截断 | `post-execute` 替换成 spill 引用 |
| 遥测 / 日志 | 之后 | 无 | `post-execute` 监听器 |
| 循环卫生（重复调用提醒） | 之前 | 无 | `guard` 包挂 `pre-execute` |

**如果只有一个 `execute()` 函数**，这五个关注点只能：塞进函数体里（工具作者要懂权限和遥测）、或者塞进调用方（tool loop 变成一个什么都管的巨型函数）。

**拆成三段之后，每个关注点各挂一个监听器，互相不知道对方存在。** 加一个超时插件不需要改 tool loop，也不需要改任何工具。

这就是 dsh 那句"**新行为挂在文档化的扩展点上，而不是改 loop**"的具体含义。阶段 10 会正面讲 waterfall 的机制（`next()` 语义、短路、顺序），到时候回头看这三段会更清楚。

## 工程思维总结

### 1. 终止条件由模型决定时，必须外部兜底

`MAX_STEPS` 这行代码防的不是 bug，是**模型的正常行为**——它可能真的觉得还需要再读一个文件。agent 与普通程序的一个根本差别就在这里：**你调用的那个东西不保证会停。**

同类判断在后面会反复出现：上下文窗口（阶段 16）、并发工具数、子 agent 深度（阶段 17）。**凡是模型能自由决定次数的地方，都要有一个它够不着的上限。**

### 2. 失败要变成模型能读懂的输入

工具执行失败有两个可能的读者：**我们的错误处理代码**，和**模型**。选后者，因为模型能改正——换个路径、修个参数、换个方法。选前者只能中断会话。

这条推广开来：**在 agent 系统里，"错误"经常不是异常，而是一种需要被喂回去的信息。**

### 3. 半成品状态的代价随阶段递增

同一个主题第五次出现，而每一次丢掉的东西都更贵：

| 阶段 | 半成品 | 丢掉的代价 |
|---|---|---|
| 1.4 | 悬空 user 消息 | 一条消息 |
| 2.1 | 缺 `[DONE]` | 一段残缺文本 |
| 2.2 | 未终止残片 | 一个事件 |
| 2.3 | 断流半句话 | 用户看到的内容 |
| 3.4 | 悬空工具调用 | **几次工具执行 + 几轮推理** |

dsh 的应对也随之升级：前四个是"丢掉"，第五个变成了 `repair.ts` 的**确定性补齐**。**当丢弃的代价超过修复的复杂度时，就该换方案了**——这个判断点在阶段 12 会被正式讲。

## 阶段 3 学了什么

| 课 | 你现在应该能回答 |
|---|---|
| **3.1** | 工具调用在 wire 上长什么样；`arguments` 是字符串；`tool_call_id` 配对；**描述是提示词** |
| **3.2** | `id`/`name` 只在首块；按 `index` 用 Map 累积；收全靠协议信号；带标签联合让编译器收窄 |
| **3.3** | Tool 四件套；模型参数是不可信输入；输出是给模型看的；**失败变文本而非异常** |
| **3.4** | tool loop 就是"没工具就停"；终止条件必须外部兜底；悬空调用与回滚/补齐之争 |
| **3.5** | 三段事件容纳三类关注点；`ask` fail-closed；包裹器只能改 signal |

## 下一阶段的痛点预告

现在的 agent 只有一个 `read` 工具。你会立刻想加 `write`、`edit`、`bash`、`grep`——**而每加一个，`src/tool.ts` 里的手写校验就要复制一遍**。

更麻烦的是：`bash` 工具能执行任意命令。你真的要让模型无条件地跑 `rm -rf` 吗？

阶段 4 加工具集，也会第一次遇到"**这个工具该不该被允许执行**"——那是阶段 15 权限系统的种子。

## 本阶段的 debug 手法

| 手法 | 什么时候用 |
|---|---|
| 打印请求里的 `tools` 字段（3.1、3.3） | 模型不调工具——先确认它到底知不知道有工具 |
| 把每一片 `tool_calls` 增量原样打出来（3.2） | 参数 `JSON.parse` 失败——错的不是 parse，是前面某一片 |
| `console.dir(messages, { depth: null })`（3.4） | 供应商报 400——八成是 `tool_call_id` 配不上对 |
| 看那串重复的调用（3.4） | turn 不结束——模型陷在自己看不出来的环里 |

一条贯穿的规律：**工具相关的问题，九成能靠"把发出去的和收回来的原样打出来"定位。**

---

下一阶段：阶段 4 工具集与执行前后（进入前先在 [COURSE.md](../../../COURSE.md) 细化小课）
