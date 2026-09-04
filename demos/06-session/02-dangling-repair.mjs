// 6.1 悬空的工具调用：不回滚，投影时补齐。
//   node --import tsx demos/06-session/02-dangling-repair.mjs
//
// 三条日志，只差在"中断发生在哪一步"。同一个 deriveMessages() 投影它们，
// 看补出来的那条 tool 消息说了什么——以及 1.4 的回滚会删掉哪几条。

const { Session, deriveMessages } = await import('../../src/session.ts')

/**
 * 按 runTurn() 的真实顺序造一条日志，在指定位置停下。
 * @param {'complete' | 'after-call' | 'before-call'} stopAt - 中断发生在哪。
 * @returns {import('../../src/session.ts').Session}
 */
function logInterruptedAt(stopAt) {
  const session = new Session()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', { text: '把 a.txt 抄到 b.txt' })
  session.append('assistant/message', {
    turn: 1, step: 1, text: null,
    toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' }],
  })
  if (stopAt === 'before-call') return session      // 进程死在"记下开始"之前
  session.append('tool/call', { callId: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' })
  if (stopAt === 'after-call') return session       // 进程死在工具跑到一半
  session.append('tool/result', { callId: 'call_1', content: '   1: hello' })
  return session
}

for (const stopAt of ['complete', 'after-call', 'before-call']) {
  const session = logInterruptedAt(stopAt)
  const messages = deriveMessages(session.events, '(system prompt)')
  console.log(`\n=== 中断于 ${stopAt} —— 日志 ${session.events.length} 条，投影出 ${messages.length} 条 ===`)
  for (const m of messages) {
    console.log(`  ${m.role.padEnd(9)} ${String(m.content ?? '(null)').slice(0, 70)}`)
  }
}

console.log('\n三条日志投影出来的 messages 都是**合法**的：')
console.log('  每一个 tool_calls 都有配对的 tool 结果，供应商不会 400。')
console.log('  差别只在补出来的那句话——它告诉模型这次调用到底走到了哪一步：')
console.log('    TOOL_OUTCOME_UNKNOWN  开始执行了，可能已经改了磁盘，别假设它没跑。')
console.log('    TOOL_NOT_STARTED      没执行，重试是安全的。')
console.log('\n对比 1.4 的回滚：它会把 assistant 那条连同 tool_calls 一起 pop 掉，')
console.log('于是"模型要求过读 a.txt"这件事**从历史上消失**——用户在屏幕上见过，')
console.log('日志里却没有。日志只增不改，这个矛盾就不存在了。')
