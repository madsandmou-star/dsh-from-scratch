# DSH From Scratch 课程大纲

> **活文档**：进入每个阶段前才细化该阶段的小课，不提前规划过细。核心原则：**每个阶段产出一个能跑的东西**。
> 导览见 [README.md](README.md)，写作约定见 [AGENTS.md](AGENTS.md)。

## 第一阶段 · 简化版能跑

不引入任何框架。目标是把 agent 的每一块机制亲手写一遍，为第二阶段积攒痛点。

### 阶段 0：环境与基础

> **目标**：搭好开发环境，掌握 Node + TypeScript 的开发节奏和调试方法。
>
> **产出**：`npm run hello` 打印一行字，并知道报错了该怎么查。

#### 课程

- **0.1 [运行时与包管理器](docs/00-env-basics/01-node-pnpm/01-node-pnpm.md)**
  - Node、包管理器、tsx 各自负责什么，为什么要求 Node `^22.19 || >=24`
  - workspace 是什么：一个仓库里几十个包怎么互相引用
  - 直接跑 `.ts`：`node --import tsx`，以及它和"先编译再跑"的区别
  - 第一个程序：`src/hello.ts`

- **0.2 [TypeScript 与 ESM 的最小集](docs/00-env-basics/02-typescript-esm/01-typescript-esm.md)**
  - 声明：这不是完整的 TS 教程，只建立初步印象，后面用到的新语法随用随讲
  - 类型标注、`interface`、联合类型、`Record`、泛型的最小用法
  - `import type` 为什么重要：它在运行时会消失
  - ESM 与 CJS：为什么 dsh 全仓库 `"type": "module"`，本地相对导入为什么要写 `.ts` 后缀
  - `strict: true` 到底严在哪

- **0.3 [Debug：这门课最重要的一课](docs/00-env-basics/03-debug/01-debug.md)**
  - 读报错：栈顶不一定是根因，怎么找到"你自己的那一帧"
  - `console.log` 打点的正确姿势（打值、打类型、打时机）
  - 断点调试：`node --inspect-brk --import tsx`，VS Code attach
  - 三类典型故障的定位手法：拿不到值 / 拿到的类型不对 / 根本没执行到
  - 对照 dsh：为什么 dsh 里到处是 runtime invariant（`dsh/packages/<组>/<包>/src/invariant.ts`）

- **0.4 [阶段验收](docs/00-env-basics/04-stage-review/01-stage-review.md)**
  - 验收清单 + 工程思维总结：为什么 dsh 选 TypeScript、选 pnpm workspace，而课程选 npm

#### 阶段产出

```
src/hello.ts        # 唯一的代码：一个能跑、能被断点停住的文件
```

### 阶段 1：最小 agent（一次 LLM 调用）

> **目标**：不用任何 SDK、不用流式、不用框架，理解一次模型调用的本质——读配置 → 组装 messages → 发 HTTP → 解析 JSON。
>
> **产出**：命令行里能和模型多轮对话（无工具、无流式、退出即丢失）。

#### 课程

- **1.1 [配置与密钥](docs/01-minimal-agent/01-config-and-key/01-config-and-key.md)**
  - 一次模型调用需要哪四个东西：baseURL、模型 id、密钥、messages
  - 为什么配置里只放**环境变量名**而不是密钥本身
  - 设计我们的 `dsh-learn.json`，写出 `src/config.ts`
  - 对照 dsh：`dsh/packages/credentials/`（凭据引用 seam）与 `DeepSeekConnectionOptions.apiKeyEnv`

- **1.2 [先用 curl 打通](docs/01-minimal-agent/02-messages-curl/01-messages-curl.md)**
  - LLM API 的本质就是一次 POST：`/chat/completions`
  - messages 数组：`system` / `user` / `assistant` 三种 role 各自的作用
  - 手动 curl 一次，看清请求体和响应体的每一个字段
  - 教 debug：401 / 400 / 429 分别该怀疑什么

- **1.3 [用 fetch 调模型](docs/01-minimal-agent/03-fetch-llm/01-fetch-llm.md)**
  - `async` / `await` 与 Promise 的最小心智模型
  - `src/types.ts`：先给 `Message` 一个类型
  - `src/llm.ts`：`chat(messages)` —— 发请求、判错、取 `choices[0].message.content`
  - 教 debug：请求失败时先看状态码还是先看响应体
  - 对照 dsh：`dsh/packages/llm/llm-deepseek/src/adapter.ts` 为什么被称作 transport-only

- **1.4 [多轮对话](docs/01-minimal-agent/04-multi-turn/01-multi-turn.md)**
  - 模型没有记忆：所谓"多轮"就是每次把整个历史重发一遍
  - `readline` 读输入，把 assistant 回复推回历史
  - `src/index.ts`：第一个 agent loop 的雏形
  - 教 debug：历史越滚越长时怎么把"真正发出去的请求"打出来看

- **1.5 [阶段验收](docs/01-minimal-agent/05-stage-review/01-stage-review.md)**
  - 验收清单 + 工程思维总结：为什么先裸 fetch 再抽象
  - 对照 dsh：同一件事在 dsh 里由哪几个包分担，以及这门课后面会怎么长成那样

#### 阶段产出

```
DshFromScratch/
├── dsh-learn.example.json   # 配置模板（真实配置 gitignore）
└── src/
    ├── config.ts            # 读配置 + 从环境变量取密钥
    ├── types.ts             # Message
    ├── llm.ts               # chat()：一次非流式模型调用
    └── index.ts             # 多轮对话 CLI
```

### 阶段 2：流式输出

> **目标**：把"等全部生成完再打印"改成"逐字打印"，理解 SSE 与增量拼装。
>
> **产出**：回复像打字机一样逐字出现。
>
> **对照**：`dsh/packages/llm/llm-deepseek/src/sse.ts`（为什么 `[DONE]` 缺失要当成错误）、`assistant/chunk` 事件为什么必须落盘。

### 阶段 3：工具循环

> **目标**：让模型能调用你的函数——agent 与聊天机器人的分界线。
>
> **产出**：agent 能自己决定读哪个文件来回答问题。
>
> **对照**：`dsh/packages/core/agent-loop/src/tool-calls.ts`，以及"一个 step = 一次模型请求 + 它调用的工具"这个定义。

### 阶段 4：工具集与执行前后

> **目标**：write / edit / glob / grep，以及每个工具都要面对的现实问题——超时、输出太大、参数非法。
>
> **产出**：一个能改代码的 agent。
>
> **对照**：`dsh/packages/core/tools/src/index.ts` 的执行管线，`dsh/packages/fs/tool-fs/`。

### 阶段 5：system prompt 组装

> **目标**：模型看到的第一屏是怎么拼出来的：身份、环境信息、工作区 AGENTS.md、工具 schema。
>
> **产出**：可复现的 system prompt，改一个开关就能看出差异。
>
> **对照**：`dsh/packages/core/system-prompt/`、`dsh/packages/context/`。

### 阶段 6：会话落盘

> **目标**：进程退出后还能接着聊。先用最朴素的办法：把 messages 数组序列化成 JSONL。
>
> **产出**：`--resume` 能续上上次的对话。
>
> **痛点预告**：这个朴素方案在阶段 12 会被推翻——它无法回答"第 3 步之前发生了什么"，也无法 revert。

## 第二阶段 · 演进成 dsh

每个阶段先复现一个**具体的疼**，再引入 dsh 对应的抽象，最后对照真实源码补差距。

### 阶段 7：Cordis 插件与上下文

> **痛点**：CLI 入口和另一个入口各读一遍配置、各造一遍工具数组，加第七个工具要改三处。
>
> **引入**：插件 = 一个 `apply(ctx)` 函数；应用 = 一棵插件树。
>
> **对照**：[docs/cordis-tutorial/01-first-plugin.md](dsh/docs/cordis-tutorial/01-first-plugin.md)、`dsh/vendor/cordis/bin.js`。

### 阶段 8：服务与 inject

> **痛点**：插件之间要互相调用，只能 import 具体实现，换实现就要改调用方。
>
> **引入**：服务挂在 `ctx.<key>` 上，依赖用 `inject` 声明；load 顺序由依赖决定，不由书写顺序决定。
>
> **对照**：[docs/cordis-tutorial/03-services.md](dsh/docs/cordis-tutorial/03-services.md)、`ctx.llm` / `ctx.tools` / `ctx.sessions`。

### 阶段 9：可逆注册

> **痛点**：卸载一个功能时，它注册过的监听器、定时器、临时文件没人收。
>
> **引入**：`ctx.effect()` / `ctx.on()` 返回 disposer，插件卸载即回收；HMR 因此才成立。
>
> **对照**：[docs/cordis-tutorial/02-lifecycle-and-effects.md](dsh/docs/cordis-tutorial/02-lifecycle-and-effects.md)、"registrations are effects" 这条硬规矩。

### 阶段 10：类型化事件与 waterfall

> **痛点**：想在工具执行前加一道检查，只能改 loop 本体。
>
> **引入**：`emit` / `waterfall` / `parallel` / `serial` 四种派发模式；around 中间件必须调 `next()`。
>
> **对照**：`tools/pre-execute` → `tools/execute` → `tools/post-execute`，[docs/tool-execution-pipeline.md](dsh/docs/tool-execution-pipeline.md)。

### 阶段 11：配置即组合

> **痛点**：改一个部署要改代码、重新发版。
>
> **引入**：`cordis.yml` 描述插件树，Schemastery 校验 config，profile / bundle / patch 分层组合。
>
> **对照**：[docs/architecture.md](dsh/docs/architecture.md#profiles-and-bundles)、`dsh --profile web --dump-config`。

### 阶段 12：事件溯源的 session log

> **痛点**：messages 数组丢掉了"发生过什么"，无法 revert、无法 fork、无法重放 UI。
>
> **引入**：追加式 `SessionEvent` 日志 + 投影（`deriveMessages()`）；**模型可见 ⟺ 已记录**。
>
> **对照**：`dsh/packages/core/session/src/index.ts`、[docs/architecture.md](dsh/docs/architecture.md#session-log)。

### 阶段 13：agent 服务与 loop 分离

> **痛点**：loop 写死在入口里，换驱动方式、并发多个 agent、中途取消都做不到。
>
> **引入**：`ctx.agents` 注册表 + 可替换的 `agent-loop` 驱动；turn / step / inbox / inject / abort 的准确含义。
>
> **对照**：`dsh/packages/core/agent-loop/src/agent.ts`、[docs/agent-lifecycle.md](dsh/docs/agent-lifecycle.md)。

### 阶段 14：capability seam

> **痛点**：把 bash 从本地执行换成沙箱执行，要改掉每一个调用方。
>
> **引入**：一条能力 = Service Definition + Service Provider + Consumer 三个角色，缺一不成 seam。
>
> **对照**：`dsh/packages/shell/`（shell / bash-local / tool-bash）、[docs/capability-seams.md](dsh/docs/capability-seams.md)。

### 阶段 15：人在环中

> **痛点**：工具可以随便改文件、随便执行命令，没人确认。
>
> **引入**：审批与交互 seam、权限预设、命令、ask-user 工具。
>
> **对照**：`dsh/packages/interaction/`。

### 阶段 16：上下文经济学

> **痛点**：长对话把上下文撑爆，一次大输出就把窗口吃光。
>
> **引入**：compaction 能力与 spill 策略。
>
> **对照**：`dsh/packages/compaction/`、`dsh/packages/spill/`。

### 阶段 17：分工

> **痛点**：单个 agent 什么都干，prompt 越堆越长。
>
> **引入**：subagent、skill、plan 模式、todo。
>
> **对照**：`dsh/packages/subagent/`、`dsh/packages/skill/`、`dsh/packages/plan/`、`dsh/packages/todo/`。

### 阶段 18：出口

> **痛点**：只有一个终端界面；换个前端就得重写一遍编排逻辑。
>
> **引入**：headless / ACP / JSON-RPC / Web 各自只是一个出口，UI 由 `session/event` 驱动。
>
> **对照**：`dsh/examples/`、`dsh/packages/sdk/`、`dsh/packages/acp/`。

### 阶段 19：守住架构

> **痛点**：改一处崩三处；重构之后没人敢合。
>
> **引入**：单元测试、快照重放、runtime invariant、仓库门禁各自防住哪一类回归。
>
> **对照**：[docs/testing.md](dsh/docs/testing.md)、`dsh/packages/<组>/<包>/src/invariant.ts`、`scripts/`。

### 阶段 20：自我修改

> **痛点**：加一个能力要改代码、重启进程。
>
> **引入**：agent 检视并挂载自己写的插件。
>
> **对照**：`dsh/packages/extensions/`、`pnpm run demo:cordis`。

### 毕业设计

> 删掉自己的 mini harness，直接给 dsh 写一个真正的插件：选一个 [docs/architecture.md](dsh/docs/architecture.md#where-new-behavior-goes) 里列出的扩展点，实现、加测试、跑门禁、提 PR。

## 当前状态

- [x] 阶段 0：环境与基础
- [x] 阶段 1：最小 agent
- [ ] 阶段 2：流式输出
- [ ] 阶段 3：工具循环
- [ ] 阶段 4：工具集与执行前后
- [ ] 阶段 5：system prompt 组装
- [ ] 阶段 6：会话落盘
- [ ] 阶段 7：Cordis 插件与上下文
- [ ] 阶段 8：服务与 inject
- [ ] 阶段 9：可逆注册
- [ ] 阶段 10：类型化事件与 waterfall
- [ ] 阶段 11：配置即组合
- [ ] 阶段 12：事件溯源的 session log
- [ ] 阶段 13：agent 服务与 loop 分离
- [ ] 阶段 14：capability seam
- [ ] 阶段 15：人在环中
- [ ] 阶段 16：上下文经济学
- [ ] 阶段 17：分工
- [ ] 阶段 18：出口
- [ ] 阶段 19：守住架构
- [ ] 阶段 20：自我修改
- [ ] 阶段 21：骨架对齐
- [ ] 毕业设计

> **下一步**：进入阶段 2 前，先把阶段 2 的小课在本文件里细化出来（照阶段 0、1 的粒度），再动手写讲义和代码。
