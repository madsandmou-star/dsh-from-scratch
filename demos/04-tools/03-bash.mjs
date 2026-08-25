// 4.2 bash 工具的九种情况：正常、失败、退出码、状态不保留、输出爆炸、超时、越界、无输出。
//   node demos/04-tools/03-bash.mjs

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 工作目录 = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
process.chdir(工作目录)
const { bashTool } = await import('../../src/tool.ts')
await writeFile('demo.ts', 'export const x = 1\n', 'utf8')

const 跑 = async (args, 标题) => {
  console.log(`\n── ${标题} ──`)
  const 开始 = Date.now()
  try {
    const 结果 = await bashTool.execute({ description: 标题, ...args })
    const 行 = 结果.split('\n')
    console.log(行.length > 6 ? `${行.slice(0, 3).join('\n')}\n…（共 ${行.length} 行）…\n${行.slice(-2).join('\n')}` : 结果)
  } catch (错误) { console.log(`拒绝：${错误.message}`) }
  console.log(`（耗时 ${Date.now() - 开始}ms）`)
}

await 跑({ command: 'echo hello' }, '① 正常')
await 跑({ command: 'ls /nonexistent-dir' }, '② 命令失败：非零退出 + stderr')
await 跑({ command: 'grep zzz demo.ts' }, '③ grep 没找到：退出码 1，但不是故障')
await 跑({ command: 'cd /tmp && pwd' }, '④ 这一次 cd 了')
await 跑({ command: 'pwd' }, '⑤ 下一次还记得吗')
await 跑({ command: 'seq 1 20000' }, '⑥ 输出爆炸：只保留末尾')
await 跑({ command: 'sleep 5', timeout_ms: 500 }, '⑦ 超时')
await 跑({ command: 'echo 越界', workdir: '../..' }, '⑧ workdir 越界')
await 跑({ command: 'true' }, '⑨ 完全没有输出')
