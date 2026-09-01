// 5.1 system prompt 是拼出来的：注册、排序、重名、注销、条件性段落。
//   node demos/05-system-prompt/01-assembly.mjs

import { 提示注册表, 身份段 } from '../../src/system-prompt.ts'
import { 工具指引段 } from '../../src/tool.ts'
import { 只读模式提示 } from '../../src/guard.ts'

// 身份段用了 {{cwd}} 和 {{model}}（5.2），所以每个注册表都得先把这两个变量注册上。
// 忘了注册就会组装失败——这正是 5.2 想要的行为：拼错或漏掉不会静默。
const 注册变量 = 提示 => {
  提示.变量('cwd', () => '/home/me/项目')
  提示.变量('model', () => 'deepseek-chat')
}

const 画清单 = (标题, 注册表) => {
  console.log(`\n── ${标题} ──`)
  for (const 项 of 注册表.清单()) {
    console.log(`  ${String(项.顺序).padStart(5)}  ${项.名字.padEnd(20)} ${项.字符数} 字符${项.生效 ? '' : '（不生效，会被丢掉）'}`)
  }
  console.log(`  → 拼出来共 ${注册表.组装().length} 字符`)
}

const 提示 = new 提示注册表()
注册变量(提示)
提示.注册(身份段)
const 撤销persona = 提示.注册({ 名字: 'deployment:persona', 顺序: 0, 文本: '你在帮一个 Python 背景的人读 TypeScript 代码。' })
提示.注册(工具指引段)
提示.注册(只读模式提示(false))
画清单('① 默认装配（只读关）', 提示)

console.log('\n── ② 重名 ──')
try { 提示.注册({ 名字: 'harness:identity', 顺序: 999, 文本: '我要覆盖身份段' }) }
catch (错误) { console.log(`  ❌ ${错误.message}`) }
console.log('  → 静默覆盖会让人查半天为什么某段话不见了，所以直接抛错。')

console.log('\n── ③ 注销 ──')
撤销persona()
画清单('撤掉 persona 之后', 提示)
console.log('  → 注册返回注销函数，不是 void。dsh 里这叫"注册即效果"。')

const 只读的 = new 提示注册表()
注册变量(只读的)
只读的.注册(身份段)
只读的.注册({ 名字: 'deployment:persona', 顺序: 0, 文本: '你在帮一个 Python 背景的人读 TypeScript 代码。' })
只读的.注册(工具指引段)
只读的.注册(只读模式提示(true))
画清单('④ 只读模式打开', 只读的)

console.log('\n=== 只读模式那一段长这样 ===')
console.log(只读的.组装().split('\n\n').at(-1))
