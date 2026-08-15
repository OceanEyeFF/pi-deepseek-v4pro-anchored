# Pi DeepSeek V4 Pro Anchored

[English](./README.md)

`pi-deepseek-v4pro-anchored` 是一个可安装的 [Pi Package](https://pi.dev/packages)，用于在 Pi 中为 DeepSeek V4 Pro 应用渐进式、DSH 风格的工具工作流。

## 渐进模式（默认）

**渐进模式 / Progressive mode** 会让新的交互式会话从精简、聚焦的工具目录开始，并在短锚定轮结束后的下一个轮次才按需扩展工具：

1. 以兼容 DSH 的最小环境启动：一行 persona，加上 `bash` 与 `str_replace_editor`。
2. 在第一条普通交互任务前，先执行一条很短的锚定轮。
3. 在下一工作轮静默晋升到小型发现工具集，让模型只解锁实际需要的工具。

原始实验把这一工作流称为 **C2**。现在 C2 仅表示实验组编号和向后兼容别名；面向用户的名称为 **渐进模式 / Progressive mode**。随附实验显示，该变体在一次 DeepSeek V4 Pro 检索任务中取得了最好的综合权衡。这只是工作流假设的证据，并不保证它会提升所有模型或所有任务的质量、成本或安全性。

## 安装

Pi 的包目录会索引携带 `pi-package` 关键词的 npm 包。安装已发布包：

```bash
pi install npm:pi-deepseek-v4pro-anchored
```

不安装、仅试用一次：

```bash
pi -e npm:pi-deepseek-v4pro-anchored
```

Pi 默认全局加载包。如需仅在当前项目中安装，请在 `pi install` 时加 `-l`。

## 与 DeepSeek V4 Pro 一起使用

在启动会话前，请配置你选择的 Pi provider，并选中 DeepSeek V4 Pro。本包刻意不注册 provider、不选择模型，也不处理 API 凭据。

安装后默认启用渐进模式。第一条普通交互消息会排在锚定轮之后执行；斜杠命令、恢复的会话、RPC 与 print 模式请求不会被拦截。

锚定轮会走 Pi 正常的“输入变换”管线；只有 Pi 已报告锚定轮的 agent run 启动后，扩展才会把原始任务以 followUp 排入队列。这样刻意避免在同一个 input 事件里并发发出两条用户消息请求。图片附件不会进入锚定轮，只会随原始任务保留。

运行时命令：

```text
/dsh-mode progressive  启用渐进模式（先精简工具，随后按需扩展）
/dsh-mode off          恢复原生 Pi 行为与工具
/dsh-mode              查看当前模式
/dsh ...               /dsh-mode 的别名
/dsh-status             查看受控阶段与已激活工具
/dsh-mode c2           progressive 的旧版兼容别名
```

在启动 Pi 前设置 `DSH_MODE=off`，即可加载命令但让工作流初始保持关闭。

## 配置

| 变量 | 含义 |
| --- | --- |
| `DSH_MODE=off\|progressive` | 初始模式；包默认值为 `progressive`。 |
| `DSH_MODE=c2` | `progressive` 的旧版兼容别名。 |
| `DSH_ANCHOR_TEXT` | 替换短锚定轮的消息文案。 |
| `DSH_C2_ANCHOR_TEXT` | `DSH_ANCHOR_TEXT` 的旧版兼容别名。 |
| `DSH_ANCHOR_PROMOTE_HINT=0\|1` | `0` 是渐进模式默认值：静默晋升。`1` 会发送晋升提示（D2 实验变体）。 |
| `DSH_ANCHOR_SHELL=bash\|pwsh` | 选择最小 shell schema。 |
| `DSH_ANCHOR_COMPACTION_TOOLS=...` | 控制压缩后的工作工具集。 |

已有配置可在方便时把 `DSH_MODE=c2` 改为 `DSH_MODE=progressive`，并把 `DSH_C2_ANCHOR_TEXT` 改为 `DSH_ANCHOR_TEXT`；两种旧写法仍然有效。

## 兼容性与安全性

- Pi：`@earendil-works/pi-coding-agent`（已用 0.83.0 测试，并按 0.84.2 打包）
- Node.js：22.19.0 或更高版本
- 这是拥有 Pi 常规完整用户权限的扩展。请只安装来自可信来源的包，并在使用前审查代码。

扩展使用刻意收窄的初始工具目录。它不提供沙箱、网络隔离、模型访问或凭据管理。

## 证据与限制

随附的[实验报告](./exp/REPORT.md)比较了同一检索任务的六次单独运行。其中 C2 实验组（现称“渐进模式”）的结果为 $0.047、309 行输出、24/25 条事实覆盖。研究中每个分组仅有 `n=1`，且只覆盖一个模型/任务；在依赖它之前，请用自己的工作负载进行基准测试。

原始网页抓取与模型会话轨迹默认不会进入公开包/仓库；它们仍保留在原始本地研究目录中。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run pack:check
```

npm tarball 仅包含包入口、运行时文件与发布文档。Pi 通过 jiti 加载 TypeScript 扩展，无需构建步骤。

## 许可证与致谢

MIT。上游研究与实现参考请见 [NOTICE](./NOTICE)。
