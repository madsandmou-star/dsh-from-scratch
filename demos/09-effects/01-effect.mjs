// 9.1 ctx.effect：申请和归还绑成一个动作。
//   node --import tsx demos/09-effects/01-effect.mjs

const { Context, Service } = await import('../../src/cordis.ts')

console.log('=== ① 不用 effect：自己记账 ===')
function manual(ctx) {
  const undo = []                                  // 每个插件都得自己维护一个
  const timer = setInterval(() => {}, 1000)
  undo.push(() => { clearInterval(timer) })
  undo.push(() => console.log('    manual：撤销注册 B'))
  undo.push(() => console.log('    manual：撤销注册 C'))
  // 还得自己暴露一个收尾入口——而且不能写在自己的 ctx 上（7.2：父看不见子），
  // 得 provide 出去才有人调得到。**光是"让别人能收我"就已经是一道题了。**
  ctx.provide('cleanup', async () => {
    for (const fn of undo.reverse()) await fn()    // 顺序自己管，重复调用自己防
  })
}
const r1 = new Context()
r1.plugin(manual)
await r1.cleanup()
console.log('  能用，但这段账本是**每个插件都要抄一遍**的样板：')
console.log('  数组、顺序、幂等、还要自己暴露一个 cleanup 让别人调。')

console.log('\n=== ② 用 effect：申请和归还写在同一个表达式里 ===')
const r2 = new Context()
r2.plugin(function auto(ctx) {
  ctx.effect(() => {
    const timer = setInterval(() => {}, 1000)
    return () => { clearInterval(timer); console.log('    auto：定时器清掉了') }
  })
  ctx.effect(() => () => console.log('    auto：撤销注册 B'))
  ctx.effect(() => () => console.log('    auto：撤销注册 C'))
})
console.log('  收掉：')
await r2.dispose()
console.log('  没有数组、没有 cleanup 入口、顺序和幂等都归机制管。')

console.log('\n=== ③ 逆序：后注册的先收 ===')
console.log('  上面 C → B → 定时器，正是注册顺序的倒过来。')
console.log('  理由和 finally 里关资源一样：**后来的可能用着先来的**。')

console.log('\n=== ④ 幂等：手动收过一次，插件卸载时不会再收一次 ===')
const r4 = new Context()
r4.plugin(function once(ctx) {
  const undo = ctx.effect(() => () => console.log('    once：我只会被打印一次'))
  void undo()          // 手动先收
})
await r4.dispose()     // 再收一次整棵树
console.log('  不挡住的话，clearInterval 无所谓，而"关一个已经关了的句柄"会抛。')

console.log('\n=== ⑤ 服务的收尾也是一个 effect，不用任何人记得调 ===')
class Db extends Service {
  constructor(ctx) { super(ctx, 'db'); console.log('    Db：连上了') }
  dispose() { console.log('    Db：断开了') }
}
const r5 = new Context()
r5.plugin(Db)
await r5.dispose()
console.log('  8.4 那版要 Context.dispose() 专门去遍历服务；现在服务和别的注册')
console.log('  走的是**同一条回收路径**——收尾不再是服务的特权。')
