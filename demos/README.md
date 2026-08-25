# demos —— 每一课的可运行演示

课程里贴出来的每一段输出，都来自这里的一个脚本。**它们都不需要 API key**：需要模型的演示用的是一个按剧本回答的假服务器（`harness.mjs`）。

```sh
node --import tsx demos/04-tools/01-write-edit.mjs
```

或者用 npm 脚本（等价，少打点字）：

```sh
npm run demo demos/04-tools/01-write-edit.mjs
```

## 约定

- **每个演示自带一个临时工作目录**，跑完不留痕迹；不会碰你的仓库。少数需要一棵真实目录树的演示（例如 `06-search.mjs`）在课程仓库自己身上跑，但**只读**。
- 需要跑完整会话的演示走 `harness.mjs` 的 `跑一次会话()`：它起一个假模型服务器、写一份临时配置、用临时目录当工作目录把 `src/index.ts` 跑起来。
- 演示脚本是 `.mjs` 而不是 `.ts`，这样它们既能被 `tsx` 跑，也能直接被 `node` 跑（除非要 import `src/*.ts`）。

## 阶段 4：工具集

| 脚本 | 对应课 | 看什么 |
|---|---|---|
| `04-tools/01-write-edit.mjs` | 4.1 | write 的创建/覆盖报告；edit 的三种失败和一次成功 |
| `04-tools/02-edit-self-correct.mjs` | 4.1 | 模型撞上"不唯一"，看到错误后自己多带上下文重试 |
| `04-tools/03-bash.mjs` | 4.2 | 退出码、stderr、状态不保留、输出爆炸、超时、越界 |
| `04-tools/04-red-green.mjs` | 4.2 | 跑测试 → 读代码 → 改代码 → 再跑测试，一个 turn 四个 step |
| `04-tools/05-bash-bypasses-everything.mjs` | 4.2 | bash 一行绕过 edit 的路径护栏 |
| `04-tools/06-search.mjs` | 4.3 | glob 和 grep 的正常与异常输出 |
| `04-tools/07-shell-injection.mjs` | 4.3 | 模型给的 pattern 被 shell 执行；同一个 pattern 走工具则无事 |
| `04-tools/08-redos.mjs` | 4.3 | 一个正则把进程同步卡死，连定时器都醒不过来（会一直跑，Ctrl-C 结束） |
