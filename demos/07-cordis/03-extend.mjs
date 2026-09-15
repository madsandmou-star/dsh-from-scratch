// 7.2 子 context 的三个性质：看得见、遮得住、改不到；以及"继承是活的"。
//   node --import tsx demos/07-cordis/03-extend.mjs

const { Context } = await import('../../src/cordis.ts')

const root = new Context()
root.logger = msg => console.log(`    [日志] ${msg}`)
root.config = { model: 'deepseek-chat', readOnly: false }

console.log('=== ① 看得见：子没有 logger，但用得了 ===')
root.plugin(function child(ctx) {
  ctx.logger('我自己没有 logger，这是从父那里继承来的')
  console.log(`    ctx.config.model = ${ctx.config.model}`)
  console.log(`    自有属性：${JSON.stringify(ctx.ownKeys())}   ← 空的，全是继承来的`)
})

console.log('\n=== ② 遮得住：子给自己定义一个同名的，父不受影响 ===')
root.plugin(function shadowing(ctx) {
  ctx.logger = msg => console.log(`    [子的日志] ${msg}`)
  ctx.logger('我用的是自己的')
  console.log(`    自有属性：${JSON.stringify(ctx.ownKeys())}`)
})
root.logger('父的 logger 还是原来那个')

console.log('\n=== ③ 改不到：子改自己的，父看不见 ===')
root.plugin(function isolated(ctx) {
  ctx.config = { ...ctx.config, readOnly: true }    // 换一个新对象
  console.log(`    子看到的 readOnly = ${ctx.config.readOnly}`)
})
console.log(`  父看到的 readOnly = ${root.config.readOnly}   ← 没被改`)

console.log('\n=== ④ 但"改不到"只对**重新赋值**成立 ===')
root.plugin(function mutating(ctx) {
  ctx.config.readOnly = true      // 没有重新赋值，是改那个共享对象里的字段
})
console.log(`  父看到的 readOnly = ${root.config.readOnly}   ← 被改了！`)
console.log('  继承共享的是**引用**，不是副本。子改不了"ctx.config 指向谁"，')
console.log('  但它照样能改那个对象里面的东西。真正的隔离要靠只读数据或者服务（阶段 8）。')
root.config = { model: 'deepseek-chat', readOnly: false }   // 复位

console.log('\n=== ⑤ 继承是活的：父后来加的东西，子立刻看得见 ===')
let captured
root.plugin(function early(ctx) {
  captured = ctx                                   // 这个插件先装
  console.log(`    装载时 ctx.tools = ${ctx.tools}`)
})
root.tools = ['read', 'write']                     // 父后来才加
console.log(`  之后 captured.tools = ${JSON.stringify(captured.tools)}   ← 看得见`)
console.log('  如果 extend 是"复制父的属性"，这里就会是 undefined。')
console.log('  插件是陆续装上去的，所以这个差别是决定性的。')

console.log('\n=== ⑥ 踩坑演示：可变对象不能靠继承共享 ===')
const bad = new Context()
// 模拟"忘了给子一个自己的 children 数组"
const fake = Object.create(bad)
fake.name = 'fake'
fake.children.push('这一条推进了父的数组')
console.log(`  父的 children 长度 = ${bad.children.length}   ← 子的 push 打到父身上了`)
console.log('  这就是 plugin() 里为什么要显式 `children: []`——不给的话，')
console.log('  所有插件都会挂进同一个数组，整棵树塌成一层。')
