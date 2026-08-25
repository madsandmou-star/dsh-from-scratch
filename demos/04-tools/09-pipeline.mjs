// 4.4 执行管线：执行前放行/拒绝、统一超时、执行后兜底，以及"失败即拒绝"。
//   node demos/04-tools/09-pipeline.mjs

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 工作目录 = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
process.chdir(工作目录)
const { 执行工具 } = await import('../../src/pipeline.ts')
const { 记账, 输出兜底, 只读模式 } = await import('../../src/guard.ts')
await writeFile('a.txt', 'hello\n', 'utf8')

const 跑 = async (标题, 名字, 参数, 护栏们, 超时毫秒) => {
  console.log(`\n── ${标题} ──`)
  const 结果 = await 执行工具(名字, JSON.stringify(参数), 护栏们, 超时毫秒)
  console.log(结果.length > 200 ? `${结果.slice(0, 120)}…（共 ${结果.length} 字符）` : 结果)
}

const 正常 = [记账(true), 只读模式(false), 输出兜底()]
const 只读 = [记账(true), 只读模式(true), 输出兜底()]

await 跑('① 正常放行（注意 stderr 上的记账）', 'read', { path: 'a.txt' }, 正常)
await 跑('② 只读模式拦下 write', 'write', { path: 'a.txt', content: 'x' }, 只读)
await 跑('③ 只读模式不拦 read', 'read', { path: 'a.txt' }, 只读)
await 跑('④ 统一超时：bash 睡 10 秒，上限 1 秒', 'bash', { command: 'sleep 10', description: '睡一会' }, 正常, 1000)
// 现有六个工具**都**自己截断过了，所以兜底这一层平时根本不会触发。
// 它保护的是你还没写的那个工具——或者某天有人漏了截断的那个。这里现场注册一个。
const { tools } = await import('../../src/tool.ts')
tools.push({
  name: '没截断的工具',
  description: '演示用',
  parameters: { type: 'object', properties: {} },
  async execute() { return 'x'.repeat(200_000) },
})
await 跑('⑤ 执行后兜底：一个忘了自己截断的工具', '没截断的工具', {}, 正常)

// 一层自己会抛异常的护栏。管线必须把它当成"拒绝"，而不是当成"放行"。
const 坏掉的护栏 = { 名字: '坏掉的护栏', 执行前() { throw new Error('我自己炸了') } }
await 跑('⑥ 护栏自己出错 → 失败即拒绝', 'bash', { command: 'echo 我不该被执行', description: '试试' }, [坏掉的护栏, ...正常])

// 执行后钩子出错，不该把已经产生的结果吃掉。
const 坏掉的执行后 = { 名字: '坏掉的记账', 执行后() { throw new Error('记账炸了') } }
await 跑('⑦ 执行后钩子出错 → 结果照常返回', 'read', { path: 'a.txt' }, [坏掉的执行后, ...正常])
