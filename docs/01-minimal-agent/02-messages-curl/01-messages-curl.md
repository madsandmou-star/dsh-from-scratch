# 1.2 先用 curl 打通

> 本课目标：在写任何代码之前，先用 curl 亲手发一次请求，把"模型调用"这件事去神秘化。
>
> **跑一下（不需要 key）**：`npm run demo demos/01-minimal-agent/03-wire-format.mjs` —— 同一条 curl 打向一个假服务器，请求和响应两头都完整打出来。

## 为什么先 curl

因为它把变量降到最少。用代码调 API 时，失败可能来自：请求体拼错、header 写错、密钥没读到、响应解析错、await 用错。curl 一次成功，就一次性排除掉后面所有"是不是我代码写错了"的怀疑——**你已经证明这个地址、这把钥匙、这个模型名是通的**。

这是一条通用的排查纪律：**先用最笨的工具证明外部世界是好的，再怀疑自己的代码。**

## 发一次

```sh
curl "$(node -p "require('./dsh-learn.json').baseURL")/chat/completions" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $DEEPSEEK_API_KEY" \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "用一句话解释什么是 agent" }
    ]
  }'
```

（觉得第一行的 `node -p` 太绕就直接把 baseURL 抄进去，它只是免得你手写两遍。）

响应大致长这样：

```jsonc
{
  "id": "...",
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "agent 是……" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 23, "completion_tokens": 41, "total_tokens": 64 }
}
```

## 请求体里只有两个东西是本质的

- **`model`**：调哪个模型。
- **`messages`**：一个数组，模型能看到的**全部**内容就是它。

第二条值得停一下。模型不认识"上一轮"、"上下文"、"记忆"这些概念，它每次只看到你这一次发过去的数组。所谓的"对话"完全是客户端造出来的假象——下一课就会亲手造这个假象。

## 三种 role

| role | 谁在说 | 作用 |
|---|---|---|
| `system` | 你（开发者） | 设定身份、规则、可用的环境信息。通常放在数组第一个 |
| `user` | 用户 | 这一轮的输入 |
| `assistant` | 模型 | 模型之前说过的话——由你把它加回数组，模型才"记得" |

阶段 3 还会出现第四种 `tool`：工具执行的结果，也是通过塞进这个数组喂回给模型的。**整个 agent 的复杂度，最终都会落在"这个数组里该有什么"这个问题上。**

## 响应里要看的两个字段

- **`choices[0].message.content`**：模型说的话。可能是 `null`——当模型选择只调用工具而不说话时（阶段 3 会遇到）。
- **`choices[0].finish_reason`**：这一轮**为什么停下来**。`stop` 是正常说完；`length` 是被最大长度截断了；`tool_calls` 是模型要调工具（阶段 3 的分叉点）。

初学者常常只读 `content` 而无视 `finish_reason`，于是遇到"回复莫名其妙断在半句"时无从查起——那是 `length`，不是模型犯傻。

## 教 debug：让 curl 说出更多

```sh
curl -i ...     # 连响应头一起打印（看状态码、限流头）
curl -v ...     # 连 TLS 握手、请求头一起打印（怀疑是代理/网络时用）
```

如果 curl 也失败，问题一定在代码之外的四件事里：地址、密钥、模型名、网络（公司代理、防火墙）。按 [1.1 的状态码表](../01-config-and-key/01-config-and-key.md#教-debug三个状态码分别怀疑什么)对号入座。

## 对照 dsh

dsh 里对应的这一层是 `dsh/packages/llm/llm-deepseek/src/serialize.ts`——把内部的消息表示序列化成这个 wire 格式。它比我们复杂的地方在于：内部消息不只有文本（还有图片、思维链、工具调用），而 wire 格式又必须严格符合供应商的要求，所以中间需要一次显式的翻译。

而 `dsh/packages/llm/llm/src/message.ts` 定义的是**内部**消息词汇——注意 dsh 并不直接把 OpenAI 的格式当成自己的模型。这一层区分的价值在阶段 8 会兑现：换一个协议完全不同的供应商时，需要改的只有翻译层。

---

下一课：[1.3 用 fetch 调模型](../03-fetch-llm/01-fetch-llm.md)
