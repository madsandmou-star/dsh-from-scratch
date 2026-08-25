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

const 课程根目录 = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 起一个按剧本回答的假模型服务器。
 * @param {{name: string, args: object}[]} 剧本 - 依次要求调用的工具；用完后模型给最终回答。
 * @param {string} 最终回答 - 剧本走完后模型说的话。
 * @param {(内容: string) => void} [看见] - 每收到一条 tool 结果就回调一次。
 * @returns {Promise<{端口: number, 关掉: () => Promise<void>}>}
 */
export function 启动假服务器(剧本, 最终回答, 看见) {
  let 第几轮 = 0
  const 服务器 = createServer(async (req, res) => {
    let body = ''
    for await (const 块 of req) body += 块
    const 最后一条 = JSON.parse(body).messages.at(-1)
    if (最后一条.role === 'tool' && 看见 !== undefined) 看见(最后一条.content)

    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const 帧 = 增量 => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: 增量, finish_reason: null }] })}\n\n`)
    const 收尾 = 原因 => res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 原因 }] })}\n\n`)

    const 这一步 = 剧本[第几轮++]
    if (这一步 === undefined) {
      帧({ content: 最终回答 })
      收尾('stop')
    } else {
      帧({ tool_calls: [{ index: 0, id: `call_${第几轮}`, type: 'function', function: { name: 这一步.name, arguments: JSON.stringify(这一步.args) } }] })
      收尾('tool_calls')
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return new Promise(完成 => {
    服务器.listen(0, () => 完成({
      端口: 服务器.address().port,
      关掉: () => new Promise(结束 => 服务器.close(() => { 结束() })),
    }))
  })
}

/**
 * 在一个临时工作目录里跑一次完整会话，输出直接打到当前终端。
 * @param {object} 选项
 * @param {Record<string, string>} [选项.文件] - 先在临时目录里铺好的文件，键是相对路径。
 * @param {{name: string, args: object}[]} 选项.剧本 - 模型依次要求调用的工具。
 * @param {string} 选项.最终回答 - 剧本走完后模型说的话。
 * @param {string} 选项.输入 - 喂给 CLI 的那句用户输入。
 * @param {object} [选项.配置] - 额外的配置字段，合并进临时的 dsh-learn.json（例如 `{ 只读: true }`）。
 * @param {(内容: string) => void} [选项.看见] - 每收到一条 tool 结果就回调一次。
 * @returns {Promise<string>} 临时工作目录路径（调用方可以再检查文件内容）。
 */
export async function 跑一次会话({ 文件 = {}, 剧本, 最终回答, 输入, 看见, 配置 = {} }) {
  const 工作目录 = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
  for (const [相对路径, 内容] of Object.entries(文件)) {
    await mkdir(dirname(join(工作目录, 相对路径)), { recursive: true })
    await writeFile(join(工作目录, 相对路径), 内容, 'utf8')
  }

  const { 端口, 关掉 } = await 启动假服务器(剧本, 最终回答, 看见)
  // 密钥必须是 ASCII：HTTP 头是 ByteString，塞中文会在发请求时炸掉。
  const 配置路径 = join(工作目录, '.dsh-learn-demo.json')
  await writeFile(配置路径, JSON.stringify({
    baseURL: `http://127.0.0.1:${端口}/v1`,
    model: 'mock',
    apiKeyEnv: 'DSH_DEMO_KEY',
    systemPrompt: '你是一个帮忙改代码的助手。',
    ...配置,
  }), 'utf8')

  await new Promise((完成, 失败) => {
    const 子进程 = spawn(
      process.execPath,
      ['--import', join(课程根目录, 'node_modules/tsx/dist/loader.mjs'), join(课程根目录, 'src/index.ts')],
      {
        cwd: 工作目录,
        stdio: ['pipe', 'inherit', 'inherit'],
        env: { ...process.env, DSH_LEARN_CONFIG: 配置路径, DSH_DEMO_KEY: 'demo-key-not-real' },
      },
    )
    子进程.stdin.end(`${输入}\n`)
    子进程.on('error', 失败)
    子进程.on('close', () => { 完成() })
  })

  await 关掉()
  return 工作目录
}

/**
 * 删掉 {@link 跑一次会话} 建出来的临时目录。
 * @param {string} 目录 - 临时工作目录。
 */
export async function 清理(目录) {
  await rm(目录, { recursive: true, force: true })
}

/**
 * 一个永远不会响的取消信号。
 *
 * 直接调 `tool.execute()` 的演示要用它——4.4 之后 `execute` 的第二个参数是必填的。
 * 真实调用永远该走 `执行工具()`，由管线来发这个信号。
 */
export const 不取消 = new AbortController().signal
