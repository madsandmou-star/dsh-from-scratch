// 8.2 inject：声明依赖，顺序由依赖算出来。
//   node --import tsx demos/08-services/03-inject.mjs

const { Context } = await import('../../src/cordis.ts')

const order = []
const configPlugin = { name: 'config', apply(ctx) { order.push('config'); ctx.provide('config', { readOnly: true }) } }
const guardsPlugin = { name: 'guards', inject: ['config'], apply(ctx) { order.push('guards'); ctx.provide('guards', ctx.config.readOnly ? ['ro'] : []) } }
const loopPlugin = { name: 'loop', inject: ['guards', 'session'], apply(ctx) { order.push('loop') } }
const sessionPlugin = { name: 'session', apply(ctx) { order.push('session'); ctx.provide('session', { events: [] }) } }

console.log('=== ① 故意按**最坏**的顺序装：使用者全排在提供者前面 ===')
const root = new Context()
root.plugin(loopPlugin)        // 依赖 guards、session —— 两个都还没有
root.plugin(guardsPlugin)      // 依赖 config —— 还没有
root.plugin(sessionPlugin)     // 提供 session
root.plugin(configPlugin)      // 提供 config
console.log(`  实际装载顺序：${order.join(' → ')}`)
console.log('  写下的顺序：loop → guards → session → config')
console.log('  **装载顺序由依赖算出来，和书写顺序无关。**')

console.log('\n=== ② 装配树：谁装的谁，还是那个规则 ===')
console.log(root.inspect())
console.log('  注意 guards 和 loop 都挂在 root 下——它们是被 provide 唤醒后才装的，')
console.log('  但"当初在哪调的 plugin()"决定父节点是谁，跟什么时候装无关。')

console.log('\n=== ③ 依赖永远不来会怎样：挂着，不报错 ===')
const r2 = new Context()
r2.plugin({ name: 'needsLlm', inject: ['llm', 'config'], apply() { console.log('  我永远跑不到') } })
r2.plugin(configPlugin)
console.log('  还挂着的插件：')
for (const { name, waitingFor } of r2.pendingPlugins()) {
  console.log(`    ${name}  还在等：${waitingFor.join('、')}`)
}
console.log('\n  它不报错——因为"等一个还没装的服务"是**合法**的：')
console.log('  那个提供者可能在清单更后面，也可能要等用户做完某个操作才装。')
console.log('  但装配结束后这个列表应该是空的。**不空 = 有依赖没人提供**，多半是名字写错了。')

console.log('\n=== ④ 循环依赖：两个都挂着，谁也不动 ===')
const r3 = new Context()
r3.plugin({ name: 'A', inject: ['b'], apply(ctx) { ctx.provide('a', 1) } })
r3.plugin({ name: 'B', inject: ['a'], apply(ctx) { ctx.provide('b', 1) } })
for (const { name, waitingFor } of r3.pendingPlugins()) console.log(`    ${name}  还在等：${waitingFor.join('、')}`)
console.log('  和 ③ 长得一样——**循环依赖在这个机制里就是"永远等不到"**。')
console.log('  这不是缺陷：一个装载器分不清"你依赖的东西还没装"和"你俩互相依赖"，')
console.log('  它只能如实报告谁在等谁，让人去看。诊断清单在这里就是全部答案。')
