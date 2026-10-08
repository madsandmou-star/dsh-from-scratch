# 0.3 Debug：这门课最重要的一课

> 本课目标：建立一套"跑不通时先做什么"的固定动作。
>
> AI 让"跑通"变得廉价，但**跑通不等于看懂**。真正搞明白一段代码怎么运转，最有效的办法是去 debug 它：读报错栈、追数据流、定位根因、验证假设。这门课后面每一节都会带一处 debug 手法，本课先把工具备齐。

## 一、读报错：找到"你自己的那一帧"

一个典型的 Node 报错栈：

```
Error: 找不到配置文件 /home/you/DshFromScratch/dsh-learn.json
先复制模板：cp dsh-learn.example.json dsh-learn.json
    at loadConfig (file:///home/you/DshFromScratch/src/config.ts:38:11)
    at file:///home/you/DshFromScratch/src/index.ts:14:16
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)
```

读法：

1. **第一行是结论，不是根因。** 它告诉你"发生了什么"，不告诉你"为什么会走到这里"。
2. **从上往下找第一个属于你的文件**（这里是 `config.ts:38`，然后是 `index.ts:14`）。`node:internal/...` 开头的帧是 Node 自己的，通常可以跳过。
3. **异步栈会断。** `await` 之后的调用栈常常只剩几帧，看不到"是谁一路调过来的"。这时候别硬看栈，改用下面的打点法。

一条经验：**报错行不等于出错行**。上面这个例子里，真正的错误发生在你**没有创建配置文件**，而报错行是"发现文件不存在的那一行"。定位根因要往回追一步——`config.ts:38` 想读的是哪个路径？那个路径为什么不对？

## 二、打点：`console.log` 的三种正确用法

```ts
// 1. 打值，并带上名字（不带名字的日志在滚屏里毫无意义）
console.log('messages:', messages)

// 2. 打完整结构（嵌套对象默认会被折叠成 [Object]）
console.dir(messages, { depth: null })

// 3. 打类型和"是不是空"，而不是只打值
console.log('content:', typeof content, content === null, JSON.stringify(content))
```

第三条最容易被忽略：`console.log(x)` 打出来的 `undefined`、`"undefined"`、空字符串在屏幕上长得几乎一样，但它们是三种完全不同的故障。加上 `typeof` 和 `JSON.stringify` 就分得开了。

打点的位置也有讲究：**打在你相信为真的那句断言旁边**。比如你相信"发出去的 messages 里第一条是 system"，那就在发请求前一行把它打出来。agent 出问题时十有八九不是模型笨，而是你以为发出去的东西和实际发出去的不一样。

## 三、断点：让程序停下来

打点是"猜哪里有问题然后去看"，断点是"停下来把整个现场翻一遍"。

```sh
node --inspect-brk --import tsx src/hello.ts
```

`--inspect-brk` 让进程在第一行就暂停，并打开一个调试端口，终端会打印 `Debugger listening on ws://127.0.0.1:9229/...`。然后有两种接法：

- **VS Code**：命令面板 → `Debug: Attach to Node Process`，选中那个进程。更省事的办法是本仓库已经配好的 [`.vscode/launch.json`](../../../.vscode/launch.json)——在行号旁点一个红点下断点，按 F5 选「调试当前打开的文件」或「调试 agent」，不用敲任何命令。
- **Chrome**：地址栏输 `chrome://inspect`，点 `inspect`。

停下来之后重点看四样东西：

| 面板 | 回答的问题 |
|---|---|
| Variables | 现在这些变量**实际**是什么值 |
| Call Stack | 是谁调到这里来的 |
| Watch | 我关心的那个表达式现在等于几 |
| Step Over / Into / Out | 下一步走哪 |

在 [`src/hello.ts`](../../../src/hello.ts) 的 `return \`hello, ${name}\`` 那行下个断点跑一次，先把手感建立起来——后面阶段 3 的工具循环里，"模型到底给了什么参数"用断点看比打日志快得多。

## 四、三类故障的固定动作

| 现象 | 先问自己 | 具体动作 |
|---|---|---|
| **拿不到值**（undefined） | 是没赋值，还是赋值了但取错了字段？ | 把上一层对象整个 `console.dir` 出来，对着看字段名拼写 |
| **类型不对**（运行时炸在某个方法上） | 数据是从哪个边界进来的？ | 找最近的一个"外部输入"点（JSON、文件、网络、命令行），在那里打 `typeof` |
| **根本没执行到** | 是条件没进去，还是压根没调用？ | 在函数第一行打一条日志；还看不到就往调用方走一层 |

第三类最费时间，因为屏幕上"什么都没发生"。固定动作是**先证明代码被执行了**，再谈逻辑对不对。

## 五、对照 dsh：断言放在哪里

dsh 产品里一直开着的检查，放在**数据进门的那一刻**。`dsh/packages/core/session/src/index.ts` 的 `append()`，一条事件进日志之前先过两道：

```ts
validateSessionEventData(event, `session event "${type}" at seq ${event.seq}`)
this.surfaceManager.validateNext(event as SessionEvent)
```

任何一道不过就直接抛错，这条事件根本进不了日志。这就是"在关系被破坏的那一刻就炸"：坏数据在写入那一刻被拦住，而不是等三步之后，某个读日志的地方冒出一个莫名其妙的症状。（阶段 2 会看到这两行在 `append()` 里的完整位置。）

dsh 还试过另一种放法，而且刚刚把它整个删了，正好拿来对比：

- 每个包旁边可以有一个 `src/invariant.ts`，从旁边**事后核对**几件事之间的关系，比如"循环发给模型的请求，能不能从会话日志重建出来"。dsh 0.1 时每个包都有一份（226 个），0.2.0-rc.2 收缩到 38 个。
- 早在 2026 年 8 月，它们就不在正式发布的装配里跑了。那份设计笔记（`dsh/.agents/notes/archived/simplification/2026-08-03-omit-invariants-from-shipped-config.md`）把它们定性为 "optional development diagnostics"（可选的开发诊断），留给测试和显式开启诊断的部署；同时写明 "Session validation, snapshotting, freezing, and cited source-event validation remain always on"——会话的校验、快照、冻结一直开着，不依赖它们。
- 0.2.1-alpha.1 把整套运行时不变量插件删掉了：提交 `f028f25667`（"refactor: remove runtime invariant plugins"）和升级指南 `dsh/docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md`。**dsh 没有写下删除的理由。**

从这个过程能读出一个判断（这是教师判断，不是源码事实）：**一直开着的检查要放在入口**——数据进来那一刻就验，它永远在，开销只付一次；**放在旁边事后核对的检查**要单独装、单独维护，一旦没装就什么都不防。dsh 先把后一种从正式装配里拿掉，再收缩数量，最后整个删除，把保证留在了入口校验和测试里。

你在这门课里手动做的"打点验证假设"，属于第一种：在你怀疑出错的那个位置、那个时刻去看。阶段 19 会专门讲各种检查各自防住哪一类回归。

---

下一课：[0.4 阶段验收](../04-stage-review/01-stage-review.md)
