// 4.3 glob 与 grep：正常用法、非法正则、没匹配、匹配太多。
//   node demos/04-tools/06-search.mjs
//
// 这个演示直接在课程仓库自己身上跑，因为它需要一棵真实的目录树。

import { globTool, grepTool } from '../../src/tool.ts'
import { NEVER_ABORTED } from '../harness.mjs'

const run = async (tool, args, title) => {
  console.log(`\n── ${title} ──`)
  try {
    const result = await tool.execute(args, NEVER_ABORTED)
    const line = result.split('\n')
    console.log(line.slice(0, 6).join('\n'))
    if (line.length > 6) console.log(`  …（共 ${line.length} 行）`)
  } catch (error) { console.log(`拒绝：${error.message}`) }
}

await run(globTool, { pattern: 'src/*.ts' }, '① glob：src 下的 ts，最近修改的排前面')
await run(globTool, { pattern: 'docs/**/*.md' }, '② glob：** 跨目录')
await run(grepTool, { pattern: '取字符串', include: '*.ts' }, '③ grep：这个函数用在哪')
await run(grepTool, { pattern: '(' }, '④ grep：模型写了个编译不过的正则')
// pattern 拼出来而不是写死：写死的话，grep 会在这个演示脚本自己身上搜到它。
await run(grepTool, { pattern: `zz${'zz'}-一定不存在` }, '⑤ grep：没匹配')
await run(grepTool, { pattern: 'the' }, '⑥ grep：匹配太多，被截断并说明')
