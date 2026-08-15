// 具体结果对比: 事实覆盖清单 + 结构 + 关键日期冲突
import { readFileSync } from "node:fs";

const FILES = {
	A: "artifacts/A-openai_model_history.md",
	B: "out-B.txt",
	C: "out-C.txt",
	D: "out-D.txt",
	D2: "out-D2.txt",
	C2: "out-C2.txt",
};

// [标签, 命中模式(任一即可)]
const FACTS = [
	["GPT-1/2018", ["GPT-1", "GPT-1（", "GPT-1("]],
	["GPT-2/2019", ["GPT-2"]],
	["GPT-3/2020", ["GPT-3"]],
	["ChatGPT/2022-11", ["ChatGPT"]],
	["GPT-4/2023-03", ["GPT-4"]],
	["GPT-4o/2024-05", ["GPT-4o", "gpt-4o"]],
	["o1/2024-09", ["o1"]],
	["o3/2025", ["o3"]],
	["GPT-5/2025-08", ["GPT-5"]],
	["GPT-5 Pro 2025-10-06", ["2025-10-06", "2025 年 10 月 6 日", "10 月 6 日"]],
	["GPT-5.6 家族 2026-07", ["GPT-5.6"]],
	["DALL·E 2/2022-04", ["DALL·E 2", "DALL-E 2"]],
	["DALL·E 3/2023", ["DALL·E 3", "DALL-E 3"]],
	["gpt-image-1", ["gpt-image-1"]],
	["gpt-image-2/2026-04", ["gpt-image-2"]],
	["Sora/2024-02", ["Sora"]],
	["Sora 2", ["Sora 2"]],
	["Whisper/2022-09", ["Whisper"]],
	["tts-1/2023", ["tts-1"]],
	["ada-002/2022-12", ["text-embedding-ada-002", "ada-002"]],
	["embedding-3/2024-01", ["text-embedding-3"]],
	["Codex/2021", ["Codex"]],
	["Completions API/2020", ["Completions", "completions"]],
	["o4-mini/2025-04", ["o4-mini"]],
	["GPT-4.5/2025-02", ["GPT-4.5", "gpt-4.5"]],
];

const rows = {};
for (const [tag, path] of Object.entries(FILES)) {
	const text = readFileSync(path, "utf8");
	const lower = text.toLowerCase();
	const found = FACTS.filter(([, pats]) => pats.some((p) => lower.includes(p.toLowerCase())));
	const missing = FACTS.filter(([, pats]) => !pats.some((p) => lower.includes(p.toLowerCase())));
	const headings = (text.match(/^#{1,3} /gm) ?? []).length;
	const hasRefs = /参考|来源|References|引用/.test(text);
	const lines = text.split("\n").length;
	rows[tag] = { found: found.length, total: FACTS.length, missing: missing.map((f) => f[0]), headings, hasRefs, lines, chars: text.length };
}

console.log("事实覆盖 (共" + FACTS.length + "项):");
const header = ["run", "覆盖", "标题数", "参考文献节", "行数", "字节"];
console.log(header.join("\t"));
for (const [tag, r] of Object.entries(rows)) {
	console.log([tag, `${r.found}/${r.total}`, r.headings, r.hasRefs ? "有" : "无", r.lines, r.chars].join("\t"));
}
console.log("\n缺失项:");
for (const [tag, r] of Object.entries(rows)) {
	if (r.missing.length) console.log(` ${tag}: ${r.missing.join(", ")}`);
}
console.log("\n关键日期一致性 (GPT-5 Pro 上 API 日期):");
for (const [tag, path] of Object.entries(FILES)) {
	const text = readFileSync(path, "utf8");
	const i = text.indexOf("GPT-5 Pro");
	const seg = i >= 0 ? text.slice(i, i + 220).replace(/\n/g, " ") : "(未提及 GPT-5 Pro)";
	console.log(` ${tag}: ${seg}`);
}
