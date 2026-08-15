// 对比分析 A(默认)/B(minimal)/C(anchored) 三条 session trace
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXP = dirname(fileURLToPath(import.meta.url));
const runs = ["A", "B", "C"];

function sessionFile(tag) {
	const dir = join(EXP, "sessions", tag);
	const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	if (files.length === 0) return null;
	return join(dir, files[0]);
}

for (const tag of runs) {
	const path = sessionFile(tag);
	if (!path) { console.log(`\n===== RUN ${tag}: NO SESSION FILE =====`); continue; }
	const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
	const entries = lines.map((l) => JSON.parse(l));

	const assistantTexts = [];
	const toolCalls = []; // {name, input, seq}
	let firstAssistantLine = null;
	let firstUserText = null;

	for (const e of entries) {
		if (e.type !== "message") continue;
		const m = e.message;
		if (m.role === "user" && !firstUserText) firstUserText = (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ").slice(0, 80);
		if (m.role === "assistant") {
			const text = (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
			if (text.trim()) {
				assistantTexts.push(text);
				if (!firstAssistantLine) firstAssistantLine = text.trim().split("\n")[0].slice(0, 120);
			}
		}
		if (m.role === "toolResult") {
			toolCalls.push({ name: m.toolName, input: m.input ?? m.details ?? {}, seq: e.id });
		}
	}

	const allText = assistantTexts.join("\n");
	const countRe = (re) => (allText.match(re) ?? []).length;
	const style = {
		we: countRe(/\bwe\b/gi),
		weNeed: countRe(/\bwe need\b/gi),
		lets: countRe(/\blet's\b/gi),
		letMe: countRe(/\blet me\b/gi),
		ill: countRe(/\bi'll\b/gi),
	};
	const toolCounts = {};
	for (const t of toolCalls) toolCounts[t.name] = (toolCounts[t.name] ?? 0) + 1;
	const webSearches = toolCalls.filter((t) => t.name === "web_search").slice(0, 6).map((t) => (t.input?.query ?? t.input ?? "").toString().slice(0, 70));

	console.log(`\n===== RUN ${tag} =====`);
	console.log("entries:", entries.length, "| assistantTextMsgs:", assistantTexts.length, "| toolCalls:", toolCalls.length);
	console.log("userPrompt:", firstUserText);
	console.log("firstAssistantLine:", firstAssistantLine);
	console.log("style:", JSON.stringify(style));
	console.log("tools:", JSON.stringify(toolCounts));
	console.log("assistantTextHeads:");
	for (const t of assistantTexts) console.log("   ·", t.replace(/\n/g, " ").slice(0, 150));
	if (webSearches.length) {
		console.log("web_search queries (first 6):");
		for (const q of webSearches) console.log("   ?", q);
	}
}
