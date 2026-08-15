// D2 组: 真正三轮对话 (SDK runPrintMode messages 顺序执行)
// 第1轮: 自我介绍+工具 (minimal schema 锚定) → 第2轮: 工具扩展通告 → 第3轮: 正式任务
import {
	createAgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
	ModelRuntime,
	runPrintMode,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXP = dirname(fileURLToPath(import.meta.url));
const WORK = join(EXP, "work-d2");
mkdirSync(WORK, { recursive: true });
const ANCHORED = join(dirname(EXP), "dsh-plugin", "dsh-anchored.ts");

const round1 = readFileSync(join(EXP, "round1.txt"), "utf8").trim();
const round2 = readFileSync(join(EXP, "round2.txt"), "utf8").trim();
const task = readFileSync(join(EXP, "prompt.txt"), "utf8").trim();

const modelRuntime = await ModelRuntime.create();

const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({
		cwd,
		resourceLoaderOptions: { additionalExtensionPaths: [ANCHORED] },
	});
	return {
		...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
		services,
		diagnostics: services.diagnostics,
	};
};

const runtime = await createAgentSessionRuntime(createRuntime, {
	cwd: WORK,
	agentDir: getAgentDir(),
	sessionManager: SessionManager.create(WORK),
});

await runPrintMode(runtime, {
	mode: "text",
	initialMessage: round1,
	images: [],
	messages: [round2, task],
});

const src = runtime.session.sessionFile;
if (src) {
	const dstDir = join(EXP, "sessions", "D2");
	mkdirSync(dstDir, { recursive: true });
	const dst = join(dstDir, src.split(/[\\/]/).pop());
	copyFileSync(src, dst);
	console.error("COPIED_TO=" + dst);
} else {
	console.error("NO_SESSION_FILE");
}
