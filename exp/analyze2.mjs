// 深度对比: 思维链风格标记 + 工具调用序列 + 产出物
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXP = dirname(fileURLToPath(import.meta.url));

function load(tag) {
	const d = join(EXP, "sessions", tag, readdirSync(join(EXP, "sessions", tag)).find((f) => f.endsWith(".jsonl")));
	return readFileSync(d, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

for (const tag of ["A", "B", "C"]) {
	const entries = load(tag);
	const thinking = [];
	const calls = []; // {tool, args}
	const texts = [];
	for (const e of entries) {
		if (e.type !== "message") continue;
		const m = e.message;
		if (m.role !== "assistant") continue;
		for (const c of m.content ?? []) {
			if (c.type === "thinking") thinking.push(c.thinking ?? "");
			else if (c.type === "text" && (c.text ?? "").trim()) texts.push(c.text);
			else if (c.type === "toolCall") {
				const name = c.toolName ?? c.name ?? c.function?.name ?? "?";
				const args = c.input ?? c.arguments ?? c.function?.arguments ?? {};
				calls.push({ name, args });
			}
		}
	}
	const allThink = thinking.join("\n");
	const re = (x) => (allThink.match(x) ?? []).length;
	const thinkStyle = { we: re(/\bwe\b/gi), weNeed: re(/\bwe need\b/gi), lets: re(/\blet's\b/gi), letMe: re(/\blet me\b/gi), ill: re(/\bi'll\b/gi) };
	const toolCounts = {};
	for (const c of calls) toolCounts[c.name] = (toolCounts[c.name] ?? 0) + 1;

	console.log(`\n===== RUN ${tag} =====`);
	console.log("thinkingChars:", allThink.length, "| thinkingBlocks:", thinking.length, "| assistantTextBlocks:", texts.length);
	console.log("thinkingStyle(EN):", JSON.stringify(thinkStyle));
	console.log("tools:", JSON.stringify(toolCounts));
	console.log("firstThinkingHead:", allThink.slice(0, 220).replace(/\n/g, " "));
	console.log("lastThinkingTail:", allThink.slice(-200).replace(/\n/g, " "));
	console.log("toolSequence:");
	for (const c of calls.slice(0, 40)) {
		const a = JSON.stringify(c.args);
		console.log("  ·", c.name, a.slice(0, 120).replace(/\n/g, " "));
	}
	if (calls.length > 40) console.log(`  … (${calls.length - 40} more)`);
}
