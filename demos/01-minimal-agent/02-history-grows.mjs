// 1.4 模型是无状态的：所谓"多轮对话"，就是每一轮都把整个历史重新发一遍。
//   node demos/01-minimal-agent/02-history-grows.mjs

import { startFakeServer } from '../harness.mjs'
import { chatStream } from '../../src/llm.ts'

const sizes = []
const { port, close } = await startFakeServer([], '（回复）', undefined, undefined, messages => {
  sizes.push(messages)
})

const config = {
  baseURL: `http://127.0.0.1:${port}/v1`,
  model: 'mock', apiKeyEnv: 'K', apiKey: 'k', systemPrompt: '你是助手。', readOnly: false, accounting: false,
}

// 手工模拟三轮对话，每轮把用户输入和模型回复都追加进同一个数组。
const messages = [{ role: 'system', content: config.systemPrompt }]
for (const [i, said] of ['你好', '再说一句', '最后一句'].entries()) {
  messages.push({ role: 'user', content: said })
  let reply = ''
  for await (const event of chatStream(messages, config, [])) {
    if (event.type === 'text') reply += event.text
  }
  messages.push({ role: 'assistant', content: reply })
  const bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8')
  console.log(`第 ${i + 1} 轮：发出去 ${sizes[i].length} 条消息，${bytes} 字节`)
}
close()

console.log('\n最后一轮发出去的完整历史：')
for (const m of sizes.at(-1)) console.log(`  ${m.role.padEnd(9)} ${m.content}`)

console.log('\n每一轮都把前面全部重发一遍——这就是长对话越来越贵、越来越慢的原因。')
console.log('阶段 16 讲 compaction 时会回到这里。')
