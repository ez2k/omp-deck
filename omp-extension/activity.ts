/**
 * omp extension, the dashboard's live link to a session:
 * - Reports background work (async subagents, background bash jobs, results still waiting to be
 *   delivered) and the thinking level. `omp collab list` only says whether a turn is in flight, so
 *   without this a session whose subagents keep working after its turn looks idle, and an update
 *   restart would cut them off.
 * - Applies the dashboard's model / thinking-level changes (`/model <id>` in the TUI only opens a
 *   picker, and collab guests cannot run it), long-polling omp-web for them.
 *
 * Talks only to omp-web on loopback, authenticated with the token omp-web writes to data/internal-token.
 */
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dir, "..", "data");
const CHECK_MS = 3_000;
/** Unchanged state is re-sent this often, so omp-web can tell a live report from a stale one. */
const HEARTBEAT_MS = 15_000;
const CONTROL_POLL_MS = 25_000;
const RETRY_MS = 3_000;
/** Bumped when the dashboard gains a control this extension can carry out. */
const CONTROL_VERSION = 3; // 1: model/thinking, 2: + account choice, 3: + prompts from the dashboard bot

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

async function call(pathname: string, init: RequestInit = {}, timeoutMs = 5_000): Promise<Response | null> {
	const cfg = readConfig();
	if (!cfg) return null;
	try {
		return await fetch(cfg.base + pathname, {
			...init,
			headers: { "Content-Type": "application/json", "X-Omp-Web-Token": cfg.token, ...init.headers },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch {
		return null;
	}
}

interface JobItem {
	id?: string;
	type?: string;
	label?: string;
	startTime?: number;
}

interface ModelLike {
	provider: string;
	id: string;
}

/** One stored OAuth account as omp's auth storage lists it (`authStorage.oauth.accounts`). */
interface AccountSummary {
	credentialId: number;
	email?: string;
	orgId?: string;
	accountId?: string;
	active: boolean;
}

interface AuthStorage {
	oauth: { accounts(provider: string, sessionId?: string): AccountSummary[] };
	sessions: {
		pin(provider: string, sessionId: string, credentialId: number): boolean;
		release(provider: string, sessionId: string): boolean;
	};
}

interface Ctx {
	agent?: { kind: string };
	cwd?: string;
	model?: ModelLike;
	sessionManager?: { getSessionId(): string };
	modelRegistry?: { find(provider: string, id: string): ModelLike | undefined; authStorage?: AuthStorage };
	getAsyncJobSnapshot?(): { running?: JobItem[]; delivery?: { queued?: number } } | null;
}

interface Pi {
	on<E>(event: string, handler: (event: E, ctx: Ctx) => unknown): void;
	setModel(model: ModelLike): Promise<boolean>;
	getThinkingLevel(): string | undefined;
	setThinkingLevel(level: string): void;
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void>;
}

interface Control {
	id: string;
	model?: string;
	thinking?: string;
	/** provider -> account identity key to pin, or "" to let omp choose again. */
	accounts?: Record<string, string>;
	/** A message for the session, as if typed (queued after the current work when busy). */
	prompt?: string;
}

/** The identity key `omp usage accounts` prints and the dashboard stores: `email:<address>|org:<id>`. */
function accountKey(a: AccountSummary): string | null {
	if (!a.email) return null;
	return a.orgId ? `email:${a.email}|org:${a.orgId}` : `email:${a.email}`;
}

export default function sessionBridge(pi: Pi): void {
	let timer: Timer | null = null;
	let last = "";
	let lastSentAt = 0;
	/** Bumped on every session start/shutdown; a control loop from an older generation stops. */
	let generation = 0;
	/** provider -> account key the dashboard chose for this session (re-pinned before every run). */
	let chosen: Record<string, string> = {};

	/**
	 * Pins the chosen accounts as explicit session pins: omp never moves an explicit pin for ranking
	 * or reserve, only past an account that is blocked (hit its limit), so work does not stop. An
	 * Anthropic pin goes cold after an idle hour, hence re-pinning before each run.
	 */
	const pinChosen = (ctx: Ctx): string | null => {
		const auth = ctx.modelRegistry?.authStorage;
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (!auth || !sessionId) return "이 omp 버전에서는 계정을 고를 수 없습니다";
		for (const [provider, key] of Object.entries(chosen)) {
			const account = auth.oauth.accounts(provider, sessionId).find(a => accountKey(a) === key);
			if (!account) return `로그인된 계정이 아닙니다: ${key.replace(/^email:|\|org:.*$/g, "")}`;
			auth.sessions.pin(provider, sessionId, account.credentialId);
		}
		return null;
	};

	/** provider -> the account now serving it (the model's provider, plus any with a choice). */
	const activeAccounts = (ctx: Ctx) => {
		const auth = ctx.modelRegistry?.authStorage;
		const sessionId = ctx.sessionManager?.getSessionId?.();
		const out: Record<string, string> = {};
		if (!auth || !sessionId) return out;
		for (const provider of new Set([ctx.model?.provider, ...Object.keys(chosen)].filter((p): p is string => !!p))) {
			const active = auth.oauth.accounts(provider, sessionId).find(a => a.active);
			const key = active && accountKey(active);
			if (key) out[provider] = key;
		}
		return out;
	};

	const report = async (ctx: Ctx) => {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (!sessionId) return;
		const snap = ctx.getAsyncJobSnapshot?.() ?? null;
		const running = (snap?.running ?? []).map(j => ({
			type: String(j.type ?? "job"),
			label: String(j.label ?? "").slice(0, 120),
			startTime: typeof j.startTime === "number" ? j.startTime : 0,
		}));
		const body = JSON.stringify({
			sessionId,
			pid: process.pid,
			running,
			queued: snap?.delivery?.queued ?? 0,
			thinking: pi.getThinkingLevel() ?? null,
			accounts: activeAccounts(ctx),
			chosen,
			control: CONTROL_VERSION,
		});
		if (body === last && Date.now() - lastSentAt < HEARTBEAT_MS) return;
		const res = await call("/internal/session-activity", { method: "POST", body });
		if (res?.ok) {
			last = body;
			lastSentAt = Date.now();
		}
	};

	const apply = async (c: Control, ctx: Ctx): Promise<{ ok: boolean; error?: string }> => {
		if (c.model) {
			const slash = c.model.indexOf("/");
			const model = slash > 0 ? ctx.modelRegistry?.find(c.model.slice(0, slash), c.model.slice(slash + 1)) : undefined;
			if (!model) return { ok: false, error: `이 세션에서 쓸 수 없는 모델입니다: ${c.model}` };
			if (!(await pi.setModel(model))) return { ok: false, error: `${c.model}에 로그인된 계정이 없습니다` };
		}
		// After the model: a level the new model lacks is clamped by omp itself.
		if (c.thinking) pi.setThinkingLevel(c.thinking);
		if (c.accounts) {
			const auth = ctx.modelRegistry?.authStorage;
			const sessionId = ctx.sessionManager?.getSessionId?.();
			if (!auth || !sessionId) return { ok: false, error: "이 omp 버전에서는 계정을 고를 수 없습니다" };
			const next = { ...chosen };
			for (const [provider, key] of Object.entries(c.accounts)) {
				if (key) next[provider] = key;
				else {
					delete next[provider];
					auth.sessions.release(provider, sessionId); // "자동": omp ranks the accounts again
				}
			}
			const previous = chosen;
			chosen = next;
			const error = pinChosen(ctx);
			if (error) {
				chosen = previous;
				return { ok: false, error };
			}
		}
		if (c.prompt) await pi.sendUserMessage(c.prompt, { deliverAs: "followUp" });
		return { ok: true };
	};

	const controlLoop = async (ctx: Ctx, gen: number) => {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (!sessionId) return;
		while (gen === generation) {
			const res = await call(`/internal/session-control/${sessionId}?pid=${process.pid}`, {}, CONTROL_POLL_MS + 5_000);
			if (gen !== generation) return;
			if (!res || (!res.ok && res.status !== 204)) {
				await Bun.sleep(RETRY_MS); // omp-web down or restarting
				continue;
			}
			if (res.status === 204) continue;
			const c = (await res.json().catch(() => null)) as Control | null;
			if (!c?.id) continue;
			let result: { ok: boolean; error?: string };
			try {
				result = await apply(c, ctx);
			} catch (err) {
				result = { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
			await call(`/internal/session-control/${sessionId}/result`, { method: "POST", body: JSON.stringify({ id: c.id, ...result }) });
			last = ""; // report the new thinking level now
			void report(ctx);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		clearInterval(timer ?? undefined);
		const gen = ++generation;
		last = "";
		chosen = {};
		timer = setInterval(() => void report(ctx), CHECK_MS);
		void (async () => {
			// The account chosen for this session, or else for its project folder.
			const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
			const q = new URLSearchParams({ sessionId, cwd: ctx.cwd ?? process.cwd() });
			const res = await call(`/internal/session-accounts?${q}`);
			const body = res?.ok ? ((await res.json().catch(() => null)) as { accounts?: Record<string, string> } | null) : null;
			if (gen !== generation) return;
			chosen = body?.accounts ?? {};
			pinChosen(ctx);
			void report(ctx);
		})();
		void controlLoop(ctx, gen);
	});
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.agent?.kind === "sub" || !Object.keys(chosen).length) return;
		pinChosen(ctx);
	});
	pi.on("session_shutdown", () => {
		generation++;
		clearInterval(timer ?? undefined);
		timer = null;
	});
}
