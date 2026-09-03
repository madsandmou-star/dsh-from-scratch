// 2.2 分帧器抗切分：网络分块 ≠ 协议分帧。同一份数据，五种切法，结果必须一样。
//   node demos/02-streaming/01-sse-framing.mjs

import { parseSse } from '../../src/sse.ts'

/** 三条事件的完整字节流。第三条故意在 JSON 里放中文，用来试探多字节字符被劈开的情况。 */
const WIRE =
  'data: {"n":1}\n\n'
  + 'data: {"n":2}\n\n'
  + 'data: {"text":"你好世界"}\n\n'
  + 'data: [DONE]\n\n'

/**
 * 把一段文本按给定的切点切成若干块，做成一个字节流。
 * @param {string} text - 完整的线上数据。
 * @param {number[] | 'each-byte'} cuts - 切点下标；'each-byte' 表示一个字节一块。
 * @returns {ReadableStream<Uint8Array>} 模拟出来的网络流。
 */
function streamOf(text, cuts) {
  const bytes = new TextEncoder().encode(text)
  const parts = []
  if (cuts === 'each-byte') {
    for (const b of bytes) parts.push(Uint8Array.of(b))
  } else {
    let from = 0
    for (const at of [...cuts, bytes.length]) { parts.push(bytes.slice(from, at)); from = at }
  }
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p)
      controller.close()
    },
  })
}

/**
 * 用一种切法跑一遍分帧器，打印它产出的事件。
 * @param {string} title - 这一格演示什么。
 * @param {number[] | 'each-byte'} cuts - 切点。
 */
const frame = async (title, cuts) => {
  const events = []
  for await (const data of parseSse(streamOf(WIRE, cuts))) events.push(data)
  const label = cuts === 'each-byte' ? '每字节一块'
    : cuts.length === 0 ? '不切' : `切在字节 ${cuts.join(', ')}`
  console.log(`\n── ${title}（${label}）──`)
  for (const e of events) console.log(`  ${e}`)
  console.log(`  共 ${events.length} 条`)
}

// "你"这个字在字节流里的位置——切在它中间，才算真的试探了多字节字符。
const bytes = new TextEncoder().encode(WIRE)
const 你的第一个字节 = bytes.indexOf(new TextEncoder().encode('你')[0])

await frame('① 全部挤在一个 chunk 里', [])
await frame('② 前两条一块，后两条一块', [WIRE.indexOf('data: {"text"')])
await frame('③ 切在 JSON 中间', [20])
await frame(`④ 切开"你"这个字（它占 3 字节，切在第 1 和第 2 字节之间）`, [你的第一个字节 + 1])
await frame('⑤ 一个字节一块——最极端的切法', 'each-byte')

console.log('\n五种切法，产出完全一样。')
console.log('关键是两件事：TextDecoder({stream:true}) 接住被劈开的多字节字符，')
console.log('以及用 while 找边界——一个 chunk 里可能同时有好几条事件。')

// 最后一格：流末尾有半条没有终止符的残片，必须丢掉而不是当正常数据。
const 残片 = 'data: {"n":1}\n\ndata: {"n":2}'   // 注意结尾没有空行
const rest = []
for await (const data of parseSse(streamOf(残片, []))) rest.push(data)
console.log(`\n── ⑥ 结尾是半条没有终止符的残片 ──`)
console.log(`  产出 ${rest.length} 条：${rest.join(' | ')}`)
console.log('  第二条被丢掉了——按 SSE 规范它还不构成一个事件。')
