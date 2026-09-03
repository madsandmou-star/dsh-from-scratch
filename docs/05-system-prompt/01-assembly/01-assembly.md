# 5.1 system prompt 是拼出来的

> 本课目标：把 system prompt 从配置里那一句常量，变成一个**注册表**——每个部件塞一段自己的话，最后按顺序拼起来。顺便把阶段 4 塞错地方的三句话搬回家。

## 痛点：三句话待错了地方

阶段 4 结束时，配置里的 system prompt 还是这一句：

```json
"systemPrompt": "You are a helpful assistant."
```

而我们往**工具描述**里塞了三句话：

| 塞在哪 | 那句话 |
|---|---|
| `bash` 的 description | "读文件请优先用 read（它带行号），改文件请优先用 edit" |
| `grep` 的 description | "请用这个工具而不是 bash 里的 grep" |
| 只读模式的**拒绝理由** | "当前是只读模式，你可以用 read / glob / grep 查看" |

**这三句都不在描述"某一个工具是什么"，而在描述"这套装配下该怎么干活"。** 各自的毛病：

**① 工具之间被绑死了。** `bash` 的描述里提到 `read` 和 `edit`。如果某个装配不带 `read` 工具（比如一个只跑命令的 agent），`bash` 的描述就在**说谎**——它让模型去用一个不存在的工具。

**② 没有全局视角的人说不清优先级。** "该先用谁"这件事，只有**看到全套工具的人**才说得清。单个工具的描述里写这个，本质上是在越权。

**③ 最糟的一句：只读模式那句话只有被拒绝之后才说得出口。**

看 4.4 那个演示的输出：

```
[工具] edit(...) → error：被护栏「readOnlyGuard」拒绝：当前是只读模式，edit 不能用。
```

也就是说，**模型必须先试着改一次文件、被拒绝，才知道自己在只读模式。** 这是最典型的"话放错了地方"：

> **一条限制必须在模型做决定之前就被它看到，而不是之后。**

放在拒绝理由里，最好的情况是浪费一个 step，最坏的情况是模型反复重试或者干脆放弃任务。

## 解法：一句话和一张图

**把 system prompt 从"一个常量"改成"一个注册表"：谁都可以往里塞一段带名字和顺序的话，发请求前按顺序拼起来。**

改之前，那句话是从配置里直接读出来的，工具描述里另外散着三句：

```
配置文件 ──"You are a helpful assistant."──→ messages[0]

tool.ts   bash.description  ── 夹带："优先用 read/edit" ──→ 请求的 tools 字段
          grep.description  ── 夹带："别用 bash 里的 grep" ──→ 请求的 tools 字段
guard.ts  只读模式的拒绝理由 ── 只有被拒绝之后才出现 ──→ 某条 tool result
```

改之后，四个来源都汇进同一个注册表，出口只有一个：

```
identitySection          (-100) ─┐
配置的 persona  (   0) ─┤
toolGuidanceSection      ( 100) ─┼──→ PromptRegistry ──按顺序拼──→ messages[0]
只读模式段      ( 110) ─┘        （空段落丢掉）
```

而工具描述回归本分——只说"这个工具是什么"，不再提别的工具。

### 全部代码，一眼看完

整个机制就是一个 `Map` 加一次排序：

```ts
export interface PromptSection {
  name: string                        // 唯一，重名抛错
  order: number                        // 从小到大拼
  text: string | (() => string)       // 函数版用来做"条件性段落"
}

export class PromptRegistry {
  private readonly sections = new Map<string, PromptSection>()

  register(section: PromptSection): () => void {
    if (this.sections.has(section.name)) throw new Error(`system prompt 段落重名：${section.name}`)
    this.sections.set(section.name, section)
    return () => { this.sections.delete(section.name) }   // ← 返回的是注销函数
  }

  assemble(): string {
    return [...this.sections.values()]
      .sort((a, b) => a.order - b.order)
      .map(section => (typeof section.text === 'string' ? section.text : section.text()).trim())
      .filter(text => text !== '')             // ← 空段落丢掉
      .join('\n\n')
  }
}
```

**九十行不到，其中三十行是这个类，剩下是注释和一个 debug 用的 `inventory()`。** 这一课剩下的篇幅全在讲：上面这几行里的每一个选择为什么是这样，而不是另一样。

### 用起来是四行

```ts
const prompt = new PromptRegistry()
prompt.register(identitySection)
prompt.register({ name: 'deployment:persona', order: 0, text: config.systemPrompt })
prompt.register(toolGuidanceSection)
prompt.register(readOnlyNotice(config.readOnly))

const messages = [{ role: 'system', content: prompt.assemble() }]
```

### 拼出来的东西

```
你是一个跑在命令行里的编码助手。你可以读写文件、执行命令、搜索代码。回答要简短直接：用户看到的是终端，不是网页。

You are a helpful assistant.

选工具的优先级：
- 读文件用 read（它带行号），不要用 `cat`。
- 改已有文件用 edit（唯一字面匹配），不要用 write 整体重写，也不要用 `sed`。
- 按内容找代码用 grep，按文件名找用 glob，都不要用 bash 里的 grep/find——专门工具会跳过 node_modules、限制结果数量、并且不经过 shell。
- bash 用来跑那些没有专门工具的事：测试、构建、git、查进程。
```

只读模式打开时，末尾还会多出第四段。**三句话都回家了**，而且只读那句现在出现在**模型做决定之前**。

下面逐个看这几行代码里的选择。

## 三个字段，三个决定

### `name`：重名直接抛错

```ts
if (this.sections.has(section.name)) throw new Error(`system prompt 段落重名：${section.name}`)
```

```
── ② 重名 ──
  ❌ system prompt 段落重名：harness:identity
```

**为什么不是"后者覆盖前者"？** 因为那会变成一个**静默**的失败：两个部件都以为自己的话进去了，实际只有一个进去，而且取决于注册顺序。这种 bug 你要查半天——你会一直盯着 prompt 看"为什么这句话不见了"。

这是阶段 0 那条"配置错误要在第一次请求之前暴露"的又一次应用。dsh 也是抛错（`a duplicate registration throws`）。

### `order`：为什么用带间隔的数字

```ts
/**
 * 约定（照抄 dsh）：
 * `-100` 是 harness 自己的身份，`0` 是部署方给的 persona，`100`–`199` 是工具指引。
 */
```

```
── ① 默认装配（只读关） ──
   -100  harness:identity     56 ch
      0  deployment:persona   33 ch
    100  tools:guidance       214 ch
    110  guard:read-only      0 ch（blank，会被丢掉）
  → 拼出来共 307 ch
```

用 `-100 / 0 / 100` 而不是 `1 / 2 / 3`，是为了**将来在任意两段之间插进新段时不用重新编号**。这个梯子是从 dsh 直接抄的，因为它本身就是经验。

`0` 留给"部署方给的 persona"也是有讲究的：**它是模型读到的第一段**（负数排在它前面的只有 harness 身份），所以最容易被模型当成"我是谁"。5.4 会讲 dsh 为什么给这个位置起了个具名常量 `PERSONA_SECTION`。

### `text` 可以是函数：条件性段落

只读模式那一段这样写：

```ts
text: () => (enabled
  ? '当前是**只读模式**：write / edit / bash 都不可用，调用它们会被直接拒绝。'
    + '你可以用 read / glob / grep 查看代码，并把建议的改法说出来，但不要试图自己动手。'
  : ''),
```

关掉时它返回空串，组装时被丢掉：

```ts
.filter(text => text !== '')
```

**空段落被丢掉，而不是让调用方去判断该不该注册它。** 差别在于：装配那几行永远长一个样（`prompt.register(readOnlyNotice(config.readOnly))`），开关的逻辑留在懂这个开关的地方。装配代码里散落 `if` 是"每加一个功能就动一次主干"的开始。

## 装配：没有人知道全貌

回头看那四行注册。**没有任何一个地方"知道"最终的 prompt 长什么样。** 它是这四行的和。加一个功能就多一行，删一个功能就少一行——而不是去一个几百行的模板字符串里找位置。

这正是 dsh 的形状，只不过 dsh 里这四行分散在四个插件里：

```ts
ctx.systemPrompt.section({ name: 'tool:edit', order: 102, text: 'Use the edit tool for …' })
```

**装了哪些插件，system prompt 就长什么样。**

## 注册返回的是注销函数

```ts
register(section: PromptSection): () => void {
  ...
  return () => { this.sections.delete(section.name) }
}
```

```
── ③ 注销 ──
── 撤掉 persona 之后 ──
   -100  harness:identity     56 ch
    100  tools:guidance       214 ch
```

返回值是**注销函数**，不是 `void`。现在还用不上——我们的装配一次成型，没人会撤。但这是 dsh 那条规矩的种子：

> **注册即效果**：每一个贡献都必须是可撤销的。

为什么必须？因为 dsh 的插件可以在运行时装卸（阶段 20 那个"agent 修改自己的运行时"就靠这个）。一个插件被卸载时，它往 system prompt 里塞的那段话、注册的工具、挂的事件监听器**必须一起消失**。如果注册是个不可逆的动作，卸载就只能是假的。

**先把返回值定成注销函数，比将来再改所有调用点便宜得多。**

## 一个新的 debug 手法

```sh
DSH_SHOW_PROMPT=1 npm run dev
```

```
[system prompt inventory]
   -100  harness:identity  (56 ch)
      0  deployment:persona  (28 ch)
    100  tools:guidance  (214 ch)
    110  guard:read-only  (0 ch)
--- 拼出来的 system prompt（302 ch）---
...
```

**agent 行为不对时，先看它到底收到了什么 system prompt。** 这和 1.4 那句"十有八九不是模型笨，而是你以为发出去的东西和实际发出去的东西不一样"是同一条。

清单里的**字符数**尤其有用：某段话意外变空（一个返回 `undefined` 的函数、一个没读到的文件）时，你在拼出来的全文里很难发现少了什么，但在清单里一眼就看到 `0 字符`。

## 效果：模型提前知道了

`demos/05-system-prompt/02-model-sees-it.mjs` 把模型真正收到的 system prompt 打出来。只读模式打开时，最后多了一段：

```
当前是**只读模式**：write / edit / bash 都不可用，调用它们会被直接拒绝。
你可以用 read / glob / grep 查看代码，并把建议的改法说出来，但不要试图自己动手。
```

**模型在决定调用哪个工具之前就读到了这句话。** 4.4 那个拒绝理由**仍然保留**——两者不是二选一：

| | 作用 | 时机 |
|---|---|---|
| system prompt 那段 | 让模型**别去试** | 决定之前 |
| 护栏的拒绝理由 | 模型还是试了，告诉它**发生了什么、还剩什么能用** | 之后 |

**提示是引导，护栏是保证。** 提示可以被模型忽略（它就是几句话），护栏不会。**只有提示 = 没有安全性；只有护栏 = 浪费步数还可能让模型放弃。** 两个都要。

这条在 dsh 里贯穿始终：`tool-fs` 的 `edit` 既在 system prompt 里写了 "Read the file first (the default fs-observation-policy requires it)"，又真的有一个 `fs-observation-policy` 插件在执行前拦截。**说一遍，也拦一遍。**

## 对照 dsh

`dsh/packages/core/system-prompt/src/index.ts`（545 行）比我们这 90 行多的东西：

| | 我们的 | dsh |
|---|---|---|
| 注册 | `registry.register()` | `ctx.systemPrompt.section()`，绑在插件生命周期上，插件卸载自动撤销 |
| 段落文本 | `string \| (() => string)` | `string \| ((context: AssembleContext) => string)`，**每次组装带上下文**（哪个 agent、哪个 scope） |
| 变量 | 无 | `{{cwd}}` `{{model}}` `{{provider}}`，组装完再插值（**5.2**） |
| 动态信息 | 无 | `context()` 是**另一套东西**，不拼进 system prompt（**5.3**） |
| 工具 schema | 单独发在请求的 `tools` 字段 | 也归 systemPrompt 管，还能配 `toolOrder` |
| 整体替换 | 无 | `complete: true`（**5.4**） |
| 组装 | 一个函数 | `system-prompt/assemble` **waterfall**，插件可以在最后改写整个组装结果 |
| 变更通知 | 无 | `system-prompt/change` 事件，因为**装配可以在运行时变** |

有一条现在就值得说：**dsh 把工具的 schema 也交给 systemPrompt 管**。乍看奇怪——工具是请求里单独的 `tools` 字段，跟 system prompt 是两回事。但它们有一个共同点：**都是"模型这一轮能看到的世界"的一部分，都由装配决定**。放在一起，就只有一个地方回答"这次请求模型看到了什么"。

而 `toolOrder` 这个配置项里有个细节挺有意思：

```ts
export const TOOL_ORDER_REST = '<unlisted-tools>'
```

你可以配 `["read", "edit", "<unlisted-tools>", "bash"]`——**没列出来的工具插在那个占位符的位置**。而且 `toolOrder` 里写了一个不存在的工具名会**直接抛错**并列出所有已知工具名。又是"配置错误要在第一次请求之前暴露"。

---

下一课：**5.2 变量与插值** —— system prompt 里要出现"你的工作目录是 /home/xxx/项目"这种话，但工作目录不是写讲义时能知道的。我们会加上 `{{cwd}}`，并回答两个问题：为什么不引入一个模板引擎，以及 `{{typo}}` 这种拼错的变量该怎么办。
