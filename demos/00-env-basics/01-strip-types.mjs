// 0.1 Node 到底能不能直接跑 .ts：能，但只能"擦掉类型"，擦不掉需要生成代码的语法。
//   node demos/00-env-basics/01-strip-types.mjs

import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'dsh-demo-'))

/**
 * 写一个 .ts 文件，直接用 node 跑它，打印结果或第一行报错。
 * @param {string} name - 临时文件名。
 * @param {string} title - 这一格演示什么。
 * @param {string} code - 文件内容。
 */
const run = async (name, title, code) => {
  const file = join(dir, name)
  await writeFile(file, code, 'utf8')
  console.log(`\n── ${title} ──`)
  console.log(code.split('\n').map(l => `  │ ${l}`).join('\n'))
  try {
    const out = execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    console.log(`  ✅ ${out.trim()}`)
  } catch (error) {
    const stderr = String(error.stderr ?? '')
    const line = stderr.split('\n').find(l => /Error/.test(l)) ?? stderr.trim().split('\n')[0]
    console.log(`  ❌ ${line.trim()}`)
  }
}

console.log(`node 版本：${process.version}`)

await run('a.ts', '① 只有类型注解 —— 擦掉就行', "const who: string = 'dsh'\nconsole.log(`hello, ${who}`)")
await run('b.ts', '② interface —— 编译后本来就不存在', "interface M { role: string }\nconst m: M = { role: 'user' }\nconsole.log(m.role)")
await run('c.ts', '③ enum —— 它要生成一个真实对象，擦不掉', 'enum Color { Red, Blue }\nconsole.log(Color.Red)')
await run('d.ts', '④ namespace —— 同样要生成代码', 'namespace N { export const x = 1 }\nconsole.log(N.x)')

console.log('\n结论：Node 的 type stripping 只做"擦除"，不做"代码生成"。')
console.log('所以这门课用 tsx——它是真的编译，enum 和 namespace 都能跑。')
