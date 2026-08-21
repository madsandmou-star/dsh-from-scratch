// 阶段 0 的唯一代码：一个能跑、能被断点停住的文件。
//
// 跑它：
//   node --import tsx src/hello.ts
//   node --import tsx src/hello.ts 你的名字
//
// `--import tsx` 让 Node 在加载模块时先把 TypeScript 转成 JavaScript，
// 所以这个 .ts 文件不需要先编译成 .js 就能直接跑（见 00-env-basics/01-node-pnpm）。

// process 是 Node 提供的全局对象，argv 是启动这个进程的命令行参数数组。
// argv[0] 是 node 可执行文件，argv[1] 是脚本路径，argv[2] 开始才是我们自己传的参数。
const who: string = process.argv[2] ?? 'dsh'

// `?? ` 是空值合并：左边是 null 或 undefined 时才取右边。
// 它和 `||` 的区别在于：空字符串 '' 和 0 会被 `||` 当成假值换掉，`??` 不会。

/**
 * 把名字拼成一句问候。
 * 单独抽成函数只有一个目的：给阶段 0 的断点练习一个可以停下来的地方。
 * @param name - 要问候的对象。
 * @returns 一行问候语。
 */
function greet(name: string): string {
  // 在这一行下断点，然后用调试器看 name 的值（见 00-env-basics/03-debug）。
  return `hello, ${name}`
}

console.log(greet(who))

// 这个进程打印完就自然退出了：没有服务器在监听端口，没有定时器在等待，
// Node 的事件循环里没有任何待办事项，进程就结束。
// 记住这个事实——阶段 7 引入 Cordis 之后，"进程为什么不退出" 会变成一个真实的排查题。
