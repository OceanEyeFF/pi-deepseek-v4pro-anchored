/**
 * dsh-anchored.ts — Pi 移植 xiaobright/dsh-anchored-standard
 * (https://github.com/xiaobright/dsh-anchored-standard, MIT)
 *
 * 核心假设 (来自该仓库的实测, 见其 README / issue #6 / #11):
 *   - DeepSeek V4 Pro 强烈条件化于 API 可见的工具目录; Minimal 工具对
 *     (persistent bash + str_replace_editor) 在 adapter 默认 maxTokens(256000)
 *     下 5/5 锚定 RL 最优轨迹, 而所有 standard 系 schema 11/11 落入 standard-like。
 *   - 首请求的自动注入上下文 (技能目录 ~9KB、AGENTS.md 摘要) 会破坏锚定:
 *     有技能目录注入时 0/9 锚定, 无注入时 ~81%。
 *   - 晋升后一次性 dump 全部工具会把轨迹拉回 standard-like —— 所以晋升后只给
 *     最小驻留集 + 按需解锁 (dev_tool_search), 重工具一键解锁。
 *   - 压缩重写整个可见面, 压缩后是"第二次首请求", 需要纪元感知地重新 bootstrap。
 *
 * Pi 移植映射:
 *   DSH (cordis)                          → Pi (扩展 API)
 *   -----------------------------------  ---------------------------------------
 *   system-prompt/assemble 过滤器         → before_agent_start 返回 systemPrompt
 *   agent/pre-step 注入剥离               → 同上: 整体替换 persona 即剥离全部注入
 *   agent/request maxTokens 封顶(opt-in) → 不做 (Pi 无等价钩子; 仓库结论是
 *                                             256000 下工具 schema 才是决定变量)
 *   promotion 信号 tool/call 等           → tool_execution_start / turn_end
 *   持久 session event 扫描              → session_start 扫 ctx.sessionManager.getBranch()
 *   compaction/end 纪元边界              → session_compact 事件 + 条目扫描
 *   dev_tool_search / skill_search       → 自定义工具 (pi.getAllTools /
 *                                             before_agent_start 的 skills 快照)
 *   agent/inbox/inserted 锚定轮          → input transform + agent_start followUp 队列
 *   instruction-hint                     → 晋升后一次性 pi.sendMessage 提示
 *
 * 配置 (环境变量, /reload 生效):
 *   DSH_ANCHOR_SHELL=bash|pwsh         默认 bash (对齐官方 minimal 的 bash schema)
 *   DSH_ANCHOR_PROMOTE_ON=either       默认; 可选 tool-call / assistant-message
 *   DSH_ANCHOR_TURN=none               默认; zero / whoami = 首请求前插入零工具锚定轮
 *   DSH_ANCHOR_COMPACTION_TOOLS=read,write,edit,find,grep,ls  压缩后的工作集 (空=无)
 *
 * 阶段工具目录:
 *   bootstrap (首请求):  [shell, str_replace_editor]  —— 官方 Minimal 真实工具对
 *   promoted (晋升后):   [shell, str_replace_editor, dev_tool_search, skill_search,
 *                        skill_load, ...unlocked]  —— 最小驻留集, 不 dump 全目录
 *   post-compaction:     [shell, str_replace_editor, ...compactionTools] 直到再晋升
 *   anchor turn:         [] (零工具, 用于 zero/whoami 变体)
 *
 * 用法:
 *   pi -e ./dsh-anchored.ts
 *   # 或复制到 ~/.pi/agent/extensions/dsh-anchored.ts (全局自动加载)
 */

import type { ExtensionAPI, InputEvent } from "@earendil-works/pi-coding-agent";
import { createBashTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Runtime gate / 运行时开关：dsh-toggle 用它在 {关闭 / Off, 渐进 / Progressive}
// 之间切换；独立加载时默认启用。 / Standalone use defaults to enabled.
// ─────────────────────────────────────────────────────────────────────────────
let anchoredEnabled = true;

/** 开/关全部 anchored 机制（persona 替换、工具目录控制、晋升、压缩纪元）。 */
export function setAnchoredEnabled(on: boolean) {
	anchoredEnabled = on;
}

export function isAnchoredEnabled() {
	return anchoredEnabled;
}

// ─────────────────────────────────────────────────────────────────────────────
// 与官方 minimal preset 逐字一致的部分
// ─────────────────────────────────────────────────────────────────────────────
const PERSONA = "You are a helpful software engineer assistant.";

const BASH_DESCRIPTION = [
	"Run commands in a bash shell",
	'* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
	"* You don't have access to the internet via this tool.",
	"* You do have access to a mirror of common linux and python packages via apt and pip.",
	"* State is persistent across command calls and discussions with the user.",
	"* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
	"* Please avoid commands that may produce a very large amount of output.",
	"* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.",
].join("\n");

const PWSH_DESCRIPTION = [
	"Run commands in a PowerShell shell",
	'* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
	"* You don't have access to the internet via this tool.",
	"* State is persistent across command calls and discussions with the user (the current directory is preserved across calls).",
	"* To inspect a particular line range of a file, e.g. lines 10-25, try 'Get-Content /path/to/the/file | Select-Object -Skip 9 -First 16'.",
	"* Please avoid commands that may produce a very large amount of output.",
	"* Please run long lived commands in the background, e.g. 'Start-Job { ... }' or start a server in the background.",
].join("\n");

const MAX_OUTPUT_CHARS = 16000;
const TRUNCATED_MESSAGE =
	"<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";
const EDITOR_DESCRIPTION = [
	"Custom editing tool for viewing, creating and editing files",
	"* State is persistent across command calls and discussions with the user",
	"* If `path` is a file, `view` displays the result of applying `cat -n`. If `path` is a directory, `view` lists non-hidden files and directories up to 2 levels deep",
	"* The `create` command cannot be used if the specified `path` already exists as a file",
	"* If a `command` generates a long output, it will be truncated and marked with `<response clipped>`",
	"",
	"Notes for using the `str_replace` command:",
	"* The `old_str` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!",
	"* If the `old_str` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in `old_str` to make it unique",
	"* The `new_str` parameter should contain the edited lines that should replace the `old_str`",
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// 会话级状态 (与 DSH 一样, 从持久会话条目推导, resume/reload 安全)
// ─────────────────────────────────────────────────────────────────────────────
let bashCwd: string | undefined;
let pwshCwd: string | undefined;
const undoHistory = new Map<string, string[]>();
let skillsSnapshot: Array<{ name: string; description: string; filePath: string }> = [];
let contextFilePaths: string[] = [];

interface PendingAnchorTask {
	text: string;
	images: InputEvent["images"];
}

// sessionId -> phase state
interface PhaseState {
	boundaryId: string | null; // 最近一次 compaction 条目 id (纪元边界)
	promoted: boolean;
	hinted: boolean; // instruction-hint 已注入一次
	unlocked: Set<string>; // dev_tool_search 显式解锁的工具
	pendingAnchorTask: PendingAnchorTask | null; // 已变换为锚定轮、等待安全排队的原始任务
}
const phases = new Map<string, PhaseState>();

function stateFor(ctx: { sessionManager?: { getSessionId?: () => string } }): PhaseState {
	let id = "default";
	try {
		id = ctx?.sessionManager?.getSessionId?.() ?? "default";
	} catch {
		id = "default";
	}
	let s = phases.get(id);
	if (!s) {
		s = { boundaryId: null, promoted: false, hinted: false, unlocked: new Set(), pendingAnchorTask: null };
		phases.set(id, s);
	}
	return s;
}

export type AnchoredPhase = "bootstrap" | "anchoring" | "promoted" | "post-compaction";

export interface AnchoredStatus {
	phase: AnchoredPhase;
	pendingAnchorTask: boolean;
	unlockedTools: string[];
}

/** 获取当前受控阶段，供 dsh-toggle 的状态命令使用。 */
export function getAnchoredStatus(ctx: { sessionManager?: { getSessionId?: () => string } }): AnchoredStatus {
	const state = stateFor(ctx);
	return {
		phase: state.pendingAnchorTask !== null ? "anchoring" : state.promoted ? "promoted" : state.boundaryId !== null ? "post-compaction" : "bootstrap",
		pendingAnchorTask: state.pendingAnchorTask !== null,
		unlockedTools: [...state.unlocked].sort(),
	};
}

/**
 * Pi 先通过正常输入管线提交锚定轮，再在 agent 已启动后用 followUp 排队原始任务。
 * This deliberately avoids two competing sendUserMessage calls from one input event.
 */
function queuePendingAnchorTask(pi: ExtensionAPI, ctx: { sessionManager?: { getSessionId?: () => string } }) {
	const state = stateFor(ctx);
	const pending = state.pendingAnchorTask;
	if (!pending) return;

	state.pendingAnchorTask = null;
	const content =
		pending.images && pending.images.length > 0
			? [{ type: "text" as const, text: pending.text }, ...pending.images]
			: pending.text;
	pi.sendUserMessage(content, { deliverAs: "followUp" });
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具集
// ─────────────────────────────────────────────────────────────────────────────
const DISCOVERY_TOOLS = ["dev_tool_search", "skill_search", "skill_load"];

function maybeTruncate(content: string): string {
	return content.length <= MAX_OUTPUT_CHARS ? content : content.slice(0, MAX_OUTPUT_CHARS) + TRUNCATED_MESSAGE;
}

function bashQuote(path: string): string {
	return `'${path.replace(/'/g, `'\\''`)}'`;
}

function pwshQuote(path: string): string {
	return `'${path.replace(/'/g, "''")}'`;
}

function lastBashCdTarget(command: string): string | undefined {
	const re = /(?:^|[\n;&]\s*|&&\s*)cd\s+("[^"]*"|'[^']*'|\S+)/g;
	let target: string | undefined;
	let m: RegExpExecArray | null;
	while ((m = re.exec(command)) !== null) target = m[1].replace(/^["']|["']$/g, "");
	return target;
}

function lastPwshCdTarget(command: string): string | undefined {
	const re = /(?:^|[\n;]|&&)\s*(?:cd|Set-Location|sl)\s+('[^']*'|"[^"]*"|\S+)/gi;
	let target: string | undefined;
	let m: RegExpExecArray | null;
	while ((m = re.exec(command)) !== null) target = m[1].replace(/^['"]|['"]$/g, "").replace(/''/g, "'");
	return target;
}

function resolvePwshPath(): string {
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
		const standard = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		if (existsSync(standard)) return standard;
		try {
			const found = spawnSync("where", ["powershell.exe"], { encoding: "utf8", timeout: 5000, windowsHide: true });
			const first = found.stdout?.trim().split(/\r?\n/)[0];
			if (found.status === 0 && first && existsSync(first)) return first;
		} catch {
			/* fallthrough */
		}
	} else {
		for (const candidate of ["/usr/bin/pwsh", "/usr/local/bin/pwsh", "/opt/microsoft/powershell/7/pwsh"]) {
			if (existsSync(candidate)) return candidate;
		}
		try {
			const found = spawnSync("which", ["pwsh"], { encoding: "utf8", timeout: 5000 });
			const first = found.stdout?.trim().split(/\r?\n/)[0];
			if (found.status === 0 && first) return first;
		} catch {
			/* fallthrough */
		}
	}
	throw new Error(
		"dsh-anchored: PowerShell not found. Install PowerShell 7 or use DSH_ANCHOR_SHELL=bash with Git Bash.",
	);
}

function viewFile(absPath: string, viewRange?: number[]): string {
	const content = readFileSync(absPath, "utf8");
	const allLines = content.split("\n");
	let start = 1;
	let end = allLines.length;
	let rangeNote = "";
	if (viewRange !== undefined) {
		if (viewRange.length !== 2 || !viewRange.every(Number.isInteger)) {
			throw new Error("Invalid `view_range`. It should be a list of two integers.");
		}
		const [a, b] = viewRange;
		if (a < 1 || a > allLines.length) {
			throw new Error(`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${a}\` should be within the range of lines of the file: [1, ${allLines.length}]`);
		}
		if (b > allLines.length) {
			throw new Error(`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${b}\` should be smaller than the number of lines in the file: \`${allLines.length}\``);
		}
		if (b !== -1 && b < a) {
			throw new Error(`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${b}\` should be larger or equal than its first \`${a}\``);
		}
		start = a;
		end = b === -1 ? allLines.length : b;
		rangeNote = ` with view_range=[${a}, ${b}]`;
	}
	const numbered = allLines
		.slice(start - 1, end)
		.map((line, i) => `${String(start + i).padStart(6, " ")}  ${line}`)
		.join("\n");
	return maybeTruncate(
		`Here's the content of ${absPath} with line numbers (which has a total of ${allLines.length} lines)${rangeNote}:\n${numbered}\n`,
	);
}

function listDirectory(absPath: string): string {
	const rows: string[] = [];
	const visit = (dir: string, depth: number) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
			const child = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				rows.push(`d\t${child}`);
				if (depth < 2) visit(child, depth + 1);
			} else if (entry.isFile()) {
				rows.push(`f\t${child}`);
			} else {
				rows.push(`?\t${child}`);
			}
		}
	};
	rows.push(`d\t${absPath}`);
	visit(absPath, 1);
	rows.sort((l, r) => {
		const lp = l.slice(l.indexOf("\t") + 1);
		const rp = r.slice(r.indexOf("\t") + 1);
		return lp < rp ? -1 : lp > rp ? 1 : 0;
	});
	return `Here're the files and directories up to 2 levels deep in ${absPath}, excluding hidden items, node_modules, and Python cache directories:\n${maybeTruncate(rows.join("\n") + "\n")}\n`;
}

function pushUndo(absPath: string) {
	const stack = undoHistory.get(absPath) ?? [];
	stack.push(readFileSync(absPath, "utf8"));
	undoHistory.set(absPath, stack);
}

function readExisting(absPath: string): string {
	if (!existsSync(absPath) || !statSync(absPath).isFile()) {
		throw new Error(`File does not exist at: ${absPath}. Cannot execute \`str_replace\`/` + "`insert`" + ` on a missing file.`);
	}
	return readFileSync(absPath, "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// 扩展主体
// ─────────────────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	const SHELL = (process.env.DSH_ANCHOR_SHELL ?? process.env.DSH_MINIMAL_SHELL ?? "bash").trim().toLowerCase() || "bash";
	const SHELL_TOOL_NAME = SHELL === "pwsh" ? "pwsh" : "bash";
	const PROMOTE_ON = (process.env.DSH_ANCHOR_PROMOTE_ON ?? "either").trim().toLowerCase() || "either";
	const ANCHOR_TURN = (process.env.DSH_ANCHOR_TURN ?? "none").trim().toLowerCase() || "none";
	const COMPACTION_TOOLS = (process.env.DSH_ANCHOR_COMPACTION_TOOLS ?? "read,write,edit,find,grep,ls")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	// Promotion notice / 晋升通告：以独立消息提示“新工具已可用”（D2 实验验证有效；
	// DSH_ANCHOR_PROMOTE_HINT=0 关闭）。The value is read on every promotion, so
	// switching Progressive mode at runtime also takes effect. / 每次晋升时读取该值，
	// 因此运行中切换渐进模式也能生效。
	const hintEnabled = () => (process.env.DSH_ANCHOR_PROMOTE_HINT ?? "1").trim() !== "0";
	const DSH_TIMEOUT_SECONDS = 300;

	const promoteOnToolCall = PROMOTE_ON === "either" || PROMOTE_ON === "tool-call";
	const promoteOnAssistant = PROMOTE_ON === "either" || PROMOTE_ON === "assistant-message";

	const BOOTSTRAP = [SHELL_TOOL_NAME, "str_replace_editor"];
	const residentTools = (state: PhaseState) => [...new Set([...BOOTSTRAP, ...DISCOVERY_TOOLS, ...state.unlocked])];
	const postCompactionTools = () => [...new Set([...BOOTSTRAP, ...COMPACTION_TOOLS])];
	const anchorText = ANCHOR_TURN === "whoami" ? "你是谁" : ANCHOR_TURN === "zero" ? "This round is a test. Tools are not open yet; all tools will open next round." : null;

	let warned = false;
	const warnOnce = (message: string) => {
		if (warned) return;
		warned = true;
		console.warn(`[dsh-anchored] ${message}`);
	};

	/** 激活目标工具集; 缺名工具时降级 (绝不 brick 会话)。 */
	const activate = (names: string[]) => {
		try {
			pi.setActiveTools(names);
		} catch (error) {
			warnOnce(`setActiveTools failed (${String((error as Error)?.message ?? error)}); leaving the current catalog untouched`);
		}
	};

	/** 当前会话的激活工具集。 */
	const activeFor = (state: PhaseState): string[] => {
		if (state.promoted) return residentTools(state);
		if (state.boundaryId !== null) return postCompactionTools();
		return BOOTSTRAP;
	};

	/** 晋升: 切换驻留集 + 一次性晋升通告 + 一次性 instruction-hint。
	 *  D2 实验证明: 只有把"新工具已可用"作为独立消息注入 (而不是并在同一条请求里),
	 *  模型才会在下一请求切换到工具化检索路线 (D2: web_search×44; D 对照组: 0)。 */
	const promote = (ctx: { sessionManager?: { getSessionId?: () => string }; isIdle?: () => boolean }, sessionState: PhaseState) => {
		if (sessionState.promoted) return;
		sessionState.promoted = true;
		activate(residentTools(sessionState));
		const idle = ctx?.isIdle?.() ?? false;
		if (!sessionState.hinted) {
			sessionState.hinted = true;
			const parts: string[] = [];
			if (hintEnabled()) {
				parts.push(
					[
						"更新通告: 你的可用工具集刚刚扩展了。",
						`当前可用: ${residentTools(sessionState).join(", ")}。`,
						"需要联网检索、子代理、任务清单、图片阅读、后台任务等能力时，先调用 dev_tool_search 搜索并解锁对应工具（如 web_search、fetch_content、todo），解锁后从下一个请求起即可使用。",
					].join("\n"),
				);
			}
			if (contextFilePaths.length > 0) {
				parts.push(
					[
						"Workspace instruction files exist (not auto-injected into the prompt):",
						...contextFilePaths.map((p) => `- ${p}`),
						"Read the relevant one(s) yourself before acting when the task concerns repository conventions.",
					].join("\n"),
				);
			}
			if (parts.length > 0) {
				try {
					pi.sendMessage({ customType: "instruction-hint", content: parts.join("\n\n"), display: true }, { deliverAs: idle ? "nextTurn" : "steer" });
				} catch {
					/* hint is best-effort */
				}
			}
		}
	};

	/** 持久扫描: 从会话条目推导 phase + 解锁集 (resume/reload 安全)。 */
	const scanSession = (sessionManager: { getBranch?: () => Array<{ type: string; id: string; message?: { role?: string; customType?: string; toolName?: string; details?: { unlocked?: string[] } } }> }, state: PhaseState) => {
		state.boundaryId = null;
		state.promoted = false;
		state.hinted = false;
		state.unlocked = new Set();
		state.pendingAnchorTask = null;
		try {
			const entries = sessionManager?.getBranch?.() ?? [];
			for (const entry of entries) {
				if (entry.type === "compaction") {
					state.boundaryId = entry.id;
					state.promoted = false;
					continue;
				}
				if (entry.type !== "message" || !entry.message) continue;
				const m = entry.message;
				if (m.role === "user") continue;
				if (m.role === "custom" && m.customType === "instruction-hint") {
					state.hinted = true;
					continue;
				}
				if (m.role === "toolResult" && m.toolName === "dev_tool_search") {
					for (const name of m.details?.unlocked ?? []) state.unlocked.add(name);
					continue;
				}
				if (!state.promoted) {
					if (m.role === "assistant" && promoteOnAssistant) state.promoted = true;
					else if (m.role === "toolResult" && promoteOnToolCall) state.promoted = true;
				}
			}
		} catch (error) {
			warnOnce(`session scan failed, staying on bootstrap: ${String((error as Error)?.message ?? error)}`);
		}
	};

	const isFreshSession = (sessionManager: { getBranch?: () => Array<{ type: string; message?: { role?: string } }> }) => {
		try {
			return !(sessionManager?.getBranch?.() ?? []).some((e) => e.type === "message" && e.message?.role === "user");
		} catch {
			return false;
		}
	};

	// ── system prompt: 永远是 minimal persona (complete + 无运行时上下文) ──
	pi.on("before_agent_start", (event) => {
		if (!anchoredEnabled) return;
		skillsSnapshot = (event.systemPromptOptions?.skills ?? []).map((s) => ({
			name: s.name,
			description: s.description,
			filePath: s.filePath,
		}));
		contextFilePaths = (event.systemPromptOptions?.contextFiles ?? []).map((f) => f.path);
		return { systemPrompt: PERSONA };
	});

	// ── 生命周期 ──
	pi.on("session_start", (_event, ctx) => {
		if (!anchoredEnabled) return;
		bashCwd = undefined;
		pwshCwd = undefined;
		undoHistory.clear();
		const state = stateFor(ctx);
		scanSession(ctx.sessionManager as never, state);
		activate(activeFor(state));
	});

	// ── 晋升信号 (durable: session_start 扫描同样推导) ──
	pi.on("tool_execution_start", (event, ctx) => {
		if (!anchoredEnabled) return;
		if (!promoteOnToolCall || event.toolName === "dev_tool_search" || event.toolName === "skill_search" || event.toolName === "skill_load") return;
		const state = stateFor(ctx);
		if (state.promoted) return;
		promote(ctx, state);
	});

	pi.on("turn_end", (event, ctx) => {
		if (!anchoredEnabled) return;
		if (!promoteOnAssistant || event.message?.role !== "assistant") return;
		const state = stateFor(ctx);
		if (state.promoted) return;
		promote(ctx, state);
	});

	// ── 压缩纪元: 压缩后回到受控目录, 直到新的晋升信号 ──
	pi.on("session_compact", (event, ctx) => {
		if (!anchoredEnabled) return;
		const state = stateFor(ctx);
		state.boundaryId = (event as { compactionEntry?: { id?: string } }).compactionEntry?.id ?? "post-compaction";
		state.promoted = false;
		activate(postCompactionTools());
	});

	// ── 锚定轮 (zero / whoami 变体): transform 首条输入；agent_start 后安全 followUp 原任务 ──
	if (anchorText !== null) {
		pi.on("input", (event, ctx) => {
			if (!anchoredEnabled) return;
			if (event.source === "extension") return; // 不重新锚定自己注入的消息
			if (!isFreshSession(ctx.sessionManager as never)) return;
			activate([]); // 零工具面
			const state = stateFor(ctx);
			state.pendingAnchorTask = { text: event.text, images: event.images ? [...event.images] : undefined };
			return { action: "transform", text: anchorText! };
		});

		pi.on("agent_start", (_event, ctx) => {
			queuePendingAnchorTask(pi, ctx);
		});
	}

	// ═════════════════════════════════════════════════════════════════════════
	// shell 工具 (Minimal schema: 名称 + 描述决定锚定, 执行器不决定)
	// ═════════════════════════════════════════════════════════════════════════
	const bashCache = new Map<string, ReturnType<typeof createBashTool>>();
	const getBash = (cwd: string) => {
		let tool = bashCache.get(cwd);
		if (!tool) {
			tool = createBashTool(cwd);
			bashCache.set(cwd, tool);
		}
		return tool;
	};

	if (SHELL_TOOL_NAME === "bash") {
		pi.registerTool({
			name: "bash",
			label: "bash",
			description: BASH_DESCRIPTION,
			parameters: getBash(process.cwd()).parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const command = String(params.command ?? "");
				const prefixed = bashCwd !== undefined ? `cd ${bashQuote(bashCwd)} && ${command}` : command;
				const result = await getBash(ctx.cwd).execute(
					toolCallId,
					{ ...params, command: prefixed, timeout: params.timeout ?? DSH_TIMEOUT_SECONDS },
					signal,
					onUpdate,
				);
				const cdTarget = lastBashCdTarget(command);
				if (cdTarget !== undefined) bashCwd = isAbsolute(cdTarget) ? cdTarget : resolve(bashCwd ?? ctx.cwd, cdTarget);
				return result;
			},
		});
	}

	if (SHELL_TOOL_NAME === "pwsh") {
		const pwshCache = new Map<string, ReturnType<typeof createBashTool>>();
		const getPwsh = (cwd: string) => {
			let tool = pwshCache.get(cwd);
			if (!tool) {
				tool = createBashTool(cwd, {
					shellPath: resolvePwshPath(),
					spawnHook: ({ command, cwd, env }) => ({
						command: pwshCwd !== undefined ? `Set-Location -LiteralPath ${pwshQuote(pwshCwd)}; ${command}` : command,
						cwd,
						env,
					}),
				});
				pwshCache.set(cwd, tool);
			}
			return tool;
		};
		pi.registerTool({
			name: "pwsh",
			label: "pwsh",
			description: PWSH_DESCRIPTION,
			parameters: getPwsh(process.cwd()).parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const command = String(params.command ?? "");
				const result = await getPwsh(ctx.cwd).execute(
					toolCallId,
					{ ...params, command, timeout: params.timeout ?? DSH_TIMEOUT_SECONDS },
					signal,
					onUpdate,
				);
				const cdTarget = lastPwshCdTarget(command);
				if (cdTarget !== undefined) pwshCwd = isAbsolute(cdTarget) ? cdTarget : resolve(pwshCwd ?? ctx.cwd, cdTarget);
				return result;
			},
		});
	}

	// ═════════════════════════════════════════════════════════════════════════
	// str_replace_editor (官方 minimal 第二工具, 逐字移植)
	// ═════════════════════════════════════════════════════════════════════════
	pi.registerTool({
		name: "str_replace_editor",
		label: "str_replace_editor",
		description: EDITOR_DESCRIPTION,
		parameters: Type.Object({
			command: StringEnum(["view", "create", "str_replace", "insert", "undo_edit"] as const, {
				description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`, `undo_edit`.",
			}),
			path: Type.String({ description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`." }),
			file_text: Type.Optional(
				Type.String({ description: "Required parameter of `create` command, with the content of the file to be created." }),
			),
			insert_line: Type.Optional(
				Type.Number({ description: "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`." }),
			),
			new_str: Type.Optional(
				Type.String({
					description: "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the new string.",
				}),
			),
			old_str: Type.Optional(
				Type.String({ description: "Required parameter of `str_replace` command containing the string in `path` to replace." }),
			),
			view_range: Type.Optional(
				Type.Array(Type.Number(), {
					minItems: 2,
					maxItems: 2,
					description:
						"Optional parameter of `view` command when `path` points to a file. If none is given, the full file is viewed. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 starts to line 11. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const absPath = resolve(ctx.cwd, params.path);
			const cmd = params.command as "view" | "create" | "str_replace" | "insert" | "undo_edit";

			switch (cmd) {
				case "view": {
					if (!existsSync(absPath)) throw new Error(`cannot view "${absPath}": no such file or directory`);
					const info = statSync(absPath);
					if (info.isDirectory()) {
						if (params.view_range !== undefined) {
							throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.");
						}
						return { content: [{ type: "text", text: listDirectory(absPath) }], details: {} };
					}
					if (!info.isFile()) throw new Error(`cannot view "${absPath}": not a regular file or directory`);
					return { content: [{ type: "text", text: viewFile(absPath, params.view_range as number[] | undefined) }], details: {} };
				}

					case "create": {
						if (params.file_text === undefined || params.file_text.length === 0) {
							throw new Error("Parameter `file_text` is required for command: create");
						}
						const fileText = params.file_text;
						if (existsSync(absPath)) {
							throw new Error(`File already exists at: ${absPath}. Cannot overwrite files using command \`create\`.`);
						}
						return withFileMutationQueue(absPath, async () => {
							mkdirSync(dirname(absPath), { recursive: true });
							writeFileSync(absPath, fileText, "utf8");
							return { content: [{ type: "text", text: `File created successfully at: ${absPath}` }], details: {} };
						});
				}

				case "str_replace": {
					if (params.old_str === undefined) throw new Error("Parameter `old_str` is required for command: str_replace");
					const abs = absPath;
						return withFileMutationQueue(abs, async () => {
						const content = readExisting(abs);
						const count = content.split(params.old_str!).length - 1;
						if (count === 0) {
							throw new Error("String to replace not found in file (even after relaxing whitespace).");
						}
						if (count > 1) {
							throw new Error(
								"Multiple occurrences of the string to replace in file; not unique. Please provide a larger string with more surrounding context to make it unique.",
							);
						}
						pushUndo(abs);
						writeFileSync(abs, content.replace(params.old_str!, params.new_str ?? ""), "utf8");
						return { content: [{ type: "text", text: `The file ${abs} has been updated.` }], details: {} };
					});
				}

				case "insert": {
					if (params.new_str === undefined || params.new_str.length === 0) {
						throw new Error("Parameter `new_str` is required for command: insert");
					}
					const line = params.insert_line;
					if (line === undefined || !Number.isInteger(line)) {
						throw new Error("Invalid `insert_line` parameter. It should be an integer.");
					}
					const abs = absPath;
						return withFileMutationQueue(abs, async () => {
						const content = readExisting(abs);
						const lines = content.split("\n");
						if (line < 0 || line > lines.length) {
							throw new Error(`Invalid \`insert_line\` parameter: ${line}. It should be within the range of lines of the file: [0, ${lines.length}]`);
						}
						pushUndo(abs);
						lines.splice(line, 0, params.new_str!);
						writeFileSync(abs, lines.join("\n"), "utf8");
						return { content: [{ type: "text", text: `The file ${abs} has been updated.` }], details: {} };
					});
				}

				case "undo_edit": {
					const abs = absPath;
						return withFileMutationQueue(abs, async () => {
						const stack = undoHistory.get(abs);
						if (!stack || stack.length === 0) {
							throw new Error(`No edit history found for ${abs}.`);
						}
						writeFileSync(abs, stack.pop()!, "utf8");
						return {
							content: [{ type: "text", text: `Last edit to ${abs} undone successfully. Please review the file before making further changes.` }],
							details: {},
						};
					});
				}
			}
		},
	});

	// ═════════════════════════════════════════════════════════════════════════
	// dev_tool_search — 按需解锁完整目录 (the tool-search pattern)
	// ═════════════════════════════════════════════════════════════════════════
	pi.registerTool({
		name: "dev_tool_search",
		label: "dev_tool_search",
		description: [
			"Discover and unlock tools that are NOT currently available.",
			"",
			`This session keeps a minimal resident set: ${[...BOOTSTRAP, "skill_search", "skill_load"].join(", ")}. Everything else is unlocked on demand through this tool.`,
			"",
			"If the current task needs any of the following, call dev_tool_search FIRST — do not try to work around them with bash:",
			"- web_search / fetch — internet search and web retrieval",
			"- subagent / Agent — delegate work to sub-agents",
			"- todo — task tracking",
			"- ask_user_question — ask the user",
			"- read_image / image reading — image files",
			"- background jobs / workflow — long-running work",
			"",
			'Usage: pass `query` to search the catalog (returns matching tool names + descriptions), then pass `toolNames` with exact names to unlock them. Unlocked tools appear from the next request on and stay unlocked for the session.',
		].join("\n"),
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: 'search keywords (e.g. "web", "subagent")' })),
			toolNames: Type.Optional(
				Type.Array(Type.String(), { description: "exact tool names to unlock (appear from the next request on)" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const query = typeof params.query === "string" ? params.query.trim() : "";
			const unlock = (Array.isArray(params.toolNames) ? params.toolNames : []).filter((n) => typeof n === "string" && n.length > 0);
			const lines: string[] = [];

			if (unlock.length > 0) {
				const state = stateFor(ctx);
				for (const name of unlock) state.unlocked.add(name);
				activate(residentTools(state));
				lines.push(`Unlocked for the next request: ${unlock.join(", ")}`);
			}

			if (query.length === 0 && unlock.length === 0) {
				lines.push("Provide `query` to search the catalog, or `toolNames` to unlock tools.");
			} else if (query.length > 0) {
				try {
					const all = pi.getAllTools();
					const wanted = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
					const matches = all
						.filter((t) => {
							const haystack = `${t.name} ${t.description ?? ""}`.toLowerCase();
							return wanted.every((token) => haystack.includes(token));
						})
						.slice(0, 25);
					if (matches.length === 0) {
						lines.push(`No tools match "${query}".`);
					} else {
						lines.push(`Matching tools (${matches.length}):`);
						for (const t of matches) {
							const desc = (t.description ?? "").split("\n")[0].slice(0, 90);
							lines.push(`- ${t.name}: ${desc}`);
						}
						lines.push('Unlock with dev_tool_search({"toolNames": ["<exact name>"]}).');
					}
				} catch (error) {
					lines.push(`catalog search unavailable: ${String((error as Error)?.message ?? error)}`);
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") || "Nothing to do." }],
				details: { unlocked: unlock },
			};
		},
	});

	// ═════════════════════════════════════════════════════════════════════════
	// skill_search / skill_load — 替代全量技能目录注入 (~9KB 注入会破坏锚定)
	// ═════════════════════════════════════════════════════════════════════════
	const tokens = (text: string) => (text || "").toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);

	pi.registerTool({
		name: "skill_search",
		label: "skill_search",
		description:
			"Search the available skills by keyword and return matching skill names with short descriptions. This session keeps NO skill catalog in the prompt — if a task looks like it matches a skill (document conversion, image processing, PDF, spreadsheets, …), call skill_search FIRST to find it, then skill_load to activate it. Do NOT assume skill names from memory.",
		parameters: Type.Object({
			query: Type.String({ description: 'search keywords (e.g. "pdf", "game review")' }),
		}),
		async execute(toolCallId, params, signal, onUpdate) {
			const wanted = tokens(params.query);
			try {
				const matches = skillsSnapshot
					.filter((s) => {
						const haystack = `${s.name} ${s.description ?? ""}`.toLowerCase();
						return wanted.every((token) => haystack.includes(token));
					})
					.slice(0, 20);
				if (matches.length === 0) {
					return { content: [{ type: "text", text: `No skills match "${params.query}".` }], details: {} };
				}
				const lines = [`Matching skills (${matches.length}):`];
				for (const s of matches) lines.push(`- ${s.name}: ${s.description.split("\n")[0].slice(0, 120)}`);
				lines.push('Activate one with skill_load({"name": "<exact name>"}).');
				return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
			} catch (error) {
				return { content: [{ type: "text", text: `skill search unavailable: ${String((error as Error)?.message ?? error)}` }], details: {} };
			}
		},
	});

	pi.registerTool({
		name: "skill_load",
		label: "skill_load",
		description:
			"Load ONE skill's full instructions by exact name and inject them into the NEXT request. Call only when the skill is actually needed for the current task. Search first with skill_search.",
		parameters: Type.Object({
			name: Type.String({ description: "exact skill name from skill_search results" }),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const skill = skillsSnapshot.find((s) => s.name === params.name);
			if (!skill) {
				return { content: [{ type: "text", text: `Skill "${params.name}" not found. Search with skill_search first.` }], details: {} };
			}
			try {
				const content = readFileSync(skill.filePath, "utf8");
				const idle = ctx?.isIdle?.() ?? false;
				pi.sendMessage(
					{ customType: "skill-load", content: `Skill instructions for ${skill.name}:\n\n${content}`, display: true },
					{ deliverAs: idle ? "nextTurn" : "steer" },
				);
				return {
					content: [{ type: "text", text: `Skill "${skill.name}" loaded; its instructions will be injected into the next request.` }],
					details: {},
				};
			} catch (error) {
				return { content: [{ type: "text", text: `failed to load skill: ${String((error as Error)?.message ?? error)}` }], details: {} };
			}
		},
	});

	// 工具激活全部放在 session_start (工厂执行期间 setActiveTools 会被 pi 守卫拒绝:
	// "Extension runtime not initialized")。
}

// ─────────────────────────────────────────────────────────────────────────────
// Progressive-mode anchor interception / 渐进模式锚定轮拦截（供 dsh-toggle 使用）：
// 将首条真实输入变换为 minimal 目录锚定轮；Pi 启动该轮后才把原消息安全排为 followUp。
// The experiment called this sequence “C2”; that label is retained only for
// compatibility. / 实验曾将该序列记为“C2”；该名称仅为兼容保留。
// ─────────────────────────────────────────────────────────────────────────────

/** Default progressive-mode anchor text / 渐进模式默认锚定轮文案。 */
export const DEFAULT_PROGRESSIVE_ANCHOR_TEXT = "请简单介绍一下你自己，以及你当前可用的工具。";

/**
 * Resolve the progressive anchor text / 获取渐进模式锚定轮文案。
 * DSH_C2_ANCHOR_TEXT remains a backward-compatible fallback.
 * DSH_C2_ANCHOR_TEXT 保留为向后兼容的备用变量。
 */
export function getProgressiveAnchorText(): string {
	return (process.env.DSH_ANCHOR_TEXT ?? process.env.DSH_C2_ANCHOR_TEXT ?? DEFAULT_PROGRESSIVE_ANCHOR_TEXT).trim();
}

/** @deprecated Use getProgressiveAnchorText() / 请改用 getProgressiveAnchorText()。 */
export const C2_ANCHOR_TEXT = getProgressiveAnchorText();

/**
 * Register progressive-mode anchor interception / 注册渐进模式锚定轮拦截。
 * `isEnabled` returning false passes input through; dsh-toggle uses it as its gate.
 * `isEnabled` 返回 false 时放行输入，dsh-toggle 用它作为开关门控。
 * This is mutually exclusive with DSH_ANCHOR_TURN=zero|whoami.
 * 它与 DSH_ANCHOR_TURN=zero|whoami 互斥：非 none 时不注册。
 */
export function registerProgressiveAnchor(pi: ExtensionAPI, isEnabled: () => boolean = () => true) {
	const anchorTurn = (process.env.DSH_ANCHOR_TURN ?? "none").trim().toLowerCase();
	if (anchorTurn !== "none" && anchorTurn !== "") return;

	pi.on("input", (event, ctx) => {
		if (!isEnabled()) return;
		// 只拦用户在 TUI 里真正敲的第一条消息; 扩展注入 / RPC / print 模式不拦
		if (event.source !== "interactive") return;
		// 命令/技能/模板开头的输入不做锚定, 交给 pi 正常展开 (避免破坏 /cmd 语义)
		if (event.text.startsWith("/")) return;
		// 仅全新会话 (无历史 user 消息) 锚定一次
		let fresh = false;
		try {
			const branch = (ctx.sessionManager?.getBranch?.() ?? []) as Array<{
				type: string;
				message?: { role?: string };
			}>;
			fresh = !branch.some((e) => e.type === "message" && e.message?.role === "user");
		} catch {
			fresh = false;
		}
		if (!fresh) return;

		// 1) Anchor turn / 锚定轮：确保 minimal 目录（bootstrap 已是会话默认，显式再设一次防竞态）。
		try {
			pi.setActiveTools(["bash", "str_replace_editor"]);
		} catch {
			/* bootstrap 已生效则无需处理 */
		}

		// 2) Let Pi submit the anchor normally / 让 Pi 正常提交锚定轮：先保存原始任务，
		//    用 transform 让当前输入成为锚定轮。这样不会从一个 input 处理器并发发两条 prompt。
		const state = stateFor(ctx);
		state.pendingAnchorTask = { text: event.text, images: event.images ? [...event.images] : undefined };
		return { action: "transform", text: getProgressiveAnchorText() };
	});

	// 3) Queue only after Pi has started the transformed anchor / 仅在 Pi 已启动变换后的锚定轮后排队。
	// followUp stays behind the complete anchor agent run, including any tool sub-turns.
	pi.on("agent_start", (_event, ctx) => {
		queuePendingAnchorTask(pi, ctx);
	});
}

/** @deprecated Use registerProgressiveAnchor() / 请改用 registerProgressiveAnchor()。 */
export const registerC2Anchor = registerProgressiveAnchor;
