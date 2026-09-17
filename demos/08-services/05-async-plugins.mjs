// 8.3 异步插件：装载过程中可以做 I/O，依赖它的插件老老实实等着。
//   node --import tsx demos/08-services/05-async-plugins.mjs

const { Context } = await import('../../src/cordis.ts')

const log = []
const at = () => `${String(Date.now() - t0).padStart(3)}ms`
let t0 = Date.now()

/** 模拟一次 I/O。 */
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

console.log('=== ① 依赖一个异步插件：等它跑完才装 ===')
const root = new Context()
root.plugin({
  name: 'slowConfig',
  async apply(ctx) {
    log.push(`${at()} slowConfig 开始读文件…`)
    await sleep(50)
    ctx.provide('config', { model: 'deepseek-chat' })
    log.push(`${at()} slowConfig 提供了 config`)
  },
})
root.plugin({
  name: 'consumer',
  inject: ['config'],
  apply(ctx) { log.push(`${at()} consumer 装上了，读到 ${ctx.config.model}`) },
})

log.push(`${at()} 两次 plugin() 都返回了`)
console.log(`  此刻 consumer 装了吗？ ${root.pendingPlugins().length === 0 ? '装了' : '还挂着'}`)

await root.ready()
for (const line of log) console.log(`  ${line}`)
console.log('\n  两处值得看：')
console.log('  ① **两次 plugin() 立刻就返回了**，但那时 consumer 还挂着。')
console.log('     "调用返回"和"装配完成"从此是两件事——所以需要一个显式的汇合点 ready()。')
console.log('  ② consumer 那行**排在 slowConfig 最后一行前面**，不是打错了：')
console.log('     provide() 是同步唤醒的——它那一行返回之前，等它的插件已经装完了。')

console.log('\n=== ② 三个异步插件互相依赖，ready() 要等好几轮 ===')
t0 = Date.now()
log.length = 0
const r2 = new Context()
const slow = (name, needs, provides, ms) => ({
  name, inject: needs,
  async apply(ctx) {
    log.push(`${at()} ${name} 开始`)
    await sleep(ms)
    ctx.provide(provides, name)
    log.push(`${at()} ${name} 提供了 ${provides}`)
  },
})
r2.plugin(slow('C', ['b'], 'c', 30))     // 故意倒着写
r2.plugin(slow('B', ['a'], 'b', 30))
r2.plugin(slow('A', [], 'a', 30))
await r2.ready()
for (const line of log) console.log(`  ${line}`)
console.log('\n  三轮串起来了：A 跑完 → 唤醒 B → B 跑完 → 唤醒 C。')
console.log('  ready() 里那个 for(;;) 就是为这个存在的：**等一批 promise 的过程中')
console.log('  会冒出新的 promise，一轮等不干净。**')

console.log('\n=== ③ 装配失败还是当场炸，只是出口变成了 ready() ===')
const r3 = new Context()
r3.plugin({ name: 'boom', async apply() { await sleep(10); throw new Error('这个插件在 I/O 之后炸了') } })
try {
  await r3.ready()
} catch (error) {
  console.log(`  ${error.message}`)
}
console.log('  用的是 Promise.all 不是 allSettled：装配失败要当场炸，')
console.log('  不要"记下来最后一起报"——第一个错之后的一切都已经不可信了。')
