// 阶段 1.4：多轮对话 CLI —— 这门课的第一个"循环"。
//
// 跑它：
//   export DEEPSEEK_API_KEY=sk-...
//   node --import tsx src/index.ts
//
// 退出：输入 /exit，或按 Ctrl-C。

import { createInterface } from 'node:readline/promises'
import { loadConfig } from './config.ts'
import { chat } from './llm.ts'
import type { Message } from './types.ts'

const config = loadConfig()

// 模型本身是无状态的：它不记得上一次你说了什么。
// 所谓"多轮对话"，就是每一轮都把**整个历史**重新发一遍。
// 这也是为什么长对话会越来越贵、越来越慢——阶段 16 讲 compaction 时会回到这里。
const messages: Message[] = [
  { role: 'system', content: config.systemPrompt },
]

// readline 接口。用 `for await (const line of rl)` 迭代输入行，而不是反复调 rl.question()：
// question() 在 stdin 结束后就不能再用了（会抛 ERR_USE_AFTER_CLOSE），
// 而迭代写法对交互式终端和管道输入（`echo "你好" | npm run dev`）都成立。
const rl = createInterface({ input: process.stdin, output: process.stdout })

process.stdout.write('\n你 > ')

// 顶层 await：ESM 模块可以直接在模块顶层写 await，不需要包一个 main() 再调用。
for await (const line of rl) {
  const input = line.trim()
  if (input === '/exit') break
  if (input === '') { process.stdout.write('\n你 > '); continue }

  messages.push({ role: 'user', content: input })

  // 这里是整个 agent 的雏形：收输入 → 组装上下文 → 调模型 → 处理结果 → 回到开头。
  // 阶段 3 会在"处理结果"这一步分叉出工具调用，那一分叉就是 agent 与聊天机器人的分界线。
  let reply: string
  try {
    reply = await chat(messages, config)
  } catch (error) {
    // 一次请求失败不该让整个进程崩掉：打印出来，把刚才那条 user 消息撤回，继续下一轮。
    // 不撤回的话，历史里会留下一条没有对应回复的悬空消息，下一次请求会带着它一起发出去。
    console.error(`\n[请求失败] ${error instanceof Error ? error.message : String(error)}`)
    messages.pop()
    process.stdout.write('\n你 > ')
    continue
  }

  messages.push({ role: 'assistant', content: reply })
  console.log(`\n模型 > ${reply}`)
  process.stdout.write('\n你 > ')
}

rl.close()

// 想看清"到底发出去了什么"，在 chat() 调用前加一行：
//   console.dir(messages, { depth: null })
// 这是阶段 1 最有用的一个 debug 手法：agent 出问题时，
// 十有八九不是模型笨，而是你以为发出去的东西和实际发出去的东西不一样。
