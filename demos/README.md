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
- 需要跑完整会话的演示走 `harness.mjs` 的 `runSession()`：它起一个假模型服务器、写一份临时配置、用临时目录当工作目录把 `src/index.ts` 跑起来。
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
| `04-tools/09-pipeline.mjs` | 4.4 | 执行前拒绝、统一超时、执行后兜底、失败即拒绝 vs 失败即忽略 |
| `04-tools/10-read-only.mjs` | 4.4 | 同一个 agent 同一段模型输出，只改一个配置开关 |
| `04-tools/11-signal-fusion.mjs` | 4.4 | 换掉 signal 会把用户的取消挤掉；熔合之后谁先按都算 |

## 阶段 5：system prompt 组装

| 脚本 | 对应课 | 看什么 |
|---|---|---|
| `05-system-prompt/01-assembly.mjs` | 5.1 | 注册、排序、重名抛错、注销、条件性段落 |
| `05-system-prompt/02-model-sees-it.mjs` | 5.1 | 只读模式那句话现在在模型**决定之前**就到了 |
| `05-system-prompt/03-variables.mjs` | 5.2 | 插值的八种情况：三种错误、孤立的 `{{`、值不二次展开、取值时机 |
| `05-system-prompt/04-variables-pain.mjs` | 5.2 | 每段自己取值 spawn 两次 git，注册成变量之后只取一次 |
| `05-system-prompt/05-runtime-context.mjs` | 5.3 | 一个 turn 三次请求里，快照的位置和自我取代 |
| `05-system-prompt/06-why-not-system-prompt.mjs` | 5.3 | 时间放进 system prompt 会打断多长的缓存前缀；去重与清空 |
| `05-system-prompt/07-complete-and-slots.mjs` | 5.4 | 具名槽位替换、`complete` 只留一段、两段冲突、最小 subagent |
