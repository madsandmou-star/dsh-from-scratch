// 6.2 为什么是一行一条 JSON，而不是一个大 JSON 数组。
//   node --import tsx demos/06-session/04-why-jsonl.mjs
//
// 两个理由，两个可测的数字：追加一条要写多少字节，以及写到一半被杀会剩下什么。

import { appendFileSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
const EVENTS = 2000

/** 造一条差不多真实大小的事件。 */
const makeEvent = seq => ({ type: 'tool/result', seq, time: Date.now(), data: { callId: `call_${seq}`, content: 'x'.repeat(200) } })

// ── 做法 A：整个日志是一个 JSON 数组，追加 = 读回来 + push + 整个写回去 ──
const arrayPath = join(dir, 'log.json')
writeFileSync(arrayPath, '[]', 'utf8')
let arrayBytes = 0
let start = performance.now()
for (let seq = 0; seq < EVENTS; seq++) {
  const all = JSON.parse(readFileSync(arrayPath, 'utf8'))
  all.push(makeEvent(seq))
  const text = JSON.stringify(all)
  writeFileSync(arrayPath, text, 'utf8')
  arrayBytes += text.length
}
const arrayMs = performance.now() - start

// ── 做法 B：一行一条，追加 = 往文件末尾写一行 ──
const jsonlPath = join(dir, 'log.jsonl')
writeFileSync(jsonlPath, '', 'utf8')
let jsonlBytes = 0
start = performance.now()
for (let seq = 0; seq < EVENTS; seq++) {
  const line = `${JSON.stringify(makeEvent(seq))}\n`
  appendFileSync(jsonlPath, line, 'utf8')
  jsonlBytes += line.length
}
const jsonlMs = performance.now() - start

const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`
console.log(`=== 追加 ${EVENTS} 条事件，两种格式 ===`)
console.log(`  JSON 数组   写了 ${mb(arrayBytes).padStart(9)}   耗时 ${arrayMs.toFixed(0).padStart(6)} ms   最终文件 ${mb(statSync(arrayPath).size)}`)
console.log(`  JSONL       写了 ${mb(jsonlBytes).padStart(9)}   耗时 ${jsonlMs.toFixed(0).padStart(6)} ms   最终文件 ${mb(statSync(jsonlPath).size)}`)
console.log(`\n  写入量差 ${(arrayBytes / jsonlBytes).toFixed(0)} 倍，耗时差 ${(arrayMs / jsonlMs).toFixed(0)} 倍。`)
console.log('  原因：数组那边每追加一条，都要把**整个历史**重写一遍——O(n²)。')
console.log('  会话越长越慢，而会话本来就是会一直变长的东西。')

// ── 第二个理由：写到一半被杀，剩下的文件还能不能读 ──
console.log('\n=== 写到一半进程被杀，文件还剩什么 ===')
const records = [0, 1, 2, 3, 4].map(makeEvent)
const goodArray = JSON.stringify(records)
const goodJsonl = records.map(e => `${JSON.stringify(e)}\n`).join('')
const cut = text => text.slice(0, Math.floor(text.length * 0.6))    // 写了 60% 就被杀

for (const [name, text] of [['JSON 数组', cut(goodArray)], ['JSONL', cut(goodJsonl)]]) {
  const lines = text.split('\n').filter(l => l !== '')
  let ok = 0
  for (const line of lines) { try { JSON.parse(line); ok++ } catch { /* 这一行残缺 */ } }
  console.log(`  ${name.padEnd(10)} 截断后能读回 ${ok} 条完整记录（原本 5 条）`)
}

console.log('\n  JSON 数组是一个整体：少一个 `]` 就整个文件解析失败，五条全丢。')
console.log('  JSONL 的每一行独立成立：**只有最后那行残缺**，前面的照样能读。')
console.log('  这就是 6.4 那个"截断修复"能存在的前提——格式先让它成为可能。')
