// 演示用的小脚手架：起一个假的模型服务器，用一个临时工作目录跑一次完整会话。
//
// 为什么要假服务器：这门课的每个演示都必须**不用 API key 就能跑**，而且每次输出一样。
// 真模型每次回答都不同，没法当教材。

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const COURSE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 起一个按剧本回答的假模型服务器。
 * @param {{name: string, args: object}[]} script - 依次要求调用的工具；用完后模型给最终回答。
 * @param {string} finalAnswer - 剧本走完后模型说的话。
 * @param {(content: string) => void} [onToolResult] - 每收到一条 tool 结果就回调一次。
 * @param {(content: string) => void} [onSystemPrompt] - 第一次请求时回调一次，参数是模型收到的 system prompt。
 * @param {(messages: object[]) => void} [onRequest] - 每收到一次请求回调一次，参数是完整的 messages 数组。
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export function startFakeServer(script, finalAnswer, onToolResult, onSystemPrompt, onRequest) {
  let reportedSystemPrompt = false
  let seenToolResults = 0
  let round = 0
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const messages = JSON.parse(body).messages
    if (!reportedSystemPrompt && onSystemPrompt !== undefined) {
      reportedSystemPrompt = true
      onSystemPrompt(messages[0].content)
    }
    if (onRequest !== undefined) onRequest(messages)
    // 找**最后一条 tool 消息**，而不是只看数组末尾：阶段 5.3 之后，
    // 每个 step 之前还会追加一条运行时上下文快照，它排在工具结果后面。
    let reported = 0
    for (const m of messages) if (m.role === 'tool') reported++
    if (reported > seenToolResults && onToolResult !== undefined) {
      const toolMessages = messages.filter(m => m.role === 'tool')
      for (const m of toolMessages.slice(seenToolResults)) onToolResult(m.content)
      seenToolResults = reported
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const frame = delta => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: delta, finish_reason: null }] })}\n\n`)
    const finish = reason => res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`)

    const step = script[round++]
    if (step === undefined) {
      frame({ content: finalAnswer })
      finish('stop')
    } else {
      frame({ tool_calls: [{ index: 0, id: `call_${round}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] })
      finish('tool_calls')
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return new Promise(resolve => {
    server.listen(0, () => resolve({
      port: server.address().port,
      close: () => new Promise(done => server.close(() => { done() })),
    }))
  })
}

/**
 * 在一个临时工作目录里跑一次完整会话，输出直接打到当前终端。
 * @param {object} options
 * @param {Record<string, string>} [options.files] - 先在临时目录里铺好的文件，键是相对路径。
 * @param {{name: string, args: object}[]} options.script - 模型依次要求调用的工具。
 * @param {string} options.finalAnswer - 剧本走完后模型说的话。
 * @param {string} options.input - 喂给 CLI 的那句用户输入。
 * @param {object} [options.config] - 额外的配置字段，合并进临时的 dsh-learn.json（例如 `{ readOnly: true }`）。
 * @param {(content: string) => void} [options.onToolResult] - 每收到一条 tool 结果就回调一次。
 * @param {(content: string) => void} [options.onSystemPrompt] - 回调一次模型收到的 system prompt。
 * @param {(messages: object[]) => void} [options.onRequest] - 每次请求回调一次，参数是完整的 messages。
 * @returns {Promise<string>} 临时工作目录路径（调用方可以再检查文件内容）。
 */
export async function runSession({ files = {}, script, finalAnswer, input, onToolResult, onSystemPrompt, onRequest, config = {} }) {
  const workdir = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(dirname(join(workdir, relPath)), { recursive: true })
    await writeFile(join(workdir, relPath), content, 'utf8')
  }

  const { port, close } = await startFakeServer(script, finalAnswer, onToolResult, onSystemPrompt, onRequest)
  // 密钥必须是 ASCII：HTTP 头是 ByteString，塞中文会在发请求时炸掉。
  const configPath = join(workdir, '.dsh-learn-demo.json')
  await writeFile(configPath, JSON.stringify({
    baseURL: `http://127.0.0.1:${port}/v1`,
    model: 'mock',
    apiKeyEnv: 'DSH_DEMO_KEY',
    systemPrompt: '你是一个帮忙改代码的助手。',
    ...config,
  }), 'utf8')

  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', join(COURSE_ROOT, 'node_modules/tsx/dist/loader.mjs'), join(COURSE_ROOT, 'src/index.ts')],
      {
        cwd: workdir,
        stdio: ['pipe', 'inherit', 'inherit'],
        env: { ...process.env, DSH_LEARN_CONFIG: configPath, DSH_DEMO_KEY: 'demo-key-not-real' },
      },
    )
    child.stdin.end(`${input}\n`)
    child.on('error', reject)
    child.on('close', () => { resolve() })
  })

  await close()
  return workdir
}

/**
 * 删掉 {@link runSession} 建出来的临时目录。
 * @param {string} dir - 临时工作目录。
 */
export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true })
}

/**
 * 一个永远不会响的取消信号。
 *
 * 直接调 `tool.execute()` 的演示要用它——4.4 之后 `execute` 的第二个参数是必填的。
 * 真实调用永远该走 `runTool()`，由管线来发这个信号。
 */
export const NEVER_ABORTED = new AbortController().signal
