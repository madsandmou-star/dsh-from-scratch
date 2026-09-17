// 8.1 服务：写在整棵树共用的一张表上，兄弟从此看得见。
//   node --import tsx demos/08-services/01-provide.mjs

const { Context } = await import('../../src/cordis.ts')

console.log('=== ① 7.2 的那个 TypeError，现在不复现了 ===')
const root = new Context()
root.plugin(function assembly(ctx) {
  ctx.plugin(function configPlugin(c) { c.provide('config', { readOnly: true }) })
  ctx.plugin(function guardsPlugin(c) {
    c.provide('guards', c.config.readOnly ? ['readOnly'] : [])   // ← 读兄弟提供的服务
    console.log(`    guardsPlugin 读到 config.readOnly = ${c.config.readOnly}`)
  })
})
console.log(`  根也读得到：root.config = ${JSON.stringify(root.config)}`)
console.log(`  已提供的服务：${root.listServices().join('、')}`)

console.log('\n=== ② 树是平的了（不用再靠嵌套让后面看见前面）===')
console.log(root.inspect())

console.log('\n=== ③ 服务对**整棵树**可见，不只是后代 ===')
const r2 = new Context()
let earlyCtx
r2.plugin(function early(ctx) { earlyCtx = ctx })      // 先装
r2.plugin(function late(ctx) { ctx.provide('tools', ['read', 'write']) })  // 后装
console.log(`  先装的那个插件读到：${JSON.stringify(earlyCtx.tools)}`)
console.log('  它在 tools 被提供之前就装好了，但现在读得到——访问器是活的。')
console.log('  （注意：这不等于它在自己的 apply 里就能读到。那是顺序问题，8.2 解决。）')

console.log('\n=== ④ 重名是装配错误，不是"后者覆盖前者" ===')
try {
  r2.plugin(function another(ctx) { ctx.provide('tools', ['别的实现']) })
} catch (error) {
  console.log(`  ${error.message}`)
}
console.log('  静默覆盖会让"到底哪个实现在生效"变成一道考古题。')
console.log('  想换实现要走另一条路——dsh 的 isolate()，阶段 14 讲。')

console.log('\n=== ⑤ 但顺序还没解放 ===')
const r3 = new Context()
try {
  r3.plugin(function consumer(ctx) { console.log(ctx.config.readOnly) })  // 提供者还没装
} catch (error) {
  console.log(`  ${error.constructor.name}: ${error.message}`)
}
console.log('  可见性解决了，时序没有：装载是同步的，提供者必须先跑完。')
console.log('  8.2 的 inject 会让这一条也消失——依赖没就绪就推迟这个插件。')
