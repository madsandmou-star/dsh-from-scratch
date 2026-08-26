// 4.4 两个人同时想喊停：换掉 signal 会把用户的取消挤掉，熔合则谁先按都算。
//   node demos/04-tools/11-signal-fusion.mjs
//
// 这个演示不碰课程代码，只用一个假工具——它要说明的是 AbortSignal 本身的一个坑。

/**
 * 一个"工具"：本来要跑 5 秒，但它答应了盯着 signal，随时可以被打断。
 * @param {AbortSignal} signal - 停止按钮的接收端。
 * @returns {Promise<string>} 跑完了，或者被谁打断了。
 */
function 假工具(signal) {
  return new Promise(完成 => {
    const 定时器 = setTimeout(() => 完成('跑完了（5 秒）'), 5000)
    // 取消是**合作式**的：Node 不会替你掐掉任何东西，是干活的人自己答应盯着按钮。
    signal.addEventListener('abort', () => {
      clearTimeout(定时器)
      完成(`被打断了：${signal.reason}`)
    }, { once: true })
  })
}

/** 每次都重新造一个"用户在 500ms 时按 Ctrl-C"。 */
function 用户的取消按钮() {
  const 控制器 = new AbortController()
  setTimeout(() => 控制器.abort('用户按了 Ctrl-C'), 500)
  return 控制器.signal
}

/** 每次都重新造一个"3 秒超时"。 */
function 包装器的超时() {
  const 控制器 = new AbortController()
  setTimeout(() => 控制器.abort('超时 3 秒'), 3000)
  return 控制器.signal
}

console.log('工具本来要跑 5 秒；用户在 500ms 按 Ctrl-C；超时设在 3 秒。\n')

{
  console.log('=== 场景 A：包装器直接把 signal 换成自己的 ===')
  const 用户 = 用户的取消按钮()
  const 开始 = Date.now()
  // 用户那个 signal 造出来了，但工具根本没拿到——它被顶掉了。
  const 结果 = await 假工具(包装器的超时())
  console.log(`  ${结果}（等了 ${Date.now() - 开始}ms）`)
  console.log(`  用户那个按钮按了吗？ ${用户.aborted ? '按了，但没人在听' : '没按'}`)
  console.log('  → 用户按了停止，然后干等了 3 秒。从他的角度看，这个 agent 的停止按钮坏了。\n')
}

{
  console.log('=== 场景 B：注册表把两个熔在一起 ===')
  // AbortSignal.any：这两个里任何一个响了，我就响。
  // dsh 手写了一个等价的 fuseToolSignals()，为的是保住 reason 并清理监听器。
  const 熔合 = AbortSignal.any([用户的取消按钮(), 包装器的超时()])
  const 开始 = Date.now()
  console.log(`  ${await 假工具(熔合)}（等了 ${Date.now() - 开始}ms）`)
  console.log('  → 谁先按都算。包装器加了超时，但拿不走用户的取消权。\n')
}

{
  console.log('=== 场景 C：没人按，超时也没到 ===')
  const 熔合 = AbortSignal.any([new AbortController().signal, 包装器的超时()])
  const 开始 = Date.now()
  console.log(`  ${await 假工具(熔合)}（等了 ${Date.now() - 开始}ms）`)
  console.log('  → 等等，5 秒的活怎么 3 秒就停了？因为超时**也**在那条并联线上。')
  console.log('     这正是熔合的另一半意义：两个按钮都有效，不是只有用户那个有效。')
}
