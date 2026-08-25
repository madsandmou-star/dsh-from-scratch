# 4.1 write 与 edit：让 agent 能改代码

> 本课目标：加上两个写文件的工具，并把 `edit` 的**唯一字面匹配**这条契约讲清楚——它是几乎所有 coding agent 都做了同一个选择的地方。

阶段 3 结束时，我们的 agent 能读文件、能循环调工具，但它**只能看，不能动**。这一课把 `write` 和 `edit` 加上，agent 第一次能改代码。

## write：覆盖是不可逆的

`write` 很简单——给路径和内容，写进去。难的地方全在**它会覆盖已有文件**。

```ts
const 原有字节数 = await readFile(路径, 'utf8').then(内容 => 内容.length, () => undefined)

await mkdir(dirname(路径), { recursive: true })
await writeFile(路径, 内容, 'utf8')

return 原有字节数 === undefined
  ? `已创建 ${相对路径}（${内容.length} 字符）`
  : `已覆盖 ${相对路径}（原 ${原有字节数} 字符 → 现 ${内容.length} 字符）`
```

三个细节，每个都有理由：

**① 返回值区分"创建"和"覆盖"。** 模型经常搞错路径——它以为在建新文件，实际砸掉了一个已存在的。看到"已覆盖 xxx（原 4000 字符 → 现 12 字符）"，它有机会立刻发现问题；看到一句笼统的"已写入"，它不会。

**② `content` 允许是空字符串，所以不能用 `取字符串()`。** 清空一个文件是合法操作。3.3 那个校验函数把空串也拒了——那对 `path` 是对的，对 `content` 是错的。**同一个校验函数不一定适用于所有字段**，这是校验代码最常见的复制粘贴事故。

```ts
const 内容 = args['content']
if (typeof 内容 !== 'string') {
  throw new Error(`参数 content 必须是字符串，实际收到：${JSON.stringify(内容)}`)
}
```

**③ `mkdir(..., { recursive: true })`。** 模型要求写 `src/utils/format.ts` 时，`src/utils/` 可能还不存在。少了这一行，工具会报一句 `ENOENT` 给模型，模型大概率不知道该先建目录。**能替模型做掉的事就别让它猜。**

`description` 里也写了一句关键的话：

> **覆盖会丢失原有内容**，所以修改已存在的文件时优先用 edit，只有创建新文件或整体重写时才用 write。

这是 3.1 那条"description 是提示词"的又一次应用——**工具之间的优先级也要写进描述里**，否则模型会用 `write` 重写整个文件来改一行，把你其余的代码顺手改坏。

## edit：为什么是"唯一字面匹配"

改一段代码，理论上有四种定位方式：

| 方式 | 问题 |
|---|---|
| 行号（改第 42 行） | 模型上一次 `read` 之后文件可能已经变了；一次成功的 edit 会让**后面所有行号失效** |
| diff / patch | 模型生成 unified diff 的准确率明显低于生成原文；上下文行数、`@@` 行号一错就整块打不上 |
| 正则替换 | 模型写出的正则会误伤；转义字符是灾难现场 |
| **唯一字面匹配** | 模型只需要**照抄一段它刚读到的原文** |

第四种赢在一个地方：**它对模型的要求最低**。模型刚刚 `read` 过文件，原文就在它的上下文里，照抄一段是它最擅长的事。而"这段必须唯一"这个约束，模型也有一个非常自然的改正动作——**多带几行上下文**。

所以核心实现就是数出现次数：

```ts
const 出现位置 = 找出所有位置(内容, old_string)
if (出现位置.length === 0) {
  throw new Error(`old_string 在 ${相对路径} 中没有找到。请先用 read 确认原文（注意空格、缩进和换行必须完全一致）。`)
}
if (出现位置.length > 1) {
  const 行号 = 出现位置.map(位置 => 内容.slice(0, 位置).split('\n').length)
  throw new Error(
    `old_string 在 ${相对路径} 中出现了 ${出现位置.length} 次（第 ${行号.join('、')} 行），必须恰好一次。`
    + '请在 old_string 里多带上前后几行上下文，让它变得唯一。',
  )
}
```

**为什么不直接 `内容.replace(old_string, new_string)`？** 因为 `replace` 只换第一处却什么也不说——模型以为全换了，实际只改了一半。这是最难查的一类 bug：没有报错，结果是错的。

## 三种失败要报出三种错

这一条比"唯一匹配"本身更重要：**错误信息的读者是模型，它读完要能自己改正。** 所以三种失败必须报成三条不同的话，因为改正动作完全不同：

| 失败 | 模型该怎么办 |
|---|---|
| 匹配 0 次 | 原文抄错了（多半是空格/缩进）→ **重新 read 确认** |
| 匹配 >1 次 | 原文太短 → **多带上下文** |
| `old_string === new_string` | 它自己算错了 → **重新想这次要改什么** |

第三条容易被忽略。两段完全一样的文本，替换必然是空操作——如果不拦，工具会返回"已修改"，模型于是认为任务完成了。**"什么也没发生"绝不能报成成功。**

匹配多次那条错还多带了**行号**：

```
old_string 在 demo.ts 中出现了 2 次（第 2、6 行），必须恰好一次。
```

只说"出现了 2 次"，模型不知道该往哪个方向加上下文；说了第 2 行和第 6 行，它立刻知道这两处长得一样，得靠上下文区分。**给模型的错误信息里要带上它改正所需要的全部信息**——这一条 dsh 也是这么做的（下面对照）。

找位置的写法有个小坑值得记：

```ts
起点 = 位置 + 目标.length
```

从**这次匹配的末尾**继续找，而不是 `位置 + 1`。否则在 `"aaa"` 里找 `"aa"` 会数出 2 次（下标 0 和 1），但它们是重叠的，实际只能替换一次。

## 实测：三种失败 + 一次成功

```
✅ write → 已创建 notes.md（4 字符）
✅ write → 已覆盖 notes.md（原 4 字符 → 现 12 字符）
---
❌ edit → old_string 在 demo.ts 中出现了 2 次（第 2、6 行），必须恰好一次。请在 old_string 里多带上前后几行上下文，让它变得唯一。
❌ edit → old_string 在 demo.ts 中没有找到。请先用 read 确认原文（注意空格、缩进和换行必须完全一致）。
❌ edit → old_string 和 new_string 完全相同，这次替换不会改变任何东西。
✅ edit → 已修改 demo.ts（替换了 32 字符 → 32 字符）
```

被改的文件是这个——注意 `return 1` 出现了两次，这就是"必须唯一"要解决的现实：

```ts
export function a() {
  return 1
}

export function b() {
  return 1
}
```

## 真正的收获：模型能自己从错误里爬出来

上面是直接调工具。把它放回 3.4 的 tool loop 里跑一遍，才看得到这套设计的全部价值。用一个假服务器，剧本只有两步：第一步故意用 `"  return 1"` 这个不唯一的原文，第二步多带一行上下文。

```
你 > 把 b() 的返回值改成 2

模型 >
  [工具] edit({"path":"demo.ts","old_string":"  return 1","new_string":"  return 2"})
         → 错误：old_string 在 demo.ts 中出现了 2 次（第 2、6 行），必须恰好一次。请在 old_string 里多带上前后几 …

模型 >
  [工具] edit({"path":"demo.ts","old_string":"export function b() {\n  return 1","new_string":"export function b() {\n  return 2"})
         → 已修改 demo.ts（替换了 32 字符 → 32 字符）

模型 > 改好了：b() 现在返回 2，a() 没动。
```

服务器侧确认模型确实**看见**了那条错：

```
【模型这一轮看到的 tool 结果】错误：old_string 在 demo.ts 中出现了 2 次（第 2、6 行），必须恰好一次。请在 old_string 里多带上前后几行上下文，让它变得唯一。
【模型这一轮看到的 tool 结果】已修改 demo.ts（替换了 32 字符 → 32 字符）
```

这是 3.3 那条"执行失败要变成文本，不是异常"和 3.4 的 tool loop 合起来的效果：**一次失败的工具调用只是多花一个 step，不是一次崩溃。** 一个 turn 里的两个 step，第二个是第一个的改正——阶段 1.4 定义 turn/step 时说的"一个 turn 可能有多个 step"，到这里才算完全兑现。

> **debug 手法**：agent 改文件改错了，先看**它到底收到了什么 tool 结果**。上面那个假服务器只做了一件事——把 `messages.at(-1)` 打出来。真跑起来时，在 `chatStream` 调用前加 `console.dir(messages.at(-1), { depth: null })` 就能得到同样的信息。模型的下一步完全由它看到的东西决定，看错了就一定走错。

## 对照 dsh

dsh 里有**两套**写文件的工具，这本身就是一个值得看的决定：

| 包 | 工具 | 风格 |
|---|---|---|
| `dsh/packages/fs/tool-fs/` | `read` / `write` / `edit` | Claude Code 风格，一个动作一个工具 |
| `dsh/packages/fs/tool-str-replace-editor/` | `str_replace_editor` | Anthropic computer-use 风格，一个工具带 `command` 参数分派到 `view`/`create`/`str_replace`/`insert` |

**为什么留两套？** 因为不同的模型对不同的工具形态熟悉程度不一样——工具描述是提示词，而模型在训练里见过哪一种，直接影响它的调用准确率。dsh 把这变成了可组合的插件：换一套工具就是换一个包，不用改 agent loop。

### 唯一匹配：两套都做了同样的选择

`dsh/packages/fs/tool-str-replace-editor/src/index.ts` 里的报错：

```
No replacement was performed. Multiple occurrences of old_str `...` in lines [2, 6]. Please ensure it is unique
```

**它也报行号。** 我们上面那条改进不是自己想出来的，是照着它做的。找位置的循环（`matchOffsets`）和我们的 `找出所有位置` 几乎逐行相同，包括 `offset = match + search.length` 那个防重叠的写法。

`dsh/packages/fs/tool-fs/src/edit.ts` 的校验也是三条，其中一条正是我们刚加的：

```ts
if (args.old_string === args.new_string) throw new Error('old_string and new_string must differ')
```

### 我们没做、dsh 做了的

| | 我们的 | dsh |
|---|---|---|
| 返回值 | 一句字符串 | 结构化的 `{ path, before, after }`，再由 `render` 变成文字、`presentationMeta` 变成 **diff 卡片** |
| 读后才能改 | 无 | `dsh/packages/fs/fs-observation-policy/`：没 read 过就 edit，直接 `FS_NOT_OBSERVED` 拒绝 |
| 并发安全 | 无 | `replaceIfVersion`——写回时带上读到的版本，中途被别人改过就失败 |
| 批量替换 | 无 | `replace_all` 参数，**默认 false** |
| 文件访问 | 直接 `node:fs` | 走 `ctx.fs` 能力接缝，可以换成沙箱、远程、E2B |
| 越权路径 | 抛错 | 沙箱升级：模型可以带 `sandbox_permissions` + `justification` 申请，且**只有在受限后端下这两个字段才出现在 schema 里** |

有两条特别值得展开：

**`fs-observation-policy`——"没读过就不许改"。** 这条规则在 `dsh/packages/fs/fs-observation-policy/src/index.ts` 里，错误信息是 `edit requires reading "..." first`。它防的是模型**凭记忆或凭猜测**去 edit：它以为文件里有那段代码，其实没有，或者已经不是那样了。有趣的是它是一个**独立的插件**——不装它，`edit` 就是无条件替换。**"要不要强制先读"是部署时的选择，不是 edit 工具自己的事**，这正是 AGENTS.md 里"插件而不是改主循环"那条规矩的样子。

**结构化返回值 + diff 卡片。** 我们的 `edit` 返回 `已修改 demo.ts（替换了 32 字符 → 32 字符）`——**同一句话既给模型看，又给人看**。dsh 把两者分开了：`execute` 返回 `{ path, before, after }`，`render()` 从中生成给模型的那句英文，`presentationMeta()` 从中算出 diff 给界面画卡片。这就是 AGENTS.md 里那条"**工具的 UI 呈现意图是设计的一部分，要一开始就定**"。阶段 12 讲 UI 时会回到这里；现在只要记住一件事：**一旦你的返回值同时要服务模型和界面，字符串就不够用了。**

`replace_all` 我们故意没做。它是唯一匹配的逃生口，但装上它就会削弱这一课的核心：**模型会倾向于直接用 `replace_all` 绕开"要唯一"的约束**，然后改错地方。dsh 的做法是保留它但默认关闭，并在 system prompt 里明确写"先试着让 old_string 更具体，不行才用 replace_all"（见 `tool:edit` 那段 section 文本）。

---

下一课：**4.2 bash** —— 把整台机器交给模型。有了 bash，理论上 read/write/edit 都可以不要（`cat`/`tee`/`sed` 全能干），我们会先看这个想法为什么诱人，再看它为什么不对。同时第一次撞上**危险操作**：`rm -rf` 该由谁来拦。
