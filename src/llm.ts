// 阶段 2.3：一次流式的模型调用。
//
// 和阶段 1 的 chat() 相比只改了一件事：返回值从"一个字符串"变成"一串增量"。
// 这一个改动会一路传染到调用方——见 index.ts。

import { parseSse } from './sse.ts'
import { tools, toWireTools } from './tool.ts'
import type { ResolvedConfig } from './config.ts'
import type { Message, StreamChunk, StreamEvent, ToolCall } from './types.ts'

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
 * @returns 依次产出文本增量，以及（如果模型要求调工具）流末一条拼装完成的工具调用事件。
 */
export async function* chatStream(
  messages: Message[],
  config: ResolvedConfig,
): AsyncGenerator<StreamEvent, void> {
  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    // 3.1 撞墙时发现的问题在这里补上：不告诉模型有哪些工具，它永远不会调用工具。
    body: JSON.stringify({ model: config.model, messages, stream: true, tools: toWireTools(tools) }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`模型请求失败：HTTP ${response.status}\n${body}`)
  }
  if (response.body === null) throw new Error('响应没有 body，无法读流')

  let sawDone = false

  // 工具调用是**按 index 分组的增量**：`id` 和 `name` 只在每组的第一块出现，
  // 后续碎片只有 index 和一截 arguments 文本。所以要按 index 攒。
  // 用 Map 而不是数组：index 不保证从 0 开始，也不保证连续。
  const pendingCalls = new Map<number, { id: string, name: string, args: string }>()

  for await (const payload of parseSse(response.body)) {
    // [DONE] 是 OpenAI 协议的收尾标记，不是一条内容。见到它就结束。
    if (payload === '[DONE]') { sawDone = true; break }

    const chunk = JSON.parse(payload) as StreamChunk
    const choice = chunk.choices[0]

    for (const delta of choice?.delta.tool_calls ?? []) {
      const prev = pendingCalls.get(delta.index) ?? { id: '', name: '', args: '' }
      pendingCalls.set(delta.index, {
        // id / name 只在第一块出现，后续块里是 undefined —— 不能直接覆盖，否则第一块的值会被冲掉。
        id: delta.id ?? prev.id,
        name: delta.function?.name ?? prev.name,
        // arguments 是唯一需要拼接的字段。
        args: prev.args + (delta.function?.arguments ?? ''),
      })
    }

    const delta = choice?.delta.content
    // content 可能是 undefined（只带 finish_reason 的那一帧）、null（模型选择只调工具）或空字符串，三种都跳过。
    if (delta !== undefined && delta !== null && delta !== '') yield { type: 'text', text: delta }
  }

  // 没等到 [DONE] 流就结束了 = 响应被截断（网络断、服务器崩、代理超时）。
  // 此时已经 yield 出去的那些增量是真实到达的，但整段回复是残缺的，
  // 调用方必须知道这件事——所以这里抛错，而不是安静地正常返回。
  // dsh 在 packages/llm/llm-deepseek/src/sse.ts 里做同样的判断，错误码是 STREAM_CLOSED。
  if (!sawDone) throw new Error('流在收到 [DONE] 之前就结束了：这次回复不完整，不可信')

  // 到这里流已经完整结束了，攒着的工具调用才算收全。
  // **不能用"arguments 能否 JSON.parse 成功"来判断收全**：`{}` 是合法 JSON，
  // 而它完全可能只是 `{"path": "x"}` 的一个前缀状态；反过来也不知道后面还有没有第三个工具要来。
  // 唯一可靠的信号是协议给的——流结束了。
  if (pendingCalls.size > 0) {
    const calls: ToolCall[] = [...pendingCalls.entries()]
      .sort(([a], [b]) => a - b)      // 按 index 排序，让调用顺序稳定可复现
      .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.args }))
    yield { type: 'tool-calls', calls }
  }
}
