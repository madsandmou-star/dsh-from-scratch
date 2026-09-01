// 5.3 动态上下文走 user 消息，不进 system prompt：位置、去重、取代语义。
//   node demos/05-system-prompt/05-runtime-context.mjs

import { 跑一次会话, 清理 } from '../harness.mjs'

const 每次请求 = []
const 工作目录 = await 跑一次会话({
  文件: { 'a.txt': 'hello\n', 'b.txt': 'world\n' },
  剧本: [
    { name: 'read', args: { path: 'a.txt' } },
    { name: 'read', args: { path: 'b.txt' } },
  ],
  最终回答: '两个文件都读完了。',
  输入: '读一下 a.txt 和 b.txt',
  看见每次请求: 消息们 => 每次请求.push(消息们),
})
await 清理(工作目录)

console.log(`\n=== 这个 turn 一共发了 ${每次请求.length} 次请求 ===`)
for (const [下标, 消息们] of 每次请求.entries()) {
  console.log(`\n── 第 ${下标 + 1} 次请求的 messages（${消息们.length} 条）──`)
  for (const m of 消息们) {
    const 摘要 = String(m.content ?? '(null)').replace(/\n/g, ' ⏎ ').slice(0, 72)
    console.log(`  ${m.role.padEnd(9)} ${摘要}`)
  }
}

console.log('\n看三件事：')
console.log('  ① 时间快照是一条 user 消息，**排在这一步的最后**，不是最前面。')
console.log('  ② system 那条从头到尾没变过——缓存前缀是稳定的。')
console.log('  ③ 每个 step 都重算了快照；时间变了就发新的，开头写着"取代之前的快照"。')
