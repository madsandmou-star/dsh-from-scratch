// 5.2 痛点：没有变量机制时，每段自己去取值——同一个事实取了两次。
//   node demos/05-system-prompt/04-variables-pain.mjs
//
// 这个演示在课程仓库自己身上跑（要一个真的 git 仓库），只读。

import { execFileSync } from 'node:child_process'
import { PromptRegistry } from '../../src/system-prompt.ts'

let lookups = 0
const currentBranch = () => {
  lookups++
  return execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
}

console.log('=== 痛点：每段自己取值 ===')
{
  const prompt = new PromptRegistry()
  prompt.register({ name: 'harness:identity', order: -100, text: () => `你在一个 git 仓库里工作，当前分支是 ${currentBranch()}。` })
  prompt.register({ name: 'tools:guidance', order: 100, text: () => `提交前确认你还在 ${currentBranch()} 分支上。` })
  const startedAt = Date.now()
  console.log(prompt.assemble())
  console.log(`[spawn 了 ${lookups} 次 git，耗时 ${Date.now() - startedAt}ms]`)
}

console.log('\n=== 解法：注册成变量，一次组装只取一次 ===')
{
  lookups = 0
  const prompt = new PromptRegistry()
  prompt.variable('branch', currentBranch)
  prompt.register({ name: 'harness:identity', order: -100, text: '你在一个 git 仓库里工作，当前分支是 {{branch}}。' })
  prompt.register({ name: 'tools:guidance', order: 100, text: '提交前确认你还在 {{branch}} 分支上。' })
  const startedAt = Date.now()
  console.log(prompt.assemble())
  console.log(`[spawn 了 ${lookups} 次 git，耗时 ${Date.now() - startedAt}ms]`)
  console.log('注意两段的文本现在是**纯字符串**——它们可以来自配置文件、来自 AGENTS.md，')
  console.log('而那些地方写不了 `${当前分支()}`。这才是变量机制真正买到的东西。')
}
