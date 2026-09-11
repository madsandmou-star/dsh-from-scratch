// 6.4 不认识的东西怎么办：跳过还是拒绝，以及格式版本什么时候必须拒绝。
//   node --import tsx demos/06-session/08-unknown-and-version.mjs

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { loadSession, SESSION_FORMAT_VERSION, KNOWN_EVENT_TYPES } = await import('../../src/persistence.ts')
const { deriveMessages } = await import('../../src/session.ts')

const dir = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
const path = join(dir, 'log.jsonl')

console.log(`这个 build 认识 ${KNOWN_EVENT_TYPES.size} 种事件：${[...KNOWN_EVENT_TYPES].join('、')}`)

/** 造一条日志：头 + 若干事件，每条自动编 seq。 */
function write(header, events) {
  const lines = [JSON.stringify(header), ...events.map((e, i) => JSON.stringify({ seq: i, time: 0, ...e }))]
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
}

const HEADER = { type: 'session', version: SESSION_FORMAT_VERSION, id: 'demo', createdAt: 0, cwd: dir }
const BASE = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { text: '你好' } },
]

/** 读一次并报告结果。 */
function tryLoad(label) {
  console.log(`\n=== ${label} ===`)
  try {
    const loaded = loadSession(path)
    const messages = deriveMessages(loaded.events, '(system)')
    console.log(`  读回 ${loaded.events.length} 条事件，投影出 ${messages.length} 条消息`)
    console.log(`  投影：${messages.map(m => m.role).join(' → ')}`)
  } catch (error) {
    console.log(`  ${error.constructor.name}`)
    for (const l of String(error.message).split('\n')) console.log(`  ${l}`)
  }
}

// ① 一条这个 build 不认识的事件，没标 ignorable
write(HEADER, [...BASE, { type: 'metrics/sample', data: { tokens: 1234 } }])
tryLoad('不认识的事件，没标 ignorable')

// ② 同一条，标了 ignorable: true
write(HEADER, [...BASE, { type: 'metrics/sample', ignorable: true, data: { tokens: 1234 } }])
tryLoad('同一条，标了 ignorable: true')

// ③ 格式版本比这个程序新
write({ ...HEADER, version: SESSION_FORMAT_VERSION + 1 }, BASE)
tryLoad(`格式版本是 ${SESSION_FORMAT_VERSION + 1}，程序只认 ${SESSION_FORMAT_VERSION}`)

console.log('\n两条规则，一个共同的理由：')
console.log('  **不写 ignorable 就是必需**，读到不认识的必需事件一律拒绝。')
console.log('  忘了标 → 过度拒绝，用户看到一句明确的错误，去换个版本打开。')
console.log('  反过来默认跳过 → 悄悄读出一段残缺的历史，模型基于它继续干活。')
console.log('\n  第一种是不方便，第二种是事故。**默认值要选在出错时代价小的那一边。**')
console.log('\n版本号只在**结构性**改动时才加：事件包装变形、会话头变形、核心语义变了。')
console.log('往事件表里加一个新类型**不加版本**——那是 ignorable 这个机制负责的事。')
