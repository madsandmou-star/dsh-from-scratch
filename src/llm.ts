// 阶段 2.3：一次流式的模型调用。
//
// 和阶段 1 的 chat() 相比只改了一件事：返回值从"一个字符串"变成"一串增量"。
// 这一个改动会一路传染到调用方——见 index.ts。

import { parseSse } from './sse.ts'
import type { Config } from './config.ts'
import type { Message, StreamChunk } from './types.ts'

/**
 * 发一次流式 chat completion 请求，逐块产出模型的输出。
 *
 * 用异步生成器（async generator）而不是回调，是一个有意的选择：
 * 生成器的产出顺序天然就是到达顺序，调用方用 `for await` 写起来是平铺的直线代码，
 * 而且**背压**是自动的——调用方处理慢，生成器就停在 yield 那里等它。
 * 回调写法（`chatStream(msgs, onChunk)`）会把控制流拆散到两个地方，
 * 一旦调用方需要"收到某块之后提前停止"，回调就要额外发明一个返回值约定。
 *
 * @param messages - 完整的对话历史。
 * @param config - 连接事实与密钥。
 * @returns 依次产出文本增量；流正常结束时返回，异常时抛错。
 */
export async function* chatStream(
  messages: Message[],
  config: Config & { apiKey: string },
): AsyncGenerator<string, void> {
  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    // 和阶段 1 唯一的请求差别：stream: true。
    body: JSON.stringify({ model: config.model, messages, stream: true }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`模型请求失败：HTTP ${response.status}\n${body}`)
  }
  if (response.body === null) throw new Error('响应没有 body，无法读流')

  let 见过DONE = false

  for await (const payload of parseSse(response.body)) {
    // [DONE] 是 OpenAI 协议的收尾标记，不是一条内容。见到它就结束。
    if (payload === '[DONE]') { 见过DONE = true; break }

    const chunk = JSON.parse(payload) as StreamChunk
    const choice = chunk.choices[0]

    // 模型要求调用工具时，这一帧的 content 是 null，真正的内容在 delta.tool_calls 里。
    // 阶段 3.2 会把分块到达的工具调用拼起来，3.3 才真正执行它。现在先明确地拒绝，
    // 而不是让 null 一路流到 process.stdout.write() 去炸出一句无关的报错。
    if (choice?.delta.tool_calls !== undefined) {
      const 名字 = choice.delta.tool_calls.map(call => call.function?.name).filter(Boolean).join(', ')
      throw new Error(`模型要求调用工具${名字 === '' ? '' : `（${名字}）`}，但阶段 3.3 之前还不支持`)
    }

    const delta = choice?.delta.content
    // content 可能是 undefined（只带 finish_reason 的那一帧）、null（模型选择只调工具）或空字符串，三种都跳过。
    if (delta !== undefined && delta !== null && delta !== '') yield delta
  }

  // 没等到 [DONE] 流就结束了 = 响应被截断（网络断、服务器崩、代理超时）。
  // 此时已经 yield 出去的那些增量是真实到达的，但整段回复是残缺的，
  // 调用方必须知道这件事——所以这里抛错，而不是安静地正常返回。
  // dsh 在 packages/llm/llm-deepseek/src/sse.ts 里做同样的判断，错误码是 STREAM_CLOSED。
  if (!见过DONE) throw new Error('流在收到 [DONE] 之前就结束了：这次回复不完整，不可信')
}
