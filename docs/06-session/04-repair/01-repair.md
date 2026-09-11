# 6.4 坏掉的日志怎么读回来

6.3 保证了"该落盘的一定在盘上"。这一课管另一头：**那个盘上的文件读不回来怎么办。**

## 痛点：一次崩溃让整个会话报废

写入不是原子的。`handle.writeFile(content)` 把几百行一次交给内核，但进程被 `kill -9` 的那一刻可能正好写到一半——文件末尾于是留下**半行 JSON**：

```
{"type":"tool/result","seq":5,"time":1789011348341,"data":{"callId":"call_1","conte
```

6.2 的 `loadSession()` 遇到它的反应是：

```ts
event = JSON.parse(line) as SessionEvent      // ← 抛错
```

于是 `--resume` 打不开，**整个会话读不回来**。前面 7 条事件好端端在那里，因为第 8 条写了一半，全部作废。

这很荒唐：我们花了一整课（6.3）保证落盘，最后卡在读的那一步。**能写进去但读不出来的数据，等于没写。**

还有两种"坏"也会撞上同一行代码，但它们的性质完全不同：

- 日志是**完好的**，只是里面有一条这个程序不认识的事件类型（更新的版本写的）
- 日志是完好的，只是**格式版本**比这个程序新

这两种情况下文件一个字节都没坏。把它们和"半行残骸"用同一个 `throw` 处理，等于告诉用户"你的数据坏了"——**而真相是"你该换个版本的程序打开它"**。

> 一个 `catch` 里塞三种毛病，用户就拿不到任何可照做的信息。

## 解法：一句话和一张图

**一句话：按字节扫到最后一个完整行；末尾的残骸可以丢，其余任何异常一律拒绝，而且"坏了"和"读不懂"是两种不同的错误。**

```
                     ┌─ 末行没有换行符 ────────→ 崩溃残骸：丢掉，报告丢了多少字节
                     │                          （唯一被容忍的坏）
  读日志 ─→ 逐行扫 ──┼─ 完整的行读不动 ────────→ SessionLogCorruptionError
                     ├─ seq 有空洞 ────────────→ SessionLogCorruptionError
                     ├─ 不认识的类型，没标 ignorable ─→ SessionFormatUnsupportedError
                     └─ 版本不认识 ─────────────→ SessionFormatUnsupportedError

  然后：truncate 到最后一个完整行 + fsync，再挂持久化
```

**两个错误类型分得开，是因为用户该做的事不一样**：损坏 → 去看备份；读不懂 → 去换版本的程序。

### 一屏看完的完整实现

`src/persistence.ts`：

```ts
/** 这个 build 认识的事件类型。漏写一项编译不过。 */
const KNOWN: Record<SessionEventType, true> = {
  'turn/start': true, 'user/message': true, 'context/snapshot': true,
  'assistant/message': true, 'tool/call': true, 'tool/result': true,
}
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(KNOWN))

export class SessionLogCorruptionError extends Error { … }      // 内容不可信
export class SessionFormatUnsupportedError extends Error { … }  // 完好但读不懂

export function loadSession(path: string): LoadedSession {
  const buffer = readFileSync(path)            // ← Buffer，不是 utf8 字符串

  const headerEnd = buffer.indexOf(0x0A)       // 0x0A 就是 '\n'，按字节找
  if (headerEnd === -1) throw new SessionLogCorruptionError(`会话日志没有完整的会话头：${path}`)

  const header = JSON.parse(buffer.subarray(0, headerEnd).toString('utf8')) as SessionHeader
  if (header.type !== 'session') throw new SessionLogCorruptionError(…)
  // 版本先判，再往下读：连怎么解释都不确定的时候，读出来的东西没有意义。
  if (header.version !== SESSION_FORMAT_VERSION) throw new SessionFormatUnsupportedError(…)

  const events: SessionEvent[] = []
  let committedBytes = headerEnd + 1
  let line = 1
  while (committedBytes < buffer.length) {
    const lineEnd = buffer.indexOf(0x0A, committedBytes)
    // 没有结尾换行 = 这一行没写完 = 崩溃残骸。前面的都是好的，到此为止。
    if (lineEnd === -1) break
    line += 1

    let event: SessionEvent
    try {
      event = JSON.parse(buffer.subarray(committedBytes, lineEnd).toString('utf8')) as SessionEvent
    } catch (error) {
      // 已经有结尾换行还读不动，就不是"写了一半"，是真的坏了。
      throw new SessionLogCorruptionError(`第 ${line} 行有完整的换行但不是合法 JSON：…`)
    }
    if (event.seq !== events.length) throw new SessionLogCorruptionError(`第 ${line} 行的 seq 是 ${event.seq}，按位置应该是 ${events.length}`)
    if (!KNOWN_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
      throw new SessionFormatUnsupportedError(`第 ${line} 行是这个程序不认识的事件类型 "${event.type}"，而且没有标 ignorable。…`)
    }
    events.push(event)
    committedBytes = lineEnd + 1
  }

  return { header, events, committedBytes, tornBytes: buffer.length - committedBytes }
}

/** 把日志截到最后一个完整行，并 fsync。 */
export async function repairLog(path: string, committedBytes: number): Promise<void> {
  await truncate(path, committedBytes)
  // 截断本身也要落盘：否则崩溃两次之后，文件可能还是原来那么长。
  const handle = await open(path, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}
```

`SessionEvent` 的包装里多了一个字段：

```ts
/** 标记"读的人不认识 type 时可以安全跳过这一条"。不写就是必需。 */
ignorable?: true
```

### 用起来是几行

`src/index.ts` 里，续聊的那一步多了一次修复：

```ts
async function loadForResume(): Promise<SessionEvent[]> {
  const loaded = loadSession(logPath)
  if (loaded.tornBytes > 0) {
    console.error(`[修复] 日志末尾有 ${loaded.tornBytes} 字节没写完的残骸（多半是上次被强杀），已丢弃。`)
    await repairLog(logPath, loaded.committedBytes)
  }
  return loaded.events
}

const session = resumeId === undefined ? new Session() : new Session(await loadForResume())
```

**修必须发生在挂持久化之前。** 不截断就追加，新事件会接在那半行后面，拼成一行谁也读不懂的东西——**一次可恢复的崩溃就变成了永久损坏**。

### 产出长什么样

```sh
node --import tsx demos/06-session/07-torn-tail.mjs
```

```
原始日志：1196 字节，9 行

=== 末尾半行（进程被强杀）（1156 字节）===
  读回 7 条事件；可追加偏移 1089；丢弃残骸 67 字节
  修复后文件 1089 字节——半行没了，可以安全追加
  再读一次：7 条事件，残骸 0 字节

=== 中间一行损坏（有换行符）（1026 字节）===
  SessionLogCorruptionError
  第 4 行有完整的换行但不是合法 JSON：Unterminated string in JSON at position 31 (line 1 column 32)

=== 中间少一条（seq 空洞）（992 字节）===
  SessionLogCorruptionError
  第 4 行的 seq 是 3，按位置应该是 2
```

```sh
node --import tsx demos/06-session/08-unknown-and-version.mjs
```

```
=== 不认识的事件，没标 ignorable ===
  SessionFormatUnsupportedError
  第 4 行是这个程序不认识的事件类型 "metrics/sample"，而且没有标 ignorable。
  拒绝解释这个日志——跳过一条必需事件，重建出来的会话是错的。

=== 同一条，标了 ignorable: true ===
  读回 3 条事件，投影出 2 条消息
  投影：system → user

=== 格式版本是 1，程序只认 0 ===
  SessionFormatUnsupportedError
  会话日志的格式版本是 1，这个程序只认 0：…
  这多半是更新的版本写的。用那个版本打开它，别用这个。
```

## 判据：这种坏，是不是崩溃必然产生的那一种

容忍什么、拒绝什么，不该凭感觉。这一课的整个分类来自一个问题：

**"崩溃会不会必然产生这种坏？"**

| 坏法 | 崩溃会产生吗 | 反应 |
|---|---|---|
| 末行没有换行符 | **会**。写入不是原子的，被杀在中途一定长这样 | 丢掉，继续 |
| 完整的行读不动 | 不会。内核要么写了这些字节要么没写，不会改写已有字节 | 拒绝 |
| seq 有空洞 | 不会。我们只追加，从不跳号 | 拒绝 |
| 不认识的事件类型 | 不会。那是别的程序写的 | 拒绝（另一种错误） |

**能自动修的，只有"我们自己的写入路径必然会产生的那一种损坏"。** 其他任何异常都意味着有第三方插手过（手工编辑、磁盘错误、拼错了两个文件、更新版本的程序），那时自动修复是在**猜**，而猜错的代价是把一段历史悄悄读歪。

这条判据可以直接搬到别的地方用：能安全自动恢复的失败模式，是那些你自己的代码路径会产生的；陌生的失败模式要抛给人。

## 为什么必须按字节，不能按字符

```ts
const buffer = readFileSync(path)             // 没有 'utf8'
const headerEnd = buffer.indexOf(0x0A)        // 找字节 0x0A
```

如果写成 `readFileSync(path, 'utf8')` 再 `split('\n')`，有一个场合会错得很隐蔽：**进程死在一个 UTF-8 多字节序列的中间**。

一个汉字在 UTF-8 里是 3 个字节。假设只写进去了头 2 个：

```
…"content":"会议改到周四下午三\xE7\x82      ← 最后那个字只写了 2/3
```

`toString('utf8')` 遇到这种不完整序列，会把它换成**替换字符** `�`（一个字符）。于是：

- 字符串长度和文件字节数**对不上**
- 按字符串位置算出来的 `committedBytes` 是错的
- `truncate(path, 错的偏移)` 会砍掉一部分好数据，或者留下一部分垃圾

**字节是文件的真实单位，字符是解码之后的产物。** 既然要把偏移交回给文件系统（`truncate`），全程就必须用字节。解码只发生在一个地方——已经确认是完整一行的那一小段。

dsh 的扫描器也是这么做的：`dsh/packages/session/session-persistence-jsonl/src/format.ts` 里的 `scanLog(buffer: Buffer)`，第一行就是 `buffer.indexOf(0x0A)`。

## `ignorable`：默认值要选在出错时代价小的那一边

这是这一课最值得带走的一条设计判断。

场景：你的程序读到一个日志，里面有一条 `metrics/sample`——它不认识这个类型。两种可能的默认：

**默认跳过。** 程序继续跑，读出一段**少了几条事件**的历史。如果那条事件其实很重要（比如一条"这十条消息被摘要取代了"），重建出来的会话是**错的**，而且没人会知道。模型会基于一段被悄悄改过的历史继续干活。

**默认拒绝。** 用户看到一句明确的话："这个日志里有我不认识的事件，多半是更新的版本写的，用那个版本打开。"他换个版本，问题解决。

第一种是**事故**，第二种是**不方便**。所以默认必须是拒绝。

`ignorable: true` 是写的人的一个**声明**：这条记录纯粹是信息性的，丢了不影响重建。dsh 把这条写在字段注释里：

> A writer sets `true` only on purely informational records whose loss cannot affect reconstruction; **defaulting to required means a forgotten marker over-refuses (an inconvenience) rather than silently resuming a gutted session.**
>
> （写的人只在纯信息性、丢失不影响重建的记录上标 `true`；**默认必需意味着忘了标最多是过度拒绝（不方便），而不是悄悄恢复出一个被掏空的会话。**）

注意"忘了标"这个措辞——它承认人会犯错，然后**把默认值设在犯错代价小的那一边**。这是一条通用的 API 设计原则：**默认值不是"最常见的选择"，是"搞错时损失最小的选择"。**

## 格式版本什么时候必须加

两个机制管两件不同的事，很容易搞混：

| | 管什么 | 加一个新事件类型 |
|---|---|---|
| `ignorable` | **词汇表变大** | 这是它的职责 |
| `SESSION_FORMAT_VERSION` | **结构变了** | 不加版本 |

dsh 把判断标准写在 `SESSION_FORMAT_VERSION` 的注释里，非常精确：

> bump exactly when an older runtime could no longer handle a new log with full semantic correctness ("parses without error" is not correctness — silently skipping content that shapes reconstruction is a wrong read).
>
> （**老运行时不再能以完整的语义正确性处理新日志时**，才加版本。"能解析不报错"不等于正确——悄悄跳过影响重建的内容，就是一次错误的读取。）

够得上这条标准的只有结构性改动：会话头的形状、`SessionEvent` 包装的形状、核心事件的语义、surface 机制。

还有一句收尾的实用建议：

> When in doubt, bump: a near-identity upgrade step is almost free, a missed bump makes older runtimes read new logs wrong silently.
>
> （**拿不准就加**：一个几乎什么都不做的升级步骤几乎免费，而漏加一次会让老版本悄悄把新日志读错。）

和 `ignorable` 同一个形状的判断：两种错里选代价小的那一种。

## 教 debug：错误信息里那个行号是给你用的

```
第 4 行有完整的换行但不是合法 JSON：Unterminated string in JSON at position 31
```

行号从 1 数，头是第 1 行——所以可以直接拿去查：

```sh
sed -n '4p' .dsh-learn/sessions/<id>.jsonl            # 看那一行到底长什么样
wc -c .dsh-learn/sessions/<id>.jsonl                  # 文件多少字节
tail -c 200 .dsh-learn/sessions/<id>.jsonl            # 末尾 200 字节，看有没有半行
```

**把"能直接拿去执行的坐标"放进错误信息里**，比"解析失败"有用得多。这条对所有面向文件的错误都成立：行号、字节偏移、字段路径，三者至少给一个。

三种排查路径：

**`--resume` 说版本不对。** 不是坏了。要么是你在用旧版本打开新日志（换版本），要么是 `SESSION_FORMAT_VERSION` 被谁改了（`git log -S SESSION_FORMAT_VERSION`）。

**`--resume` 说有不认识的事件类型。** 同上，不是坏了。检查 `KNOWN` 那个对象里是不是漏了一项——不过漏了的话 `tsc` 会先告诉你。

**`--resume` 说损坏，而你确信只是崩溃。** 看 `tail -c 200`：末行有换行符吗？有的话那就不是崩溃残骸——崩溃不会在写完换行之后还把前面的字节改坏。去想想有没有别的东西动过这个文件（编辑器？同步工具？两个进程同时写同一个会话？）。

## 对照 dsh

| | 我们的 | dsh 的 | 为什么 dsh 更复杂 |
|---|---|---|---|
| 扫描 | 一个 `while` 循环 | `SessionLogScanner` 类，支持分块喂入 | 要边读边解压（zstd），不能先全读进内存 |
| 中间损坏 | 一律拒绝 | **延迟判断**：坏点之后的全丢；但坏点后面还有 `turn/end` 才抛 | 一个被中断的 turn 尾部可以整段丢弃，真损坏才必须拒绝 |
| 补齐 | 投影时即时补（6.1） | `interruptedTurnClosers()` 往日志里补**真实事件** | 补出来的也要落盘、要能被别的进程看到 |
| 截断 | `truncate` + fsync | 同样，外加目录 fsync | POSIX 下目录项本身也要 fsync 才持久 |
| 已知类型表 | 手写对象 + `Record<SessionEventType, true>` 保证完整 | 脚本生成 + `doc-sync` 验证新鲜度 | 事件表靠 declaration merging 散在几十个包里 |
| 版本 | 不认识就拒绝 | 升级步骤链 + 内存视图转换 + migrate-on-continue | 真实用户有存量会话，不能让他们丢历史 |

那个"延迟判断"值得展开一句。dsh 的 `consumeEventLine()` 遇到坏行时不立刻抛：

```ts
this.issue ??= new Error(`corrupt session log: unparsable committed event at line ${this.eventLine}`)
return
```

然后在后面的行里检查：

```ts
if (this.issue !== undefined) {
  if (decoded.some(event => event.type === 'turn/end')) throw this.issue
  return
}
```

逻辑是：**坏点后面如果还有 `turn/end`，说明那段不是"崩溃时写了一半的尾巴"，而是一段本该完整的历史被破坏了**——那必须拒绝。如果后面没有 turn 结束标记，那整段就当崩溃尾巴丢掉。

这比我们的"一律拒绝"宽容，代价是需要 `turn/end` 这个边界事件——**我们的事件表里只有 `turn/start`，没有 `turn/end`**，所以做不了这个判断。这是一处真实的差距，会在阶段 12 补齐。

## 这一课改了什么

| 文件 | 改动 |
|---|---|
| `src/session.ts` | `SessionEvent` 包装加 `ignorable?: true`；投影加 `default` 分支 |
| `src/persistence.ts` | `loadSession()` 改成按字节扫描 + 残骸容忍；新增 `KNOWN_EVENT_TYPES`、`repairLog()`、两个错误类型 |
| `src/index.ts` | 续聊时先修再挂持久化 |
| `demos/06-session/07-torn-tail.mjs` | 新增：末尾半行可修，中间坏 / seq 空洞被拒 |
| `demos/06-session/08-unknown-and-version.mjs` | 新增：`ignorable` 的有无，版本不认识 |

## 下一课

**6.5 阶段验收**：把 6.1–6.4 串起来——一个数组变成了日志加投影，落到磁盘，保证了落盘时机，扛住了崩溃。然后对照 `dsh/packages/core/session/` 和 `dsh/packages/session/` 看清整个差距表，预告阶段 7 的痛点。
