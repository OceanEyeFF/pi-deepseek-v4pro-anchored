/**
 * dsh-toggle.ts — DSH mode switch / DSH 模式开关：{off / 关闭, progressive / 渐进}
 *
 * Off / 关闭（默认）
 *   Native Pi behaviour and the full native tool catalog. / 原生 Pi 行为与完整原生工具目录。
 *
 * Progressive mode / 渐进模式
 *   Start with a small, focused tool catalog, run a short anchor turn before the
 *   first task, then silently expand tools on the next turn as needed.
 *   先以精简工具目录开始；首个任务前先执行短锚定轮；随后在下一轮静默按需扩展工具。
 *   The experiment called this workflow “C2”; that is now a legacy compatibility
 *   alias, not the user-facing name. / 实验中将其记为“C2”；该名称现仅作兼容别名。
 *
 * Runtime commands / 运行时命令（立即生效，无需重启）：
 *   /dsh-mode progressive  Enable Progressive mode / 启用渐进模式
 *   /dsh-mode off          Restore native Pi and all tools / 恢复原生 Pi 与全部工具
 *   /dsh-mode              Show the current mode / 查看当前模式
 *   /dsh ...               Alias / 别名
 *   /dsh-status            Show controlled phase and active tools / 查看受控阶段与已激活工具
 *   /dsh-mode c2           Legacy alias for progressive / 渐进模式的旧版兼容别名
 *
 * Environment / 环境变量（启动时默认值）：
 *   DSH_MODE=off|progressive  Default is off when this standalone toggle is used.
 *                              单独使用本开关时默认 off。
 *   DSH_MODE=c2               Legacy alias for progressive / 渐进模式的旧版兼容别名。
 *
 * Recommendation / 使用建议：switch before the first message in a new session.
 * 建议在新会话的第一条消息前切换。已有历史的会话切换到渐进模式也会启用
 * persona、晋升与驻留集机制，但不会再插入锚定轮。
 *
 * Loading requirement / 加载要求：this file controls the gate and commands; it does
 * not register the anchored mechanism itself. It must be loaded with dsh-anchored.ts.
 * 本文件只负责开关门控与命令，不注册 anchored 机制本身；必须与 dsh-anchored.ts 同时加载。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAnchoredStatus, registerProgressiveAnchor, setAnchoredEnabled } from "./dsh-anchored.ts";

type Mode = "off" | "progressive";

function parseMode(raw: string | undefined): Mode {
	const value = (raw ?? "off").trim().toLowerCase();
	return value === "progressive" || value === "c2" ? "progressive" : "off";
}

function modeLabel(mode: Mode): string {
	return mode === "progressive" ? "渐进模式 / Progressive mode" : "关闭 / Off";
}

export default function (pi: ExtensionAPI) {
	let mode: Mode = parseMode(process.env.DSH_MODE);

	// 渐进模式默认静默晋升 / Progressive mode promotes silently by default.
	// The experiment found notices are only an accelerator, while silent promotion
	// has the better overall cost/quality trade-off. / 实验表明通告只是加速剂，
	// 静默晋升的综合性价比更好。
	if (mode === "progressive" && process.env.DSH_ANCHOR_PROMOTE_HINT === undefined) {
		process.env.DSH_ANCHOR_PROMOTE_HINT = "0";
	}

	// Gate every anchored handler at event time / 在事件触发时门控所有 anchored handler。
	setAnchoredEnabled(mode === "progressive");
	// Progressive-mode anchor interception / 渐进模式锚定轮拦截（由开关控制）。
	registerProgressiveAnchor(pi, () => mode === "progressive");

	const apply = (next: Mode) => {
		mode = next;
		if (next === "progressive" && process.env.DSH_ANCHOR_PROMOTE_HINT === undefined) {
			// Running changes are supported because anchored reads this on every promotion.
			// 运行中切换同样生效：anchored 会在每次晋升时读取该环境变量。
			process.env.DSH_ANCHOR_PROMOTE_HINT = "0";
		}
		setAnchoredEnabled(next === "progressive");
		if (next === "off") {
			// Restore all tools; the native persona returns on the next turn.
			// 恢复全部工具；下一轮将回到原生 persona。
			try {
				pi.setActiveTools(pi.getAllTools().map((t) => t.name));
			} catch {
				/* best-effort */
			}
		}
	};

	const command = {
		description:
			"切换 DSH 模式 / Switch DSH mode: progressive = 渐进工具工作流 / Progressive mode（先精简、后按需扩展 / minimal first, expand on demand）; off = 原生 Pi / native Pi. c2 为旧版兼容别名 / legacy alias.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = (args ?? "").trim().toLowerCase();
			const next = arg === "c2" ? "progressive" : arg;
			if (next === "off" || next === "progressive") {
				apply(next);
				ctx?.ui?.notify?.(
					next === "progressive"
						? "DSH：已启用渐进模式 / Progressive mode enabled — 先精简工具，随后按需扩展。"
						: "DSH：已关闭 / Off — 已恢复原生 Pi 工具。",
					"info",
				);
				return;
			}
			ctx?.ui?.notify?.(
				`当前 DSH 模式 / Current DSH mode: ${modeLabel(mode)}。用法 / Usage: /dsh-mode progressive|off（c2 为旧版兼容别名 / legacy alias）；用 /dsh-status 查看阶段和工具 / inspect phase and tools。`,
				"info",
			);
		},
	};

	const statusCommand = {
		description: "查看 DSH 当前阶段与已激活工具 / Show the current DSH phase and active tools.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			let activeTools: string[] = [];
			try {
				activeTools = pi.getActiveTools();
			} catch {
				/* unavailable only during an abnormal runtime transition */
			}

			if (mode === "off") {
				ctx?.ui?.notify?.(
					"DSH 状态 / DSH status: 关闭 / Off；当前工具目录由原生 Pi 管理 / the native Pi catalog is in control。已激活工具 / active tools: " +
						(activeTools.join(", ") || "（不可用 / unavailable）") +
						"。",
					"info",
				);
				return;
			}

			const status = getAnchoredStatus(ctx);
			const unlocked = status.unlockedTools.length > 0 ? status.unlockedTools.join(", ") : "无 / none";
			ctx?.ui?.notify?.(
				"DSH 状态 / DSH status: 渐进模式 / Progressive mode；阶段 / phase: " +
					status.phase +
					"；锚定任务待排队 / anchor task pending: " +
					(status.pendingAnchorTask ? "是 / yes" : "否 / no") +
					"；已解锁工具 / unlocked: " +
					unlocked +
					"；已激活工具 / active tools: " +
					(activeTools.join(", ") || "（不可用 / unavailable）") +
					"。",
				"info",
			);
		},
	};

	pi.registerCommand("dsh-mode", command);
	pi.registerCommand("dsh", command);
	pi.registerCommand("dsh-status", statusCommand);

	// Show the active mode in the status bar / 在状态栏显示当前模式，便于随时确认。
	pi.on("session_start", (_event, ctx: { ui?: { setStatus?: (id: string, text: string) => void } }) => {
		ctx?.ui?.setStatus?.("dsh-mode", mode === "progressive" ? "DSH: 渐进 / Progressive" : "DSH: 关闭 / Off");
	});
}
