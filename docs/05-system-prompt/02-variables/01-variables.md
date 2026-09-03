# 5.2 变量与插值

> 本课目标：让段落文本里能写 `{{cwd}}`，并回答三个问题——为什么不引入模板引擎、拼错的变量该怎么办、以及变量的值里恰好含 `{{...}}` 时会发生什么。

## 痛点：段落一旦要说"运行时才知道的事"，它就不再是文本了

system prompt 里有些话必须带具体值：当前工作目录是哪个、跑的是哪个模型、在哪个 git 分支上。5.1 的 `text` 可以是函数，所以看起来已经能做了：

```ts
prompt.register({ name: 'harness:identity', order: -100, text: () => `你在一个 git 仓库里工作，当前分支是 ${currentBranch()}。` })
prompt.register({ name: 'tools:guidance',  order: 100,  text: () => `提交前确认你还在 ${currentBranch()} 分支上。` })
```

跑一次（`demos/05-system-prompt/04-variables-pain.mjs`）：

```
你在一个 git 仓库里工作，当前分支是 main。

提交前确认你还在 main 分支上。
[spawn 了 2 次 git，耗时 14ms]
```

**同一次组装，同一个事实，取了两次。** 三个毛病，一个比一个重：

**① 重复取值有代价。** 取分支要 spawn 一个进程。两段就是两次；十段就是十次，而这是**每一轮请求**都要做的事（模型无状态，1.4 讲过）。

**② 两段可能对不上。** 两次取值之间隔着时间。中途换了分支、换了目录、跨过了午夜——**同一份 prompt 里两段话互相矛盾**，而模型会认真对待这个矛盾。

**③ 最要命的一条：段落不再是文本，而是代码。** 现在段落必须**自己知道去哪儿取值**。那么这些段落还能从哪来？

- 配置文件里的 persona：JSON 里写不了 `${currentBranch()}`
- 工作区的 `AGENTS.md`：一个 Markdown 文件里更写不了
- 用户在界面上填的自定义指令：那是一个文本框

**凡是来自"纯文本"的段落，就完全没有插值能力。** 而 dsh 的 persona 来自配置、项目指令来自文件、preset 来自 YAML——它们**全部**是纯文本。这才是变量机制真正要买的东西。

## 解法：一句话和一张图

**把"运行时才知道的值"从段落里拿出去，注册成命名变量；段落里只写 `{{名字}}`，组装时统一替换。**

改之前，取值嵌在每一段的代码里：

```
段落 a ── 文本是函数 ──→ 自己调 currentBranch() ──→ spawn git
段落 b ── 文本是函数 ──→ 自己调 currentBranch() ──→ spawn git   （第二次）
```

改之后，取值集中在组装那一刻，段落退回成纯字符串：

```
variable branch ──┐
variable cwd    ──┼─→ 组装时一次性全部求值 ──→ 逐段插值 ──→ system prompt
段落 a（纯文本，含 {{branch}}）──┘
段落 b（纯文本，含 {{branch}}）──┘
```

### 全部代码，一眼看完

注册表多两个方法（一个注册、一个取值），加一个扫描器：

```ts
variable(name: string, provide: () => string | undefined): () => void {
  if (!VARIABLE_NAME.test(name)) throw new Error(`变量名不合法：${name}`)
  if (this.variables.has(name)) throw new Error(`变量重名：${name}`)
  this.variables.set(name, provide)
  return () => { this.variables.delete(name) }
}

// 一次组装只取一次：两段读到的 {{branch}} 必须是同一个值。
private resolveVariables(): Map<string, string | undefined> {
  return new Map([...this.variables].map(([name, provide]) => [name, provide()]))
}
```

扫描器是整节课的主体，三十行：

```ts
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
const REFERENCE_AT = /^\{\{([^{}]*)\}\}/

function interpolate(owner: string, text: string, variables: Map<string, string | undefined>): string {
  let result = ''
  let consumed = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', consumed)) {
    const group = REFERENCE_AT.exec(text.slice(open))
    if (group === null) {
      // 后面还有 `}}` 说明想写引用但写坏了；否则这个 `{{` 就是普通文字。
      if (text.indexOf('}}', open + 2) >= 0) throw new Error(`段落「${owner}」里有写坏的变量引用：…`)
      result += text.slice(consumed, open + 2)
      consumed = open + 2
      continue
    }
    const name = group[1] ?? ''
    if (!VARIABLE_NAME.test(name)) throw new Error(`段落「${owner}」里的变量名不合法："{{${name}}}"`)
    if (!variables.has(name)) throw new Error(`段落「${owner}」引用了未注册的变量 "{{${name}}}"。已注册的变量：…`)
    const value = variables.get(name)
    if (value === undefined) throw new Error(`variable "{{${name}}}" 这一次组装没有取到值（段落「${owner}」）`)
    // 拼到 result 上，而不是回到文本里继续扫——替换进去的值不再被当成模板。
    result += text.slice(consumed, open) + value
    consumed = open + group[0].length
  }
  return result + text.slice(consumed)
}
```

### 用起来是两行

```ts
prompt.variable('cwd', () => process.cwd())
prompt.variable('model', () => config.model)
```

段落回归纯文本：

```ts
text: '你是一个跑在命令行里的编码助手。…\n'
  + '当前工作目录是 {{cwd}}，所有相对路径都相对于它。你正在以 {{model}} 运行。'
```

### 产出

```
[system prompt inventory]
   -100  harness:identity  (118 ch)
      0  deployment:persona  (28 ch)
    100  tools:guidance  (214 ch)
    110  guard:read-only  (0 ch)
--- 拼出来的 system prompt（364 ch）---
你是一个跑在命令行里的编码助手。你可以读写文件、执行命令、搜索代码。回答要简短直接：用户看到的是终端，不是网页。
当前工作目录是 /home/user/dsh-from-scratch，所有相对路径都相对于它。你正在以 mock 运行。
...
```

痛点那个演示的下半段也一起解决了：

```
=== 解法：注册成变量，一次组装只取一次 ===
你在一个 git 仓库里工作，当前分支是 main。
提交前确认你还在 main 分支上。
[spawn 了 1 次 git，耗时 6ms]
```

下面看这几十行里的每一个选择。

## 为什么不用一行正则

一行就能写完：

```ts
text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_, name) => variables.get(name) ?? '')
```

**它没法回答"出了什么事"。** 上面那个手写扫描器区分了**四种**情况，而 `replace` 只能给出一种结果：

| 文本里出现 | 手写扫描器 | 一行正则 |
|---|---|---|
| `{{cwd}}`，已注册 | 替换 | 替换 ✓ |
| `{{cdw}}`，拼错了 | **报错并列出所有已注册变量** | 不匹配 → 原样留在 prompt 里 |
| `{{ cwd }}`，多了空格 | **报错说名字不合法** | 不匹配 → 原样留在 prompt 里 |
| `{{branch}}`，注册了但这次取不到 | **报错说这次没有值** | 换成空串，静默 |

后三行都是**静默失败**。模型收到的 prompt 里躺着一句 `工作目录是 {{cdw}}。`，或者 `当前分支 。`，而你在日志里什么都看不到——**只会觉得模型今天有点笨**。

三种错误对应三种完全不同的修法，所以必须是三条不同的错：

```
── ② 变量名拼错了 ──
  ❌ 段落「a」引用了未注册的变量 "{{cdw}}"。已注册的变量：cwd

── ③ 变量注册了，但这次取不到值 ──
  ❌ variable "{{git_branch}}" 这一次组装没有取到值（段落「a」）

── ④ 引用写坏了 ──
  ❌ 段落「a」里的变量名不合法："{{ cwd }}"（要求匹配 /^[a-z][a-z0-9_]*$/）
```

第二条尤其值钱：**报错里带上所有已注册变量名**，作者一眼就看出是自己把 `cwd` 敲成了 `cdw`。这是 4.1 那条"错误信息里要带上改正所需的全部信息"的又一次应用——只不过这次的读者是**写讲义的人**，不是模型。

**为什么是"报错"而不是"留个空"？** 因为这是**配置错误**，而配置错误要在第一次请求之前暴露（阶段 0 那条规矩的第五次应用）。一个拼错的变量名不会自己好，它会一直错下去，还悄悄降低模型的表现。

## `undefined` 和"没注册"是两回事

注意 `provide` 的类型是 `() => string | undefined`，而这两种情况报的是不同的错：

- **没注册**：作者写错了名字，或者忘了注册 → 改代码
- **注册了但返回 `undefined`**：这个事实**这一次拿不到** → 比如不在 git 仓库里，所以没有分支

第二种不是 bug，是现实。但它仍然要报错，因为**段落里既然写了 `{{git_branch}}`，就说明作者认为它一定有值**。真正正确的写法是让整段变成条件性的（5.1 那个返回空串的技巧）：

```ts
text: () => (insideGitRepo ? '当前分支是 {{git_branch}}。' : '')
```

**"这个值可能没有"是段落的事，不是变量的事。** 变量只回答"值是多少"。

## 孤零零的 `{{` 是普通文字

```
── ⑤ 孤零零的 {{ 是普通文字，不报错 ──
  ✅ Jinja 模板里的变量写成 {{ 加名字。
```

为什么要专门处理这一格？因为 system prompt 里**真的会出现 `{{`**——你在教模型写 Jinja 模板、写 Vue 组件、写 Handlebars 的时候。一律报错就等于禁止 prompt 里出现这两个字符。

判据是"后面有没有 `}}`"：有，说明作者是想写一个引用但写坏了（报错）；没有，那就是普通文字（原样保留）。**这条规则不完美**——`{{ 加名字 }}` 会被判成写坏的引用。但它覆盖了绝大多数真实情况，而且**判错时是报错而不是静默**，作者立刻知道要改写这句话。

> **接受一个不完美的判据，前提是它错的时候会喊出来。** 这跟静默失败是两回事。

## 值不会被二次展开

```
── ⑥ 变量的值里含 {{...}}，不会被二次展开 ──
  ✅ 工作目录是 /tmp/{{secret}}。
```

一个叫 `/tmp/{{secret}}` 的目录（有人故意建的，或者只是手滑），如果替换后再扫一遍，`{{secret}}` 就会被展开成另一个变量的值。

代码上就是这一行的差别：

```ts
result += text.slice(consumed, open) + value      // 拼到"已完成"的部分上
consumed = open + group[0].length             // 从引用的**后面**继续扫
```

替换进去的值落在 `result` 里，扫描指针跳过它，**再也不会碰它**。

这是这门课第三次遇到同一件事：

| 课 | 数据变成代码的地方 | 防法 |
|---|---|---|
| 4.3 | 模型给的 pattern 被 shell 解释 | 不引入 shell，走 argv |
| 4.3 | glob 里的 `.` 被当成正则元字符 | 转义 |
| **5.2** | 变量的值被当成模板 | **替换后不再扫描** |

**"这段文本是数据还是代码"——每次外部输入进入一个有语法的地方，就要问一遍。**

## 取值发生在组装时

```
── ⑧ 取值发生在组装时，不是注册时 ──
  组装第一次：工作目录是 /一开始的目录。
  组装第二次：工作目录是 /后来换了的目录。
```

两个理由：

**① 事实会变。** 阶段 13 会支持在会话里换工作目录；`{{cwd}}` 必须跟着变。注册时求值一次，prompt 就永远停在启动那一刻。

**② 测试里能固定住。** 想让 prompt 可复现，换掉取值函数就行：

```ts
prompt.variable('cwd', () => '/固定的测试目录')
```

**不用去 monkeypatch `process.cwd`。** 这是"把外部依赖变成一个可替换的函数"的最小形态——同一个思路，阶段 7 引入 Cordis 之后会变成整个服务注入体系。

## 同一次组装，同一个值

```
── ⑦ 同一次组装里，两段读到同一个值 ──
  ✅ 第一段看到 1。
     第二段看到 1。
```

变量取值函数每次组装**只调一次**，结果存进一个 `Map`，所有段落共用：

```ts
private resolveVariables(): Map<string, string | undefined> {
  return new Map([...this.variables].map(([name, provide]) => [name, provide()]))
}
```

这解决了痛点里的 ① 和 ②：不重复付代价，也不会自相矛盾。

> **一次组装是一个"快照"。** 快照内部必须自洽，哪怕世界在组装期间变了。这条在阶段 6 讲会话落盘时会变得更重要——一个快照要能被完整地记下来、重放出来。

## 对照 dsh

`dsh/packages/core/system-prompt/src/index.ts` 里的 `interpolate()` 和我们这个几乎逐行一致，包括 `{{` 孤立时当字面、替换值不再扫描、三种错误分开报。三处不同：

| | 我们的 | dsh |
|---|---|---|
| 变量存哪 | `Map<string, string \| undefined>` | `Record<string, string \| undefined>`（普通对象） |
| 取值函数的入参 | 无 | `(context: AssembleContext) => string \| undefined`，能看到是哪个 agent、哪个 scope |
| 谁能改 | 只有注册者 | 组装是 waterfall，插件可以在最后改写整个 `variables` |
| 插值发生在哪 | `assemble()` 里 | 独立的 `renderPrompt(assembly)`，**assembly 里的段落是没插值的** |

第一处差别里藏着一个很值得看的细节。dsh 的 `variables` 是普通对象，所以它必须写这一行：

```ts
// Do not resolve unregistered names through Object.prototype.
if (!Object.hasOwn(variables, name)) { … }
```

**为什么？** 因为 JS 里普通对象天生带着 `Object.prototype` 上的一堆属性。`variables['toString']` 不是 `undefined`，是一个函数；`variables['constructor']` 也有值。如果直接写 `if (name in variables)` 或者 `variables[name] !== undefined`，那么 prompt 里写 `{{constructor}}` 就会**意外命中原型链**，把一个函数拼进 system prompt。

我们用 `Map` 就没有这个问题——`Map` 没有原型上的键。**那 dsh 为什么不用 `Map`？** 因为它的 `variables` 要经过 `system-prompt/assemble` 这个 waterfall 被插件改写，还要能被序列化进快照；普通对象在这两件事上都更顺手。**它是有意选了一个需要多写一行防护的结构，然后把那一行写对了。**

> 这条值得记：**用普通对象当查找表时，"有没有这个键"必须用 `Object.hasOwn`。** Python 里的 `dict` 没有这个坑，JS 有。

第四处差别（插值和组装分开）是为 5.3 铺路的：dsh 的 `PromptAssembly` 里，**段落和动态上下文都还是没插值的原文**，两者共用同一份 `variables`，各自在需要的时候才 `renderPrompt` / `renderContextSections`。下一课就讲那个"动态上下文"为什么是另一套东西。

---

下一课：**5.3 动态上下文不进 system prompt** —— 我们刚刚让 `{{cwd}}` 进了 system prompt。但"当前时间"、"你刚打开的文件"、"git 状态"这类每轮都在变的信息，dsh **不放进 system prompt**，而是变成一条 user 消息。为什么？答案里有两条硬理由，其中一条是这门课第一次真正兑现「模型可见 ⟺ 已落日志」。
