// 4.3 我们补不掉的洞：JS 正则会回溯，一个 pattern 就能把进程同步卡死。
//   node demos/04-tools/08-redos.mjs
//
// 它会一直跑下去。按 Ctrl-C 结束，然后看看那只"看门狗"有没有叫过。

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 工作目录 = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
process.chdir(工作目录)
const { grepTool } = await import('../../src/tool.ts')
await writeFile('长行.txt', `${'a'.repeat(40)}b\n`, 'utf8')

// 三秒后本该叫一声。但正则是同步跑的，事件循环被占住，定时器永远等不到机会。
setTimeout(() => console.log('【看门狗】3 秒到了，我醒了'), 3000)

console.log('开始搜索 pattern = (a+)+$ ，文件里只有一行：40 个 a 加一个 b')
const 开始 = Date.now()
const 结果 = await grepTool.execute({ pattern: '(a+)+$', include: '长行.txt' })
console.log(`搜完了：${结果}（耗时 ${Date.now() - 开始}ms）`)
