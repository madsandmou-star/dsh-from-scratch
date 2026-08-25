// 阶段 3.3：工具的定义与执行。
//
// 一个工具是四样东西：名字、描述、参数格式、执行函数。
// 前三样是给**模型**看的（会被塞进请求的 tools 字段），第四样是给我们自己跑的。

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

/** 本课程当前可用的工具。 */
export const tools: Tool[] = [readTool, writeTool, editTool]

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
