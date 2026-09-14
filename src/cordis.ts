// 阶段 7.1：迷你版 Cordis —— 插件与上下文。
//
// 这是这门课第一次"先自己写一个几十行的版本，再和 dsh/vendor/cordis/ 对照"。
// 不直接用 Cordis，是因为**用一个插件系统和理解它为什么长这样，是两件事**。
//
// 这一课只做两件事：
//   ① 插件是什么（一个 apply 函数）
//   ② 应用是什么（一棵插件树）
// 服务（阶段 8）、可逆注册（阶段 9）、类型化事件（阶段 10）都还没有。

/**
 * 一个插件能拿到的东西。
 *
 * 每个插件拿到的是**自己的一份** `Context`，不是同一个全局对象——7.2 讲为什么。
 * 现在它只有一个方法：装一个子插件。
 */
export class Context {
  /** 这个 context 属于哪个插件。只用于诊断输出，不参与任何逻辑。 */
  readonly name: string
  /** 装它的那个 context。根 context 是 undefined。 */
  readonly parent: Context | undefined
  /** 在它下面装过的子 context，按装载顺序。 */
  private readonly children: Context[] = []

  /**
   * @param name - 这个 context 的名字；根的名字是 `'root'`。
   * @param parent - 父 context；只有根没有。
   */
  constructor(name = 'root', parent?: Context) {
    this.name = name
    this.parent = parent
  }

  /**
   * 装一个插件。
   *
   * 做三件事：给它造一个**子 context**、记进插件树、调它的 `apply`。
   * 没有返回值，也没有"卸载"——阶段 9 才会有。
   * @param plugin - 一个 `apply` 函数，或者一个带 `apply` 方法的对象。
   * @param config - 原样传给 `apply` 的第二个参数。这个插件的配置。
   * @throws 传进来的东西不是插件。
   */
  plugin<T>(plugin: Plugin<T>, config?: T): void {
    const apply = typeof plugin === 'function' ? plugin : plugin.apply
    if (typeof apply !== 'function') {
      throw new Error(`不是一个插件：需要函数或带 apply 方法的对象，收到 ${typeof plugin}`)
    }
    // 名字用来在插件树里认人。函数插件用函数名，对象插件优先用它自己声明的 name。
    const name = (typeof plugin === 'function' ? plugin.name : plugin.name ?? plugin.apply.name) || '(匿名)'
    const child = new Context(name, this)
    this.children.push(child)
    // 同步调用，**异常不拦**：装配失败必须当场炸，而不是"这一项被跳过了"。
    // dsh 的 cordis 教程第一章就在演示这件事：apply 抛异常，进程终止。
    apply(child, config as T)
  }

  /**
   * 把这棵插件树画成文本。
   *
   * 这是本阶段最有用的 debug 手法：**装配出了问题，先看看到底装了什么**。
   * @param indent - 内部递归用的缩进。
   * @returns 多行文本，每行一个插件。
   */
  inspect(indent = ''): string {
    const lines = [`${indent}${this.name}`]
    for (const child of this.children) lines.push(child.inspect(`${indent}  `))
    return lines.join('\n')
  }
}

/**
 * 一个插件：要么是函数，要么是带 `apply` 方法的对象。
 *
 * dsh 的 Cordis 还接受第三种——一个 `Service` 子类（阶段 8 才讲）。
 * 对象形态的好处是能带 `name`：函数插件靠函数名，而打包工具可能把函数名改掉。
 */
export type Plugin<T = unknown> =
  | ((ctx: Context, config: T) => void)
  | { name?: string, apply: (ctx: Context, config: T) => void }
