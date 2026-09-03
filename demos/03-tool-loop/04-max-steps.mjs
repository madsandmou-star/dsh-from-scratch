// 3.4 最大步数兜底：模型陷在自己看不出来的循环里时，谁来喊停。
//   node demos/03-tool-loop/04-max-steps.mjs

import { runSession, cleanup } from '../harness.mjs'

// 剧本足够长，超过 index.ts 里的 MAX_STEPS（10）——模型"永远"在读文件，从不给最终回答。
const script = Array.from({ length: 20 }, (_, i) => ({
  name: 'read',
  args: { path: i % 2 === 0 ? 'a.txt' : 'b.txt' },
}))

const workdir = await runSession({
  files: { 'a.txt': '看 b.txt\n', 'b.txt': '看 a.txt\n' },
  script,
  finalAnswer: '（这句话永远轮不到）',
  input: '这两个文件在说什么',
})
await cleanup(workdir)

console.log('\n模型读 a 发现要读 b，读 b 发现要读 a——它自己看不出来这是个环。')
console.log('MAX_STEPS 是这个 turn 唯一的出口：没有它，agent 会一直烧钱直到你按 Ctrl-C。')
console.log('注意它是**兜底**不是解决方案——真正的诊断要看上面那串重复的调用。')
