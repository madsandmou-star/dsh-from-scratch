// 阶段 3.3：工具的定义与执行。
//
// 一个工具是四样东西：名字、描述、参数格式、执行函数。
// 前三样是给**模型**看的（会被塞进请求的 tools 字段），第四样是给我们自己跑的。

import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import type { PromptSection } from './system-prompt.ts'
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
   * @param signal - 取消信号（4.4 的统一超时、以及将来用户按下的中断）。
   *   能被打断的工具**必须**观察它；纯计算的工具观察不了，这一点 4.3 的 ReDoS 已经证明过。
   * @returns 给模型看的文本结果。不是给人看的，所以不要加颜色、进度条、装饰性排版。
   */
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<string>
  /**
   * 可选：把执行结果压成一行**给人看**的摘要。
   *
   * `execute` 的返回值是给模型的，通用的"取首行"规则对它未必合适——
   * bash 就是反例：首行可能是 `[stderr]`，真正有用的是最后那几行。
   * 谁最清楚自己的输出长什么样，谁就该负责它怎么显示。
   * dsh 把这条做成了工具定义的一部分（`presentCall` / `presentResult`），阶段 12 讲。
   * @param result - `execute` 的返回值。
   * @returns 一行摘要。
   */
  summarize?(result: string): string
}

/** 工作目录：所有文件访问都被限制在它之内。 */
const CWD = process.cwd()

/**
 * 把模型给的参数里的一个字段取出来并确认它是非空字符串。
 * 模型生成的 JSON 是不可信输入：字段可能缺、可能是数字、可能是 null。
 * @param args - 已解析的参数对象。
 * @param field - 要取的字段。
 * @returns 该字段的字符串值。
 */
function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`参数 ${field} 必须是非空字符串，实际收到：${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 把模型给的路径解析成绝对路径，并确认它没有逃出工作目录。
 *
 * 模型完全可能生成 `../../../etc/passwd`——不是因为它有恶意，而是因为它在猜路径。
 * 这道检查属于"外部输入必须在边界上校验"那条规矩（阶段 0 学的）。
 * @param displayPath - 模型给的路径。
 * @returns 工作目录之内的绝对路径。
 */
function resolveInsideCwd(displayPath: string): string {
  const absolute = resolve(CWD, displayPath)
  const relativeToCwd = relative(CWD, absolute)
  if (relativeToCwd.startsWith('..') || isAbsolute(relativeToCwd)) {
    throw new Error(`路径越界：${displayPath} 解析后落在工作目录之外`)
  }
  return absolute
}

/** 一次最多读多少字节，防止一个大文件把上下文撑爆。 */
const MAX_READ_BYTES = 50_000

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
    const target = resolveInsideCwd(requireString(args, 'path'))
    const content = await readFile(target, 'utf8')

    // 加行号：后续的 edit 工具要靠行号定位，而且模型引用某一行时也需要它。
    // 这是"工具输出是给模型看的"的一个具体例子——人读文件不需要行号，模型需要。
    const lines = content.split('\n')
    const numbered = lines.map((lineText, i) => `${String(i + 1).padStart(4)}: ${lineText}`).join('\n')

    if (numbered.length > MAX_READ_BYTES) {
      return `${numbered.slice(0, MAX_READ_BYTES)}\n\n[文件过大，已截断到 ${MAX_READ_BYTES} 字节，共 ${lines.length} 行]`
    }
    return numbered
  },
}

/** 写文件工具。 */
export const writeTool: Tool = {
  name: 'write',
  description: '把内容写入一个文件（覆盖已有内容，不存在则创建）。'
    + '**覆盖会丢失原有内容**。路径相对于当前工作目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对于当前工作目录的文件路径' },
      content: { type: 'string', description: '要写入的完整文件内容' },
    },
    required: ['path', 'content'],
  },
  async execute(args) {
    const target = resolveInsideCwd(requireString(args, 'path'))
    const content = args['content']
    // content 可以是空字符串（清空文件是合法操作），所以不能用 取字符串。
    if (typeof content !== 'string') {
      throw new Error(`参数 content 必须是字符串，实际收到：${JSON.stringify(content)}`)
    }

    // 覆盖是不可逆的，所以要把"覆盖了多少"报告给模型——它可能因此发现自己搞错了文件。
    const previousChars = await readFile(target, 'utf8').then(content => content.length, () => undefined)

    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')

    return previousChars === undefined
      ? `已创建 ${requireString(args, 'path')}（${content.length} 字符）`
      : `已覆盖 ${requireString(args, 'path')}（原 ${previousChars} 字符 → 现 ${content.length} 字符）`
  },
}

/**
 * 找出 old_string 在文件里的**每一处**位置。
 *
 * 报"出现了几次"不够——模型还得知道是哪几行，才能决定多带哪一段上下文。
 * 给模型的错误信息里应该带上它改正所需要的全部信息（dsh 的 `str_replace` 也这么做）。
 * @param content - 文件全文。
 * @param needle - 要找的字面文本。
 * @returns 每一次出现的字符index，从小到大。
 */
function findAllOffsets(content: string, needle: string): number[] {
  const offsets: number[] = []
  let from = 0
  for (;;) {
    const offset = content.indexOf(needle, from)
    if (offset < 0) return offsets
    offsets.push(offset)
    // 从这次匹配的末尾继续找：重叠的匹配（比如在 "aaa" 里找 "aa"）只算一次。
    from = offset + needle.length
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
    const displayPath = requireString(args, 'path')
    const target = resolveInsideCwd(displayPath)
    const old_string = requireString(args, 'old_string')
    const new_string = args['new_string']
    if (typeof new_string !== 'string') {
      throw new Error(`参数 new_string 必须是字符串，实际收到：${JSON.stringify(new_string)}`)
    }

    // 两段一模一样的文本，替换必然是空操作。这不是"没事发生"，是模型算错了：
    // 它以为自己改了东西。让它立刻知道，比让它继续往下走要好。
    if (old_string === new_string) {
      throw new Error('old_string 和 new_string 完全相同，这次替换不会改变任何东西。')
    }

    const content = await readFile(target, 'utf8')

    // 唯一匹配是这个工具的核心契约。数出现位置而不是直接 replace：
    // replace 只换第一处，模型会以为全换了；replaceAll 又可能改到不该改的地方。
    // 两种失败要报出不同的错，因为模型的改正动作完全不同。
    const offsets = findAllOffsets(content, old_string)
    if (offsets.length === 0) {
      throw new Error(`old_string 在 ${displayPath} 中没有找到。请先用 read 确认原文（注意空格、缩进和换行必须完全一致）。`)
    }
    if (offsets.length > 1) {
      const lineNumbers = offsets.map(offset => content.slice(0, offset).split('\n').length)
      throw new Error(
        `old_string 在 ${displayPath} 中出现了 ${offsets.length} 次（第 ${lineNumbers.join('、')} 行），必须恰好一次。`
        + '请在 old_string 里多带上前后几行上下文，让它变得唯一。',
      )
    }

    await writeFile(target, content.replace(old_string, new_string), 'utf8')
    return `已修改 ${displayPath}（替换了 ${old_string.length} 字符 → ${new_string.length} 字符）`
  },
}

/** 一条命令最多跑多久。超过就杀掉——模型不会自己发现"卡住了"。 */
const DEFAULT_TIMEOUT_MS = 30_000

/** 一条命令的输出最多往上下文里塞多少字节。 */
const MAX_OUTPUT_CHARS = 30_000

/**
 * 只保留末尾若干字节的输出收集器。
 *
 * 边收边裁，所以内存有上界：`yes` 这种命令一秒能产出几十 MB，
 * 等收完再裁已经晚了。保留**末尾**而不是开头，因为命令的错误信息几乎总在最后。
 */
class TailBuffer {
  private text = ''
  private dropped = false

  /**
   * 追加一块输出，超出上限时从头部丢弃。
   * @param chunk - 子进程新产出的一段文本。
   */
  push(chunk: string): void {
    this.text += chunk
    if (this.text.length > MAX_OUTPUT_CHARS) {
      this.text = this.text.slice(-MAX_OUTPUT_CHARS)
      this.dropped = true
    }
  }

  /**
   * 取出收集到的文本，并在截断过时附上明确说明。
   * @returns 给模型看的这一路输出。
   */
  read(): string {
    return this.dropped ? `[前面的输出已被丢弃，只保留末尾 ${MAX_OUTPUT_CHARS} 字节]\n${this.text}` : this.text
  }
}

/** 一次命令执行的结果。非零退出**不是异常**，是一个正常的结果值。 */
interface CommandOutcome {
  stdout: string
  stderr: string
  code: number | null
  killedBy: NodeJS.Signals | null
  timedOut: boolean
}

/**
 * 跑一条 bash 命令并收集它的输出。
 *
 * 每次调用都是**全新的 shell**：`cd`、变量、函数都不会留到下一次。
 * 想换目录就用 workdir 参数——这是 dsh 的 bash 工具在描述里明确告诉模型的同一件事。
 * @param command - 交给 `bash -c` 的命令行。
 * @param workdir - 子进程的工作目录。
 * @param timeoutMs - 超过这个时间就 SIGKILL。
 * @param signal - 外层护栏的取消信号；它一响，命令同样被 SIGKILL。
 * @returns 输出、退出码、以及是否因超时被杀。
 */
function runCommand(command: string, workdir: string, timeoutMs: number, signal: AbortSignal): Promise<CommandOutcome> {
  return new Promise(resolve => {
    const child = spawn('bash', ['-c', command], { cwd: workdir })
    const stdout = new TailBuffer()
    const stderr = new TailBuffer()
    let timedOut = false

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout.push(chunk) })
    child.stderr.on('data', (chunk: string) => { stderr.push(chunk) })

    // SIGKILL 而不是 SIGTERM：命令可以捕获 SIGTERM 然后赖着不走，
    // 而超时的意义就是"无论如何都要停下"。代价是它没机会清理，这里接受这个代价。
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)

    // 外层还有一层护栏的超时（4.4）。它管的是"任何工具都不许卡住 agent"，
    // 上面那个管的是"一条命令跑多久算久"——两层预算，两个问题，都要接。
    const onOuterAbort = () => { child.kill('SIGKILL') }
    signal.addEventListener('abort', onOuterAbort, { once: true })

    // 'close' 而不是 'exit'：exit 在进程退出时就触发，此时 stdout 可能还没读完。
    // close 保证所有输出流都已经关闭——少了这一条，长输出的末尾会莫名其妙丢掉。
    child.on('close', (code, killedBy) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onOuterAbort)
      resolve({ stdout: stdout.read(), stderr: stderr.read(), code, killedBy, timedOut })
    })
  })
}

/**
 * 把一次执行结果拼成给模型看的文本。
 *
 * 关键决定：**非零退出码不抛异常**，而是作为标记附在输出末尾。
 * `grep` 没找到东西就退 1，`test` 判假也退 1——这些都不是故障，是结果。
 * 该怎么反应由模型决定，工具只负责如实报告（dsh 的 bash 工具是同一条规矩）。
 * @param result - 一次执行的完整结果。
 * @param timeoutMs - 本次生效的超时值，用于写进超时标记。
 * @returns stdout、标了记的 stderr、以及退出状态标记。
 */
function formatOutcome(result: CommandOutcome, timeoutMs: number): string {
  let body = result.stdout
  if (result.stderr !== '') {
    if (body !== '' && !body.endsWith('\n')) body += '\n'
    // stderr 要标出来。混在一起模型分不清哪句是结果、哪句是警告。
    body += `[stderr]\n${result.stderr}`
  }
  if (body === '') body = '(没有输出)'

  const markers: string[] = []
  if (result.timedOut) markers.push(`[超时：跑满 ${timeoutMs}ms 后被杀掉]`)
  if (result.killedBy !== null) markers.push(`[被信号杀掉：${result.killedBy}]`)
  else if (result.code !== 0) markers.push(`[退出码：${result.code}]`)

  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
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
    + '非零退出会以 `[退出码：N]` 的形式报告。输出过长时只保留末尾。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令行' },
      description: { type: 'string', description: '一句话说明这条命令要做什么，例如"跑单元测试"' },
      workdir: { type: 'string', description: '可选：命令的工作目录，相对于当前工作目录' },
      timeout_ms: { type: 'number', description: `可选：超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}` },
    },
    required: ['command', 'description'],
  },
  async execute(args, signal) {
    const command = requireString(args, 'command')
    // description 是必填的，但工具本身不用它。要它是为了让模型**说出意图**：
    // 阶段 15 的审批弹窗要拿它给用户看，而且被迫写一句话本身就会让模型少乱来。
    requireString(args, 'description')

    const workdir = args['workdir'] === undefined ? CWD : resolveInsideCwd(requireString(args, 'workdir'))

    // 默认值在这里显式取，而不是藏在 runCommand() 里的 `?? DEFAULT_TIMEOUT_MS`。
    // dsh 把这条做成了一条明规矩：resolve(request) → spec 是一步独立的解析，
    // 调用方能看见最终生效的值是什么（`ShellExecRequest` → `ShellExecSpec`）。
    const rawTimeout = args['timeout_ms']
    if (rawTimeout !== undefined && (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0)) {
      throw new Error(`参数 timeout_ms 必须是正数，实际收到：${JSON.stringify(rawTimeout)}`)
    }
    const timeoutMs = rawTimeout ?? DEFAULT_TIMEOUT_MS

    return formatOutcome(await runCommand(command, workdir, timeoutMs, signal), timeoutMs)
  },
  summarize(result) {
    // 命令的结论在末尾：报错的最后一句、以及我们自己附的退出状态标记。
    // `[stderr]` 是分节标题不是内容，滤掉。
    const lines = result.split('\n').filter(line => line.trim() !== '' && line !== '[stderr]')
    const lastTwo = lines.slice(-2).join(' / ')
    return lines.length > 2 ? `（共 ${lines.length} 行）… ${lastTwo}` : lastTwo
  },
}

/**
 * 搜索时永远不进去的目录。
 *
 * 少了这一条，任何一次搜索的结果里 99% 是 `node_modules` 和 `.git`——
 * 模型要的那几行会被淹没。**过滤噪音和限制数量是两件事，两件都要做。**
 */
const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'lib', 'coverage', '.cache'])

/** 一次搜索最多返回多少条结果。 */
const MAX_RESULTS = 100

/** 一条匹配行最多显示多少字符：压缩过的 JS、单行 JSON 数据能一行几十万字符。 */
const MAX_LINE_CHARS = 300

/** 一次搜索最多看多少个文件，防止在超大仓库里跑到天荒地老。 */
const MAX_WALKED_FILES = 20_000

/**
 * 深度优先遍历一个目录下的所有文件，跳过 {@link SKIPPED_DIRS}。
 * @param root - 遍历起点的绝对路径。
 * @yields 每个文件的绝对路径。
 */
async function* walkFiles(root: string): AsyncGenerator<string> {
  const pending = [root]
  let walked = 0
  while (pending.length > 0) {
    const dir = pending.pop()
    if (dir === undefined) return
    // 目录可能在遍历途中被删掉，或者是个没有权限的目录：跳过它，别让整次搜索失败。
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) pending.push(fullPath)
      } else if (entry.isFile()) {
        if (++walked > MAX_WALKED_FILES) return
        yield fullPath
      }
      // 符号链接既不进也不 yield：跟着链接走可能绕回自己，变成无限循环。
    }
  }
}

/**
 * 把一个 glob 模式编译成正则。
 *
 * 支持三种通配：`**` 跨目录、`*` 不跨目录、`?` 一个字符。其余字符按字面量处理，
 * 所以正则元字符必须转义——否则 `a.ts` 里的 `.` 会匹配任意字符。
 * @param glob - 例如 `src/**\/*.ts`。
 * @returns 用来整体匹配相对路径的正则。
 */
function globToRegExp(glob: string): RegExp {
  let pattern = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? ''
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*'
        i++
        // `**/` 后面的斜杠一起吃掉，这样 `**/*.ts` 也能匹配根目录下的 `a.ts`。
        if (glob[i + 1] === '/') i++
      } else {
        pattern += '[^/]*'
      }
    } else if (ch === '?') {
      pattern += '[^/]'
    } else {
      pattern += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${pattern}$`)
}

/** 按文件名模式找文件的工具。 */
export const globTool: Tool = {
  name: 'glob',
  description: '按文件名模式查找文件，返回相对路径列表，最近修改的排在前面。'
    + '支持 `**`（跨目录）、`*`（不跨目录）、`?`（单字符），例如 `src/**/*.ts`。'
    + '自动跳过 node_modules、.git 等目录。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '文件名模式，例如 `src/**/*.ts`' },
      path: { type: 'string', description: '可选：搜索起点，相对于当前工作目录，默认是工作目录本身' },
    },
    required: ['pattern'],
  },
  async execute(args) {
    const matcher = globToRegExp(requireString(args, 'pattern'))
    const from = args['path'] === undefined ? CWD : resolveInsideCwd(requireString(args, 'path'))

    const hits: { target: string, mtime: number }[] = []
    for await (const file of walkFiles(from)) {
      const displayPath = relative(CWD, file)
      if (!matcher.test(displayPath)) continue
      hits.push({ target: displayPath, mtime: (await stat(file)).mtimeMs })
    }

    if (hits.length === 0) return '没有匹配的文件。'

    // 按修改时间倒序：模型问"这个功能的代码在哪"时，最近动过的文件几乎总是最相关的。
    // dsh 的 glob 也是这个顺序（它靠 `rg --files` 自带的排序拿到）。
    hits.sort((a, b) => b.mtime - a.mtime)
    const shown = hits.slice(0, MAX_RESULTS).map(item => item.target).join('\n')
    return hits.length > MAX_RESULTS
      ? `${shown}\n\n[共 ${hits.length} 个匹配，只显示最近修改的 ${MAX_RESULTS} 个。请把 pattern 写得更具体。]`
      : shown
  },
}

/**
 * 按内容搜索文件的工具。
 *
 * XXX(ReDoS)：`pattern` 直接交给 `new RegExp`，而 JS 的正则引擎会回溯。
 * 一个 `(a+)+$` 配上足够长的行就能把整个进程**同步**卡死——连超时都救不了，
 * 因为定时器要等事件循环，而事件循环正被这个正则占着。课程里 4.3 讲了为什么
 * 这个洞只能靠换引擎补，以及 dsh 是怎么换的。
 */
export const grepTool: Tool = {
  name: 'grep',
  description: '按内容搜索文件，返回 `文件:行号: 内容` 形式的匹配行。'
    + 'pattern 是正则表达式。可以用 include 限定文件名，例如 `*.ts`。'
    + '会跳过 node_modules 等目录，并限制结果数量。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '可选：搜索起点，相对于当前工作目录' },
      include: { type: 'string', description: '可选：只搜文件名匹配这个 glob 的文件，例如 `*.ts`' },
    },
    required: ['pattern'],
  },
  async execute(args) {
    const source = requireString(args, 'pattern')
    let matcher: RegExp
    try {
      matcher = new RegExp(source)
    } catch (error) {
      // 模型写的正则可能根本编译不过（未闭合的括号最常见）。这是它能改正的错。
      throw new Error(`pattern 不是合法的正则表达式：${error instanceof Error ? error.message : String(error)}`)
    }
    const from = args['path'] === undefined ? CWD : resolveInsideCwd(requireString(args, 'path'))
    const includeFilter = args['include'] === undefined ? undefined : globToRegExp(requireString(args, 'include'))

    const lines: string[] = []
    let totalMatches = 0
    for await (const file of walkFiles(from)) {
      const displayPath = relative(CWD, file)
      // include 只匹配文件名部分，这样 `*.ts` 不必写成 `**/*.ts`。
      if (includeFilter !== undefined && !includeFilter.test(displayPath.split('/').at(-1) ?? '')) continue

      // 二进制文件读出来是乱码，正则可能碰巧匹配上，输出是一堆不可打印字符。
      const content = await readFile(file, 'utf8').catch(() => undefined)
      if (content === undefined || content.includes('\0')) continue

      content.split('\n').forEach((line, index) => {
        if (!matcher.test(line)) return
        totalMatches++
        if (lines.length >= MAX_RESULTS) return
        const clipped = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
        lines.push(`${displayPath}:${index + 1}: ${clipped}`)
      })
    }

    if (totalMatches === 0) return '没有匹配。'
    return totalMatches > MAX_RESULTS
      ? `${lines.join('\n')}\n\n[共 ${totalMatches} 处匹配，只显示前 ${MAX_RESULTS} 处。请把 pattern 或 include 写得更具体。]`
      : lines.join('\n')
  },
}

/**
 * 工具之间该怎么选——这段话属于 system prompt，不属于任何一个工具的描述。
 *
 * 5.1 之前它散在 bash 和 grep 的 `description` 里，那有两个毛病：
 * 一个工具的描述里提到另一个工具，等于把它们绑死了（删掉 grep，bash 的描述就在说谎）；
 * 而且"该先用谁"这件事只有**看到全套工具的人**才说得清，单个工具没有这个视角。
 */
export const toolGuidanceSection: PromptSection = {
  name: 'tools:guidance',
  order: 100,
  text: '选工具的优先级：\n'
    + '- 读文件用 read（它带行号），不要用 `cat`。\n'
    + '- 改已有文件用 edit（唯一字面匹配），不要用 write 整体重写，也不要用 `sed`。\n'
    + '- 按内容找代码用 grep，按文件名找用 glob，都不要用 bash 里的 grep/find——'
    + '专门工具会跳过 node_modules、限制结果数量、并且不经过 shell。\n'
    + '- bash 用来跑那些没有专门工具的事：测试、构建、git、查进程。',
}

/** 本课程当前可用的工具。 */
export const tools: Tool[] = [readTool, writeTool, editTool, bashTool, globTool, grepTool]

/**
 * 把工具定义转成 OpenAI 兼容 API 的 `tools` 字段格式。
 * @param tools - 内部工具定义。
 * @returns wire 格式的工具数组。
 */
export function toWireTools(tools: Tool[]): unknown[] {
  return tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}
