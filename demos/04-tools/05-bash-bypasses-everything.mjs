// 4.2 bash 绕过我们所有的护栏：edit 出不了工作目录，bash 想去哪去哪。
//   node demos/04-tools/05-bash-bypasses-everything.mjs

import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 工作目录 = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
process.chdir(工作目录)
const { bashTool, editTool } = await import('../../src/tool.ts')

await mkdir('重要资料', { recursive: true })
await writeFile('重要资料/论文.md', '三年的工作\n', 'utf8')

console.log('edit 想动工作目录之外的文件：')
try { await editTool.execute({ path: '../../etc/hosts', old_string: 'a', new_string: 'b' }) }
catch (错误) { console.log(`  ❌ ${错误.message}`) }

console.log('\nbash 想删掉工作目录里的三年工作：')
console.log('  ' + await bashTool.execute({ command: 'rm -rf 重要资料 && echo 删完了', description: '清理' }))

console.log('bash 想读工作目录之外的东西：')
console.log('  ' + await bashTool.execute({ command: 'head -1 /etc/hostname', description: '读系统文件' }))
