# DSH 极简模式 → Pi 复刻方案

> **Package users / 包用户**：已发布包将原实验代号 **C2** 命名为
> **渐进模式 / Progressive mode**。请优先阅读仓库根目录的
> [English README](../README.md) 或 [中文 README](../README.zh-CN.md)，并使用
> `/dsh-mode progressive|off`；`c2` 仅保留为旧版兼容别名。

调研对象：`@deepseek-ai/dsh@0.1.0-rc.6`（deepseek-ai/deepseek-harness）与 Pi（`@earendil-works/pi-coding-agent`）。
结论先行：DSH 极简模式的"初始环境"= **一句 system prompt + 两个工具 + cwd，其余全无**。Pi 侧用 4 个 API 即可 1:1 复刻，实现见 [`dsh-minimal.ts`](./dsh-minimal.ts)。

---

## 一、DSH 极简模式（minimal preset）配置确认

源码位于 dsh 包 `config/agent-presets/minimal/`（web profile 挂载它后，base 层的 agent 面工具全部 disabled，只保留 host 面的会话/存储等基础设施）。

### preset.yml

```yaml
name: 极简模式
description: 仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent。
order: 3
```

### agent.cordis.yml 拆解

```yaml
# 1) persona —— 唯一的、完整的 system prompt
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true              # 全局身份、Web 引导、工具指引等 prompt 段一律禁止追加
    includeRuntimeContext: false # 不注入 cwd/日期/OS 等运行时快照

# 2) persistent-shell 组 —— 持久 bash（PTY, 300s 超时, 官方描述）
- id: persistent-shell
  group: true
  isolate: { terminals: true }
  config:
    - id: pty           → '@deepseek-ai/dsh-terminal'
    - id: terminal-bash → '@deepseek-ai/dsh-terminal-bash'   (timeoutMs: 300000)
    - id: persistent-bash → '@deepseek-ai/dsh-tool-bash-persistent' (timeoutMs: 300000)
      # description: "Run commands in a bash shell ..."（完整文本已逐字移植进扩展）

# 3) filesystem 组 —— str_replace_editor（16000 字符输出上限）
- id: filesystem
  group: true
  isolate: { fs: true }
  config:
    - id: fs-local → '@deepseek-ai/dsh-fs-local'  (cwd: !!js process.env.DSH_CWD ?? process.cwd())
    - id: str-replace-editor → '@deepseek-ai/dsh-tool-str-replace-editor'  (maxOutputChars: 16000)
```

### 极简模式第一轮对话时，模型实际得到的初始环境

| 维度 | 极简模式的内容 |
|---|---|
| system prompt | 仅一句 `You are a helpful software engineer assistant.`（complete 语义：工具指引、身份段、Web 引导全部被拦截） |
| 运行时上下文 | 无（`includeRuntimeContext: false`） |
| 工具 | 仅 2 个：`bash`（持久 PTY + 官方描述）、`str_replace_editor`（view/create/str_replace/insert/undo_edit） |
| 上下文文件 | 无（无 AGENTS/skills 注入） |
| 计划/待办 | 无（plan-mode、tool-todo 均 disabled） |
| web/subagent | 无 |
| 压缩 | 无（"Context compaction is absent"） |
| cwd | `DSH_CWD ?? process.cwd()` |
| 首轮消息 | **不注入任何初始消息** —— 用户输入即第一轮；"初始环境"只由上面几项构成 |

---

## 二、两个工具选择的权衡（Q1/Q2）

### Q1：bash 还是 pwsh？

DSH 极简模式本身是 **bash-only**（persistent-bash 走 PTY；DSH 虽有 `dsh-tool-pwsh`，但 minimal preset 不包含它）。在 Pi 侧：

| | bash（默认，忠实） | pwsh（可选） |
|---|---|---|
| 与 DSH minimal 一致性 | 完全一致 | 偏离原版（但"一个 shell 工具"的形态不变） |
| Pi 侧实现 | 覆盖内置 bash（DSH 官方描述 + cd 跟踪） | 复用 Pi 的 bash 执行器、仅换 shell 为 powershell.exe（截断/进程树清理/流式输出全继承） |
| 依赖 | Pi 的 bash 工具在 Windows 本来就要求 git-bash/Cygwin/MSYS2/bash on PATH | 系统自带 Windows PowerShell，无需装 git-bash |
| 描述适配 | DSH 原文逐字（sed/apt/pip 是 bash 语义） | 同构改写（Get-Content/Start-Job） |
| 目录持久 | `cd` 跟踪 | `Set-Location`/`cd`/`sl` 跟踪 |

**结论：都可以接受，默认 bash（忠实）。** 设 `DSH_MINIMAL_SHELL=pwsh` 切换。

### Q2：`read` 比 `str_replace_editor` 更合适吗？

取决于目标是"忠实复刻"还是"Pi 原生极简"：

| 方案 | 工具集 | 适用场景 |
|---|---|---|
| **dsh 预设**（默认）：`str_replace_editor`，**不带 read** | shell + str_replace_editor | 目标是与 DSH 极简**行为对齐**（评测/复现）：双工具约束本身就是极简模式的特性——没有独立读文件工具，模型必须用 `view`（cat -n 带行号）、`view_range` 窗口、自己规划查看粒度 |
| **pi 预设**：`edit` + `read` | shell + edit + read | 目标是"Pi 上最好用的极简"：read 全面优于 view（支持图片截图、offset/limit、Pi 的 50KB 截断与临时文件溢出）；edit 优于 str_replace（一次调用多组替换、TUI diff 渲染、内置文件变更队列） |

`read` 单看能力确实更强，但 DSH 极简是**故意**不要 read 的——"两个工具"是约束不是缺陷。所以：

- 想要 DSH 原版体验/对齐实验 → `str_replace_editor`（无 read）
- 想要 Pi 原生体验 → `edit` + `read`

设 `DSH_MINIMAL_PRESET=pi` 切换；两种预设下"一句话 persona + 无压缩 + 无其它工具"的极简骨架完全一致。

---

## 三、Pi 侧对应机制（已对安装版本逐一核实 API 签名）

| DSH 极简模式 | Pi 实现 | 作用位置 |
|---|---|---|
| persona `complete:true` + `includeRuntimeContext:false` | `pi.on("before_agent_start")` 返回 `{ systemPrompt: PERSONA }` | **整体替换**每轮 system prompt：Pi 默认的 identity、Guidelines、tool snippets、AGENTS.md、skills、cwd/日期环境信息一次性全清空 |
| 双工具白名单 | `pi.setActiveTools(ACTIVE_TOOLS)` | 关闭 read/edit/write/grep/find/ls/todo 及一切扩展工具 |
| persistent-bash（含官方描述, 300s） | `pi.registerTool({ name: "bash", ... })` 覆盖内置 bash：DSH 原文描述 + cd 跟踪 + 默认超时 300s | 覆盖后 TUI 会提示内置 bash 被替换（属预期） |
| pwsh（可选） | `createBashTool(cwd, { shellPath: <powershell 绝对路径>, spawnHook })` 再以 `pwsh` 名注册 | `shellPath` 必须是存在的绝对路径（Pi 用 existsSync 校验） |
| str_replace_editor | `pi.registerTool({ name: "str_replace_editor", ... })` 忠实移植（5 个命令 + 16000 字符裁剪 + `<response clipped>` 提示） | 文件写入走 `withFileMutationQueue`，与 Pi 并行工具调用兼容 |
| 无压缩 | `session_before_compact` 对 `manual`/`threshold` 返回 `{ cancel: true }`（保留 `overflow` 防炸会话）；settings.json 里 `"compaction": {"enabled": false}` 双保险 | — |
| cwd | pi 启动目录（`ctx.cwd`） | — |
| 首轮不注入 | 默认不注入（忠实原版）；可选见下节 | — |

## 四、"首轮对话喂养"的三条路径

DSH 极简模式本身**不喂首轮消息**（环境 = 系统提示 + 工具）。若要在 Pi 里把初始环境或任务"喂"进第一轮，有三种注入点：

1. **忠实路径（推荐默认）**——不注入。用户第一句话即第一轮，模型看到的就是极简环境本身。
2. **持久消息注入**（`before_agent_start` 返回 `message`）：

   ```typescript
   pi.on("before_agent_start", (event) => ({
     systemPrompt: PERSONA,
     message: { customType: "dsh-minimal", content: "<上下文或任务>", display: true },
   }));
   ```

   消息存入会话、进入 LLM 上下文；每次用户发消息都可见（持久注入）。
3. **自动 kickoff**（`session_start` → `pi.sendUserMessage(...)`）：
   会话一启动就发送一条真实用户消息并触发第一轮。本扩展用环境变量开关：

   ```bash
   DSH_MINIMAL_KICKOFF="请检查当前目录并修复 lint 错误" pi -e ./dsh-minimal.ts
   ```

SDK 场景另有 `InteractiveMode({ initialMessage })` / `runPrintMode({ initialMessage })` / `session.prompt(text)`，同一套环境（systemPrompt 覆盖 + tools 白名单）在 SDK 里对应 `DefaultResourceLoader({ systemPromptOverride })` + `createAgentSession({ tools: [...] })`。

---

## 五、使用方式

```bash
# 单次测试
pi -e ./dsh-minimal.ts

# 全局启用（所有项目自动加载，/reload 可热更新）
cp dsh-minimal.ts ~/.pi/agent/extensions/dsh-minimal.ts

# 预设与 shell（修改后 /reload 生效）
DSH_MINIMAL_PRESET=dsh    # 默认: shell + str_replace_editor (忠实复刻)
DSH_MINIMAL_PRESET=pi     # shell + edit + read (Pi 原生极简)
DSH_MINIMAL_SHELL=bash    # 默认: 匹配 DSH 原版
DSH_MINIMAL_SHELL=pwsh    # PowerShell (无需 git-bash)
DSH_MINIMAL_KICKOFF="..." # 可选: 会话启动即喂入的第一条消息

# 可选：关闭压缩（DSH minimal 无压缩）
# ~/.pi/agent/settings.json 中加入 {"compaction": {"enabled": false}}
```

验证环境是否生效：进入会话后 TUI 会提示 bash 被覆盖（dsh 预设）；发送任意消息，模型只会调用白名单内的工具，且系统提示只有 persona 一句。

---

## 六、差异与注意

| 差异点 | 说明 |
|---|---|
| bash 非持久 PTY | Pi 内置 bash 每次调用新 shell；扩展用 **cd 跟踪**近似持久状态（跨调用保持目录）。如需真持久 PTY，参考 pi 的 `interactive-shell.ts` 示例自行移植 DSH 的 pty 方案 |
| 描述里的环境承诺 | DSH 原文第 3/4 行（apt/pip 镜像、状态持久）是 DSH 环境承诺，本机不满足时建议改写 `BASH_DESCRIPTION` |
| undo 历史 | 仅会话内存（DSH 声称跨讨论持久）；`session_start` 时重置 |
| 双工具约束更硬 | dsh 预设下模型看文件只能靠 `str_replace_editor` 的 `view` —— 与 DSH 极简完全一致；pi 预设下 read/edit 均可用 |
| 超时 | dsh 预设的 bash/pwsh 默认超时 300s（对齐 DSH timeoutMs: 300000）；pi 预设用 Pi 内置无超时语义 |
| 恢复全部工具 | 删除/停用扩展，或临时 `pi.setActiveTools([...])`（可在 `/minimal` 类命令里切换） |
| Windows | bash 命令走 Pi 的 shell 解析（git-bash 等）；cd 跟踪用 `isAbsolute` 兼容盘符路径；pwsh 用 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` |

---

## 八、dsh-c2：旧版 C2 实验预设（发布包中称为“渐进模式 / Progressive mode”）

基于 `../exp/REPORT.md` 的 C2 组结论（$0.047、309 行产出、接近基线成本），`dsh-c2.ts` 把 C2 模式做成即插即用插件：

**工作流**：
1. 会话启动 = anchored bootstrap：minimal persona + 仅 bash + str_replace_editor
2. 用户第一条消息被拦截，先注入一条**锚定轮**自介消息（可配 `DSH_C2_ANCHOR_TEXT`），在 minimal 目录下跑完；模型回复即**静默晋升**（不发通告）
3. 真实消息作为下一轮 followUp 送达——新轮边界 + 已扩展目录（+dev_tool_search/skill_search/skill_load），模型自发发现并解锁所需工具（C2 实验：dev_tool_search×5、web_search×14，无任何通告）

**机制依据**：工具切换由**轮边界**触发（同轮晋升无效，跨轮自发生效）；通告只是加速剂（D2 44 次搜索 vs C2 14 次，但 C2 成本更低）。

**配置**：
- `DSH_C2_ANCHOR_TEXT`：锚定轮文案（默认自介）
- 未显式设置 `DSH_ANCHOR_PROMOTE_HINT` 时强制静默；设 `=1` 切回 D2 式通告
- 与 `DSH_ANCHOR_TURN=zero|whoami` 互斥（非 none 时 c2 让步）
- 仅拦截 `source=interactive` 的新会话首条输入；`/` 开头、RPC/print、resume 均不拦

**用法**：

```bash
# 交互式：自动生效
pi -e ./dsh-c2.ts

# 自动化（SDK）：runner 自己编排锚定轮（见 ../exp/run-multi.mjs 的 C2 跑法），插件负责静默晋升
node run-multi.mjs C2 round2b.txt   # initialMessage=锚定文案, messages=[任务]
```

注意：`dsh-c2.ts` 依赖同目录的 `dsh-anchored.ts`（相对导入），复制到 `~/.pi/agent/extensions/` 时两个文件一起复制。

---

## 七、anchored-standard 移植（触发 DS 的 RL 性能释放）

基于 [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard) 的实测结论，新增 **`dsh-anchored.ts`**（见该文件头部的完整映射表）。该仓库的核心发现：

### 仓库关键证据（DeepSeek V4 Pro，Windows + 官方端点）

1. **工具 schema 身份是首轮锚定的决定变量**：在 adapter 默认 maxTokens（256000）下，Minimal 工具对（persistent bash + str_replace_editor）**5/5 锚定** RL 最优轨迹（首行 `We need…`、`let me` 0.0）；而 pwsh/read、仅 pwsh、沙箱 bash/read 等 standard 系 schema **11/11 落入 standard-like**。Project2 评分：Standard 91/92 vs Minimal 99/96。
2. **注入上下文破坏锚定**：技能目录提醒（~9KB）在场时 **0/9 锚定**，无注入时 **~81%**；AGENTS.md 摘要同理。
3. **晋升后一次性 dump 全目录会把轨迹拉回 standard-like**（zero 变体的晋升后回退根因）→ 晋升后只给最小驻留集 + `dev_tool_search` 按需解锁。
4. **压缩重写整个可见面**，压缩后是"第二次首请求" → 纪元感知地重新 bootstrap。

### Pi 移植（`dsh-anchored.ts`）

| 机制 | Pi 实现 |
|---|---|
| 首请求锚定 | `before_agent_start` 整体替换 system prompt 为 minimal persona（连 AGENTS/skills 注入一起剥掉）+ 首请求只激活 `[shell, str_replace_editor]` |
| 晋升信号 | `tool_execution_start` / `turn_end`（`DSH_ANCHOR_PROMOTE_ON=either\|tool-call\|assistant-message`）|
| 持久化 | `session_start` 扫描 `sessionManager.getBranch()` 条目（assistant/toolResult/compaction/custom）推导 phase，resume/reload 安全 |
| 晋升后驻留集 | bootstrap 对 + `dev_tool_search` + `skill_search` + `skill_load` + 已解锁工具，**不 dump 全目录** |
| 按需解锁 | `dev_tool_search`（query 搜 `pi.getAllTools()`；`toolNames` 精确解锁，解锁名存入 toolResult 的 `details.unlocked` 持久化） |
| 技能目录替代 | `skill_search`/`skill_load`（快照 `before_agent_start` 的 `systemPromptOptions.skills`；load 读文件后以 custom message 注入下一请求） |
| instruction-hint | 晋升后一次性注入"指令文件存在，自行读取"（不嵌入内容），仅一次/会话 |
| 压缩纪元 | `session_compact` → 回退 `[shell, str_replace_editor, ...compactionTools]`（默认 read,write,edit,find,grep,ls），新晋升信号后恢复驻留集，已解锁保留 |
| zero/whoami 锚定轮 | `DSH_ANCHOR_TURN=zero\|whoami`：`input` 事件拦截首条真实消息，先插零工具锚定请求（"This round is a test…" / "你是谁"），真实消息 followUp 排队 |
| 降级保护 | 缺 bootstrap 工具/过滤失败 → 警告一次并保持当前目录，绝不 brick 会话 |

### 用法

```bash
pi -e ./dsh-anchored.ts                                   # 默认: either 晋升, 无锚定轮
DSH_ANCHOR_PROMOTE_ON=tool-call pi -e ./dsh-anchored.ts  # 仅工具调用晋升
DSH_ANCHOR_TURN=zero pi -e ./dsh-anchored.ts             # 首请求零工具锚定轮
DSH_ANCHOR_SHELL=pwsh pi -e ./dsh-anchored.ts            # PowerShell (schema 名改为 pwsh)
# 或复制到 ~/.pi/agent/extensions/dsh-anchored.ts
```

### 注意事项（与 DSH 版的差异）

| 差异 | 说明 |
|---|---|
| `bootstrapMaxTokens` 不移植 | Pi 无等价钩子；仓库结论是 256000 下工具 schema 才是决定变量，封顶本身是 opt-in |
| Pi 无持久 PTY | 与 minimal 移植相同，bash 用 cd 跟踪近似（schema 名称/描述仍与官方一致——仓库 custom-bash 已证明锚定取决于 schema 而非执行器） |
| 子代理 | DSH 版 delegationDepth>0 恒晋升；Pi 的 subagent 是独立会话，本移植不处理 |
| 晋升时机 | `tool_execution_start` 晋升后，**同一轮的后续 LLM 请求**即看到驻留集（对应 DSH 的 request #2 语义） |
