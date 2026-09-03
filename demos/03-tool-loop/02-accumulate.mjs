// 3.2 工具调用的参数是**分块**到达的，而且多个调用会交错。靠 index 归位。
//   node demos/03-tool-loop/02-accumulate.mjs

import { createServer } from 'node:http'
import { chatStream } from '../../src/llm.ts'
import { tools } from '../../src/tool.ts'

// 两个工具调用交错到达，而且每个的参数都被切成了碎片。
// 真实供应商就是这么发的——碎片边界完全不保证落在 JSON 的合法位置上。
const DELTAS = [
  { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"pa' } }] },
  { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{"pat' } }] },
  { tool_calls: [{ index: 0, function: { arguments: 'th": "sr' } }] },
  { tool_calls: [{ index: 1, function: { arguments: 'tern": "TODO"' } }] },
  { tool_calls: [{ index: 0, function: { arguments: 'c/llm.ts"}' } }] },
  { tool_calls: [{ index: 1, function: { arguments: '}' } }] },
]

const server = createServer(async (req, res) => {
  for await (const _ of req) { /* 读完请求体 */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const delta of DELTAS) {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise(r => server.listen(0, r))

console.log('服务器发出去的六个增量（注意 index 0 和 1 交错）：')
for (const d of DELTAS) {
  const c = d.tool_calls[0]
  console.log(`  index=${c.index}  ${c.function.name ?? '（续）'}  arguments 片段：${JSON.stringify(c.function.arguments)}`)
}

const config = {
  baseURL: `http://127.0.0.1:${server.address().port}/v1`,
  model: 'mock', apiKeyEnv: 'K', apiKey: 'k', systemPrompt: '', readOnly: false, accounting: false,
}
console.log('\n累积之后拿到的完整调用：')
for await (const event of chatStream([{ role: 'user', content: 'x' }], config, tools)) {
  if (event.type !== 'tool-calls') continue
  for (const call of event.calls) {
    console.log(`  ${call.id}  ${call.name}(${call.arguments})`)
    console.log(`      JSON.parse 之后：${JSON.stringify(JSON.parse(call.arguments))}`)
  }
}
server.close()

console.log('\n两件事：')
console.log('  ① 碎片切在 "pa|th" 和 "pat|tern" 中间——任何一块单独拿去 JSON.parse 都会炸。')
console.log('  ② 两个调用交错发送，靠 index 而不是到达顺序归位。')
