// 7.3 重构之后：两个入口共用一份插件清单，装配树能打出来。
//   node --import tsx demos/07-cordis/05-assembled.mjs
//
// 注意：7.3 当时这棵树是**一路往右缩进**的（靠嵌套让后面的插件看见前面的）。
// 8.1 引入服务之后它变平了，所以下面打出来的是平树。
// 体量那几个数字不受影响——那才是这一课要量的东西。

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// 真的跑一遍装配，所以需要一份配置。用临时的，不碰你本地那份。
const dir = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
const configPath = join(dir, 'config.json')
writeFileSync(configPath, JSON.stringify({
  baseURL: 'http://127.0.0.1:1/v1', model: 'mock',
  apiKeyEnv: 'DSH_DEMO_KEY', systemPrompt: '你是一个助手。',
}), 'utf8')
process.env['DSH_LEARN_CONFIG'] = configPath
process.env['DSH_DEMO_KEY'] = 'demo-key-not-real'
process.chdir(dir)      // 会话日志写进临时目录

const { Context } = await import('../../src/cordis.ts')
const { assemble } = await import('../../src/plugins.ts')

const root = new Context()
root.plugin(assemble(function cli(ctx) {
  console.log('=== 链条最后一环看得见什么 ===')
  for (const key of ['config', 'prompt', 'guards', 'session', 'sessionId', 'logPath', 'persistence']) {
    console.log(`  ctx.${key.padEnd(12)} ${ctx[key] === undefined ? '✗ 没有' : '✓'}`)
  }
  void ctx.dispose()
}))

/** 树 + 每层的自有属性。 */
function dump(ctx, indent = '') {
  const own = ctx.ownKeys()
  console.log(`${indent}${ctx.name}${own.length === 0 ? '' : `   + ${own.join(', ')}`}`)
  for (const child of ctx.children) dump(child, `${indent}  `)
}

console.log('\n=== 装配树（7.3 时是嵌套的；8.1 之后是平的）===')
dump(root)

/** 数一个文件里有多少行有效代码。 */
function loc(path) {
  return readFileSync(join(ROOT, path), 'utf8').split('\n')
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*')).length
}

console.log('\n=== 两个入口的体量：7.1 版 → 7.3 版 ===')
for (const [before, after] of [
  ['demos/07-cordis/fixtures/index.before.ts', 'src/index.ts'],
  ['demos/07-cordis/fixtures/headless.before.ts', 'src/headless.ts'],
]) {
  console.log(`  ${after.padEnd(18)} ${String(loc(before)).padStart(3)} 行 → ${String(loc(after)).padStart(3)} 行`)
}
console.log(`  src/plugins.ts     （新）  ${loc('src/plugins.ts')} 行  ← 装配搬到了这里，两个入口共用`)

console.log('\n=== 现在加一个功能要改几处 ===')
console.log('  加一道护栏          → 1 处（plugins.ts 的 guardsPlugin）')
console.log('  加一段 system prompt → 1 处（plugins.ts 的 promptPlugin）')
console.log('  改会话存放位置       → 1 处（plugins.ts 的 SESSION_ROOT）')
console.log('  7.1 时这三项各要改 2 处，再加一个入口就是 3 处。现在永远是 1 处。')

console.log('\n但这一版还不够好，两点：')
console.log('  ① corePlugins 的**顺序是手写的**——因为兄弟插件互相看不见（7.2），')
console.log('     只能靠嵌套让后面的读到前面的。阶段 8 的 inject 会让顺序无所谓。')
console.log('  ② 主循环还在入口文件里，它直接读 ctx.session / ctx.persistence。')
console.log('     阶段 13 会把 loop 也变成一个服务，入口只剩"装哪些插件"。')
