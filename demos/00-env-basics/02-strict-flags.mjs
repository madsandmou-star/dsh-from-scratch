// 0.2 tsconfig 里那几个开关到底拦住了什么：同一段代码，开与不开的差别。
//   node demos/00-env-basics/02-strict-flags.mjs

import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'dsh-demo-'))
const TSC = new URL('../../node_modules/.bin/tsc', import.meta.url).pathname

/**
 * 用一组编译选项检查一段代码，打印 tsc 的判断。
 * @param {string} title - 这一格演示什么。
 * @param {string} code - 待检查的代码。
 * @param {string[]} flags - 传给 tsc 的开关。
 */
const check = async (title, code, flags) => {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.ts`)
  await writeFile(file, code, 'utf8')
  console.log(`\n── ${title} ──`)
  console.log(code.trim().split('\n').map(l => `  │ ${l}`).join('\n'))
  console.log(`  开关：${flags.join(' ')}`)
  try {
    execFileSync(TSC, ['--noEmit', '--ignoreConfig', ...flags, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    console.log('  ✅ tsc 认为没问题')
  } catch (error) {
    const first = String(error.stdout ?? '').split('\n').find(l => l.includes('error')) ?? ''
    console.log(`  ❌ ${first.replace(/^.*?\((\d+),\d+\): /, '第 $1 行：').trim()}`)
  }
}

const INDEX = `
const lines: string[] = ['a', 'b']
const first = lines[0]
console.log(first.toUpperCase())   // 数组下标越界时 first 会是 undefined
`
await check('① 取数组下标 —— 只开 strict', INDEX, ['--strict'])
await check('② 同一段代码 —— 再开 noUncheckedIndexedAccess', INDEX, ['--strict', '--noUncheckedIndexedAccess'])

const OPTIONAL = `
interface Options { timeout?: number }
const o: Options = {}
o.timeout = undefined          // 显式赋 undefined，和"这个字段不存在"是一回事吗？
console.log(o)
`
await check('③ 可选字段赋 undefined —— 只开 strict', OPTIONAL, ['--strict'])
await check('④ 同一段代码 —— 再开 exactOptionalPropertyTypes', OPTIONAL, ['--strict', '--exactOptionalPropertyTypes'])

console.log('\n这两个开关都不在 `strict` 里，要单独打开。')
console.log('课程的 tsconfig.json 打开了它们，理由和 dsh 的 tsconfig.base.json 一样：')
console.log('这两类 bug 全都发生在"外部数据进入我们的世界"的地方，而这正是 agent 每天在做的事。')
