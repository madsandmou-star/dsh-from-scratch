# 附录：dsh 0.1 → 0.2，它改了什么、为什么改

> 课程的参考版本从 `dsh-v0.1.0-rc.8`（commit `141eb6fef`，2026-08-19）升到了 `0.2.0-rc.2`（commit `639ed0153`，2026-09-29）。这一个多月里 dsh 改掉了好几处课程讲过的机制。这篇附录做两件事：告诉你**哪些课要回头重读**，以及 **dsh 每一处改动的理由**——理由尽量引 dsh 自己的设计笔记（`dsh/.agents/notes/`），笔记里没写的会明确标成"推测"。
>
> 读这篇不需要先学过阶段 9 之后的东西。

## 一、先看结论：哪些课要重读

### 必须重读（机制变了，旧说法是错的）

| 课 | 变了什么 | 读哪一段 |
|---|---|---|
| [2.4a 内存日志、落盘、和用户看到的东西](../02-streaming/04-stage-review/02-log-and-screen.md) | **整篇重写。** dsh 不再每个 token 写一条日志；流式碎片变成临时帧，一步结束时整条流压紧存进一条事件。"屏幕上有的一定在日志里"不再成立，改成靠结束帧对账 | 全篇 |
| [2.4 阶段验收](../02-streaming/04-stage-review/01-stage-review.md) | 原来的"原始增量要落盘"改成"原始增量要留档"，讲紧凑流怎么存 | "原始增量要留档"一节 |
| [附录：流式的四段链路](streaming-opencode-vs-dsh.md) | **结论反转。** 原来说"dsh 每个碎片都落盘、opencode 不落"，现在两边都不单独落盘，区别只剩收尾那条记录里有没有带时间的整条流 | "一句话总结"和"③ 落盘" |
| [附录：内存日志什么时候真的落盘](durability-checkpoints.md) | 攒批从共享 coordinator 挪到了每个写句柄里；卸载排干从"靠注册顺序"改成"不依赖顺序" | ① 和 ③ |
| [5.3 动态上下文不进 system prompt](../05-system-prompt/03-runtime-context/01-runtime-context.md) | dsh 的 system prompt 从 `request/header` 里的一个字段，挪成了独立的 `system/message` 事件；变化时可以追加在历史后面而不是改开头 | "对照 dsh"的 ③ |
| [5.4 谁能替换整个 prompt](../05-system-prompt/04-complete/01-complete.md) | persona 拆成前缀、后缀两个槽位；段落顺序改由中央表分配。**课程代码也改名了**（见下面第三节） | "对照 dsh"前半段 |
| [6.3 什么时候真的写到盘上](../06-session/03-durability/01-durability.md) | 批处理延迟从可配置变回常量，以及 dsh 为什么这么判断。**课程代码改名** `LIVE_WRITE_BATCH_MAX_DELAY_MS` | "对照 dsh"整节 |

### 快速过一遍（细节变了，结论没变）

| 课 | 变了什么 |
|---|---|
| 2.1、2.2、2.4b | dsh 等的终止标记从 `[DONE]` 换成了 `message_stop`；"没见到终止标记就报 `STREAM_CLOSED`"这条判断没变。引用的代码全部换成新版 |
| 3.2 | **更正一处旧错**：dsh 并不在某个工具调用参数收齐时就开始执行它，也是等整条流结束 |
| 3.4、3.5 | `repair.ts` 模块注释和 `tools/pre-execute` 的注释换成新版原文（多了一个 `cancel` 决定） |
| 4.1、4.3、4.4、4.5 | `replace_all` 的引导从提示词挪到了报错里；glob 超上限时可以按目录轮流取样；`str_replace_editor` 不再默认装配 |
| 6.1、6.2、6.4、6.5 | 引文、行数、对照表更新：持久化接口、默认 zstd、格式 v4 与升级链 |
| 7.1、7.3 | **更正一处旧错**：`- name: './hello.ts'` 出自 Cordis 教程，不是 dsh 的 base 装配；7.3 换成了 base 装配的真实开头 |
| 0.3、0.4 | 不再是"每个包都有 `invariant.ts`"，只剩 38 个 |
| 1.1、1.2、1.3 | `apiKeyEnv` 所在的包、内部词汇与线上格式的隔离、适配器的定位说法更新 |

### 不用重读

阶段 1 的主体、阶段 7–9 的主体。dsh 的 Cordis（`dsh/vendor/cordis/src/`）两个版本之间只差 3 行，我们照着它写的迷你版不受影响。

## 二、dsh 为什么这么改

每一条按同一个格式：**改了什么 → dsh 给的理由 → 付出的代价 → 值得带走的判断**。

### 1. 模型接口：从 Chat Completions 换成 Messages

**改了什么。** 0.1 和我们一样，走 DeepSeek 的 OpenAI 兼容接口 `/chat/completions`，流以 `data: [DONE]` 结束。0.2 只走 DeepSeek 的 Anthropic 兼容 Messages 接口（默认 `https://api.deepseek.com/anthropic`），流里每帧带名字（`message_start`、`content_block_delta`……），以 `message_stop` 结束。

**理由。** `dsh/.agents/notes/implemented/feature/2026-09-07-deepseek-messages-adapter.md`：

> Messages represents thinking, signatures, tool calls, tool results, and cumulative usage as native protocol fields. Translating only the endpoint or flattening assistant history loses information needed by subsequent tool turns.

Messages 协议把**思维链、思维链的签名、工具调用、工具结果、累计用量**都当作协议里的原生字段；换成别的格式或者把历史压扁，会丢掉后续工具轮次需要的信息。另一份笔记（`dsh/.agents/notes/implemented/simplification/2026-09-19-deepseek-messages-only.md`）解释了为什么不两个都留："Selecting a second transport duplicates serializers, stream handling, Files wire formats, configuration branches, and fixtures without adding a required capability to this route."——留第二套协议等于所有东西写两遍，却不带来这条线路需要的任何能力。

**代价。** 自定义的 `baseURL` 必须兼容 Messages 接口。

**带走的判断。** 1.2 讲的"内部词汇 ≠ 线上格式"在这里兑现了一次：线上协议整个换掉，dsh 改的是 `llm-deepseek` 包里的翻译层，agent 循环只认内部的 `StreamChunk`。**这一层隔离不是为了"也许哪天要换"，是真的换过。**

> 课程代码仍然用 `/chat/completions`。它依然可用，前两个阶段也是按它讲的；判断逻辑两边一样。

### 2. 流不再逐 token 写日志

**改了什么。** 0.1 每个流式增量是一条 `assistant/chunk` 事件。0.2（会话格式 v2）删掉了这个事件：碎片只作为进程内的临时帧（`agent/assistant-stream`）推给界面；一步结束时写**一条** `assistant/message`（成功）或 `assistant/attempt`（失败或被重试），里面的 `stream` 字段装着这一步的整条流——每块原文、每块到达时间，都能原样还原。

**理由。** `dsh/.agents/notes/implemented/architecture/2026-09-01-v2-embedded-assistant-streams.md` 两头都否掉了：

- 每块一条事件："repeats envelopes throughout persistence, telemetry, history transport, indexing, and client assembly"——每一块都要在持久化、遥测、历史传输、索引、界面组装里各背一份事件外壳。
- 只存组装好的消息："would ... lose failed and abandoned output, token boundaries, timestamps, and deterministic provider replay"——丢掉失败输出、token 边界、时间戳和可确定的重放。

规模有多大：dsh 记下的一个真实会话，旧格式下是约 **914 万**条逻辑事件，新格式下是 **72,784** 条（`dsh/.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md`）。

**代价。** 笔记原话："A hard process or host loss before settlement discards the complete in-flight stream; `agent/assistant-stream` is not a write-ahead log."——一步结束前进程被杀，这一步正在流的内容全丢。0.1 时这些碎片至少有一部分已经在日志里。

**带走的判断。** 要求（token 级、带时间、可还原）没变，变的是**表示**。先问"我到底需要保住哪些事实"，再问"用什么形状存最便宜"。一个事实不一定要对应一条事件。

### 3. system prompt 成为日志里的第 0 条消息

**改了什么。** 0.1 就已经把 system prompt 记进日志了，但放在 `request/header`（"这次请求用了什么配置"）的一个字段里。0.2（格式 v3）把它挪成独立的 `system/message` 事件，和 user、assistant、tool 消息并列在模型可见面上。

**理由。** `dsh/.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.md`："that layout leaves one model-visible fact with two homes"——一个模型可见的事实有两个家。压缩、token 计数、界面、快照测试，每个想知道"模型看到了什么"的地方都得自己去两处拼。

它还为下一步铺路（`dsh/.agents/notes/implemented/feature/2026-09-02-in-history-system-prompt-replacement.md`）："Every system prompt change costs the whole provider prefix cache."——system prompt 一变，服务商的前缀缓存从第一个 token 就失效。有的模型支持在对话中间追加一条 system 消息来替换前面的；有了 `system/message`，dsh 就能在这种模型上**把新 prompt 追加在已缓存的历史后面**，缓存不失效。

**带走的判断。** 5.3 我们把"当前时间"挪出 system prompt、追加在后面，是为了保住缓存前缀；dsh 把同一个思路用到了 system prompt 本身。**会变的东西追加在后面，不改前缀**——这条贯穿了 5.3、5.4 和这一条。

### 4. persona 拆成前缀和后缀

**改了什么。** 0.1 只有一个 `deployment:persona` 段落。0.2 有 `deployment:persona-prefix`（order 0）和 `deployment:persona-suffix`（order 10200，最后）。

**理由。** `dsh/.agents/notes/implemented/bug-fix/2026-09-06-environment-prompt-suffix.md`：本机 Web 地址、dsh 源码路径、工作目录这些**每台机器都不同**的事实，放在前面会让所有人本来相同的提示词很早就分叉，"limiting the prefix available for same-model cache reuse"。所以 dsh 自带的装配把"你是谁"放前缀，只把 `Your working directory is {{cwd}}.` 放后缀。

**带走的判断。** 还是缓存前缀。一段文字该放前面还是后面，不只看"读起来顺不顺"，还要看"它在不同用户之间是不是一样"。

### 5. 段落顺序改由中央表分配

**改了什么。** 0.1 里每个插件自己写 `order: 102` 这样的数字；0.2 统一调 `ctx.systemPrompt.getSectionOrder('TOOL_EDIT')`，从 `SECTION_ORDERS` 这张表里查。

**理由。** `dsh/.agents/notes/archived/architecture/2026-08-25-sparse-first-party-prompt-section-orders.md`：二十多个包各写各的数字，两个段落撞上同一个 order 时，排序的平局由**插件启动顺序**决定——"clean compositions can activate the same plugins in different orders and produce different request headers and snapshot results"。同一份装配跑两次，发给模型的提示词可能不一样。

**带走的判断。** 8.2 我们刚学过"插件并发启动、顺序由依赖决定而不是由位置决定"。这条 bug 就是它的反面：**凡是结果依赖"谁先启动"的地方，都是不确定性的来源**。解法是把"谁在前"从分散的约定收成一个地方的数据。

### 6. 持久化接口重做：句柄、尽力写、耐久屏障

**改了什么。** 0.1 有一个共享的 coordinator 订阅所有会话事件、自己猜每个会话归谁，服务上有十二个方法。0.2 变成五个方法加"每个会话一个句柄"：`create` / `open` 拿到 `SessionHandle`，句柄上 `append` 只是尽力写，`flush` 才保证落盘，`close` 排干并释放写权。

**理由。** `dsh/.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.md`："The previous persistence seam owned far more than storage"——旧接口把存储、会话构造、崩溃修复、缓存搅在一起，而且"nothing excluded a second writer"（没有东西能阻止第二个写者）。下一步要做跨进程的写权，而"ownership belongs to an explicit per-session channel with an owner, not to a global listener"——写权应该属于一个有主人的、每个会话一条的通道，而不是一个全局监听器。

**代价。** 后端插件在会话还活着时被重载，旧句柄会失效，写入会大声报错（原来是悄悄重新认领）。

**带走的判断。** "谁拥有它"要有一个明确的交接点，而不是事后去猜。这是 9.1 那句"注册即效果"在资源所有权上的同一个形状：拿到句柄的人负责关掉它。

### 7. 批处理延迟从配置收回成常量

**改了什么。** 0.1 的 `writeBatchMaxDelayMs` 可以在 `cordis.yml` 里改；0.2 是 JSONL 提供者里的常量 `LIVE_WRITE_BATCH_MAX_DELAY_MS = 200`。

**理由。** 同一份持久化笔记，否掉"持久化自带批处理配置"时写的是："the batching window is internal write-path scheduling, not a deployment-varying choice"——它是写路径内部的调度，不是随部署变化的选择。正确性全靠 `flush` 和检查点，200ms 只影响写盘次数。

**带走的判断。** 4.2 学的规矩是"随部署变化的选择必须是配置"。它的另一半同样重要：**不随部署变化的东西不该做成配置**。每多一个旋钮，就多一种部署方可能拧错的方式。

### 8. 卸载时的排干不再依赖注册顺序

**改了什么。** 0.1 的 coordinator 故意先注册 disposer、后注册监听器，利用"拆卸按注册反序"让监听器先关。0.2 的 `close()` 一直排到缓冲为空，关掉的句柄从路由表里删掉，之后来的事件直接查不到。

**理由。** 持久化笔记："Root-fiber disposal runs every fiber's disposers concurrently"——整个应用关闭时，所有插件的 disposer 并发执行。一个插件内部把顺序排对了，管不住别的插件还在往里写。

**带走的判断。** 这是阶段 9 马上要讲的东西。"注册顺序即拆卸顺序"只在**一个插件内部**成立；跨插件的时候，要靠"做完一轮还有就再做一轮"这种不依赖顺序的写法。

### 9. 旧日志不再直接拒绝，而是逐级升级

**改了什么。** 会话格式到了 v4。0.1 时代的思路是"版本不对就拒绝"；0.2 有 `session-format-v0-to-v1` 到 `v3-to-v4` 四个相邻升级包，旧日志读的时候逐级升上来，**原文件不动**，另存一份新版本。

**理由。** `dsh/.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md` 第一句："Session format v0 shipped in an alpha release, so a structural writer change can no longer treat existing JSONL as disposable pre-release state."——v0 已经随 alpha 版发出去了，用户手里有真实会话，不能再当成可以扔掉的预发布数据。

**带走的判断。** 6.4 我们学的是"拿不准就加版本号"。版本号只解决"认出来"；一旦有了真实用户，还得解决"认出来之后怎么办"。**格式一旦发布，就成了你对用户的承诺。**

### 10. 运行时不变量从"每个包都有"收缩到 38 个

**改了什么。** 0.1 要求每个包都发布一个 `invariant.ts`（226 个）；0.2 只留 38 个。

**理由。** `dsh/.agents/notes/implemented/simplification/2026-08-28-omit-unneeded-invariant-companions.md`：当时有 209 个"说明为什么是空的"空壳检查，"That machinery expressed a negative conclusion without adding a runtime assertion"——一大堆机制只是在说"这里没什么可查"。新规矩：只有几份**独立产生的观测可能对不上**时才写不变量。

**带走的判断。** 检查也有成本。"每个都要有"的规则很容易执行，但会产出大量不检查任何东西的检查。

### 11. 删掉 agent-spine-demo

**改了什么。** `packages/examples/agent-spine-demo` 整个删除；想看最小的完整装配，看 `dsh/packages/bundle/sdk-minimal/cordis.patch.yml`。

**理由。** `dsh/.agents/notes/archived/simplification/2026-08-26-remove-agent-spine-demo.md`：这个包名义上是示例，实际导出了一个公共的组合插件，"one plugin row hid the mandatory agent runtime"——一行就把整个必需的 agent 运行时藏起来了，而且和 `dsh-base` 重复了一份组合策略。现在 `sdk-minimal` 把每一行都写出来，变长了，但每个插件都看得见、能被 patch。

**带走的判断。** 7.3 我们把装配收进 `corePlugins` 一个数组；dsh 走得更远，连"一行代表一整套"都拆开了。**省字不等于清楚。**

## 三、课程代码跟着改了什么

按"命名向 dsh 看齐"的约定，这三个名字改了，讲义里的代码同步更新：

| 旧名字 | 新名字 | 出现在哪几课 |
|---|---|---|
| `WRITE_BATCH_MAX_DELAY_MS` | `LIVE_WRITE_BATCH_MAX_DELAY_MS` | 6.3 |
| `PERSONA_SECTION`（值 `'deployment:persona'`） | `PERSONA_PREFIX_SECTION`（值 `'deployment:persona-prefix'`） | 5.4、7.1、7.3、9.1 |
| `suppressContext()` | `suppressRuntimeContext()` | 5.4 |

行为没有变，所有演示照常跑。

课程代码**没有**跟着换协议，仍然用 `/chat/completions` 和 `[DONE]`：接口仍然可用，阶段 1–3 的讲义和演示都建立在它上面，而"必须看到终止标记"这类判断两种协议完全一样。

## 四、这一次升级本身教了什么

路径检查只抓到了 4 处失效，真正要改的有几十处：**路径还在，说法已经错了。** 文件没删，里面的机制换了；函数名还在，注释的原文改了；数字没报错，但已经从 226 变成 316。所以课程的规矩里加了一条：升级之后要逐条复核对 dsh 的描述，而且每进入一个新阶段先升到上游最新版。
