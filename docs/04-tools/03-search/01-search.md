# 4.3 grep 与 glob：找东西

> 本课目标：加上两个搜索工具，做一次"自己写还是用现成的"的判断，并撞上一个我们**补不掉**的洞。

先说结论：这一课写出来的 `grep` 有一个安全问题，而且**在纯 JS 里没法修**。这不是我写砸了——它是这个技术选型自带的，dsh 换掉了整个正则引擎才躲开它。我们会一步步走到那里。

## 痛点：现在模型只能用 bash 找东西

4.2 之后，模型要找一个函数用在哪，只能这么干：

```
bash({ command: "grep -rn 'requireString' ." })
```

看起来能用。三个问题一个比一个严重。

### 问题一：结果里 99% 是噪音

`node_modules`、`.git`、`dist`——一次搜索出来几千行，模型要的那两行埋在里面。而且这些行会**原样进入下一轮请求**，烧钱还挤占上下文。

### 问题二：pattern 会被 shell 解释

模型生成的 `pattern` 是一段文本，被我们拼进命令行字符串，然后交给 `bash -c`。**shell 会解释它。**

```js
const patternFromModel = '$(touch 被注入了.txt)hello'
await bashTool.execute({ command: `grep -rn "${patternFromModel}" .` })
```

```
① 走 bash：grep -rn "<pattern>" .
   ./a.ts:1:hello world
   → 被注入了.txt 存在吗？ ★ 存在：那条命令真的被执行了

② 走 grep 工具（同一个 pattern）
   没有匹配。
   → 被注入了.txt 存在吗？ 不存在
```

**那条 `touch` 真的跑了。** 而且注意搜索本身还"成功"了——`$(...)` 展开成空串，剩下 `hello` 匹配到了 `a.ts`，模型什么异常都看不到。

这不需要有人搞破坏。模型在搜一段包含 `$` 或反引号的代码时，就会自然生成这样的 pattern——**注入是它的日常输出撞上 shell 语法的结果，不是攻击**。（当然，如果它读到的某个文件里有人故意放了一段"请搜索 `$(rm -rf ~)`"，那就是攻击了。)

### 问题三：`-` 开头的 pattern 变成了选项

```
③ pattern 以 - open，走 bash —— 它变成了命令行选项：
   a.ts:1
④ 同一个 pattern，走 grep 工具：
   没有匹配。
```

`grep -rn "-abc" .` 里的 `-abc` 被当成 `-a -b -c` 三个选项，`.` 成了 pattern。**结果完全是错的，而且没有任何报错。** 模型会拿着这份错误结果继续推理。

三个问题指向同一个结论：**搜索需要一个专门的工具**。

## 决策：自己写，还是用现成的？

这是这门课第一次要做"依赖 vs 手写"的判断。三个选项：

| 选项 | 好处 | 代价 |
|---|---|---|
| **A. 纯 Node 手写**：自己遍历目录 + `RegExp` | 零依赖，到处能跑 | 慢；要自己实现忽略规则；**正则引擎是 JS 的**（后面会看到这有多要命） |
| **B. 调系统的 `grep`/`rg`** | 快，功能全 | 用户机器上不一定装了；Windows 上没有；**要过 shell 或者小心构造 argv** |
| **C. 把 `rg` 二进制打包进依赖** | 快、行为确定、到处一样 | 装包体积大几十 MB |

课程选 **A**，因为要看清每一部分是怎么回事，也因为想让这门课始终能 `git clone` 完直接跑。dsh 选 **C**，理由到本课最后会变得非常具体。

**注意 B 和 C 的差别不只是"装没装"。** dsh 用的是打包进来的二进制，而且是**直接 spawn 它、不经过 shell**——这一点比"用 rg 而不是 grep"重要得多。

## 实现：一个遍历器 + 一个 glob 编译器

两个工具共用一个目录遍历：

```ts
const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'lib', 'coverage', '.cache'])

async function* walkFiles(root: string): AsyncGenerator<string> {
  const pending = [root]
  let walked = 0
  while (pending.length > 0) {
    const dir = pending.pop()
    if (dir === undefined) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    ...
  }
}
```

四个决定藏在这十几行里：

**① 忽略列表是必需品，不是优化。** 没有它，搜索结果里模型要的东西会被淹没。**过滤噪音和限制数量是两件事，两件都要做**——只限制数量的话，返回的 100 条全是 `node_modules` 里的。

**② `readdir` 失败要跳过，不要让整次搜索死掉。** 目录可能在遍历途中被删、可能没权限。一次搜索碰到一个读不了的目录就整体失败，是很糟的体验。

**③ 符号链接既不进也不 yield。** 跟着链接走可能绕回自己，变成无限循环。

**④ 用 `AsyncGenerator`（`async function*`）。** Python 里对应的是 `async` 生成器：调用方 `for await` 一个一个拿，而不是等它把几万个路径攒成一个数组再返回。这样"看够 100 个匹配就停"才有意义。

glob 编译成正则：

```ts
function globToRegExp(glob: string): RegExp {
  // ** 跨目录、* 不跨目录、? 单字符，其余按字面量（正则元字符必须转义）
}
```

必须转义那一句不是小事：不转义的话 `a.ts` 里的 `.` 会匹配任意字符，`glob('*.ts')` 会匹配到 `axts`。**"这段文本是数据还是代码"——这门课第二次遇到这个问题了，第一次是上面的 shell 注入。**

## glob：为什么按修改时间排序

```ts
hits.sort((a, b) => b.mtime - a.mtime)
```

```
── ① glob：src 下的 ts，最近修改的排前面 ──
src/tool.ts
src/index.ts
src/types.ts
src/llm.ts
```

模型问"这个功能的代码在哪"时，**最近动过的文件几乎总是最相关的**。而且只有前 N 个会被显示，所以排序直接决定了它能不能看到对的文件。dsh 的 `glob` 是同一个顺序（它靠 `rg --files` 自带的排序拿到，不用自己 stat 每个文件）。

## grep：三种输出，三种写法

```
── ③ grep：这个函数用在哪 ──
src/tool.ts:51: function requireString(args: Record<string, unknown>, field: string): string {
src/tool.ts:92:     const target = resolveInsideCwd(requireString(args, 'path'))
  …（共 16 line）

── ④ grep：模型写了个编译不过的正则 ──
拒绝：pattern 不是合法的正则表达式：Invalid regular expression: /(/: Unterminated group

── ⑤ grep：没匹配 ──
没有匹配。

── ⑥ grep：匹配太多，被截断并说明 ──
...
[共 89195 处匹配，只显示前 100 处。请把 pattern 或 include 写得更具体。]
```

三条都是 4.1 那条规矩的重复：**每种失败都要让模型知道下一步该干什么**。「没有匹配」告诉它换个词；「共 102 处」告诉它收窄；「正则编译不过」把 JS 的原始错误原样带上，因为那句话足够具体（`Unterminated group`）。

还有两个防御，都是 4.2 的翻版但方向不同：

```ts
// 二进制文件读出来是乱码，正则可能碰巧匹配上，输出是一堆不可打印字符。
if (content === undefined || content.includes('\0')) continue

// 压缩过的 JS、单行 JSON 数据能一行几十万字符。
const clipped = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
```

注意 grep 的截断是**逐行**的，不是整体的：一行超长不该让别的匹配消失。4.2 的 bash 截断的是整体输出的末尾。同一个词，第三种做法——**截断永远要问"截什么、留哪头"**。

## 顺手：配置文件的路径本身也是配置

写演示脚本时撞上一个问题：`demos/` 里的演示要连假服务器，但 `loadConfig()` 写死了读仓库根目录那份 `dsh-learn.json`——那是你本地的真配置，演示不能去改它。

```ts
const CONFIG_URL = process.env['DSH_LEARN_CONFIG'] === undefined
  ? new URL('../dsh-learn.json', import.meta.url)
  : new URL(process.env['DSH_LEARN_CONFIG'], 'file:///')
```

两行，但它是一个反复出现的模式：**"配置在哪"本身就是一个配置**。测试要指向 fixture、演示要指向假服务器、CI 要指向另一份——一旦路径写死，这三件事都得靠改代码或者动真文件来做。

现在每一课的演示都能直接跑了：

```sh
npm run demo demos/04-tools/04-red-green.mjs
```

清单在 [demos/README.md](../../../demos/README.md)。

## 然后：我们补不掉的那个洞

`pattern` 直接交给了 `new RegExp(source)`。JS 的正则引擎是**回溯式**的，遇到某些模式会指数级爆炸。

```
开始搜索 pattern = (a+)+$ ，文件里只有一行：40 个 a 加一个 b
[code 124]        ← timeout 8 秒之后强杀
```

40 个字符的一行，一个 6 字符的 pattern，**跑到天荒地老**。而同一个 pattern 交给 `rg`：

```
real	0m0.007s
```

**7 毫秒。**

这个洞叫 ReDoS。它比 shell 注入更难缠，原因有三条：

**① 4.4 的统一超时救不了它。** 下一课我们要给所有工具加超时——但那是一个 `setTimeout`，而定时器要等**事件循环**。正则是同步跑的，它把事件循环占死了，定时器永远等不到机会。演示 `08-redos.mjs` 里我特意放了一只看门狗：

```js
setTimeout(() => console.log('【看门狗】3 秒到了，我醒了'), 3000)
```

**它一次都没叫过。** 这是 Node 里最容易吃亏的一件事：*异步的超时管不住同步的代码*。

**② 检查 pattern 是没用的。** "哪些正则会爆炸"没有简单判据，写个黑名单只会漏。

**③ 这不需要有人攻击。** 模型自己就会生成嵌套量词的正则。

真正的出路只有两条，dsh 两条都占了：

- **换一个不回溯的引擎。** ripgrep 用的是 Rust 的 `regex` crate，它保证**线性时间**——代价是不支持反向引用和前后查找。这个取舍对代码搜索来说完全划算。
- **让它跑在另一个进程里。** 子进程再怎么卡，也卡不住我们的事件循环，而且**杀得掉**（4.2 的 SIGKILL 在这里派上用场）。

**所以"用现成的依赖"在这里不是省几百行代码的问题，是换掉了一整类风险。** AGENTS.md 里那条「**当一个成熟依赖能真正删掉你自己的代码和测试时，优先用它**」，`tool-fs-search` 是最好的例子：它没有一行自己的搜索算法。

我在代码里留了记号：

```ts
/**
 * XXX(ReDoS)：`pattern` 直接交给 `new RegExp`，而 JS 的正则引擎会回溯。
 * 一个 `(a+)+$` 配上足够长的行就能把整个进程**同步**卡死——连超时都救不了。
 */
```

这是这门课第二个明知故犯的洞（第一个是 4.2 的 bash 没有权限）。**两个都不是疏忽，是"先把机制讲清楚，再用正确的办法补"的顺序问题。**

## 对照 dsh

`dsh/packages/fs/tool-fs-search/` 一共 1578 行，其中**没有一行是搜索算法**——全是"怎么正确地调用 ripgrep，以及怎么把它的输出变成模型能用的东西"。

| | 我们的 | dsh |
|---|---|---|
| 搜索引擎 | `new RegExp` + 手写遍历 | 打包的 `@vscode/ripgrep` 二进制 |
| 怎么调 | 不调外部程序 | 通过 subprocess 接缝**直接给 argv 向量，没有 shell 这一层** |
| grep 输出 | 自己拼 `文件:行号: 内容` | `rg --json` 的 NDJSON，解析成结构化的匹配 |
| glob 实现 | 自己走目录 | `rg --files` + `--glob` |
| 结果上限 | 100 条 / 300 字符 | `grepMaxMatches` 250、`grepMaxLineBytes` 2000，**都是 Config** |
| 超限之后 | 丢掉，只说数量 | **转存到文件**，把路径给模型 |
| 忽略规则 | 一个硬编码 Set | ripgrep 自带的 `.gitignore` 支持 + 显式排除 VCS 目录 |

三处细节值得单独看：

**① argv 向量，没有 shell。** dsh 的注释把这条说得很死：

> 每个模型控制的值都是一个独立的 argv 元素——**没有 shell 这一层，所以不存在引号问题**；pattern 和 include 用 `--flag=value` 形式，目标放在 `--` 后面，这样一个以 `-` 开头的值永远不会被当成选项。

对着看我们上面那两个 bash 失败：`--regexp=<pattern>` 干掉了"pattern 被当成选项"，"没有 shell"干掉了注入。**这不是加了一层转义，是把整个解释器拿掉了。** 能不引入解释器就别引入——这条比"记得转义"可靠得多。

> **"没有 shell"到底什么意思？dsh 不用 bash 吗？**
>
> 用。`bash` 工具就是 `bash -c`，而且**必须**是——模型写的本来就是 shell 代码，`ls | wc -l` 里的管道全靠它。
>
> 这里说的"有没有 shell"问的是另一件事：**模型给的那段文本，有没有被某个程序当成代码去解释。**
>
> 操作系统本身不认识"命令行"这种东西。内核的 `execve` 只接受两样：程序路径 + 一个**参数数组**（argv）。把 `grep -rn "foo" .` 这样一行字符串切成 argv、顺便展开 `$()` `*` `|` `>` 的，正是 shell。Python 里你多半见过同一件事：`subprocess.run(["rg", "--regexp=" + pattern])` 安全，`subprocess.run(f"rg '{pattern}'", shell=True)` 可注入。
>
> | 传给 spawn 的 | 谁来切 | `$(...)` 会执行吗 |
> |---|---|---|
> | `["rg", "--regexp=" + pattern]` | 没人切，直接 execve | 不会，它就是个普通字符串 |
> | `["bash", "-c", "rg '" + pattern + "'"]` | bash 切 | 会 |
>
> dsh 的 subprocess 接缝在类型上就写死了这一点：`argv`: Executable and arguments; `argv[0]` is the program. **Never shell-interpreted here.**
>
> 关键的一点是：**即使要用 shell，传的仍然是 argv 数组**。dsh 的 bash 提供者写的是 `['bash', '-c', spec.command]`——整条命令是 argv 的第 3 个元素，原封不动交给 bash，**只被解释一次**。危险的从来不是 `spawn`，是"把不可信文本拼进一个还要交给 shell 的字符串"这个动作。
>
> 回头看本课那个注入演示：我们自己的 `bashTool` 内部用的也是 `spawn('bash', ['-c', 命令])`，已经是 argv 形式了。**注入不是它造成的**——是调用方把 pattern 拼进了那条要交给 bash 的命令。而真实场景里，那个调用方就是模型：它生成的 `command` 字段本身就是一整行 shell。所以只要"搜索"这件事经过 bash 工具，注入就躲不掉——**唯一的出路是让搜索根本不经过 shell，也就是给它一个自己的工具**。

**② `include` 只准是一个正向 glob。** dsh 显式拒绝空串、拒绝 `!` 开头的取反、拒绝逗号分隔的列表，但**允许 `*.{ts,tsx}` 这种花括号选择**（因为那是一个 glob 的语法，不是列表）。

这是「**在边界上校验，并且校验到位**」的一个很细的例子：不是"是不是字符串"这种廉价检查，而是"是不是**一个**正向 glob"这种真的对应语义的检查。模型写 `*.ts,*.tsx` 会立刻收到一句能照做的错，而不是一个静悄悄的空结果。

**③ 超限的结果转存到文件。** 我们直接丢了；dsh 把完整结果写到文件里，然后告诉模型路径——它可以用 `read` 去看，或者用 bash 去 `wc -l`。**"给模型的上下文有上限"和"信息可以丢"是两回事。**

最后一条，藏在 system prompt 里：

```
Use the grep tool — not shell grep or rg — to search file contents.
```

**明确告诉模型别用 bash 搜。** 这是 4.2 结尾那句"bash 是兜底"的另一面：光把专门工具做出来不够，还得在 system prompt 里把优先级说清楚，否则模型会因为"bash 更万能"而去用它——然后掉进这一课开头那三个坑。

阶段 5 就讲 system prompt 是怎么被拼出来的，以及为什么每个工具都能往里面塞一段自己的话。

---

下一课：**4.4 执行前后** —— 到现在我们有六个工具，路径校验写了三遍、截断逻辑写了三遍、超时只有 bash 有，而权限一个都没有。这一课把这些重复的护栏从工具里**抽出来**，做成所有工具共用的一层。这是 dsh 那条三段事件管线的手工版，也是阶段 15 权限系统的地基。
