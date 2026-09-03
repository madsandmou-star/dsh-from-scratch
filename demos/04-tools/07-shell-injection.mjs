// 4.3 为什么搜索不能走 bash：模型给的 pattern 会被 shell 解释。
//   node demos/04-tools/07-shell-injection.mjs

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { NEVER_ABORTED } from '../harness.mjs'

const workdir = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
process.chdir(workdir)
const { bashTool, grepTool } = await import('../../src/tool.ts')
await writeFile('a.ts', 'hello world\n', 'utf8')

const clear = () => { if (existsSync('被注入了.txt')) rmSync('被注入了.txt') }
const report = () => console.log(`   → 被注入了.txt 存在吗？ ${existsSync('被注入了.txt') ? '★ 存在：那条命令真的被执行了' : '不存在'}`)

// 模型只是想找一段代码。它生成的这段文本里恰好含有 shell 语法——它并不知道自己在做什么。
const patternFromModel = '$(touch 被注入了.txt)hello'

clear()
console.log('① 走 bash：grep -rn "<pattern>" .')
console.log('   ' + await bashTool.execute({ command: `grep -rn "${patternFromModel}" .`, description: '搜索' }, NEVER_ABORTED))
report()

clear()
console.log('\n② 走 grep 工具（同一个 pattern）')
console.log('   ' + await grepTool.execute({ pattern: patternFromModel }, NEVER_ABORTED))
report()

console.log('\n③ pattern 以 - 开头，走 bash —— 它变成了命令行选项：')
console.log('   ' + await bashTool.execute({ command: 'grep -rn "-abc" .', description: '搜索' }, NEVER_ABORTED))
console.log('④ 同一个 pattern，走 grep 工具：')
console.log('   ' + await grepTool.execute({ pattern: '-abc' }, NEVER_ABORTED))
clear()
