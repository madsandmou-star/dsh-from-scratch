// 7.2 debug 手法：看"每一层各自贡献了什么"；以及继承为什么只够用一半。
//   node --import tsx demos/07-cordis/04-who-added-what.mjs

const { Context } = await import('../../src/cordis.ts')

/** 把一棵插件树连同每层的自有属性一起打出来。 */
function dump(ctx, indent = '') {
  const own = ctx.ownKeys()
  console.log(`${indent}${ctx.name}${own.length === 0 ? '' : `   + ${own.join(', ')}`}`)
  for (const child of ctx.children) dump(child, `${indent}  `)
}

console.log('=== ① 每个插件在自己的 ctx 上写东西 ===')
const root = new Context()
root.plugin(function assembly(ctx) {
  ctx.plugin(function configPlugin(c) { c.config = { model: 'deepseek-chat', readOnly: false } })
  ctx.plugin(function toolsPlugin(c) { c.tools = ['read', 'write', 'bash'] })
  ctx.plugin(function loggerPlugin(c) { c.logger = () => {} })
})
dump(root)

console.log('\n=== ② 兄弟之间互相看不见 ===')
try {
  root.plugin(function assembly2(ctx) {
    ctx.plugin(function configPlugin(c) { c.config = { readOnly: true } })
    ctx.plugin(function guardsPlugin(c) {
      c.guards = c.config.readOnly ? ['readOnly'] : []   // ← 想读兄弟写的东西
    })
  })
} catch (error) {
  console.log(`  ${error.constructor.name}: ${error.message}`)
}
console.log('  configPlugin 写的是**它自己的** ctx；guardsPlugin 读的是**它自己的** ctx。')
console.log('  两个 ctx 是兄弟，继承只朝一个方向走：**子看得见父，父看不见子，兄弟互不相见。**')

console.log('\n=== ③ 唯一现在能用的办法：父先写好，再装子 ===')
const root3 = new Context()
root3.plugin(function assembly3(ctx) {
  ctx.config = { readOnly: true }                         // 父自己写
  ctx.plugin(function guardsPlugin(c) {
    c.guards = c.config.readOnly ? ['readOnly'] : []      // 子继承得到
    console.log(`    guards = ${JSON.stringify(c.guards)}`)
  })
})
dump(root3)

console.log('\n  它能跑，但代价是回到了 7.1 那个痛点：')
console.log('  **assembly3 必须亲自知道 config 长什么样、必须在装 guards 之前写好它。**')
console.log('  装配顺序又变成了手写的，"谁依赖谁"这件事仍然只存在于作者脑子里。')

console.log('\n=== 这一课的结论 ===')
console.log('  继承解决了"子怎么用到父的东西"，没解决"插件之间怎么互相用"。')
console.log('  阶段 8 的服务就是来补这一半的：写在 ctx.<名字> 上的东西对**整棵树**可见，')
console.log('  依赖用 inject 声明，装载顺序由依赖算出来，而不是由书写位置决定。')
