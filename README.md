# 🧭 DSH From Scratch

**从零开始，一行一行造一个 agent harness，直到能看懂 DeepSeek Harness 的每一个设计决策。**

> 这是一个**教学项目**，学法来自 [OpenCode From Scratch](https://github.com/hong-kailin/OpenCodeFromScratch)：不是"跟着敲代码"，而是"一起想清楚为什么"。
> 参考源码以 git submodule 的形式钉在 `dsh/`，只读、不修改，版本固定——所以讲义里写的每一个路径，你打开时看到的都和写讲义时一模一样。

| | |
|---|---|
| 📌 参考版本 | deepseek-harness `dsh-v0.1.0-rc.8`（commit `141eb6fef`，钉在 `dsh/` submodule，只读） |
| 📂 参考源码 | `dsh/packages/`、`dsh/docs/`、`dsh/examples/` |
| 🎯 终点 | **骨架 1:1 复刻**（31 个包、约 6.2 万行）+ 外围逐个读懂；最后给 dsh 提一个真插件 |
| 👤 适合人群 | 想搞懂 AI coding agent 内部原理、准备给 dsh 提 PR 的开发者 |
| 🗣️ 语言 | 讲义中文，技术术语保留英文（Cordis、waterfall、capability seam、session log） |

## 为什么不是"直接读源码"

dsh 有 200 多个包（分在 50 个包组里）。打开 `dsh/packages/core/agent-loop/src/index.ts`，开头一行 `static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']` 就牵出五个服务，而它们谁都不在这个文件里。直接读，第三个文件就迷路了——不是因为代码难，是因为**你缺少这套架构存在的动机**。

一个抽象只有在你先痛过之后才讲得通：

- 你没写过两个入口各自 `loadConfig()`，就不会觉得依赖注入是解药，只会觉得 `ctx` 是多余的一层。
- 你没被"重启后对话全丢了"坑过，就不会理解为什么 dsh 把整个 session 做成**追加式事件日志**而不是一个 messages 数组。
- 你没被"把 bash 换成沙箱执行要改 12 个文件"坑过，就不会理解 capability seam 为什么要拆成 Service Definition / Provider / Consumer 三个角色。

所以这门课的路线是：**先造一个丑但能跑的 agent，再一个痛点一个痛点地把它演进成 dsh 的样子。** 每引入一个抽象，都先让你看见它解决的那个具体的疼。

> **先感受到痛点，再学解决方案，理解才深刻。**

## 你能学到什么

> **整门课最重要的一课：学会 debug。**
> AI 让"跑通"变得廉价，但"跑通"和"看懂"是两回事。真正搞明白一段代码怎么运转，最有效的办法是去 debug 它：读报错栈、追数据流、定位根因、验证假设。写代码可以交给 AI，理解代码得靠 debug。

- **一个 agent 到底由什么组成**：tool loop、流式、system prompt、session、权限、压缩，每一块都亲手写一遍
- **dsh 的设计决策**：为什么"一切皆插件"、为什么 session 是事件日志、为什么能力要拆成三个角色、为什么改 loop 要先改文档
- **用 AI 给自己定制讲义**：这门课本身就是 AI agent 协助生成的；讲义看不懂就换个说法、换个类比，一遍遍打磨到你真的懂为止
- **给 dsh 提 PR 的底气**：终点不是"我造了个玩具"，而是"我知道这个功能该挂在哪个扩展点上"

## 终点：复刻到哪一步

**骨架 1:1，外围只读。** 这不是"简化版"的托词——骨架部分的终态是**逐行与 dsh 源码一致**，包括它的错误分类、边界处理、事件语义和测试。

| | 范围 | 规模 | 要求 |
|---|---|---|---|
| **骨架** | `core/`（session、tools、agent、agent-loop、system-prompt、scope）、`llm/` 三件套、`session/` 持久化与投影、fs / shell / subprocess 三条 seam、interaction 权限、compaction、subagent、skill、plan、todo、guard、context、credentials、settings、boot、bundle、util | **31 个包 / 62,400 行** | 逐行复刻到与源码一致 |
| **框架** | `vendor/cordis` | 6,493 行 | 先自己写迷你版跑通，再对照读全量，不逐行抄 |
| **外围** | `client/` Web GUI（45,536 行）、`host/` + `api/` + `typert`（21,222 行）、website、Python SDK、native/landlock、e2b、lsp、terminal PTY、sandbox 后端、hooks 桥、session-query、spill、attachment、storage、仓库门禁与生成器 | 约 14 万行 | 带你读懂设计与取舍，不重写 |

参照系：骨架的 31 个包，正好和 opencode 整个项目的包数一样多——**这门课的"骨架"体量等于 OpenCode From Scratch 的全部目标**。外围之所以只读，不是因为它不重要，而是因为重写 4.5 万行 Web 前端学不到 agent 架构，读它的分层却能。

## 学习路线

核心原则：**动机驱动 + 渐进演进**——不是"dsh 有什么就照搬什么"，而是"哪里痛了才引入什么"。

### 第一阶段 · 简化版能跑（不引入任何框架）

| 阶段 | 内容 |
|:---:|---|
| 0 | 环境与基础（Node + pnpm + TypeScript ESM + tsx） |
| 1 | 最小 agent（读配置 → fetch → 多轮对话） |
| 2 | 流式输出（SSE 与增量拼装） |
| 3 | 工具循环（agent 的本质） |
| 4 | 工具集与执行前后（超时、截断） |
| 5 | system prompt 组装（环境信息 + AGENTS.md + 工具 schema） |
| 6 | 会话落盘（事件日志 + 投影，JSONL 重启恢复） |

### 第二阶段 · 痛点驱动，演进成 dsh

| 阶段 | 解决的痛点 | 引入的 dsh 抽象 |
|:---:|---|---|
| 7 | 入口重复、依赖到处传 | Cordis 插件与上下文 |
| 8 | 谁都能 import 谁 | 服务与 `inject` |
| 9 | 卸载一个功能要手动收尾 | 可逆注册（effect） |
| 10 | 想在工具执行前插一脚，只能改 loop | 类型化事件与 waterfall 管线 |
| 11 | 换个部署要改代码 | 配置即组合（cordis.yml / profile / bundle / patch） |
| 12 | 日志有了，但不能 revert、压缩、分支 | surface 操作、投影缓存、压缩 |
| 13 | loop 写死了，换不掉 | agent 服务与 loop 分离（turn / step / inbox） |
| 14 | 换执行后端要改一堆消费者 | capability seam（Definition / Provider / Consumer） |
| 15 | 工具能乱改文件，没人确认 | 权限、审批、命令、ask-user |
| 16 | 长对话爆上下文 | compaction 与 spill |
| 17 | 单 agent 干所有事 | subagent、skill、plan、todo |
| 18 | 只有一个终端出口 | headless / ACP / JSON-RPC / Web，由 `session/event` 驱动 |
| 19 | 改一处崩三处 | 测试、快照重放、runtime invariant、门禁 |
| 20 | 加个能力要重启进程 | agent 挂载自己写的插件 |

完整大纲与当前进度见 **[COURSE.md](COURSE.md)**（活文档，进入每阶段前才细化）。

想先知道 dsh 和 opencode 差在哪、各自押注了什么，看附录：**[opencode 与 dsh 的体量与架构对比](docs/appendix/opencode-vs-dsh.md)**。

## 快速开始

前置：Node `^22.19 || >=24`（`node -v` 确认）。

```sh
# 1. 克隆课程，并把参考源码一起拉下来（--recurse-submodules 是关键）
git clone --recurse-submodules <本仓库地址> DshFromScratch
cd DshFromScratch
npm install          # 只装一个 tsx，用来直接跑 .ts

# 已经克隆过但 dsh/ 是空的：
git submodule update --init --depth 1 dsh

# 2. 阶段 0 的第一个程序
npm run hello        # 等价于 node --import tsx src/hello.ts

# 3. 配置模型（复制模板后填自己的 baseURL / model，key 走环境变量）
cp dsh-learn.example.json dsh-learn.json
export DEEPSEEK_API_KEY=sk-...

# 4. 阶段 1 的多轮对话 agent
npm run dev          # 等价于 node --import tsx src/index.ts

# 5. 跑演示（27 个，全都不需要 key：用的是假模型服务器）
npm run demo demos/02-streaming/01-sse-framing.mjs   # 分帧器抗五种切法
npm run demo demos/04-tools/04-red-green.mjs         # agent 自己修好一个测试

# 6. 自检：讲义里的链接和源码引用有没有失效
npm run check
npm run typecheck
```

> `dsh/` 是**可选**的：不初始化它，课程代码照样跑，只是讲义里"对照真实源码"那部分点不开。想学到位就初始化它——这门课一半的价值在对照上。

> ⚠️ `dsh-learn.json` 已被 gitignore。**永远不要把真实 key 写进任何提交的文件**——这门课的配置里只出现环境变量名，这也是 dsh 本体的做法（见 `dsh/packages/credentials/`）。

## 目录结构

```
DshFromScratch/
├── README.md           # 你正在看的这个：项目导览
├── COURSE.md           # 课程大纲（活文档）
├── AGENTS.md           # 课程作者约定 + 给 AI 助手的指令
├── docs/               # 讲义（按 阶段/小课 编号组织）
│   ├── 00-env-basics/
│   └── 01-minimal-agent/
├── src/                # 教学代码（讲义里的每段代码都在这里能打开）
├── demos/              # 每一课的可运行演示，都不需要 API key（见 demos/README.md）
├── scripts/            # npm run check：链接与源码引用自检
└── dsh/                # ← 参考源码（submodule，只读，版本固定）
```

参考源码就在 `dsh/` 里，不用另外找：

| 你想看的东西 | 位置 |
|---|---|
| 架构全景 | [docs/architecture.md](dsh/docs/architecture.md) |
| Cordis 概念与教程 | [docs/cordis-primer.md](dsh/docs/cordis-primer.md)、[docs/cordis-tutorial/](dsh/docs/cordis-tutorial/index.md) |
| DeepSeek 模型适配器 | `dsh/packages/llm/llm-deepseek/src/` |
| agent loop | `dsh/packages/core/agent-loop/src/agent.ts` |
| 工具注册与执行管线 | `dsh/packages/core/tools/src/index.ts` |
| session 事件日志 | `dsh/packages/core/session/src/index.ts` |
| 一个装配好的最小 agent | `dsh/packages/examples/agent-spine-demo/README.md` |

## 给同样想学的人

你**不需要**先读完 Cordis 文档，**不需要**先理解事件溯源，**不需要**先搞懂什么叫 capability seam。从阶段 0 开始，写第一行 `console.log`，然后一步一步往前走。遇到不懂的概念，讲义里会讲；遇到不懂的语法，边写边查。

**读一万篇 agent 架构文章，不如亲手写一个。**
