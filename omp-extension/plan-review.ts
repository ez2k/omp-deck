/**
 * omp extension: mirrors the interactive plan review (approve / refine / save) to the omp-web
 * dashboard so it can be answered from a browser. The terminal picker stays live; the first answer wins.
 *
 * Talks only to omp-web on loopback, authenticated with the token omp-web writes to data/internal-token.
 */
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dir, "..", "data");
const POLL_TIMEOUT_MS = 30_000;
const RETRY_MS = 3_000;

function readConfig(): { base: string; token: string } | null {
	try {
		const token = fs.readFileSync(path.join(DATA_DIR, "internal-token"), "utf8").trim();
		const env = fs.readFileSync(path.join(DATA_DIR, "env"), "utf8");
		const port = /^PORT=(\d+)/m.exec(env)?.[1] ?? "7470";
		return token ? { base: `http://127.0.0.1:${port}`, token } : null;
	} catch {
		return null; // omp-web not installed/started: stay inert
	}
}

async function call(pathname: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response | null> {
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

interface ReviewEvent {
	reviewId: string;
	sessionId: string;
	title: string;
	planFilePath: string;
	options: { id: string; label: string; disabled: boolean }[];
	tiers?: { role: string; provider: string; model: string; thinkingLevel?: string }[];
}

interface Ctx {
	agent?: { kind: string };
	resolvePlanReview(reviewId: string, choice: string, input?: { feedback?: string; role?: string }): boolean;
	getPendingPlanReview(): ReviewEvent | undefined;
}

/** Reviews this process is currently relaying (module state is shared by subagent sessions; ids are unique). */
const active = new Set<string>();

function register(review: ReviewEvent): Promise<Response | null> {
	return call("/internal/plan-review", {
		method: "POST",
		body: JSON.stringify({
			reviewId: review.reviewId,
			sessionId: review.sessionId,
			title: review.title,
			planFilePath: review.planFilePath,
			options: review.options,
			tiers: review.tiers ?? [],
			pid: process.pid,
		}),
	});
}

async function relay(review: ReviewEvent, ctx: Ctx): Promise<void> {
	if (active.has(review.reviewId)) return;
	active.add(review.reviewId);
	const { reviewId } = review;
	const stillOpen = () => active.has(reviewId) && ctx.getPendingPlanReview()?.reviewId === reviewId;
	/** answer id -> result already reported, so a re-delivered answer is acknowledged, not re-applied. */
	const handled = new Map<string, { ok: boolean; error?: string }>();
	try {
		let registered = false;
		// Long-poll for an answer until this review closes (plan_review_resolved clears `active`).
		while (stillOpen()) {
			if (!registered) {
				registered = Boolean((await register(review))?.ok);
				if (!registered) {
					await Bun.sleep(RETRY_MS); // omp-web down or restarting
					continue;
				}
			}
			const res = await call(`/internal/plan-review/${reviewId}/answer`, {}, POLL_TIMEOUT_MS + 5_000);
			if (!res) {
				await Bun.sleep(RETRY_MS);
				continue;
			}
			if (res.status === 204) continue;
			if (res.status === 410) {
				registered = false; // omp-web restarted and lost the review: register it again
				continue;
			}
			if (!res.ok) {
				await Bun.sleep(RETRY_MS);
				continue;
			}
			const answer = (await res.json()) as { id?: string; choice: string; feedback?: string; role?: string };
			const answerId = answer.id ?? "";
			let result = handled.get(answerId);
			if (!result) {
				const input: { feedback?: string; role?: string } = {};
				if (answer.feedback) input.feedback = answer.feedback;
				if (answer.role) input.role = answer.role;
				result = { ok: false };
				try {
					result.ok = ctx.resolvePlanReview(reviewId, answer.choice, Object.keys(input).length ? input : undefined);
				} catch (err) {
					result.error = err instanceof Error ? err.message : String(err);
				}
				handled.set(answerId, result);
			}
			await call(`/internal/plan-review/${reviewId}/result`, {
				method: "POST",
				body: JSON.stringify({ answerId: answer.id, ...result }),
			});
			if (result.ok) return;
		}
	} finally {
		active.delete(reviewId);
	}
}

// Minimal local view of ExtensionAPI.on: omp passes each event's own shape, typed per handler below.
type On = <E>(event: string, handler: (event: E, ctx: Ctx) => unknown) => void;

export default function planReviewBridge(pi: { on: On }): void {
	pi.on<ReviewEvent>("plan_review_requested", (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		void relay(event, ctx); // hand off: plan_review_resolved waits for this handler to return
	});
	pi.on<{ reviewId: string; choice?: string; by?: string }>("plan_review_resolved", event => {
		active.delete(event.reviewId);
		void call(`/internal/plan-review/${event.reviewId}/resolved`, {
			method: "POST",
			body: JSON.stringify({ choice: event.choice ?? null, by: event.by ?? null }),
		});
	});
	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		const pending = ctx.getPendingPlanReview?.();
		if (pending) void relay(pending, ctx);
	});
}
