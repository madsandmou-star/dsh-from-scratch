# 6.5 阶段验收

阶段 6 做完了一件事：**把"一个数组干三件事"拆成一条只增不改的日志，让它落到磁盘上，并且扛得住崩溃。**

## 验收清单

```sh
# ① 日志与它的投影，两栏并排
npm run demo demos/06-session/01-log-vs-projection.mjs
# [会话日志] 12 条 —— 发生了什么（权威）
# [投影出来的 messages] 10 条 —— 发给模型什么
#   turn/start 和 tool/call 只进日志，不进请求

# ② 悬空的工具调用：投影时补齐，不回滚
npm run demo demos/06-session/02-dangling-repair.mjs
# 中断于 after-call  → TOOL_OUTCOME_UNKNOWN（跑过了，磁盘可能已经变了）
# 中断于 before-call → TOOL_NOT_STARTED（没跑，重试安全）

# ③ 磁盘上的 JSONL 与续聊
npm run demo demos/06-session/03-jsonl-and-resume.mjs
# 同一个文件，从 9 行长到了 13 行——续聊是往后追加，不是新开一个

# ④ 为什么不是一个大 JSON 数组
npm run demo demos/06-session/04-why-jsonl.mjs
# JSON 数组   写了  565.4 MB   耗时   3454 ms
# JSONL       写了    0.6 MB   耗时     10 ms

# ⑤ 同步写把事件循环卡住多久
npm run demo demos/06-session/05-batching.mjs
# 每条同步写   事件循环最长被卡  108 ms
# 攒 200 条一批 事件循环最长被卡    1 ms

# ⑥ 检查点：工具去数自己这次调用落盘了没有
npm run demo demos/06-session/06-checkpoints.mjs
# 有检查点：1    关掉检查点：0

# ⑦ 崩溃残骸能修，其他的坏必须拒绝
npm run demo demos/06-session/07-torn-tail.mjs
# 末尾半行   → 读回 7 条事件，丢弃残骸 67 字节
# 中间损坏   → SessionLogCorruptionError
# seq 空洞   → SessionLogCorruptionError

# ⑧ 不认识的事件与不认识的版本
npm run demo demos/06-session/08-unknown-and-version.mjs
# 没标 ignorable → SessionFormatUnsupportedError
# 标了 ignorable → 读回 3 条事件，投影出 2 条消息

# ⑨ 真的跑一次，自己看
DSH_DUMP_LOG=1 npm run dev        # 聊两句，退出
cat .dsh-learn/sessions/*.jsonl   # 磁盘上的那条日志
npm run dev -- --resume           # 接着聊

# ⑩
npm run typecheck && npm run check
```

| 验收项 | |
|---|---|
| 能说出 `messages` 那个数组同时承担的三个角色 | ✓ |
| 知道"日志是权威，messages 是投影"这句话在代码上对应什么 | ✓ |
| 知道为什么 `tool/call` 和 `tool/result` 要分成两条事件 | ✓ |
| 能解释 `TOOL_NOT_STARTED` 和 `TOOL_OUTCOME_UNKNOWN` 的区别买到了什么 | ✓ |
| 知道为什么是一行一条 JSON 而不是一个数组（两个理由） | ✓ |
| 知道 `write()` 返回了不等于落盘了，以及哪三种崩溃各丢什么 | ✓ |
| 能说出检查点只放在哪两个时刻，以及判据是什么 | ✓ |
| 知道为什么读日志要按字节而不是按字符 | ✓ |
| 能说出"哪一种坏可以自动修"的判据 | ✓ |
| 知道 `ignorable` 的默认值为什么是"必需" | ✓ |
| 知道什么时候该加格式版本号，什么时候不该 | ✓ |

## 本阶段产出

| 文件 | 新增/改动 |
|---|---|
| `src/session.ts` | **新增 237 行**：`SessionEventMap`、`SessionEvent`、`Session`、`deriveMessages()`、`summarizeEvent()` |
| `src/persistence.ts` | **新增 377 行**：JSONL 读写、`SessionWriter`（攒批 + 串行 + 失败回滚）、`repairLog()`、两个错误类型 |
| `src/index.ts` | 改动 214 行：`messages` 数组 → `Session`；删掉回滚和 `lastSentSnapshot`；`--resume`；两处检查点；`DSH_DUMP_LOG` |
| `demos/06-session/` | 8 个新演示 |
| `demos/harness.mjs` | 支持复用工作目录和追加命令行参数（`--resume` 要在同一个目录里再跑一次） |
| `.gitignore` | `.dsh-learn/` |

被**删掉**的东西同样值得记一笔：

```ts
while (messages.length > rollbackTo) messages.pop()     // 1.4 的回滚
let lastSentSnapshot: string | undefined               // 5.3 那个记在旁边的变量
lastSentSnapshot = undefined                           // 以及它那行补丁
```

三样东西一起消失了。**它们不是被改好的，是被"让日志成为唯一权威"这个决定取消了。**

## 一条主线：四节课在解同一个问题

四节课看起来在讲四件事（数据结构、文件格式、刷盘时机、错误恢复），实际上是**同一个问题的四层**：

> **"发生过什么"这件事，怎么才能真的可信。**

| 课 | 这一层的威胁 | 解法 |
|---|---|---|
| 6.1 | 有三个互相冲突的理由在改那个数组 | 日志只增不改，messages 降级成投影 |
| 6.2 | 进程一退，权威就消失了 | 落成 JSONL，启动时读回来当种子 |
| 6.3 | "写了"不等于"在盘上"；同步写还卡住 agent | 攒批异步写 + 两个语义检查点 fsync |
| 6.4 | 盘上的文件可能读不回来 | 按字节扫，残骸能修，其他的坏明确拒绝 |

**每一层都在回答"这份历史在什么情况下会撒谎"，然后把那种情况堵掉。** 一层没堵，上面几层的工作就白费——6.1 写下的 `TOOL_OUTCOME_UNKNOWN` 要等到 6.3 的检查点才真的成立，而 6.3 保证的落盘要等到 6.4 的修复才真的读得回来。

## 工程思维总结

### ① 一个数据结构该不该拆，看有几个冲突的理由在改它

不看它多长。6.1 那个 `messages` 数组只有几行代码在碰它，但有三个角色在要求它变成不同的样子——于是任何一方的需求都会伤到另外两方。

拆完之后那个"回滚"不需要改，它**消失了**：它存在的唯一理由是"请求内容不能非法"，而投影时补齐把那个需求从数据结构上移走了。

> **好的重构不是把脏代码写干净，是让脏代码没有存在的理由。**

### ② 派生状态越少越好，能查出来的就不要存

5.3 的 `lastSentSnapshot` 是一个典型的"记在旁边的变量"。它有 bug，我当时打了补丁，并且明说补丁只堵住了我知道的那一个洞。

6.1 之后它变成了一次 O(n) 的倒序扫描——**慢了，但不可能对不上**。

这条判断在本阶段出现了三次：`lastSentSnapshot`、turn 编号、"上次发了什么"。三次的答案都一样：**从权威数据里查，不要另存一份。** 事件溯源最实在的好处不是"能重放"，是**能删掉的派生状态变多了**。

### ③ 格式选择决定失败的粒度

JSON 数组把失败粒度定在"整个文件"，JSONL 定在"一行"。6.2 那个演示里，同一次截断，前者救回 0 条，后者救回 3 条。

而且这不只是"损失小一点"——**它决定了 6.4 那个修复机制能不能存在**。修复需要一个"好的到哪里为止"的分界点，只有面向行的格式给得出来。

> 选格式的时候问一句：**它坏掉的时候，坏的是一个字节还是整个文件？**

### ④ "它返回了"和"它生效了"之间隔着几层缓冲

`appendFileSync` 返回 ≠ 在盘上（page cache）。这个形状在别处一样成立：网络 `write` 返回 ≠ 对方收到（发送缓冲区），`console.log` 返回 ≠ 屏幕上有（stdout 缓冲），`git commit` 返回 ≠ 远端有。

**排查"明明做了却没效果"，先问这一层。** 而反过来，知道有这几层之后才能做 6.3 那个取舍：平时让它留在缓冲里（快），少数时刻花钱把它按到底（对）。

### ⑤ 值得为之付代价的时刻，要用"撒谎代价"来挑

检查点只有两处，判据是一句话：**崩溃之后，缺了这条事件会不会让恢复出来的历史说谎。**

- 模型回答落盘了、依据的历史没落盘 → 一段没有原因的结果 → **会撒谎**，所以发请求前检查点。
- `tool/call` 没落盘 → 恢复时说成 `TOOL_NOT_STARTED` → 重试一次已经执行过的 `rm -rf` → **会撒谎**，所以跑工具前检查点。
- 工具结果没落盘 → 重跑一次工具 → **不撒谎，只是浪费**，所以不检查点。

**丢了要重做的事，和丢了会做错的事，是两个量级。** 只为后者付 fsync 的钱。

### ⑥ 默认值要选在出错时代价小的那一边

`ignorable` 不写就是"必需"，于是忘了标的后果是**过度拒绝**（用户看到一句明确的错误）而不是**悄悄读出残缺的历史**（模型基于假历史继续干活）。

同一个形状出现在格式版本上：拿不准就加版本，因为"多写一个几乎什么都不做的升级步骤"比"老版本悄悄读错新日志"便宜得多。

> **默认值不是"最常见的选择"，是"搞错时损失最小的选择"。**

### ⑦ 能自动修的，只有你自己会造成的那种坏

6.4 的整个分类来自一个问题：**崩溃会不会必然产生这种坏？**

末行没有换行符——会（写入不原子），所以必须能修。完整的行读不动、seq 有空洞——不会，那意味着有第三方插手过（手工编辑、磁盘错误、拼错两个文件），这时自动修复是在**猜**。

**陌生的失败模式要抛给人。** 你猜对了省下一次麻烦，猜错了悄悄毁掉一段历史。

## 与 dsh 的差距

规模上：我们 **614 行**（`session.ts` + `persistence.ts`）对着 dsh 的 `core/session` **3164 行**加 `packages/session/` 下 **13 个包、9414 行**。

| | 我们的 | dsh 的 | 哪个阶段补齐 |
|---|---|---|---|
| 单条投影规则 | 循环里的 `case` | `deriveEventMessage()` 独立导出，可折叠到任意日志前缀 | 阶段 12 |
| 哪些事件进投影 | 硬编码的 `case` | surface + `surfaceOp` 标记（`append` / `replace`） | 阶段 12（压缩） |
| 投影成本 | 每次 O(全部日志) | 缓存，O(新增节点) | 阶段 12 |
| 投影结果 | 普通对象，能改 | deep-frozen | 阶段 12 |
| 事件表扩展 | 改一个文件 | declaration merging，每个插件自己加 | 阶段 7 / 10 |
| turn 边界 | 只有 `turn/start` | `turn/start` + `turn/end` + `step/start` + `step/end` | 阶段 12 |
| 崩溃补齐 | 投影时即时造 | `interruptedTurnClosers()` 往日志补**真实事件** | 阶段 12 |
| 批处理延迟 | 常量 200ms | 可配置，默认 200 | 阶段 11（配置即组合） |
| 写失败 | 整批放回队首 | truncate 回原大小再 fsync 再重试 | 阶段 12 |
| 检查点 | 写死在 `index.ts` | 独立插件，三个监听器，可整个不装 | 阶段 7 / 10 |
| 中间损坏 | 一律拒绝 | 延迟判断：后面还有 `turn/end` 才抛 | 阶段 12 |
| 目录持久化 | 没做 | 截断/新建后 fsync 父目录 | 阶段 12 |
| 落盘后端 | 只有 JSONL | JSONL / SQLite 两个提供者 | 阶段 14（capability seam） |
| 物理编码 | 纯文本 | 可选 zstd 压缩 | 不复刻（外围） |
| 会话标题、统计、遥测 | 没有 | 8 个独立包 | 不复刻（外围，只带读） |

对应源码位置，方便自己去翻：

- `dsh/packages/core/session/src/index.ts` —— `Session` 本体、`append()`、`deriveMessages()`
- `dsh/packages/core/session/src/types.ts` —— `SessionEventMap`、`SessionEvent` 包装、`SESSION_FORMAT_VERSION`
- `dsh/packages/core/session/src/surface.ts` —— `deriveEventMessage()`，那条"THE 投影规则"
- `dsh/packages/core/session/src/repair.ts` —— `interruptedTurnClosers()`、两个恢复码
- `dsh/packages/core/session/src/known-event-types.ts` —— 生成的已知类型表
- `dsh/packages/session/session-persistence/src/coordinator.ts` —— 批处理调度、两个错误类型
- `dsh/packages/session/session-persistence/src/write-behind.ts` —— `SessionWriteBehind`
- `dsh/packages/session/session-persistence-jsonl/src/format.ts` —— 路径编码、会话头、`scanLog()`
- `dsh/packages/session/session-checkpoint-policy/src/index.ts` —— 三个检查点监听器

## 本阶段的 debug 手法

| 手法 | 回答什么问题 | 哪一课 |
|---|---|---|
| `DSH_DUMP_LOG=1 npm run dev` | 日志里有什么 vs 发出去了什么——**两栏对不上，错的几乎总是投影** | 6.1 |
| 先信日志，再查投影 | 缺事件 → 去 `index.ts` 找漏掉的 `append`；投影不对 → 去 `deriveMessages()` 找那个 `case` | 6.1 |
| `tail -3` / `grep '"type":"tool/call"'` 日志文件 | agent 到底调了哪些工具、最后发生了什么 | 6.2 |
| `wc -l` 日志 vs `session.events.length` | 多了 = 写了两遍；少了 = 队列里还压着 | 6.2 |
| 起一个 1ms 定时器看它迟到多久 | **事件循环被同步代码占住了多久**（对任何"莫名卡顿"都有效） | 6.3 |
| `DSH_NO_CHECKPOINT=1` 跑一次对照 | 检查点到底买到了什么 | 6.3 |
| 错误信息里的行号直接 `sed -n '4p'` | 那一行到底长什么样 | 6.4 |
| `tail -c 200` 看末行有没有换行符 | 是崩溃残骸（有救），还是别的事故（别猜） | 6.4 |

## 下一阶段的痛点预告

到这里，`src/index.ts` 那 307 行里装着整个 agent 的**装配逻辑**：

```ts
const config = loadConfig()
const guards = [accounting(config.accounting), readOnlyGuard(config.readOnly), outputBackstop()]
const prompt = new PromptRegistry()
prompt.variable('cwd', () => process.cwd())
prompt.register(identitySection)
…
const session = new Session()
const persistence = attachJsonlPersistence(session, logPath, header)
```

这一串有三个问题，都还没疼到不能忍，但马上就会：

**① 每个部件都得被 `index.ts` 认识。** 加一个功能要改这个文件；而 dsh 有两百多个包，不可能都往一个文件里塞。

**② 部件之间要互相知道。** 6.3 那两处检查点是写在 `runTurn()` 里的——**落盘这件事侵入了主循环**。如果不想要检查点（跑在内存里的测试），得改 `runTurn`。

**③ 没有办法"装上去"和"卸下来"。** `guards` 是一个数组字面量，`prompt.register()` 返回的注销函数我们一次都没用过。一个功能能被**卸掉**，是它能被**替换**的前提。

**阶段 7 引入 Cordis**：先自己写一个几十行的迷你插件系统，把 `index.ts` 的装配逻辑拆成一个个能装能卸的插件，然后对照 `dsh/vendor/cordis/`。那一课之后，"检查点"会从 `runTurn()` 里消失，变成一个挂在事件上的插件——和 dsh 的 `session-checkpoint-policy` 一样。
