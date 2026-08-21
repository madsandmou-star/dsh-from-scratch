// 课程自检：防止讲义里的引用悄悄失效。
//
//   node scripts/check-course.mjs
//   DSH_REF=/path/to/deepseek-harness node scripts/check-course.mjs   # 参考源码不在 dsh/ 时
//
// 检查两件事：
//   1. 所有 Markdown 相对链接都能解析到真实文件；
//   2. 讲义里用反引号写出的每一个 dsh 源码路径都真实存在于参考源码里。
// 第 2 条是这门课最容易腐烂的地方：dsh 改个包名，讲义就开始说谎，而没有任何人会发现。

import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const submodule = join(root, 'dsh')
const reference = process.env.DSH_REF === undefined ? submodule : resolve(process.env.DSH_REF)
const referenceReady = existsSync(join(reference, 'packages'))

/** 把课程里写的 dsh/... 路径映射到参考源码的真实位置（支持 DSH_REF 指向别处的 clone）。 */
function resolveAgainstReference(absolute) {
  const fromSubmodule = relative(submodule, absolute)
  if (fromSubmodule.startsWith('..')) return absolute
  return join(reference, fromSubmodule)
}

/** 参考源码里的路径写法：`dsh/packages/...`，允许带行号后缀。占位写法不参与检查。 */
const CITATION = /`(dsh\/(?:packages|docs|examples|vendor|scripts|apps|native|python)\/[^`\s]+)`/g
const PLACEHOLDER = /[<>…*]|\.\.\./

const markdown = globSync('**/*.md', { cwd: root })
  .filter(file => !file.startsWith('dsh/') && !file.includes('node_modules'))

const problems = []
let citations = 0
let skipped = 0

for (const file of markdown) {
  const source = readFileSync(join(root, file), 'utf8')

  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0]
    if (target === '' || /^(https?:|mailto:)/.test(target)) continue
    const absolute = resolveAgainstReference(resolve(dirname(join(root, file)), target))
    if (absolute.startsWith(reference) && !referenceReady) { skipped++; continue }
    if (!existsSync(absolute)) problems.push(`${file}: 链接指向不存在的文件 → ${target}`)
  }

  for (const match of source.matchAll(CITATION)) {
    if (PLACEHOLDER.test(match[1])) continue
    if (!referenceReady) { skipped++; continue }
    citations++
    const cited = match[1].replace(/:\d+$/, '').slice('dsh/'.length)
    if (!existsSync(join(reference, cited))) problems.push(`${file}: 引用了不存在的源码路径 → ${match[1]}`)
  }
}

if (!referenceReady) {
  console.log(`check-course: 参考源码不可用（${reference}），跳过 ${skipped} 处引用检查。`)
  console.log('check-course: 初始化参考源码：git submodule update --init --depth 1 dsh')
}

if (problems.length > 0) {
  console.error(`check-course: 发现 ${problems.length} 个问题：\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`check-course: 通过（${markdown.length} 个 Markdown 文件，链接全部可解析${referenceReady ? `，${citations} 处源码路径存在` : ''}）。`)
