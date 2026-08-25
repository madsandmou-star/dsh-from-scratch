// 4.3 glob 与 grep：正常用法、非法正则、没匹配、匹配太多。
//   node demos/04-tools/06-search.mjs
//
// 这个演示直接在课程仓库自己身上跑，因为它需要一棵真实的目录树。

import { globTool, grepTool } from '../../src/tool.ts'

const 跑 = async (tool, args, 标题) => {
  console.log(`\n── ${标题} ──`)
  try {
    const 结果 = await tool.execute(args)
    const 行 = 结果.split('\n')
    console.log(行.slice(0, 6).join('\n'))
    if (行.length > 6) console.log(`  …（共 ${行.length} 行）`)
  } catch (错误) { console.log(`拒绝：${错误.message}`) }
}

await 跑(globTool, { pattern: 'src/*.ts' }, '① glob：src 下的 ts，最近修改的排前面')
await 跑(globTool, { pattern: 'docs/**/*.md' }, '② glob：** 跨目录')
await 跑(grepTool, { pattern: '取字符串', include: '*.ts' }, '③ grep：这个函数用在哪')
await 跑(grepTool, { pattern: '(' }, '④ grep：模型写了个编译不过的正则')
// pattern 拼出来而不是写死：写死的话，grep 会在这个演示脚本自己身上搜到它。
await 跑(grepTool, { pattern: `zz${'zz'}-一定不存在` }, '⑤ grep：没匹配')
await 跑(grepTool, { pattern: 'the' }, '⑥ grep：匹配太多，被截断并说明')
