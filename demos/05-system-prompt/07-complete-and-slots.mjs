// 5.4 只能往上加不够用：具名槽位替换 persona，以及"这一段就是全部"。
//   node demos/05-system-prompt/07-complete-and-slots.mjs

import { PERSONA段名, PERSONA顺序, 提示注册表, 身份段 } from '../../src/system-prompt.ts'
import { 工具指引段 } from '../../src/tool.ts'

/** 建一个和真实装配一样的注册表。 */
const 建装配 = () => {
  const 提示 = new 提示注册表()
  提示.变量('cwd', () => '/home/me/项目')
  提示.变量('model', () => 'deepseek-chat')
  提示.注册(身份段)
  提示.注册({ 名字: PERSONA段名, 顺序: PERSONA顺序, 文本: '你在帮一个 Python 背景的人读 TypeScript 代码。' })
  提示.注册(工具指引段)
  提示.上下文({ 名字: 'time', 顺序: 0, 文本: '现在是 2026-09-01T04:00:00Z。' })
  return 提示
}

const 画 = (标题, 提示) => {
  console.log(`\n── ${标题} ──`)
  for (const 项 of 提示.清单()) console.log(`  ${String(项.顺序).padStart(5)}  ${项.名字.padEnd(20)} ${String(项.字符数).padStart(4)} 字符${项.生效 ? '' : '  ← 未生效'}`)
  console.log(`  system prompt（${提示.组装().length} 字符）：`)
  console.log(提示.组装().split('\n').map(行 => `    ${行}`).join('\n'))
  const 快照 = 提示.组装上下文()
  console.log(`  运行时快照：${快照 === '' ? '（无）' : 快照.split('\n').at(-1)}`)
}

console.log('=== ① 痛点：想换掉 persona，但只能"加" ===')
{
  const 提示 = 建装配()
  try {
    提示.注册({ 名字: PERSONA段名, 顺序: PERSONA顺序, 文本: '你是一个只会总结文件的机器人。' })
  } catch (错误) {
    console.log(`  ❌ ${错误.message}`)
  }
  console.log('  换个名字加一段呢？那两个人设会同时出现，互相打架。')
}

console.log('\n=== ② 具名槽位：替换而不是新增 ===')
{
  const 提示 = 建装配()
  const 恢复 = 提示.替换({ 名字: PERSONA段名, 顺序: PERSONA顺序, 文本: '你在帮一个前端工程师读后端代码。' })
  画('替换之后（其余段落一个没动）', 提示)
  恢复()
  console.log(`\n  恢复之后 persona 是：${提示.组装().split('\n\n')[1]}`)
}

console.log('\n=== ③ 完整：这一段就是全部 ===')
{
  const 提示 = 建装配()
  提示.替换({
    名字: PERSONA段名,
    顺序: PERSONA顺序,
    完整: true,
    文本: '你只做一件事：把给你的文件总结成三句话。工作目录是 {{cwd}}。不要调用任何工具。',
  })
  画('完整段生效', 提示)
  console.log('  注意 {{cwd}} 仍然被插值了——"完整"换掉的是哪些段进 prompt，不是要不要处理模板。')
}

console.log('\n=== ④ 两段都说"我是全部" ===')
{
  const 提示 = 建装配()
  提示.替换({ 名字: PERSONA段名, 顺序: PERSONA顺序, 完整: true, 文本: 'A 说我是全部。' })
  提示.替换({ 名字: 'tools:guidance', 顺序: 100, 完整: true, 文本: 'B 说我是全部。' })
  try { 提示.组装() } catch (错误) { console.log(`  ❌ ${错误.message}`) }
  console.log('  没有任何规则能决定听谁的，所以只能报错。')
}

console.log('\n=== ⑤ 一个最小的 subagent：完整 + 抑制上下文 ===')
{
  const 提示 = 建装配()
  提示.替换({ 名字: PERSONA段名, 顺序: PERSONA顺序, 完整: true, 文本: '你只做一件事：把给你的文件总结成三句话。' })
  提示.抑制上下文()
  画('subagent 的装配', 提示)
  console.log('  "完整"和"抑制上下文"是两个正交的开关：一个管 prompt 里留什么，')
  console.log('  一个管要不要发那条运行时快照。dsh 的 persona preset 把两者都暴露成配置项。')
}
