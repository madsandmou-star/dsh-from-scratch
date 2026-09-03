// 1.2 线上到底传了什么：用真的 curl 打一次，但对面是假服务器，所以不需要 key。
//   node demos/01-minimal-agent/03-wire-format.mjs

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// 必须用异步版：execFileSync 会堵住事件循环，而假服务器就跑在同一个进程里——
// 同步等 curl 的结果，等于让服务器永远没机会响应。这个死锁很容易自己撞上。
const run = promisify(execFile)

const REPLY = {
  id: 'chatcmpl-demo',
  model: 'demo-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'agent 是能自己调用工具去完成任务的模型。' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 23, completion_tokens: 41, total_tokens: 64 },
}

const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  console.log(`\n=== 服务器收到的请求 ===`)
  console.log(`${req.method} ${req.url}`)
  for (const [k, v] of Object.entries(req.headers)) {
    if (['content-type', 'authorization'].includes(k)) {
      console.log(`${k}: ${k === 'authorization' ? v.slice(0, 13) + '…（打码）' : v}`)
    }
  }
  console.log('\n请求体：')
  console.log(JSON.stringify(JSON.parse(body), null, 2))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(REPLY))
})
await new Promise(r => server.listen(0, r))
const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`

// 和 1.2 讲义里那条 curl 一模一样，只是地址指向假服务器。
const { stdout: out } = await run('curl', [
  '-s', url,
  '-H', 'content-type: application/json',
  '-H', 'authorization: Bearer sk-这是假的',
  '-d', JSON.stringify({
    model: 'demo-model',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: '用一句话解释什么是 agent' },
    ],
  }),
], { encoding: 'utf8' })
server.close()

console.log('\n=== curl 拿到的响应 ===')
console.log(JSON.stringify(JSON.parse(out), null, 2))

const completion = JSON.parse(out)
console.log('\n=== 要看的两个字段 ===')
console.log(`  choices[0].message.content  = ${JSON.stringify(completion.choices[0].message.content)}`)
console.log(`  choices[0].finish_reason    = ${JSON.stringify(completion.choices[0].finish_reason)}`)
console.log('\ncontent 可能是 null（模型只调工具不说话时，阶段 3 会遇到）。')
console.log('finish_reason 是 length 时说明被最大长度截断了——不是模型犯傻。')
