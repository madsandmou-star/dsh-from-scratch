# 附录：opencode 与 dsh 的体量与架构对比

> 这不是"谁赢"的排行榜，是两条不同押注的对照。两边的数字都用同一套口径现场统计，快照日期几乎同天：opencode `v1.18.20`（2026-08-21）、dsh `0.1.0-rc.8`（2026-08-20）。
>
> 统计口径：`packages/**/src/**` 下的 `.ts`/`.tsx`，排除 `*.test.ts`/`*.spec.ts`；不含 `vendor/`。

## 一、体量

| | opencode v1.18.20 | dsh 0.1.0-rc.8 |
|---|---:|---:|
| 包数 | 36 | **226** |
| src 文件数 | **2,262** | 1,375 |
| src 行数 | **472,418** | 239,844 |
| 测试文件数 | 724 | **796** |
| 测试行数 | 173,425 | **271,488** |
| Markdown 文档 | 151 | **2,469** |

两个反直觉的事实：

1. **opencode 的包少 6 倍，代码却多 1 倍。** dsh 的 226 个包平均 1,061 行/包，opencode 的 36 个包平均 13,123 行/包。这是"拆得极碎"与"按产品面分块"的直接体现。
2. **dsh 的测试行数超过源码行数**（271k > 240k），opencode 是源码的 37%。dsh 的每文件 100% 覆盖率门禁是这个比例的直接原因。

### 质量分布在哪

| opencode（行） | | dsh（行） | |
|---:|---|---:|---|
| 138,622 | `app/` Web UI (SolidJS) | 45,536 | `client/` Web GUI |
| 80,546 | `opencode/` 主应用 | 21,222 | `host/` + `api/` + `typert/` |
| 39,546 | `console/` SaaS 控制台 | 13,497 | `core/`（六个包） |
| 33,519 | `ui/` 组件库 | 9,414 | `session/` 持久化与投影 |
| 32,922 | `core/` 领域层 | 4,756 | `llm/` 三件套 |
| 30,087 | `sdk/` 生成的客户端 | | |
| 27,056 | `tui/` 终端 UI | | |
| 17,379 | `stats/` | | |
| 9,533 | `llm/` | | |

opencode 的仓库里装着一整个 SaaS 产品：`console`、`stats`、`enterprise`、`containers`、`slack`、`identity`、`function`。dsh 没有这一层，但多了 Python SDK、native landlock 启动器和 typert 类型图生成器。

### agent 核心本身

| | opencode | dsh |
|---|---:|---:|
| agent 核心合计 | `opencode/` + `core/` + `llm/` ≈ **123,000** | 骨架 31 个包 ≈ **62,400** |
| 循环本体 | `opencode/src/session/` 8,101 + `core/src/session/` 3,668 | `core/agent-loop/` **1,662** |
| 工具层 | `opencode/src/tool/` 5,198 + `core/src/tool/` 2,675 | `core/tools/` 5,628 |
| CLI | `opencode/src/cli/` 21,853 | `apps/cli`（骨架外） |

dsh 的 agent-loop 只有 1,662 行——因为它把权限、压缩、子 agent、持久化全部推到了插件里，loop 本体只负责 turn/step 的推进。opencode 的 `session/prompt.ts` 把这些编排在一起。

## 二、架构指纹

用现场统计的调用次数看两边的"世界观"：

| opencode（Effect-TS） | 次数 | dsh（Cordis） | 次数 |
|---|---:|---|---:|
| import `effect` 的文件 | 625 | import `@deepseek-ai/cordis` 的文件 | 540 |
| `Schema.*` | 6,835 | `ctx.on(` | 208 |
| `Effect.gen` | 697 | `ctx.effect(` | 175 |
| `Stream.*` | 256 | `ctx.emit(` | 27 |
| `Layer.effect` | 160 | `ctx.waterfall(` | 13 |
| — | | `ctx` 服务键 | 69 |
| — | | `cordis.yml` / patch 文件 | 131 |

### 扩展模型：钩子表 vs 服务与事件

**opencode 是一张固定的钩子表。** 插件签名是 `(input, options) => Promise<Hooks>`，`Hooks` 接口列出你能插的所有位置：

```
loader          methods         models          dispose         event
config          chat.message    chat.params     chat.headers
permission.ask  shell.env       command.execute.before
tool.execute.before             tool.execute.after
experimental.chat.messages.transform            experimental.chat.system.transform
experimental.provider.small_model               experimental.session.compacting
experimental.compaction.autocontinue            experimental.text.complete
```

优点是**能力边界一眼可见**，写插件不用理解框架。缺点也在同一句话里：**表上没有的位置就插不进去**——想在别处插一脚，只能改主应用。表里 6 个 `experimental.` 前缀说明这张表正在快速膨胀，而膨胀的每一步都要主仓发版。

**dsh 没有这张表，它有 69 个服务键 + 一套类型化事件。** 新能力挂在 `ctx.<key>` 上，拦截通过 `waterfall` 事件（必须调 `next()` 才继续），组合写在 `cordis.yml` 里，任何一行都能被上层 patch 替换。代价是：**没有"你能做什么"的单一清单**，你得读服务目录和事件目录才知道有哪些扩展点。

### 装配：编译期 vs 运行时

这是两者最本质的分歧。

- **Effect Layer 在编译期定死依赖图。** 少注入一个依赖是**类型错误**，编译不过。
- **Cordis 在运行时按服务键装配。** 少一个 `inject` 的服务，插件就静静地永不激活——没有编译错误。dsh 用 runtime invariant 和 `verify-cordis-config` 门禁去补这个洞。

反过来：

- **Cordis 的组合是数据，不是代码。** 换后端、改策略不用改代码也不用重编译，patch 一行 yaml；`dsh --profile web --dump-config` 能打印出真实装配出来的整棵树。极端情况下 agent 能在运行时给自己挂上刚写的插件（`packages/extensions/`）。
- **Effect 做不到这件事**，Layer 图在编译期就固定了。

一句话：**opencode 押注编译期确定性，dsh 押注运行时可组合。**

### 两种"看不懂"

初学者在两边都会卡，但卡的性质不同：

- opencode 是**语法看不懂**：`Effect.gen(function* () { yield* ... })` 是一门 DSL，得先学函数式那一套。学一次就过去了。
- dsh 是**流向看不懂**：代码接近普通 TypeScript，但 `ctx.tools` 从哪来、这个 waterfall 上挂了谁、这次运行到底装了哪些插件——读代码看不出来。得靠工具（`--dump-config`、事件目录）和文档解决，**每读一个新子系统都要重来一次**。

这也解释了 dsh 为什么有 2,469 篇文档：**隐式装配必须用文档还债。**

> 流式这条链路（SSE 解析 → 内存 → 落盘 → 用户可见）的逐段对比另开一篇：[流式的四段链路](streaming-opencode-vs-dsh.md)。

## 三、优缺点与判断

| 维度 | 更强的一方 | 理由 |
|---|---|---|
| 插件生态门槛 | **opencode** | 22 个命名钩子，看一眼类型就能写；dsh 要先理解服务/事件/配置三件事 |
| 深度定制、换后端 | **dsh** | capability seam 三角色 + patch 层，换执行后端不碰任何消费者代码 |
| 依赖装配的安全性 | **opencode** | Layer 缺失是编译错误；dsh 是运行时静默不激活 |
| 运行时可组合 | **dsh** | 组合是配置数据，可 dump、可 patch、可热插；Effect 图编译期定死 |
| 循环本体的可读性 | **dsh** | agent-loop 1,662 行，其余全在插件；opencode 编排集中在 session 层 |
| 可回放与审计 | **dsh** 略胜 | "模型可见 ⟺ 已记录"是 runtime invariant，不是约定 |
| 产品迭代速度 | **opencode** | 单仓含全部产品面，文档与门禁负担轻得多 |
| 多人/多 agent 协作改代码 | **dsh** | 门禁密度（覆盖率、快照、不变量、文档配对）把约定变成机械检查 |
| 作为学习对象 | **dsh** | 核心 62k 行、边界清晰；opencode 的等价物散在 12 万行里且隔着 Effect |

**没有总体上的赢家，但有清楚的适用面：**

要做一个**被大量第三方按自己的方式重新组装**的 harness，dsh 的押注更对——它把"改造"从改代码降级成改配置。要做一个**自己团队快速演进的产品**，opencode 的押注更对——编译期确定性和低文档负担直接换成迭代速度。

dsh 为它的押注付的账单是可以量化的：**测试行数超过源码行数，文档篇数是 opencode 的 16 倍。** 这不是过度工程，是隐式装配和无限可替换性的必然成本——你把确定性从编译器手里拿走了，就得用门禁和文档把它买回来。
