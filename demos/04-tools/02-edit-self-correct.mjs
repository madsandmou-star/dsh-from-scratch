// 4.1 完整 tool loop：模型第一次用了不唯一的 old_string，看到报错后自己多带上下文重试。
//   node demos/04-tools/02-edit-self-correct.mjs

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { 跑一次会话, 清理 } from '../harness.mjs'

const 模型看到的 = []
const 工作目录 = await 跑一次会话({
  文件: { 'demo.ts': 'export function a() {\n  return 1\n}\n\nexport function b() {\n  return 1\n}\n' },
  剧本: [
    // 第 1 步：old_string 只带一行——这行在文件里有两处。
    { name: 'edit', args: { path: 'demo.ts', old_string: '  return 1', new_string: '  return 2' } },
    // 第 2 步：看到"出现了 2 次（第 2、6 行）"之后，多带一行上下文让它唯一。
    { name: 'edit', args: { path: 'demo.ts', old_string: 'export function b() {\n  return 1', new_string: 'export function b() {\n  return 2' } },
  ],
  最终回答: '改好了：b() 现在返回 2，a() 没动。',
  输入: '把 b() 的返回值改成 2',
  // 子进程的输出是直接打到终端的，这里先攒着，等会话跑完再打，免得两股输出交错。
  看见: 内容 => 模型看到的.push(内容),
})

console.log('\n=== 模型每一轮实际看到的 tool 结果 ===')
for (const [下标, 内容] of 模型看到的.entries()) console.log(`第 ${下标 + 1} 步 → ${内容}`)

console.log('\n=== demo.ts 现在 ===')
console.log(await readFile(join(工作目录, 'demo.ts'), 'utf8'))
await 清理(工作目录)
