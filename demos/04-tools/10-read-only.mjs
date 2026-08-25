// 4.4 只读模式：同一个 agent、同一套工具，换一个配置开关就只能看不能动。
//   node demos/04-tools/10-read-only.mjs

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { 跑一次会话, 清理 } from '../harness.mjs'

const 剧本 = [
  { name: 'read', args: { path: 'add.mjs' } },
  { name: 'edit', args: { path: 'add.mjs', old_string: '  return a - b', new_string: '  return a + b' } },
]
const 文件 = { 'add.mjs': 'export function add(a, b) {\n  return a - b\n}\n' }

for (const 只读 of [false, true]) {
  console.log(`\n${'='.repeat(20)} 只读 = ${只读} ${'='.repeat(20)}`)
  const 工作目录 = await 跑一次会话({
    文件,
    剧本,
    最终回答: 只读 ? '我只能看不能改，这里应该把减号换成加号。' : '改好了。',
    输入: 'add 写错了，帮我修一下',
    配置: { 只读 },
  })
  console.log(`--- add.mjs 现在 ---\n${await readFile(join(工作目录, 'add.mjs'), 'utf8')}`)
  await 清理(工作目录)
}
