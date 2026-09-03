// 5.3 动态上下文走 user 消息，不进 system prompt：位置、去重、取代语义。
//   node demos/05-system-prompt/05-runtime-context.mjs

import { runSession, cleanup } from '../harness.mjs'

const requests = []
const workdir = await runSession({
  files: { 'a.txt': 'hello\n', 'b.txt': 'world\n' },
  script: [
    { name: 'read', args: { path: 'a.txt' } },
    { name: 'read', args: { path: 'b.txt' } },
  ],
  finalAnswer: '两个文件都读完了。',
  input: '读一下 a.txt 和 b.txt',
  onRequest: messages => requests.push(messages),
})
await cleanup(workdir)

console.log(`\n=== 这个 turn 一共发了 ${requests.length} 次请求 ===`)
for (const [index, messages] of requests.entries()) {
  console.log(`\n── 第 ${index + 1} 次请求的 messages（${messages.length} 条）──`)
  for (const m of messages) {
    const summary = String(m.content ?? '(null)').replace(/\n/g, ' ⏎ ').slice(0, 72)
    console.log(`  ${m.role.padEnd(9)} ${summary}`)
  }
}

console.log('\n看三件事：')
console.log('  ① 时间快照是一条 user 消息，**排在这一步的最后**，不是最前面。')
console.log('  ② system 那条从头到尾没变过——缓存前缀是稳定的。')
console.log('  ③ 每个 step 都重算了快照；时间变了就发新的，开头写着"取代之前的快照"。')
