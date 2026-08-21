# 0.2 TypeScript 与 ESM 的最小集

> 本课目标：认识后面每一课都会用到的那几个语法，以及两条会真的把你卡住的模块规则。
>
> **声明**：这不是完整的 TypeScript 教程。后面用到的新语法会随用随讲——这是本课程的规矩：用到再讲。

## 类型只在编译期存在

这是理解 TypeScript 的第一件事，也是最容易被忽略的一件事：

```ts
interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const m = JSON.parse(raw) as Message   // 运行时什么检查都没发生
```

`as Message` 不校验任何东西，它只是告诉编译器"我保证它长这样"。如果 `raw` 里 `role` 是 `"assisstant"`（拼错了），程序照跑不误，直到模型返回 400 你才知道。

所以类型标注解决的是"我改这里会不会碰坏那里"，**不解决"外面进来的数据对不对"**。这两件事的分界线在 dsh 里是一条明确的规矩：同进程内、由 TypeScript 保证的边界不做运行时校验；而解析配置、模型返回的 JSON、落盘文件、跨进程消息这些地方**必须**校验。你会在阶段 1.1 的配置校验里第一次实践它，在阶段 11 的 Schemastery 里看到它的工业级版本。

## 会用到的六个语法

```ts
// 1. 类型标注：变量、参数、返回值
const who: string = 'dsh'
function greet(name: string): string { return `hello, ${name}` }

// 2. interface：描述一个对象有哪些字段
interface Config { baseURL: string, model: string }

// 3. 联合类型：只能是这几个值之一（比 string 精确得多）
type Role = 'system' | 'user' | 'assistant'

// 4. 数组与 Record
const messages: Message[] = []
const headers: Record<string, string> = { 'content-type': 'application/json' }

// 5. 可选与空值合并
interface Options { timeout?: number }        // 可能没有这个字段
const timeout = options.timeout ?? 30_000     // 只有 null/undefined 才取右边

// 6. 泛型（用到的时候会展开讲，先知道长这样）
async function json<T>(response: Response): Promise<T> { return await response.json() as T }
```

联合类型值得多看一眼：把 `role` 写成 `'system' | 'user' | 'assistant'` 而不是 `string`，编译器就能在你写 `'assisstant'` 时当场报错。dsh 把这一点用到了极致——它要求所有闭合的联合类型在 `switch` 的最后落到 `assertNever`，这样以后新增一个成员，所有没处理它的地方都会立刻变红。

## `import type` 为什么单独存在

```ts
import type { Config } from './config.ts'   // 只借类型，运行时这行会消失
import { loadConfig } from './config.ts'    // 真的要这个函数，运行时保留
```

只需要类型时用 `import type`，编译产物里就不会留下这次导入。好处不只是省几个字节：它让"我只是想描述一个形状"和"我真的依赖这个模块"变成两件在代码里看得见的事。dsh 的包与包之间大量使用它——一个插件可以只依赖某个能力的**类型**，而不依赖它的实现。

## 两条 ESM 规则

dsh 全仓库 `"type": "module"`，用的是 ES Modules（`import` / `export`），不是老的 CommonJS（`require`）。两条会卡住你的规则：

**1. 本地相对导入要写 `.ts` 后缀。**

```ts
import { chat } from './llm.ts'   // ✅
import { chat } from './llm'      // ❌ ERR_MODULE_NOT_FOUND
```

ESM 按字面路径找文件，不会替你猜后缀。跨包导入则相反，写包名：`import { ... } from '@deepseek-ai/dsh-llm'`。

**2. 没有 `__dirname`。**

取而代之的是 `import.meta.url`——当前模块自己的 URL。想找同级或上级的文件：

```ts
const CONFIG_URL = new URL('../dsh-learn.json', import.meta.url)
```

这正是 [`src/config.ts`](../../../src/config.ts) 的写法。注意它和 `readFileSync('dsh-learn.json')` 的区别：后者相对于**你敲命令时所在的目录**，换个目录就找不到了；前者相对于**代码文件自己**，永远正确。

## `strict: true` 严在哪

dsh 全仓库开 `strict`，最常撞见的两条：

- **`noImplicitAny`**：参数不写类型、编译器又推不出来，就报错。逼你在函数签名上把契约写清楚。
- **严格空值检查**：`string | undefined` 不能当 `string` 用。`completion.choices[0]?.message.content` 里的 `?.` 就是为此存在——数组下标可能取空，编译器不允许你假装它一定有。

这类"编译器很烦"的时刻，通常是它在提醒你有一条真实存在的路径没想过。阶段 1.3 里"模型可以合法地返回 `null` content"就是这么被逼出来的一个考虑。

---

下一课：[0.3 Debug：这门课最重要的一课](../03-debug/01-debug.md)
