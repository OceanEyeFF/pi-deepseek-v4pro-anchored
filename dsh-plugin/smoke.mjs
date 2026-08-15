// 冒烟测试: 用 pi 的 jiti 加载 dsh-minimal.ts, mock ExtensionAPI, 验证工厂与工具逻辑
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(join(PLUGIN_DIR, "smoke-entry.js"), { interopDefault: true });

const EXT = join(PLUGIN_DIR, "dsh-minimal.ts");
const mod = await jiti.import(EXT);
const factory = mod.default;
if (typeof factory !== "function") throw new Error("no default factory");

// assert 失败即抛错, 保证测试有真实退出码
console.assert = (cond, ...msg) => {
	if (!cond) {
		console.error("ASSERTION FAILED:", ...msg);
		throw new Error("smoke test failed");
	}
};

// 每个变体: 独立 mock pi + 环境变量, 调用工厂 (工厂每次执行时读取 env)
function loadVariant(env) {
	for (const k of Object.keys(process.env)) if (k.startsWith("DSH_MINIMAL_")) delete process.env[k];
	Object.assign(process.env, env);
	const handlers = {};
	const tools = {};
	let active = [];
	const sent = [];
	const pi = {
		on(ev, h) { (handlers[ev] ??= []).push(h); },
		registerTool(def) { tools[def.name] = def; },
		setActiveTools(names) { active.length = 0; active.push(...names); },
		sendUserMessage(msg, opts) { sent.push({ msg, opts }); },
	};
	factory(pi);
	return { handlers, tools, active, sent, pi };
}

// ── 1. 四种预设组合: 工具白名单 (工厂期不激活, session_start 后生效) ──
const v1 = loadVariant({});
console.assert(v1.active.length === 0, "factory-time: no activation (pi guard)");
v1.handlers.session_start[0]({ reason: "startup" });
console.assert(JSON.stringify(v1.active) === JSON.stringify(["bash", "str_replace_editor"]), "dsh+bash:", v1.active);
const v2 = loadVariant({ DSH_MINIMAL_PRESET: "pi" });
v2.handlers.session_start[0]({ reason: "startup" });
console.assert(JSON.stringify(v2.active) === JSON.stringify(["bash", "edit", "read"]), "pi+bash:", v2.active);
const v3 = loadVariant({ DSH_MINIMAL_SHELL: "pwsh" });
v3.handlers.session_start[0]({ reason: "startup" });
console.assert(JSON.stringify(v3.active) === JSON.stringify(["pwsh", "str_replace_editor"]), "dsh+pwsh:", v3.active);
const v4 = loadVariant({ DSH_MINIMAL_PRESET: "pi", DSH_MINIMAL_SHELL: "pwsh" });
v4.handlers.session_start[0]({ reason: "startup" });
console.assert(JSON.stringify(v4.active) === JSON.stringify(["pwsh", "edit", "read"]), "pi+pwsh:", v4.active);

// pi 预设下 bash 应保持内置 (未被重注册)
console.assert(v2.tools.bash === undefined && v2.tools.str_replace_editor === undefined, "pi preset: no overrides");
// dsh 预设下 str_replace_editor 已注册; pwsh 变体注册 pwsh
console.assert(v1.tools.bash && v1.tools.str_replace_editor, "dsh+bash: both registered");
console.assert(v3.tools.pwsh && v3.tools.str_replace_editor && v3.tools.bash === undefined, "dsh+pwsh: pwsh+editor");

// ── 2. before_agent_start → 整体替换 system prompt (各预设一致) ──
for (const v of [v1, v2, v3, v4]) {
	const r = v.handlers.before_agent_start.map((h) => h({ prompt: "x", systemPrompt: "LONG DEFAULT", systemPromptOptions: {} }))[0];
	console.assert(r?.systemPrompt === "You are a helpful software engineer assistant.", "persona replaced");
}

// ── 3. compaction: manual/threshold 取消, overflow 放行 ──
const w1 = v1.handlers.session_before_compact.map((h) => h({ reason: "manual" }))[0];
const c2 = v1.handlers.session_before_compact.map((h) => h({ reason: "threshold" }))[0];
const w3 = v1.handlers.session_before_compact.map((h) => h({ reason: "overflow" }))[0];
console.assert(w1?.cancel === true && c2?.cancel === true && w3 === undefined, "compaction policy");

// ── 4. session_start: 重置 + 激活 + kickoff ──
const vk = loadVariant({ DSH_MINIMAL_KICKOFF: "请检查当前目录" });
vk.handlers.session_start?.[0]({ reason: "startup" });
console.assert(vk.sent.length === 1 && vk.sent[0].msg === "请检查当前目录", "kickoff sent");
console.assert(JSON.stringify(vk.active) === JSON.stringify(["bash", "str_replace_editor"]), "tools after session_start");
// resume 不重发 kickoff
vk.handlers.session_start?.[0]({ reason: "resume" });
console.assert(vk.sent.length === 1, "kickoff not resent on resume");

// ── 5. str_replace_editor 全命令真实验证 (临时目录) ──
const work = mkdtempSync(join(tmpdir(), "dsh-min-"));
const editor = v1.tools.str_replace_editor;
const exe = (p) => editor.execute("t1", p, undefined, undefined, { cwd: work, signal: undefined });
const txt = (r) => r.content.find((c) => c.type === "text")?.text ?? "";

await exe({ command: "create", path: "a.txt", file_text: "line1\nline2\nline3" });
console.assert(readFileSync(join(work, "a.txt"), "utf8") === "line1\nline2\nline3", "create ok");
let threw = false; try { await exe({ command: "create", path: "a.txt", file_text: "x" }); } catch { threw = true; }
console.assert(threw, "create refuses existing file");

const q2 = await exe({ command: "view", path: "a.txt" });
console.assert(q2.content[0].text.includes("1  line1") && q2.content[0].text.includes("total of 3 lines"), "view numbering ok");
const q3 = await exe({ command: "view", path: "a.txt", view_range: [2, -1] });
console.assert(q3.content[0].text.includes("2  line2") && !q3.content[0].text.includes("1  line1"), "view_range ok");

await exe({ command: "str_replace", path: "a.txt", old_str: "line2", new_str: "LINE2" });
console.assert(readFileSync(join(work, "a.txt"), "utf8") === "line1\nLINE2\nline3", "str_replace ok");
threw = false; try { await exe({ command: "str_replace", path: "a.txt", old_str: "line", new_str: "x" }); } catch { threw = true; }
console.assert(threw, "str_replace not-unique throws");
threw = false; try { await exe({ command: "str_replace", path: "a.txt", old_str: "nope", new_str: "x" }); } catch { threw = true; }
console.assert(threw, "str_replace not-found throws");

await exe({ command: "insert", path: "a.txt", insert_line: 0, new_str: "line0" });
console.assert(readFileSync(join(work, "a.txt"), "utf8").startsWith("line0\nline1"), "insert@0 ok");
threw = false; try { await exe({ command: "insert", path: "a.txt", insert_line: 999, new_str: "x" }); } catch { threw = true; }
console.assert(threw, "insert out-of-range throws");

await exe({ command: "undo_edit", path: "a.txt" });
console.assert(readFileSync(join(work, "a.txt"), "utf8").startsWith("line1\nLINE2"), "undo ok");
threw = false; try { await exe({ command: "undo_edit", path: "nope.txt" }); } catch { threw = true; }
console.assert(threw, "undo without history throws");

mkdirSync(join(work, "sub", "deep"), { recursive: true });
writeFileSync(join(work, "sub", "b.txt"), "b");
writeFileSync(join(work, "sub", ".hidden"), "h");
writeFileSync(join(work, "sub", "node_modules"), "n");
const r5 = await exe({ command: "view", path: "." });
const listingBody = txt(r5).split(":\n").slice(1).join("");
console.assert(listingBody.includes("d\t") && listingBody.includes("b.txt"), "dir listing ok");
console.assert(!listingBody.includes(".hidden") && !listingBody.includes("\tnode_modules"), "dir filters ok");
threw = false; try { await exe({ command: "view", path: ".", view_range: [1, 2] }); } catch { threw = true; }
console.assert(threw, "view_range on dir throws");

// ── 6. bash 覆盖: cd 跟踪 (真实 shell) ──
const bash = v1.tools.bash;
const bctx = { cwd: work, signal: undefined };
const b1 = await bash.execute("t2", { command: "cd sub && pwd" }, undefined, undefined, bctx);
console.assert(b1.content[0].text.includes("sub"), "bash cd+pwd:", b1.content[0].text.slice(0, 80));
const b2 = await bash.execute("t3", { command: "pwd" }, undefined, undefined, bctx);
console.assert(b2.content[0].text.includes("sub"), "bash persistent cwd:", b2.content[0].text.slice(0, 80));

// ── 7. pwsh 工具: 真实 powershell 执行 + Set-Location 跟踪 ──
const pwsh = v3.tools.pwsh;
const pctx = { cwd: work, signal: undefined };
const p1 = await pwsh.execute("t4", { command: "New-Item -ItemType Directory -Force sub | Out-Null; Set-Location sub; (Get-Location).Path" }, undefined, undefined, pctx);
console.assert(p1.content[0].text.includes("sub"), "pwsh Set-Location:", p1.content[0].text.slice(0, 100));
const p2 = await pwsh.execute("t5", { command: "(Get-Location).Path" }, undefined, undefined, pctx);
console.assert(p2.content[0].text.includes("sub"), "pwsh persistent cwd:", p2.content[0].text.slice(0, 100));
const p3 = await pwsh.execute("t6", { command: "sl ..; (Get-Location).Path" }, undefined, undefined, pctx);
console.assert(!p3.content[0].text.split(/[\\/]/).pop().includes("sub"), "pwsh sl alias tracking:", p3.content[0].text.slice(0, 100));

rmSync(work, { recursive: true, force: true });

// ── 8. dsh-anchored: 阶段机/晋升/压缩纪元/解锁/锚定轮 ──
const anchoredMod = await jiti.import(join(PLUGIN_DIR, "dsh-anchored.ts"));
const anchoredFactory = anchoredMod.default;
const { setAnchoredEnabled } = anchoredMod;

function loadAnchored(env) {
	for (const k of Object.keys(process.env)) if (k.startsWith("DSH_ANCHOR_") || k.startsWith("DSH_MINIMAL_")) delete process.env[k];
	Object.assign(process.env, env);
	setAnchoredEnabled(true); // 门控归一化 (toggle 测试会改它)
	const handlers = {};
	const tools = {};
	let active = [];
	const sent = [];
	const pi = {
		on(ev, h) { (handlers[ev] ??= []).push(h); },
		registerTool(def) { tools[def.name] = def; },
		setActiveTools(names) { active.length = 0; active.push(...names); },
		sendUserMessage(msg, opts) { sent.push({ kind: "user", msg, opts }); },
		sendMessage(msg, opts) { sent.push({ kind: "custom", msg, opts }); },
		getActiveTools() { return [...active]; },
		getAllTools() { return Object.entries(tools).map(([name, d]) => ({ name, description: d.description })); },
	};
	anchoredFactory(pi);
	return { handlers, tools, active, sent, pi };
}

const sm = (branch = []) => ({ getSessionId: () => "s1", getBranch: () => branch });
const ectx = (branch = []) => ({ sessionManager: sm(branch), isIdle: () => false });

// 8a. 默认: 工厂期不激活; 会话启动扫描后 = bootstrap 对
const a1 = loadAnchored({});
console.assert(a1.active.length === 0, "anchored factory-time: no activation");
a1.handlers.session_start[0]({ reason: "startup" }, ectx([]));
console.assert(JSON.stringify(a1.active) === JSON.stringify(["bash", "str_replace_editor"]), "anchored bootstrap:", a1.active);
a1.handlers.session_start[0]({ reason: "startup" }, ectx([]));
console.assert(JSON.stringify(a1.active) === JSON.stringify(["bash", "str_replace_editor"]), "anchored after scan:", a1.active);

// 8b. persona 替换 + 技能/上下文快照
const skillWork = mkdtempSync(join(tmpdir(), "dsh-skill-"));
const skillFile = join(skillWork, "SKILL.md");
writeFileSync(skillFile, "# PDF skill body");
const bea2 = a1.handlers.before_agent_start[0]({
	prompt: "x",
	systemPrompt: "LONG",
	systemPromptOptions: {
		skills: [{ name: "pdf-tool", description: "PDF conversion", filePath: skillFile }],
		contextFiles: [{ path: "C:/proj/AGENTS.md", content: "# Rules" }],
	},
});
console.assert(bea2.systemPrompt === "You are a helpful software engineer assistant.", "anchored persona");

// 8c. tool_call
// 8c. tool_call 晋升 (either): 驻留集 = bootstrap + 发现工具; 注入 instruction-hint 一次
a1.handlers.tool_execution_start[0]({ toolName: "bash" }, ectx([]));
const resident = ["bash", "str_replace_editor", "dev_tool_search", "skill_search", "skill_load"];
console.assert(JSON.stringify(a1.active) === JSON.stringify(resident), "anchored promoted:", a1.active);
console.assert(a1.sent.length === 1 && a1.sent[0].msg.customType === "instruction-hint" && a1.sent[0].msg.content.includes("AGENTS.md") && a1.sent[0].msg.content.includes("更新通告") && a1.sent[0].msg.content.includes("dev_tool_search"), "promotion hint (tools+instructions) sent once");
a1.handlers.tool_execution_start[0]({ toolName: "bash" }, ectx([]));
console.assert(a1.sent.length === 1, "hint not re-sent");

// 8d. dev_tool_search 解锁 read → 驻留集包含 read; details.unlocked 持久化
a1.handlers.session_start[0]({ reason: "startup" }, ectx([
	{ type: "message", id: "m1", message: { role: "user", content: [] } },
	{ type: "message", id: "m2", message: { role: "assistant", content: [] } },
]));
const dt = a1.tools.dev_tool_search;
const dr = await dt.execute("t7", { toolNames: ["read"] }, undefined, undefined, ectx([]));
console.assert(dr.details.unlocked.includes("read") && a1.active.includes("read"), "dev_tool_search unlock");
const dq = await dt.execute("t8", { query: "editor" }, undefined, undefined, ectx([]));
console.assert(dq.content[0].text.includes("str_replace_editor"), "dev_tool_search query");

// 8e. 压缩纪元: 回退 bootstrap+工作集; 新晋升信号再晋升 (unlocked 保留)
a1.handlers.session_compact[0]({ compactionEntry: { id: "c9" } }, ectx([]));
console.assert(!a1.active.includes("dev_tool_search") && a1.active.includes("find") && a1.active.includes("str_replace_editor"), "post-compaction set:", a1.active);
a1.handlers.turn_end[0]({ message: { role: "assistant" } }, ectx([]));
console.assert(a1.active.includes("read") && a1.active.includes("dev_tool_search"), "re-promoted with unlocks:", a1.active);

// 8f. 持久扫描: 有 assistant/toolResult → promoted; compaction 条目后 → 未晋升; hinted 恢复
a1.handlers.session_start[0]({ reason: "resume" }, ectx([
	{ type: "message", id: "m1", message: { role: "user", content: [] } },
	{ type: "message", id: "m2", message: { role: "assistant", content: [] } },
	{ type: "compaction", id: "c9" },
	{ type: "message", id: "m3", message: { role: "user", content: [] } },
]));
console.assert(a1.active.includes("find") && !a1.active.includes("dev_tool_search"), "scan: post-compaction unpromoted:", a1.active);
const a2 = loadAnchored({});
a2.handlers.session_start[0]({ reason: "resume" }, ectx([
	{ type: "message", id: "m1", message: { role: "user", content: [] } },
	{ type: "message", id: "m2", message: { role: "assistant", content: [] } },
	{ type: "message", id: "m3", message: { role: "toolResult", toolName: "dev_tool_search", details: { unlocked: ["web_search"] } } },
	{ type: "message", id: "m4", message: { role: "custom", customType: "instruction-hint", content: "hint" } },
]));
console.assert(a2.active.includes("web_search") && a2.active.includes("dev_tool_search"), "scan: promoted+unlocked+hinted");

// 8g. promoteOn=tool-call: turn_end 不晋升
const a3 = loadAnchored({ DSH_ANCHOR_PROMOTE_ON: "tool-call" });
a3.handlers.session_start[0]({ reason: "startup" }, ectx([]));
a3.handlers.turn_end[0]({ message: { role: "assistant" } }, ectx([]));
console.assert(JSON.stringify(a3.active) === JSON.stringify(["bash", "str_replace_editor"]), "promoteOn=tool-call: turn_end no-op");
a3.handlers.tool_execution_start[0]({ toolName: "bash" }, ectx([]));
console.assert(a3.active.includes("dev_tool_search"), "promoteOn=tool-call: tool promotes");

// 8h. zero 锚定轮: 变换首条输入；agent_start 后才安全 followUp 真实任务
const a4 = loadAnchored({ DSH_ANCHOR_TURN: "zero" });
const inp = a4.handlers.input[0];
const rIn = inp({ text: "做任务", source: "interactive", images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "AAA" } }] }, ectx([]));
console.assert(rIn?.action === "transform" && rIn.text === "This round is a test. Tools are not open yet; all tools will open next round." && rIn.images?.length === 0 && a4.active.length === 0, "anchor: transform + zero tools");
console.assert(a4.sent.length === 0, "anchor: no competing prompt is sent during input");
a4.handlers.agent_start[0]({}, ectx([]));
console.assert(a4.sent.length === 1 && a4.sent[0].opts?.deliverAs === "followUp" && a4.sent[0].msg[0].text === "做任务" && a4.sent[0].msg[1].type === "image", "anchor: real task queued after agent start");
const rIn2 = inp({ text: "二次消息", source: "interactive" }, ectx([
	{ type: "message", id: "m1", message: { role: "user", content: [] } },
]));
console.assert(rIn2 === undefined && a4.sent.length === 1, "anchor: non-fresh session untouched");

// 8i. skill_search / skill_load
const sk = a1.tools.skill_search;
const sr = await sk.execute("t9", { query: "pdf" }, undefined, undefined);
console.assert(sr.content[0].text.includes("pdf-tool"), "skill_search match");
const sl = a1.tools.skill_load;
const slr = await sl.execute("t10", { name: "pdf-tool" }, undefined, undefined, ectx([]));
console.assert(slr.content[0].text.includes("loaded") && a1.sent.some((s) => s.msg.customType === "skill-load"), "skill_load injects");
const slMiss = await sl.execute("t11", { name: "nope" }, undefined, undefined, ectx([]));
console.assert(slMiss.content[0].text.includes("not found"), "skill_load miss");

// 8j. bash 覆盖与编辑器存在 (Minimal schema)
console.assert(a1.tools.bash?.description.includes("Run commands in a bash shell") && a1.tools.str_replace_editor, "anchored minimal schema");

// 8k. DSH_ANCHOR_PROMOTE_HINT=0: 无上下文文件时晋升不发任何提示
const a5 = loadAnchored({ DSH_ANCHOR_PROMOTE_HINT: "0" });
a5.handlers.session_start[0]({ reason: "startup" }, ectx([]));
a5.handlers.before_agent_start[0]({ prompt: "x", systemPrompt: "L", systemPromptOptions: { skills: [], contextFiles: [] } });
a5.handlers.tool_execution_start[0]({ toolName: "bash" }, ectx([]));
console.assert(a5.sent.length === 0 && a5.active.includes("dev_tool_search"), "promote-hint off: no message, tools still promoted");

rmSync(skillWork, { recursive: true, force: true });

// ── 9. dsh-c2: legacy C2 experiment preset / 旧版 C2 实验预设 ──
const c2Mod = await jiti.import(join(PLUGIN_DIR, "dsh-c2.ts"));
const c2Factory = c2Mod.default;

function loadC2(env) {
	for (const k of Object.keys(process.env)) if (k.startsWith("DSH_ANCHOR_") || k.startsWith("DSH_MINIMAL_") || k.startsWith("DSH_C2_")) delete process.env[k];
	Object.assign(process.env, env);
	setAnchoredEnabled(true); // 门控归一化
	const handlers = {};
	const tools = {};
	let active = [];
	const sent = [];
	const pi = {
		on(ev, h) { (handlers[ev] ??= []).push(h); },
		registerTool(def) { tools[def.name] = def; },
		setActiveTools(names) { active.length = 0; active.push(...names); },
		sendUserMessage(msg, opts) { sent.push({ kind: "user", msg, opts }); },
		sendMessage(msg, opts) { sent.push({ kind: "custom", msg, opts }); },
		getAllTools() { return Object.entries(tools).map(([name, d]) => ({ name, description: d.description })); },
	};
	c2Factory(pi);
	return { handlers, tools, active, sent, pi };
}

// 9a. 静默晋升 / silent promotion：工厂强制 PROMOTE_HINT=0，晋升后不发任何消息
const zc1 = loadC2({});
console.assert(process.env.DSH_ANCHOR_PROMOTE_HINT === "0", "c2 forces silent promotion");
console.assert(zc1.tools.bash && zc1.tools.str_replace_editor && zc1.tools.dev_tool_search && zc1.tools.skill_search && zc1.tools.skill_load, "c2 mounts anchored mechanisms");
zc1.handlers.session_start[0]({ reason: "startup" }, ectx([]));
console.assert(JSON.stringify(zc1.active) === JSON.stringify(["bash", "str_replace_editor"]), "c2 bootstrap tools");
zc1.handlers.before_agent_start[0]({ prompt: "x", systemPrompt: "L", systemPromptOptions: { skills: [], contextFiles: [] } });
zc1.handlers.turn_end[0]({ message: { role: "assistant" } }, ectx([]));
console.assert(zc1.active.includes("dev_tool_search") && zc1.sent.length === 0, "c2 silent promotion: resident set, no message");

// 9b. 锚定轮拦截 / anchor interception: interactive + fresh → transform + agent_start followUp
const zc2 = loadC2({});
const zinp = zc2.handlers.input[0];
const zq1 = zinp({ text: "做任务", source: "interactive", images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "AAA" } }] }, ectx([]));
console.assert(zq1?.action === "transform" && zq1.text.includes("介绍一下你自己") && zq1.images?.length === 0 && zc2.sent.length === 0, "c2 anchor transform");
console.assert(JSON.stringify(zc2.active) === JSON.stringify(["bash", "str_replace_editor"]), "c2 anchor keeps minimal catalog");
zc2.handlers.agent_start[0]({}, ectx([]));
console.assert(zc2.sent.length === 1 && zc2.sent[0].opts?.deliverAs === "followUp" && zc2.sent[0].msg[0].text === "做任务" && zc2.sent[0].msg[1].type === "image", "c2 followUp with images");

// 9b-1. 新名称 DSH_ANCHOR_TEXT 优先；旧名称继续可用
const zcText = loadC2({ DSH_ANCHOR_TEXT: "渐进模式锚定文案" });
const zcTextInput = zcText.handlers.input[0]({ text: "做任务", source: "interactive" }, ectx([]));
console.assert(zcTextInput?.action === "transform" && zcTextInput.text === "渐进模式锚定文案", "progressive anchor text");
const zcLegacyText = loadC2({ DSH_C2_ANCHOR_TEXT: "legacy anchor text" });
const zcLegacyTextInput = zcLegacyText.handlers.input[0]({ text: "做任务", source: "interactive" }, ectx([]));
console.assert(zcLegacyTextInput?.action === "transform" && zcLegacyTextInput.text === "legacy anchor text", "legacy C2 anchor text alias");

// 9c. 非 fresh / rpc / 斜杠命令 → 不锚定
const zq2 = zinp({ text: "第二条", source: "interactive" }, ectx([
	{ type: "message", id: "m1", message: { role: "user", content: [] } },
]));
console.assert(zq2 === undefined && zc2.sent.length === 1, "c2 non-fresh untouched");
const zq3 = zinp({ text: "任务", source: "rpc" }, ectx([]));
console.assert(zq3 === undefined && zc2.sent.length === 1, "c2 rpc untouched");
const zq4 = zinp({ text: "/skill:foo", source: "interactive" }, ectx([]));
console.assert(zq4 === undefined && zc2.sent.length === 1, "c2 slash command untouched");

// 9d. DSH_ANCHOR_TURN=zero 时 c2 让步 (不注册 input 拦截)
const zc3 = loadC2({ DSH_ANCHOR_TURN: "zero" });
console.assert((zc3.handlers.input ?? []).length === 1, "c2 yields to zero/whoami anchor turn (anchored only):", zc3.handlers.input?.length);

console.log("\nALL SMOKE TESTS PASSED");

// ── 10. dsh-toggle: {关闭 / Off, 渐进 / Progressive} 切换（需与 anchored 并排加载）──
const toggleMod = await jiti.import(join(PLUGIN_DIR, "dsh-toggle.ts"));
const toggleFactory = toggleMod.default;

function loadToggle(env) {
	for (const k of Object.keys(process.env)) if (k.startsWith("DSH_")) delete process.env[k];
	Object.assign(process.env, env);
	const handlers = {};
	const tools = {};
	const commands = {};
	let active = [];
	const sent = [];
	const notified = [];
	const pi = {
		on(ev, h) { (handlers[ev] ??= []).push(h); },
		registerTool(def) { tools[def.name] = def; },
		registerCommand(name, def) { commands[name] = def; },
		setActiveTools(names) { active.length = 0; active.push(...names); },
		sendUserMessage(msg, opts) { sent.push({ kind: "user", msg, opts }); },
		sendMessage(msg, opts) { sent.push({ kind: "custom", msg, opts }); },
		getActiveTools() { return [...active]; },
		getAllTools() { return Object.entries(tools).map(([name, d]) => ({ name, description: d.description })); },
	};
	anchoredFactory(pi); // 模拟 dsh-anchored.ts 并排自动加载 (机制注册)
	toggleFactory(pi); // 开关门控 + 命令
	return { handlers, tools, commands, active, sent, notified, pi };
}

// 10a. 默认关: 门控生效, 机制全静默; 命令已注册
const tctx = (branch = []) => ({ sessionManager: { getSessionId: () => "s10", getBranch: () => branch }, isIdle: () => false });

const t1 = loadToggle({});
console.assert(t1.commands["dsh-mode"] && t1.commands["dsh"] && t1.commands["dsh-status"], "toggle commands registered");
console.assert(t1.commands["dsh-mode"].description.includes("渐进") && t1.commands["dsh-mode"].description.includes("Progressive"), "bilingual progressive command description");
t1.handlers.session_start[0]({ reason: "startup" }, tctx([]));
console.assert(t1.active.length === 0, "off: session_start no-op");
const offB = t1.handlers.before_agent_start[0]({ prompt: "x", systemPrompt: "L", systemPromptOptions: { skills: [], contextFiles: [] } });
console.assert(offB === undefined, "off: persona untouched");
t1.handlers.tool_execution_start[0]({ toolName: "bash" }, tctx([]));
console.assert(t1.active.length === 0, "off: no promotion");
const offIn = t1.handlers.input[0]({ text: "任务", source: "interactive" }, tctx([]));
console.assert(offIn === undefined && t1.sent.length === 0, "off: no anchor");

// 10b. 切 progressive：锚定轮 + persona 替换生效
await t1.commands["dsh-mode"].handler("progressive", { ui: { notify: (m) => t1.notified.push(m) } });
console.assert(t1.notified.at(-1).includes("渐进") && t1.notified.at(-1).includes("Progressive"), "notify progressive");
const onIn = t1.handlers.input[0]({ text: "任务", source: "interactive" }, tctx([]));
console.assert(onIn?.action === "transform" && onIn.text.includes("介绍一下你自己") && t1.sent.length === 0, "progressive: anchor transform");
t1.handlers.agent_start[0]({}, tctx([]));
console.assert(t1.sent.length === 1 && t1.sent[0].opts?.deliverAs === "followUp" && t1.sent[0].msg === "任务", "progressive: original task safely queued");
const onB = t1.handlers.before_agent_start[0]({ prompt: "x", systemPrompt: "L", systemPromptOptions: { skills: [], contextFiles: [] } });
console.assert(onB?.systemPrompt === "You are a helpful software engineer assistant.", "progressive: persona active");
t1.handlers.turn_end[0]({ message: { role: "assistant" } }, tctx([]));
console.assert(t1.active.includes("dev_tool_search") && t1.sent.length === 1, "progressive: silent promotion (no extra messages)");

// 10b-1. /dsh-status reports the real controlled phase and active catalog
await t1.commands["dsh-status"].handler("", { ...tctx([]), ui: { notify: (m) => t1.notified.push(m) } });
console.assert(t1.notified.at(-1).includes("promoted") && t1.notified.at(-1).includes("dev_tool_search"), "dsh-status reports phase and tools");

// 10c. 切 off: 恢复全部工具, persona 回到原生
await t1.commands["dsh"].handler("off", { ui: { notify: (m) => t1.notified.push(m) } });
console.assert(t1.active.length === Object.keys(t1.tools).length && t1.active.includes("dev_tool_search"), "off: tools restored");
const offB2 = t1.handlers.before_agent_start[0]({ prompt: "x", systemPrompt: "L", systemPromptOptions: { skills: [], contextFiles: [] } });
console.assert(offB2 === undefined, "off again: persona untouched");

// 10d. c2 is a legacy alias for progressive / c2 是渐进模式的旧版别名
await t1.commands["dsh"].handler("c2", { ui: { notify: (m) => t1.notified.push(m) } });
console.assert(t1.notified.at(-1).includes("渐进") && t1.notified.at(-1).includes("Progressive"), "legacy c2 alias");

// 10e. 无参查询
await t1.commands["dsh-mode"].handler("", { ui: { notify: (m) => t1.notified.push(m) } });
console.assert(t1.notified.at(-1).includes("当前 DSH 模式") && t1.notified.at(-1).includes("Current DSH mode"), "bilingual status query");

// 10f. DSH_MODE=progressive 环境变量：启动即渐进模式
const t2 = loadToggle({ DSH_MODE: "progressive" });
t2.handlers.session_start[0]({ reason: "startup" }, tctx([]));
console.assert(JSON.stringify(t2.active) === JSON.stringify(["bash", "str_replace_editor"]), "env progressive: bootstrap active at session start");

// 10g. DSH_MODE=c2 remains a backward-compatible environment alias
const t3 = loadToggle({ DSH_MODE: "c2" });
t3.handlers.session_start[0]({ reason: "startup" }, tctx([]));
console.assert(JSON.stringify(t3.active) === JSON.stringify(["bash", "str_replace_editor"]), "legacy env c2: bootstrap active at session start");

// 收尾: 门控复原, 避免影响其它测试/后续
setAnchoredEnabled(true);

// ── 11. npm 包入口: 默认渐进模式 / Progressive mode，同时支持 DSH_MODE=off ──
const packageMod = await jiti.import(join(PLUGIN_DIR, "index.ts"));
const packageFactory = packageMod.default;

function loadPackage(env) {
	for (const k of Object.keys(process.env)) if (k.startsWith("DSH_")) delete process.env[k];
	Object.assign(process.env, env);
	setAnchoredEnabled(true);
	const handlers = {};
	const tools = {};
	const commands = {};
	let active = [];
	const sent = [];
	const pi = {
		on(ev, h) { (handlers[ev] ??= []).push(h); },
		registerTool(def) { tools[def.name] = def; },
		registerCommand(name, def) { commands[name] = def; },
		setActiveTools(names) { active.length = 0; active.push(...names); },
		sendUserMessage(msg, opts) { sent.push({ kind: "user", msg, opts }); },
		sendMessage(msg, opts) { sent.push({ kind: "custom", msg, opts }); },
		getAllTools() { return Object.entries(tools).map(([name, d]) => ({ name, description: d.description })); },
	};
	packageFactory(pi);
	return { handlers, tools, commands, active, sent, pi };
}

const packageCtx = (branch = []) => ({ sessionManager: { getSessionId: () => "s11", getBranch: () => branch }, isIdle: () => false });
const packageEnabled = loadPackage({});
console.assert(process.env.DSH_MODE === "progressive", "package defaults to Progressive mode");
console.assert(packageEnabled.commands["dsh-mode"] && packageEnabled.commands.dsh, "package registers mode commands");
packageEnabled.handlers.session_start[0]({ reason: "startup" }, packageCtx([]));
console.assert(JSON.stringify(packageEnabled.active) === JSON.stringify(["bash", "str_replace_editor"]), "package Progressive bootstrap:", packageEnabled.active);

const packageDisabled = loadPackage({ DSH_MODE: "off" });
packageDisabled.handlers.session_start[0]({ reason: "startup" }, packageCtx([]));
console.assert(packageDisabled.active.length === 0, "package respects DSH_MODE=off");

const packageLegacy = loadPackage({ DSH_MODE: "c2" });
packageLegacy.handlers.session_start[0]({ reason: "startup" }, packageCtx([]));
console.assert(JSON.stringify(packageLegacy.active) === JSON.stringify(["bash", "str_replace_editor"]), "package accepts legacy DSH_MODE=c2");

setAnchoredEnabled(true);
console.log("\nALL SMOKE TESTS PASSED (incl. toggle and package entry)");
