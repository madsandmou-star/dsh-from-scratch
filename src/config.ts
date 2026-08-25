// 阶段 1.1：读配置，并把密钥留在环境变量里。
//
// 这个文件回答一个问题：一次模型调用需要哪些"部署时才知道"的事实？
// 答案是四个：调哪个地址、用哪个模型、拿哪把钥匙、开场白说什么。
// 前三个是配置，第四个（system prompt）先放在配置里，阶段 5 会把它拆成组装出来的东西。

import { readFileSync } from 'node:fs'

/** 配置文件里允许出现的字段。 */
export interface Config {
  /** 模型服务的基地址，`/chat/completions` 会拼在它后面。 */
  baseURL: string
  /** 模型 id，例如 `deepseek-chat`。 */
  model: string
  /** 装着密钥的**环境变量名**——注意不是密钥本身。 */
  apiKeyEnv: string
  /** 每次对话开头那条 system 消息的内容。 */
  systemPrompt: string
}

// ESM 里没有 CommonJS 的 __dirname。取代它的是 import.meta.url：
// 当前模块自己的 URL。用 new URL(相对路径, import.meta.url) 就能算出同级/上级文件的位置，
// 这样无论你在哪个目录下敲命令，找到的都是 dsh-learn.json。
// 允许用 DSH_LEARN_CONFIG 指向别的文件：demos/ 下的演示要连假服务器，
// 不能去改你本地那份真配置。"路径本身也是配置"这件事，第一次用到是在这里。
const CONFIG_URL = process.env['DSH_LEARN_CONFIG'] === undefined
  ? new URL('../dsh-learn.json', import.meta.url)
  : new URL(process.env['DSH_LEARN_CONFIG'], 'file:///')

/**
 * 读取并校验配置，同时从环境变量取出密钥。
 * 任何一项缺失都在这里立刻报错——配置错误要在第一次请求之前就暴露，
 * 而不是等模型返回 401 时才让人去猜。
 * @returns 一次模型调用需要的全部连接事实。
 */
export function loadConfig(): Config & { apiKey: string } {
  let raw: string
  try {
    raw = readFileSync(CONFIG_URL, 'utf8')
  } catch {
    // 只吞掉"文件不存在/读不了"这一种情况，换成一句人能照做的提示。
    throw new Error(
      `找不到配置文件 ${CONFIG_URL.pathname}\n`
      + '先复制模板：cp dsh-learn.example.json dsh-learn.json',
    )
  }

  // JSON.parse 的返回类型是 any，所以这里立刻断言成我们期望的类型，
  // 后面的字段检查才是真正的把关（TypeScript 只在编译期有效，运行时不检查任何东西）。
  const config = JSON.parse(raw) as Config

  for (const field of ['baseURL', 'model', 'apiKeyEnv', 'systemPrompt'] as const) {
    if (typeof config[field] !== 'string' || config[field] === '') {
      throw new Error(`配置项 ${field} 缺失或不是非空字符串`)
    }
  }

  const apiKey = process.env[config.apiKeyEnv]
  if (apiKey === undefined || apiKey === '') {
    throw new Error(
      `环境变量 ${config.apiKeyEnv} 没有设置。\n`
      + `先导出密钥：export ${config.apiKeyEnv}=sk-...`,
    )
  }

  // 配置文件里存的是**变量名**，密钥本身只活在进程的环境里。
  // 这样配置文件可以放心提交、放心贴给别人看，也不会在报错栈里被打印出来。
  // dsh 本体把这条规则做成了一个能力接缝：packages/credentials/ 里的凭据引用，
  // 以及 DeepSeek 适配器的 apiKeyEnv 字段（packages/llm/llm-deepseek/src/adapter.ts）。
  return { ...config, apiKey }
}
