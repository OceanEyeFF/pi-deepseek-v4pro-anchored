/**
 * npm Pi Package entry point / npm Pi 包入口。
 *
 * The package defaults to Progressive mode: start with a focused tool catalog,
 * then expand it on the next turn as needed. / 包默认启用渐进模式：先使用精简工具
 * 目录，再在下一轮按需扩展。The experiment called this workflow “C2”; `c2` remains
 * a compatibility alias only. / 实验曾将该工作流记为“C2”；`c2` 仅保留为兼容别名。
 *
 * Set DSH_MODE=off before Pi starts to load the commands while leaving native Pi
 * behaviour untouched. / 在启动 Pi 前设置 DSH_MODE=off，可加载命令但保持原生行为。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import anchored from "./dsh-anchored.ts";
import toggle from "./dsh-toggle.ts";

export default function (pi: ExtensionAPI) {
	// A package install should be useful immediately. / 安装后即可直接使用。
	// Users can opt out with DSH_MODE=off or switch at runtime with /dsh-mode.
	// 用户仍可通过 DSH_MODE=off 或 /dsh-mode 在运行时切换。
	if (process.env.DSH_MODE === undefined) process.env.DSH_MODE = "progressive";

	anchored(pi);
	toggle(pi);
}
