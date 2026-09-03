// 3.1 / 3.3 请求里的 tools 字段长什么样：模型看到的工具就是这些 JSON。
//   node demos/03-tool-loop/01-tools-in-request.mjs

import { createServer } from 'node:http'
import { chatStream } from '../../src/llm.ts'
import { tools } from '../../src/tool.ts'

const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const request = JSON.parse(body)

  console.log('请求的顶层字段：', Object.keys(request).join(', '))
  console.log(`\nmessages（${request.messages.length} 条）：`)
  for (const m of request.messages) console.log(`  ${m.role.padEnd(9)} ${String(m.content).slice(0, 50)}`)

  console.log(`\ntools（${request.tools.length} 个）：`)
  for (const t of request.tools) {
    const required = t.function.parameters.required ?? []
    console.log(`  ${t.function.name.padEnd(7)} 参数 ${Object.keys(t.function.parameters.properties).join('/')}`
      + `　必填 ${required.join('/') || '（无）'}`)
  }

  console.log('\nbash 这一个的完整样子——模型读到的就是这段 JSON：')
  console.log(JSON.stringify(request.tools.find(t => t.function.name === 'bash'), null, 2).split('\n').map(l => `  ${l}`).join('\n'))

  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise(r => server.listen(0, r))

const config = {
  baseURL: `http://127.0.0.1:${server.address().port}/v1`,
  model: 'mock', apiKeyEnv: 'K', apiKey: 'k', systemPrompt: '你是助手。', readOnly: false, accounting: false,
}
for await (const _ of chatStream([{ role: 'user', content: '你好' }], config, tools)) { /* 只关心请求 */ }
server.close()

console.log('\n注意 description 里**没有**提到别的工具——那些"该先用谁"的话在 system prompt 里（5.1）。')
