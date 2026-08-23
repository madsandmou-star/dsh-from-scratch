// 阶段 1.3：先给"消息"一个类型。
//
// 这门课的类型会随阶段长大：阶段 3 加 tool 调用，阶段 12 会发现
// "消息"根本不是最原始的东西——事件才是，消息是从事件投影出来的。
// 现在先保持最小。

/** 一条对话消息的角色。 */
export type Role = 'system' | 'user' | 'assistant'

/**
 * 一条对话消息。
 * 这就是 OpenAI 兼容 API 在 `messages` 数组里要的元素：只有角色和文本。
 */
export interface Message {
  role: Role
  content: string
}

/**
 * 一次拼装完成的工具调用。`arguments` 保持字符串——它是模型生成的 JSON 文本，
 * 是不可信输入，解析和校验属于执行方的责任（阶段 3.3）。
 */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

/**
 * `chatStream()` 产出的东西。
 *
 * 阶段 2 它只产出文本增量（一个 string），现在多了"工具调用"这一类，
 * 所以改成带标签的联合类型——调用方 switch 一下就知道该干什么。
 * dsh 的 `StreamChunk` 是同一个思路，只是它有七个成员（见 2.4）。
 */
export type StreamEvent =
  | { type: 'text', text: string }
  | { type: 'tool-calls', calls: ToolCall[] }

/**
 * 流式响应里每一帧的结构。注意是 `delta`（增量）不是 `message`（快照）。
 * 阶段 3 加工具调用时，delta 里还会出现 `tool_calls`，那时这个类型会长大。
 */
export interface StreamChunk {
  choices: Array<{
    delta: {
      role?: 'assistant'
      /** 文本增量。模型选择只调用工具时是 null。 */
      content?: string | null
      /** 工具调用增量。阶段 3.2 会讲它为什么是"增量"而不是完整对象。 */
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string, arguments?: string }
      }>
    }
    finish_reason: string | null
  }>
}

/**
 * `/chat/completions` 非流式响应里我们真正用到的部分。
 * 真实响应还有 usage、id、created 等字段，声明它们对当前这一课没有帮助，
 * 所以只写我们要读的那几个——类型是给人看的说明，不是响应的复印件。
 */
export interface ChatCompletion {
  choices: Array<{
    message: { role: 'assistant', content: string | null }
    finish_reason: string
  }>
}
