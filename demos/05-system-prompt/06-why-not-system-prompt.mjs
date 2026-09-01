// 5.3 痛点与解法对照：把"当前时间"放进 system prompt 会发生什么。
//   node demos/05-system-prompt/06-why-not-system-prompt.mjs

import { 提示注册表, 快照已清空, 身份段 } from '../../src/system-prompt.ts'

const 建注册表 = () => {
  const 提示 = new 提示注册表()
  提示.变量('cwd', () => '/home/me/项目')
  提示.变量('model', () => 'deepseek-chat')
  提示.注册(身份段)
  return 提示
}

/** 让两次调用之间真的过掉一点时间。 */
const 等一下 = () => new Promise(完成 => setTimeout(完成, 5))

console.log('=== 痛点：时间作为 system prompt 的一段 ===')
{
  const 提示 = 建注册表()
  提示.注册({ 名字: 'time', 顺序: 50, 文本: () => `现在是 ${new Date().toISOString()}。` })
  const 第一步 = 提示.组装()
  await 等一下()
  const 第二步 = 提示.组装()
  console.log(`  两个 step 的 system prompt 一样吗？ ${第一步 === 第二步 ? '一样' : '★ 不一样'}`)
  // 找出第一个不同的字符位置：它决定了缓存前缀能命中多长。
  let 相同前缀 = 0
  while (相同前缀 < 第一步.length && 第一步[相同前缀] === 第二步[相同前缀]) 相同前缀++
  console.log(`  相同前缀只有 ${相同前缀} / ${第一步.length} 字符——后面全部要重新计算。`)
}

console.log('\n=== 解法：时间作为动态上下文 ===')
{
  const 提示 = 建注册表()
  提示.上下文({ 名字: 'time', 顺序: 0, 文本: () => `现在是 ${new Date().toISOString()}。` })
  const 第一步prompt = 提示.组装()
  const 第一步快照 = 提示.组装上下文()
  await 等一下()
  const 第二步prompt = 提示.组装()
  const 第二步快照 = 提示.组装上下文()
  console.log(`  两个 step 的 system prompt 一样吗？ ${第一步prompt === 第二步prompt ? '★ 一样，缓存前缀完整' : '不一样'}`)
  console.log(`  两个 step 的快照一样吗？           ${第一步快照 === 第二步快照 ? '一样' : '不一样，会作为新的一条 user 消息追加'}`)
}

console.log('\n=== 去重：上下文没变就不重发 ===')
{
  const 提示 = 建注册表()
  提示.上下文({ 名字: 'branch', 顺序: 0, 文本: '当前分支是 main。' })
  let 上次
  const 试一步 = 第几步 => {
    const 快照 = 提示.组装上下文()
    if (快照 === (上次 ?? '')) { console.log(`  step ${第几步}：和上次一样，不发`); return }
    console.log(`  step ${第几步}：发一条 user 消息`)
    上次 = 快照
  }
  试一步(1); 试一步(2); 试一步(3)
}

console.log('\n=== 从"有"变成"没有"：必须显式说一声 ===')
{
  const 提示 = 建注册表()
  let 还在git仓库里 = true
  提示.上下文({ 名字: 'branch', 顺序: 0, 文本: () => (还在git仓库里 ? '当前分支是 main。' : '') })
  console.log(`  step 1 的快照：${提示.组装上下文().split('\n').at(-1)}`)
  还在git仓库里 = false
  const 快照 = 提示.组装上下文()
  console.log(`  step 2 的快照：${快照 === '' ? `（空）→ 要发的是："${快照已清空}"` : 快照}`)
  console.log('  什么都不发的话，模型会继续拿 step 1 那份当真。')
}
