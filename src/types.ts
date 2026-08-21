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
