// 阶段 3.3：工具的定义与执行。
//
// 一个工具是四样东西：名字、描述、参数格式、执行函数。
// 前三样是给**模型**看的（会被塞进请求的 tools 字段），第四样是给我们自己跑的。

import { readFile } from 'node:fs/promises'
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

/** 本课程当前可用的工具。3.4 之后会有更多。 */
export const tools: Tool[] = [readTool]

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
