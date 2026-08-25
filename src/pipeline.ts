// 阶段 4.4：工具执行的三段管线。
//
// 到 4.3 为止，"执行一个工具"就是 `await tool.execute(参数)` 一行。
// 六个工具之后，有四件事没人管：谁都可能卡住整个 agent（只有 bash 有超时）、
// 谁都可能吐出巨量输出（三种工具三套截断）、没有任何权限、也没法知道每次调用花了多久。
//
// 这个文件把这些**横切关注点**从工具里抽出来，做成所有工具共用的一层。

import { tools } from './tool.ts'

/** 一次工具调用的身份：这三样在整条管线里都不变。 */
export interface 执行上下文 {
  /** 模型要调用的工具名。 */
  readonly 工具名: string
  /** 已解析的参数。**未校验**——校验仍然是每个工具自己的责任。 */
  readonly 参数: Record<string, unknown>
  /** 取消信号。工具应当观察它，能被打断的工具必须被打断。 */
  readonly signal: AbortSignal
}

/**
 * 执行前的决定。
 *
 * 没有"待定"这一档：一个护栏要么放行要么拒绝。**拿不准就是拒绝**——
 * dsh 把这条写得更明确：`pre-execute` 可以返回 `ask`（问用户），
 * 但**当这套装配里没有审批能力时，`ask` 直接变成拒绝**，而不是变成放行。
 */
export type 执行前决定 = { 放行: true } | { 放行: false, 理由: string }

/** 一层护栏。三个钩子都是可选的，只挂自己关心的那个。 */
export interface 护栏 {
  /** 出现在日志和拒绝理由里，所以要能让人看懂是谁拦的。 */
  名字: string
  /**
   * 执行之前：放行或拒绝。
   * @param 上下文 - 待执行的调用。
   * @returns 放行或带理由的拒绝。
   */
  执行前?(上下文: 执行上下文): Promise<执行前决定> | 执行前决定
  /**
   * 执行之后：可以原样返回，也可以改写结果。
   * @param 上下文 - 刚跑完的调用。
   * @param 结果 - 工具的返回值，**或者它失败时的错误文本**。
   * @returns 最终喂给模型的文本。
   */
  执行后?(上下文: 执行上下文, 结果: string): Promise<string> | string
}

/**
 * 任何一次工具调用的时间上限。
 *
 * 这和 bash 自己那个超时是**两回事**：bash 的超时回答"一条命令跑多久算久"，
 * 这个回答"任何工具都不许卡住整个 agent"。两层预算，两个问题。
 * dsh 也是两层：shell 的 `timeoutMs` 在提供者里，
 * `dsh-tool-call-timeout-policy` 是挂在 `tools/execute` 上的一个环绕包装器。
 */
export const 默认工具超时毫秒 = 60_000

/**
 * 按顺序跑所有护栏的执行前钩子。
 *
 * **失败即拒绝**：一个钩子自己抛异常，结果是拒绝执行，不是放行。
 * 护栏坏掉的时候，"什么都不拦"是最糟的结果。
 * @param 护栏们 - 按顺序求值的护栏。
 * @param 上下文 - 待执行的调用。
 * @returns 第一个拒绝，或者全部放行。
 */
async function 跑执行前(护栏们: readonly 护栏[], 上下文: 执行上下文): Promise<执行前决定> {
  for (const 一层 of 护栏们) {
    if (一层.执行前 === undefined) continue
    let 决定: 执行前决定
    try {
      决定 = await 一层.执行前(上下文)
    } catch (错误) {
      return { 放行: false, 理由: `护栏「${一层.名字}」自己出错了：${错误 instanceof Error ? 错误.message : String(错误)}` }
    }
    if (!决定.放行) return { 放行: false, 理由: `被护栏「${一层.名字}」拒绝：${决定.理由}` }
  }
  return { 放行: true }
}

/**
 * 按顺序跑所有护栏的执行后钩子，每一层看到的是上一层的产出。
 *
 * 这里**不**失败即拒绝：结果已经产生了，一个记账用的钩子挂掉不该把它吃掉。
 * dsh 对应的规则是 `tools/result` 那一档"监听器的失败被隔离"。
 * @param 护栏们 - 按顺序求值的护栏。
 * @param 上下文 - 刚跑完的调用。
 * @param 原始结果 - 工具的返回值或错误文本。
 * @returns 逐层加工之后的最终文本。
 */
async function 跑执行后(护栏们: readonly 护栏[], 上下文: 执行上下文, 原始结果: string): Promise<string> {
  let 结果 = 原始结果
  for (const 一层 of 护栏们) {
    if (一层.执行后 === undefined) continue
    try {
      结果 = await 一层.执行后(上下文, 结果)
    } catch (错误) {
      console.error(`[护栏 ${一层.名字} 的执行后钩子出错，已忽略] ${错误 instanceof Error ? 错误.message : String(错误)}`)
    }
  }
  return 结果
}

/**
 * 执行一次工具调用，全程走护栏。
 *
 * 三段：**执行前**（放行/拒绝）→ **执行**（带超时和取消）→ **执行后**（加工结果）。
 * 所有失败——找不到工具、参数不是合法 JSON、被拒绝、超时、工具自己抛错——
 * 都变成**给模型看的文本**而不是异常（3.3 的规矩），并且**都会经过执行后钩子**：
 * 失败也是结果，截断和记账对它一样适用。
 * @param 名字 - 模型要调用的工具名。
 * @param 参数JSON - 模型生成的参数文本，未解析。
 * @param 护栏们 - 这次装配启用的护栏，按顺序。
 * @param 超时毫秒 - 这次调用的时间上限。
 * @returns 喂回给模型的文本。
 */
export async function 执行工具(
  名字: string,
  参数JSON: string,
  护栏们: readonly 护栏[],
  超时毫秒: number = 默认工具超时毫秒,
): Promise<string> {
  const tool = tools.find(t => t.name === 名字)
  if (tool === undefined) return `错误：不存在名为 ${名字} 的工具。可用工具：${tools.map(t => t.name).join(', ')}`

  let 参数: Record<string, unknown>
  try {
    参数 = JSON.parse(参数JSON) as Record<string, unknown>
  } catch (错误) {
    return `错误：参数不是合法的 JSON（${错误 instanceof Error ? 错误.message : String(错误)}）。收到的原文：${参数JSON}`
  }

  const 控制器 = new AbortController()
  const 上下文: 执行上下文 = { 工具名: 名字, 参数, signal: 控制器.signal }

  const 决定 = await 跑执行前(护栏们, 上下文)
  if (!决定.放行) return await 跑执行后(护栏们, 上下文, `错误：${决定.理由}`)

  const 定时器 = setTimeout(() => { 控制器.abort(new Error(`工具执行超过 ${超时毫秒}ms`)) }, 超时毫秒)
  let 结果: string
  try {
    结果 = await tool.execute(参数, 上下文.signal)
    // 取消是**合作式**的：signal 一响，工具怎么反应由它自己决定。
    // bash 会杀掉子进程然后**正常返回**一个"被 SIGKILL 了"的结果——
    // 对模型来说那是一句没头没脑的话，它不知道是谁杀的、为什么杀。
    // 所以中止过的调用一律由管线改写结果：**谁施加的限制，谁负责解释**。
    if (控制器.signal.aborted) 结果 = `错误：工具 ${名字} 超过了 ${超时毫秒}ms 的时间上限，已被中止。\n[中止前拿到的输出]\n${结果}`
  } catch (错误) {
    结果 = 控制器.signal.aborted
      ? `错误：工具 ${名字} 超过了 ${超时毫秒}ms 的时间上限，已被中止。`
      : `错误：${错误 instanceof Error ? 错误.message : String(错误)}`
  } finally {
    clearTimeout(定时器)
  }

  return await 跑执行后(护栏们, 上下文, 结果)
}
