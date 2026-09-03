// 5.4 只能往上加不够用：具名槽位替换 persona，以及"这一段就是全部"。
//   node demos/05-system-prompt/07-complete-and-slots.mjs

import { PERSONA_SECTION, PERSONA_ORDER, PromptRegistry, identitySection } from '../../src/system-prompt.ts'
import { toolGuidanceSection } from '../../src/tool.ts'

/** 建一个和真实装配一样的注册表。 */
const newAssembly = () => {
  const prompt = new PromptRegistry()
  prompt.variable('cwd', () => '/home/me/项目')
  prompt.variable('model', () => 'deepseek-chat')
  prompt.register(identitySection)
  prompt.register({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: '你在帮一个 Python 背景的人读 TypeScript 代码。' })
  prompt.register(toolGuidanceSection)
  prompt.context({ name: 'time', order: 0, text: '现在是 2026-09-01T04:00:00Z。' })
  return prompt
}

const print = (title, prompt) => {
  console.log(`\n── ${title} ──`)
  for (const item of prompt.inventory()) console.log(`  ${String(item.order).padStart(5)}  ${item.name.padEnd(20)} ${String(item.chars).padStart(4)} 字符${item.active ? '' : '  ← 未生效'}`)
  console.log(`  system prompt（${prompt.assemble().length} 字符）：`)
  console.log(prompt.assemble().split('\n').map(line => `    ${line}`).join('\n'))
  const snapshot = prompt.assembleContext()
  console.log(`  运行时快照：${snapshot === '' ? '（无）' : snapshot.split('\n').at(-1)}`)
}

console.log('=== ① 痛点：想换掉 persona，但只能"加" ===')
{
  const prompt = newAssembly()
  try {
    prompt.register({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: '你是一个只会总结文件的机器人。' })
  } catch (error) {
    console.log(`  ❌ ${error.message}`)
  }
  console.log('  换个名字加一段呢？那两个人设会同时出现，互相打架。')
}

console.log('\n=== ② 具名槽位：替换而不是新增 ===')
{
  const prompt = newAssembly()
  const restore = prompt.replace({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: '你在帮一个前端工程师读后端代码。' })
  print('替换之后（其余段落一个没动）', prompt)
  restore()
  console.log(`\n  恢复之后 persona 是：${prompt.assemble().split('\n\n')[1]}`)
}

console.log('\n=== ③ 完整：这一段就是全部 ===')
{
  const prompt = newAssembly()
  prompt.replace({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    complete: true,
    text: '你只做一件事：把给你的文件总结成三句话。工作目录是 {{cwd}}。不要调用任何工具。',
  })
  print('完整段生效', prompt)
  console.log('  注意 {{cwd}} 仍然被插值了——"完整"换掉的是哪些段进 prompt，不是要不要处理模板。')
}

console.log('\n=== ④ 两段都说"我是全部" ===')
{
  const prompt = newAssembly()
  prompt.replace({ name: PERSONA_SECTION, order: PERSONA_ORDER, complete: true, text: 'A 说我是全部。' })
  prompt.replace({ name: 'tools:guidance', order: 100, complete: true, text: 'B 说我是全部。' })
  try { prompt.assemble() } catch (error) { console.log(`  ❌ ${error.message}`) }
  console.log('  没有任何规则能决定听谁的，所以只能报错。')
}

console.log('\n=== ⑤ 一个最小的 subagent：完整 + 抑制上下文 ===')
{
  const prompt = newAssembly()
  prompt.replace({ name: PERSONA_SECTION, order: PERSONA_ORDER, complete: true, text: '你只做一件事：把给你的文件总结成三句话。' })
  prompt.suppressContext()
  print('subagent 的装配', prompt)
  console.log('  "完整"和"抑制上下文"是两个正交的开关：一个管 prompt 里留什么，')
  console.log('  一个管要不要发那条运行时快照。dsh 的 persona preset 把两者都暴露成配置项。')
}
