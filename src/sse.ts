// 阶段 2.2：把"字节流"变成"一条条 SSE 事件"。
//
// 这个文件解决一个具体问题：网络分块和协议分帧不是一回事。
// fetch 给你的每个 chunk 是"这一次网络读到的字节"，它可能：
//   - 一次带来三条完整事件
//   - 把一条事件从 JSON 中间劈成两半
//   - 把一个中文字（UTF-8 三字节）劈成两半
// 所以必须自己缓冲、自己找边界。

/**
 * 把 SSE 字节流解码成一条条 `data:` 负载。
 * @param stream - fetch 响应的 body，字节流。
 * @returns 每个事件的 data 内容，按到达顺序；`[DONE]` 也会照常产出，由调用方决定怎么收尾。
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  // TextDecoder 负责字节 → 文本。`{ stream: true }` 是关键：
  // 它会把结尾处不完整的多字节字符留在内部，等下一块字节补齐，而不是吐出乱码 �。
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })

    // SSE 的事件边界是一个空行，也就是连续两个换行。
    // 用 while 而不是 if：一个网络 chunk 里可能同时到了好几条事件。
    let boundary: number
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)      // +2 跳过那两个换行

      // 一个事件可以有多行；聊天补全只用 `data:` 这一种字段，其余（event:/id:/retry:/注释行）忽略。
      // 规范允许多行 data 拼接，这里保持完整实现，免得遇到别家实现时莫名其妙丢内容。
      const dataLines = rawEvent
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trimStart())

      if (dataLines.length > 0) yield dataLines.join('\n')
    }
  }

  // 走到这里说明流结束了。buffer 里如果还有东西，那是一截**没有终止符**的残片——
  // 按 SSE 规范它还不构成一个事件，所以不能冲刷出去当正常数据用。
  // 阶段 2.4 会讲 dsh 为什么把"没等到 [DONE] 就结束"直接当成错误。
}
