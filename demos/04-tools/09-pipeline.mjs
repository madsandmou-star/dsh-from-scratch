// 4.4 执行管线：执行前放行/拒绝、统一超时、执行后兜底，以及"失败即拒绝"。
//   node demos/04-tools/09-pipeline.mjs

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const workdir = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
process.chdir(workdir)
const { runTool } = await import('../../src/pipeline.ts')
const { accounting, outputBackstop, readOnlyGuard } = await import('../../src/guard.ts')
await writeFile('a.txt', 'hello\n', 'utf8')

const run = async (title, name, args, guards, timeoutMs) => {
  console.log(`\n── ${title} ──`)
  const result = await runTool(name, JSON.stringify(args), guards, timeoutMs)
  console.log(result.length > 200 ? `${result.slice(0, 120)}…（共 ${result.length} 字符）` : result)
}

const normal = [accounting(true), readOnlyGuard(false), outputBackstop()]
const readOnly = [accounting(true), readOnlyGuard(true), outputBackstop()]

await run('① 正常放行（注意 stderr 上的记账）', 'read', { path: 'a.txt' }, normal)
await run('② 只读模式拦下 write', 'write', { path: 'a.txt', content: 'x' }, readOnly)
await run('③ 只读模式不拦 read', 'read', { path: 'a.txt' }, readOnly)
await run('④ 统一超时：bash 睡 10 秒，上限 1 秒', 'bash', { command: 'sleep 10', description: '睡一会' }, normal, 1000)
// 现有六个工具**都**自己截断过了，所以兜底这一层平时根本不会触发。
// 它保护的是你还没写的那个工具——或者某天有人漏了截断的那个。这里现场注册一个。
const { tools } = await import('../../src/tool.ts')
tools.push({
  name: '没截断的工具',
  description: '演示用',
  parameters: { type: 'object', properties: {} },
  async execute() { return 'x'.repeat(200_000) },
})
await run('⑤ 执行后兜底：一个忘了自己截断的工具', '没截断的工具', {}, normal)

// 一层自己会抛异常的护栏。管线必须把它当成"拒绝"，而不是当成"放行"。
const brokenGuard = { name: '坏掉的护栏', before() { throw new Error('我自己炸了') } }
await run('⑥ 护栏自己出错 → 失败即拒绝', 'bash', { command: 'echo 我不该被执行', description: '试试' }, [brokenGuard, ...normal])

// 执行后钩子出错，不该把已经产生的结果吃掉。
const brokenAfter = { name: '坏掉的记账', after() { throw new Error('记账炸了') } }
await run('⑦ 执行后钩子出错 → 结果照常返回', 'read', { path: 'a.txt' }, [brokenAfter, ...normal])
