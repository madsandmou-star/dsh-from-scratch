# 2.2 用 fetch 读流：ReadableStream 与分帧

> 本课目标：看清"网络分块"和"协议分帧"根本不是一回事，然后手写一个能扛住真实切法的分帧器。

## 实验：让服务器故意用三种方式切

上一课看的是服务器**发出去**的东西，整整齐齐。这一课看客户端**收到**的东西。

我让假服务器发同样五条事件，但故意这样切：① 一次发三条完整事件 ② 把一条事件从 JSON 中间劈成两半 ③ 把一个中文字（UTF-8 三字节）劈成两半。

客户端不做任何缓冲，直接把每个网络 chunk 解码打印：

```
── 第 1 个网络 chunk（147 字节）
"data: {...\"content\":\"a\"}}]}\n\ndata: {...\"content\":\"b\"}}]}\n\ndata: {...\"content\":\"丙\"}}]}\n\n"
── 第 2 个网络 chunk（30 字节）
"data: {\"choices\":[{\"delta\":{\"c"
── 第 3 个网络 chunk（19 字节）
"ontent\":\"丁\"}}]}\n\n"
── 第 4 个网络 chunk（40 字节）
"data: {\"choices\":[{\"delta\":{\"content\":\"�"
── 第 5 个网络 chunk（23 字节）
"��\"}}]}\n\ndata: [DONE]\n\n"
```

三件事同时暴露：

1. **一个 chunk 可能带来三条事件**（第 1 个）。
2. **一条事件可能横跨两个 chunk**，切点在 `"c` / `ontent"` 中间——对这半截 `JSON.parse` 必然抛异常。
3. **一个字符可能被劈开**：第 4、5 个 chunk 里的 `�` 是 UTF-8 替换字符。各自解码就是乱码，而且**你拼起来也救不回来**——乱码在解码那一步就已经产生了。

> 为什么会这样：TCP 是**字节流**，没有"消息"概念。中间还隔着 TLS 记录、HTTP chunked 编码、各级代理的缓冲。**没有任何一层向你承诺"一次读到的正好是一条协议消息"。**
>
> Python 里同样成立：`requests` 的 `iter_content()` 给的也是任意大小的块。你之所以可能没踩过，是因为一直在用 `iter_lines()` —— 那是库替你做了分帧。

## 两个修法

### ① 用带状态的解码器接住半个字符

```ts
const decoder = new TextDecoder('utf-8')
buffer += decoder.decode(chunk, { stream: true })
```

`{ stream: true }` 让 decoder **把结尾处不完整的多字节序列留在内部**，等下一块字节补齐，而不是当场吐出 `�`。

这是"有状态解码"的最小例子：**解码器必须跨调用记住上一次的残留**。

### ② 自己找事件边界

```ts
let boundary: number
while ((boundary = buffer.indexOf('\n\n')) !== -1) {
  const rawEvent = buffer.slice(0, boundary)
  buffer = buffer.slice(boundary + 2)
  ...
}
```

两个细节：

- **用 `while` 不是 `if`** —— 一个 chunk 里可能同时到了三条事件，只切一次会把后两条留到下次，顺序虽然不乱但延迟平白多了一轮。
- **切完的残留留在 buffer 里**，等下一个 chunk 来接上。这就是"分帧"的全部：**缓冲 + 找终止符 + 留残片**。

完整实现在 [`src/sse.ts`](../../../src/sse.ts)，含逐行注释。跑同一个"故意乱切"的服务器：

```
── 第 1 条事件: content = "a"
── 第 2 条事件: content = "b"
── 第 3 条事件: content = "丙"
── 第 4 条事件: content = "丁"     ← 横跨两个 chunk 的那条
── 第 5 条事件: content = "戊"     ← 被劈开的中文字
── 第 6 条事件: [DONE]
```

## 流结束时，buffer 里剩下的东西怎么办

这是本课最需要想清楚的一个判断。

循环结束后，`buffer` 里可能还有一截**没有终止符**的内容。诱惑是"冲刷出去，别浪费"——**不能**。

按 SSE 规范，事件**只在遇到空行终止符时才成立**。没有终止符的尾巴不是"一条还没处理的事件"，它是**一条被截断的事件**：可能少了半个 JSON、半个工具参数。当成正常数据用，下游 `JSON.parse` 会炸，或者更糟——**恰好能解析，但内容是残缺的**。

所以 `src/sse.ts` 在流结束后什么都不做，只留一条注释说明为什么。

> dsh 的注释把这条讲得更狠（`dsh/packages/llm/llm-deepseek/src/sse.ts`）：**"分帧严格遵守规范：事件只在其空行终止符处派发，所以 EOF 时未终止的尾巴是截断，不是可冲刷的负载。"**
>
> 这句话是"半成品状态"主题的第三次出现（1.4 悬空消息、2.1 缺 `[DONE]`、这里的截断尾巴）。三次的答案都一样：**宁可丢掉，不可当成完整数据用。**

## 教 debug：怀疑流式问题时，先把原始 chunk 打出来

```ts
for await (const chunk of response.body!) {
  console.log(`── ${chunk.length} 字节`, JSON.stringify(Buffer.from(chunk).toString('utf8')))
}
```

这是流式问题唯一可靠的起点。要看的是：

- **边界在哪** —— 是不是切在了 JSON 中间
- **有没有 `�`** —— 有就是解码方式错了，不是服务器发错了
- **`\n\n` 出现的位置** —— 是不是对端根本没按 SSE 格式发（有些网关会重新包装响应）

本地跑不出问题、线上才出问题的流式 bug，十有八九是**中间多了一层代理**，改变了分块方式。你的分帧器只要是对的，分块方式就无所谓——**这正是我们要自己分帧的原因**。

## 对照 dsh：它把分帧交给库，但保留了协议判断

dsh 不手写这个循环，用的是 `eventsource-parser`：

```ts
const events = stream
  .pipeThrough(new TextDecoderStream())
  .pipeThrough(new EventSourceParserStream({ onComment }))
```

注意它用的是 **Web Streams 的 `pipeThrough`** 而不是 `for await` + 手动缓冲——两段变换（解码、分帧）被串成一条管道，每段各管一件事。

而 dsh 自己保留的是**协议语义**那一小块：

```ts
for await (const { data } of events) {
  yield data
  if (data === DONE) return
}
throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
```

三行代码，三个决定：`[DONE]` 原样产出（让调用方决定收尾时机）、见到它就返回、没见到就抛错。

**这就是"用依赖"和"被依赖绑架"的区别**：把通用的、边界情况多的部分（CRLF、BOM、多行 data、注释行、UTF-8 切割）交出去，把**自己这个协议独有的判断**留在手里。

---

下一课：**2.3 接进对话循环** —— `chat()` 的返回值要从"一个字符串"变成"一串增量"，调用方的写法会跟着变。你会看到流式的复杂度是怎么向上传染的。
