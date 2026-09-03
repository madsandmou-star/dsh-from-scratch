// 5.1 模型在**决定调用之前**就看到了只读模式，而不是被拒绝之后才知道。
//   node demos/05-system-prompt/02-model-sees-it.mjs

import { runSession, cleanup } from '../harness.mjs'

for (const readOnly of [false, true]) {
  console.log(`\n${'='.repeat(24)} 只读 = ${readOnly} ${'='.repeat(24)}`)
  let systemPromptSeen = ''
  const workdir = await runSession({
    files: { 'add.mjs': 'export function add(a, b) {\n  return a - b\n}\n' },
    script: [{ name: 'read', args: { path: 'add.mjs' } }],
    finalAnswer: readOnly ? '减号应该是加号，但我改不了。' : '我这就改。',
    input: 'add 写错了',
    config: { readOnly },
    onSystemPrompt: content => { systemPromptSeen = content },
  })
  await cleanup(workdir)
  console.log('--- 模型这一轮收到的 system prompt ---')
  console.log(systemPromptSeen.split('\n').map(line => `  ${line}`).join('\n'))
}
