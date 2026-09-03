// 3.3 模型给的参数是不可信输入：四种它真的会犯的错，四条能改正的回复。
//   node demos/03-tool-loop/03-arg-validation.mjs

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
process.chdir(dir)
const { runTool } = await import('../../src/pipeline.ts')
await writeFile('a.txt', 'hello\n', 'utf8')

/**
 * 模拟模型发来的一次工具调用：名字 + 一段**未解析**的参数文本。
 * @param {string} title - 这一格演示什么。
 * @param {string} name - 工具名。
 * @param {string} raw - 模型生成的 arguments 原文。
 */
const call = async (title, name, raw) => {
  console.log(`\n── ${title} ──`)
  console.log(`  模型发来：${name}(${raw})`)
  console.log(`  → ${(await runTool(name, raw, [])).split('\n')[0]}`)
}

await call('① 正常', 'read', '{"path": "a.txt"}')
await call('② 参数被截断，不是合法 JSON', 'read', '{"path": "a.tx')
await call('③ 缺字段', 'read', '{}')
await call('④ 类型不对', 'read', '{"path": 42}')
await call('⑤ 路径越界', 'read', '{"path": "../../etc/passwd"}')
await call('⑥ 工具名是幻觉出来的', 'summarize', '{}')

console.log('\n六种情况全都变成了**文本**返回给模型，一次异常都没抛。')
console.log('因为这些失败的正确读者是模型，不是我们的错误处理代码——')
console.log('它读完能自己改正，而抛异常会打断整个 agent。')
