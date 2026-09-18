// 8.4 Service 类：注册、命名、持有 ctx、收尾，绑在一个构造函数里。
//   node --import tsx demos/08-services/06-service-class.mjs

const { Context, Service } = await import('../../src/cordis.ts')

console.log('=== ① 类插件：ctx.plugin(类) 会 new 它，构造函数自己 provide ===')
class Clock extends Service {
  constructor(ctx) {
    super(ctx, 'clock')          // ← 注册就发生在这一行
    this.started = Date.now()
  }
  now() { return `启动后 ${Date.now() - this.started}ms` }
}

const root = new Context()
root.plugin(Clock)               // 不用写 ctx.provide('clock', new Clock(ctx))
console.log(`  root.clock.name = ${root.clock.name}`)
console.log(`  root.clock.now() = ${root.clock.now()}`)
console.log(`  服务表：${root.listServices().join('、')}`)

console.log('\n=== ② 依赖声明写成静态字段 ===')
class Recorder extends Service {
  static inject = ['clock']
  constructor(ctx) {
    super(ctx, 'recorder')
    this.entries = [`装上时：${ctx.clock.now()}`]   // 服务自己拿得到 ctx
  }
  dispose() { console.log(`    Recorder.dispose：我记了 ${this.entries.length} 条`) }
}
root.plugin(Recorder)
console.log(`  recorder 装上了：${root.recorder.entries[0]}`)

console.log('\n=== ③ 收尾按注册的**逆序** ===')
class A extends Service { constructor(c) { super(c, 'a') } dispose() { console.log('    A.dispose') } }
class B extends Service { static inject = ['a']; constructor(c) { super(c, 'b') } dispose() { console.log('    B.dispose') } }
const r2 = new Context()
r2.plugin(A)
r2.plugin(B)
console.log(`  注册顺序：${r2.listServices().join(' → ')}`)
console.log('  dispose 顺序：')
await r2.dispose()
console.log('  逆序的理由和 finally 里关资源一样：**后注册的可能用着先注册的**。')

console.log('\n=== ④ 构造期间读自己，拿到的是半成品 ===')
class Trap extends Service {
  constructor(ctx) {
    super(ctx, 'trap')                                  // 这一行之后服务表里已经有 trap 了
    console.log(`    构造函数里读 ctx.trap.value = ${ctx.trap.value}`)
    this.value = 42
  }
}
const r3 = new Context()
r3.plugin(Trap)
console.log(`  构造完之后读 = ${r3.trap.value}`)
console.log('  provide 发生在 super() 里，那时子类的字段还没初始化。')
console.log('  dsh 有一个 Service.init 符号，专放"构造完之后再跑"的逻辑。')

console.log('\n=== ⑤ 类插件和函数插件是怎么分开的 ===')
console.log(`  typeof Clock            = ${typeof Clock}        ← 类在 JS 里就是函数`)
console.log(`  Clock.prototype instanceof Service = ${Clock.prototype instanceof Service}`)
console.log('  所以判据是原型链，不是 typeof。分不开的话，ctx.plugin(Clock) 会')
console.log('  把它当普通函数调用 —— 类不加 new 调用会直接抛 TypeError。')
await root.dispose()
