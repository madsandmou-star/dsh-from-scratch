// 7.1 插件与插件树：三种形态、树长什么样、装配失败会怎样。
//   node --import tsx demos/07-cordis/01-first-plugin.mjs

const { Context } = await import('../../src/cordis.ts')

const root = new Context()

// ── 形态一：函数插件（最常见）──
function hello(ctx) {
  console.log('  hello 说：我被装上了')
}

// ── 形态二：对象插件，带自己的 name ──
const greeter = {
  name: 'greeter',
  apply(ctx, config) {
    console.log(`  greeter 说：我的配置是 ${JSON.stringify(config)}`)
    // 插件可以装子插件——树就是这么长出来的
    ctx.plugin(hello)
  },
}

// ── 一个插件可以装好几个，也可以按配置决定装不装 ──
function assembly(ctx, config) {
  console.log('  assembly 说：我来组装')
  ctx.plugin(greeter, { tone: 'friendly' })
  if (config.verbose) ctx.plugin(function noisy(c) { console.log('  noisy 说：只有 verbose 时才有我') })
}

console.log('=== 装载顺序（apply 是同步调用的）===')
root.plugin(assembly, { verbose: true })
root.plugin(hello)

console.log('\n=== 插件树 ===')
console.log(root.inspect())

console.log('\n=== 装配失败当场炸，不是"这一项被跳过了" ===')
try {
  root.plugin(function broken() { throw new Error('这个插件自己炸了') })
} catch (error) {
  console.log(`  捕获：${error.message}`)
}
try {
  root.plugin({ name: '没有 apply 的东西' })
} catch (error) {
  console.log(`  捕获：${error.message}`)
}

console.log('\n看三件事：')
console.log('  ① 插件只是一个 apply 函数——没有基类、没有注解、没有注册表。')
console.log('  ② 树是**装出来的**，不是声明的：谁在自己的 apply 里装了谁，谁就是谁的子节点。')
console.log('  ③ 装配失败会当场抛。启动期的错误必须吵，"跳过这一项"会让你在半夜排查')
console.log('     "为什么这个功能没生效"——而那时早就没有现场了。')
