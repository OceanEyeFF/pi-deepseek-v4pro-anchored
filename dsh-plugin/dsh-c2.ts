/**
 * dsh-c2.ts — C2 工作模式插件（实验 REPORT 第 5 节：综合性价比最优方案）
 *
 * C2 模式（实验组 C2，619s / $0.047 / 309 行产出）：
 *   1. 会话启动 = dsh-anchored 的 bootstrap 阶段：minimal persona + minimal 目录
 *      （bash + str_replace_editor），无任何注入上下文；
 *   2. 用户发出第一条消息时，插件先注入一条**锚定轮**消息（默认自介），该轮在
 *      minimal 目录下跑完，模型回复即触发**静默晋升**（不发通告——与 D2 的关键区别）；
 *   3. 真实消息作为下一轮（followUp）送达——新轮边界 + 已扩展目录，模型自发解锁
 *      所需工具（C2 实验：dev_tool_search×5、web_search×14、全程无通告）。
 *
 * 机制依据（exp/REPORT.md）：工具切换由**轮边界**触发；通告只是加速剂（D2 44 次
 * 搜索 vs C2 14 次，而 C2 成本更低 $0.047 vs $0.091）。
 *
 * 配置（环境变量，/reload 生效）：
 *   DSH_C2_ANCHOR_TEXT       锚定轮文案（默认自介）
 *   DSH_ANCHOR_PROMOTE_HINT  未显式设置时强制 0（静默晋升）；设 1 切回 D2 式通告
 *
 * 用法：
 *   # 交互式（TUI）：自动生效
 *   pi -e ./dsh-c2.ts
 *   # 自动化（SDK）：runner 自己编排锚定轮（exp/run-multi.mjs 的 C2 跑法），
 *   # 插件负责静默晋升与驻留集。
 *
 * 如需 {关, C2} 切换版，请用 dsh-toggle.ts（同样依赖 dsh-anchored.ts）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import anchored, { registerC2Anchor } from "./dsh-anchored.ts";

export default function (pi: ExtensionAPI) {
	// C2 = 静默晋升：未显式配置时关掉晋升通告（D2 vs C2 的唯一区别）
	if (process.env.DSH_ANCHOR_PROMOTE_HINT === undefined) {
		process.env.DSH_ANCHOR_PROMOTE_HINT = "0";
	}
	// 完整 anchored 机制：bootstrap 目录、minimal persona、晋升、压缩纪元、按需解锁
	anchored(pi);
	// C2 锚定轮拦截（始终开启）
	registerC2Anchor(pi);
}
