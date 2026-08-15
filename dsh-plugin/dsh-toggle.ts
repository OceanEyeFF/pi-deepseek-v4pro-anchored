/**
 * dsh-toggle.ts — DSH 模式开关插件：{关, C2} 一键切换
 *
 * 关 (默认) = 原生 Pi，完全不加干预；
 * C2        = 实验组 C2 工作模式：锚定开场（minimal persona + bash + str_replace_editor）
 *             → 首条消息先跑锚定轮 → 跨轮**静默**晋升 → 任务在新轮自发生成工具选择
 *             （实验依据 exp/REPORT.md：$0.047 成本、309 行最长产出）。
 *
 * 切换方式（运行时立即生效，无需重启）：
 *   /dsh-mode c2    开启 C2 模式
 *   /dsh-mode off   关闭，恢复原生 Pi（同时恢复全部工具）
 *   /dsh-mode       查看当前模式
 *   /dsh c2 | /dsh off | /dsh   （别名）
 *
 * 环境变量（启动时默认值）：
 *   DSH_MODE=off|c2  默认 off
 *
 * 使用建议：在**新会话第一条消息之前**切换。开启后首条消息会自动先跑锚定轮；
 * 已有历史的会话切换 c2 也会启用 persona/晋升/驻留集机制，但不再插入锚定轮。
 *
 * ⚠ 加载要求：本插件只负责“开关门控 + C2 锚定轮 + 命令”，**不注册 anchored 机制本身**。
 * 必须与 dsh-anchored.ts 同时加载（机制由它注册，本插件门控其全部 handler）：
 *   - 全局安装：把 dsh-anchored.ts 和 dsh-toggle.ts 一起放进 ~/.pi/agent/extensions/
 *   - 单次使用：pi -e ./dsh-anchored.ts -e ./dsh-toggle.ts
 * 不要同时再加载 dsh-c2.ts / dsh-minimal.ts（避免重复注册）。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerC2Anchor, setAnchoredEnabled } from "./dsh-anchored.ts";

export default function (pi: ExtensionAPI) {
	let mode: "off" | "c2" = (process.env.DSH_MODE ?? "off").trim().toLowerCase() === "c2" ? "c2" : "off";

	// C2 = 静默晋升（不发通告；实验证明通告只是加速剂，静默性价比更高）
	if (mode === "c2" && process.env.DSH_ANCHOR_PROMOTE_HINT === undefined) {
		process.env.DSH_ANCHOR_PROMOTE_HINT = "0";
	}

	// 门控：anchored 的所有 handler 在事件触发时检查此开关
	setAnchoredEnabled(mode === "c2");
	// C2 锚定轮拦截（开关控制）
	registerC2Anchor(pi, () => mode === "c2");

	const apply = (next: "off" | "c2") => {
		mode = next;
		if (next === "c2" && process.env.DSH_ANCHOR_PROMOTE_HINT === undefined) {
			// 运行中切到 c2 也要静默晋升 (anchored 在每次 promote 时读 env)
			process.env.DSH_ANCHOR_PROMOTE_HINT = "0";
		}
		setAnchoredEnabled(next === "c2");
		if (next === "off") {
			// 关闭时恢复全部工具；persona 也会在下一轮回到原生（before_agent_start 已被门控放行）
			try {
				pi.setActiveTools(pi.getAllTools().map((t) => t.name));
			} catch {
				/* best-effort */
			}
		}
	};

	const command = {
		description: "切换 DSH 模式: off = 原生 Pi; c2 = 锚定开场 + 跨轮静默晋升",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "off" || arg === "c2") {
				apply(arg);
				ctx?.ui?.notify?.(arg === "c2" ? "DSH 模式: C2（锚定开场 + 跨轮静默晋升）" : "DSH 模式: 关闭（原生 Pi）", "info");
				return;
			}
			ctx?.ui?.notify?.(`当前 DSH 模式: ${mode === "c2" ? "C2" : "关闭"}。用法: /dsh-mode off|c2`, "info");
		},
	};

	pi.registerCommand("dsh-mode", command);
	pi.registerCommand("dsh", command);

	// 会话启动时在状态栏显示当前模式（便于随时确认）
	pi.on("session_start", (_event, ctx: { ui?: { setStatus?: (id: string, text: string) => void } }) => {
		ctx?.ui?.setStatus?.("dsh-mode", `DSH: ${mode === "c2" ? "C2" : "关"}`);
	});
}
