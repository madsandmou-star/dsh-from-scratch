# 0.1 运行时与包管理器

> 本课目标：跑通第一个 `.ts` 文件，并搞清楚"跑"这个动作背后到底有哪几个角色。

## 三个角色

写 Python 时你面对的是"解释器 + pip"两个东西。这边多了一层：

| 角色 | 它负责什么 | 本课程 / dsh 的具体情况 |
|---|---|---|
| **Node** | 运行 JavaScript 的运行时 | 两边都要 `^22.19 \|\| >=24`（见各自 `package.json` 的 `engines`） |
| **包管理器** | 装依赖、跑 `scripts` | 课程用 npm（只装一个 tsx）；dsh 用 pnpm，因为它要管 200 多个包的 workspace |
| **tsx** | 让 Node 能直接加载 `.ts` | 两边都用，`node --import tsx` 启用 |

多出来的这一层是 TypeScript 造成的：Node 只认 JavaScript，而我们写的是 TypeScript。

## 为什么 `.ts` 不能直接跑

TypeScript 的类型标注（`const x: number = 1` 里的 `: number`）不是 JavaScript 语法，Node 默认读不懂。传统做法是先编译：`tsc` 把 `.ts` 转成 `.js`，再 `node xxx.js`。dsh 的正式构建就是这么做的（`pnpm run build` 用 tsc 出类型、tsdown 出运行时产物）。

但开发时每改一行都编译一次太慢，所以有了 tsx：它挂在 Node 的模块加载钩子上，**加载的瞬间**把 TypeScript 剥成 JavaScript，然后交给 Node 执行。注意它只是把类型标注删掉，**不做类型检查**——类型检查是另一件事（课程里跑 `npx tsc --noEmit`，dsh 里跑 `pnpm run typecheck`）。

> 这条区别以后会咬你一口：代码跑得好好的，CI 却报类型错误。因为跑起来那一步根本没检查类型。

## 跑第一个程序

代码在 [`src/hello.ts`](../../../src/hello.ts)：

```ts
const who: string = process.argv[2] ?? 'dsh'

function greet(name: string): string {
  return `hello, ${name}`
}

console.log(greet(who))
```

在课程根目录执行：

```sh
node --import tsx src/hello.ts
# hello, dsh

node --import tsx src/hello.ts 小明
# hello, 小明
```

如果报 `Cannot find package 'tsx'`，说明依赖还没装，先跑一次 `npm install`。`package.json` 里也备好了快捷方式：`npm run hello`。

**不想装依赖也能跑**：Node 22.6 之后内置了类型剥离，本课的文件可以直接用

```sh
node --experimental-strip-types src/hello.ts
```

两条命令做的是同一件事。之所以课程默认用 tsx，是因为 dsh 也用它（连 `dsh` 命令自己从源码启动时走的都是 `node --import tsx/esm`，见 `dsh/docs/development.md`）——保持一致，你才能顺手去跑参考源码里的东西。

## workspace：一个仓库里的几十个包

dsh 不是一个包，是 200 多个包住在一个仓库里（按 `dsh/packages/<组>/<包>/` 分成 50 个包组），彼此用包名互相引用，比如 `import ... from '@deepseek-ai/dsh-llm'`。这种布局叫 **monorepo**，pnpm 用 `dsh/pnpm-workspace.yaml` 声明哪些目录算成员：

```yaml
packages:
  - vendor/*
  - packages/*/*
  - apps/*
```

成员之间的依赖不会真的从 npm 下载，pnpm 直接把本地目录链接过去。所以你改 `dsh/packages/llm/llm/src/` 里的一行，`dsh/packages/core/agent-loop` 立刻就能看到。

**课程仓库和 dsh 是分开的两个仓库**：dsh 以 submodule 的形式钉在 `dsh/`，版本固定、只读。所以你在这里不能 `import '@deepseek-ai/dsh-llm'`——不过这正合适，从零学的意思就是不借用现成的包；每个抽象都要自己写一遍，再翻到 `dsh/` 里看真实版长什么样。

顺带记住一件事：`dsh/` 里的东西**永远不要改**。它是对照物，不是工作区。

## 为什么这门课把这层讲在最前面

因为它是后面所有"跑不起来"的第一嫌疑人。三类最常见的开局故障：

| 现象 | 根因 | 怎么确认 |
|---|---|---|
| `Cannot find package 'tsx'` | 没装依赖 | `ls node_modules \| head`，空的就 `npm install` |
| `Unknown file extension ".ts"` | 忘了 `--import tsx` | 看你敲的命令 |
| `Cannot find module './config'` | 相对导入漏了 `.ts` 后缀 | 见 [0.2](../02-typescript-esm/01-typescript-esm.md) 的 ESM 小节 |

---

下一课：[0.2 TypeScript 与 ESM 的最小集](../02-typescript-esm/01-typescript-esm.md)
