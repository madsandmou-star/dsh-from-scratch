// 4.1 直接调用 write / edit，看四种结果：创建、覆盖、三种失败、一次成功。
//   node demos/04-tools/01-write-edit.mjs

import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 不取消 } from '../harness.mjs'

const 工作目录 = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
process.chdir(工作目录)
// tool.ts 在模块加载时就把 process.cwd() 记成工作目录，所以必须先 chdir 再 import。
const { writeTool, editTool } = await import('../../src/tool.ts')

await writeFile('demo.ts', 'export function a() {\n  return 1\n}\n\nexport function b() {\n  return 1\n}\n', 'utf8')

const 跑 = async (tool, args) => {
  try { console.log(`✅ ${tool.name} → ${await tool.execute(args, 不取消)}`) }
  catch (错误) { console.log(`❌ ${tool.name} → ${错误.message}`) }
}

await 跑(writeTool, { path: 'notes.md', content: '第一版\n' })
await 跑(writeTool, { path: 'notes.md', content: '第二版，比第一版长一些\n' })
console.log('---')
await 跑(editTool, { path: 'demo.ts', old_string: '  return 1', new_string: '  return 2' })
await 跑(editTool, { path: 'demo.ts', old_string: '  return 9', new_string: '  return 2' })
await 跑(editTool, { path: 'demo.ts', old_string: '  return 1', new_string: '  return 1' })
await 跑(editTool, { path: 'demo.ts', old_string: 'export function b() {\n  return 1', new_string: 'export function b() {\n  return 2' })
console.log('--- 文件现在是 ---')
console.log(await readFile('demo.ts', 'utf8'))
