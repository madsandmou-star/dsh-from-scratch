# 0.4 阶段 0 验收

> 本课目标：确认环境可用，并把这一阶段学到的**判断**沉淀下来。

## 验收清单

```sh
# ① 直接跑 .ts
npm run hello
# hello, dsh

# ② 命令行参数
node --import tsx src/hello.ts 小明
# hello, 小明

# ③ 类型检查是独立的一步
npm run typecheck
# 无输出即通过

# ④ 讲义自检：链接与源码引用有没有失效
npm run check
# check-course: 通过（14 个 Markdown 文件，链接全部可解析，46 处源码路径存在）

# ⑤ 失败路径：错误信息要能照着做
node --import tsx src/index.ts
# Error: 找不到配置文件 .../dsh-learn.json
# 先复制模板：cp dsh-learn.example.json dsh-learn.json

# ⑥ 调试器
node --inspect-brk --import tsx src/hello.ts
# Debugger listening on ws://127.0.0.1:9229/...
```

| 验收项 | |
|---|---|
| Node / 包管理器 / tsx 三个角色各自负责什么 | ✓ |
| Node 原生剥离能跑 `.ts`，但只能删不能生成（`enum` 会报错） | ✓ |
| 跑起来和类型对是两件事 | ✓ |
| 类型在运行时**彻底不存在**，以及这为什么逼出了 schema 库 | ✓ |
| `import type` ≈ Python 的 `if TYPE_CHECKING` | ✓ |
| ESM 两条：相对导入带 `.ts`、用 `import.meta.url` 而不是 cwd | ✓ |
| `strict` 是一组开关，数组下标要靠 `noUncheckedIndexedAccess` | ✓ |
| Node 报错栈第一行是根因（和 Python 相反） | ✓ |
| 忘了 `await` 会让错误脱离时序 | ✓ |
| `console.dir(x, { depth: null })` 才打得全 | ✓ |
| 会用 `--inspect-brk` 或 F5 下断点 | ✓ |

## 本阶段产出

```
src/hello.ts        # 唯一的代码
tsconfig.json       # 与 dsh 对齐：strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
```

## 工程思维总结

### 1. 类型是给"修改"用的，不是给"输入"用的

TypeScript 在运行时什么都不做——`interface` 编译后一个字节都不剩。它值钱的地方是：三个月后你改一个字段名，编译器把所有受影响的地方指给你看。它不值钱的地方是：外面进来的数据长什么样，它一无所知。

**所以边界在哪，校验就在哪。** dsh 把这条写成了硬规矩：同进程内由类型保证的调用不做运行时校验，而配置、模型返回的 JSON、落盘文件、跨进程消息必须校验。下一阶段第一节就会用上它。

这条语言事实还有个更大的后果：TS 世界必须**手写一份类型的运行时副本**（schema）。opencode 里 `Schema.` 出现 6,835 次，dsh 用 Schemastery——它们存在的唯一原因就是"类型运行时不存在"。Python 靠 `__annotations__` 就能省掉这一份。

### 2. 别信任何人告诉你的运行时行为，包括讲义

这一阶段三节课，有两节的讲义在上课时被现场推翻：

- 0.1 原文说"Node 读不懂 `.ts`"——实测 `node src/hello.ts` 直接输出 `hello, dsh`（Node 22.18+ 内置类型剥离）。
- 0.2 原文说"`?.` 是 `strict` 的空值检查逼出来的"——实测去掉 `?.` 后 `strict` 根本不报错，真正管这件事的是 `noUncheckedIndexedAccess`。

两次都是跑一条命令就暴露的。**代码的行为只有一个权威：跑它。** 文档、教程、AI 的回答、你三个月前的记忆，都是二手的。

### 3. 一致性比个人偏好值钱

课程用 `node --import tsx` 而不是别的跑法，理由不是"它更好"，而是 **dsh 已经这么做了**：参考源码怎么跑，课程就怎么跑，你才能顺手把 `dsh/` 里的东西也跑起来对照。同理，`tsconfig.json` 的严格开关直接抄 `dsh/tsconfig.base.json`。

反过来，课程用 npm 而 dsh 用 pnpm，是同一条判断得出的相反结论：课程只有两个开发依赖，不需要 workspace，用 pnpm 只是徒增前置要求。**一致性是为了降低摩擦，不是为了整齐。**

### 4. 会 debug 才算会读代码

后面每加一层抽象，"这行到底执行没执行、值是什么"就难猜一分；到阶段 10 的 waterfall 事件，光靠读代码几乎不可能推出实际执行顺序。那时候你只有一个办法：停下来看。

dsh 把这个思路工业化了：**226 个包，226 个 `src/invariant.ts`**，在关系被破坏的瞬间就炸，而不是等症状在三层之外冒出来。

## 阶段 0 学了什么

| 课 | 知识点 |
|---|---|
| 0.1 | Node / 包管理器 / tsx 的分工；原生剥离的边界（`enum` 报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）；dsh 因此被迫回到 tsx，且当时**没有测试覆盖真实启动路径**；monorepo 与 workspace |
| 0.2 | 类型运行时不存在（对照 Python `__annotations__`）；六个常用语法；联合类型 + `assertNever`；`import type`；ESM 两条规则；`strict` 管不到数组下标 |
| 0.3 | Node 栈顺序与 Python 相反；忘了 `await` 的时序错乱（dsh 称其为"最有价值的一类 lint 抓到的 bug"）；`console.dir` 深度；四种"空"的区分；断点四面板；runtime invariant |

## 下一阶段的痛点预告

现在你有一个能打印 hello 的程序。下一阶段要让它**说话**——调用真正的模型。

第一个要面对的问题不是代码，是**密钥往哪放**：写进代码会被提交上去，写进配置文件也会被提交上去。删掉那一行也没用——git 历史里还留着，而且别人已经 clone 走了。

这个看起来很小的问题，在 dsh 里长成了一整条能力接缝（`dsh/packages/credentials/`）：密钥来源本身是可替换的，而且**每次请求现取**，这样配置变更能立刻生效，也不会把这一代的 URL 配上一代的密钥。

---

下一阶段：[阶段 1：最小 agent](../../01-minimal-agent/01-config-and-key/01-config-and-key.md)
