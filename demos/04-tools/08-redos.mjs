// 4.3 我们补不掉的洞：JS 正则会回溯，一个 pattern 就能把进程同步卡死。
//   node demos/04-tools/08-redos.mjs
//
// 它会一直跑下去。按 Ctrl-C 结束，然后看看那只"看门狗"有没有叫过。

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NEVER_ABORTED } from '../harness.mjs'

const workdir = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
process.chdir(workdir)
const { grepTool } = await import('../../src/tool.ts')
await writeFile('长行.txt', `${'a'.repeat(40)}b\n`, 'utf8')

// 三秒后本该叫一声。但正则是同步跑的，事件循环被占住，定时器永远等不到机会。
setTimeout(() => console.log('【看门狗】3 秒到了，我醒了'), 3000)

console.log('开始搜索 pattern = (a+)+$ ，文件里只有一行：40 个 a 加一个 b')
const startedAt = Date.now()
const result = await grepTool.execute({ pattern: '(a+)+$', include: '长行.txt' }, NEVER_ABORTED)
console.log(`搜完了：${result}（耗时 ${Date.now() - startedAt}ms）`)
