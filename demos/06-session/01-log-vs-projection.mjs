// 6.1 日志是权威，messages 是投影：同一次会话，两栏并排看。
//   node --import tsx demos/06-session/01-log-vs-projection.mjs
//
// 这个演示不自己造数据：它跑一次**真实的**会话（假模型服务器 + 真工具），
// 然后打开 src/index.ts 里的 DSH_DUMP_LOG 开关，让程序自己把两栏打出来。

import { runSession, cleanup } from '../harness.mjs'

process.env['DSH_DUMP_LOG'] = '1'

const workdir = await runSession({
  files: { 'a.txt': 'hello\n' },
  script: [
    { name: 'read', args: { path: 'a.txt' } },
    { name: 'write', args: { path: 'b.txt', content: 'hello again\n' } },
  ],
  finalAnswer: '读完 a.txt，写好了 b.txt。',
  input: '把 a.txt 的内容抄一份到 b.txt',
})
await cleanup(workdir)

console.log('\n看四件事：')
console.log('  ① 日志比 messages 长：turn/start 和 tool/call 只进日志，不进请求。')
console.log('  ② 但它们必须进日志——没有 tool/call，就分不清"从没开始"和"开始了没结果"。')
console.log('  ③ system 那条不在日志里：它是每次组装出来的（5.1），不是"发生过的事"。')
console.log('  ④ 时间快照在日志里叫 context/snapshot，投影成 user——')
console.log('     wire 上的 role 是投影规则的一部分，不是事件本身的属性。')
