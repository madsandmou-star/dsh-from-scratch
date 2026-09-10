// 6.3 语义检查点：工具跑起来的那一刻，"我要开始跑了"这条事件已经在盘上了吗？
//   node --import tsx demos/06-session/06-checkpoints.mjs
//
// 手法：让模型调一个 bash 工具去数**自己这次调用**在日志文件里出现了几次。
// 工具的输出就是答案——它是在自己执行的那一刻观测到的，没法作假。

import { runSession, cleanup } from '../harness.mjs'

const COMMAND = 'grep -c \'"type":"tool/call"\' .dsh-learn/sessions/*.jsonl 2>/dev/null || echo 0'

/**
 * 跑一次会话，返回 bash 工具看到的那个数字。
 * @param {boolean} checkpoint - 是否启用检查点。
 * @returns {Promise<string>} 工具的输出。
 */
async function run(checkpoint) {
  const results = []
  if (!checkpoint) process.env['DSH_NO_CHECKPOINT'] = '1'
  else delete process.env['DSH_NO_CHECKPOINT']
  const workdir = await runSession({
    script: [{ name: 'bash', args: { command: COMMAND, description: '数数我自己这次调用落盘了没有' } }],
    finalAnswer: '数完了。',
    input: '数一下会话日志里有几条 tool/call',
    onToolResult: content => results.push(content),
  })
  await cleanup(workdir)
  return (results[0] ?? '').trim()
}

console.log('=== 有检查点（默认）===')
const withCheckpoint = await run(true)
console.log(`  工具看到的：${withCheckpoint.split('\n')[0]}`)

console.log('\n=== 关掉检查点（DSH_NO_CHECKPOINT=1）===')
const without = await run(false)
console.log(`  工具看到的：${without.split('\n')[0]}`)
delete process.env['DSH_NO_CHECKPOINT']

console.log('\n差别就是这一行代码：')
console.log('    session.append(\'tool/call\', …)')
console.log('    await checkpoint()          ← 有它，下面这行才敢跑')
console.log('    const result = await runTool(…)')
console.log('\n为什么值得为它等一次 fsync：')
console.log('  这个 bash 工具本可以是 `rm -rf build/`。进程如果死在它执行的中途，')
console.log('  日志里有没有那条 tool/call，决定了恢复时说哪句话：')
console.log('    有 → TOOL_OUTCOME_UNKNOWN：它跑过，磁盘可能已经变了，别当没发生。')
console.log('    没 → TOOL_NOT_STARTED：它没跑，重试是安全的。')
console.log('\n  6.1 写下的那条区分，到这里才真的成立——**没落盘的事件，恢复时等于没发生过**。')
