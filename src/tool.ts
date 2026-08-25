// 阶段 3.3：工具的定义与执行。
//
// 一个工具是四样东西：名字、描述、参数格式、执行函数。
// 前三样是给**模型**看的（会被塞进请求的 tools 字段），第四样是给我们自己跑的。

import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolve, relative, isAbsolute } from 'node:path'

/** 一个工具的完整定义。 */
export interface Tool {
  /** 模型用这个名字发起调用。 */
  name: string
  /**
   * 给模型看的说明——**它是提示词，不是文档**。
   * 写清"什么时候用"比写清"做什么"更重要（3.1 讲过）。
   */
  description: string
  /** JSON Schema：模型据此生成参数。 */
  parameters: Record<string, unknown>
  /**
   * 执行工具。
   * @param args - 模型生成的参数，**已解析但未校验**——校验是每个工具自己的责任。
   * @returns 给模型看的文本结果。不是给人看的，所以不要加颜色、进度条、装饰性排版。
   */
  execute(args: Record<string, unknown>): Promise<string>
  /**
   * 可选：把执行结果压成一行**给人看**的摘要。
   *
   * `execute` 的返回值是给模型的，通用的"取首行"规则对它未必合适——
   * bash 就是反例：首行可能是 `[stderr]`，真正有用的是最后那几行。
   * 谁最清楚自己的输出长什么样，谁就该负责它怎么显示。
   * dsh 把这条做成了工具定义的一部分（`presentCall` / `presentResult`），阶段 12 讲。
   * @param 结果 - `execute` 的返回值。
   * @returns 一行摘要。
   */
  摘要?(结果: string): string
}

/** 工作目录：所有文件访问都被限制在它之内。 */
const 工作目录 = process.cwd()

/**
 * 把模型给的参数里的一个字段取出来并确认它是非空字符串。
 * 模型生成的 JSON 是不可信输入：字段可能缺、可能是数字、可能是 null。
 * @param args - 已解析的参数对象。
 * @param 字段名 - 要取的字段。
 * @returns 该字段的字符串值。
 */
function 取字符串(args: Record<string, unknown>, 字段名: string): string {
  const 值 = args[字段名]
  if (typeof 值 !== 'string' || 值 === '') {
    throw new Error(`参数 ${字段名} 必须是非空字符串，实际收到：${JSON.stringify(值)}`)
  }
  return 值
}

/**
 * 把模型给的路径解析成绝对路径，并确认它没有逃出工作目录。
 *
 * 模型完全可能生成 `../../../etc/passwd`——不是因为它有恶意，而是因为它在猜路径。
 * 这道检查属于"外部输入必须在边界上校验"那条规矩（阶段 0 学的）。
 * @param 相对路径 - 模型给的路径。
 * @returns 工作目录之内的绝对路径。
 */
function 解析路径(相对路径: string): string {
  const 绝对路径 = resolve(工作目录, 相对路径)
  const 相对于工作目录 = relative(工作目录, 绝对路径)
  if (相对于工作目录.startsWith('..') || isAbsolute(相对于工作目录)) {
    throw new Error(`路径越界：${相对路径} 解析后落在工作目录之外`)
  }
  return 绝对路径
}

/** 一次最多读多少字节，防止一个大文件把上下文撑爆。 */
const 最大字节数 = 50_000

/** 读文件工具。 */
export const readTool: Tool = {
  name: 'read',
  description: '读取一个文本文件的内容，返回带行号的文本。当用户询问某个文件里有什么、'
    + '某段代码怎么实现，或者你需要基于文件内容回答问题时使用。路径相对于当前工作目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对于当前工作目录的文件路径，例如 src/llm.ts' },
    },
    required: ['path'],
  },
  async execute(args) {
    const 路径 = 解析路径(取字符串(args, 'path'))
    const 内容 = await readFile(路径, 'utf8')

    // 加行号：后续的 edit 工具要靠行号定位，而且模型引用某一行时也需要它。
    // 这是"工具输出是给模型看的"的一个具体例子——人读文件不需要行号，模型需要。
    const 行 = 内容.split('\n')
    const 带行号 = 行.map((行内容, i) => `${String(i + 1).padStart(4)}: ${行内容}`).join('\n')

    if (带行号.length > 最大字节数) {
      return `${带行号.slice(0, 最大字节数)}\n\n[文件过大，已截断到 ${最大字节数} 字节，共 ${行.length} 行]`
    }
    return 带行号
  },
}

/** 写文件工具。 */
export const writeTool: Tool = {
  name: 'write',
  description: '把内容写入一个文件（覆盖已有内容，不存在则创建）。'
    + '**覆盖会丢失原有内容**，所以修改已存在的文件时优先用 edit，只有创建新文件或整体重写时才用 write。'
    + '路径相对于当前工作目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对于当前工作目录的文件路径' },
      content: { type: 'string', description: '要写入的完整文件内容' },
    },
    required: ['path', 'content'],
  },
  async execute(args) {
    const 路径 = 解析路径(取字符串(args, 'path'))
    const 内容 = args['content']
    // content 可以是空字符串（清空文件是合法操作），所以不能用 取字符串。
    if (typeof 内容 !== 'string') {
      throw new Error(`参数 content 必须是字符串，实际收到：${JSON.stringify(内容)}`)
    }

    // 覆盖是不可逆的，所以要把"覆盖了多少"报告给模型——它可能因此发现自己搞错了文件。
    const 原有字节数 = await readFile(路径, 'utf8').then(内容 => 内容.length, () => undefined)

    await mkdir(dirname(路径), { recursive: true })
    await writeFile(路径, 内容, 'utf8')

    return 原有字节数 === undefined
      ? `已创建 ${取字符串(args, 'path')}（${内容.length} 字符）`
      : `已覆盖 ${取字符串(args, 'path')}（原 ${原有字节数} 字符 → 现 ${内容.length} 字符）`
  },
}

/**
 * 找出 old_string 在文件里的**每一处**位置。
 *
 * 报"出现了几次"不够——模型还得知道是哪几行，才能决定多带哪一段上下文。
 * 给模型的错误信息里应该带上它改正所需要的全部信息（dsh 的 `str_replace` 也这么做）。
 * @param 内容 - 文件全文。
 * @param 目标 - 要找的字面文本。
 * @returns 每一次出现的字符下标，从小到大。
 */
function 找出所有位置(内容: string, 目标: string): number[] {
  const 位置们: number[] = []
  let 起点 = 0
  for (;;) {
    const 位置 = 内容.indexOf(目标, 起点)
    if (位置 < 0) return 位置们
    位置们.push(位置)
    // 从这次匹配的末尾继续找：重叠的匹配（比如在 "aaa" 里找 "aa"）只算一次。
    起点 = 位置 + 目标.length
  }
}

/** 编辑文件工具：唯一字面匹配替换。 */
export const editTool: Tool = {
  name: 'edit',
  description: '把文件中的一段文本替换成另一段。old_string 必须在文件中**恰好出现一次**——'
    + '如果它出现多次，请在 old_string 里多带上下文（前后各几行）让它变得唯一。'
    + '修改已存在的文件时优先用这个工具，而不是 write，因为它不会碰到文件的其余部分。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对于当前工作目录的文件路径' },
      old_string: { type: 'string', description: '要被替换掉的原文，必须在文件中恰好出现一次' },
      new_string: { type: 'string', description: '替换成的新文本' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args) {
    const 相对路径 = 取字符串(args, 'path')
    const 路径 = 解析路径(相对路径)
    const old_string = 取字符串(args, 'old_string')
    const new_string = args['new_string']
    if (typeof new_string !== 'string') {
      throw new Error(`参数 new_string 必须是字符串，实际收到：${JSON.stringify(new_string)}`)
    }

    // 两段一模一样的文本，替换必然是空操作。这不是"没事发生"，是模型算错了：
    // 它以为自己改了东西。让它立刻知道，比让它继续往下走要好。
    if (old_string === new_string) {
      throw new Error('old_string 和 new_string 完全相同，这次替换不会改变任何东西。')
    }

    const 内容 = await readFile(路径, 'utf8')

    // 唯一匹配是这个工具的核心契约。数出现位置而不是直接 replace：
    // replace 只换第一处，模型会以为全换了；replaceAll 又可能改到不该改的地方。
    // 两种失败要报出不同的错，因为模型的改正动作完全不同。
    const 出现位置 = 找出所有位置(内容, old_string)
    if (出现位置.length === 0) {
      throw new Error(`old_string 在 ${相对路径} 中没有找到。请先用 read 确认原文（注意空格、缩进和换行必须完全一致）。`)
    }
    if (出现位置.length > 1) {
      const 行号 = 出现位置.map(位置 => 内容.slice(0, 位置).split('\n').length)
      throw new Error(
        `old_string 在 ${相对路径} 中出现了 ${出现位置.length} 次（第 ${行号.join('、')} 行），必须恰好一次。`
        + '请在 old_string 里多带上前后几行上下文，让它变得唯一。',
      )
    }

    await writeFile(路径, 内容.replace(old_string, new_string), 'utf8')
    return `已修改 ${相对路径}（替换了 ${old_string.length} 字符 → ${new_string.length} 字符）`
  },
}

/** 一条命令最多跑多久。超过就杀掉——模型不会自己发现"卡住了"。 */
const 默认超时毫秒 = 30_000

/** 一条命令的输出最多往上下文里塞多少字节。 */
const 最大输出字节数 = 30_000

/**
 * 只保留末尾若干字节的输出收集器。
 *
 * 边收边裁，所以内存有上界：`yes` 这种命令一秒能产出几十 MB，
 * 等收完再裁已经晚了。保留**末尾**而不是开头，因为命令的错误信息几乎总在最后。
 */
class 尾部收集器 {
  private 文本 = ''
  private 丢弃过 = false

  /**
   * 追加一块输出，超出上限时从头部丢弃。
   * @param 块 - 子进程新产出的一段文本。
   */
  加(块: string): void {
    this.文本 += 块
    if (this.文本.length > 最大输出字节数) {
      this.文本 = this.文本.slice(-最大输出字节数)
      this.丢弃过 = true
    }
  }

  /**
   * 取出收集到的文本，并在截断过时附上明确说明。
   * @returns 给模型看的这一路输出。
   */
  取(): string {
    return this.丢弃过 ? `[前面的输出已被丢弃，只保留末尾 ${最大输出字节数} 字节]\n${this.文本}` : this.文本
  }
}

/** 一次命令执行的结果。非零退出**不是异常**，是一个正常的结果值。 */
interface 命令结果 {
  stdout: string
  stderr: string
  退出码: number | null
  信号: NodeJS.Signals | null
  超时: boolean
}

/**
 * 跑一条 bash 命令并收集它的输出。
 *
 * 每次调用都是**全新的 shell**：`cd`、变量、函数都不会留到下一次。
 * 想换目录就用 workdir 参数——这是 dsh 的 bash 工具在描述里明确告诉模型的同一件事。
 * @param 命令 - 交给 `bash -c` 的命令行。
 * @param 工作路径 - 子进程的工作目录。
 * @param 超时毫秒 - 超过这个时间就 SIGKILL。
 * @returns 输出、退出码、以及是否因超时被杀。
 */
function 跑命令(命令: string, 工作路径: string, 超时毫秒: number): Promise<命令结果> {
  return new Promise(完成 => {
    const 子进程 = spawn('bash', ['-c', 命令], { cwd: 工作路径 })
    const 标准输出 = new 尾部收集器()
    const 标准错误 = new 尾部收集器()
    let 超时 = false

    子进程.stdout.setEncoding('utf8')
    子进程.stderr.setEncoding('utf8')
    子进程.stdout.on('data', (块: string) => { 标准输出.加(块) })
    子进程.stderr.on('data', (块: string) => { 标准错误.加(块) })

    // SIGKILL 而不是 SIGTERM：命令可以捕获 SIGTERM 然后赖着不走，
    // 而超时的意义就是"无论如何都要停下"。代价是它没机会清理，这里接受这个代价。
    const 定时器 = setTimeout(() => { 超时 = true; 子进程.kill('SIGKILL') }, 超时毫秒)

    // 'close' 而不是 'exit'：exit 在进程退出时就触发，此时 stdout 可能还没读完。
    // close 保证所有输出流都已经关闭——少了这一条，长输出的末尾会莫名其妙丢掉。
    子进程.on('close', (退出码, 信号) => {
      clearTimeout(定时器)
      完成({ stdout: 标准输出.取(), stderr: 标准错误.取(), 退出码, 信号, 超时 })
    })
  })
}

/**
 * 把一次执行结果拼成给模型看的文本。
 *
 * 关键决定：**非零退出码不抛异常**，而是作为标记附在输出末尾。
 * `grep` 没找到东西就退 1，`test` 判假也退 1——这些都不是故障，是结果。
 * 该怎么反应由模型决定，工具只负责如实报告（dsh 的 bash 工具是同一条规矩）。
 * @param 结果 - 一次执行的完整结果。
 * @param 超时毫秒 - 本次生效的超时值，用于写进超时标记。
 * @returns stdout、标了记的 stderr、以及退出状态标记。
 */
function 组装输出(结果: 命令结果, 超时毫秒: number): string {
  let 正文 = 结果.stdout
  if (结果.stderr !== '') {
    if (正文 !== '' && !正文.endsWith('\n')) 正文 += '\n'
    // stderr 要标出来。混在一起模型分不清哪句是结果、哪句是警告。
    正文 += `[stderr]\n${结果.stderr}`
  }
  if (正文 === '') 正文 = '(没有输出)'

  const 标记: string[] = []
  if (结果.超时) 标记.push(`[超时：跑满 ${超时毫秒}ms 后被杀掉]`)
  if (结果.信号 !== null) 标记.push(`[被信号杀掉：${结果.信号}]`)
  else if (结果.退出码 !== 0) 标记.push(`[退出码：${结果.退出码}]`)

  if (标记.length === 0) return 正文
  if (!正文.endsWith('\n')) 正文 += '\n'
  return 正文 + 标记.join('\n')
}

/**
 * 跑 bash 命令的工具。
 *
 * XXX(权限)：这个工具现在什么都拦不住——`rm -rf ~` 会照跑不误。
 * 阶段 15 会加上审批，届时拦截点不在这个工具里，而在统一的执行前钩子上。
 */
export const bashTool: Tool = {
  name: 'bash',
  description: '执行一条 bash 命令（`bash -c`）并返回它的 stdout/stderr。'
    + '每次调用都是**全新的 shell**：cd、变量、函数都不会留到下一次，要换目录请用 workdir 参数而不是 cd。'
    + '非零退出会以 `[退出码：N]` 的形式报告。输出过长时只保留末尾。'
    + '读文件请优先用 read（它带行号），改文件请优先用 edit——bash 用来跑那些没有专门工具的事：'
    + '测试、构建、git、查进程。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令行' },
      description: { type: 'string', description: '一句话说明这条命令要做什么，例如"跑单元测试"' },
      workdir: { type: 'string', description: '可选：命令的工作目录，相对于当前工作目录' },
      timeout_ms: { type: 'number', description: `可选：超时毫秒数，默认 ${默认超时毫秒}` },
    },
    required: ['command', 'description'],
  },
  async execute(args) {
    const 命令 = 取字符串(args, 'command')
    // description 是必填的，但工具本身不用它。要它是为了让模型**说出意图**：
    // 阶段 15 的审批弹窗要拿它给用户看，而且被迫写一句话本身就会让模型少乱来。
    取字符串(args, 'description')

    const 工作路径 = args['workdir'] === undefined ? 工作目录 : 解析路径(取字符串(args, 'workdir'))

    // 默认值在这里显式取，而不是藏在 跑命令() 里的 `?? 默认超时毫秒`。
    // dsh 把这条做成了一条明规矩：resolve(request) → spec 是一步独立的解析，
    // 调用方能看见最终生效的值是什么（`ShellExecRequest` → `ShellExecSpec`）。
    const 超时原值 = args['timeout_ms']
    if (超时原值 !== undefined && (typeof 超时原值 !== 'number' || !Number.isFinite(超时原值) || 超时原值 <= 0)) {
      throw new Error(`参数 timeout_ms 必须是正数，实际收到：${JSON.stringify(超时原值)}`)
    }
    const 超时毫秒 = 超时原值 ?? 默认超时毫秒

    return 组装输出(await 跑命令(命令, 工作路径, 超时毫秒), 超时毫秒)
  },
  摘要(结果) {
    // 命令的结论在末尾：报错的最后一句、以及我们自己附的退出状态标记。
    // `[stderr]` 是分节标题不是内容，滤掉。
    const 行 = 结果.split('\n').filter(行 => 行.trim() !== '' && 行 !== '[stderr]')
    const 末两行 = 行.slice(-2).join(' / ')
    return 行.length > 2 ? `（共 ${行.length} 行）… ${末两行}` : 末两行
  },
}

/** 本课程当前可用的工具。 */
export const tools: Tool[] = [readTool, writeTool, editTool, bashTool]

/**
 * 把工具定义转成 OpenAI 兼容 API 的 `tools` 字段格式。
 * @param tools - 内部工具定义。
 * @returns wire 格式的工具数组。
 */
export function 转成wire格式(tools: Tool[]): unknown[] {
  return tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}
