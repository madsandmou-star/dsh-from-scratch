# 1.4 多轮对话

> 本课目标：写出第一个循环，并看清"对话记忆"这个假象是怎么造出来的。
>
> **跑一下**：`npm run demo demos/01-minimal-agent/02-history-grows.mjs` —— 三轮对话，看每一轮实际发出去多少条消息、多少字节。

## 记忆是客户端造的

模型是无状态的。它不记得你上一句说了什么，也不知道自己上一句说了什么。**所谓多轮对话，就是每一轮都把整个历史重新发一遍。**

```
第 1 轮发：[system, user1]
第 2 轮发：[system, user1, assistant1, user2]
第 3 轮发：[system, user1, assistant1, user2, assistant2, user3]
```

三个直接后果，现在就该记住：

1. **越聊越贵、越聊越慢**：每轮的输入 token 数随历史线性增长。
2. **总有一轮会超出上下文窗口**：这不是"如果"，是"什么时候"。阶段 16 的 compaction 就是为它准备的。
3. **谁决定数组里有什么，谁就决定模型能做什么**：这门课后面所有的复杂度——工具结果、system prompt 组装、注入的上下文、压缩后的摘要——最终都落在"这个数组里该有什么"上。

## 代码：[`src/index.ts`](../../../src/index.ts)

```ts
const messages: Message[] = [
  { role: 'system', content: config.systemPrompt },
]

const rl = createInterface({ input: process.stdin, output: process.stdout })
process.stdout.write('\n你 > ')

for await (const line of rl) {
  const input = line.trim()
  if (input === '/exit') break
  if (input === '') { process.stdout.write('\n你 > '); continue }

  messages.push({ role: 'user', content: input })
  const reply = await chat(messages, config)
  messages.push({ role: 'assistant', content: reply })
  console.log(`\n模型 > ${reply}`)
  process.stdout.write('\n你 > ')
}
```

（上面省掉了错误处理，完整版见源文件。）

顶层 `await` 在 ESM 里是合法的，所以不需要包一个 `main()` 再调用——这也是为什么 [0.2](../../00-env-basics/02-typescript-esm/01-typescript-esm.md) 要先讲模块系统。

### 为什么是 `for await`，不是反复 `rl.question()`

`node:readline/promises` 提供了 `rl.question()`，返回 Promise，看起来更直白。但它有个致命限制：**stdin 一结束，readline 就关闭了，此后每次 `question()` 都抛 `ERR_USE_AFTER_CLOSE`**——哪怕缓冲区里还有没读完的行。

后果是这个 CLI 只能在交互式终端里活着。一旦你想用管道喂输入（自动化测试、录制演示、`echo "你好" | npm run dev`），第二轮就崩。用户按 Ctrl-D 也是同样的崩法。

`for await (const line of rl)` 把输入当成**一个行的流**来迭代，交互式终端和管道输入都成立，流结束就是循环结束——Ctrl-D 自然变成了"退出"。

## 一个真实的坑：失败后要把消息撤回

```ts
try {
  reply = await chat(messages, config)
} catch (error) {
  console.error(`\n[请求失败] ${error instanceof Error ? error.message : String(error)}`)
  messages.pop()   // 把刚才那条 user 消息撤回
  continue
}
```

如果不 `pop()`，历史里就留下一条**没有对应回复的悬空 user 消息**。下一轮请求会把它一起发出去，于是模型看到连着两条 user 消息——有的供应商直接报 400，有的会回答错乱的内容，而你完全想不到问题出在"上一次失败的那轮"。

这类"失败留下了半成品状态"的 bug，在 agent 里会反复出现（工具执行到一半、流式断在中间、进程被杀）。dsh 对它的答案在阶段 12：**不要维护一个可变的 messages 数组，改成追加式的事件日志**——只记录"发生过什么"，模型看到的历史每次从日志投影出来。失败就是没有那条事件，没有半成品可言。

现在先记住这个疼。

## 教 debug：把真正发出去的东西打出来

agent 出问题时，第一反应通常是"模型怎么这么笨"。十有八九不是——是你以为发出去的东西和实际发出去的不一样。

在 `chat()` 调用之前加一行：

```ts
console.dir(messages, { depth: null })
```

要看的三件事：

- **第一条是不是 system**，内容对不对；
- **role 是不是严格交替**（`user` / `assistant` / `user` …），有没有上面说的悬空消息；
- **历史有多长**了——`messages.length` 和大致字数，这是"什么时候会爆上下文"的先兆。

想更进一步就打断点：在 `messages.push` 那行停下来，用 Variables 面板看整个数组的演化。这比日志更适合看"状态是怎么一步步变成现在这样的"。

## 这个循环和 agent loop 差在哪

```
收输入 → assembleContext → 调模型 → 处理结果 → 回到开头
```

这个骨架和 dsh 的 agent loop 是同一个形状。差别全在"处理结果"那一步：

- 我们现在只有一条路：把回复打印出来。
- 真正的 agent 在这里分叉：**模型要求调用工具**时，去执行工具，把结果塞回数组，**不等用户输入就再调一次模型**。

那一分叉就是 agent 与聊天机器人的分界线，是阶段 3 的内容。

dsh 把这个骨架的术语定得很精确（见 [docs/architecture.md](../../../dsh/docs/architecture.md#turn-flow)）：

- 一个 **step** = 一次模型请求 + 它调用的那些工具；
- 一个 **turn** = 零个或多个 step，从输入被认领开始，到没有任何未了结的事为止。

我们的 `while (true)` 一轮 = 一个只有一个 step 的 turn。等到阶段 3 加了工具循环，"一个 turn 里有多个 step"才会真的发生。

---

下一课：[1.5 阶段验收](../05-stage-review/01-stage-review.md)
