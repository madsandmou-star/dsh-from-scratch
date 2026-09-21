// 9.1 真实的收益：promptPlugin 注册的七样东西，现在能整个撤回去。
//   node --import tsx demos/09-effects/02-prompt-effects.mjs

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
const { configPlugin, promptPlugin } = await import('../../src/plugins.ts')

const root = new Context()
root.plugin(configPlugin)
root.plugin(promptPlugin)

/** 打一份 system prompt 清单。 */
function inventory(label) {
  const items = root.prompt.inventory()
  console.log(`  ${label}：${items.length} 段` + (items.length === 0 ? '' : ` —— ${items.map(i => i.name).join('、')}`))
  console.log(`    拼出来 ${root.prompt.assemble().length} 字符；运行时上下文 ${root.prompt.assembleContext().length} 字符`)
}

console.log('=== 装上之后 ===')
inventory('清单')

console.log('\n=== 收掉整棵树 ===')
await root.dispose()
inventory('清单')
console.log('  七样东西（2 个变量 + 4 段 + 1 个运行时上下文）全撤回去了，')
console.log('  而 promptPlugin 里没有一行"撤销"的代码——只有七个 ctx.effect(...)。')

console.log('\n=== 为什么这件事重要 ===')
console.log('  5.1 那个注册表从第一天就返回注销函数，6.1 的 session.on() 也是。')
console.log('  在 9.1 之前，那些返回值**一次都没被接住过**。')
console.log('  一个能注册不能注销的注册表，等于一个只能变大的全局状态——')
console.log('  阶段 14 要给 subagent 换一套工具和 prompt，靠的正是"能撤回去"。')
