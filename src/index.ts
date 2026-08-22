// 阶段 1.4：多轮对话 CLI —— 这门课的第一个"循环"。
//
// 跑它：
//   export DEEPSEEK_API_KEY=sk-...
//   node --import tsx src/index.ts
//
// 退出：输入 /exit，或按 Ctrl-C。

import { createInterface } from 'node:readline/promises'
import { loadConfig } from './config.ts'
import { chatStream } from './llm.ts'
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
  //
  // 流式带来的第一个变化：没有"拿到回复"这个时刻了。
  // 打印和累积同时发生，而"完整回复"要自己攒——攒出来的东西才能进历史。
  process.stdout.write('\n模型 > ')
  let reply = ''
  try {
    for await (const delta of chatStream(messages, config)) {
      process.stdout.write(delta)     // 逐字上屏，不换行
      reply += delta                  // 同时攒完整文本
    }
  } catch (error) {
    // 流式带来的第二个变化：失败时屏幕上已经有半句话了，收不回来。
    // 我们的选择是**不把半句话写进历史**：给用户一个明确的中断标记，然后撤回这一轮。
    // 理由和 2.2 丢弃未终止残片一样——残缺内容进了历史，下一轮模型会拿它当事实。
    console.error(`\n[本轮中断，已丢弃] ${error instanceof Error ? error.message : String(error)}`)
    messages.pop()
    process.stdout.write('\n你 > ')
    continue
  }

  messages.push({ role: 'assistant', content: reply })
  console.log()
  process.stdout.write('\n你 > ')
}

rl.close()

// 想看清"到底发出去了什么"，在 chat() 调用前加一行：
//   console.dir(messages, { depth: null })
// 这是阶段 1 最有用的一个 debug 手法：agent 出问题时，
// 十有八九不是模型笨，而是你以为发出去的东西和实际发出去的东西不一样。
