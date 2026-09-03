// 4.2 完整 tool loop：跑测试 → 读代码 → 改代码 → 再跑测试。一个 turn 四个 step。
//   node demos/04-tools/04-red-green.mjs

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runSession, cleanup } from '../harness.mjs'

const seenByModel = []
const workdir = await runSession({
  files: {
    'add.mjs': 'export function add(a, b) {\n  return a - b\n}\n',
    'test.mjs': "import { add } from './add.mjs'\n"
      + 'if (add(2, 3) !== 5) {\n'
      + '  console.error(`FAIL: add(2, 3) 期望 5，实际 ${add(2, 3)}`)\n'
      + '  process.exit(1)\n}\n'
      + "console.log('PASS')\n",
  },
  script: [
    { name: 'bash', args: { command: 'node test.mjs', description: '跑测试看看现在是什么情况' } },
    { name: 'read', args: { path: 'add.mjs' } },
    { name: 'edit', args: { path: 'add.mjs', old_string: '  return a - b', new_string: '  return a + b' } },
    { name: 'bash', args: { command: 'node test.mjs', description: '再跑一次测试确认修好了' } },
  ],
  finalAnswer: 'add 里写成了减法，已改成加法，测试通过了。',
  input: 'test.mjs 跑不过，修好它',
  onToolResult: content => seenByModel.push(content),
})

console.log('\n=== 模型每一轮实际看到的 tool 结果 ===')
for (const [index, content] of seenByModel.entries()) {
  console.log(`第 ${index + 1} 步 → ${content.replace(/\n/g, ' ⏎ ').slice(0, 100)}`)
}
console.log('\n=== add.mjs 现在 ===')
console.log(await readFile(join(workdir, 'add.mjs'), 'utf8'))
await cleanup(workdir)
