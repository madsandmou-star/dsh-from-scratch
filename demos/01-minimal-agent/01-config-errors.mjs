// 1.1 配置错误要在第一次请求之前暴露：三种缺失，三条能照做的提示。
//   node demos/01-minimal-agent/01-config-errors.mjs

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const dir = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
const LOADER = new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname
const CONFIG_TS = new URL('../../src/config.ts', import.meta.url).pathname

/**
 * 用一份给定的配置调用 loadConfig()，把它的判断打出来。
 * @param {string} title - 这一格演示什么。
 * @param {object | null} config - 配置内容；null 表示配置文件根本不存在。
 * @param {Record<string, string>} env - 额外的环境变量。
 */
const load = async (title, config, env = {}) => {
  console.log(`\n── ${title} ──`)
  const file = join(dir, `${Math.random().toString(36).slice(2)}.json`)
  if (config !== null) await writeFile(file, JSON.stringify(config, null, 2), 'utf8')
  const probe = join(dir, `${Math.random().toString(36).slice(2)}.mjs`)
  await writeFile(probe, `import { loadConfig } from '${CONFIG_TS}'\nconsole.log(JSON.stringify(loadConfig()))\n`, 'utf8')
  try {
    const out = execFileSync(process.execPath, ['--import', LOADER, probe], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, DSH_LEARN_CONFIG: file, ...env },
    })
    const parsed = JSON.parse(out)
    console.log(`  ✅ 读到了：model=${parsed.model} readOnly=${parsed.readOnly} apiKey=${'*'.repeat(parsed.apiKey.length)}`)
  } catch (error) {
    const msg = String(error.stderr ?? '').split('Error: ')[1] ?? String(error.stderr ?? '')
    console.log(`  ❌ ${msg.split('\n    at ')[0].trim()}`)
  }
}

const OK = { baseURL: 'https://example.com/v1', model: 'demo-model', apiKeyEnv: 'DEMO_KEY', systemPrompt: '你好。' }

await load('① 配置文件不存在', null)
await load('② 少了 model 这一项', { ...OK, model: undefined }, { DEMO_KEY: 'sk-x' })
await load('③ 配置齐了，但环境变量没设', OK)
await load('④ 全都齐了', OK, { DEMO_KEY: 'sk-abcdef' })

console.log('\n三条错误分别对应三个不同的动作：复制模板 / 补字段 / 导出环境变量。')
console.log('注意 ④ 里密钥被打成了星号——配置里存的是**变量名**，密钥只活在进程环境里。')
