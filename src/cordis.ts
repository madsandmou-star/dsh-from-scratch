// 阶段 7.1–7.2：迷你版 Cordis —— 插件与上下文。
//
// 这是这门课第一次"先自己写一个几十行的版本，再和 dsh/vendor/cordis/ 对照"。
// 不直接用 Cordis，是因为**用一个插件系统和理解它为什么长这样，是两件事**。
//
// 这两课只做两件事：
//   ① 插件是什么（一个 apply 函数）、应用是什么（一棵插件树）  —— 7.1
//   ② 子 context 怎么既看得见父的东西、又改不到它              —— 7.2
// 服务（阶段 8）、可逆注册（阶段 9）、类型化事件（阶段 10）都还没有。

/**
 * 一个插件能拿到的东西。
 *
 * 每个插件拿到的是**自己的一份** `Context`，而且这一份是用 {@link extend}
 * 从父那里派生出来的：原型链继承父的一切，自己的属性遮住继承来的，父不被改。
 */
export class Context {
  /** 这个 context 属于哪个插件。用于诊断输出。 */
  readonly name: string = 'root'
  /** 装它的那个 context。根是 undefined。 */
  readonly parent: Context | undefined = undefined
  /**
   * 在它下面直接装过的子 context，按装载顺序。
   *
   * 每个 context 都要有**自己的**这个数组——{@link plugin} 里显式给了它一个。
   * 忘了给的话它会顺着原型链找到父的那个，于是所有插件都挂进同一个数组，
   * 树就塌成一层了。这是原型链继承最容易踩的坑：**可变对象不能靠继承共享。**
   */
  readonly children: Context[] = []

  /**
   * 服务表：**整棵树共用一张**（8.1）。
   *
   * 只有根真正持有它；子 context 通过原型链拿到的是**同一个 Map**。
   * 7.2 说过"可变对象不能靠继承共享，否则子的修改会打到父身上"——
   * 这里**恰恰要那个效果**：任何一层 provide 的服务，整棵树都要看得见。
   * 所以 {@link extend} 故意不给子一份新的，而 `children` 故意要给。
   * **同一条语言规则，一次是坑，一次是工具；区别只在于你要不要共享。**
   */
  private readonly services = new Map<string, unknown>()

  /**
   * 依赖还没齐、暂时装不上的插件（8.2）。和 {@link services} 一样，整棵树共用一份。
   */
  private readonly pending: PendingPlugin[] = []

  /**
   * 还没跑完的异步 `apply`（8.3）。和上面两个一样，整棵树共用一份。
   *
   * 装载因此不再是"调完 `plugin()` 就装完了"：真正的完成点是 {@link ready}。
   */
  private readonly inflight: Promise<void>[] = []

  /** 这棵树的根。服务的访问器都定义在它身上，于是所有后代都读得到。 */
  private get root(): Context {
    let node: Context = this
    while (node.parent !== undefined) node = node.parent
    return node
  }

  /**
   * 提供一个服务：写进整棵树共用的服务表，并让 `ctx.<name>` 读得到。
   *
   * 读的那一头靠**在根上定义一个访问器**：每个 context 都以根为原型祖先，
   * 所以在根上定义一次，整棵树都读得到——**兄弟之间从此看得见了**。
   * 定义成 getter 而不是直接赋值，是为了让后来的 `provide` 能透明地换掉实现。
   * @param name - 服务名。
   * @param value - 服务实例。
   * @throws 这个名字已经被别人提供过了。**重名是装配错误，不是"后者覆盖前者"。**
   */
  provide(name: string, value: unknown): void {
    const root = this.root
    if (root.services.has(name)) throw new Error(`服务重名：${name} 已经被提供过了`)
    root.services.set(name, value)
    Object.defineProperty(root, name, {
      get: () => root.services.get(name),
      configurable: true,      // 阶段 9 要能撤销，所以必须可重新配置
      enumerable: true,
    })
    // 有新服务了，看看有没有插件正等着它（8.2）。
    this.drain()
  }

  /**
   * 列出当前已经提供了哪些服务，按提供顺序。
   *
   * 本阶段最有用的 debug 手法：**读到 undefined 时，先看那个服务到底提供了没有**。
   * @returns 服务名。
   */
  listServices(): string[] {
    return [...this.root.services.keys()]
  }

  /**
   * 派生一个子 context。
   *
   * `Object.create(this)` 让子**以父为原型**：父身上的一切，子都看得见；
   * 而子身上定义的同名属性会**遮住**继承来的那个，父自己一个字节都不变。
   *
   * 和"把父的属性复制一份"最大的区别是：**继承是活的**。
   * 父在这之后新增的属性，子立刻就能看见；复制只能拿到复制那一刻的快照。
   * 插件是陆续装上去的，所以这个差别是决定性的。
   * @param meta - 要在子身上定义的自有属性。
   * @returns 一个以当前 context 为原型的子 context。
   */
  extend<T extends object>(meta: T): this & T {
    const child = Object.create(this) as this & T
    Object.assign(child, meta)
    return child
  }

  /**
   * 装一个插件。
   *
   * 三件事：{@link extend} 出一个子 context、记进插件树、调它的 `apply`。
   * 但在这之前先看它的 `inject`：**依赖没就绪就不装，挂起来等**（8.2）。
   * 没有"卸载"——阶段 9 才会有。
   * @param plugin - 一个 `apply` 函数，或者一个带 `apply` 方法的对象。
   * @param config - 原样传给 `apply` 的第二个参数。这个插件的配置。
   * @throws 传进来的东西不是插件。
   */
  plugin<T>(plugin: Plugin<T>, config?: T): void {
    // 类插件（8.4）：`new` 它，构造函数自己会 provide。
    // 判据是原型链而不是 `typeof`——类在 JS 里就是函数，`typeof` 分不开。
    if (typeof plugin === 'function' && plugin.prototype instanceof Service) {
      const Ctor = plugin as new (ctx: Context) => Service
      const inject = (plugin as { inject?: readonly string[] }).inject ?? []
      const entry: PendingPlugin = {
        name: plugin.name || '(匿名服务)',
        inject,
        apply: ctx => { new Ctor(ctx) },
        config,
        ctx: this,
      }
      if (this.missing(inject).length > 0) this.root.pending.push(entry)
      else this.install(entry)
      return
    }
    const apply = typeof plugin === 'function' ? plugin : plugin.apply
    if (typeof apply !== 'function') {
      throw new Error(`不是一个插件：需要函数或带 apply 方法的对象，收到 ${typeof plugin}`)
    }
    // 名字用来在插件树里认人。函数插件用函数名，对象插件优先用它自己声明的 name。
    const name = (typeof plugin === 'function' ? plugin.name : plugin.name ?? plugin.apply.name) || '(匿名)'
    const inject = typeof plugin === 'function' ? [] : plugin.inject ?? []
    const entry: PendingPlugin = { name, inject, apply: apply as PendingPlugin['apply'], config, ctx: this }
    // 依赖齐了就立刻装；差一个就挂起，等 provide 把它唤醒。
    if (this.missing(inject).length > 0) this.root.pending.push(entry)
    else this.install(entry)
  }

  /**
   * 真正把一个插件装上：派生子 context、记进树、调 apply。
   * @param entry - 待装的插件。
   */
  private install(entry: PendingPlugin): void {
    // children 必须显式给一个新数组——见它的字段注释。
    const child = entry.ctx.extend({ name: entry.name, parent: entry.ctx as Context, children: [] as Context[] })
    entry.ctx.children.push(child)
    // **异常不拦**：装配失败必须当场炸，而不是"这一项被跳过了"。
    const result = entry.apply(child, entry.config)
    // 异步插件（8.3）：记下这个 promise，{@link ready} 会等它。
    // 它跑完之前，它 provide 的服务还不存在，所以依赖它的插件仍然挂着——
    // **"依赖就绪"从此包含了"提供者真的跑完了"**。
    if (result instanceof Promise) this.root.inflight.push(result)
  }

  /**
   * 这些依赖里，哪些还没被提供。
   * @param inject - 依赖的服务名。
   * @returns 还缺的那些。
   */
  private missing(inject: readonly string[]): string[] {
    return inject.filter(name => !this.root.services.has(name))
  }

  /**
   * 把挂起队列里依赖已经齐了的插件装上，直到装不动为止。
   *
   * 每装一个就**重新扫一遍**：一个插件装上时可能又提供了新服务，
   * 于是原本还差东西的另一个插件这一刻就齐了。
   */
  private drain(): void {
    for (;;) {
      const index = this.root.pending.findIndex(entry => this.missing(entry.inject).length === 0)
      if (index === -1) return
      const [entry] = this.root.pending.splice(index, 1)
      // splice 保证只会取到一个；这个断言表达的是那个不变量。
      if (entry !== undefined) this.install(entry)
    }
  }

  /**
   * 按注册的**逆序**收掉所有服务。
   *
   * 逆序的理由和 `finally` 里关资源一样：后注册的可能用着先注册的。
   * 只有实现了 `dispose` 的服务会被叫到，其余的（纯数据服务）跳过。
   * @throws 任何一个 `dispose` 抛出的错误，原样向上抛。
   */
  async dispose(): Promise<void> {
    const services = [...this.root.services.values()].reverse()
    for (const value of services) {
      if (value instanceof Service && value.dispose !== undefined) await value.dispose()
    }
  }

  /**
   * 等到装配真正结束：所有异步 `apply` 都跑完，而且再没有插件能被唤醒。
   *
   * 同步装载时代不需要它——`plugin()` 返回就等于装完了。有了异步插件之后，
   * "调用返回"和"装配完成"是两件事，必须有一个显式的汇合点。
   *
   * 循环是必须的：等一批 promise 的过程中，它们 provide 的服务会唤醒更多插件，
   * 而那些插件可能又是异步的。**一轮等不干净。**
   * @throws 任何一个插件的 `apply` 抛出的错误，原样向上抛。
   */
  async ready(): Promise<void> {
    for (;;) {
      const tasks = this.root.inflight.splice(0)
      if (tasks.length === 0) return
      // 不用 allSettled：装配失败要当场炸，不要"记下来最后一起报"。
      await Promise.all(tasks)
    }
  }

  /**
   * 还挂着没装的插件，以及各自在等什么。
   *
   * 本阶段最有用的 debug 手法：**"我的插件没跑"，先看它是不是在等一个永远不会来的服务**。
   * 装配结束后这个列表应该是空的——不空就说明有依赖没人提供（多半是名字写错了）。
   * @returns 每个挂起插件的名字和它还缺的服务。
   */
  pendingPlugins(): { name: string, waitingFor: string[] }[] {
    return this.root.pending.map(entry => ({ name: entry.name, waitingFor: this.missing(entry.inject) }))
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

  /**
   * 列出这个 context 自己加的东西——不含从父继承来的。
   *
   * 靠的是 `Object.getOwnPropertyNames`：它只看**自有属性**，不看原型链。
   * "这一层贡献了什么"和"这一层能看见什么"是两个问题，这个方法回答前者。
   * @returns 自有属性名，去掉 `plugin()` 自己塞的那三个。
   */
  ownKeys(): string[] {
    const internal = new Set(['name', 'parent', 'children', 'services'])
    return Object.getOwnPropertyNames(this).filter(key => !internal.has(key))
  }
}

/**
 * 一个**服务**：既是插件，也是它自己注册的那个东西（8.4）。
 *
 * 7.1 说过 Cordis 接受三种插件形态，第三种就是它——一个 `Service` 子类。
 * 它把总是一起出现的三件事绑在了一个构造函数里：
 *
 * 1. **注册**：`super(ctx, name)` 里就 `provide` 了，不用调用方再写一行。
 * 2. **命名**：名字是构造参数，实例自己也知道自己叫什么（诊断时有用）。
 * 3. **持有 ctx**：服务从此能自己用 ctx，不用调用方把东西喂进来。
 *
 * 加上一个可选的 {@link dispose}：**谁申请的资源谁负责收**。
 * 阶段 9 会把这条推广到所有注册（监听器、定时器、临时文件），而不只是服务。
 */
export abstract class Service {
  /** 这个服务注册用的名字。 */
  readonly name: string

  /**
   * 注册自己。
   *
   * 注意 `provide` 发生在**构造函数里**，也就是子类的字段还没初始化完的时候。
   * 所以别在构造期间去读 `ctx.<自己的名字>`——那时拿到的是个半成品。
   * dsh 有一个 `Service.init` 符号专门放"构造完之后再跑"的逻辑。
   * @param ctx - 这个服务所属的 context。
   * @param name - 注册用的名字。
   */
  constructor(protected readonly ctx: Context, name: string) {
    this.name = name
    ctx.provide(name, this)
  }

  /**
   * 收尾。整棵树被 {@link Context.dispose} 时按**注册的逆序**调用。
   *
   * 逆序是因为后注册的可能用着先注册的：先收后来的，再收更早的。
   */
  dispose?(): void | Promise<void>
}

/**
 * 一个插件：要么是函数，要么是带 `apply` 方法的对象，要么是一个 {@link Service} 子类。
 *
 * dsh 的 Cordis 还接受第三种——一个 `Service` 子类（阶段 8 才讲）。
 * 对象形态的好处是能带 `name`：函数插件靠函数名，而打包工具可能把函数名改掉。
 */
export type Plugin<T = unknown> =
  | (new (ctx: Context) => Service)
  | ((ctx: Context, config: T) => void | Promise<void>)
  | {
    name?: string
    /**
     * 这个插件要用到哪些服务（8.2）。
     *
     * 声明了就意味着：**这些服务没就绪之前，不要装我**。装载器会把这个插件
     * 挂起，等最后一个依赖被 provide 时再装。所以清单里的书写顺序不再重要。
     */
    inject?: readonly string[]
    /**
     * 装这个插件时跑的函数。
     *
     * 返回 promise 时装载器会等它（8.3）：在它 resolve 之前，这个插件 provide 的
     * 服务还不存在，依赖它的插件继续挂着。所以插件可以在装载过程中做 I/O。
     */
    apply: (ctx: Context, config: T) => void | Promise<void>
  }

/** 挂在队列里等依赖的一个插件。 */
interface PendingPlugin {
  name: string
  inject: readonly string[]
  apply: (ctx: Context, config: unknown) => void | Promise<void>
  config: unknown
  /** 当初调 `ctx.plugin()` 的那个 context——装上时它才是父节点。 */
  ctx: Context
}
