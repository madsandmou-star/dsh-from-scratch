// 6.4 崩溃残骸：末尾半行能修，中间坏了必须拒绝。
//   node --import tsx demos/06-session/07-torn-tail.mjs

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runSession, cleanup } from '../harness.mjs'

const { loadSession, repairLog, SessionLogCorruptionError } = await import('../../src/persistence.ts')

// 先正常跑一次，攒出一条真实的日志。
const workdir = await runSession({
  files: { 'a.txt': 'hello\n' },
  script: [{ name: 'read', args: { path: 'a.txt' } }],
  finalAnswer: '读完了。',
  input: '读一下 a.txt',
})
const root = join(workdir, '.dsh-learn', 'sessions')
const path = join(root, readdirSync(root)[0])
const good = readFileSync(path)
console.log(`\n原始日志：${good.length} 字节，${good.toString('utf8').split('\n').filter(Boolean).length} 行`)

/**
 * 把日志改成某种坏样子，然后试着读回来。
 * @param {string} label - 这次要制造哪种坏。
 * @param {Buffer} bytes - 改造后的文件内容。
 */
function tryLoad(label, bytes) {
  writeFileSync(path, bytes)
  console.log(`\n=== ${label}（${bytes.length} 字节）===`)
  try {
    const loaded = loadSession(path)
    console.log(`  读回 ${loaded.events.length} 条事件；可追加偏移 ${loaded.committedBytes}；丢弃残骸 ${loaded.tornBytes} 字节`)
    return loaded
  } catch (error) {
    console.log(`  ${error.constructor.name}`)
    console.log(`  ${String(error.message).split('\n')[0]}`)
    return undefined
  }
}

// ① 被杀在写最后一行的中间：末尾少了换行符。
const torn = good.subarray(0, good.length - 40)
const loaded = tryLoad('末尾半行（进程被强杀）', torn)

// 修好它，再看一次。
if (loaded !== undefined && loaded.tornBytes > 0) {
  await repairLog(path, loaded.committedBytes)
  console.log(`  修复后文件 ${statSync(path).size} 字节——半行没了，可以安全追加`)
  const again = loadSession(path)
  console.log(`  再读一次：${again.events.length} 条事件，残骸 ${again.tornBytes} 字节`)
}

// ② 中间某一行被改坏了，但换行符还在。
const lines = good.toString('utf8').split('\n').filter(Boolean)
const broken = [...lines]
broken[3] = broken[3].slice(0, 30) + '☠'
tryLoad('中间一行损坏（有换行符）', Buffer.from(broken.join('\n') + '\n', 'utf8'))

// ③ 中间少了一条：seq 出现空洞。
const missing = lines.filter((_, i) => i !== 3)
tryLoad('中间少一条（seq 空洞）', Buffer.from(missing.join('\n') + '\n', 'utf8'))

await cleanup(workdir)

console.log('\n判据只有一条：**这种坏，是不是崩溃必然产生的那一种？**')
console.log('  末行没写完 —— 是。写入不是原子的，被杀在中途一定长这样，所以必须能修。')
console.log('  完整的行读不动 / seq 有空洞 —— 不是。崩溃不会产生它们，')
console.log('  所以那是别的事故（手工编辑、磁盘错误、拼错了两个文件），拒绝。')
console.log('\n注意全程按**字节**处理：进程可能死在一个 UTF-8 多字节字符中间，')
console.log('按字符串读会把那几个字节变成替换字符，算出来的截断偏移就是错的。')
