// 4.1 完整 tool loop：模型第一次用了不唯一的 old_string，看到报错后自己多带上下文重试。
//   node demos/04-tools/02-edit-self-correct.mjs

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runSession, cleanup } from '../harness.mjs'

const seenByModel = []
const workdir = await runSession({
  files: { 'demo.ts': 'export function a() {\n  return 1\n}\n\nexport function b() {\n  return 1\n}\n' },
  script: [
    // 第 1 步：old_string 只带一行——这行在文件里有两处。
    { name: 'edit', args: { path: 'demo.ts', old_string: '  return 1', new_string: '  return 2' } },
    // 第 2 步：看到"出现了 2 次（第 2、6 行）"之后，多带一行上下文让它唯一。
    { name: 'edit', args: { path: 'demo.ts', old_string: 'export function b() {\n  return 1', new_string: 'export function b() {\n  return 2' } },
  ],
  finalAnswer: '改好了：b() 现在返回 2，a() 没动。',
  input: '把 b() 的返回值改成 2',
  // 子进程的输出是直接打到终端的，这里先攒着，等会话跑完再打，免得两股输出交错。
  onToolResult: content => seenByModel.push(content),
})

console.log('\n=== 模型每一轮实际看到的 tool 结果 ===')
for (const [index, content] of seenByModel.entries()) console.log(`第 ${index + 1} 步 → ${content}`)

console.log('\n=== demo.ts 现在 ===')
console.log(await readFile(join(workdir, 'demo.ts'), 'utf8'))
await cleanup(workdir)
