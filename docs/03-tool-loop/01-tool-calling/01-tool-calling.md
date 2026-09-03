# 3.1 模型怎么"要求"调工具

> 本课目标：看清工具调用在 wire 上到底长什么样，以及"工具描述是写给模型看的提示词"这件事。

## 先撞墙

阶段 2 结束时，我们的 agent 只能说话。拿它去接一个"模型要求调工具"的响应，看它怎么死：

```
模型 >
[本轮中断，已丢弃] May not write null values to stream
```

同时服务器那边打印：

```
【服务器收到的请求里有 tools 字段吗】 没有
```

两个问题一起暴露：

1. **我们从没告诉模型有哪些工具可用**——请求里没有 `tools` 字段。
2. **`content` 是 `null` 时我们崩了。** 1.3 的非流式版本明明检查过 `content === null`，2.3 写流式版本时只检查了 `undefined` 和空串，`null` 漏网，一路流到 `process.stdout.write(null)` 才炸——**报出来的错和根因毫无关系**。

> 这是 0.3 讲过的那类故障的活标本：**根因被下游症状掩盖**。修法也是老规矩——在边界上把不该通过的值拦住，而不是等它在三层之外炸。
>
> 更值得记的是：**同一个坑换了个形状就没认出来。** 非流式的 `message.content` 和流式的 `delta.content` 是同一个字段的两种形态，我们只在一处设防。

## 请求里多出来的 `tools`

```jsonc
{
  "model": "deepseek-chat",
  "messages": [ ... ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read",
        "description": "读取一个文件的内容。用于回答关于代码或文本文件内容的问题。",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "相对于工作目录的文件路径" }
          },
          "required": ["path"]
        }
      }
    }
  ]
}
```

`parameters` 是一段 **JSON Schema**——它不是给你的代码看的，是**给模型看的**：模型据此生成合法参数。

## 响应：模型不说话，直接要求调用

```jsonc
{
  "choices": [{
    "index": 0,
    "delta": {
      "role": "assistant",
      "content": null,                      // ← 模型选择不说话
      "tool_calls": [{
        "index": 0,
        "id": "call_abc123",                // ← 这次调用的唯一标识
        "type": "function",
        "function": { "name": "read", "arguments": "{\"path\": \"src/llm.ts\"}" }
      }]
    },
    "finish_reason": null
  }]
}
```

然后单独一帧：

```jsonc
{ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }
```

三个细节值得记：

- **`arguments` 是字符串，不是对象。** 模型生成的是一段 JSON **文本**，要你自己 `JSON.parse`。它完全可能生成不合法的 JSON——这是不可信输入（3.3 讲校验）。
- **`id` 是配对用的。** 一轮里模型可以同时要求调用多个工具，结果喂回去时必须靠 `id` 对上号。
- **`finish_reason: "tool_calls"`** 就是 1.2 埋下的那个伏笔——它和 `stop` / `length` 并列，意思是"我停下来是因为要调工具"。

## 第四种 role：`tool`

工具执行完，结果这样喂回去：

```jsonc
{
  "role": "tool",
  "tool_call_id": "call_abc123",     // ← 和上面那个 id 对上
  "content": "1: import { parseSse } from './sse.ts'\n2: ..."
}
```

于是 `messages` 数组里出现了完整的一轮：

```
system    | 你是一个助手
user      | src/llm.ts 里写了什么？
assistant | (content: null, tool_calls: [read(path=src/llm.ts)])
tool      | 1: import { parseSse } ...              ← tool_call_id 指回上一条
assistant | 这个文件实现了一次流式的模型调用……         ← 模型看完结果后的回答
```

**1.2 说过"模型能看到的全部就是 messages 数组"——现在这句话依然成立。** 工具执行没有给模型开任何后门，它只是往数组里多加了两条消息。

**agent 的全部魔法就在这里：没有魔法。**

## 工具描述是提示词，不是文档

`description` 字段决定了模型**会不会用**、**什么时候用**这个工具。它不是给人看的注释，是提示词的一部分。

对比两种写法：

```jsonc
"description": "读文件"                                          // 模型经常不用它
"description": "读取一个文件的内容。当用户询问某个文件里有什么、
                某段代码怎么实现、或者需要基于文件内容回答问题时使用。
                路径相对于当前工作目录。"                          // 模型知道何时该用
```

参数的 `description` 同理——`"path"` 配上 `"相对于工作目录的文件路径"`，模型才不会传绝对路径或者带 `./` 前缀。

> **教 debug：模型不调工具时，先怀疑描述，不是先怀疑模型。**
>
> 排查顺序：① 请求里真的带上 `tools` 了吗（打出来看，别假设）② 描述有没有说清"什么时候用"③ 参数 schema 是否 required 了不该 required 的字段 ④ 才是换个模型或改 system prompt。
>
> 90% 的"模型不听话"是①和②。

## 我们这一课改了什么

只改了两处，都在为后面铺路：

1. `types.ts` 的 `StreamChunk` 加上 `tool_calls` 与 `content: string | null`
2. `llm.ts` 检测到 `tool_calls` 时**明确报错**，而不是让 `null` 漏到下游：

```ts
if (choice?.delta.tool_calls !== undefined) {
  throw new Error(`模型要求调用工具（${name}），但阶段 3.3 之前还不支持`)
}
```

现在撞墙撞出来的是一句人话：

```
[本轮中断，已丢弃] 模型要求调用工具（read），但阶段 3.3 之前还不支持
```

**"还没实现"和"实现错了"必须报出不同的错。** 前者是路线图，后者是 bug——混在一起你会浪费半小时去 debug 一个根本还没写的功能。

## 对照 dsh

我们把工具定义手写成 JSON 塞进请求。dsh 里这件事分给了三个地方：

| 关注点 | dsh 的位置 |
|---|---|
| 工具注册表（谁能被调用） | `dsh/packages/core/tools/src/index.ts` 的 `ctx.tools` |
| 工具 schema 进入提示词组装 | `dsh/packages/core/system-prompt/` |
| 把内部工具定义翻译成 wire 格式 | `dsh/packages/llm/llm-deepseek/src/serialize.ts` |

一个插件注册工具时，**不需要知道 DeepSeek 的 JSON 长什么样**——它注册的是内部表示，翻译层负责变成 wire 格式。这就是 1.2 讲的"内部词汇 ≠ wire 格式"在工具上的体现。

阶段 3 我们会把这三件事全写在一起（够用就好），阶段 8 之后再拆开。

---

下一课：**3.2 流式下把工具调用拼起来** —— 上面那个 `arguments` 字符串在真实流式里是**分块到达**的，这是 2.4 预告的那笔债。
