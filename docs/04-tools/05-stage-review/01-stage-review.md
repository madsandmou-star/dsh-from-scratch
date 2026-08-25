# 4.5 阶段 4 验收

> 本课目标：把"工具"这件事从头串一遍，并回答一个攒了四节课的问题——dsh 为什么把 read/write/edit、str_replace_editor、bash、grep/glob 拆成**四个独立的包**。

## 验收清单

```sh
# ① 六个工具都在
npm run demo demos/04-tools/01-write-edit.mjs     # write 创建/覆盖，edit 三种失败一种成功
npm run demo demos/04-tools/03-bash.mjs           # 退出码、状态不保留、输出爆炸、超时、越界
npm run demo demos/04-tools/06-search.mjs         # glob 排序、grep 三种输出

# ② 模型能从失败里自己爬出来
npm run demo demos/04-tools/02-edit-self-correct.mjs
# 第 1 步 → 错误：old_string ... 出现了 2 次（第 2、6 行）...
# 第 2 步 → 已修改 demo.ts

# ③ 一个 turn 四个 step：跑测试 → 读 → 改 → 再跑
npm run demo demos/04-tools/04-red-green.mjs      # 最后一步 → PASS

# ④ 护栏
npm run demo demos/04-tools/09-pipeline.mjs
# 错误：被护栏「只读模式」拒绝：当前是只读模式，write 不能用。...
# 错误：工具 bash 超过了 1000ms 的时间上限，已被中止。
# 错误：护栏「坏掉的护栏」自己出错了：我自己炸了

# ⑤ 同一个 agent，一个开关的差别
npm run demo demos/04-tools/10-read-only.mjs

# ⑥ 两个明知故犯的洞，各自复现一次
npm run demo demos/04-tools/05-bash-bypasses-everything.mjs   # bash 绕过路径护栏
npm run demo demos/04-tools/07-shell-injection.mjs            # pattern 被 shell 执行
timeout 8 npm run demo demos/04-tools/08-redos.mjs            # 看门狗一次都没叫

# ⑦⑧
npm run typecheck && npm run check
```

| 验收项 | |
|---|---|
| `edit` 用唯一字面匹配，三种失败三条可改正的错 | ✓ |
| 工具描述里写清工具之间的优先级 | ✓ |
| bash：SIGKILL、`close` 而非 `exit`、保留输出末尾、非零退出不是异常 | ✓ |
| 搜索不经过 shell；知道 argv 数组和命令行字符串的区别 | ✓ |
| 三段管线：执行前失败即拒绝，执行后失败即忽略 | ✓ |
| 知道两层超时各自回答什么问题 | ✓ |
| 知道 ReDoS 补不掉，以及为什么 | ✓ |

## 本阶段产出

```
src/tool.ts       # 改：+write +edit +bash +glob +grep，Tool 加 摘要() 和 signal
src/pipeline.ts   # 新增：三段执行管线
src/guard.ts      # 新增：只读模式 / 输出兜底 / 记账
src/config.ts     # 改：Config → 生效配置；DSH_LEARN_CONFIG
src/index.ts      # 改：执行工具() 搬进管线，装配护栏数组
demos/            # 新增：harness.mjs + 阶段 4 的十个演示
```

`src/` 从阶段 3 结束的 700 行涨到 1274 行，其中 `tool.ts` 一个文件就 568 行。**这个数字本身就是下一课的伏笔**（见文末）。

## 把工具这件事串一遍

四节课下来，"加一个工具"要回答的问题固定是这七个：

| 问题 | 在哪一课定下的 | 判断标准 |
|---|---|---|
| 它叫什么、描述怎么写 | 3.1、3.3 | 描述是**提示词**：写清"什么时候用"，以及**和别的工具比该先用谁** |
| 参数怎么校验 | 3.3 | 模型给的 JSON 是不可信输入；空串对 `path` 非法、对 `content` 合法 |
| 输出给谁看 | 3.3、4.2 | `execute` 的返回值给**模型**；给人看的那一行是另一个方法（`摘要`） |
| 输出太大怎么办 | 3.3、4.2、4.3 | 截断永远要问"截什么、留哪头"：read 留头、bash 留尾、grep 逐行 |
| 失败怎么报 | 3.3、4.1 | 每种失败对应一个**不同的改正动作**，就得是一条不同的错 |
| 谁能打断它 | 4.4 | 能被打断的必须接 `signal`；打不断的（纯 CPU）要在设计上避开 |
| 危险性由谁兜 | 4.2、4.4 | 不在工具里，在管线的执行前那一段 |

**这七个问题里，只有前两个是"这个工具特有的"。** 后五个每个工具都要回答，而且答案高度雷同——这正是 4.4 把它们抽出来的理由，也是下面那个"为什么是四个包"的铺垫。

## 为什么 dsh 是四个独立的包

我们六个工具挤在一个 `tool.ts` 里。dsh 是这样分的：

| 包 | 工具 | 额外依赖 |
|---|---|---|
| `dsh/packages/fs/tool-fs/` | `read` `write` `edit` | `diff` |
| `dsh/packages/fs/tool-str-replace-editor/` | `str_replace_editor` | 无 |
| `dsh/packages/fs/tool-fs-search/` | `grep` `glob` | **`@vscode/ripgrep`（几十 MB 的二进制）** |
| `dsh/packages/shell/tool-bash/` | `bash` | 无 |

拆包不是为了"文件小一点"。三个具体的理由，每一个都能在文件里直接看到：

### ① 依赖不该被连坐

`tool-fs-search` 依赖 `@vscode/ripgrep`——一个几十 MB 的预编译二进制。如果所有工具在一个包里，**任何人只要想用 `read`，就得先下载那个二进制。**

包边界就是**依赖边界**。这是最硬的一条：它不是风格问题，是安装体积和安装时间的问题。

### ② 装配时要能按平台开关

`dsh/packages/bundle/base/cordis.patch.yml` 里：

```yaml
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'
```

**Windows 上装 pwsh 那套，别的平台装 bash 那套。** 如果工具全在一个包里，这个开关就没有粒度可言——你只能"全都要"或者"全不要"。

同一个文件里还有：

```yaml
- id: tool-str-replace-editor
  name: '@deepseek-ai/dsh-tool-str-replace-editor'
  config:
    maxOutputChars: 16000
```

两套写文件的工具**同时存在**，装配时选哪套（或者都装）是部署的决定。这也只有分包才做得到。

### ③ 每个包声明自己要什么

`peerDependencies` 里能直接读出一个工具**依赖哪些能力接缝**：

| 包 | 它要的接缝 |
|---|---|
| `tool-str-replace-editor` | `fs` `sandbox` `sandbox-policy` `tools` |
| `tool-fs` | 上面那些 + `attachment` `llm` `session` `system-prompt` `user-approval` |
| `tool-fs-search` | `subprocess` `spill` `output-retention` `timeout` `session` `system-prompt` |
| `tool-bash` | `shell` `shell-env` `jobs` `agent` `sandbox` `user-approval` … |

**这张表就是文档。** 看一眼就知道：`tool-fs-search` 要跑子进程（`subprocess`）、结果可能大到要转存（`spill`）；`tool-bash` 要管后台任务（`jobs`）。而 `tool-str-replace-editor` 最朴素——它只碰文件系统。

我们那个 568 行的 `tool.ts` 里，这些关系全是隐式的：`grepTool` 用了 `readdir`，`bashTool` 用了 `spawn`，但你得读代码才知道。**分包把"谁需要什么"从代码里提到了清单里。**

> **那我们该拆吗？** 现在不该。拆包是为了解决依赖连坐、装配粒度、依赖声明这三件事——我们一件都还没有：没有第三方依赖、只有一种装配、没有能力接缝。**照着终点的形状去组织一个还没有那些问题的代码库，是过度设计。** 阶段 7 引入 Cordis 插件之后，装配粒度这件事会第一次真的成为问题，那时候再拆才有意义。

## 工程思维总结

### 1. 错误信息的读者决定它怎么写

这一阶段最反复出现的一条。`edit` 匹配多次时报出**具体行号**、只读模式拒绝时告诉模型**还剩什么能用**、超时后由管线补一句**是谁掐的**——都是同一件事：

**先问"谁会读这条错误"，再问"读完他要做什么"。**

给人看的错误要能定位代码；给模型看的错误要能触发一个**具体的改正动作**。写"操作失败"对两者都没用。

### 2. 同一个问题，在管线两端答案相反

执行前钩子抛异常 = 拒绝；执行后钩子抛异常 = 忽略。判据不是"该不该容错"，而是：

**这一步失败，是让世界少发生一件事，还是让已经发生的事被误报？**

这个判据在别处一样管用：写文件前的校验失败要中止，写完之后的日志失败不能中止。

### 3. 通用机制是兜底，不是替代品

统一截断没有取代 read/bash/grep 各自的截断，因为那三处**懂内容**，统一那处不懂。同理，统一超时没有取代 bash 自己的超时。

**当你抽出一层通用机制时，先问它是不是比具体实现更懂。不更懂，就只能当底线，不能当替代。**

### 4. 明知故犯要留记号

阶段 4 留下两个洞：bash 没有权限（`XXX(权限)`）、grep 会 ReDoS（`XXX(ReDoS)`）。两条记号都写清了**为什么现在不补**和**该补在哪里**。

**"知道有个洞但现在不补"和"没意识到有洞"是完全不同的两件事**，区别就在有没有这条记号，以及记号里有没有写出正确的补法。dsh 的 `tool-bash` 顶上那条 `TODO(permissions)` 就是范本——它连"该补在 `tools/pre-execute`"都写了。

### 5. 知道机制在哪里失效

ReDoS 那一节的价值不在"我们写了个有洞的 grep"，在于**实测出了统一超时的物理边界**：`setTimeout` 管不住同步代码。

**一个你不知道边界的机制，你就不知道什么时候该信它。**

## 阶段 4 学了什么

| 课 | 你现在应该能回答 |
|---|---|
| **4.1** | 为什么用唯一字面匹配而不是行号/diff/正则；三种失败为什么要三条错；write 为什么要区分创建和覆盖 |
| **4.2** | 超时为什么用 SIGKILL；截断为什么保留末尾；非零退出为什么不是异常；每次新 shell 为什么必须写进 description |
| **4.3** | argv 数组和命令行字符串的区别；为什么搜索必须有自己的工具；ReDoS 为什么只能靠换引擎解决 |
| **4.4** | 三段管线为什么是三段；fail-closed 和 fail-open 各自用在哪端；两层超时回答的是两个问题 |
| **4.5** | 拆包解决的是依赖连坐、装配粒度、依赖声明——不是"文件太大" |

## 下一阶段的痛点预告

现在的 system prompt 是配置文件里写死的一句话：

```json
"systemPrompt": "You are a helpful assistant."
```

而这一阶段我们往工具描述里塞了一堆**本该属于 system prompt 的话**：

- "读文件请优先用 read（它带行号），改文件请优先用 edit"（4.2）
- "请用这个工具而不是 bash 里的 grep"（4.3）
- "当前是只读模式，你可以用 read / glob / grep 查看"（4.4 的拒绝理由）

这三句都不是在描述**某一个工具是什么**，而是在描述**这套装配下该怎么干活**。塞在工具描述里有两个问题：一个工具的描述里提到另一个工具，等于把它们绑死了（删掉 grep 工具，bash 的描述就在说谎）；而只读模式那句话更离谱——**它只有在被拒绝之后才说得出口**，模型在决定调用之前根本不知道自己在只读模式。

dsh 的做法你已经在对照里瞥见好几次了：

```ts
ctx.systemPrompt.section({
  name: 'tool:edit',
  order: 102,
  text: 'Use the edit tool for targeted changes to existing UTF-8 text files. …',
})
```

**每个插件往 system prompt 里塞一段自己的话，最后按 `order` 拼起来。** 装了哪些插件，system prompt 就长什么样——它不再是一个常量，而是一个**装配出来的东西**。

阶段 5 就做这件事，并且会撞上一个新问题：**拼出来的东西也是模型可见的，那它要不要落日志？**

---

下一阶段：阶段 5 system prompt 组装（进入前先在 [COURSE.md](../../../COURSE.md) 细化小课）
