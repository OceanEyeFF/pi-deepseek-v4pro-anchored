/**
 * dsh-minimal.ts — 在 Pi 里复刻 DeepSeek Harness (DSH) 极简模式 (minimal preset) 的初始环境
 *
 * DSH 极简模式 (@deepseek-ai/dsh@0.1.0-rc.6, config/agent-presets/minimal) 的模型初始环境:
 *   1. system prompt 只有一句话: "You are a helpful software engineer assistant."
 *      (persona complete: true — 其它任何 prompt 段都不得追加;
 *       includeRuntimeContext: false — 不注入 cwd/日期等运行时快照)
 *   2. 工具只有两个: 持久 bash (300s 超时, 带 DSH 官方描述) + str_replace_editor (maxOutputChars 16000)
 *   3. cwd = DSH_CWD ?? process.cwd()
 *   4. 没有 todo/plan/web_search/subagent/skill/AGENTS 上下文, 也没有 compaction
 *
 * 本扩展在 Pi 侧的对应实现:
 *   - before_agent_start 里整体替换 systemPrompt  -> 等价于 complete:true + includeRuntimeContext:false
 *     (同时把 Pi 默认的 identity/guidelines/tool snippets/AGENTS.md/skills/环境信息全部清掉)
 *   - setActiveTools(...) -> 只留白名单内的工具
 *   - session_before_compact 取消 threshold/manual 压缩 (保留 overflow 防止上下文溢出炸会话)
 *   - 可选首轮喂料: 环境变量 DSH_MINIMAL_KICKOFF 非空时, 会话启动即自动发送该消息触发第一轮
 *
 * 两个可配置维度 (环境变量, 修改后 /reload 生效):
 *   DSH_MINIMAL_PRESET=dsh|pi
 *     dsh (默认, 忠实复刻): shell + str_replace_editor 双工具
 *        — str_replace_editor 为忠实移植 (view/create/str_replace/insert/undo_edit, 16000 字符裁剪)
 *        — 不用 read: DSH 极简刻意没有独立读文件工具, 看文件只能靠 view (cat -n)
 *     pi  (Pi 原生极简):   shell + edit + read 三工具
 *        — read 优于 view: 支持图片/offset/limit/行范围, 截断与临时文件溢出由 Pi 处理
 *        — edit 优于 str_replace: 一次调用多组替换 + TUI diff 渲染
 *   DSH_MINIMAL_SHELL=bash|pwsh
 *     bash (默认): 匹配 DSH 原版 (DSH minimal 就是 persistent-bash, 不含 pwsh)
 *     pwsh:        用 Pi 的 bash 执行器换成 powershell.exe, 适合纯 Windows 无 git-bash 环境
 *
 * 用法:
 *   pi -e ./dsh-minimal.ts                # 单次测试
 *   # 或复制到 ~/.pi/agent/extensions/dsh-minimal.ts (全局自动加载, 可 /reload 热更新)
 *
 * 配套 settings.json 建议 (可选, 双保险关闭压缩):
 *   { "compaction": { "enabled": false } }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Persona — DSH minimal preset 的唯一 system prompt (逐字)
// ─────────────────────────────────────────────────────────────────────────────
const PERSONA = "You are a helpful software engineer assistant.";

// ─────────────────────────────────────────────────────────────────────────────
// 2. bash — DSH persistent-bash 的官方描述 (逐字, 见 agent.cordis.yml)
//    注意: 第 3/4 行 (apt/pip 镜像、状态持久) 是 DSH 环境承诺, 若本机不满足请自行改写。
//    本扩展对"状态持久"做了 cd 跟踪的近似实现 (见下)。
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// 2b. pwsh — 同构的 PowerShell 描述 (bash 版本的本机适配)
// ─────────────────────────────────────────────────────────────────────────────
const PWSH_DESCRIPTION = [
	"Run commands in a PowerShell shell",
	'* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
	"* You don't have access to the internet via this tool.",
	"* State is persistent across command calls and discussions with the user (the current directory is preserved across calls).",
	"* To inspect a particular line range of a file, e.g. lines 10-25, try 'Get-Content /path/to/the/file | Select-Object -Skip 9 -First 16'.",
	"* Please avoid commands that may produce a very large amount of output.",
	"* Please run long lived commands in the background, e.g. 'Start-Job { ... }' or start a server in the background.",
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// 3. str_replace_editor — DSH 官方描述与常量 (逐字)
// ─────────────────────────────────────────────────────────────────────────────
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
// 会话级状态 (session_start 时重置; DSH 的"跨讨论持久"这里简化为会话内)
// ─────────────────────────────────────────────────────────────────────────────
let bashCwd: string | undefined; // cd 跟踪: 近似持久 bash 的 cwd
let pwshCwd: string | undefined; // Set-Location 跟踪: 近似持久 pwsh 的 cwd
const undoHistory = new Map<string, string[]>(); // str_replace_editor 撤销栈

function maybeTruncate(content: string): string {
	return content.length <= MAX_OUTPUT_CHARS ? content : content.slice(0, MAX_OUTPUT_CHARS) + TRUNCATED_MESSAGE;
}

function bashQuote(path: string): string {
	return `'${path.replace(/'/g, `'\\''`)}'`;
}

function pwshQuote(path: string): string {
	return `'${path.replace(/'/g, "''")}'`;
}

/** bash: 取命令中最后一个位于命令边界 (行首 / 分号 / &&) 的 cd 目标。 */
function lastBashCdTarget(command: string): string | undefined {
	const re = /(?:^|[\n;&]\s*|&&\s*)cd\s+("[^"]*"|'[^']*'|\S+)/g;
	let target: string | undefined;
	let m: RegExpExecArray | null;
	while ((m = re.exec(command)) !== null) {
		target = m[1].replace(/^["']|["']$/g, "");
	}
	return target;
}

/** pwsh: 取命令中最后一个位于语句边界 (行首 / 分号 / &&) 的 cd|Set-Location|sl 目标。 */
function lastPwshCdTarget(command: string): string | undefined {
	const re = /(?:^|[\n;]|&&)\s*(?:cd|Set-Location|sl)\s+('[^']*'|"[^"]*"|\S+)/gi;
	let target: string | undefined;
	let m: RegExpExecArray | null;
	while ((m = re.exec(command)) !== null) {
		target = m[1].replace(/^['"]|['"]$/g, "").replace(/''/g, "'");
	}
	return target;
}

/** 解析 powershell 的绝对路径 (Pi 的 shellPath 必须是已存在的绝对路径)。 */
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
		"dsh-minimal: PowerShell not found. Install PowerShell 7 (winget install Microsoft.PowerShell) or use DSH_MINIMAL_SHELL=bash with Git Bash.",
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
	// —— 预设与环境 (工厂每次执行时读取; 改环境变量后 /reload 即生效) ——
	const PRESET = (process.env.DSH_MINIMAL_PRESET ?? "dsh").trim().toLowerCase() || "dsh";
	const SHELL = (process.env.DSH_MINIMAL_SHELL ?? "bash").trim().toLowerCase() || "bash";
	const FAITHFUL = PRESET === "dsh"; // dsh = 忠实复刻; pi = Pi 原生极简
	const SHELL_TOOL_NAME = SHELL === "pwsh" ? "pwsh" : "bash";
	const ACTIVE_TOOLS = FAITHFUL ? [SHELL_TOOL_NAME, "str_replace_editor"] : [SHELL_TOOL_NAME, "edit", "read"];
	const DSH_TIMEOUT_SECONDS = 300; // DSH minimal: timeoutMs 300000

	const ACTIVATE = () => pi.setActiveTools(ACTIVE_TOOLS);

	// —— system prompt 整体替换: 等价 persona complete:true + includeRuntimeContext:false ——
	pi.on("before_agent_start", () => ({ systemPrompt: PERSONA }));

	// —— 会话生命周期 ——
	pi.on("session_start", (event) => {
		bashCwd = undefined;
		pwshCwd = undefined;
		undoHistory.clear();
		ACTIVATE();
		if (event.reason === "startup" || event.reason === "new") {
			// DSH minimal 原版不注入首轮消息; 需要自动喂料时设置 DSH_MINIMAL_KICKOFF
			const kickoff = process.env.DSH_MINIMAL_KICKOFF;
			if (kickoff && kickoff.trim().length > 0) {
				pi.sendUserMessage(kickoff); // 发送真实用户消息并触发首轮
			}
		}
	});

	// —— compaction 缺席: 取消手动/阈值压缩, 保留 overflow (防上下文溢出直接失败) ——
	pi.on("session_before_compact", (event) => {
		if (event.reason === "manual" || event.reason === "threshold") return { cancel: true };
	});

	// ═════════════════════════════════════════════════════════════════════════
	// shell 工具
	// ═════════════════════════════════════════════════════════════════════════
	// 忠实复刻时重注册 bash (DSH 官方描述 + cd 跟踪 + 300s 默认超时);
	// pi 预设下 bash 用 Pi 内置原样 (原生描述/行为, 无默认超时)。
	const bashCache = new Map<string, ReturnType<typeof createBashTool>>();
	const getBash = (cwd: string) => {
		let tool = bashCache.get(cwd);
		if (!tool) {
			tool = createBashTool(cwd);
			bashCache.set(cwd, tool);
		}
		return tool;
	};

	if (FAITHFUL && SHELL_TOOL_NAME === "bash") {
		pi.registerTool({
			name: "bash",
			label: "bash",
			description: BASH_DESCRIPTION,
			parameters: getBash(process.cwd()).parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const command = String(params.command ?? "");
				// 持久 cwd: 每次调用先 cd 回上次记录的目录 (近似 PTY 持久状态)
				const prefixed = bashCwd !== undefined ? `cd ${bashQuote(bashCwd)} && ${command}` : command;
				const result = await getBash(ctx.cwd).execute(
					toolCallId,
					{ ...params, command: prefixed, timeout: params.timeout ?? DSH_TIMEOUT_SECONDS },
					signal,
					onUpdate,
				);
				// 解析本次命令里的 cd, 更新持久目录
				const cdTarget = lastBashCdTarget(command);
				if (cdTarget !== undefined) {
					const base = bashCwd ?? ctx.cwd;
					bashCwd = isAbsolute(cdTarget) ? cdTarget : resolve(base, cdTarget);
				}
				return result;
			},
		});
	}

	if (SHELL_TOOL_NAME === "pwsh") {
		// 复用 Pi 的 bash 执行器 (截断/进程树清理/流式输出), 仅换 shell 为 powershell
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
				if (cdTarget !== undefined) {
					const base = pwshCwd ?? ctx.cwd;
					pwshCwd = isAbsolute(cdTarget) ? cdTarget : resolve(base, cdTarget);
				}
				return result;
			},
		});
	}

	// ═════════════════════════════════════════════════════════════════════════
	// str_replace_editor (仅忠实复刻预设)
	// ═════════════════════════════════════════════════════════════════════════
	if (FAITHFUL) {
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
	}

	// 工具激活全部放在 session_start (工厂执行期间 setActiveTools 会被 pi 守卫拒绝:
	// "Extension runtime not initialized")。
}
