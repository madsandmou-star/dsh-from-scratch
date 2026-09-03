// 2.3 两种断流：连接被掐，和"干净结束但缺 [DONE]"。后者最阴。
//   node demos/02-streaming/02-broken-stream.mjs

import { createServer } from 'node:http'
import { chatStream } from '../../src/llm.ts'

/**
 * 起一个会用指定方式"断掉"的假模型服务器。
 * @param {'destroy' | 'no-done' | 'ok'} how - 断法。
 * @returns {Promise<{config: object, close: () => void}>}
 */
async function fakeServer(how) {
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* 读完请求体 */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const frame = d => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`)
    frame({ content: '这句话' })
    frame({ content: '说到一半' })
    // 先让前两帧真的发出去再掐，否则客户端一个字都没读到，看不出半句话已经上屏的效果。
    if (how === 'destroy') { setTimeout(() => res.socket.destroy(), 30); return }
    if (how === 'no-done') { res.end(); return }                   // 干净关闭，但没发 [DONE]
    res.write('data: [DONE]\n\n'); res.end()
  })
  await new Promise(r => server.listen(0, r))
  return {
    config: {
      baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'mock', apiKeyEnv: 'K', apiKey: 'k', systemPrompt: '', readOnly: false, accounting: false,
    },
    close: () => server.close(),
  }
}

const messages = [{ role: 'user', content: '说点什么' }]

const tryIt = async (title, how) => {
  console.log(`\n── ${title} ──`)
  const { config, close } = await fakeServer(how)
  let text = ''
  try {
    for await (const event of chatStream(messages, config, [])) {
      if (event.type === 'text') { text += event.text; process.stdout.write(`  屏幕上出现："${event.text}"\n`) }
    }
    console.log(`  ✅ 正常结束，攒到的完整文本："${text}"`)
  } catch (error) {
    console.log(`  ❌ ${error.message}`)
    console.log(`  这时屏幕上已经有了 "${text}" —— 但它不完整，不能进历史。`)
  }
  close()
}

await tryIt('① 正常：收到了 [DONE]', 'ok')
await tryIt('② 连接被掐', 'destroy')
await tryIt('③ 干净关闭，但没发 [DONE] —— 最阴的一种', 'no-done')

console.log('\n② 和 ③ 的区别值得记：')
console.log('  ② 网络层就报错了，你想不发现都难。')
console.log('  ③ 一切"正常"——HTTP 200、流干净地结束了，只是内容少了一半。')
console.log('  如果不检查 [DONE]，③ 会被当成一次成功的回复，半句话进历史，模型下一轮就疯了。')
