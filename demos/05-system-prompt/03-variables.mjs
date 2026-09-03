// 5.2 变量与插值：取值时机、三种错误、值不会被二次展开、孤立的 {{ 是字面文本。
//   node demos/05-system-prompt/03-variables.mjs

import { PromptRegistry } from '../../src/system-prompt.ts'

/**
 * 跑一次装配，成功就打印结果，失败就打印错误。
 * @param {string} 标题 - 这一格演示什么。
 * @param {(提示: 提示注册表) => void} 装配 - 往注册表里塞东西。
 */
const run = (title, registry) => {
  console.log(`\n── ${title} ──`)
  const prompt = new PromptRegistry()
  try {
    registry(prompt)
    console.log(`  ✅ ${prompt.assemble()}`)
  } catch (error) {
    console.log(`  ❌ ${error.message}`)
  }
}

run('① 正常插值', prompt => {
  prompt.variable('cwd', () => '/home/me/项目')
  prompt.register({ name: 'a', order: 0, text: '工作目录是 {{cwd}}。' })
})

run('② 变量名拼错了', prompt => {
  prompt.variable('cwd', () => '/home/me/项目')
  prompt.register({ name: 'a', order: 0, text: '工作目录是 {{cdw}}。' })
})

run('③ 变量注册了，但这次取不到值', prompt => {
  prompt.variable('git_branch', () => undefined)   // 比如：这个目录不是 git 仓库
  prompt.register({ name: 'a', order: 0, text: '当前分支 {{git_branch}}。' })
})

run('④ 引用写坏了', prompt => {
  prompt.register({ name: 'a', order: 0, text: '工作目录是 {{ cwd }}。' })
})

run('⑤ 孤零零的 {{ 是普通文字，不报错', prompt => {
  prompt.register({ name: 'a', order: 0, text: 'Jinja 模板里的变量写成 {{ 加名字。' })
})

run('⑥ 变量的值里含 {{...}}，不会被二次展开', prompt => {
  // 假设用户的目录名字就叫这个——一个恶意或者只是手滑的目录名。
  prompt.variable('cwd', () => '/tmp/{{secret}}')
  prompt.variable('secret', () => '不该被读到的东西')
  prompt.register({ name: 'a', order: 0, text: '工作目录是 {{cwd}}。' })
})

run('⑦ 同一次组装里，两段读到同一个值', prompt => {
  let nth = 0
  prompt.variable('n', () => String(++nth))
  prompt.register({ name: 'a', order: 0, text: '第一段看到 {{n}}。' })
  prompt.register({ name: 'b', order: 1, text: '第二段看到 {{n}}。' })
})

console.log('\n── ⑧ 取值发生在组装时，不是注册时 ──')
{
  const prompt = new PromptRegistry()
  let currentDir = '/一开始的目录'
  prompt.variable('cwd', () => currentDir)
  prompt.register({ name: 'a', order: 0, text: '工作目录是 {{cwd}}。' })
  console.log(`  组装第一次：${prompt.assemble()}`)
  currentDir = '/后来换了的目录'
  console.log(`  组装第二次：${prompt.assemble()}`)
}
