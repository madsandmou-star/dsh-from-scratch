// 5.1 模型在**决定调用之前**就看到了只读模式，而不是被拒绝之后才知道。
//   node demos/05-system-prompt/02-model-sees-it.mjs

import { 跑一次会话, 清理 } from '../harness.mjs'

for (const 只读 of [false, true]) {
  console.log(`\n${'='.repeat(24)} 只读 = ${只读} ${'='.repeat(24)}`)
  let 模型收到的系统提示 = ''
  const 工作目录 = await 跑一次会话({
    文件: { 'add.mjs': 'export function add(a, b) {\n  return a - b\n}\n' },
    剧本: [{ name: 'read', args: { path: 'add.mjs' } }],
    最终回答: 只读 ? '减号应该是加号，但我改不了。' : '我这就改。',
    输入: 'add 写错了',
    配置: { 只读 },
    看见系统提示: 内容 => { 模型收到的系统提示 = 内容 },
  })
  await 清理(工作目录)
  console.log('--- 模型这一轮收到的 system prompt ---')
  console.log(模型收到的系统提示.split('\n').map(行 => `  ${行}`).join('\n'))
}
