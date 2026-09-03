# 1.1 配置与密钥

> 本课目标：把"一次模型调用需要哪些外部事实"想清楚，并写出第一个会**主动报错**的模块。
>
> **跑一下**：`npm run demo demos/01-minimal-agent/01-config-errors.mjs` —— 三种配置缺失各自的报错，以及密钥为什么只活在环境变量里。

## 一次模型调用要知道四件事

```
POST {baseURL}/chat/completions
Authorization: Bearer {apiKey}

{ "model": "{model}", "messages": [ ... ] }
```

- **baseURL**：调哪个地址。换供应商、换自建网关，只改这一项。
- **model**：用哪个模型。
- **apiKey**：凭什么让你调。
- **messages**：这次要说什么（这是运行时数据，不是配置）。

前三项都是"部署时才知道"的事实，不该硬编码在代码里。所以它们进配置文件。

## 密钥不进配置文件

看起来最自然的写法是这样：

```jsonc
{ "apiKey": "sk-abc123..." }   // ❌ 别这么写
```

问题不在于"有人会看到"，而在于**它会被提交**。一旦进了 git 历史，删掉那一行是没用的——历史里还留着，而且很多人已经 clone 走了。此外它还会顺着报错栈、日志、崩溃上报流出去。

我们的做法是：配置里只放**环境变量的名字**。

```json
{
  "baseURL": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "systemPrompt": "You are a helpful assistant."
}
```

模板见 [`dsh-learn.example.json`](../../../dsh-learn.example.json)。真实配置 `dsh-learn.json` 已经在 `.gitignore` 里——不过注意，就算它被提交了也不会泄露密钥，因为里面根本没有密钥。这是"设计上就不可能出事"和"靠人记得别犯错"的区别。

```sh
cp dsh-learn.example.json dsh-learn.json
export DEEPSEEK_API_KEY=sk-...
```

## 代码：[`src/config.ts`](../../../src/config.ts)

三件事：找到文件、校验字段、取出密钥。

```ts
const CONFIG_URL = new URL('../dsh-learn.json', import.meta.url)
```

用 `import.meta.url` 而不是相对路径字符串，是为了让"在哪敲命令"不影响结果（[0.2](../../00-env-basics/02-typescript-esm/01-typescript-esm.md) 讲过）。

```ts
const config = JSON.parse(raw) as Config

for (const field of ['baseURL', 'model', 'apiKeyEnv', 'systemPrompt'] as const) {
  if (typeof config[field] !== 'string' || config[field] === '') {
    throw new Error(`配置项 ${field} 缺失或不是非空字符串`)
  }
}
```

这就是阶段 0 说的那条边界规则的第一次落地：**`as Config` 不校验任何东西**，真正的把关是下面那个循环。配置文件是外部输入，必须在这里检查。

```ts
const apiKey = process.env[config.apiKeyEnv]
if (apiKey === undefined || apiKey === '') {
  throw new Error(`环境变量 ${config.apiKeyEnv} 没有设置。\n先导出密钥：export ${config.apiKeyEnv}=sk-...`)
}
```

注意报错信息里带了**可以照着敲的下一步**。这是有意的：报错的读者是"卡住的人"，一条只说"配置错误"的消息等于什么都没说。

## 为什么在这里就报错

配置只在 `loadConfig()` 里被检查一次，而且是在任何请求发出之前。这条选择有个名字：**配置错误要尽早、响亮地失败**。

反面做法是"缺什么就用个默认值兜着"——比如密钥缺失就发一个匿名请求。结果是你收到一个 401，去查网络、查供应商、查模型名，最后发现是环境变量拼错了。一次本该在 0.1 秒内结束的失败，被拖成了半小时。

dsh 把这条写成了硬规矩：**误配置在能自洽判断时于加载期失败**，否则在最早可判定的点失败，绝不静默跳过缺失的引用。

## 教 debug：三个状态码分别怀疑什么

真发出请求之后，如果失败，先看状态码再看别的：

| 状态码 | 先怀疑 | 怎么确认 |
|---|---|---|
| **401 / 403** | 密钥不对，或者根本没带上 | `echo ${DEEPSEEK_API_KEY:0:6}` 看变量在不在（别打印全量） |
| **400** | 请求体不对：模型名拼错、messages 结构不合法 | 把请求体原样打出来，和下一课的 curl 版本对照 |
| **404** | baseURL 拼错了，路径重复或缺少 `/v1` | 把最终 URL 打出来看一眼 |
| **429** | 限流或余额不足 | 看响应体里的具体说明 |

**永远打印响应体**。很多供应商把真正的原因写在 body 里，只看状态码会漏掉。这也是 [`llm.ts`](../../../src/llm.ts) 里失败时先 `await response.text()` 再抛错的原因。

## 对照 dsh

我们用一个字段 `apiKeyEnv` 解决的问题，dsh 用了一整条能力接缝：

| | 我们的 | dsh 的 | 为什么 dsh 更复杂 |
|---|---|---|---|
| 密钥来源 | `process.env[name]` | `dsh/packages/credentials/` 的凭据引用 seam（env 优先，其次 `.env`） | 来源可替换：环境变量、文件、将来的密钥服务 |
| 取密钥的时机 | 启动时取一次 | 每次请求现取（`DeepSeekConnectionOptions.apiKeyEnv`，见 `dsh/packages/llm/llm-deepseek/src/adapter.ts`） | 配置变更能立刻生效，且不会把这一代的 URL 配上一代的密钥 |
| 配置校验 | 手写 if | Schemastery schema（阶段 11） | 校验规则本身可被组合、可被生成文档 |
| 配置来源 | 一个 JSON 文件 | profile / bundle / patch 分层叠加 | 一份部署可以在不改代码的前提下被覆盖 |

差距会在阶段 8、11 补上。现在保持一个 JSON 文件就够了——你还没有第二个部署要伺候。

---

下一课：[1.2 先用 curl 打通](../02-messages-curl/01-messages-curl.md)
