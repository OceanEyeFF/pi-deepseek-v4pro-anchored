# 实验报告：DSH 极简/锚定模式在 Pi 上的复现与机制验证

- **任务**：介绍 OpenAI 各个产品线上的模型的发展历史（`exp/prompt.txt`）
- **模型/参数**：`deepseek/deepseek-v4-pro`，thinking=max
- **日期**：2026-08-15
- **理论来源**：[`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)（工具 schema 首轮锚定假说）与 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) minimal preset
- **复现产物**：`dsh-plugin/dsh-minimal.ts`、`dsh-plugin/dsh-anchored.ts`（Pi 扩展）、`exp/`（实验数据）

---

## 摘要

在 Pi 上用六种工具环境跑同一检索型任务，验证 DSH minimal 模式的 RL 轨迹锚定效应：

1. **风格锚定成功复现**：Minimal 工具对（bash + str_replace_editor）使 DS 思维链从 standard-like 的 "let me" 个体口吻（61 次）切换为 "We need/we" 协作口吻（157/90 次）——与仓库 issue #11 的签名一致。
2. **锚定跟随的是工作轮的当前工具目录，不是会话历史**：目录转丰富后风格立即回落（C2/D2 第 3 轮 we 仅 2/21）。
3. **工具切换由轮边界触发，通告只是加速剂**：同轮内晋升（C）模型绝不回看目录（0 次 dev_tool_search）；任务在新轮到达时（C2/D2），无通告也会自发发现并解锁新工具（5/4 次 dev_tool_search、14/44 次 web_search）。
4. **成本结构被工具选择主导**：curl 自建管线（B）烧 6.81M token（16.7× A、22.7× C2），瓶颈是工具结果上下文滚入（cacheRead 6.61M），而非思维链。
5. **综合性价比最高的是 C2**（锚定开场 + 跨轮静默晋升）：$0.047、309 行最长产出、接近 A 的成本；但风格锚定纯度最高的是 B，代价是 17× token。

---

## 1. 背景与目标

DSH 极简模式（minimal preset）的初始环境 = 一句话 persona（`You are a helpful software engineer assistant.`，complete:true）+ 双工具（持久 bash + str_replace_editor）+ 无任何注入上下文。`dsh-anchored-standard` 仓库报告：DeepSeek V4 Pro 强烈条件化于 API 可见的工具目录——Minimal 工具对在首请求 5/5 锚定 RL 最优轨迹（Project2：Minimal 99/96 vs Standard 91/92），且注入上下文（技能目录/AGENTS 摘要）会破坏锚定（0/9 vs 81%）。

**目标**：在 Pi 上复现这一效应，并回答三个递进问题：
1. 首轮 Minimal schema 能否在 Pi 上复现 "We need" 轨迹锚定？（A/B 对比）
2. 锚定后转复杂环境，模型是否会用新工具？（C 组）
3. 用什么方式（轮边界？显式通告？）能让模型在转复杂后真正切换工具路线？（D/D2/C2）

任务选择理由（用户给定）：① 可检查输出风格；② 可检查搜索工具调用是否正确；③ 多阶段工作对本题必要。

## 2. 实验设计

### 2.1 六组环境

| 组 | 环境 | 轮结构 |
|---|---|---|
| A | 默认 Pi（内置 + web_access/todo/subagent 等扩展，全工具目录） | 单轮（任务即首请求） |
| B | `dsh-minimal.ts`（全程 bash + str_replace_editor） | 单轮 |
| C | `dsh-anchored.ts`（首请求 Minimal 工具对，晋升后驻留集：+dev_tool_search/skill_search/skill_load） | 单轮（同轮内晋升） |
| D | `dsh-anchored.ts` + 通告与任务拼在同一条消息 | 单轮（假三轮，见 2.4） |
| D2 | `dsh-anchored.ts` + 第 2 轮独立通告（工具扩展） | 真三轮 |
| C2 | `dsh-anchored.ts`（`DSH_ANCHOR_PROMOTE_HINT=0`）+ 第 2 轮中性消息 | 真三轮 |

### 2.2 控制变量

同一任务、同一模型/thinking、干净 cwd（无 AGENTS.md）、独立会话目录、每组单次运行。prompt 不点名任何工具（"如有需要，检索最新资料核实"），让工具选择自然涌现。

### 2.3 数据收集

`pi -p`（print 模式）跑 A–D，SDK `runPrintMode({ messages })` 跑 D2/C2。每组保留：会话 JSONL（含完整 thinking 与 usage）、stdout/stderr、耗时。分析脚本：`analyze.mjs`（结构）、`analyze2.mjs`（思维链风格+工具序列）、`analyze3.mjs`（事实覆盖）。

### 2.4 方法学坑（D 组的教训）

CLI `pi -p "@a.txt" "@b.txt" "@c.txt"` 会把多条消息**拼成一条 user 消息**——D 组因此退化为"通告与任务同轮到达"，成为有效对照组（并排通告 vs 独立通告轮的对照）。真三轮必须走 SDK `runPrintMode({ messages })`。

## 3. 结果

### 3.1 总览

| | A 默认 | B minimal | C anchored | D 并排通告 | D2 独立通告 | C2 独立中性 |
|---|---|---|---|---|---|---|
| 耗时 | **410s** | 1155s | 736s | 568s | 796s | 619s |
| LLM 请求数 | 10 | 96 | 54 | 44 | 45 | **14** |
| 工具调用 | 24 | 95 | 54 | 45 | 86 | 20 |
| 调用构成 | todo11, web_search8, fetch2, bash2, write1 | bash91, sre4 | bash54 | bash45 | web_search44, bash32, dev_tool_search4, fetch5, skill_search1 | web_search14, dev_tool_search5, bash1 |
| 可见回复 | 7 条进度播报 | 1 条长文 | 1 条长文 | 1 条长文 | 3 条（介绍+确认+长文） | 11 条（介绍+待命+8 进度+长文） |
| 交付形态 | 文件+摘要 | 聊天直出 | 聊天直出 | 聊天直出 | 聊天直出 | 聊天直出 |

### 3.2 输出风格（思维链签名）

| thinking 内标记 | A | B | C | D | D2 | C2 | 仓库判据 |
|---|---|---|---|---|---|---|---|
| `we` | 0 | **157** | **90** | **85** | 21 | 2 | 高 = minimal 锚定 |
| `we need` | 0 | **13** | **7** | 7 | 2 | 0 | 同上 |
| `let me` | **61** | 1 | 0 | 0 | 17 | **59** | 高 = standard-like |

- A 首段思维："The user wants me to write a comprehensive survey…"（任务执行者口吻）
- B/C/D 首段思维："**We need** answer user asks in Chinese… **We need** produce article…"（协作体口吻）
- **按轮次拆解（机制证据）**：C2/D2 第 1/2 轮都是短思维（无风格标记），第 3 轮（工作轮、目录已丰富）C2 we=2/letMe=59、D2 we=21/letMe=17；而工作轮全程保持 minimal 目录的 B/C 是 we=157/90。**风格跟随工作轮的当前目录，不是会话历史**。

### 3.3 搜索工具调用正确性

- **A**：标准用法——web_search×8（批量 queries）+ fetch_content×2；Wikipedia 被网络策略屏蔽后改走官方 Help Center/媒体渠道。
- **B**：无搜索工具。先信了描述里的 "no internet"，用 curl 探测后发现**网络实际可用**，自建管线：curl 官方 models/deprecations/changelog 文档 + Wikipedia（`-A Mozilla` 绕过屏蔽）+ python/BeautifulSoup 解析。91 次 bash 中大量是环境调试往返。
- **C**：晋升后 `dev_tool_search` 就在目录里（描述明示可解锁 web_search），但**零调用、思维链零提及**——继续 bash 自建管线（curl + r.jina.ai + DuckDuckGo HTML + Bing）。
- **D**（通告与任务同轮）：同样零 dev_tool_search，45 次 bash 全 curl。
- **D2/C2**（任务在新轮到达）：均自发采用标准两步用法（query 搜索 → toolNames 解锁），D2 解锁 web_search/fetch_content/get_search_content 后检索 44 次；C2 无通告也解锁 web_search/get_search_content 并检索 14 次，首句即"我先启用网络检索工具"。

### 3.4 多阶段工作形态

- **A**：显式分阶段——todo 管理 4 个任务，5 轮检索 + 撰写 + 校对，每阶段一条可见进度播报。
- **B/C/D**：单回合内隐式分阶段——95/53/44 个 thinking 块内完成"检索→交叉核对→拟稿→成文"，最终一次吐全文。
- **C2**：8 条进度播报 + 最终长文（介于两者之间）。
- 所有组都完成多阶段工作；**阶段管理的载体不同**：A 用工具+对话分层，B/C/D 用超长思维链。

### 3.5 Token 消耗（session usage 聚合）

| 组 | 请求数 | 输入 | 输出 | cacheRead | reasoning | totalTokens | 成本 |
|---|---|---|---|---|---|---|---|
| A | 10 | 32.1K | 31.9K | 343.4K | 21.9K | 407.4K | $0.043 |
| B | 96 | 154.2K | 44.5K | **6.61M** | 23.2K | **6.81M** | $0.130 |
| C | 54 | 140.8K | 34.8K | 4.71M | 18.6K | 4.89M | $0.109 |
| D | 44 | 94.8K | 22.6K | 2.43M | 11.9K | 2.54M | $0.070 |
| D2 | 45 | 107.6K | 39.1K | 2.87M | 23.6K | 3.02M | $0.091 |
| C2 | 14 | 29.9K | 38.3K | 232.1K | 27.0K | **300.3K** | **$0.047** |

- B 烧 6.81M（A 的 16.7×、C2 的 22.7×），瓶颈是 cacheRead 6.61M——curl 管线把 HTML/文档全量滚进上下文，历史越长每请求重读越贵。
- reasoning 各组接近（11.9K–27K）：**思维链体量不是成本差异来源，工具结果上下文才是**。
- 性价比（cost/产出行）：C2 $0.00015 < A $0.00019 < D $0.00034 < D2 $0.00041 < C $0.00047 < B $0.00050。

### 3.6 具体结果（25 项关键事实覆盖 + 结构 + 日期一致性）

| 组 | 事实覆盖 | 标题数 | 参考文献节 | 行数/字节 | 备注 |
|---|---|---|---|---|---|
| A | 25/25 | 26 | 有 | 228 / 19.7KB | 明确修正"GPT-5 Pro 2025-10-06 上 API"的误传 |
| B | 24/25 | 22 | 有 | 259 / 19.5KB | 缺 gpt-image-2 节点 |
| C | 23/25 | 22 | 有 | 232 / 21.1KB | 缺 gpt-image-1/2 |
| D | 24/25 | 19 | 有 | 202 / 14.5KB | 最薄；缺 gpt-image-2 |
| D2 | 25/25 | 21 | 有 | 222 / 18.5KB | 检索面最广（44 次搜索） |
| C2 | 24/25 | 23 | 有 | **309 / 26.7KB** | 最详尽；缺 GPT-4.5 专节 |

**日期一致性**：GPT-5 Pro = 2025-10-06 六组一致 ✓。跨组冲突：GPT-5.1 上 ChatGPT 的日期 D=11-13、D2/C2=11-12；GPT-5.1-Codex-Max 的 API 日期 D=2025-12-04、D2/C2=2025-11-19（n=1 无法定真伪）。curl 管线与搜索工具路线在准确度上互有出入，**没有路线全面碾压**。

## 4. 机制结论

1. **风格锚定可复现**：Minimal 工具对（bash + str_replace_editor）首请求即可把 DS 从 "let me" 个体轨迹切换到 "We need" 协作轨迹——仓库核心假说在 Pi 上成立。
2. **锚定跟随工作轮的当前目录**：风格不写在会话历史里，而是由"实际执行工作的那一轮的工具目录"决定。目录保持 minimal → 全程协作体（B/C）；目录转丰富 → 当轮即回落（C2/D2）。
3. **工具切换由轮边界触发**：同一轮内晋升，模型绝不回看目录（C/D）；晋升后任务在新轮到达，模型会重新审视并自发切换（C2），显式通告使其更积极（D2 44 vs C2 14 次）。
4. **Pi 特有变量**：Pi 的 bash 实际有网络（DSH 沙箱才真断网），B/C/D 的 curl 行为据此产生；严格复现 DSH 条件需断网沙箱。
5. **成本由工具结果上下文主导**：bash 自建管线 vs 搜索工具的 token 差一个数量级，与思维链无关。

## 5. 对"DS RL 性能释放"的实践建议

| 目标 | 方案 | 依据 |
|---|---|---|
| 风格纯度（RL 轨迹对齐） | B 模式：全程 minimal 目录（`dsh-minimal.ts`） | we=157 最强锚定；但检索型任务 17× token，且产出事实覆盖不占优 |
| 综合性价比 | C2 模式：锚定开场 → 跨轮静默晋升（`dsh-anchored.ts` + `DSH_ANCHOR_PROMOTE_HINT=0` + 先闲聊一轮再给任务） | $0.047、309 行最长产出、接近 A 的成本 |
| 检索积极度 | D2 模式：跨轮显式通告（`DSH_ANCHOR_PROMOTE_HINT` 默认开即自动注入） | web_search 44 次，覆盖面最广 |
| 默认基线 | A（Pi 原生全工具） | 效率与覆盖面均衡，但无锚定风格 |

**扩展落地**：`dsh-anchored.ts` 的晋升通告（`DSH_ANCHOR_PROMOTE_HINT`）默认开启 = D2 效果；设 `=0` = C2 效果；配合“先锚定闲聊一轮、再给任务”的使用模式即可获得轮边界红利。C2 模式已封装为独立插件 **`dsh-c2.ts`**（交互式自动锚定，详见 `dsh-plugin/README.md` 第八节）。

## 6. 局限与后续工作

- n=1/组、单任务、单模型（仓库亦仅 r1/r2）——风格计数与工具选择结论仅供方向性参考。
- 日期冲突（Codex-Max 等）未定真伪；若要定量"结果质量"需要人工标注基准。
- 后续可做：① 断网沙箱重跑 B/C（还原 DSH 条件）；② 多任务/多模型（Flash）重复；③ 锚定轮长度对锚定强度的剂量实验；④ 晋升后驻留集大小（3 工具 vs 全目录）对风格回落速率的影响。

## 7. 数据与复现

```
exp/
├── REPORT.md            # 本报告
├── prompt.txt           # 任务文本（六组共用）
├── round1.txt           # 锚定轮文案（D2/C2）
├── round2.txt           # 通告轮文案（D2）
├── round2b.txt          # 中性轮文案（C2）
├── run-one.sh           # A–D 跑批脚本（pi -p）
├── run-d2.mjs           # D2 跑批脚本（SDK）
├── run-multi.mjs        # C2 跑批脚本（SDK 多轮）
├── analyze.mjs          # 结构统计
├── analyze2.mjs         # 思维链风格 + 工具序列
├── analyze3.mjs         # 事实覆盖 + 日期一致性
├── sessions/{A,B,C,D,D2,C2}/   # 会话 JSONL（含完整 thinking/usage）
├── out-{A,B,C,D,D2,C2}.txt     # 各组成品
├── err-*.txt / meta-*.txt      # 错误与耗时
├── artifacts/A-openai_model_history.md  # A 组写出的文件
└── work/ work-d2/ work-c2/     # 运行期工作目录（B/C/D 的抓取物）

dsh-plugin/
├── dsh-minimal.ts       # minimal 复刻扩展（persona 替换 + 双工具）
├── dsh-anchored.ts      # anchored-standard 移植（bootstrap/晋升/纪元/通告）
├── dsh-c2.ts            # C2 工作模式插件（锚定开场 + 跨轮静默晋升，依赖 anchored）
├── smoke.mjs            # 三件套冒烟测试（全部通过）
└── README.md            # 机制映射与使用说明
```

复现命令：

```bash
# A–D（pi -p）
cd exp && ./run-one.sh A
./run-one.sh B -e ../dsh-plugin/dsh-minimal.ts
./run-one.sh C -e ../dsh-plugin/dsh-anchored.ts
./run-one.sh D -e ../dsh-plugin/dsh-anchored.ts "@$(pwd)/round1.txt" "@$(pwd)/round2.txt" "@$(pwd)/prompt.txt"

# D2 / C2（SDK 多轮；需先建立 exp/node_modules 与 dsh-plugin/node_modules 的 pi 包 junction）
node run-multi.mjs D2 round2.txt
DSH_ANCHOR_PROMOTE_HINT=0 node run-multi.mjs C2 round2b.txt

# 分析
node analyze2.mjs && node analyze3.mjs
```
