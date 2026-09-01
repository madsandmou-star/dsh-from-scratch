// 5.2 痛点：没有变量机制时，每段自己去取值——同一个事实取了两次。
//   node demos/05-system-prompt/04-variables-pain.mjs
//
// 这个演示在课程仓库自己身上跑（要一个真的 git 仓库），只读。

import { execFileSync } from 'node:child_process'
import { 提示注册表 } from '../../src/system-prompt.ts'

let 取了几次 = 0
const 当前分支 = () => {
  取了几次++
  return execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
}

console.log('=== 痛点：每段自己取值 ===')
{
  const 提示 = new 提示注册表()
  提示.注册({ 名字: 'harness:identity', 顺序: -100, 文本: () => `你在一个 git 仓库里工作，当前分支是 ${当前分支()}。` })
  提示.注册({ 名字: 'tools:guidance', 顺序: 100, 文本: () => `提交前确认你还在 ${当前分支()} 分支上。` })
  const 开始 = Date.now()
  console.log(提示.组装())
  console.log(`[spawn 了 ${取了几次} 次 git，耗时 ${Date.now() - 开始}ms]`)
}

console.log('\n=== 解法：注册成变量，一次组装只取一次 ===')
{
  取了几次 = 0
  const 提示 = new 提示注册表()
  提示.变量('branch', 当前分支)
  提示.注册({ 名字: 'harness:identity', 顺序: -100, 文本: '你在一个 git 仓库里工作，当前分支是 {{branch}}。' })
  提示.注册({ 名字: 'tools:guidance', 顺序: 100, 文本: '提交前确认你还在 {{branch}} 分支上。' })
  const 开始 = Date.now()
  console.log(提示.组装())
  console.log(`[spawn 了 ${取了几次} 次 git，耗时 ${Date.now() - 开始}ms]`)
  console.log('注意两段的文本现在是**纯字符串**——它们可以来自配置文件、来自 AGENTS.md，')
  console.log('而那些地方写不了 `${当前分支()}`。这才是变量机制真正买到的东西。')
}
