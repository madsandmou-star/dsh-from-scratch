// 阶段 6.1：把"发生了什么"和"发给模型什么"拆开。
//
// 到阶段 5 为止，`messages` 数组一个人干三件事：
//   ① 发给模型的请求内容  ② 给用户显示的对话  ③ "发生过什么"的记录
// 三个角色共用一个可变数组，所以谁改了它另外两个都跟着变——1.4 那句
// `while (messages.length > rollbackTo) pop()` 就是一次抹掉了三样东西。
//
// 这个文件让**日志**成为唯一的权威：发生什么就追加一条，永不修改。
// 请求内容由 deriveMessages() 从日志投影出来。

import type { Message, ToolCall } from './types.ts'

/**
 * 会话里可能发生的事情，以及每种事情要记下什么。
 *
 * 这是一张**可扩展的表**：后面每加一个功能（压缩、分支、权限审批）都会往里加一项，
 * 而不是去改已有项的含义。dsh 里对应的东西叫 `SessionEventMap`，
 * 靠 TypeScript 的 declaration merging 让每个插件都能往里加自己的事件类型。
 */
export interface SessionEventMap {
  /** 一个 turn 开始了。它是边界标记，本身不产生任何模型可见的内容。 */
  'turn/start': { turn: number }
  /** 用户说了一句话。 */
  'user/message': { text: string }
  /** 运行时上下文快照（5.3）。它在 wire 上是 user role，但来源不是用户。 */
  'context/snapshot': { text: string }
  /** 模型这一步的产出：文本、和/或它要求的工具调用。 */
  'assistant/message': { turn: number, step: number, text: string | null, toolCalls?: ToolCall[] }
  /** 一次工具调用**开始**了。和 `tool/result` 分开记，才能看出"开始了但没结束"。 */
  'tool/call': { callId: string, name: string, arguments: string }
  /** 一次工具调用的结果。`callId` 把它和上面那条配对。 */
  'tool/result': { callId: string, content: string }
}

/** 事件类型名。 */
export type SessionEventType = keyof SessionEventMap

/**
 * 日志里的一条记录。
 *
 * `seq` 是**会话内单调递增**的序号：它让"这条比那条早"成为一个可比较的事实，
 * 而不是靠数组下标——下标会随着数组被改而失效，seq 不会（因为日志不改）。
 */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    seq: number
    /** Unix 毫秒。重放时间线、算耗时都靠它。 */
    time: number
    data: SessionEventMap[K]
  }
}[T]

/** 追加一条事件之后被通知的订阅者。 */
export type SessionListener = (event: SessionEvent) => void

/**
 * 一次会话：一条只增不改的事件日志。
 *
 * 只有一个写入口 {@link append}，而且它**只追加**——没有任何方法能改掉或删掉
 * 已经追加的事件。这条限制是后面一切的地基：能重放、能审计、能崩溃后恢复，
 * 都是因为历史不会在你背后变。
 */
export class Session {
  private readonly log: SessionEvent[] = []
  private readonly listeners = new Set<SessionListener>()

  /** 已经发生的全部事情，按发生顺序。调用方只读。 */
  get events(): readonly SessionEvent[] {
    return this.log
  }

  /**
   * 追加一条事件，然后同步广播给所有订阅者。
   *
   * 顺序是**先入日志、再广播**：订阅者被叫醒时，它要的那条事件已经在日志里了。
   * 反过来的话，一个订阅者去查日志会发现"通知我的那条还没到"。
   * @param type - 事件类型。
   * @param data - 这类事件要记的内容。
   * @returns 刚追加的那条事件（带上分配好的 seq）。
   */
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T]): SessionEvent<T> {
    const event = { type, seq: this.log.length, time: Date.now(), data } as SessionEvent<T>
    this.log.push(event)
    for (const listener of this.listeners) listener(event)
    return event
  }

  /**
   * 订阅"有新事件了"。
   * @param listener - 每追加一条就被调用一次。
   * @returns 取消订阅的函数。
   */
  on(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/** 工具调用开始了但结果没落日志时，补出来的结果里带的码。 */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/** 模型要求了调用，但连"开始执行"都没记下来时，补出来的结果里带的码。 */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'

/**
 * 把事件日志投影成发给模型的 messages。
 *
 * "投影"这个词是认真的：日志是权威，messages 是它的一个**视图**。
 * 换一种投影规则（压缩、隐藏某些工具结果、只给 subagent 看一部分），
 * 日志一个字都不用动——阶段 12 会真的换。
 *
 * 这里还做一件 1.4 靠回滚做的事：**补齐**。一个 turn 中途失败时，日志里会留下
 * "模型要求调用 X"但没有对应结果的记录。那种 messages 是**非法的**，供应商会
 * 直接 400。回滚的做法是把它们删掉（连同别的三样东西一起）；投影的做法是
 * 给每个没有结果的调用补一条合成的结果，说明它为什么没有结果。
 * @param events - 全部日志。
 * @param systemPrompt - 这一次组装出来的 system prompt（5.1）。
 * @returns 可以直接发给模型的 messages。
 */
export function deriveMessages(events: readonly SessionEvent[], systemPrompt: string): Message[] {
  const messages: Message[] = [{ role: 'system', content: systemPrompt }]
  // 已经落了结果的 callId，用来判断哪些调用是悬空的。
  const settled = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool/result') settled.add(event.data.callId)
  }
  // 记录了"开始执行"的 callId：它决定补出来的结果该说哪一句。
  const started = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool/call') started.add(event.data.callId)
  }

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
      case 'tool/call':
        // 边界标记和"调用开始"都不进 messages——它们是给我们自己看的。
        // 但它们必须落日志：没有 tool/call，就分不清"从没开始"和"开始了没结果"。
        break

      case 'user/message':
      case 'context/snapshot':
        messages.push({ role: 'user', content: event.data.text })
        break

      case 'assistant/message': {
        const { text, toolCalls } = event.data
        messages.push({
          role: 'assistant',
          content: text,
          ...toolCalls === undefined || toolCalls.length === 0 ? {} : {
            // 我们的 ToolCall 是扁的 { id, name, arguments }，wire 上要的是嵌套的
            // { id, type, function: { name, arguments } }。这一层翻译只发生在这里：
            // 日志存"这件事是什么"，wire 格式是它的投影，换供应商只换这几行。
            // `type: 'function'` 不用写 `as const`——它直接嵌在 messages.push() 的实参里，
            // 编译器从 Message['tool_calls'] 推得出这里要的是字面量类型。
            // dsh 的 `dsh/packages/llm/llm-deepseek/src/serialize.ts` 先赋给局部变量，
            // 没有这个上下文，所以那边必须写 `as const`。
            tool_calls: toolCalls.map(call => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          },
        })
        // 补齐：这一条要求的调用里，没有结果的那些，就地补一条。
        for (const call of toolCalls ?? []) {
          if (settled.has(call.id)) continue
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: started.has(call.id)
              ? `错误：${TOOL_OUTCOME_UNKNOWN} —— 这次调用开始执行了，但结果没有被记录下来（多半是进程中途退出）。`
              : `错误：${TOOL_NOT_STARTED} —— 这次调用没有被执行。`,
          })
        }
        break
      }

      case 'tool/result':
        messages.push({ role: 'tool', tool_call_id: event.data.callId, content: event.data.content })
        break
    }
  }
  return messages
}

/**
 * 把一条事件压成一行，用来打日志看。
 *
 * 单独抽出来是因为**日志和它的投影必须能并排看**：出问题时你要回答的问题是
 * "日志里有的东西，投影出来了吗、投影对了吗"，两边都得是一行一条。
 * @param event - 要摘要的事件。
 * @returns 一行文本，不含换行（换行被替成 `⏎`）。
 */
export function summarizeEvent(event: SessionEvent): string {
  const oneLine = (text: string): string => text.replace(/\n/g, ' ⏎ ')
  switch (event.type) {
    case 'turn/start':
      return `turn ${event.data.turn}`
    case 'user/message':
    case 'context/snapshot':
      return oneLine(event.data.text)
    case 'assistant/message': {
      const said = event.data.text === null ? '(不说话)' : oneLine(event.data.text)
      const asked = (event.data.toolCalls ?? []).map(call => ` → ${call.name}#${call.id}`).join('')
      return `step ${event.data.step}  ${said}${asked}`
    }
    case 'tool/call':
      return `${event.data.name}#${event.data.callId} 开始`
    case 'tool/result':
      return `#${event.data.callId} ← ${oneLine(event.data.content)}`
  }
}
