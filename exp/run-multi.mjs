// 通用多轮跑批: node run-multi.mjs <tag> <round2file>
// 第1轮: 自我介绍+工具 (minimal schema 锚定) → 第2轮: <round2file> → 第3轮: 正式任务 (prompt.txt)
// 环境变量透传 (如 DSH_ANCHOR_PROMOTE_HINT=0)
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

const TAG = process.argv[2];
const ROUND2_FILE = process.argv[3];
if (!TAG || !ROUND2_FILE) {
	console.error("usage: node run-multi.mjs <tag> <round2file>");
	process.exit(2);
}

const EXP = dirname(fileURLToPath(import.meta.url));
const WORK = join(EXP, `work-${TAG.toLowerCase()}`);
mkdirSync(WORK, { recursive: true });
const ANCHORED = join(dirname(EXP), "dsh-plugin", "dsh-anchored.ts");

const round1 = readFileSync(join(EXP, "round1.txt"), "utf8").trim();
const round2 = readFileSync(join(EXP, ROUND2_FILE), "utf8").trim();
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
	const dstDir = join(EXP, "sessions", TAG);
	mkdirSync(dstDir, { recursive: true });
	const dst = join(dstDir, src.split(/[\\/]/).pop());
	copyFileSync(src, dst);
	console.error("COPIED_TO=" + dst);
} else {
	console.error("NO_SESSION_FILE");
}
