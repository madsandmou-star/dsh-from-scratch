// 8.1 之后的真实装配：树是平的，服务表是实的。
//   node --import tsx demos/08-services/02-assembled-flat.mjs

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
const { assemble } = await import('../../src/plugins.ts')

const root = new Context()
root.plugin(assemble(function cli(ctx) {
  console.log('=== cli 这一环读得到什么 ===')
  for (const key of ['config', 'prompt', 'guards', 'session', 'sessionId', 'logPath', 'persistence']) {
    console.log(`  ctx.${key.padEnd(12)} ${ctx[key] === undefined ? '✗' : '✓'}`)
  }
  ctx.persistence.close()
}))

console.log('\n=== 装配树：7.3 是一路缩进，现在是平的 ===')
console.log(root.inspect())

console.log('\n=== 服务表（整棵树共用一张）===')
for (const name of root.listServices()) console.log(`  ${name}`)

console.log('\n=== 谁都读得到，不分位置 ===')
console.log(`  root.config.model        = ${root.config.model}`)
console.log(`  root.children[0].sessionId = ${root.children[0].sessionId}`)
console.log('  连根都读得到——而根是所有插件的**祖先**，不是后代。')
console.log('  这正是"服务"和"继承来的属性"的区别：**服务不分方向。**')
