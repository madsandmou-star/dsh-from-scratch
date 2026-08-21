// 阶段 1.3：一次非流式的模型调用。
//
// 这个文件只做一件事：把 messages 数组变成模型的一句回复。
// 没有重试、没有流式、没有工具、没有抽象层——这些会在阶段 2、3、8 依次加进来，
// 每一个都要先看见它解决的问题。

import type { Config } from './config.ts'
import type { ChatCompletion, Message } from './types.ts'

// 本地相对导入写 `.ts` 后缀，是 ESM 的要求：运行时要按字面路径找文件。
// 仓库根 AGENTS.md 把这条列成了硬约定，dsh 的 packages/ 里也是同样的写法。

/**
 * 发一次 chat completion 请求，返回模型的回复文本。
 * @param messages - 完整的对话历史，包括开头那条 system 消息。
 * @param config - 连接事实与密钥，由 loadConfig() 产出。
 * @returns 模型这一轮的回复文本。
 */
export async function chat(messages: Message[], config: Config & { apiKey: string }): Promise<string> {
  // fetch 是 Node 18 起内置的全局函数，不需要装任何 HTTP 库。
  // await 的意思是"在这里等这个 Promise 有结果再往下走"，
  // 等待期间进程不阻塞，事件循环还能处理别的事（阶段 3 之后这一点会变得重要）。
  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Bearer 认证：密钥放在 Authorization 头里，不放在 URL 上——URL 会进日志。
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
    }),
  })

  // fetch 不会因为 4xx / 5xx 抛异常，它只在网络层失败时抛。
  // 所以状态码必须自己检查，否则下一行 JSON.parse 会拿到一个错误体，
  // 报出来的却是"读不到 choices"这种离根因很远的错（见 01-config-and-key 的 debug 小节）。
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`模型请求失败：HTTP ${response.status}\n${body}`)
  }

  const completion = await response.json() as ChatCompletion
  const content = completion.choices[0]?.message.content

  // 模型可以合法地返回 null content（例如它选择只调用工具而不说话）。
  // 阶段 1 还没有工具，所以这里当成异常；阶段 3 会把这条路径改成"去执行工具"。
  if (content === undefined || content === null) {
    throw new Error(`响应里没有文本内容：${JSON.stringify(completion.choices[0])}`)
  }

  return content
}

// 对照 dsh：同一件事在 packages/llm/llm-deepseek/src/adapter.ts 里做，
// 那个适配器被明确定义为 transport-only——只管发请求和解流，
// 连接事实由注册它的插件解析后传进来，密钥每次请求现取。
// 我们这里把"解析配置"和"发请求"混在一起了，阶段 8 会把它们拆开，
// 那时你会看到"显式的 resolve 步骤"这条规矩解决的是什么问题。
