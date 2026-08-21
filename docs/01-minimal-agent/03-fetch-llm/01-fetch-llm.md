# 1.3 用 fetch 调模型

> 本课目标：把上一课的 curl 变成代码，顺带把 `async` / `await` 讲清楚。

## async / await 的最小心智模型

```ts
const response = await fetch(url, options)
```

`fetch` 立刻返回一个 **Promise**：一张"结果以后会有"的凭据。`await` 的意思是"在这里等这张凭据兑现，再往下走"。

关键在于"等"的方式：它**不阻塞进程**。等待期间事件循环可以处理别的事——另一个请求的响应、一次键盘输入、一个定时器。所以 Node 用单线程就能同时处理很多 IO。

三条实用规则：

1. 用了 `await` 的函数必须标 `async`（模块顶层例外，ESM 允许顶层 `await`，[`index.ts`](../../../src/index.ts) 用的就是这个）。
2. `async` 函数的返回值总是 Promise。`Promise<string>` 读作"以后会给你一个 string"。
3. 忘了写 `await`，你拿到的是那张凭据本身，而不是结果。典型症状：打印出 `Promise { <pending> }`，或者 `undefined` 出现在完全说不通的地方。

## 先给消息一个类型

[`src/types.ts`](../../../src/types.ts)：

```ts
export type Role = 'system' | 'user' | 'assistant'

export interface Message {
  role: Role
  content: string
}
```

`ChatCompletion` 只声明了我们真正会读的字段（`choices[].message.content` 和 `finish_reason`），没有把响应的每个字段抄一遍。**类型是给人看的说明，不是响应的复印件**——多写的字段既不会被检查，也会在响应变化时变成谎言。

## 发请求：[`src/llm.ts`](../../../src/llm.ts)

```ts
export async function chat(messages: Message[], config: Config & { apiKey: string }): Promise<string> {
  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model: config.model, messages }),
  })
```

和上一课的 curl 一一对应：URL、两个头、一个 JSON body。`Config & { apiKey: string }` 里的 `&` 是交叉类型，意思是"既有 Config 的全部字段，又多一个 apiKey"。

### 最容易踩的一脚：fetch 不为 4xx 抛错

```ts
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`模型请求失败：HTTP ${response.status}\n${body}`)
  }
```

`fetch` 只在**网络层**失败时抛异常（域名解析不了、连接断了）。服务器明明白白告诉你 401、400、429 时，`fetch` 认为"我成功地拿到了一个响应"，`response.ok` 才是 `false`。

漏掉这个检查的后果不是"看不到错误"，而是**错误会伪装成另一个错误**：下一行把错误体解析成 JSON，然后报 `Cannot read properties of undefined (reading 'message')`——一条离根因十万八千里的报错。这一类"根因被下游症状掩盖"的故障，是 debug 时最花时间的一种，而防住它只要三行。

注意错误信息里带上了响应体：状态码只说"哪一类错"，body 才说"具体哪里错"。

### 模型可以合法地不说话

```ts
  const completion = await response.json() as ChatCompletion
  const content = completion.choices[0]?.message.content

  if (content === undefined || content === null) {
    throw new Error(`响应里没有文本内容：${JSON.stringify(completion.choices[0])}`)
  }
```

`content` 为 `null` 不是异常，是模型选择了"只调工具，不说话"。阶段 1 还没有工具，所以这里当成错误抛出；**阶段 3 会把这条路径改成"去执行工具"**——这就是 agent 长出手脚的那一刀落在哪里。

`?.` 是可选链：`choices` 可能是空数组，`choices[0]` 在类型上是 `Foo | undefined`，`strict` 模式不允许你假装它一定有（[0.2](../../00-env-basics/02-typescript-esm/01-typescript-esm.md) 讲过）。

## 教 debug：失败时按这个顺序看

1. **状态码**：非 2xx 就去查 [1.1 的表](../01-config-and-key/01-config-and-key.md#教-debug三个状态码分别怀疑什么)，不用往下看了。
2. **响应体全文**：`console.log(await response.text())`。注意 body 只能读一次，读了 `text()` 就不能再 `json()`。
3. **请求体全文**：在 `fetch` 前一行 `console.dir(messages, { depth: null })`。**你以为发出去的，和实际发出去的，是两回事。**
4. **还没头绪**：把这次请求原样搬回 curl 跑一遍。curl 通了说明问题在代码里，curl 也不通说明问题在代码外。

## 对照 dsh

| | 我们的 `chat()` | dsh 的 `DeepSeekAdapter` | 为什么 dsh 更复杂 |
|---|---|---|---|
| 位置 | `src/llm.ts` | `dsh/packages/llm/llm-deepseek/src/adapter.ts` | |
| 职责 | 读配置 + 发请求 + 解响应 | **只**发请求和解流；连接事实由注册它的插件解析好传进来 | 职责单一才可替换、可测试 |
| 返回 | 一个 string | 一串 `StreamChunk` | 流式是 dsh 的默认，不是可选项（阶段 2） |
| 失败 | 一个 Error | `LlmError` + 分类码（上下文超限、配额耗尽……） + 重试策略 | 上层要能区别对待"重试有用"和"重试没用" |
| 密钥 | 启动时取一次 | 每次请求现取 | 配置变更立刻生效 |

dsh 把这个适配器明确定义为 **transport-only**（源码 JSDoc 里就是这么写的）。我们现在把"解析配置"和"发请求"混在一起了——阶段 8 会把它们拆开，那时你会看到 dsh 那条"默认值必须是一次显式的 resolve 步骤，不能是 `run()` 里藏着的 `?? default`"的规矩解决的是什么问题。

---

下一课：[1.4 多轮对话](../04-multi-turn/01-multi-turn.md)
