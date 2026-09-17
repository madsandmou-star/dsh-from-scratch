// 8.2 真实装配：把 corePlugins 随机打乱 20 次，结果完全一样。
//   node --import tsx demos/08-services/04-shuffled.mjs

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dsh-demo-'))
const configPath = join(dir, 'config.json')
writeFileSync(configPath, JSON.stringify({
  baseURL: 'http://127.0.0.1:1/v1', model: 'mock',
  apiKeyEnv: 'DSH_DEMO_KEY', systemPrompt: '你是一个助手。',
}), 'utf8')
process.env['DSH_LEARN_CONFIG'] = configPath
process.env['DSH_DEMO_KEY'] = 'demo-key-not-real'
process.chdir(dir)

const { Context } = await import('../../src/cordis.ts')
const { corePlugins } = await import('../../src/plugins.ts')

/** 用给定的顺序装一次，返回装出来的服务名（按 provide 顺序）。 */
function assembleWith(plugins) {
  const root = new Context()
  root.plugin({
    name: 'app',
    apply(ctx) {
      for (const plugin of plugins) ctx.plugin(plugin)
      ctx.plugin({ name: 'leaf', inject: ['persistence'], apply(c) { c.persistence.close() } })
    },
  })
  return { services: root.listServices(), pending: root.pendingPlugins(), tree: root.inspect() }
}

const baseline = assembleWith(corePlugins)
console.log('=== 按写下的顺序装 ===')
console.log(`  服务表：${baseline.services.join('、')}`)
console.log(`  还挂着的：${baseline.pending.length} 个`)

console.log('\n=== 随机打乱 20 次 ===')
let allSame = true
for (let i = 0; i < 20; i++) {
  const shuffled = [...corePlugins].sort(() => Math.random() - 0.5)
  const result = assembleWith(shuffled)
  // 比的是**集合**不是顺序：互不依赖的插件之间，先后本来就没有规定。
  const same = [...result.services].sort().join() === [...baseline.services].sort().join()
    && result.pending.length === 0
  if (!same) {
    allSame = false
    console.log(`  ✗ 第 ${i + 1} 次不一样：${shuffled.map(p => p.name).join(' → ')}`)
    console.log(`     服务表：${result.services.join('、')}；还挂着 ${result.pending.length} 个`)
  }
}
console.log(allSame ? '  20 次全部提供了**同一组服务**，一个插件都没挂住。' : '  有不一样的，见上。')
console.log('\n  注意比的是集合不是顺序：provide 的先后每次都可能不同，')
console.log('  因为**互不依赖的插件之间，先后本来就没有规定**。inject 保证的是')
console.log('  "该在前面的一定在前面"，不是"每次都一模一样"。')

console.log('\n=== 看一次打乱后的实际装载顺序 ===')
const worst = [...corePlugins].reverse()
console.log(`  写下的顺序：${worst.map(p => p.name).join(' → ')}`)
console.log(`  装出来的树：`)
console.log(assembleWith(worst).tree.split('\n').map(l => `  ${l}`).join('\n'))

console.log('\n  树里的顺序是**实际装载顺序**，它按依赖重排过了。')
console.log('  对比 7.3 那棵一路缩进的树：那时顺序是手写的，写错只会报"某个属性不存在"。')
