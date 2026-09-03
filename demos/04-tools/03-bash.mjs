// 4.2 bash 工具的九种情况：正常、失败、退出码、状态不保留、输出爆炸、超时、越界、无输出。
//   node demos/04-tools/03-bash.mjs

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NEVER_ABORTED } from '../harness.mjs'

const workdir = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
process.chdir(workdir)
const { bashTool } = await import('../../src/tool.ts')
await writeFile('demo.ts', 'export const x = 1\n', 'utf8')

const run = async (args, title) => {
  console.log(`\n── ${title} ──`)
  const startedAt = Date.now()
  try {
    const result = await bashTool.execute({ description: title, ...args }, NEVER_ABORTED)
    const line = result.split('\n')
    console.log(line.length > 6 ? `${line.slice(0, 3).join('\n')}\n…（共 ${line.length} 行）…\n${line.slice(-2).join('\n')}` : result)
  } catch (error) { console.log(`拒绝：${error.message}`) }
  console.log(`（耗时 ${Date.now() - startedAt}ms）`)
}

await run({ command: 'echo hello' }, '① 正常')
await run({ command: 'ls /nonexistent-dir' }, '② 命令失败：非零退出 + stderr')
await run({ command: 'grep zzz demo.ts' }, '③ grep 没找到：退出码 1，但不是故障')
await run({ command: 'cd /tmp && pwd' }, '④ 这一次 cd 了')
await run({ command: 'pwd' }, '⑤ 下一次还记得吗')
await run({ command: 'seq 1 20000' }, '⑥ 输出爆炸：只保留末尾')
await run({ command: 'sleep 5', timeout_ms: 500 }, '⑦ 超时')
await run({ command: 'echo 越界', workdir: '../..' }, '⑧ workdir 越界')
await run({ command: 'true' }, '⑨ 完全没有输出')
