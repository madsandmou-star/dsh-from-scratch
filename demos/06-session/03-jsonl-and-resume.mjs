// 6.2 落盘与续聊：先聊一轮写出 JSONL，再 --resume 接着聊，最后看文件长什么样。
//   node --import tsx demos/06-session/03-jsonl-and-resume.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runSession, cleanup } from '../harness.mjs'

// 第一次会话：让模型读一个文件，然后回答。
const workdir = await runSession({
  files: { 'note.txt': '会议改到周四下午三点\n' },
  script: [{ name: 'read', args: { path: 'note.txt' } }],
  finalAnswer: '看到了，note.txt 里写着一句话。',
  input: 'note.txt 里写了什么',
})

const root = join(workdir, '.dsh-learn', 'sessions')
const [file] = readdirSync(root)
const path = join(root, file)
const lines = readFileSync(path, 'utf8').split('\n').filter(l => l !== '')

console.log(`\n=== 磁盘上的 ${file}（${lines.length} 行）===`)
for (const [index, line] of lines.entries()) {
  const record = JSON.parse(line)
  const label = record.type === 'session' ? '(会话头)' : `seq ${record.seq}`
  console.log(`  第 ${String(index + 1).padStart(2)} 行  ${label.padEnd(9)} ${line.slice(0, 96)}${line.length > 96 ? ' …' : ''}`)
}

// 第二次会话：--resume 续上同一个工作目录里最近的那次。
// 模型这次不用再读文件——历史里已经有那条 tool 结果了。
console.log('\n=== 续聊（--resume）：模型收到的 messages ===')
const requests = []
await runSession({
  workdir,
  script: [],
  finalAnswer: '刚才那句话是 “会议改到周四下午三点”。',
  input: '再说一遍刚才看到的那句话',
  extraArgs: ['--resume'],
  onRequest: messages => requests.push(messages),
})
for (const m of requests[0] ?? []) {
  console.log(`  ${m.role.padEnd(9)} ${String(m.content ?? '(null)').replace(/\n/g, ' ⏎ ').slice(0, 70)}`)
}

const after = readFileSync(path, 'utf8').split('\n').filter(l => l !== '')
console.log(`\n同一个文件，从 ${lines.length} 行长到了 ${after.length} 行——续聊是**往后追加**，不是新开一个。`)
await cleanup(workdir)

console.log('\n看四件事：')
console.log('  ① 第 1 行是会话头（type: "session"），带格式版本、id、cwd。')
console.log('  ② 之后一行一条事件，seq 就是它的行号减 2——顺序由文件本身保证。')
console.log('  ③ 续聊时第一次请求里就有上一轮的全部历史：日志读回来 → 投影 → 发出去。')
console.log('  ④ 模型没有再调 read：那条 tool 结果在历史里，它直接答了。')
