/**
 * omp extension loaded only into the omp-web control bot (`bot.ts` starts it with `-e`): tools that
 * operate the dashboard — list / create / stop / restart sessions, change their model, thinking
 * level or account, send them messages and read their replies, answer plan reviews, and read usage,
 * notifications, accounts, models and connected computers.
 *
 * Every tool calls omp-web's loopback `/internal/bot/<action>`, authenticated with data/internal-token.
 */
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dir, "..", "data");

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

async function dashboard(action: string, params: Record<string, unknown>) {
	const cfg = readConfig();
	if (!cfg) return { content: [{ type: "text", text: "omp-web 대시보드에 연결할 수 없습니다" }], isError: true };
	const res = await fetch(`${cfg.base}/internal/bot/${action}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Omp-Web-Token": cfg.token },
		body: JSON.stringify(params),
		signal: AbortSignal.timeout(120_000),
	});
	const text = await res.text();
	return { content: [{ type: "text", text: text || `HTTP ${res.status}` }], isError: !res.ok, details: { status: res.status } };
}

interface Pi {
	zod: any;
	registerTool(def: unknown): void;
}

export default function controlTools(pi: Pi): void {
	const z = pi.zod;
	const session = z.string().describe("Session: its `ref` from dashboard_sessions, a word of its title, or its folder name");
	const tool = (name: string, action: string, description: string, shape: Record<string, unknown>, approval: "read" | "exec" = "read") =>
		pi.registerTool({
			name,
			label: name.replace(/^dashboard_/, "").replace(/_/g, " "),
			description,
			loadMode: "essential",
			approval,
			parameters: z.object(shape),
			execute: (_id: string, params: Record<string, unknown>) => dashboard(action, params),
		});

	tool("dashboard_sessions", "sessions",
		"List the running omp sessions on the dashboard (this server and connected computers): ref, title, folder, status (작업 중/대기/입력 필요/백그라운드), model, thinking, account, pending plan review.", {});
	tool("dashboard_session_read", "session.read",
		"Read a session's latest conversation (user and AI messages, tool calls named) to report what it did or is doing.",
		{ session, count: z.number().optional().describe("How many recent messages (default 6, max 40)") });
	tool("dashboard_session_send", "session.send",
		"Send a message to a session as if the user typed it there; queued after its current work when it is busy. Use for giving a session instructions.",
		{ session, message: z.string().describe("The message, written for that session's agent") }, "exec");
	tool("dashboard_session_create", "session.create",
		"Start a new omp session in a folder. On this server folders are absolute paths under /root; on a remote computer `~` works. The folder must exist unless createDir is true.",
		{
			cwd: z.string().describe("Working folder"),
			prompt: z.string().optional().describe("First message for the new session"),
			model: z.string().optional().describe("provider/model id from dashboard_models (default: the configured model)"),
			thinking: z.string().optional().describe("Thinking level: low, medium, high, xhigh, max, …"),
			account: z.string().optional().describe("Claude account email (or part of it) to use, or 'auto'"),
			computer: z.string().optional().describe("Connected computer name to run on (default: this server)"),
			createDir: z.boolean().optional().describe("Create the folder if it is missing"),
		}, "exec");
	tool("dashboard_session_change", "session.change",
		"Change a running session's model, thinking level and/or Claude account (email part or 'auto'). The conversation continues.",
		{ session, model: z.string().optional(), thinking: z.string().optional(), account: z.string().optional() }, "exec");
	tool("dashboard_session_stop", "session.stop",
		"Stop (end) a session. Its conversation stays saved and can be resumed from the dashboard. Confirm with the user first unless they asked for exactly this.",
		{ session }, "exec");
	tool("dashboard_session_restart", "session.restart",
		"Restart an idle session in place (conversation restored), e.g. to apply an omp update.", { session }, "exec");
	tool("dashboard_session_link", "session.link",
		"Get a link that opens the session's live screen in a browser (control access).", { session });
	tool("dashboard_plan_get", "plan.get",
		"Read the plan a session is waiting to have approved, with the choices it accepts.", { session });
	tool("dashboard_plan_answer", "plan.answer",
		"Answer a session's pending plan review: execute (approve and run), compact, keep, refine (needs feedback), or save.",
		{
			session,
			choice: z.string().describe("execute | compact | keep | refine | save"),
			feedback: z.string().optional().describe("What to change (required for refine)"),
			role: z.string().optional().describe("Model tier to execute with, from the plan's tiers"),
		}, "exec");
	tool("dashboard_usage", "usage", "AI subscription usage per account: % used of each limit and when it resets.", {});
	tool("dashboard_notifications", "notifications",
		"Recent dashboard notifications (작업 완료, 입력 필요, 플랜 승인 필요), newest first.",
		{ count: z.number().optional().describe("How many (default 10)") });
	tool("dashboard_accounts", "accounts", "Logged-in model accounts and which account each project folder uses.", {});
	tool("dashboard_models", "models", "Models available for sessions, with their thinking levels.", {});
	tool("dashboard_computers", "computers", "Remote computers (e.g. the user's Mac) connected to the dashboard and their state.", {});
	tool("dashboard_dirs", "dirs", "List subfolders of a folder on this server (to find a project path).",
		{ path: z.string().optional().describe("Absolute path (default /root)") });
}
