// 阶段 5.1：system prompt 不是一个常量，是拼出来的。
//
// 阶段 4 结束时，我们把三句"这套装配下该怎么干活"的话塞进了工具描述里：
// "读文件优先用 read"、"别用 bash 里的 grep"、"当前是只读模式"。
// 它们都不在描述某一个工具是什么，塞错了地方——这个文件是它们该待的地方。

/** 一段贡献给 system prompt 的文本。 */
export interface PromptSection {
  /** 唯一名字。重名直接抛错，而不是后来者覆盖前者。 */
  name: string
  /**
   * 拼接顺序，从小到大。
   *
   * 约定（照抄 dsh，因为这个梯子本身就是经验）：
   * `-100` 是 harness 自己的身份，`0` 是部署方给的 persona，`100`–`199` 是工具指引。
   * 留出这么大的间隔，是为了将来在任意两段之间插入新段时不用重新编号。
   */
  order: number
  /**
   * 把这一段当作**完整的** system prompt：组装时其余段落全部丢掉。
   *
   * 组装过程本身照跑不误——变量要解析、动态上下文要拼、工具要排序——
   * 只是最后那一步用这一段顶掉所有段落。同时有两段声明 `complete` 是配置错误。
   */
  complete?: boolean
  /**
   * 段落文本，或者一个每次组装时求值的函数。
   *
   * 允许是函数，是因为有些段落的内容**取决于这次装配**——比如只读模式那段，
   * 开关关掉时它一个字都不该出现。
   */
  text: string | (() => string)
}

/**
 * 一段**动态上下文**：每一轮都可能变的事实（当前时间、git 状态、当前模式）。
 *
 * 它和 {@link PromptSection} 的区别不在内容，在**去向**：提示段拼进 system prompt，
 * 上下文段拼成一条 user 消息追加在这一步的末尾。5.3 讲为什么必须分开。
 */
export interface PromptContext {
  /** 唯一名字，重名抛错。 */
  name: string
  /** 拼接顺序，从小到大。 */
  order: number
  /** 文本或每次组装时求值的函数；求值为空串表示这一轮它没有话要说。 */
  text: string | (() => string)
}

/** 快照非空时的开头。它告诉模型：**旧的那份不算数了**。 */
const SNAPSHOT_PREAMBLE = '当前运行时上下文。这份快照取代之前所有的运行时上下文快照。'

/** 快照从有到无时发的话。不能什么都不发——那样模型会以为旧快照还有效。 */
export const CONTEXT_CLEARED = '当前运行时上下文：没有。之前的运行时上下文快照都不再适用。'

/** 变量名的写法：小写字母开头，后面是小写字母、数字、下划线。 */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** 位于扫描位置的一个完整 `{{...}}` 引用（名字合不合法另外判）。 */
const REFERENCE_AT = /^\{\{([^{}]*)\}\}/

/**
 * 把一段文本里的 `{{变量}}` 换成值。
 *
 * 没有用 `文本.replace(/\{\{(\w+)\}\}/g, ...)` 一行搞定，因为正则替换只能给出一种结果，
 * 而这里有三种**不同的**错误要报，报错还得说清是哪一段里的哪一个引用。
 * @param owner - 出错时告诉作者是哪一段。
 * @param text - 尚未插值的段落文本。
 * @param variables - 这次组装取到的全部变量值。
 * @returns 插值之后的文本。
 */
function interpolate(owner: string, text: string, variables: Map<string, string | undefined>): string {
  let result = ''
  let consumed = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', consumed)) {
    const group = REFERENCE_AT.exec(text.slice(open))
    if (group === null) {
      // 后面还有 `}}` 说明作者想写一个引用但写坏了；否则这个 `{{` 就是普通文字
      // （prompt 里教模型写模板时，真的会出现孤零零的 `{{`）。
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`段落「${owner}」里有写坏的变量引用："${text.slice(open, open + 16)}…"`)
      }
      result += text.slice(consumed, open + 2)
      consumed = open + 2
      continue
    }
    const name = group[1] ?? ''
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`段落「${owner}」里的变量名不合法："{{${name}}}"（要求匹配 ${String(VARIABLE_NAME)}）`)
    }
    if (!variables.has(name)) {
      const known = [...variables.keys()]
      throw new Error(
        `段落「${owner}」引用了未注册的变量 "{{${name}}}"。`
        + `已注册的变量：${known.length > 0 ? known.join('、') : '（一个都没有）'}`,
      )
    }
    const value = variables.get(name)
    if (value === undefined) {
      throw new Error(`变量 "{{${name}}}" 这一次组装没有取到值（段落「${owner}」）`)
    }
    // 拼到 结果 上，而不是回到文本里继续扫——**替换进去的值不再被当成模板扫描**。
    // 否则一个恰好含 `{{...}}` 的变量值会被二次展开：这是 4.3 那个 shell 注入的同一个家族，
    // "别让数据变成代码"在这门课的第三次出现。
    result += text.slice(consumed, open) + value
    consumed = open + group[0].length
  }
  return result + text.slice(consumed)
}

/**
 * system prompt 的注册表：谁都可以往里塞一段，最后按顺序拼起来。
 *
 * 这是 dsh `ctx.systemPrompt.section()` 的手工版。区别在于 dsh 里注册这个动作
 * 属于插件的生命周期（插件卸载，它那段自动消失），我们这里靠调用方自己拿着注销函数。
 */
export class PromptRegistry {
  private readonly sections = new Map<string, PromptSection>()
  private readonly variables = new Map<string, () => string | undefined>()
  private readonly contexts = new Map<string, PromptContext>()
  private contextSuppressed = false

  /**
   * 注册一段。
   *
   * **返回值是注销函数**，不是 void。这是 dsh 那条「注册即效果」的种子：
   * 每一个"贡献"都必须是可撤销的，否则动态装卸插件时就会留下垃圾。
   * @param section - 要注册的段落。
   * @returns 注销这一段的函数。
   */
  register(section: PromptSection): () => void {
    // 重名不是"后者覆盖前者"，是配置错了。静默覆盖会让人查半天为什么某段话不见了。
    if (this.sections.has(section.name)) throw new Error(`system prompt 段落重名：${section.name}`)
    this.sections.set(section.name, section)
    return () => { this.sections.delete(section.name) }
  }

  /**
   * 注册一个变量：段落里写 `{{名字}}`，组装时换成 `取值()` 的返回值。
   *
   * 取值函数**每次组装调用一次**，不是注册时求值一次——`cwd` 这类事实会变，
   * 而且测试里换一个取值函数就能把它固定住，不用去 monkeypatch `process`。
   * @param name - 变量名，写法见 {@link VARIABLE_NAME}。
   * @param provide - 每次组装时求值；返回 undefined 表示"这次没有值"，引用它会报错。
   * @returns 注销这个变量的函数。
   */
  variable(name: string, provide: () => string | undefined): () => void {
    if (!VARIABLE_NAME.test(name)) throw new Error(`变量名不合法：${name}（要求匹配 ${String(VARIABLE_NAME)}）`)
    if (this.variables.has(name)) throw new Error(`变量重名：${name}`)
    this.variables.set(name, provide)
    return () => { this.variables.delete(name) }
  }

  /**
   * 求出这一次组装里每个变量的值。
   *
   * **一次性全部取好**，而不是每段各取一次：同一次组装里，两段读到的 `{{cwd}}`
   * 必须是同一个值，否则拼出来的 prompt 会自相矛盾。
   * @returns 变量名到值的映射；值为 undefined 表示这次取不到。
   */
  private resolveVariables(): Map<string, string | undefined> {
    return new Map([...this.variables].map(([name, provide]) => [name, provide()]))
  }

  /**
   * 把一段的文本求值并插值。
   * @param section - 要渲染的段落。
   * @param values - {@link resolveVariables} 的结果。
   * @returns 这一段最终的文本。
   */
  private renderSection(section: PromptSection, values: Map<string, string | undefined>): string {
    return interpolate(section.name, (typeof section.text === 'string' ? section.text : section.text()).trim(), values)
  }

  /**
   * 按顺序把所有段落拼成最终的 system prompt，并把 `{{变量}}` 换成值。
   *
   * 求值为空字符串的段落被丢掉——这样一个"条件性"的段落（只读模式）
   * 就可以简单地返回空串，而不需要调用方去判断该不该注册它。
   * @returns 最终发给模型的 system prompt。
   */
  assemble(): string {
    const values = this.resolveVariables()
    const ordered = [...this.sections.values()].sort((a, b) => a.order - b.order)

    // 两段都说"我是全部"是配置错误：没有任何规则能决定听谁的。
    const completeOnes = ordered.filter(section => section.complete === true)
    if (completeOnes.length > 1) {
      throw new Error(`同时有多段声明了"完整"：${completeOnes.map(section => section.name).join('、')}`)
    }

    // 注意变量照样插值：`complete` 换掉的是"哪些段进 prompt"，不是"要不要处理模板"。
    const onlyOne = completeOnes[0]
    if (onlyOne !== undefined) return this.renderSection(onlyOne, values)

    return ordered
      .map(section => this.renderSection(section, values))
      .filter(text => text !== '')
      .join('\n\n')
  }

  /**
   * 覆盖一个已经注册过的同名段落。
   *
   * 和 {@link register} 的区别只在**意图**：`register` 撞名字是配置错误（5.1 讲过为什么要抛错），
   * `replace` 撞名字是本来就想干的事。两个动作用两个方法，读代码的人一眼看得出
   * 这里是"我不知道有人占了"还是"我就是要换掉它"。
   * @param section - 新的段落；名字必须已经存在。
   * @returns 把原来那一段放回去的函数。
   */
  replace(section: PromptSection): () => void {
    const previous = this.sections.get(section.name)
    if (previous === undefined) throw new Error(`没有名为 ${section.name} 的段落可替换（要新增请用 注册）`)
    this.sections.set(section.name, section)
    return () => { this.sections.set(section.name, previous) }
  }

  /**
   * 让这次装配不发送任何动态上下文。
   *
   * 和 `complete` 是**两个正交的开关**：一个管 system prompt 里留什么，
   * 一个管要不要发那条运行时快照。dsh 的 persona preset 把两者都暴露成配置项。
   * @returns 恢复动态上下文的函数。
   */
  suppressContext(): () => void {
    this.contextSuppressed = true
    return () => { this.contextSuppressed = false }
  }

  /**
   * 注册一段动态上下文。
   * @param section - 要注册的上下文段。
   * @returns 注销这一段的函数。
   */
  context(section: PromptContext): () => void {
    if (this.contexts.has(section.name)) throw new Error(`上下文段落重名：${section.name}`)
    this.contexts.set(section.name, section)
    return () => { this.contexts.delete(section.name) }
  }

  /**
   * 把所有动态上下文拼成这一轮的快照。
   *
   * 和 {@link assemble} 共用同一份变量快照，所以 system prompt 和上下文里的
   * `{{cwd}}` 一定是同一个值。
   * @returns 快照文本；一段都没有（或全为空）时返回空串。
   */
  assembleContext(): string {
    if (this.contextSuppressed) return ''
    const values = this.resolveVariables()
    const body = [...this.contexts.values()]
      .sort((a, b) => a.order - b.order)
      .map(section => interpolate(section.name, (typeof section.text === 'string' ? section.text : section.text()).trim(), values))
      .filter(text => text !== '')
      .join('\n\n')
    return body === '' ? '' : `${SNAPSHOT_PREAMBLE}\n\n${body}`
  }

  /**
   * 列出当前注册了哪些段落，按拼接顺序。
   *
   * 这是这一课最有用的 debug 手法：**agent 行为不对时，先看它到底收到了什么 system prompt**。
   * @returns 每一段的名字、顺序和字符数。
   */
  inventory(): { name: string, order: number, chars: number, active: boolean }[] {
    const values = this.resolveVariables()
    const ordered = [...this.sections.values()].sort((a, b) => a.order - b.order)
    // 有段落声明了"完整"时，其余段落**不会进 prompt**。清单必须如实反映这件事——
    // 一个会说谎的 debug 工具比没有更糟。
    const completeOnes = ordered.find(section => section.complete === true)
    return ordered.map((section) => {
      const text = this.renderSection(section, values)
      return {
        name: section.name,
        order: section.order,
        chars: text.length,
        active: completeOnes === undefined ? text !== '' : section === completeOnes,
      }
    })
  }
}

/**
 * 部署方 persona 的**具名槽位**。
 *
 * 它是一个导出的常量，而不是各处各写一遍字符串字面量——因为"换掉 persona"这件事
 * 靠的就是**两边用同一个名字**。名字对不上，`替换()` 就变成了"又加了一段"，
 * 于是模型会同时读到两个互相打架的人设。
 */
export const PERSONA_SECTION = 'deployment:persona'

/** persona 槽位的顺序：模型读到的第一段实质内容。 */
export const PERSONA_ORDER = 0

/** harness 自己的身份。它排在最前面，因为它是"你是谁"，其余都是"你该怎么干活"。 */
export const identitySection: PromptSection = {
  name: 'harness:identity',
  order: -100,
  text: '你是一个跑在命令行里的编码助手。你可以读写文件、执行命令、搜索代码。'
    + '回答要简短直接：用户看到的是终端，不是网页。\n'
    + '当前工作目录是 {{cwd}}，所有相对路径都相对于它。你正在以 {{model}} 运行。',
}
