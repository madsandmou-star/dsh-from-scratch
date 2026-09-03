# 4.2 bash：把整台机器交给模型

> 本课目标：加上 `bash` 工具，并把它带来的四个现实问题——超时、输出爆炸、退出码、状态不保留——一次讲完。最后撞上一个这门课到现在为止最大的漏洞。

## 先问一个诱人的问题：有了 bash，还要 read/write/edit 吗？

看起来不要了。`cat` 能读、`tee` 能写、`sed -i` 能改，一个工具顶三个，模型也早就会写 shell。

先把 bash 做出来，再回答这个问题。

## 一次执行要处理四件事

```ts
function runCommand(command: string, workdir: string, timeoutMs: number): Promise<CommandOutcome> {
  return new Promise(resolve => {
    const child = spawn('bash', ['-c', command], { cwd: workdir })
    ...
  })
}
```

### ① 超时：模型不会自己发现"卡住了"

`npm install` 卡在网络上、`vim` 等你按键、`tail -f` 永远不结束——这些情况下模型什么也收不到，整个 agent 就停在那里。**必须有人替它数秒。**

```ts
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
```

用 `SIGKILL` 而不是 `SIGTERM`：命令可以捕获 SIGTERM 然后赖着不走，而超时的意义就是"无论如何都要停下"。代价是它没机会清理临时文件，这里接受这个代价。

### ② 输出爆炸：`seq 1 20000` 就能撑爆上下文

工具的返回值会原样进入下一轮请求的 messages。一条 `find /` 能产出几百 MB。

```ts
class TailBuffer {
  private text = ''
  private dropped = false
  push(chunk: string): void {
    this.text += chunk
    if (this.text.length > MAX_OUTPUT_CHARS) {
      this.text = this.text.slice(-MAX_OUTPUT_CHARS)
      this.dropped = true
    }
  }
}
```

两个决定：

**边收边裁，不是收完再裁。** `yes` 一秒能产出几十 MB，等收完你的进程已经 OOM 了。截断必须发生在**数据进来的那一刻**。

**保留末尾，不是开头。** 3.3 的 `read` 保留的是开头（文件从头读才有意义），bash 正相反：**命令的结论在最后**——报错信息、失败的测试、`Done`。保留开头等于只看到一堆编译日志，看不到最后那句 `error:`。

同一个"截断"动作，方向由内容的性质决定，不能照搬。

### ③ 退出码：非零不是异常

```
── grep 没找到 ──
(没有输出)
[code：1]
```

`grep` 没匹配到就退 1，`test` 判假也退 1，`diff` 发现差异退 1。**这些都不是故障，是结果。** 所以退出码作为一行标记附在输出末尾，而不是抛异常：

```ts
if (result.timedOut) markers.push(`[超时：跑满 ${timeoutMs}ms 后被杀掉]`)
if (result.killedBy !== null) markers.push(`[被信号杀掉：${result.killedBy}]`)
else if (result.code !== 0) markers.push(`[退出码：${result.code}]`)
```

这是 3.3 那条"执行失败要变成文本"的延伸：**该怎么反应由模型决定，工具只负责如实报告。**

stderr 也要**标出来**而不是和 stdout 混在一起：

```
[stderr]
ls: cannot access '/nonexistent-dir': No such file or directory
[code：2]
```

混着给，模型分不清哪句是结果、哪句只是个警告。

### ④ 每次都是新 shell：状态不保留

```
── ④ 这一次 cd 了 ──
/tmp

── ⑤ 下一次还记得吗 ──
/home/user/.../play41
```

`bash -c` 每次都起一个新进程。`cd`、环境变量、shell 函数，全都不留。这不是 bug，是最简单也最可预测的语义——但**模型不知道**，除非你告诉它：

> 每次调用都是**全新的 shell**：cd、变量、函数都不会留到下一次，要换目录请用 workdir 参数而不是 cd。

这句话写在 `description` 里。少了它，模型会写出 `cd src` 然后下一条命令假设自己在 `src/` 里——然后困惑地看着一堆 "No such file"。

> **debug 手法**：agent 的命令莫名其妙找不到文件时，第一件事是**在每条命令前面加一个 `pwd &&`** 跑一遍。十有八九是它以为自己在某个目录里。

## 一个新的设计动作：默认值要显式取

```ts
const rawTimeout = args['timeout_ms']
if (rawTimeout !== undefined && (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0)) {
  throw new Error(`参数 timeout_ms 必须是正数，实际收到：${JSON.stringify(rawTimeout)}`)
}
const timeoutMs = rawTimeout ?? DEFAULT_TIMEOUT_MS
```

注意默认值是在**调用之前**取出来的，不是藏在 `runCommand()` 内部写成 `超时毫秒 ?? 30000`。差别在于：这样写，"这次到底用了多少秒"是一个能打印、能记日志、能出现在错误信息里的**值**；藏在里面就只有函数自己知道。

dsh 把这条写成了明规矩：**请求（request）和规格（spec）是两个类型**，中间隔一步显式的 `resolve()`。

```ts
// dsh/packages/shell/shell/src/types.ts
interface ShellExecRequest { command: string; workdir?: string; timeoutMs?: number; ... }
interface ShellExecSpec    { command: string; workdir: string;  timeoutMs: number;  ... }
```

可选字段进去，必填字段出来。AGENTS.md 里那条"**默认化是 `resolve(request): Spec` 这一步显式的动作，不是 `run()` 里藏着的 `?? 默认值`**"，用的就是 shell 这个包当模板。

## 顺手修一个显示 bug

第一次跑完整循环时，CLI 里那行摘要是这样的：

```
  [工具] bash({"command":"node test.mjs",...})
         → [stderr]
```

**没有任何信息量。** 原因是 3.4 里那行代码取的是结果的**首行**，而 bash 的首行经常是 `[stderr]` 这个分节标题。

通用规则对某个具体工具不合适——正确的修法不是把通用规则改得更复杂，而是**让工具自己说它该怎么显示**：

```ts
export interface Tool {
  ...
  /** 可选：把执行结果压成一行给人看的摘要。 */
  summarize?(result: string): string
}
```

```ts
summarize(result) {
  const lines = result.split('\n').filter(line => line.trim() !== '' && line !== '[stderr]')
  const lastTwo = lines.slice(-2).join(' / ')
  return lines.length > 2 ? `（共 ${lines.length} 行）… ${lastTwo}` : lastTwo
}
```

修完之后：

```
         → FAIL: add(2, 3) 期望 5，实际 -1 / [code：1]
```

**谁最清楚自己的输出长什么样，谁就该负责它怎么显示。** 这正是 dsh 那条"**工具的 UI 呈现意图是设计的一部分**"——只不过 dsh 的版本强得多：`presentCall()` 决定调用时画什么卡片（bash 画终端、edit 画 diff），`presentResult()` 决定结果怎么显示，而且它们是**纯函数**，重放会话时不用重新执行工具就能重画界面。阶段 12 会做这一层。

## 真正的时刻：红 → 绿

现在把 4.1 和 4.2 拼起来。一个有 bug 的文件、一个跑不过的测试，剧本让模型自己走完整个修复流程：

```
你 > test.mjs 跑不过，修好它

模型 >
  [工具] bash({"command":"node test.mjs","description":"跑测试看看现在是什么情况"})
         → FAIL: add(2, 3) 期望 5，实际 -1 / [code：1]

模型 >
  [工具] read({"path":"add.mjs"})
         →    1: export function add(a, b) {

模型 >
  [工具] edit({"path":"add.mjs","old_string":"  return a - b","new_string":"  return a + b"})
         → 已修改 add.mjs（替换了 14 ch → 14 ch）

模型 >
  [工具] bash({"command":"node test.mjs","description":"再跑一次测试确认修好了"})
         → PASS

模型 > add 里写成了减法，已改成加法，测试通过了。
```

**跑测试 → 读代码 → 改代码 → 再跑测试。** 这是一个 turn 里的四个 step，全部由模型自己决定顺序。到这里，我们造的东西第一次真的像个 coding agent 了——而它总共只有六百多行。

值得停下来看一眼这四步里每一步都用到了前面哪一课：step 1 的退出码（4.2）、step 2 的行号（3.3）、step 3 的唯一匹配（4.1）、step 4 的循环本身（3.4）。**没有任何一课是白讲的。**

## 回答开头那个问题

有了 bash，还要 read/write/edit 吗？**要。** 三个理由：

| | bash 的做法 | 专门工具的做法 |
|---|---|---|
| 读文件 | `cat a.ts` —— 没行号，没截断上限，一个大文件直接爆上下文 | `read` 带行号、有 50KB 上限并明说截断了 |
| 改文件 | `sed -i 's/a/b/'` —— 正则、转义、多处误伤，还没法报"匹配了几次" | `edit` 唯一字面匹配，三种失败三条可改正的错 |
| 跨平台 | Windows 上没有 `sed`，`cat` 也不是那个 `cat` | Node 的 `fs` 到处都一样 |

更根本的一条：**专门工具的每一个约束都是给模型的护栏。** `edit` 逼着模型先读原文、逼着它精确；`sed -i` 什么都不逼，于是模型什么都敢试。

bash 的位置是**兜底**：跑测试、跑构建、git、查进程——那些没有专门工具、也不值得为它写专门工具的事。所以 `description` 里最后一句是：

> 读文件请优先用 read（它带行号），改文件请优先用 edit——bash 用来跑那些没有专门工具的事。

## 然后，这门课到现在最大的漏洞

`edit` 有路径检查，出不了工作目录。`bash` 呢？

```
edit 想动工作目录之外的文件：
  ❌ 路径越界：../../etc/hosts 解析后落在工作目录之外

bash 想删掉工作目录里的三年工作：
  删完了

bash 想读工作目录之外的东西：
  vm
```

**bash 一行就绕过了我们所有的护栏。** 它能读 `/etc`、能删任何东西、能 `curl` 把你的代码发出去。我们前面在 `read`/`write`/`edit` 上花的所有心思，在 `bash` 面前等于零。

这不是我们写漏了——**这是 bash 这个工具的本质**：它的能力等于整台机器的能力，而"命令行里哪些是危险的"根本无法靠检查参数判断（`rm -rf /` 危险，`rm -rf node_modules` 每天都在做）。

所以答案不可能在这个工具里面。它只有两条出路，dsh 两条都走了：

1. **执行之前问人**——把决定权交回给用户。这需要一个所有工具共用的"执行前"拦截点，而不是每个工具自己写一份。**这就是 4.4 要做的事**，也是阶段 15 权限系统的地基。
2. **把能力本身关小**——让命令跑在一个进不去 `/etc`、连不上外网的沙箱里。dsh 的 `dsh/packages/shell/bash-sandbox/` 就是干这个的，而且失败时给模型一个专门的标记：`[sandbox: file access denied under <mode> mode]`，并明确告诉它"这是策略拒绝，不是命令有 bug，别换个写法重试"。

我在代码里留了个记号：

```ts
/**
 * XXX(权限)：这个工具现在什么都拦不住——`rm -rf ~` 会照跑不误。
 * 阶段 15 会加上审批，届时拦截点不在这个工具里，而在统一的执行前钩子上。
 */
```

**在真实项目里，"知道有个洞但现在不补"和"没意识到有洞"是完全不同的两件事**，区别就在于有没有这样一条记号。dsh 自己的 `tool-bash` 顶上也有一条一模一样的：

```ts
// TODO(permissions): deployment policy belongs in `tools/pre-execute` and
// sandboxing executors; see docs/architecture.md § Where new behavior goes.
```

注意它连**该补在哪儿**都写清楚了：不在这个工具里，在 `tools/pre-execute` 上。

## 对照 dsh

`dsh/packages/shell/` 下面有十来个包，我们这一课的 150 行对应的是其中几个：

| | 我们的 | dsh |
|---|---|---|
| 结构 | 一个函数 | **能力接缝**：`shell`（定义）+ `bash-local`/`bash-sandbox`/`pwsh-local`（提供者）+ `tool-bash`（消费者） |
| 超时 | 常量 `DEFAULT_TIMEOUT_MS` | `bash-local` 的 **Config 字段**：`timeoutMs: z.number().default(120_000)`，还有 `maxTimeoutMs` **把模型请求的超时钳住** |
| 输出过大 | 丢掉，只留末尾 | 同样只留末尾，但**全量转存到文件**，并把路径告诉模型：`[output truncated; full output: /path/...]` |
| 长命令 | 只能等超时 | `run_in_background: true` 立刻返回一个 job id，用 `job_output` 读、`job_kill` 停 |
| 状态保留 | 不保留 | 不保留；想要保留的另有 `tool-bash-persistent` 一整个包 |
| Windows | 没有 bash 就完了 | `tool-pwsh` + `pwsh-local`，同一套接缝换个提供者 |
| 危险操作 | 无 | 沙箱 + `tools/pre-execute` 上的审批 |

有两条值得单独说：

**超时是 Config，不是常量。** 我们写的是 `const 默认超时毫秒 = 30_000`；dsh 写的是一个能从 `cordis.yml` 改的配置字段。AGENTS.md 里那条规矩说得很硬：「**插件里不许有硬编码的可调参数**：随部署变化的选择必须是可校验的 `Config` 字段——一个 `DEFAULT_*` 常量不算可配置。」超时该是 30 秒还是 5 分钟，取决于这个 agent 装在谁的机器上跑什么活，**这不是写代码的人能决定的事**。

**模型给的超时会被钳住。** `clampTimeout(request.timeoutMs, config.timeoutMs, config.maxTimeoutMs)`——模型可以要求更长的超时，但要不到超过部署允许的上限。**模型的请求是输入，不是命令**，这和"路径要检查"是同一条规矩的另一个面。

顺带一提，`description` 这个我们"要了但不用"的参数，在 dsh 里也是**必填**的，而且它有真正的用处：`presentCall()` 用它当终端卡片的副标题给人看。阶段 15 的审批弹窗也要靠它——用户看到的不该是一串 `find . -name '*.ts' -exec rm {} \;`，而该是模型自己写的那句"删掉所有 TypeScript 文件"。

---

下一课：**4.3 grep 与 glob** —— 找东西。表面上是两个小工具，实际要做一次"自己写还是用现成的"的判断，以及一个比 4.2 更棘手的输出规模问题：搜索结果比文件内容更容易爆。
