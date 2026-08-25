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
import { 记账, 输出兜底, 只读模式 } from './guard.ts'
import { 执行工具 } from './pipeline.ts'
import { tools } from './tool.ts'
import type { Message, ToolCall } from './types.ts'

const config = loadConfig()

// 这一次装配启用哪些护栏——顺序就是执行前钩子的求值顺序。
// 换一套护栏不用改任何工具，也不用改这个循环：这就是 4.4 把它们抽出来的意义。
const 护栏们 = [记账(config.记账), 只读模式(config.只读), 输出兜底()]

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

/**
 * 一个 turn 里最多允许多少个 step。
 *
 * 防的是"模型反复调工具但永远不给最终回答"——它可能陷在一个自己看不出来的循环里
 * （读 A 发现要读 B，读 B 发现要读 A）。没有这个上限，agent 会一直烧钱直到你按 Ctrl-C。
 */
const 最大步数 = 10

/**
 * 跑完一个 turn：不断执行 step，直到模型不再要求调用工具。
 *
 * 一个 **step** = 一次模型请求 + 它这一轮要求的工具执行（1.4 定义过）。
 * 一个 **turn** = 从一条用户输入开始，到没有任何未了结的事为止。
 * 阶段 1 的每个 turn 只有一个 step；工具循环让"一个 turn 多个 step"第一次真的发生。
 */
async function 跑一个turn(): Promise<void> {
  for (let step = 1; step <= 最大步数; step++) {
    process.stdout.write(`\n模型 > `)
    let 文本 = ''
    let 工具调用: ToolCall[] = []

    for await (const event of chatStream(messages, config)) {
      if (event.type === 'text') {
        process.stdout.write(event.text)
        文本 += event.text
        continue
      }
      工具调用 = event.calls
    }

    // 把模型这一轮的产出记进历史。注意 content 可能是 null——模型只调工具不说话时就是这样，
    // 而这条 assistant 消息**必须**进历史：下一轮请求里，每条 tool 结果都要能找到它对应的调用。
    messages.push({
      role: 'assistant',
      content: 文本 === '' ? null : 文本,
      ...工具调用.length === 0 ? {} : {
        tool_calls: 工具调用.map(call => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      },
    })

    // 模型没要求调工具 = 它给出了最终回答 = 这个 turn 结束了。
    if (工具调用.length === 0) { console.log(); return }

    // 执行这一轮的每个工具，结果作为 tool 消息喂回历史。
    for (const call of 工具调用) {
      console.log(`\n  [工具] ${call.name}(${call.arguments})`)
      const 结果 = await 执行工具(call.name, call.arguments, 护栏们)
      // 摘要归工具自己管：通用的"取首行"对 bash 没用（首行可能是 `[stderr]`）。
      const 一行 = tools.find(t => t.name === call.name)?.摘要?.(结果) ?? 结果.split('\n')[0] ?? ''
      console.log(`         → ${一行.slice(0, 90)}${一行.length > 90 ? ' …' : ''}`)
      // tool_call_id 把结果和调用配对。少一条、或者 id 对不上，下一次请求就是非法的。
      messages.push({ role: 'tool', tool_call_id: call.id, content: 结果 })
    }
    // 带着工具结果再问一轮 —— 这就是 tool loop。
  }

  console.error(`\n[已达最大步数 ${最大步数}，停止本轮]`)
}

for await (const line of rl) {
  const input = line.trim()
  if (input === '/exit') break
  if (input === '') { process.stdout.write('\n你 > '); continue }

  const 回滚点 = messages.length
  messages.push({ role: 'user', content: input })

  try {
    await 跑一个turn()
  } catch (error) {
    // 一个 step 失败会让整个 turn 停下。历史里可能留下一条"要求调工具但没有结果"的
    // assistant 消息——那是非法状态，下一轮请求会被供应商拒绝。
    // 这里用最朴素的办法处理：把这个 turn 期间追加的消息全部回滚。
    // 3.5 会讲 dsh 为什么不这么做，以及它的办法是什么。
    console.error(`\n[本轮中断，已回滚] ${error instanceof Error ? error.message : String(error)}`)
    while (messages.length > 回滚点) messages.pop()
  }
  process.stdout.write('\n你 > ')
}

rl.close()

// 想看清"到底发出去了什么"，在 chat() 调用前加一行：
//   console.dir(messages, { depth: null })
// 这是阶段 1 最有用的一个 debug 手法：agent 出问题时，
// 十有八九不是模型笨，而是你以为发出去的东西和实际发出去的东西不一样。
