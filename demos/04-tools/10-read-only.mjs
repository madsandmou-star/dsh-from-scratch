// 4.4 只读模式：同一个 agent、同一套工具，换一个配置开关就只能看不能动。
//   node demos/04-tools/10-read-only.mjs

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runSession, cleanup } from '../harness.mjs'

const script = [
  { name: 'read', args: { path: 'add.mjs' } },
  { name: 'edit', args: { path: 'add.mjs', old_string: '  return a - b', new_string: '  return a + b' } },
]
const files = { 'add.mjs': 'export function add(a, b) {\n  return a - b\n}\n' }

for (const readOnly of [false, true]) {
  console.log(`\n${'='.repeat(20)} 只读 = ${readOnly} ${'='.repeat(20)}`)
  const workdir = await runSession({
    files,
    script,
    finalAnswer: readOnly ? '我只能看不能改，这里应该把减号换成加号。' : '改好了。',
    input: 'add 写错了，帮我修一下',
    config: { readOnly },
  })
  console.log(`--- add.mjs 现在 ---\n${await readFile(join(workdir, 'add.mjs'), 'utf8')}`)
  await cleanup(workdir)
}
