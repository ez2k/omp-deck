/**
 * omp extension: gives sessions on this server a `remote_computer` tool that hands a task to a
 * computer connected to the omp-web dashboard (a Mac running node-agent). That computer runs omp
 * headlessly with computer control on (screenshots, clicks, typing, apps) and sends back its answer
 * plus a screenshot of where it left the screen.
 *
 * Talks only to omp-web on loopback, authenticated with the token omp-web writes to data/internal-token.
 */
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dir, "..", "data");
const POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MIN = 20;

function readConfig(): { base: string; token: string } | null {
	try {
		const token = fs.readFileSync(path.join(DATA_DIR, "internal-token"), "utf8").trim();
		const env = fs.readFileSync(path.join(DATA_DIR, "env"), "utf8");
		const port = /^PORT=(\d+)/m.exec(env)?.[1] ?? "7470";
		return token ? { base: `http://127.0.0.1:${port}`, token } : null;
	} catch {
		return null;
	}
}

interface TaskState {
	state: "running" | "done" | "failed" | "cancelled";
	nodeName: string;
	output: string;
	error: string | null;
	image: string | null;
}

async function call<T>(pathname: string, init: RequestInit = {}): Promise<T> {
	const cfg = readConfig();
	if (!cfg) throw new Error("omp-web 대시보드를 찾을 수 없습니다 (data/internal-token)");
	const res = await fetch(cfg.base + pathname, {
		...init,
		headers: { "Content-Type": "application/json", "X-Omp-Web-Token": cfg.token, ...init.headers },
		signal: AbortSignal.timeout(30_000),
	});
	const body = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(body.error || `omp-web 응답 ${res.status}`);
	return body;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface Params {
	task: string;
	computer?: string;
	fresh?: boolean;
	cwd?: string;
	timeout_minutes?: number;
	model?: string;
}

interface Ctx {
	sessionManager?: { getSessionId(): string };
}

interface Pi {
	zod: any;
	registerTool(def: unknown): void;
}

export default function remoteComputer(pi: Pi): void {
	const z = pi.zod;
	pi.registerTool({
		name: "remote_computer",
		label: "Remote Computer",
		loadMode: "essential",
		approval: "exec",
		description: [
			"Hand a task to the user's own computer (e.g. their Mac) connected to the omp-web dashboard.",
			"An AI agent runs there with full desktop control: it can open apps and web pages, read the screen,",
			"click, type, and use the clipboard and that computer's files. Use it when the user asks for",
			"something on their computer, or to check a page/app in a real desktop browser.",
			"Describe the goal and what to report back; the remote agent cannot see this conversation.",
			"Calls from this session continue one remote conversation (it remembers earlier tasks) unless fresh is true.",
			"Returns the remote agent's final answer and a screenshot of the screen when it finished.",
			"Avoid consequential actions (sending messages, purchases, deleting data) unless the user asked for exactly that.",
		].join(" "),
		parameters: z.object({
			task: z.string().describe("What to do on the remote computer and what to report back. Self-contained."),
			computer: z.string().optional().describe("Computer name when several are connected (default: the only one)"),
			fresh: z.boolean().optional().describe("Start a new remote conversation instead of continuing this session's"),
			cwd: z.string().optional().describe("Working folder on the remote computer (default ~)"),
			timeout_minutes: z.number().optional().describe(`Give up after this long (default ${DEFAULT_TIMEOUT_MIN}, max 60)`),
			model: z.string().optional().describe("Model for the remote agent (provider/id); default: that computer's default"),
		}),
		async execute(_id: string, params: Params, signal: AbortSignal | undefined, onUpdate: ((u: { content: Content[] }) => void) | undefined, ctx: Ctx) {
			const timeoutSec = Math.min(Math.max(params.timeout_minutes ?? DEFAULT_TIMEOUT_MIN, 1), 60) * 60;
			const started = await call<{ taskId: string; computer: string }>("/internal/remote-task", {
				method: "POST",
				body: JSON.stringify({
					task: params.task,
					computer: params.computer,
					fresh: params.fresh,
					cwd: params.cwd,
					model: params.model,
					timeoutSec,
					sessionId: ctx?.sessionManager?.getSessionId?.() ?? "default",
				}),
			});
			const t0 = Date.now();
			let task: TaskState | null = null;
			for (;;) {
				if (signal?.aborted) {
					await call(`/internal/remote-task/${started.taskId}/cancel`, { method: "POST" }).catch(() => {});
					return { content: [{ type: "text", text: `${started.computer}에서 하던 작업을 취소했습니다` }], details: { cancelled: true } };
				}
				task = await call<TaskState>(`/internal/remote-task/${started.taskId}`).catch(() => task);
				if (task && task.state !== "running") break;
				const s = Math.round((Date.now() - t0) / 1000);
				onUpdate?.({ content: [{ type: "text", text: `${started.computer}에서 작업 중… ${s}초` }] });
				await Bun.sleep(POLL_MS);
			}
			const content: Content[] = [];
			const head = task.state === "done" ? `${task.nodeName}에서 작업을 마쳤습니다.` : `${task.nodeName}에서 작업이 ${task.state === "cancelled" ? "취소되었습니다" : "실패했습니다"}.`;
			content.push({ type: "text", text: [head, task.error && `오류: ${task.error}`, task.output && `\n원격 에이전트의 답:\n${task.output}`].filter(Boolean).join("\n") });
			if (task.image) {
				content.push({ type: "text", text: task.state === "done"
					? "작업이 끝났을 때의 화면:"
					: "참고: 지금 화면입니다. 원격 작업은 위 이유로 이뤄지지 않았으니 이 화면을 작업 결과로 보지 마세요." });
				content.push({ type: "image", data: task.image, mimeType: "image/jpeg" });
			}
			return { content, details: { computer: task.nodeName, state: task.state, seconds: Math.round((Date.now() - t0) / 1000) }, isError: task.state === "failed" };
		},
	});
}
