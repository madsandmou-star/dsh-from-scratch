// 6.3 每条一次同步写 vs 攒批异步写：系统调用次数、耗时，以及事件循环被卡多久。
//   node --import tsx demos/06-session/05-batching.mjs

import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
const EVENTS = 20000
const lines = Array.from({ length: EVENTS }, (_, seq) =>
  `${JSON.stringify({ type: 'tool/result', seq, time: Date.now(), data: { callId: `call_${seq}`, content: 'x'.repeat(200) } })}\n`)

/**
 * 量一段代码把事件循环卡了多久。
 *
 * 手法：起一个 1ms 的定时器，看它实际隔了多久才被叫醒。JS 是单线程的，
 * 同步代码跑着的时候定时器根本没机会执行——**迟到的那部分就是被卡住的时间**。
 * @param work - 要测量的函数。
 * @returns 耗时和最大定时器延迟，单位毫秒。
 */
async function measure(work) {
  let worstLag = 0
  let last = performance.now()
  const tick = setInterval(() => {
    const now = performance.now()
    worstLag = Math.max(worstLag, now - last - 1)
    last = now
  }, 1)
  const start = performance.now()
  await work()
  const ms = performance.now() - start
  // 让积压的定时器先跑一轮再停表：同步代码把它们全堵在队列里了，
  // 不给它们一次机会，"迟到了多久"就永远量不出来。
  await new Promise(resolve => { setTimeout(resolve, 0) })
  clearInterval(tick)
  return { ms, worstLag }
}

// ── 做法 A：6.2 那版，每条事件一次 appendFileSync ──
const syncPath = join(dir, 'sync.jsonl')
writeFileSync(syncPath, '', 'utf8')
let syscallsA = 0
const a = await measure(async () => {
  for (const line of lines) { appendFileSync(syncPath, line, 'utf8'); syscallsA++ }
})

// ── 做法 B：6.3 这版，攒够一批再写 + fsync ──
const batchPath = join(dir, 'batch.jsonl')
writeFileSync(batchPath, '', 'utf8')
const BATCH = 200
let syscallsB = 0
const b = await measure(async () => {
  for (let i = 0; i < lines.length; i += BATCH) {
    const handle = await open(batchPath, 'a')
    await handle.writeFile(lines.slice(i, i + BATCH).join(''))
    await handle.sync()
    await handle.close()
    syscallsB++
  }
})

console.log(`=== 写 ${EVENTS} 条事件 ===`)
console.log(`  每条同步写   ${String(syscallsA).padStart(5)} 次写调用   耗时 ${a.ms.toFixed(0).padStart(5)} ms   事件循环最长被卡 ${a.worstLag.toFixed(0).padStart(4)} ms`)
console.log(`  攒 ${BATCH} 条一批  ${String(syscallsB).padStart(5)} 次写调用   耗时 ${b.ms.toFixed(0).padStart(5)} ms   事件循环最长被卡 ${b.worstLag.toFixed(0).padStart(4)} ms`)

console.log('\n看两件事：')
console.log('  ① 写调用次数差 %d 倍——同样的字节，同样的最终文件。', Math.round(syscallsA / syscallsB))
console.log('  ② 更关键的是最后一栏：同步写把事件循环整段占住了。')
console.log('     那段时间里 SSE 的数据到了也没人读，用户看到的是模型"卡住"。')
console.log('     异步写在 await 处让出，定时器和 socket 照常被处理。')
console.log('\n  注意攒批那版还多做了 fsync（每批一次），它更慢但更安全——')
console.log('  这正是 6.3 的取舍：批处理省下的次数，拿去买 fsync 的保证。')
