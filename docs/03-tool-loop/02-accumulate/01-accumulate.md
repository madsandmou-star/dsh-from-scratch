# 3.2 流式下把工具调用拼起来

> 本课目标：还 2.4 欠下的那笔债——`arguments` 是分块到达的 JSON 文本，要按 `index` 攒起来。
>
> **跑一下**：`npm run demo demos/03-tool-loop/02-accumulate.mjs` —— 两个调用交错、参数被切在 JSON 中间，看 `index` 怎么把它们归位。

## 真实的流式工具调用长什么样

让假服务器**同时**要求调两个工具，参数分块交错到达。把每一帧的工具增量原样打出来：

```
index=0  id=call_aaa  name=read  args+="{\"pa"
index=1  id=call_bbb  name=grep  args+="{\"pat"
index=0  id=—         name=—     args+="th\": \"sr"
index=1  id=—         name=—     args+="tern\": \"parseSse\"}"
index=0  id=—         name=—     args+="c/llm.ts\"}"
(无工具增量) finish_reason=tool_calls
```

三个事实一次暴露：

1. **`id` 和 `name` 只在每组的第一块出现**，后续碎片里是 `undefined`。
2. **`arguments` 是唯一需要拼接的字段**，一截一截来。
3. **多个工具交错**——第 3 帧属于工具 0，第 4 帧属于工具 1。`index` 是唯一的归位钥匙。

第 1 条是最容易写错的地方：如果你直接 `id: delta.id`，第一块攒下的 id 会被第二块的 `undefined` 冲掉。

## 解法：一句话和一张图

**用一个以 `index` 为键的 Map 把碎片攒起来：`id` 和 `name` 只在第一片里出现就记下来，`arguments` 每来一片就往后接；等流结束再一次性交出去。**

```
到达顺序（两个调用交错，参数被切在 JSON 中间）：
  index=0  read  '{"pa'
  index=1  grep  '{"pat'
  index=0  （续） 'th": "sr'
  index=1  （续） 'tern": "TODO"'
  index=0  （续） 'c/llm.ts"}'
  index=1  （续） '}'
        ↓ 以 index 为键累积
  0 → { id: call_a, name: read, arguments: '{"path": "src/llm.ts"}' }
  1 → { id: call_b, name: grep, arguments: '{"pattern": "TODO"}' }
```

### 全部代码，一眼看完

```ts
const pendingCalls = new Map<number, { id: string, name: string, args: string }>()

for (const delta of choice?.delta.tool_calls ?? []) {
  const prev = pendingCalls.get(delta.index) ?? { id: '', name: '', args: '' }
  pendingCalls.set(delta.index, {
    // id 和 name 只在第一片里有，后续片是 undefined —— 所以用 ?? 保住已经拿到的值。
    id: delta.id ?? prev.id,
    name: delta.function?.name ?? prev.name,
    // arguments 是唯一需要拼接的字段。
    args: prev.args + (delta.function?.arguments ?? ''),
  })
}
```

流结束时按 `index` 排序再交出去，**让调用顺序稳定可复现**：

```ts
const calls = [...pendingCalls.entries()]
  .sort(([a], [b]) => a - b)
  .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.args }))
```

### 产出

```
累积之后拿到的完整调用：
  call_a  read({"path": "src/llm.ts"})
      JSON.parse 之后：{"path":"src/llm.ts"}
  call_b  grep({"pattern": "TODO"})
      JSON.parse 之后：{"pattern":"TODO"}
```

下面看两件事：什么时候算"收全了"，以及为什么返回类型必须从字符串变成带标签的联合。


## 累积器

`src/llm.ts` 里新增的部分：

```ts
const pendingCalls = new Map<number, { id: string, name: string, args: string }>()

for (const delta of choice?.delta.tool_calls ?? []) {
  const prev = pendingCalls.get(delta.index) ?? { id: '', name: '', args: '' }
  pendingCalls.set(delta.index, {
    id: delta.id ?? prev.id,                              // 只在第一块有，别覆盖
    name: delta.function?.name ?? prev.name,
    args: prev.args + (delta.function?.arguments ?? ''),   // 唯一需要拼接的
  })
}
```

用 `Map` 而不是数组：**`index` 不保证从 0 开始，也不保证连续**——按数组下标写会在稀疏情况下留下空洞。

## 什么时候算"收全了"

一个很诱人的错误答案：**试着 `JSON.parse`，能成功就说明收全了。**

两个致命问题：

- **`{}` 是合法 JSON**，但它完全可能只是 `{"path": "x"}` 的一个中间状态。你会在参数还没到齐时就动手。
- **就算某个工具的参数收全了，你也不知道后面还有没有第三个工具要来。**

唯一可靠的信号是**协议给的**：流结束了。所以拼装完成的判断放在循环之外：

```ts
if (!sawDone) throw new Error('流在收到 [DONE] 之前就结束了：这次回复不完整，不可信')

if (pendingCalls.size > 0) {
  const calls = [...pendingCalls.entries()]
    .sort(([a], [b]) => a - b)          // 按 index 排序，让调用顺序稳定可复现
    .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.args }))
  yield { type: 'tool-calls', calls }
}
```

注意顺序：**先检查 `[DONE]`，再产出工具调用。** 流被截断时那些半截参数一律作废——2.1 那条"整次调用不可信"在这里第一次产生实际后果：**残缺的工具参数比残缺的文本危险得多**，`{"path": "src/` 解析失败还算好的，万一恰好解析成了别的路径呢。

排序那行也值得一提：`Map` 的迭代顺序是插入顺序，而插入顺序取决于**哪个工具的第一块先到**。按 `index` 排序才能让"同样的响应 → 同样的执行顺序"，这是可复现性的一部分。

## 返回类型变了：从字符串到带标签的联合

阶段 2 的生成器产出 `string`。现在它要产出两类东西，于是：

```ts
export type StreamEvent =
  | { type: 'text', text: string }
  | { type: 'tool-calls', calls: ToolCall[] }
```

调用方 `switch` 一下就知道该干什么：

```ts
for await (const event of chatStream(messages, config)) {
  if (event.type === 'text') { process.stdout.write(event.text); reply += event.text; continue }
  // event.calls 在这个分支里被 TypeScript 收窄成 ToolCall[]
}
```

**这就是 0.2 讲的联合类型在真实场景里的第一次发力**：`event.calls` 只在 `type === 'tool-calls'` 的分支里存在，写错分支编译器当场报错。

> 顺带说一个被否掉的方案：生成器其实可以有**返回值**（`AsyncGenerator<string, ToolCall[]>`），把工具调用作为 `return` 值给出去。否掉是因为 **`for await` 会直接丢弃返回值**——调用方必须手写迭代器循环才能拿到，是个太容易踩空的陷阱。

`arguments` 保持**字符串**没有解析。解析和校验属于执行方的责任——那是 3.3 的内容，因为模型给的 JSON 是不可信输入。

## 验证

```
[模型要求调用工具]
  read({"path": "src/llm.ts"})   id=call_aaa
  grep({"pattern": "parseSse"})   id=call_bbb
```

两个交错的工具，各自的碎片正确归位。

## 教 debug：累积出错时，把每一片原样打出来

参数拼错的症状是 `JSON.parse` 抛 `Unexpected end of JSON input`——但错的不是 parse，是**前面某一片丢了或者接错了**。唯一有效的办法是把原始增量打出来：

```ts
for (const delta of choice?.delta.tool_calls ?? []) {
  console.error(`[增量] index=${delta.index} id=${delta.id ?? '-'} name=${delta.function?.name ?? '-'} args=${JSON.stringify(delta.function?.arguments ?? '')}`)
}
```

对着输出问三个问题：

1. **`index` 是不是稳定的** —— 两个调用交错时，同一个调用的所有片必须是同一个 `index`
2. **`id` / `name` 是不是只在第一片里有** —— 如果用 `=` 而不是 `??`，后续片的 `undefined` 会把它们覆盖掉
3. **拼出来的字符串首尾是不是 `{` 和 `}`** —— 少了是漏了片，多了是接重复了

`npm run demo demos/03-tool-loop/02-accumulate.mjs` 就是这个打印的现成版本。

## 对照 dsh：为什么它的流里有 `block-start` / `block-end`

我们靠"流结束"来判断工具调用收全。dsh 的 `StreamChunk` 直接把这件事做成了显式事件（2.4 见过）：

```ts
| { type: 'block-start';     index: number; blockType: ContentBlockType }
| { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
| { type: 'block-end';       index: number; block: ContentBlock }
```

差别在哪：

| | 我们的 | dsh 的 |
|---|---|---|
| 一个工具调用何时算完 | 整个流结束 | 收到它的 `block-end` |
| 谁做累积 | 每个消费者自己攒 | `translate.ts` 攒好，下游拿到的 `block` 已经是完整对象 |
| 能否边收边执行 | 不能——要等全部结束 | 可以——某个 block 结束就能派发它 |

**第三行是真正的差距。** dsh 可以在第一个工具的 `block-end` 到达时就开始执行它，而第二个工具还在流；我们必须等整个响应结束。对于"读三个文件"这种并行工具调用，延迟差别是实打实的。

代价是 `translate.ts` 那 185 行有状态的块装配器。**把复杂度集中在一个地方（翻译层），换取所有下游都能拿到干净的完整对象**——这和 2.4 讲的"只留流式接口"是同一种判断。

---

下一课：**3.3 定义一个工具并执行它** —— `arguments` 那个字符串终于要被解析了，而它是**模型生成的、不可信的**输入。
