# 7.2 ctx 为什么是每个插件一份

7.1 的 `plugin()` 给每个插件造了一个新 context：

```ts
const child = new Context(name, this)
```

它除了名字和父指针什么都没有。**于是插件拿不到任何东西。**

## 痛点：一个空的 context 没有用

插件要干活，总得用到点什么：配置、日志、工具表、会话。这些东西不可能每个插件自己造——那就退回到 7.1 之前 import 具体实现的状态了。

四个候选答案，前三个都有明确的代价：

**① 把父对象本身传下去**（也就是所有插件共用一个全局 `ctx`）。

`plugin()` 变成 `apply(this, config)`。能跑，但两样东西没了：

- **"谁注册的"这件事**。所有插件写在同一个对象上，卸载的时候不知道该收谁的。阶段 9 整个做不了。
- **隔离**。一个插件手滑写了 `ctx.config = null`，全世界一起挂。

而且 7.1 讲过的插件树会塌成一层——父子关系本来就存在于"我拿到的是哪个 ctx"里。

**② 每个插件自己造自己要的东西。** 那就是 import 具体实现，5.2 那个"两段都自己 spawn 一次 git"的形状会在每个插件上重演一遍。

**③ 把父的属性复制一份给子**（`{ ...parent }`）。

这个看起来最像"对的"，但它有一个致命问题：**复制只能拿到复制那一刻的快照**。

插件是**陆续**装上去的。`configPlugin` 在第 1 个装，`sessionPlugin` 在第 5 个装——如果第 1 个插件的 ctx 是在它装载时复制的，那它永远看不见后面几个插件加的东西。

> 这四个候选里，只有一个能同时满足"看得见"和"改不到"。

## 解法：一句话和一张图

**一句话：子 context 以父为原型（`Object.create(parent)`），父身上的一切子都看得见，子自己定义的同名属性遮住继承来的，而父一个字节都不变。**

```
改前（7.1）：每个插件一个空对象
   root { logger, config }
     └─ child { name, parent }          ← 只有这两样，logger 用不了

改后：原型链
   root { logger, config }
     ↑ [[Prototype]]
   child { name, parent, children }     ← 自有属性只有这三个
     读 child.logger  → 自己没有 → 顺着原型链找到 root 的 ✓
     写 child.logger  → **定义在 child 自己身上**，root 不变
```

JS 的属性查找规则是现成的：**读的时候顺着原型链往上找，写的时候只写自己。** 我们要的语义恰好就是它，不用自己实现。

### 一屏看完的完整实现

`src/cordis.ts` 新增的就一个方法：

```ts
extend<T extends object>(meta: T): this & T {
  const child = Object.create(this) as this & T
  Object.assign(child, meta)
  return child
}
```

`plugin()` 改一行：

```ts
// children 必须显式给一个新数组——见下面的坑。
const child = this.extend({ name, parent: this as Context, children: [] as Context[] })
```

再加一个诊断方法：

```ts
/** 列出这个 context 自己加的东西——不含从父继承来的。 */
ownKeys(): string[] {
  const internal = new Set(['name', 'parent', 'children'])
  return Object.getOwnPropertyNames(this).filter(key => !internal.has(key))
}
```

`Object.getOwnPropertyNames` **只看自有属性，不看原型链**——所以它回答的是"这一层贡献了什么"，而不是"这一层能看见什么"。这两个问题在 debug 时要分开问。

### 产出长什么样

```sh
node --import tsx demos/07-cordis/03-extend.mjs
```

```
=== ① 看得见：子没有 logger，但用得了 ===
    [日志] 我自己没有 logger，这是从父那里继承来的
    ctx.config.model = deepseek-chat
    自有属性：[]   ← 空的，全是继承来的

=== ② 遮得住：子给自己定义一个同名的，父不受影响 ===
    [子的日志] 我用的是自己的
    自有属性：["logger"]
    [日志] 父的 logger 还是原来那个

=== ③ 改不到：子改自己的，父看不见 ===
    子看到的 readOnly = true
  父看到的 readOnly = false   ← 没被改
```

## 四个必须知道的细节

### ① 继承是"活的"，复制不是

这是选原型链而不是选复制的**唯一决定性理由**：

```
=== ⑤ 继承是活的：父后来加的东西，子立刻看得见 ===
    装载时 ctx.tools = undefined
  之后 captured.tools = ["read","write"]   ← 看得见
```

那个插件先装，`root.tools` 后加，但它手里的 ctx **立刻**就能读到。因为原型链是一条**引用**，不是一次拷贝：每次读属性都重新沿着链找一遍。

如果 `extend` 是 `{ ...parent }`，这里就是 `undefined` 了。而插件本来就是陆续装上去的，所以这个差别不是优化，是能不能用的问题。

### ② "改不到"只对**重新赋值**成立

这是最容易被教程跳过、而实际会咬人的一条：

```
=== ④ 但"改不到"只对重新赋值成立 ===
  父看到的 readOnly = true   ← 被改了！
```

```ts
ctx.config = { ...ctx.config, readOnly: true }   // ✓ 父不受影响：换的是 child 自己的绑定
ctx.config.readOnly = true                       // ✗ 父被改了：改的是那个共享对象的字段
```

**继承共享的是引用，不是副本。** 子改不了"`ctx.config` 指向谁"，但它照样能改那个对象里面的东西。

原型链给的是**绑定隔离**，不是**值隔离**。真正的隔离要靠只读数据（`Object.freeze`）或者服务（阶段 8 会看到 dsh 怎么处理）。

### ③ 可变对象不能靠继承共享

```ts
const child = this.extend({ name, parent: this, children: [] })
//                                             ^^^^^^^^^^^^^ 必须显式给
```

忘了给会怎样？子读 `this.children` 时顺着原型链找到**父那个数组**，然后 `push` 进去：

```
=== ⑥ 踩坑演示 ===
  父的 children 长度 = 1   ← 子的 push 打到父身上了
```

于是所有插件都挂进同一个数组，**整棵树塌成一层**。

这是原型链继承的经典陷阱，判据很简单：**这个属性会被原地修改吗？会的话，每一层都必须有自己的一份。** 函数、字符串、只读配置可以放心继承；数组、Map、Set 不行。

（同样的坑在 JS 里有个更出名的版本：把数组放在类的 `prototype` 上，所有实例共享它。）

### ④ 继承只解决了一半问题

```sh
node --import tsx demos/07-cordis/04-who-added-what.mjs
```

```
=== ② 兄弟之间互相看不见 ===
  TypeError: Cannot read properties of undefined (reading 'readOnly')
```

`configPlugin` 写的是**它自己的** ctx；`guardsPlugin` 读的是**它自己的** ctx。两个 ctx 是兄弟，而**继承只朝一个方向走：子看得见父，父看不见子，兄弟互不相见。**

现在唯一能用的办法是让父先写好再装子：

```ts
ctx.config = { readOnly: true }       // 父自己写
ctx.plugin(guardsPlugin)              // 子继承得到
```

它能跑，但代价是**回到了 7.1 那个痛点**：那个父插件必须亲自知道 config 长什么样、必须在装 guards 之前写好它。装配顺序又变成手写的，"谁依赖谁"仍然只存在于作者脑子里。

**这就是阶段 8 存在的理由**，7.3 之所以还不能真正拆掉 `index.ts`，缺的也正是这一块。

## 教 debug：两栏，两个不同的问题

阶段 7 的诊断分两层，对应两个不同的问题：

```
root
  assembly
    configPlugin   + config
    toolsPlugin    + tools
    loggerPlugin   + logger
```

**左边那棵树回答"装了什么"** —— 7.1 讲过：某个功能没生效，先看它在不在树里。

**右边的 `+ xxx` 回答"每一层各自贡献了什么"** —— 用 `ownKeys()`，也就是 `Object.getOwnPropertyNames`。

两栏分开看，能直接定位三类问题：

**某个属性读到 `undefined`。** 顺着树往上数，哪一层的 `+` 里有它？**一个都没有** → 根本没人提供，去找那个插件为什么没装上。**有，但在兄弟节点上** → 就是上面那个"兄弟互不相见"，阶段 8 的服务才解决。

**改了配置但不生效。** 看看是不是有下层插件把它**遮住**了（那一层的 `+` 里出现了同名属性）。原型链的遮蔽是静默的——没有警告，没有报错，只是你读到的不是你以为的那个。

**父的数据被莫名改掉。** 回到细节 ②：是不是哪个插件做了 `ctx.config.xxx = …` 而不是 `ctx.config = {...}`。**在 `ownKeys()` 里看不见这种修改**——它没有创建自有属性，只是改了共享对象的内部。这也是为什么 dsh 要把很多东西 deep-freeze。

## 对照 dsh

dsh 的 `extend()`（`dsh/vendor/cordis/src/context.ts`）：

```ts
extend(meta = {}): this {
  const shadow = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value
  const self = Object.create(getTraceable(this, this))
  for (const prop of Reflect.ownKeys(meta)) {
    Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop)!)
  }
  if (!shadow) return self
  return Object.assign(Object.create(self), { [symbols.shadow]: shadow })
}
```

内核和我们的一模一样：`Object.create(父)` 加上自有属性。注释里那句话也和我们说的一样：

> The child prototypally inherits every property of this context; own properties of `meta` shadow the inherited ones. **The parent is not mutated.**

多出来的三处各买了一样东西：

**`Reflect.ownKeys` 而不是 `Object.assign`。** `ownKeys` 包括 **symbol 键**，而 `Object.assign` 只复制可枚举的自有属性。dsh 用 symbol 存隔离表、拦截表这些内部状态，所以必须用前者。

**`Object.defineProperty` + `getOwnPropertyDescriptor` 而不是直接赋值。** 这样连 getter/setter、`enumerable`、`writable` 都原样搬过去。直接赋值会把一个 getter 变成一个普通值——**求值时机就从"每次读"变成了"extend 那一刻"**，又是 5.2 那个"变量什么时候取值"的问题。

**`getTraceable(this, this)`。** dsh 的 ctx 是一个 **Proxy**，属性读取要走服务解析器。这是阶段 8 的内容。

### `isolate()` 和 `intercept()` 都是 `extend()` 的特例

```ts
isolate(name: string, label?: symbol) {
  const shadow = Object.create(this[symbols.isolate])
  shadow[name] = label ?? Symbol(name)
  return this.extend({ [symbols.isolate]: shadow })      // ← 就是 extend
}

intercept(name: string, config: any) {
  const intercept = Object.create(this[symbols.intercept])
  intercept[name] = config
  return this.extend({ [symbols.intercept]: intercept })  // ← 也是 extend
}
```

`isolate` 让某个服务在子树里换一个实现（subagent 用它换掉 `tools`），`intercept` 给子树里的插件注入额外配置。两个听起来很高级的功能，实现都是"extend 一个带新元数据的子 context"。

注意它们内部也用了 `Object.create` 来派生那两张表——**同一个模式套了两层**：context 继承 context，隔离表继承隔离表。这样子树改自己的隔离表，父的那张不受影响。

| | 我们的 | dsh 的 | 哪个阶段补齐 |
|---|---|---|---|
| 派生 | `Object.create` + `Object.assign` | `Object.create` + `Reflect.ownKeys` + `defineProperty` | 不补（我们不需要 symbol 和 getter） |
| ctx 是什么 | 普通对象 | Proxy，读属性走服务解析 | 阶段 8 |
| 服务隔离 | 没有 | `isolate()` | 阶段 14（subagent 换实现） |
| 分层配置 | 没有 | `intercept()` | 阶段 11 |
| 兄弟之间共享 | **做不到** | 服务挂在 ctx 上，对整棵树可见 | **阶段 8** |

## 这一课改了什么

| 文件 | 改动 |
|---|---|
| `src/cordis.ts` | 新增 `extend()` 和 `ownKeys()`；`plugin()` 改用 `extend()` 派生子 context |
| `demos/07-cordis/03-extend.mjs` | 新增：看得见 / 遮得住 / 改不到 / 继承是活的 / 两个坑 |
| `demos/07-cordis/04-who-added-what.mjs` | 新增：树 + 每层贡献；兄弟互不相见 |

## 下一课

7.3 把 `index.ts` 和 `headless.ts` 的装配拆成插件。但上面已经看到了：**兄弟插件之间还拿不到对方的产出**。

所以 7.3 会用一个过渡办法——**让装配插件自己持有那几样东西，子插件从父继承**。这能把两个入口的重复消掉，但"谁依赖谁"还是手写的顺序。等阶段 8 的服务到位，那个手写顺序才会消失。

**先解决重复，再解决顺序。** 一次只动一样。
