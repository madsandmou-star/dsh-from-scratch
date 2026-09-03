// 5.3 痛点与解法对照：把"当前时间"放进 system prompt 会发生什么。
//   node demos/05-system-prompt/06-why-not-system-prompt.mjs

import { PromptRegistry, CONTEXT_CLEARED, identitySection } from '../../src/system-prompt.ts'

const newRegistry = () => {
  const prompt = new PromptRegistry()
  prompt.variable('cwd', () => '/home/me/项目')
  prompt.variable('model', () => 'deepseek-chat')
  prompt.register(identitySection)
  return prompt
}

/** 让两次调用之间真的过掉一点时间。 */
const pause = () => new Promise(resolve => setTimeout(resolve, 5))

console.log('=== 痛点：时间作为 system prompt 的一段 ===')
{
  const prompt = newRegistry()
  prompt.register({ name: 'time', order: 50, text: () => `现在是 ${new Date().toISOString()}。` })
  const step1 = prompt.assemble()
  await pause()
  const step2 = prompt.assemble()
  console.log(`  两个 step 的 system prompt 一样吗？ ${step1 === step2 ? '一样' : '★ 不一样'}`)
  // 找出第一个不同的字符位置：它决定了缓存前缀能命中多长。
  let sharedPrefix = 0
  while (sharedPrefix < step1.length && step1[sharedPrefix] === step2[sharedPrefix]) sharedPrefix++
  console.log(`  相同前缀只有 ${sharedPrefix} / ${step1.length} 字符——后面全部要重新计算。`)
}

console.log('\n=== 解法：时间作为动态上下文 ===')
{
  const prompt = newRegistry()
  prompt.context({ name: 'time', order: 0, text: () => `现在是 ${new Date().toISOString()}。` })
  const step1Prompt = prompt.assemble()
  const step1Snapshot = prompt.assembleContext()
  await pause()
  const step2Prompt = prompt.assemble()
  const step2Snapshot = prompt.assembleContext()
  console.log(`  两个 step 的 system prompt 一样吗？ ${step1Prompt === step2Prompt ? '★ 一样，缓存前缀完整' : '不一样'}`)
  console.log(`  两个 step 的快照一样吗？           ${step1Snapshot === step2Snapshot ? '一样' : '不一样，会作为新的一条 user 消息追加'}`)
}

console.log('\n=== 去重：上下文没变就不重发 ===')
{
  const prompt = newRegistry()
  prompt.context({ name: 'branch', order: 0, text: '当前分支是 main。' })
  let previous
  const tryStep = stepNo => {
    const snapshot = prompt.assembleContext()
    if (snapshot === (previous ?? '')) { console.log(`  step ${stepNo}：和上次一样，不发`); return }
    console.log(`  step ${stepNo}：发一条 user 消息`)
    previous = snapshot
  }
  tryStep(1); tryStep(2); tryStep(3)
}

console.log('\n=== 从"有"变成"没有"：必须显式说一声 ===')
{
  const prompt = newRegistry()
  let insideGitRepo = true
  prompt.context({ name: 'branch', order: 0, text: () => (insideGitRepo ? '当前分支是 main。' : '') })
  console.log(`  step 1 的快照：${prompt.assembleContext().split('\n').at(-1)}`)
  insideGitRepo = false
  const snapshot = prompt.assembleContext()
  console.log(`  step 2 的快照：${snapshot === '' ? `（空）→ 要发的是："${CONTEXT_CLEARED}"` : snapshot}`)
  console.log('  什么都不发的话，模型会继续拿 step 1 那份当真。')
}
