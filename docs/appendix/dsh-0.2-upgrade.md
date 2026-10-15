# 附录：dsh 0.1 → 0.2，它改了什么、为什么改

> 课程的参考版本从 `dsh-v0.1.0-rc.8`（commit `141eb6fef`，2026-08-19）升到了 `0.2.0-rc.2`（commit `639ed0153`，2026-09-29）。这一个多月里 dsh 改掉了好几处课程讲过的机制。这篇附录做两件事：告诉你**哪些课要回头重读**，以及 **dsh 每一处改动的理由**——理由尽量引 dsh 自己的设计笔记（`dsh/.agents/notes/`），笔记里没写的会明确标成"推测"。
>
> 之后参考版本又升了两次：`0.2.1-alpha.1`（commit `5badb1500`，2026-10-03，第五节）和 `0.2.1-alpha.3`（commit `571902028`，2026-10-14，第六节）。**只想知道最近这一次改了什么，看文末的第六节；想把三次升级要重读的课一起过一遍，按下面的"重学路线"走。**
>
> 读这篇不需要先学过阶段 9 之后的东西。

## 重学路线：三次升级合并成一条

三次升级（rc.8 → 0.2.0-rc.2 → 0.2.1-alpha.1 → 0.2.1-alpha.3）要重读的课，按主题排成一条路线。前一单元是后一单元的铺垫，按顺序走最省力。最后一列指向下面第二、五、六节里"dsh 为什么这么改"的对应条目。

| 单元 | 主题 | 读哪几段 | 为什么改 |
|---|---|---|---|
| 1 | 流怎么算结束 | [2.1](../02-streaming/01-what-is-sse/01-what-is-sse.md) "`[DONE]` 缺失意味着什么"；[2.2](../02-streaming/02-read-stream/01-read-stream.md) "对照 dsh"；[2.4b](../02-streaming/04-stage-review/03-stream-end-detection.md) "dsh 的解法：空闲看门狗"和新加的"光喊停不够" | 第二节 1、第六节 4 |
| 2 | 流怎么留档、屏幕怎么对账 | [2.4](../02-streaming/04-stage-review/01-stage-review.md) "原始增量要留档"；[2.4a](../02-streaming/04-stage-review/02-log-and-screen.md) 全篇（`append()` 那段多了 `commit()`）；[3.2](../03-tool-loop/02-accumulate/01-accumulate.md) "第三行要看清楚"及后面的"准备中" | 第二节 2、第五节 2、第六节 5 |
| 3 | opencode 和 dsh 在流式上的取舍 | [附录：流式的四段链路](streaming-opencode-vs-dsh.md) 全篇 | 第二节 2 |
| 4 | system prompt 怎么记、怎么排 | [5.1](../05-system-prompt/01-assembly/01-assembly.md) 对照表"变量"一行；[5.2](../05-system-prompt/02-variables/01-variables.md) "对照 dsh"；[5.3](../05-system-prompt/03-runtime-context/01-runtime-context.md) "对照 dsh" ①③④；[5.4](../05-system-prompt/04-complete/01-complete.md) "对照 dsh"前半段；[5.5](../05-system-prompt/05-stage-review/01-stage-review.md) 工程思维第 1 条；代码改名 `PERSONA_PREFIX_SECTION`、`suppressRuntimeContext()` | 第二节 3、4、5，第六节 1 |
| 5 | 什么时候真的落盘 | [6.2](../06-session/02-persistence/01-persistence.md) 会话头的 `version` 和 `cwd`；[6.3](../06-session/03-durability/01-durability.md) "对照 dsh"；[附录：内存日志什么时候真的落盘](durability-checkpoints.md) ① ③；[6.4](../06-session/04-repair/01-repair.md) 最后两节和对照表；[6.5](../06-session/05-stage-review/01-stage-review.md) ⑥ 和对照表；代码改名 `LIVE_WRITE_BATCH_MAX_DELAY_MS` | 第二节 6–9，第六节 2、3 |
| 6 | 检查放在哪里 | [0.3](../00-env-basics/03-debug/01-debug.md) 第五节；[0.4](../00-env-basics/04-stage-review/01-stage-review.md) 第 4 点；[4.4](../04-tools/04-pipeline/01-pipeline.md) "规矩一"里的四种决定和"对照 dsh" ② | 第二节 10、第五节 1、第六节 5 |
| 7 | 零散更正 | 3.4、3.5 的 dsh 引文；4.1 `replace_all`；4.3 glob 取样；4.5 `str_replace_editor` 改为显式加装；7.1、7.3 `hello.ts` 的出处；1.1–1.3 适配器与 `apiKeyEnv`；0.1 的 tsx 出处；[9.1](../09-effects/01-effect/01-effect.md) 对照表"一个插件的多个 effect""失败隔离"两行 | 第二节 11、第六节 5 |

不在路线上的课不用重读：阶段 1 主体、阶段 7–9 主体（dsh 的 Cordis 源码在三次升级里只有几处和本课程无关的小改动；9.1 对照表那两行是课程自己读错了，不是 Cordis 变了）。

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
| 0.3、0.4 | 不再是"每个包都有 `invariant.ts`"，只剩 38 个（0.2.1 又整套删除，见第五节） |
| 1.1、1.2、1.3 | `apiKeyEnv` 所在的包、内部词汇与线上格式的隔离、适配器的定位说法更新 |

### 不用重读

阶段 1 的主体、阶段 7–9 的主体。dsh 的 Cordis（`dsh/vendor/cordis/src/`）两个版本之间只差 3 行，我们照着它写的迷你版不受影响。

## 二、dsh 为什么这么改

每一条按同一个格式：**改了什么 → dsh 给的理由 → 付出的代价 → 值得带走的判断**。

### 1. 模型接口：从 Chat Completions 换成 Messages

**改了什么。** 0.1 和我们一样，走 DeepSeek 的 OpenAI 兼容接口 `/chat/completions`，流以 `data: [DONE]` 结束。0.2 只走 DeepSeek 的 Anthropic 兼容 Messages 接口（默认 `https://api.deepseek.com/anthropic`），流里每帧带名字（`message_start`、`content_block_delta`……），以 `message_stop` 结束。

**理由。** `dsh/.agents/notes/implemented/feature/2026-09-07-deepseek-messages-adapter.md`：

> Messages represents thinking, signatures, tool calls, tool results, and cumulative usage as native protocol fields. Translating only the endpoint or flattening assistant history loses information needed by subsequent tool turns.

Messages 协议把**思维链、思维链的签名、工具调用、工具结果、累计用量**都当作协议里的原生字段；换成别的格式或者把历史压扁，会丢掉后续工具轮次需要的信息。另一份笔记（`dsh/.agents/notes/archived/simplification/2026-09-19-deepseek-messages-only.md`）解释了为什么不两个都留："Selecting a second transport duplicates serializers, stream handling, Files wire formats, configuration branches, and fixtures without adding a required capability to this route."——留第二套协议等于所有东西写两遍，却不带来这条线路需要的任何能力。

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

**理由。** `dsh/.agents/notes/archived/bug-fix/2026-09-06-environment-prompt-suffix.md`：本机 Web 地址、dsh 源码路径、工作目录这些**每台机器都不同**的事实，放在前面会让所有人本来相同的提示词很早就分叉，"limiting the prefix available for same-model cache reuse"。所以 dsh 自带的装配把"你是谁"放前缀，只把 `Your working directory is {{cwd}}.` 放后缀。

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

**后续。** 0.2.1-alpha.3 又改了一次：连"一个插件内部"都要打折扣——同一个插件的多个 effect 卸载时是并发启动的；dsh 把"先撤服务、等消费者收尾 → 摘监听器 → 排干关句柄"写进同一个生成器 effect，顺序才真正成立。见第六节 3。

### 9. 旧日志不再直接拒绝，而是逐级升级

**改了什么。** 会话格式到了 v4。0.1 时代的思路是"版本不对就拒绝"；0.2 有 `session-format-v0-to-v1` 到 `v3-to-v4` 四个相邻升级包，旧日志读的时候逐级升上来，**原文件不动**，另存一份新版本。

**理由。** `dsh/.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md` 第一句："Session format v0 shipped in an alpha release, so a structural writer change can no longer treat existing JSONL as disposable pre-release state."——v0 已经随 alpha 版发出去了，用户手里有真实会话，不能再当成可以扔掉的预发布数据。

**带走的判断。** 6.4 我们学的是"拿不准就加版本号"。版本号只解决"认出来"；一旦有了真实用户，还得解决"认出来之后怎么办"。**格式一旦发布，就成了你对用户的承诺。**

**后续。** 正因为每加一次版本都要多一个永久的升级包，0.2.1-alpha.3 把"拿不准就加"这条建议撤掉了，判据换成"已发布的老读者实际会怎么做"。见第六节 2。

### 10. 运行时不变量从"每个包都有"收缩到 38 个

**改了什么。** 0.1 要求每个包都发布一个 `invariant.ts`（226 个）；0.2 只留 38 个。

**理由。** `dsh/.agents/notes/archived/simplification/2026-08-28-omit-unneeded-invariant-companions.md`：当时有 209 个"说明为什么是空的"空壳检查，"That machinery expressed a negative conclusion without adding a runtime assertion"——一大堆机制只是在说"这里没什么可查"。新规矩：只有几份**独立产生的观测可能对不上**时才写不变量。

**带走的判断。** 检查也有成本。"每个都要有"的规则很容易执行，但会产出大量不检查任何东西的检查。

**后续。** 一个月后，0.2.1-alpha.1 把剩下的 38 个连同注册表一起删了，见第五节。

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

## 五、再升一次：0.2.0-rc.2 → 0.2.1-alpha.1

> 参考版本从 `0.2.0-rc.2`（commit `639ed0153`，2026-09-29）升到 `0.2.1-alpha.1`（commit `5badb1500`，2026-10-03）。上游这几天有 202 个提交、4190 个文件变动，但大部分落在设计笔记的归档整理（约 1700 个文件）、Web 界面（`packages/client`，约 460 个）和实验包上。**和课程有关的只有两件事**，外加几处数字和三份设计笔记挪进了 `archived/`。

### 要重读的课

| 课 | 变了什么 | 程度 |
|---|---|---|
| [0.3 debug](../00-env-basics/03-debug/01-debug.md) | 第五节重写：dsh 删掉了整套运行时不变量；原来说"dsh 把它做成了常驻的检查"**本来就不准确**（见下面第 1 条） | 必须重读第五节 |
| [4.4 执行前后](../04-tools/04-pipeline/01-pipeline.md) | "对照 dsh"的 ②：三段事件的顺序现在靠结构和测试保证，不再有运行时断言 | 必须重读 ② |
| [3.2 累积工具调用](../03-tool-loop/02-accumulate/01-accumulate.md) | 新增：dsh 怎么处理"等整条流结束"这段等待（"准备中"），以及参数生成顺序的实测 | 新内容，建议读 |
| [0.4 阶段验收](../00-env-basics/04-stage-review/01-stage-review.md) | 第 4 点改写 | 快速过 |
| [opencode 与 dsh 的体量对比](opencode-vs-dsh.md)、[流式的四段链路](streaming-opencode-vs-dsh.md) | 提到 runtime invariant 的几句标注为历史；体量表加了一列 | 快速过 |

其余的课不用动：会话、流式、system prompt、持久化、Cordis 这几块的源码在这次升级里没有变化（Cordis 只改了版本号）。

### 1. 运行时不变量整套删除

**改了什么。** `@deepseek-ai/dsh-invariants` 注册表、每个包的 `./invariant`（还剩 38 个）、相关的门禁和测试装置全部删除；dsh 的 AGENTS.md 里那条 "Runtime invariants assert owned relationships" 也一起删了。提交 `f028f25667`（"refactor: remove runtime invariant plugins"），升级指南 `dsh/docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md`。

**理由。** **dsh 没有写下这一次删除的理由**——提交信息只列了删了什么，升级指南只讲怎么迁移。但前面两步是有记录的，连起来能看清走向：

- 2026-08-03，`dsh/.agents/notes/archived/simplification/2026-08-03-omit-invariants-from-shipped-config.md`：先从正式发布的装配里拿掉。它们被定性为 "optional development diagnostics"；当时的问题是终端版装了它们而 Web 版没装，"A relational assertion failure could terminate an ordinary TUI run even though the always-on product boundary remained responsible for session validation and immutable history"——一次关系断言失败就能让用户正常使用的终端版直接退出，而真正一直负责会话校验和历史不可变的，本来就是产品入口那一层。
- 2026-08-28：从"每个包都要有"收缩到"只在独立观测可能对不上的地方写"（第二节第 10 条）。
- 2026-09-30：剩下的全部删除。

**代价。** 少了一层"在测试里顺带交叉核对"的保险。原来几个事件派发点（比如 `llm/adapters-updated`）为 `INVARIANT` 错误留了专门的"重新抛出"分支，现在这些分支也删了，监听器的错误一律记日志、不再往外抛。

**带走的判断。**（教师判断，不是源码事实。）一直开着的保证，dsh 放在了两个地方：**数据进门的那一刻**（`Session.append()` 先校验再写入，0.3 第五节）和**测试**（4.4 第 ② 点那条顺序断言）。放在旁边事后核对的检查，一开始是"越多越安全"，后来发现大部分什么都不查，再后来发现它会把开发期的诊断变成用户那边的崩溃，最后整个拿掉。**检查的价值取决于它放在哪里，不取决于有多少条。**

### 2. 工具参数边流边读，以及"参数顺序"这件事

**改了什么。** 界面在工具调用的参数还在流的时候，就按字段读出来显示："准备中"的 `write`/`edit` 行一旦 `file_path` 收全就显示路径，`bash` 先显示 `description`。`bash` 的描述和 `edit` 的 `file_path` 描述里各加了一句"请先写某个参数"。

**理由。** `dsh/.agents/notes/implemented/architecture/2026-09-22-tool-call-three-phases.md`：`tool/call` 要等整条流结束才出现，"File content is part of the arguments to `write`, so this delay can last several seconds"——要写的文件内容本身就在参数里，这段空白可能长达几秒，界面上什么都不显示。`dsh/.agents/notes/implemented/architecture/2026-09-24-preparing-tool-arguments.md` 补上了"边流边按字段读"，并记录了一个实测：对真实的 DeepSeek V4 接口做 310 次对照请求，**只调 JSON Schema 里 `properties` 的顺序没用（0/40），模型跟的是 `required` 的顺序**，Flash 模型还要在描述里明说一句。

**带走的判断。** 3.2 讲过"协议给了能力，不等于产品就要用"：dsh 仍然没有提前执行工具，它选择把等待**显示出来**，而不是**缩短**。另外，工具定义里字段的顺序会影响模型生成参数的顺序——这是 4.x 写工具时容易忽略的一个面。

### 3. 其他

- 三份课程引用的设计笔记从 `implemented/` 挪进了 `archived/`（`deepseek-messages-only`、`environment-prompt-suffix`、`omit-unneeded-invariant-companions`），引用路径已更新。按 dsh 的规矩，归档笔记是冻结的历史记录，不再代表当前的权威说法；我们引用它们，正是为了讲"当时为什么那么改"。
- 数字：包 316 → 319，包组 55 → 54（删掉了运行时诊断那一组），`core/session` 3421 → 3153 行，`session/` 17863 → 17705 行，`agent-loop` 2490 → 2425 行。`core/` 少掉的 644 行里有 585 行是被删的不变量文件。

### 这一次升级本身教了什么

这次三套机械检查（路径、引文、标识符）一共只报了 5 处，全部指向同一件事：不变量被删。真正多出来的发现来自去读那几份设计笔记：**0.3 原来写的"dsh 把它做成了常驻的检查"在上一个版本就已经不对了**——它们 8 月起就不在正式装配里跑。**"代码存在"和"代码在用户那边运行"是两件事**，对照源码时两者都要核实。

## 六、第三次升级：0.2.1-alpha.1 → 0.2.1-alpha.3

> 参考版本从 `0.2.1-alpha.1`（commit `5badb1500`，2026-10-03）升到 `0.2.1-alpha.3`（commit `571902028`，2026-10-14）。上游这 11 天有 1161 个提交、5281 个文件变动，大头在 Web 界面（`packages/client`，867 个文件）、快照（721）和实验包（545）。**和课程有关的是四件事**，外加几处课程自己的旧错——这次多加了一道检查才把它们找出来。

### 要重读的课

| 课 | 变了什么 | 程度 |
|---|---|---|
| [5.3 动态上下文不进 system prompt](../05-system-prompt/03-runtime-context/01-runtime-context.md) | 新增"对照 dsh"④：工作目录、Web 地址、源码路径全部搬出 system prompt；`required`、`interpolate: false`、发请求前再刷新。另更正一处旧错：快照消息的来源标记早就是 `{ kind: 'runtime-context', … }` 了 | 必须重读 ④ |
| [5.5 阶段验收](../05-system-prompt/05-stage-review/01-stage-review.md) | 工程思维第 1 条补了 dsh 这个反例：判据没错，错在对"寿命"的估计 | 必须重读第 1 条 |
| [6.4 坏了怎么办](../06-session/04-repair/01-repair.md) | "格式版本什么时候必须加"重写：判据从"写出来的东西变没变"换成"已发布的老读者实际会怎么做"；`ignorable` 一节加了插件记录 | 必须重读最后两节 |
| [附录：内存日志什么时候真的落盘](durability-checkpoints.md) | ③ 重写：拆卸顺序从"不依赖顺序"变成"把顺序组合出来"，以及 Cordis 卸载为什么是并发的 | 必须重读 ③ |
| [9.1 注册了就撤不回来](../09-effects/01-effect/01-effect.md) | **旧错**：对照表说 dsh 的 effect "有失败隔离"——同一个 effect 里其实没有；另加一行"一个插件的多个 effect 卸载时并发启动"。9.2 要用 | 必须重读对照表 |
| [2.4b 流到底怎么算结束](../02-streaming/04-stage-review/03-stream-end-detection.md) | 新增"光喊停不够"：看门狗超时后自己也不再等 | 建议读 |
| [5.1](../05-system-prompt/01-assembly/01-assembly.md)、[5.2](../05-system-prompt/02-variables/01-variables.md)、[5.4](../05-system-prompt/04-complete/01-complete.md) | 循环不再提供 `{{cwd}}`；dsh 段落和动态上下文都能声明不插值；persona 后缀现在是空的 | 快速过 |
| [6.2](../06-session/02-persistence/01-persistence.md)、[6.5](../06-session/05-stage-review/01-stage-review.md) | 会话头的 `cwd` 是"最初的项目"，和会话里可以换的工作目录分开了；⑥ 跟着 6.4 改 | 快速过 |
| [0.3](../00-env-basics/03-debug/01-debug.md)、[2.4a](../02-streaming/04-stage-review/02-log-and-screen.md) | `append()` 把入库那几步拆进了私有方法 `commit()`，顺序没变 | 快速过 |
| [4.4 执行前后](../04-tools/04-pipeline/01-pipeline.md) | **旧错**：`tools/pre-execute` 是四种决定（多一个 `cancel`），不是三档；引文换成完整原句 | 快速过 |
| [0.1 Node 与 pnpm](../00-env-basics/01-node-pnpm/01-node-pnpm.md) | **旧错**：`node --import tsx/esm` 的出处是 dsh 的 AGENTS.md 和一份设计笔记，不是 `development.md`；workspace 那段 YAML 标成节选；包组 54 → 52 | 快速过 |

### 1. 工作目录、Web 地址、源码路径搬出 system prompt

**改了什么。** 新包 `dsh/packages/session/working-directory/` 给每个会话管一个"当前工作目录"：它是一条日志里的状态（`working-directory/change` 事件），会话中途可以换（配套的 `working_directory` 工具），模型通过一条**必需的**运行时上下文看到它（`Current working directory: "…".`）。循环不再注册 `{{cwd}}` 变量，所有自带装配里的 `Your working directory is {{cwd}}.` 都删了。10 月 11 日，dsh 源码路径和 Web 界面地址也挪进了运行时上下文。`systemPrompt` 跟着多了三样东西：上下文可以标 `required`（关掉动态上下文时照发）、可以标 `interpolate: false`（目录名里的 `{{` 不当变量）、每次发请求前 `refreshContext()` 重新读一遍注册的上下文。

**理由。** 三份笔记，按时间排正好是一次"改主意"：

- 2026-09-06（`dsh/.agents/notes/archived/bug-fix/2026-09-06-environment-prompt-suffix.md`）：这些值每台机器都不一样，放在开头会让提示词"diverge near their beginning"，所以挪到 system prompt **末尾**。当时否掉了"挪进运行时上下文"："That changes their message role and persistence placement rather than only separating system sections."
- 2026-09-13（`dsh/.agents/notes/implemented/architecture/2026-09-13-session-working-directory.md`）：一个任务可能在对话中途换检出目录，固定的创建目录表达不了；"Putting mutable directory information in the system prompt changes the reusable prompt prefix."——被否掉的方案正是"Keep directory text in the system prompt"，理由："Mutable operational context belongs after retained history, using the same user-context mechanism as permission state."
- 2026-10-11（`dsh/.agents/notes/implemented/bug-fix/2026-10-11-process-specific-prompt-values-in-runtime-context.md`）：Desktop 每次启动端口随机，换检出目录、换安装方式也会让源码路径变。续聊时 system prompt 重新渲染，文字变了；在不支持"历史中间插 system 消息"的线路上，这会改写开头那个 system 节点，而 Claude 把历史思维块的签名绑在包括 system prompt 在内的前缀上，于是直接返回 400，环境恢复原样之前会话续不上。老会话为了不改写开头，靠一个投影把日志里旧格式的段落原样保留。

**代价。** 运行时上下文多了几行；自定义 persona 里要是还写着 `{{cwd}}`，组装会直接报错（`dsh/packages/core/system-prompt/README.md` 专门写了迁移说明）；工作目录和原始目录都没了的时候，所有模型请求都会被拒绝，要人工恢复。

**带走的判断。** 第一步优化的是**跨机器**的前缀复用，后两步撞上的是**跨时间**：同一个会话的两次请求之间，值变了。5.5 那条"一句话放在哪里，取决于它随谁生灭"没有错，错在对寿命的估计——会话会中途换目录，会跨进程续聊，进程里的值活不到那时候。

### 2. 格式版本：从"拿不准就加"到"看老读者实际怎么做"

**改了什么。** `SESSION_FORMAT_VERSION` 的注释整段重写（`dsh/packages/core/session/src/types.ts`）。旧的："bump exactly when an older runtime could no longer handle a new log with full semantic correctness"，外加 "When in doubt, bump"。新的："Retain it when older readers resume correctly, preserve safely ignorable records, or refuse required features before execution, mutation, or tail repair. ... Bump when an existing discriminator cannot prevent unsafe interpretation; a structural difference alone is insufficient."

**理由。** `dsh/.agents/notes/implemented/process/2026-10-08-session-reader-compatibility-review.md`。两个方向：加版本不便宜——"A global bump also excludes feature-free sessions and requires a new generation and adjacent migration"；"不认识就会拒绝"也不是自动成立的——"permissive readers can ignore required meaning, and recovery can mistake unsupported records for damaged tails"。所以要拿出已发布读者实际行为的证据，不能从 schema 差异推。笔记说明这条决定只改审查和确认的流程，不改运行时的准入、诊断、编解码和迁移行为。

**带走的判断。** "往安全那边偏"本身也要算账。旧规则把加版本的代价估成"几乎免费"，新规则把账算全了：多一代格式、一个永久维护的升级包、把老读者挡在所有新会话门外。保护老读者的不是版本号，是老读者在动手之前会不会停下来。

### 3. 持久化插件：拆卸顺序靠"组合"

**改了什么。** JSONL 持久化从"一个服务类"改成函数插件（`name`/`Config`/`apply`）。`apply()` 用一个生成器 effect 把三件事排成一条链：先挂监听器和句柄，再挂真正提供 `sessionPersistence` 的子插件；卸载时倒过来——先撤服务、**等所有注入了它的插件收尾完**，再摘监听器，最后排干、关句柄。`close()` 里"排到空为止"的循环保留。

**理由。** 提交 `4d9047be2d`（"fix(session): retain JSONL resources through provider-triggered teardown"）和包的 README："Unloading the backend waits for the consumer unloads it triggers through `sessionPersistence` injection before removing live-event listeners and draining and closing remaining handles." 配套测试是一个在异步收尾里才追加 `turn/end` 的消费者，要求这条事件落盘。为什么不靠注册顺序：一份提案笔记（`dsh/.agents/notes/proposed/architecture/2026-10-09-cordis-cleanup-dependency-lifetimes.md`）审了全仓库同类问题，原话 "reverse invocation still starts sibling async cleanup concurrently"——Cordis 卸载一个插件时，它身上的 effect 是用 `Promise.all` 同时启动的。

**代价。** 只覆盖"撤掉这个服务"触发的卸载。README 写明 "Concurrent root disposal is not ordered"；提案笔记把"整个应用关闭时，循环收尾发出的最后几条事件可能丢"列为 P0，还没修。

**带走的判断。** 要让 B 等 A 收完，把它们放进同一个 effect 里 `yield`，别指望注册的先后；规则是笔记里那句 "Stop admitting new work, settle accepted work and final publication, then drain and release the resource."——9.2 讲卸载时会正面用到。

### 4. 空闲看门狗自己也"不等了"

**改了什么。** `idleWatchdog().next()` 现在拿 `iterator.next()` 和一个到期 promise 去 `Promise.race`；适配器收尾时不再 `await iterator.return()`，改成丢出去不等。

**理由。** `dsh/packages/util/timeout/src/index.ts` 的注释："A transport can leave a read it aborted pending forever (undici drops the error when the abort lands on an in-flight body read)"。timeout 库的设计笔记原本否掉过"拿定时器去 race"（race 赢了，底层的活还在跑），这次改成 "`idleWatchdog` is the deliberate exception, and only for the single iterator demand it drives"。

**带走的判断。** "只发信号、让干活的一方自己停"是对的默认；但当对方可能永远不停时，等待的一方得自己有一个能真正结束的期限。两条不矛盾：信号负责释放资源，期限负责结束等待。

### 5. 其他

- `Session.append()` 拆出两个私有方法：`publicationEntry()`（重入检查）和 `commit()`（surface 校验 → 固定订阅者 → 入库 → 广播），新的插件记录（`appendPluginRecord()`，只许 `packages/experimental/` 调用）走同一个 `commit()`。插件记录的理由在 `dsh/.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`：实验包的状态如果声明成正式事件，就是"必需"的，没装那个实验包的版本会拒绝整个会话。
- 数字：包 319 → 336（`experimental/` 从 24 个到 46 个，hooks、webhook、ralph 等一批包挪了进去），包组 54 → 52，`src/` 41.3 万 → 43.2 万行，`core/session` 3153 → 3324 行，`session/` 20 个包 17705 行 → 21 个包 18185 行，`system-prompt/src/index.ts` 638 → 691 行。
- 四处课程旧错（不是这次 dsh 改的，是这次复核时才发现的）：5.3 的来源标记写法从 0.2.0-rc.2 起就不对了；4.4 的"三档决定"在 0.2.0-rc.2 时就已经是四种，当时只改了 3.5 的引文、漏了 4.4；9.1 把 Cordis 插件级的失败隔离说成了 effect 级的；0.1 把 tsx 的出处写成了 `development.md`。

### 这一次升级本身教了什么

**一、** 机械检查（路径、引文、标识符）一共只报了 9 处，全集中在三件事上：`append()` 的拆分、持久化的拆卸、格式版本那段注释。工作目录那件大事**一行引文都没碰到**——课程从来没有逐字引过 `{{cwd}}` 那条注册，只在讲义里转述过"dsh 自带的装配只把这一句放后缀"。**转述不会触发任何检查。** 是逐个去读"课程引用过、这次又改过"的那 40 来个文件和几份新笔记，才看出来。

**二、** 那四处旧错是怎么漏掉的：前面几套检查都是"旧版有、新版没有"，**两个版本里都没有的话**（早在上上次升级就过时了），它们看不见。这次加了一道新检查：把讲义里归到 dsh 名下的代码块逐行拿去新版里找，找不到的人工复核——5.3 那两行就是这么抓到的。另外三处是读源码读出来的：读到 agent 循环里一句新注释 "Cordis skips later disposers after a rejection"，才回头发现 9.1 写反了。

**三、** dsh 这次推翻了两条课程当作原则来教的东西："拿不准就加版本号"和"`{{cwd}}` 随会话生灭，所以放 system prompt"。两次都写了笔记，都说清了旧判断错在哪：一个是把代价估低了，一个是把寿命估短了。**原则本身都还在**（两种错里选代价小的那种；一句话放哪看它随谁生灭），**改的是代入原则的那个估计**。读设计笔记最值钱的就是这个：看清一个判断是原则错了，还是估计错了。
