// 5.1 system prompt 是拼出来的：注册、排序、重名、注销、条件性段落。
//   node demos/05-system-prompt/01-assembly.mjs

import { PromptRegistry, identitySection } from '../../src/system-prompt.ts'
import { toolGuidanceSection } from '../../src/tool.ts'
import { readOnlyNotice } from '../../src/guard.ts'

// 身份段用了 {{cwd}} 和 {{model}}（5.2），所以每个注册表都得先把这两个变量注册上。
// 忘了注册就会组装失败——这正是 5.2 想要的行为：拼错或漏掉不会静默。
const registerVariables = prompt => {
  prompt.variable('cwd', () => '/home/me/项目')
  prompt.variable('model', () => 'deepseek-chat')
}

const printInventory = (title, registry) => {
  console.log(`\n── ${title} ──`)
  for (const item of registry.inventory()) {
    console.log(`  ${String(item.order).padStart(5)}  ${item.name.padEnd(20)} ${item.chars} 字符${item.active ? '' : '（不生效，会被丢掉）'}`)
  }
  console.log(`  → 拼出来共 ${registry.assemble().length} 字符`)
}

const prompt = new PromptRegistry()
registerVariables(prompt)
prompt.register(identitySection)
const disposePersona = prompt.register({ name: 'deployment:persona', order: 0, text: '你在帮一个 Python 背景的人读 TypeScript 代码。' })
prompt.register(toolGuidanceSection)
prompt.register(readOnlyNotice(false))
printInventory('① 默认装配（只读关）', prompt)

console.log('\n── ② 重名 ──')
try { prompt.register({ name: 'harness:identity', order: 999, text: '我要覆盖身份段' }) }
catch (error) { console.log(`  ❌ ${error.message}`) }
console.log('  → 静默覆盖会让人查半天为什么某段话不见了，所以直接抛错。')

console.log('\n── ③ 注销 ──')
disposePersona()
printInventory('撤掉 persona 之后', prompt)
console.log('  → 注册返回注销函数，不是 void。dsh 里这叫"注册即效果"。')

const readOnlyRegistry = new PromptRegistry()
registerVariables(readOnlyRegistry)
readOnlyRegistry.register(identitySection)
readOnlyRegistry.register({ name: 'deployment:persona', order: 0, text: '你在帮一个 Python 背景的人读 TypeScript 代码。' })
readOnlyRegistry.register(toolGuidanceSection)
readOnlyRegistry.register(readOnlyNotice(true))
printInventory('④ 只读模式打开', readOnlyRegistry)

console.log('\n=== 只读模式那一段长这样 ===')
console.log(readOnlyRegistry.assemble().split('\n\n').at(-1))
