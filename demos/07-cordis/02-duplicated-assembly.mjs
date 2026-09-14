// 7.1 痛点度量：两个入口的装配到底重了多少。
//   node --import tsx demos/07-cordis/02-duplicated-assembly.mjs
//
// 不靠感觉说"重复很多"——把两个文件的装配段落逐行比一遍，数出来。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 读一个入口文件里"装配"那一段：从 loadConfig() 到主循环之前。 */
function assemblyOf(file) {
  const text = readFileSync(join(ROOT, 'src', file), 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.includes('loadConfig()'))
  const end = lines.findIndex((l, i) => i > start && (l.includes('MAX_STEPS =') || l.includes('createInterface(')))
  return lines.slice(start, end)
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
}

const cli = assemblyOf('index.ts')
const headless = assemblyOf('headless.ts')
const shared = headless.filter(l => cli.includes(l))

console.log(`=== 两个入口的装配段 ===`)
console.log(`  src/index.ts     ${String(cli.length).padStart(3)} 行有效代码`)
console.log(`  src/headless.ts  ${String(headless.length).padStart(3)} 行有效代码`)
console.log(`  **完全一样的**    ${String(shared.length).padStart(3)} 行  （占 headless 的 ${Math.round(shared.length / headless.length * 100)}%）`)

console.log('\n=== 一字不差抄过来的那些 ===')
for (const line of shared) console.log(`  ${line.slice(0, 96)}`)

const cliOnly = cli.filter(l => !headless.includes(l))
console.log(`\n=== 只在一边出现的 ===`)
console.log(`  headless 独有 ${headless.length - shared.length} 行（它自己建会话，不支持续聊）`)
console.log(`  index 独有 ${cliOnly.length} 行——绝大部分是 --resume 和 DSH_SHOW_PROMPT，`)
console.log(`  也就是**这个入口真正特有的功能**。那部分本来就该只在一边。`)

console.log('\n痛在哪里，说具体一点：')
console.log('  加第七个工具 → 改 tool.ts，两个入口都自动拿到（工具是数组，这条还好）')
console.log('  加一道护栏   → **两个 guards 数组各改一次**')
console.log('  加一段 system prompt → **两处 prompt.register() 各加一次**')
console.log('  改会话存放位置 → **两处 SESSION_ROOT 各改一次**')
console.log('\n漏改一处的表现是"某个入口少了一个功能"——不报错，不崩溃，')
console.log('只是那个入口的 agent 行为和另一个不一样。**这是最难查的一类 bug。**')
