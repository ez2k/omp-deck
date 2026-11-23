import type { Server } from "bun";
import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	LETSENCRYPT_DIRECTORY,
	certificateDomains,
	certificateNotAfter,
	cloudflareDns,
	issueCertificate,
} from "./acme";
import { CLIENT_PATH, handleRelay, relayWebsocket } from "./relay";
import {
	addSubscription,
	broadcast,
	hasSubscription,
	removeSubscription,
	setVapidSubject,
	subscriptionCount,
	validateSubscription,
	vapidPublicKey,
} from "./push";
import {
	cancelRemoteTask,
	forgetNode,
	handleNodeEndpoint,
	nodeCommand,
	nodeOnline,
	nodesStatus,
	remoteComputers,
	remoteHost,
	remoteHosts,
	remoteTask,
	rotateNodeToken,
	startRemoteTask,
} from "./nodes";
import { ompVersion, releaseNotes, startUpdate, updateStatus } from "./update";
import { botAbort, botNotify, botPair, botReset, botSend, botSettings, botStatus, botUnlink, startBot } from "./bot";

const PORT = Number(process.env.PORT || 7470);
const HOST = process.env.HOST || "0.0.0.0";
const DIRS_ROOT = path.resolve(process.env.OMP_WEB_DIRS_ROOT || os.homedir());
const OMP_BIN = process.env.OMP_BIN || Bun.which("omp");
if (!OMP_BIN) {
	console.error("omp를 PATH에서 찾을 수 없습니다. OMP_BIN을 설정하세요");
	process.exit(1);
}
let TOKEN = process.env.OMP_WEB_TOKEN || "";
if (!TOKEN) {
	TOKEN = crypto.randomBytes(24).toString("base64url");
	console.log(`OMP_WEB_TOKEN 미설정 — 생성된 토큰: ${TOKEN}`);
}
const TOKEN_BUF = Buffer.from(TOKEN);

/** Shared with the omp extension (omp-extension/plan-review.ts) for the loopback-only /internal routes. */
const INTERNAL_TOKEN_FILE = path.resolve(import.meta.dir, "data", "internal-token");
const INTERNAL_TOKEN = await (async () => {
	try {
		const existing = (await fs.readFile(INTERNAL_TOKEN_FILE, "utf8")).trim();
		if (existing) return existing;
	} catch {}
	const token = crypto.randomBytes(32).toString("base64url");
	await fs.mkdir(path.dirname(INTERNAL_TOKEN_FILE), { recursive: true });
	await fs.writeFile(INTERNAL_TOKEN_FILE, token, { mode: 0o600 });
	return token;
})();
const OVERLAY_PATH = path.resolve(import.meta.dir, "collab-overlay.yml");
const VIEW_OVERLAY_PATH = path.resolve(import.meta.dir, "collab-overlay-view.yml");
const INDEX_PATH = path.resolve(import.meta.dir, "public/index.html");
const COOKIE = "omp_web_token";
const TMUX_PREFIX = "omp-web-";
const OMP_TIMEOUT_MS = 20_000;
const MODELS_TTL_MS = 10 * 60_000;
const SESSIONS_DIR = path.join(os.homedir(), ".omp", "agent", "sessions");
const DOC_MAX_BYTES = 512 * 1024;
const DOC_EXT_RE = /\.(md|markdown|mdx)$/i;
const DOC_WALK_MAX_DEPTH = 6;
const DOC_WALK_MAX_DIRS = 3000;
const DOC_LIST_TTL_MS = 15_000;
/** Never descended when walking a project without git (dependencies and build output). */
const DOC_SKIP_DIRS: Record<string, true> = {
	node_modules: true,
	dist: true,
	build: true,
	out: true,
	target: true,
	vendor: true,
	coverage: true,
	__pycache__: true,
	_Index: true, // Wally (Roblox) vendored packages
};
const SESSION_ID_RE = /^[0-9a-f-]{36}$/;
const SESSION_FILE_RE = /_([0-9a-f-]{36})\.jsonl$/;
const SESSION_HEAD_BYTES = 64 * 1024;
const SESSION_TAIL_BYTES = 8 * 1024;
const RECENT_SESSIONS_LIMIT = 100;
const OMP_RUN_DIR = path.join(os.homedir(), ".omp", "run");

// One port serves the dashboard, the collab relay (`/r/<roomId>`) and the guest client (CLIENT_PATH).
// Local omp hosts use ws://127.0.0.1:<PORT>; browsers reach it over HTTPS via a reverse proxy
// (`publicUrl`) or omp-web's own Let's Encrypt certificate (<domain>:<httpsPort>).
const ACME_DIRECTORY = process.env.OMP_WEB_ACME_DIRECTORY || LETSENCRYPT_DIRECTORY;
const DATA_DIR = path.resolve(import.meta.dir, "data");
const RELAY_SETTINGS_FILE = path.join(DATA_DIR, "relay.json");
const ACME_ACCOUNT_FILE = path.join(DATA_DIR, "acme-account.json");
const TLS_CERT_FILE = path.join(DATA_DIR, "tls", "cert.pem");
const TLS_KEY_FILE = path.join(DATA_DIR, "tls", "key.pem");
const RENEW_BEFORE_MS = 30 * 24 * 3600_000;
const RENEW_CHECK_MS = 12 * 3600_000;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Host {
	instanceId: string;
	generation: number;
	pid: number;
	sessionId: string;
	sessionName: string | null;
	cwd: string;
	model: { provider: string; id: string };
	startedAt: number;
	participants: number;
	relayConnected: boolean;
	inputRequired: boolean;
	busy: boolean | null;
	access: "view" | "control";
	tmux?: string | null;
	/** In a tmux pane, so it can be restarted in place. */
	restartable?: boolean;
	/** Still running an omp binary that `omp update` has since replaced. */
	stale?: boolean;
	runningVersion?: string | null;
	/** Set for a session on a remote computer (see nodes.ts). */
	node?: { id: string; name: string };
}

class OmpError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

// ---------- helpers ----------

async function runOmp(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([OMP_BIN!, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1" },
	});
	const timer = setTimeout(() => proc.kill(), OMP_TIMEOUT_MS);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

async function ompJson<T>(args: string[]): Promise<T> {
	const { code, stdout, stderr } = await runOmp(args);
	if (code !== 0) {
		const message = stderr.trim().replace(/^error:\s*/, "").trim() || `omp 종료 코드 ${code}`;
		throw new OmpError(message, message.startsWith("no active Collab host") ? 404 : 502);
	}
	try {
		return JSON.parse(stdout) as T;
	} catch {
		throw new OmpError("omp 출력이 올바른 JSON이 아닙니다", 502);
	}
}

interface TmuxPane {
	session: string;
	paneId: string;
	panePid: number;
}

/** Every tmux pane keyed by its root pid; empty when no tmux server runs. */
async function tmuxPanes(): Promise<Map<number, TmuxPane>> {
	const panes = new Map<number, TmuxPane>();
	const proc = Bun.spawn(["tmux", "list-panes", "-a", "-F", "#{pane_pid} #{pane_id} #{session_name}"], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) return panes;
	for (const line of out.split("\n")) {
		const m = /^(\d+) (%\d+) (.+)$/.exec(line);
		if (m) panes.set(Number(m[1]), { panePid: Number(m[1]), paneId: m[2]!, session: m[3]! });
	}
	return panes;
}

async function parentPid(pid: number): Promise<number | null> {
	try {
		const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
		// fields after the last ')' are: state ppid ...
		const ppid = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[1]);
		return Number.isInteger(ppid) ? ppid : null;
	} catch {
		return null;
	}
}

/** The tmux pane whose process tree contains `pid` (omp is the pane root or a descendant of its shell). */
async function tmuxPaneForPid(pid: number, panes: Map<number, TmuxPane>): Promise<TmuxPane | null> {
	let cur: number | null = pid;
	for (let hop = 0; hop < 10 && cur !== null && cur > 1; hop++) {
		const pane = panes.get(cur);
		if (pane) return pane;
		cur = await parentPid(cur);
	}
	return null;
}

/**
 * `omp update` swaps the binary file, so a host still running the previous build has an
 * executable (`/proc/<pid>/exe`) with a different inode than OMP_BIN.
 */
const runningVersionCache = new Map<number, string | null>();
async function hostBinary(pid: number, current: { dev: number; ino: number } | null) {
	if (!current) return { stale: false, runningVersion: null };
	let stale = false;
	try {
		const exe = await fs.stat(`/proc/${pid}/exe`);
		stale = exe.ino !== current.ino || exe.dev !== current.dev;
	} catch {
		return { stale: false, runningVersion: null };
	}
	if (!stale) return { stale, runningVersion: null };
	if (!runningVersionCache.has(pid)) {
		// The replaced binary stays executable through /proc even after its file was deleted.
		const { code, stdout } = await (async () => {
			const proc = Bun.spawn([`/proc/${pid}/exe`, "--version"], { stdout: "pipe", stderr: "ignore" });
			const timer = setTimeout(() => proc.kill(), 10_000);
			try {
				return { stdout: await new Response(proc.stdout).text(), code: await proc.exited };
			} finally {
				clearTimeout(timer);
			}
		})().catch(() => ({ code: 1, stdout: "" }));
		runningVersionCache.set(pid, code === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(stdout)?.[1] ?? null) : null);
	}
	return { stale, runningVersion: runningVersionCache.get(pid) ?? null };
}

let hostsInFlight: Promise<Host[]> | null = null;
function listHosts(): Promise<Host[]> {
	hostsInFlight ??= (async () => {
		try {
			const [{ hosts }, panes, current] = await Promise.all([
				ompJson<{ hosts: Host[] }>(["collab", "list", "--json"]),
				tmuxPanes(),
				fs.stat(OMP_BIN!).catch(() => null),
			]);
			await Promise.all(
				hosts.map(async h => {
					const pane = await tmuxPaneForPid(h.pid, panes);
					h.tmux = pane?.session.startsWith(TMUX_PREFIX) ? pane.session : null;
					h.restartable = pane !== null;
					Object.assign(h, await hostBinary(h.pid, current));
				}),
			);
			const live = new Set(hosts.map(h => h.pid));
			for (const pid of runningVersionCache.keys()) if (!live.has(pid)) runningVersionCache.delete(pid);
			return hosts;
		} finally {
			hostsInFlight = null;
		}
	})();
	return hostsInFlight;
}

/** Local hosts plus the sessions of connected remote computers (those carry `node`). */
async function allHosts(): Promise<Host[]> {
	return [...(await listHosts()), ...(remoteHosts() as unknown as Host[])];
}

interface ModelInfo {
	selector: string;
	provider: string;
	name: string;
	/** Thinking levels the model accepts (empty: no thinking control). */
	thinking: string[];
}

/** Thinking levels omp accepts (`--thinking`); a model's own list narrows them. */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);

let modelsCache: { at: number; models: ModelInfo[] } | null = null;
/** Models this server can use (`omp models` lists only those with a login or key), dated aliases dropped. */
async function listModels(): Promise<ModelInfo[]> {
	if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.models;
	const { models } = await ompJson<{ models: { selector?: string; provider?: string; name?: string; thinking?: unknown }[] }>(["models", "--json"]);
	const all = models.filter((m): m is typeof m & { selector: string } => typeof m.selector === "string");
	const names = new Set(all.filter(m => !/-\d{8}$/.test(m.selector)).map(m => `${m.provider}/${m.name}`));
	const list = all
		// "claude-haiku-4-5-20251001" next to "claude-haiku-4-5" is the same model twice.
		.filter(m => !/-\d{8}$/.test(m.selector) || !names.has(`${m.provider}/${m.name}`))
		.map(m => ({
			selector: m.selector,
			provider: m.provider ?? m.selector.split("/")[0]!,
			name: m.name ?? m.selector,
			thinking: Array.isArray(m.thinking) ? m.thinking.filter((t): t is string => typeof t === "string" && THINKING_LEVELS.has(t)) : [],
		}))
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name, "en", { numeric: true }));
	modelsCache = { at: Date.now(), models: list };
	return list;
}

function shellQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function errorResponse(err: unknown): Response {
	if (err instanceof OmpError) return json({ error: err.message }, err.status);
	console.error(err);
	return json({ error: `서버 오류: ${err instanceof Error ? err.message : String(err)}` }, 500);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
	try {
		const body = await req.json();
		return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

// ---------- auth ----------

function tokenMatches(candidate: string | null | undefined): boolean {
	if (!candidate) return false;
	const buf = Buffer.from(candidate);
	return buf.length === TOKEN_BUF.length && crypto.timingSafeEqual(buf, TOKEN_BUF);
}

function cookieToken(req: Request): string | null {
	const header = req.headers.get("cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
	}
	return null;
}

const SET_COOKIE = `${COOKIE}=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;
const CLEAR_COOKIE = `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

/** Behind an HTTPS reverse proxy the cookie must not leak over plain http. */
function loginCookie(req: Request): string {
	return req.headers.get("x-forwarded-proto") === "https" ? `${SET_COOKIE}; Secure` : SET_COOKIE;
}

function redirect(location: string, cookie?: string): Response {
	const headers: Record<string, string> = { Location: location, "Cache-Control": "no-store" };
	if (cookie) headers["Set-Cookie"] = cookie;
	return new Response(null, { status: 303, headers });
}

function loginPage(error?: string, status = 200): Response {
	const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>omp collab 로그인</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo","Noto Sans KR",sans-serif;--bg:light-dark(#f4f5f7,#0f1013);--card:light-dark(#fff,#18191e);--border:light-dark(#e2e3e8,#2b2c33);--accent:light-dark(#2f6fdb,#6ea1ff);--accent-fg:light-dark(#fff,#0b1020);--muted:light-dark(#6b6b76,#9a9aa6)}
*{box-sizing:border-box}
body{display:grid;place-items:center;min-height:100dvh;margin:0;padding:1rem;background:var(--bg)}
form{display:flex;flex-direction:column;gap:.85rem;width:min(360px,100%);padding:1.75rem 1.5rem;background:var(--card);border:1px solid var(--border);border-radius:14px;box-shadow:0 4px 24px #0000001a}
h1{margin:0;font-size:1.3rem}
p.sub{margin:-.4rem 0 .2rem;color:var(--muted);font-size:.9rem}
input,button{font:inherit;font-size:16px;padding:.7rem .8rem;border-radius:10px;border:1px solid var(--border);background:var(--card);color:inherit}
button{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600;cursor:pointer}
.err{color:#d33;margin:0;font-size:.9rem}
</style></head><body>
<form method="post" action="/login">
<h1>omp collab</h1>
<p class="sub">대시보드 토큰을 입력하세요</p>
<input type="password" name="token" placeholder="토큰" autocomplete="current-password" autofocus required>
<button type="submit">로그인</button>
${error ? `<p class="err">${error}</p>` : ""}
</form></body></html>`;
	return new Response(html, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
	});
}

// ---------- routes ----------

const INSTANCE_ID_RE = /^[0-9a-f]{16}$/;
const MODEL_RE = /^[A-Za-z0-9_./:-]{1,80}$/;

async function collabLink(instanceId: string, access: "control" | "view") {
	const res = await ompJson<{ url: string; access: string; generation: number }>([
		"collab",
		"link",
		instanceId,
		...(access === "view" ? ["--view"] : []),
		"--json",
	]);
	return { ...publicLink(res.url), access: res.access, generation: res.generation };
}

async function createLink(instanceId: string, req: Request): Promise<Response> {
	const body = await readJsonBody(req);
	const access = body.access ?? "control";
	if (access !== "control" && access !== "view") {
		return json({ error: "access는 control 또는 view여야 합니다" }, 400);
	}
	const link = await collabLink(instanceId, access);
	return json({ url: link.url, localOnly: link.localOnly, access: link.access, generation: link.generation });
}

/** A join link for a local or remote host; a remote one comes from the agent on that computer. */
async function hostLink(host: { instanceId: string; node?: { id: string } }, access: "control" | "view") {
	if (!host.node) return await collabLink(host.instanceId, access);
	const r = await nodeCommand(host.node.id, "link", { instanceId: host.instanceId, access });
	if (!r.ok) throw new OmpError(r.error, 502);
	const data = r.data && typeof r.data === "object" ? r.data : null;
	const url = data && "url" in data && typeof data.url === "string" ? data.url : null;
	if (!url) throw new OmpError("링크를 받지 못했습니다", 502);
	const generation = data && "generation" in data && typeof data.generation === "number" ? data.generation : 0;
	return { ...publicLink(url), access, generation };
}

/** Remote sessions support joining and stopping; file browsing, rename and restart stay local-only. */
async function remoteHostAction(host: { instanceId: string; node: { id: string } }, action: string, req: Request): Promise<Response> {
	if (action === "link") {
		const body = await readJsonBody(req);
		const link = await hostLink(host, body.access === "view" ? "view" : "control");
		return json({ url: link.url, localOnly: link.localOnly, access: link.access, generation: link.generation });
	}
	if (action === "stop") {
		const r = await nodeCommand(host.node.id, "stop", { instanceId: host.instanceId });
		return r.ok ? json({ ok: true }) : json({ error: r.error }, 502);
	}
	return json({ error: "원격 컴퓨터의 세션에서는 지원하지 않는 기능입니다" }, 400);
}

/** Origin agents and install commands should use: the public https URL when there is one. */
function publicBaseUrl(url: URL): string {
	const origin = publicOrigin();
	return origin ? `https://${origin}` : url.origin;
}

/** The installed omp version, re-read every few minutes (`omp update` can change it). */
let ompVersionCache: { at: number; version: string | null } | null = null;
async function cachedOmpVersion(): Promise<string | null> {
	if (!ompVersionCache || Date.now() - ompVersionCache.at > 5 * 60_000) {
		ompVersionCache = { at: Date.now(), version: await ompVersion(OMP_BIN!) };
	}
	return ompVersionCache.version;
}

// ---------- applying updates to running sessions ----------

const APPLY_SETTINGS_FILE = path.resolve(import.meta.dir, "data", "update.json");
const APPLY_CHECK_MS = 15_000;
const APPLY_IDLE_MS = 2 * 60_000;
const EXIT_WAIT_MS = 20_000;
/** Launch flags carried over to the restarted process (everything else, e.g. an initial prompt, is dropped). */
const KEPT_FLAGS: Record<string, true> = { "--config": true, "--profile": true, "--session-dir": true };

function hostName(h: Host): string {
	return h.sessionName ?? h.sessionId.slice(0, 8);
}

let applySettings = { autoRestart: true };
try {
	applySettings = { ...applySettings, ...JSON.parse(await fs.readFile(APPLY_SETTINGS_FILE, "utf8")) };
} catch {}

const restartLog: string[] = [];
const restarting = new Set<string>();
/** instanceId -> first time seen idle (cleared whenever it is busy). */
const idleSince = new Map<string, number>();

function logRestart(message: string): void {
	restartLog.push(`[${new Date().toLocaleString("ko-KR")}] ${message}`);
	if (restartLog.length > 30) restartLog.shift();
	console.log(`[세션 업데이트] ${message}`);
}

async function tmux(args: string[]): Promise<void> {
	const proc = Bun.spawn(["tmux", ...args], { stdout: "ignore", stderr: "pipe" });
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`tmux ${args[0]} 실패: ${stderr.trim()}`);
}

async function waitForExit(pid: number): Promise<boolean> {
	const deadline = Date.now() + EXIT_WAIT_MS;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await Bun.sleep(250);
	}
	return false;
}

/** Carry over --config/--profile/--session-dir; swap our overlay for the one matching the host's access. */
function restartCommand(argv: string[], host: Host, sessionFile: string | null): string {
	const kept: string[] = [];
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") break;
		const eq = arg.indexOf("=");
		const flag = eq > 0 ? arg.slice(0, eq) : arg;
		if (!KEPT_FLAGS[flag]) continue;
		const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
		if (value === undefined) break;
		if (flag === "--config" && (value === OVERLAY_PATH || value === VIEW_OVERLAY_PATH)) continue;
		kept.push(flag, value);
	}
	kept.push("--config", host.access === "view" ? VIEW_OVERLAY_PATH : OVERLAY_PATH);
	// --restore also picks up subagents still running in the background when the old process exits.
	// No file means the session never got a message: there is nothing to carry over.
	if (sessionFile) kept.push("--restore", sessionFile);
	return [OMP_BIN!, ...kept].map(shellQuote).join(" ");
}

/** `<root>/<project>/<timestamp>_<sessionId>.jsonl`, in the default store or the host's --session-dir. */
async function findSessionFile(sessionId: string, argv: string[]): Promise<string | null> {
	const roots: string[] = [];
	argv.forEach((a, i) => {
		if (a === "--session-dir" && argv[i + 1]) roots.push(path.resolve(argv[i + 1]!));
		else if (a.startsWith("--session-dir=")) roots.push(path.resolve(a.slice("--session-dir=".length)));
	});
	roots.push(SESSIONS_DIR); // the host's own --session-dir wins
	const suffix = `_${sessionId}.jsonl`;
	for (const root of roots) {
		const subdirs = (await fs.readdir(root).catch(() => [] as string[])).map(d => path.join(root, d));
		for (const dir of [root, ...subdirs]) {
			const hit = (await fs.readdir(dir).catch(() => [] as string[])).find(f => f.endsWith(suffix));
			if (hit) return path.join(dir, hit);
		}
	}
	return null;
}

/** Stop the host's omp (SIGTERM, a clean session exit) and relaunch it in the same tmux pane on the current binary. */
async function restartHost(host: Host, reason: string): Promise<void> {
	if (restarting.has(host.instanceId)) throw new Error("이미 재시작하는 중입니다");
	restarting.add(host.instanceId);
	try {
		const pane = await tmuxPaneForPid(host.pid, await tmuxPanes());
		if (!pane) throw new Error("tmux 밖에서 실행 중이라 자동으로 재시작할 수 없습니다");
		const cwd = await fs.readlink(`/proc/${host.pid}/cwd`);
		const argv = (await fs.readFile(`/proc/${host.pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
		const name = hostName(host);
		logRestart(`${name}: ${reason} — 재시작합니다 (${host.runningVersion ?? "이전 버전"} → 새 버전)`);

		const paneRoot = pane.panePid === host.pid;
		// Keep the pane (and its tmux session) alive after omp exits so it can be respawned in place.
		if (paneRoot) await tmux(["set-option", "-p", "-t", pane.paneId, "remain-on-exit", "on"]);
		try {
			process.kill(host.pid, "SIGTERM");
			if (!(await waitForExit(host.pid))) throw new Error("omp가 20초 안에 종료되지 않았습니다");
			// Look up after exit: a session's file may only be written once it has content.
			const sessionFile = await findSessionFile(host.sessionId, argv);
			if (!sessionFile) logRestart(`${name}: 저장된 대화가 없어 새 세션으로 시작합니다`);
			const cmd = restartCommand(argv, host, sessionFile);
			if (paneRoot) {
				await tmux(["respawn-pane", "-t", pane.paneId, "-c", cwd, cmd]);
			} else {
				// omp ran under a shell: type the command back into it.
				await tmux(["send-keys", "-t", pane.paneId, "-l", `cd ${shellQuote(cwd)} && ${cmd}`]);
				await tmux(["send-keys", "-t", pane.paneId, "Enter"]);
			}
		} finally {
			if (paneRoot) await tmux(["set-option", "-p", "-t", pane.paneId, "remain-on-exit", "off"]).catch(() => {});
		}
		logRestart(`${name}: 새 버전으로 다시 시작했습니다 (tmux ${pane.session})`);
	} catch (err) {
		logRestart(`${hostName(host)}: 재시작 실패 — ${err instanceof Error ? err.message : String(err)}`);
		throw err;
	} finally {
		restarting.delete(host.instanceId);
		idleSince.delete(host.instanceId);
	}
}

/** Background work a session reported (omp-extension/activity.ts): async subagents, bash jobs, undelivered results. */
interface SessionActivity {
	pid: number;
	at: number;
	running: { type: string; label: string; startTime: number }[];
	queued: number;
	/** Thinking level the session runs at (omp collab list reports only the model). */
	thinking: string | null;
	/** Dashboard controls the session's extension carries out (0: none, 1: model, 2: + accounts). */
	control: number;
	/** provider -> identity key of the account serving the session now. */
	accounts: Record<string, string>;
	/** provider -> account chosen for the session (pinned); absent = omp chooses. */
	chosen: Record<string, string>;
}

/** `{ string: string }` from untrusted JSON (other values dropped). */
function stringRecord(v: unknown): Record<string, string> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string").slice(0, 20));
}
const sessionActivity = new Map<string, SessionActivity>();
/** Reports arrive every ≤15 s; one older than this is from a process that stopped reporting. */
const ACTIVITY_STALE_MS = 45_000;

/** The host's live report, or null when it has none (an omp started before the extension existed). */
function activityOf(h: Host): SessionActivity | null {
	const a = sessionActivity.get(h.sessionId);
	return a && a.pid === h.pid && Date.now() - a.at < ACTIVITY_STALE_MS ? a : null;
}

/** Running background jobs plus results waiting to be handed to the session. */
function backgroundWork(h: Host): number {
	const a = activityOf(h);
	return a ? a.running.length + a.queued : 0;
}

/**
 * Idle = no turn in flight, no question waiting, and no background work (subagents still running
 * after the turn ended would be cut off by a restart); `busy: null` (unknown) never counts.
 */
function isIdle(h: Host): boolean {
	return h.busy === false && !h.inputRequired && backgroundWork(h) === 0;
}

// ---------- session control: model / thinking changes carried out by omp-extension/activity.ts ----------

interface SessionControl {
	id: string;
	model?: string;
	thinking?: string;
	/** provider -> account identity key, "" to let omp choose again. */
	accounts?: Record<string, string>;
	/** A message for the session, as if typed (control >= 3). */
	prompt?: string;
}

const CONTROL_POLL_MS = 25_000;
const CONTROL_RESULT_MS = 15_000;
/** Per session: the change not yet picked up, the extension's waiting long-poll, and callers awaiting results. */
const controls = new Map<string, { pending: SessionControl | null; poller: ((c: SessionControl | null) => void) | null }>();
const controlResults = new Map<string, (r: { ok: boolean; error?: string }) => void>();

function controlSlot(sessionId: string) {
	let slot = controls.get(sessionId);
	if (!slot) controls.set(sessionId, (slot = { pending: null, poller: null }));
	return slot;
}

/** The extension's long-poll: a queued change at once, else wait for one (204 after a while). */
async function pollControl(sessionId: string): Promise<Response> {
	const slot = controlSlot(sessionId);
	slot.poller?.(null); // a newer poll replaces an older one (the session restarted its loop)
	if (slot.pending) {
		const c = slot.pending;
		slot.pending = null;
		return json(c);
	}
	const c = await new Promise<SessionControl | null>(resolve => {
		const timer = setTimeout(() => resolve(null), CONTROL_POLL_MS);
		slot.poller = v => {
			clearTimeout(timer);
			resolve(v);
		};
	});
	slot.poller = null;
	return c ? json(c) : new Response(null, { status: 204 });
}

/** Hands a change to the session and waits for its extension to report how it went. */
function sendControl(sessionId: string, change: Omit<SessionControl, "id">): Promise<{ ok: boolean; error?: string }> {
	const c: SessionControl = { id: crypto.randomUUID(), ...change };
	const slot = controlSlot(sessionId);
	if (slot.poller) slot.poller(c);
	else slot.pending = c; // picked up by the next poll (the loop re-polls right after each answer)
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			controlResults.delete(c.id);
			if (slot.pending?.id === c.id) slot.pending = null;
			resolve({ ok: false, error: "세션이 응답하지 않습니다. 잠시 뒤 다시 시도하세요" });
		}, CONTROL_RESULT_MS);
		controlResults.set(c.id, r => {
			clearTimeout(timer);
			resolve(r);
		});
	});
}

/**
 * Changes a running session's model, thinking level and/or accounts. A session whose extension
 * predates a control is restarted (conversation restored) to pick the change up: the extension
 * reads the session's saved account choice as it starts.
 */
async function changeModel(instanceId: string, req: Request): Promise<Response> {
	const host = (await listHosts()).find(h => h.instanceId === instanceId);
	if (!host) return json({ error: "호스트를 찾을 수 없습니다" }, 404);
	const control = activityOf(host)?.control ?? 0;
	const body = await readJsonBody(req);
	const model = typeof body.model === "string" ? body.model.trim() : "";
	const thinking = typeof body.thinking === "string" ? body.thinking.trim() : "";
	const accounts = await validAccountChoice(body.accounts);
	if (typeof accounts === "string") return json({ error: accounts }, 400);
	const hasAccounts = Object.keys(accounts).length > 0;
	if (!model && !thinking && !hasAccounts) return json({ error: "바꿀 항목을 고르세요" }, 400);
	if (model && !(await listModels()).some(m => m.selector === model)) return json({ error: `쓸 수 있는 모델이 아닙니다: ${model}` }, 400);
	if (thinking && !THINKING_LEVELS.has(thinking)) return json({ error: "thinking 값이 올바르지 않습니다" }, 400);

	if ((model || thinking) && control < 1) {
		return json({ error: "이 세션은 대시보드 연결 기능이 생기기 전에 시작되어 모델을 바꿀 수 없습니다. 세션을 다시 시작하면 됩니다" }, 409);
	}
	const needsRestart = hasAccounts && control < 2;
	if (needsRestart) {
		if (!host.restartable) return json({ error: "tmux 밖에서 실행 중이라 다시 시작할 수 없습니다" }, 409);
		if (!isIdle(host)) {
			const bg = backgroundWork(host);
			return json({ error: bg
				? `적용하려면 세션을 다시 시작해야 하는데, 백그라운드 작업 ${bg}개가 아직 진행 중입니다. 끝난 뒤 다시 시도하세요`
				: "적용하려면 세션을 다시 시작해야 하는데, 지금 작업 중입니다. 쉬고 있을 때 다시 시도하세요" }, 409);
		}
	}
	// Model and thinking go through the live session when it can take them (they are saved with it).
	if ((model || thinking) && control >= 1) {
		const r = await sendControl(host.sessionId, { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) });
		if (!r.ok) return json({ error: r.error ?? "바꾸지 못했습니다" }, 502);
	}
	if (hasAccounts && !needsRestart) {
		const r = await sendControl(host.sessionId, { accounts });
		if (!r.ok) return json({ error: r.error ?? "계정을 바꾸지 못했습니다" }, 502);
	}
	// Remembered for the session (restarts) and as its project's choice for new sessions.
	if (hasAccounts) await rememberAccounts(accounts, host.cwd, host.sessionId);
	if (!needsRestart) return json({ ok: true });
	try {
		await restartHost(host, "대시보드에서 계정 변경");
	} catch (err) {
		return json({ error: `다시 시작하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` }, 502);
	}
	return json({ ok: true, restarted: true });
}

// ---------- accounts: which logged-in account a session / project uses ----------

interface AccountInfo {
	provider: string;
	/** Identity key, `email:<address>|org:<id>` (what `omp usage accounts` prints and pins match). */
	key: string;
	email: string;
	orgName: string;
}

const ACCOUNT_PREFS_FILE = path.join(DATA_DIR, "accounts.json");
const ACCOUNTS_TTL_MS = 60_000;
const ACCOUNT_PREFS_SESSIONS_LIMIT = 500;

/** provider -> identity key, per project folder and per session (a session's own choice wins). */
let accountPrefs: { byCwd: Record<string, Record<string, string>>; bySession: Record<string, Record<string, string>> } = { byCwd: {}, bySession: {} };
try {
	accountPrefs = { ...accountPrefs, ...JSON.parse(await fs.readFile(ACCOUNT_PREFS_FILE, "utf8")) };
} catch {}

let accountsCache: { at: number; list: AccountInfo[] } | null = null;
async function listAccounts(): Promise<AccountInfo[]> {
	if (accountsCache && Date.now() - accountsCache.at < ACCOUNTS_TTL_MS) return accountsCache.list;
	const { accounts } = await ompJson<{ accounts: { provider: string; identityKey: string | null; orgName?: string }[] }>(["usage", "accounts", "--json"]);
	const list = accounts
		.filter((a): a is typeof a & { identityKey: string } => typeof a.identityKey === "string" && a.identityKey.startsWith("email:"))
		.map(a => ({
			provider: a.provider,
			key: a.identityKey,
			email: /^email:([^|]+)/.exec(a.identityKey)![1]!,
			orgName: a.orgName ?? "",
		}));
	accountsCache = { at: Date.now(), list };
	return list;
}

/** `{ provider: key | "" }` from a request, checked against the logged-in accounts; an error message otherwise. */
async function validAccountChoice(raw: unknown): Promise<Record<string, string> | string> {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) return "accounts 형식이 올바르지 않습니다";
	const out: Record<string, string> = {};
	const known = await listAccounts();
	for (const [provider, key] of Object.entries(raw)) {
		if (typeof key !== "string") return "accounts 형식이 올바르지 않습니다";
		if (key && !known.some(a => a.provider === provider && a.key === key)) return `로그인된 계정이 아닙니다: ${key}`;
		out[provider] = key;
	}
	return out;
}

async function rememberAccounts(choice: Record<string, string>, cwd: string, sessionId?: string): Promise<void> {
	const apply = (map: Record<string, Record<string, string>>, id: string) => {
		const next = { ...map[id] };
		for (const [provider, key] of Object.entries(choice)) {
			if (key) next[provider] = key;
			else delete next[provider];
		}
		if (Object.keys(next).length) map[id] = next;
		else delete map[id];
	};
	apply(accountPrefs.byCwd, cwd);
	if (sessionId) {
		apply(accountPrefs.bySession, sessionId);
		const ids = Object.keys(accountPrefs.bySession);
		for (const id of ids.slice(0, Math.max(0, ids.length - ACCOUNT_PREFS_SESSIONS_LIMIT))) delete accountPrefs.bySession[id];
	}
	await fs.mkdir(DATA_DIR, { recursive: true });
	await fs.writeFile(ACCOUNT_PREFS_FILE, JSON.stringify(accountPrefs, null, 2), { mode: 0o600 });
}

/** The accounts a starting session should pin: its own earlier choice, else its project's. */
function accountsFor(sessionId: string, cwd: string): Record<string, string> {
	return accountPrefs.bySession[sessionId] ?? accountPrefs.byCwd[path.resolve(cwd)] ?? {};
}

async function applyUpdatesWhenIdle(): Promise<void> {
	if (!applySettings.autoRestart) return;
	let hosts: Host[];
	try {
		hosts = await listHosts();
	} catch {
		return;
	}
	const now = Date.now();
	const live = new Set(hosts.map(h => h.instanceId));
	for (const id of idleSince.keys()) if (!live.has(id)) idleSince.delete(id);
	for (const h of hosts) {
		if (!h.stale || !h.restartable || restarting.has(h.instanceId)) continue;
		if (!isIdle(h)) {
			idleSince.delete(h.instanceId);
			continue;
		}
		const since = idleSince.get(h.instanceId) ?? now;
		idleSince.set(h.instanceId, since);
		if (now - since < APPLY_IDLE_MS) continue;
		await restartHost(h, `${Math.round((now - since) / 60_000)}분 이상 쉬는 중`).catch(() => {});
	}
}

async function sessionUpdateStatus() {
	const hosts = await listHosts().catch(() => [] as Host[]);
	const now = Date.now();
	return {
		autoRestart: applySettings.autoRestart,
		idleMinutes: APPLY_IDLE_MS / 60_000,
		sessions: hosts
			.filter(h => h.stale)
			.map(h => ({
				instanceId: h.instanceId,
				sessionId: h.sessionId,
				name: hostName(h),
				cwd: h.cwd,
				runningVersion: h.runningVersion ?? null,
				idle: isIdle(h),
				background: backgroundWork(h),
				restartable: h.restartable === true,
				restarting: restarting.has(h.instanceId),
				idleFor: idleSince.has(h.instanceId) ? now - idleSince.get(h.instanceId)! : 0,
			})),
		log: restartLog,
	};
}

async function saveApplySettings(req: Request): Promise<Response> {
	const body = await readJsonBody(req);
	if (typeof body.autoRestart !== "boolean") return json({ error: "autoRestart는 true 또는 false여야 합니다" }, 400);
	applySettings = { ...applySettings, autoRestart: body.autoRestart };
	await fs.mkdir(path.dirname(APPLY_SETTINGS_FILE), { recursive: true });
	await fs.writeFile(APPLY_SETTINGS_FILE, JSON.stringify(applySettings, null, 2));
	return json(await sessionUpdateStatus());
}

const TITLE_MAX = 80;
const RENAME_WAIT_MS = 15_000;

/** Text in the omp TUI composer (the line after `╰─`), so a rename never mixes with a half-typed prompt. */
async function composerText(paneId: string): Promise<string | null> {
	const proc = Bun.spawn(["tmux", "capture-pane", "-p", "-t", paneId], { stdout: "pipe", stderr: "ignore" });
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) return null;
	const line = out.split("\n").findLast(l => l.trimStart().startsWith("╰─"));
	if (line === undefined) return null;
	// Typed text starts right after `╰─ `; an empty composer shows only a right-aligned hint after a wide gap.
	const rest = line.trimStart().slice(2);
	return /^\s{3,}|^\s*$/.test(rest) ? "" : rest.split(/\s{3,}/)[0]!.trim();
}

/** Rename a running session by typing `/rename <title>` into its TUI (guests cannot run it over collab). */
async function renameHost(instanceId: string, req: Request): Promise<Response> {
	const body = await readJsonBody(req);
	const title = typeof body.title === "string" ? body.title.trim() : "";
	if (!title) return json({ error: "제목을 입력하세요" }, 400);
	if (/[\r\n\t]/.test(title) || title.length > TITLE_MAX) {
		return json({ error: `제목은 한 줄, ${TITLE_MAX}자 이하여야 합니다` }, 400);
	}
	const host = (await listHosts()).find(h => h.instanceId === instanceId);
	if (!host) return json({ error: "호스트를 찾을 수 없습니다" }, 404);
	// Typing a command only needs a quiet composer; background subagents do not mind.
	if (host.busy !== false || host.inputRequired) return json({ error: "작업 중인 세션은 제목을 바꿀 수 없습니다. 쉬고 있을 때 다시 시도하세요" }, 409);
	const pane = await tmuxPaneForPid(host.pid, await tmuxPanes());
	if (!pane) return json({ error: "tmux 밖에서 실행 중이라 제목을 바꿀 수 없습니다" }, 409);
	const typed = await composerText(pane.paneId);
	if (typed === null) return json({ error: "세션 입력창을 찾을 수 없습니다 (다른 화면이 열려 있을 수 있습니다)" }, 409);
	if (typed) return json({ error: "터미널 입력창에 작성 중인 내용이 있어 제목을 바꿀 수 없습니다" }, 409);

	await tmux(["send-keys", "-t", pane.paneId, "-l", `/rename ${title}`]);
	await tmux(["send-keys", "-t", pane.paneId, "Enter"]);
	// omp may prefix a generated card (`<icon> CODE: `), so wait for any change rather than an exact match.
	const deadline = Date.now() + RENAME_WAIT_MS;
	while (Date.now() < deadline) {
		await Bun.sleep(1000);
		const now = (await listHosts()).find(h => h.instanceId === instanceId);
		if (now && now.sessionName !== host.sessionName && now.sessionName?.includes(title)) {
			return json({ ok: true, sessionName: now.sessionName });
		}
	}
	return json({ ok: true, sessionName: null });
}

async function restartHostNow(instanceId: string): Promise<Response> {
	const host = (await listHosts()).find(h => h.instanceId === instanceId);
	if (!host) return json({ error: "호스트를 찾을 수 없습니다" }, 404);
	if (!host.restartable) return json({ error: "tmux 밖에서 실행 중이라 재시작할 수 없습니다" }, 409);
	if (!isIdle(host)) {
		const bg = backgroundWork(host);
		return json({ error: bg ? `서브에이전트 등 백그라운드 작업 ${bg}개가 아직 진행 중이라 재시작할 수 없습니다` : "작업 중인 세션은 재시작할 수 없습니다. 쉬고 있을 때 다시 시도하세요" }, 409);
	}
	try {
		await restartHost(host, "수동 요청");
	} catch (err) {
		return json({ error: `재시작 실패: ${err instanceof Error ? err.message : String(err)}` }, 502);
	}
	return json({ ok: true });
}

// ---------- plan review relay (omp extension <-> dashboard) ----------

interface PlanAnswer {
	/** Distinguishes a re-delivered answer from a new one (the extension applies each id once). */
	id: string;
	choice: string;
	feedback?: string;
	role?: string;
}

interface PlanReview {
	reviewId: string;
	sessionId: string;
	title: string;
	planFilePath: string;
	options: { id: string; label: string; disabled: boolean }[];
	tiers: { role: string; provider: string; model: string; thinkingLevel?: string }[];
	createdAt: number;
	/** Answer picked on the dashboard, waiting for the extension to collect it. */
	answer: PlanAnswer | null;
	answerWaiters: Set<(answer: PlanAnswer | null) => void>;
	resultWaiter: ((ok: boolean) => void) | null;
}

const PLAN_POLL_HOLD_MS = 25_000;
const PLAN_RESULT_WAIT_MS = 10_000;
const PLAN_CHOICES: Record<string, true> = { execute: true, compact: true, keep: true, refine: true, save: true };
const REVIEW_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const planReviews = new Map<string, PlanReview>();

function isLoopback(server: Server, req: Request): boolean {
	const ip = server.requestIP(req)?.address ?? "";
	return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function internalAuthorized(server: Server, req: Request): boolean {
	const given = Buffer.from(req.headers.get("x-omp-web-token") ?? "");
	const expected = Buffer.from(INTERNAL_TOKEN);
	return isLoopback(server, req) && given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function closeReview(reviewId: string): void {
	const review = planReviews.get(reviewId);
	if (!review) return;
	planReviews.delete(reviewId);
	for (const wake of review.answerWaiters) wake(null);
	review.resultWaiter?.(false);
}

function openReviewFor(sessionId: string): PlanReview | undefined {
	for (const r of planReviews.values()) if (r.sessionId === sessionId) return r;
	return undefined;
}

// ---------- control bot: dashboard actions for omp-extension/control-tools.ts ----------

const BOT_READ_MAX_CHARS = 12_000;

/** A request body for reusing the dashboard's own route handlers. */
const fakeRequest = (body: unknown) => new Request("http://omp-web.local/", { method: "POST", body: JSON.stringify(body ?? {}) });

function hostSummary(h: Host) {
	const a = activityOf(h);
	const review = openReviewFor(h.sessionId);
	const bg = backgroundWork(h);
	return {
		ref: h.instanceId,
		title: hostName(h),
		cwd: h.cwd,
		computer: h.node?.name ?? "이 서버",
		status: h.busy ? "작업 중" : bg ? `백그라운드 ${bg}개 진행 중` : h.inputRequired ? "입력 필요" : "대기",
		model: h.model ? `${h.model.provider}/${h.model.id}` : null,
		thinking: a?.thinking ?? null,
		account: a?.accounts?.[h.model?.provider ?? ""]?.replace(/^email:|\|org:.*$/g, "") ?? null,
		accountPinned: !!a?.chosen?.[h.model?.provider ?? ""],
		planReview: review ? { title: review.title, options: review.options.filter(o => !o.disabled).map(o => o.id) } : null,
		updatePending: h.stale ?? false,
		startedAt: new Date(h.startedAt).toISOString(),
	};
}

/** A session by instance id, session id (prefix), tmux name, folder, or a word of its title. */
async function resolveSessionRef(ref: unknown): Promise<Host | string> {
	const q = typeof ref === "string" ? ref.trim().toLowerCase() : "";
	if (!q) return "세션을 지정하세요 (sessions 도구의 ref, 제목 일부 또는 폴더)";
	const hosts = await allHosts();
	const exact = hosts.filter(h =>
		h.instanceId === q || h.sessionId.toLowerCase().startsWith(q) || h.tmux === q || h.cwd.toLowerCase() === q);
	if (exact.length === 1) return exact[0]!;
	const loose = hosts.filter(h => hostName(h).toLowerCase().includes(q) || path.basename(h.cwd).toLowerCase().includes(q));
	if (loose.length === 1) return loose[0]!;
	const list = (exact.length ? exact : loose.length ? loose : hosts).map(h => `${h.instanceId} (${hostName(h)}, ${h.cwd})`).join("; ");
	return (exact.length || loose.length ? "여러 세션이 맞습니다: " : `'${ref}'에 맞는 세션이 없습니다. 세션: `) + list;
}

/** `{ provider: key }` from an account given by email (or part of it); "auto" lets omp choose. */
async function accountByEmail(email: unknown): Promise<Record<string, string> | string> {
	if (typeof email !== "string" || !email.trim()) return {};
	const q = email.trim().toLowerCase();
	if (q === "auto" || q === "자동") return { anthropic: "" };
	const all = await listAccounts();
	const matches = all.filter(a => a.email.toLowerCase().includes(q));
	if (matches.length !== 1) {
		return `${matches.length ? "여러 계정이 맞습니다" : "그런 계정이 없습니다"}: ${all.map(a => `${a.email} (${a.provider})`).join(", ")}`;
	}
	return { [matches[0]!.provider]: matches[0]!.key };
}

/** The session's last messages (user / assistant text, tool calls named), newest last. */
async function readSessionTail(h: Host, count: number): Promise<string> {
	if (h.node) return "원격 컴퓨터 세션의 대화는 읽을 수 없습니다";
	const argv = (await fs.readFile(`/proc/${h.pid}/cmdline`, "utf8").catch(() => "")).split("\0").filter(Boolean);
	const file = await findSessionFile(h.sessionId, argv);
	if (!file) return "아직 저장된 대화가 없습니다";
	const lines = (await Bun.file(file).text()).trimEnd().split("\n");
	const out: string[] = [];
	for (let i = lines.length - 1; i >= 0 && out.length < count; i--) {
		let e: { type?: string; message?: { role?: string; content?: unknown } };
		try {
			e = JSON.parse(lines[i]!);
		} catch {
			continue;
		}
		const role = e.message?.role;
		if (e.type !== "message" || (role !== "user" && role !== "assistant")) continue;
		const content = e.message!.content;
		const parts = typeof content === "string" ? [content] : Array.isArray(content)
			? content.map((c: { type?: string; text?: string; name?: string }) =>
				c.type === "text" ? c.text ?? "" : c.type === "toolCall" ? `[도구: ${c.name}]` : "").filter(Boolean)
			: [];
		if (parts.length) out.push(`${role === "user" ? "사용자" : "AI"}: ${parts.join(" ")}`);
	}
	const text = out.reverse().join("\n\n");
	return text.length > BOT_READ_MAX_CHARS ? "…" + text.slice(-BOT_READ_MAX_CHARS) : text || "읽을 메시지가 없습니다";
}

/** Hands the session a message: through its extension (queued after current work), else typed into tmux. */
async function sendToSession(h: Host, text: string): Promise<Response> {
	if (h.node) return json({ error: "원격 컴퓨터 세션에는 대시보드 화면(접속)에서 보내세요" }, 409);
	if ((activityOf(h)?.control ?? 0) >= 3) {
		const r = await sendControl(h.sessionId, { prompt: text });
		return r.ok ? json({ ok: true, delivered: h.busy ? "작업이 끝나면 이어서 처리됩니다" : "보냈습니다" }) : json({ error: r.error }, 502);
	}
	if (h.busy !== false || h.inputRequired) return json({ error: "이 세션은 작업 중이라 끝난 뒤 보낼 수 있습니다" }, 409);
	const pane = await tmuxPaneForPid(h.pid, await tmuxPanes());
	if (!pane) return json({ error: "tmux 밖에서 실행 중이라 보낼 수 없습니다" }, 409);
	const typed = await composerText(pane.paneId);
	if (typed === null) return json({ error: "세션 입력창을 찾을 수 없습니다 (다른 화면이 열려 있을 수 있습니다)" }, 409);
	if (typed) return json({ error: "터미널 입력창에 작성 중인 내용이 있어 보낼 수 없습니다" }, 409);
	// A bracketed paste keeps line breaks inside the message instead of submitting at each one.
	const load = Bun.spawn(["tmux", "load-buffer", "-b", "omp-web-bot", "-"], { stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "ignore" });
	if ((await load.exited) !== 0) return json({ error: "tmux 버퍼에 넣지 못했습니다" }, 502);
	await tmux(["paste-buffer", "-p", "-d", "-b", "omp-web-bot", "-t", pane.paneId]);
	await tmux(["send-keys", "-t", pane.paneId, "Enter"]);
	return json({ ok: true, delivered: "보냈습니다" });
}

async function botTool(action: string, b: Record<string, any>): Promise<Response> {
	switch (action) {
		case "sessions":
			return json({ sessions: (await allHosts()).map(hostSummary) });
		case "session.create": {
			const accounts = await accountByEmail(b.account);
			if (typeof accounts === "string") return json({ error: accounts }, 400);
			let node: string | undefined;
			if (typeof b.computer === "string" && b.computer && !/^(이 ?서버|server|local)$/i.test(b.computer)) {
				const { nodes: list } = await nodesStatus(publicBaseUrl(new URL("http://localhost")));
				const n = list.find(x => x.online && x.name.toLowerCase().includes(String(b.computer).toLowerCase()));
				if (!n) return json({ error: `연결된 컴퓨터가 아닙니다: ${b.computer}` }, 400);
				node = n.id;
			}
			const res = await createSession(fakeRequest({
				cwd: b.cwd, model: b.model, thinking: b.thinking, prompt: b.prompt, createDir: b.createDir === true,
				...(node ? { node } : { accounts }),
			}));
			if (res.status !== 201) return res;
			return json({ ok: true, ...((await res.json()) as object), note: "세션이 뜨는 데 몇 초 걸립니다. 잠시 뒤 sessions로 확인하세요" });
		}
		case "session.stop":
		case "session.restart":
		case "session.change":
		case "session.send":
		case "session.read":
		case "session.link":
		case "plan.get":
		case "plan.answer": {
			const h = await resolveSessionRef(b.session);
			if (typeof h === "string") return json({ error: h }, 404);
			if (action === "session.stop") {
				return h.node ? await remoteHostAction({ instanceId: h.instanceId, node: h.node }, "stop", fakeRequest({})) : await stopHost(h.instanceId);
			}
			if (action === "session.restart") return h.node ? json({ error: "원격 컴퓨터 세션은 다시 시작할 수 없습니다" }, 409) : await restartHostNow(h.instanceId);
			if (action === "session.change") {
				const accounts = await accountByEmail(b.account);
				if (typeof accounts === "string") return json({ error: accounts }, 400);
				if (h.node) return json({ error: "원격 컴퓨터 세션의 모델은 그 세션 화면에서 바꾸세요" }, 409);
				return await changeModel(h.instanceId, fakeRequest({ model: b.model, thinking: b.thinking, accounts }));
			}
			if (action === "session.send") {
				const text = typeof b.message === "string" ? b.message.trim() : "";
				return text ? await sendToSession(h, text) : json({ error: "보낼 내용이 없습니다" }, 400);
			}
			if (action === "session.read") {
				const n = Math.min(Math.max(Number(b.count) || 6, 1), 40);
				return json({ session: hostSummary(h), messages: await readSessionTail(h, n) });
			}
			if (action === "session.link") return json({ url: (await hostLink(h, "control")).url });
			const review = openReviewFor(h.sessionId);
			if (!review) return json({ error: "승인 대기 중인 플랜이 없습니다" }, 404);
			if (action === "plan.get") {
				return json({ title: review.title, options: review.options, tiers: review.tiers, plan: (await readPlanText(review)).slice(0, BOT_READ_MAX_CHARS) });
			}
			return await answerPlanReview(h.instanceId, fakeRequest({ reviewId: review.reviewId, choice: b.choice, feedback: b.feedback, role: b.role }));
		}
		case "usage":
			return json(await aiUsage());
		case "notifications":
			return json({ items: notifications.slice(0, Math.min(Math.max(Number(b.count) || 10, 1), 50)).map(n => ({ ...n, ts: new Date(n.ts).toISOString() })) });
		case "accounts":
			return json({ accounts: await listAccounts(), byProject: accountPrefs.byCwd });
		case "models":
			return json({ models: await listModels() });
		case "computers": {
			const { nodes: list } = await nodesStatus(publicBaseUrl(new URL("http://localhost")));
			return json({ computers: list.map(({ dirs: _dirs, ...n }) => n) });
		}
		case "dirs":
			return await listDirs(new URL(`http://x/?path=${encodeURIComponent(typeof b.path === "string" ? b.path : "")}`));
		default:
			return json({ error: `알 수 없는 동작: ${action}` }, 404);
	}
}

async function handleInternal(req: Request, server: Server, pathname: string): Promise<Response> {
	if (!internalAuthorized(server, req)) return json({ error: "forbidden" }, 403);
	const botAction = /^\/internal\/bot\/([a-z.]+)$/.exec(pathname);
	if (botAction && req.method === "POST") {
		try {
			return await botTool(botAction[1]!, await readJsonBody(req));
		} catch (err) {
			return errorResponse(err);
		}
	}
	if (pathname === "/internal/session-accounts" && req.method === "GET") {
		const u = new URL(req.url);
		return json({ accounts: accountsFor(u.searchParams.get("sessionId") ?? "", u.searchParams.get("cwd") ?? "/") });
	}
	const controlPath = /^\/internal\/session-control\/([0-9a-f-]{36})(\/result)?$/.exec(pathname);
	if (controlPath) {
		if (!controlPath[2]) return await pollControl(controlPath[1]!);
		const b = await readJsonBody(req);
		const done = typeof b.id === "string" ? controlResults.get(b.id) : undefined;
		if (done) {
			controlResults.delete(b.id as string);
			done({ ok: b.ok === true, ...(typeof b.error === "string" ? { error: b.error.slice(0, 500) } : {}) });
		}
		return json({ ok: true });
	}
	if (pathname === "/internal/session-activity" && req.method === "POST") {
		const b = await readJsonBody(req);
		if (typeof b.sessionId !== "string" || !SESSION_ID_RE.test(b.sessionId) || typeof b.pid !== "number") return json({ error: "invalid" }, 400);
		const running = (Array.isArray(b.running) ? b.running : []).slice(0, 50).map((j: Record<string, unknown>) => ({
			type: String(j?.type ?? "job").slice(0, 20),
			label: String(j?.label ?? "").slice(0, 120),
			startTime: typeof j?.startTime === "number" ? j.startTime : 0,
		}));
		sessionActivity.set(b.sessionId, {
			pid: b.pid,
			at: Date.now(),
			running,
			queued: typeof b.queued === "number" ? b.queued : 0,
			thinking: typeof b.thinking === "string" ? b.thinking.slice(0, 20) : null,
			accounts: stringRecord(b.accounts),
			chosen: stringRecord(b.chosen),
			control: typeof b.control === "number" ? b.control : 0,
		});
		return json({ ok: true });
	}
	// Remote computer tasks, for the omp-extension/remote-computer.ts tool in sessions on this server.
	if (pathname === "/internal/remote-computers" && req.method === "GET") return json({ computers: remoteComputers() });
	if (pathname === "/internal/remote-task" && req.method === "POST") {
		const b = await readJsonBody(req);
		const prompt = typeof b.task === "string" ? b.task.trim() : "";
		if (!prompt) return json({ error: "task가 비어 있습니다" }, 400);
		const r = await startRemoteTask({
			computer: typeof b.computer === "string" ? b.computer : null,
			prompt,
			key: typeof b.sessionId === "string" ? b.sessionId : "default",
			fresh: b.fresh === true,
			cwd: typeof b.cwd === "string" ? b.cwd : undefined,
			timeoutSec: typeof b.timeoutSec === "number" ? b.timeoutSec : undefined,
			model: typeof b.model === "string" && MODEL_RE.test(b.model) ? b.model : undefined,
		});
		return "error" in r ? json({ error: r.error }, 409) : json({ taskId: r.task.id, computer: r.task.nodeName });
	}
	const remoteTaskPath = /^\/internal\/remote-task\/([0-9a-f-]{36})(\/cancel)?$/.exec(pathname);
	if (remoteTaskPath) {
		if (remoteTaskPath[2]) {
			const r = await cancelRemoteTask(remoteTaskPath[1]!);
			return r.ok ? json({ ok: true }) : json({ error: r.error }, 409);
		}
		const t = remoteTask(remoteTaskPath[1]!);
		return t ? json(t) : json({ error: "작업을 찾을 수 없습니다" }, 404);
	}
	if (pathname === "/internal/plan-review" && req.method === "POST") {
		const b = await readJsonBody(req);
		if (typeof b.reviewId !== "string" || !REVIEW_ID_RE.test(b.reviewId) || typeof b.sessionId !== "string") {
			return json({ error: "invalid review" }, 400);
		}
		// A newer review for the same session replaces the old one (omp does the same).
		for (const r of [...planReviews.values()]) if (r.sessionId === b.sessionId && r.reviewId !== b.reviewId) closeReview(r.reviewId);
		if (!planReviews.has(b.reviewId)) {
			planReviews.set(b.reviewId, {
				reviewId: b.reviewId,
				sessionId: b.sessionId,
				title: typeof b.title === "string" ? b.title : "",
				planFilePath: typeof b.planFilePath === "string" ? b.planFilePath : "",
				options: Array.isArray(b.options) ? (b.options as PlanReview["options"]) : [],
				tiers: Array.isArray(b.tiers) ? (b.tiers as PlanReview["tiers"]) : [],
				createdAt: Date.now(),
				answer: null,
				answerWaiters: new Set(),
				resultWaiter: null,
			});
			const host = (await listHosts().catch(() => [] as Host[])).find(h => h.sessionId === b.sessionId);
			notify("plan", b.sessionId, host, `플랜 승인 필요 · ${host ? hostName(host) : String(b.title)}`,
				"대시보드에서 플랜을 확인하고 승인하거나 수정을 요청하세요.");
		}
		return json({ ok: true });
	}
	const m = /^\/internal\/plan-review\/([^/]+)\/(answer|result|resolved)$/.exec(pathname);
	if (!m) return json({ error: "not found" }, 404);
	const reviewId = decodeURIComponent(m[1]!);
	const review = planReviews.get(reviewId);
	if (m[2] === "resolved" && req.method === "POST") {
		closeReview(reviewId);
		return json({ ok: true });
	}
	if (!review) return json({ error: "closed" }, 410);
	if (m[2] === "answer" && req.method === "GET") {
		// The answer stays queued until the extension posts its result: a poll whose client already
		// went away (timeout, reconnect) must not swallow it. The extension dedupes by `id`.
		if (!review.answer) {
			const { promise, resolve } = Promise.withResolvers<PlanAnswer | null>();
			review.answerWaiters.add(resolve);
			const timer = setTimeout(() => resolve(null), PLAN_POLL_HOLD_MS);
			await promise;
			clearTimeout(timer);
			review.answerWaiters.delete(resolve);
			if (!planReviews.has(reviewId)) return json({ error: "closed" }, 410);
		}
		const answer = review.answer;
		if (answer) console.log(`[플랜] ${reviewId}: 답변 전달 (${answer.choice} #${answer.id})`);
		return answer ? json(answer) : new Response(null, { status: 204 });
	}
	if (m[2] === "result" && req.method === "POST") {
		const b = await readJsonBody(req);
		console.log(`[플랜] ${reviewId}: 적용 결과 ok=${b.ok === true}${typeof b.error === "string" ? ` error=${b.error}` : ""}`);
		if (review.answer && (b.answerId === undefined || b.answerId === review.answer.id)) review.answer = null;
		review.resultWaiter?.(b.ok === true);
		review.resultWaiter = null;
		return json({ ok: true });
	}
	return json({ error: "not found" }, 404);
}

/** Plan file text: `local://` paths live in the session's artifact dir. */
async function readPlanText(review: PlanReview): Promise<string> {
	let file = review.planFilePath;
	if (file.startsWith("local://")) {
		const dir = await sessionArtifactDir(review.sessionId);
		if (!dir) return "";
		file = path.join(dir, "local", file.slice("local://".length));
	}
	if (!path.isAbsolute(file) || !DOC_EXT_RE.test(file)) return "";
	return await Bun.file(file).slice(0, DOC_MAX_BYTES).text().catch(() => "");
}

/** Plan file as the dashboard shows it. */
async function readPlanHtml(review: PlanReview): Promise<string> {
	return Bun.markdown.html(await readPlanText(review), { noHtmlBlocks: true, noHtmlSpans: true });
}

async function planReviewForHost(instanceId: string): Promise<Response> {
	const host = (await listHosts()).find(h => h.instanceId === instanceId);
	if (!host) return json({ error: "호스트를 찾을 수 없습니다" }, 404);
	const review = openReviewFor(host.sessionId);
	if (!review) return json({ error: "승인 대기 중인 플랜이 없습니다" }, 404);
	const { reviewId, title, options, tiers, createdAt } = review;
	return json({ reviewId, title, options, tiers, createdAt, html: await readPlanHtml(review) });
}

async function answerPlanReview(instanceId: string, req: Request): Promise<Response> {
	const host = (await listHosts()).find(h => h.instanceId === instanceId);
	if (!host) return json({ error: "호스트를 찾을 수 없습니다" }, 404);
	const b = await readJsonBody(req);
	const review = openReviewFor(host.sessionId);
	if (!review || review.reviewId !== b.reviewId) return json({ error: "이미 처리된 플랜입니다" }, 409);
	const choice = typeof b.choice === "string" ? b.choice : "";
	const option = review.options.find(o => o.id === choice);
	if (!PLAN_CHOICES[choice] || !option || option.disabled) return json({ error: "선택할 수 없는 항목입니다" }, 400);
	const feedback = typeof b.feedback === "string" ? b.feedback.trim() : "";
	if (choice === "refine" && !feedback) return json({ error: "수정 요청 내용을 입력하세요" }, 400);
	const role = typeof b.role === "string" && b.role ? b.role : undefined;
	if (role && !review.tiers.some(t => t.role === role)) return json({ error: "선택할 수 없는 모델입니다" }, 400);

	const { promise, resolve } = Promise.withResolvers<boolean | null>();
	review.resultWaiter = ok => resolve(ok);
	review.answer = { id: crypto.randomUUID(), choice, ...(feedback ? { feedback } : {}), ...(role ? { role } : {}) };
	for (const wake of review.answerWaiters) wake(review.answer);
	const timer = setTimeout(() => resolve(null), PLAN_RESULT_WAIT_MS);
	const ok = await promise;
	clearTimeout(timer);
	if (ok === null) return json({ ok: true, pending: true }, 202);
	if (!ok) return json({ error: "omp가 이 선택을 받아들이지 않았습니다 (이미 터미널에서 처리했을 수 있습니다)" }, 409);
	return json({ ok: true });
}

// ---------- AI usage (subscription limits from `omp usage --json`) ----------

/** `omp usage` refreshes from the providers itself; this only spares a subprocess per dashboard poll. */
const USAGE_TTL_MS = 60_000;
const PROVIDER_LABELS: Record<string, string> = { anthropic: "Claude", "openai-codex": "Codex", openai: "OpenAI", google: "Gemini" };
const WINDOW_LABELS: Record<string, string> = { "5h": "5시간", "1d": "1일", "7d": "7일", "30d": "30일" };

interface UsageReportRaw {
	provider: string;
	fetchedAt?: number;
	metadata?: { email?: string; planType?: string };
	limits: {
		label?: string;
		scope?: { windowId?: string; tier?: string };
		window?: { label?: string; resetsAt?: number };
		amount?: { usedFraction?: number };
		status?: string;
	}[];
}

interface AiUsage {
	generatedAt: number;
	providers: {
		provider: string;
		name: string;
		account: string;
		plan: string;
		limits: { label: string; used: number; resetsAt: number | null; status: string }[];
	}[];
}

let usageCache: { at: number; data: AiUsage } | null = null;
let usageLoading: Promise<AiUsage> | null = null;

function usageLimitLabel(l: UsageReportRaw["limits"][number]): string {
	const id = l.scope?.windowId;
	const window = (id && WINDOW_LABELS[id]) || l.window?.label || l.label || "";
	const tier = l.scope?.tier;
	return tier ? `${tier[0]!.toUpperCase()}${tier.slice(1)} ${window}` : window;
}

function aiUsage(): Promise<AiUsage> {
	if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) return Promise.resolve(usageCache.data);
	usageLoading ??= (async () => {
		const raw = await ompJson<{ generatedAt: number; reports: UsageReportRaw[] }>(["usage", "--json"]);
		const data: AiUsage = {
			generatedAt: raw.generatedAt,
			providers: raw.reports
				.map(r => ({
					provider: r.provider,
					name: PROVIDER_LABELS[r.provider] ?? r.provider,
					account: r.metadata?.email ?? "",
					plan: r.metadata?.planType ?? "",
					limits: r.limits
						.filter(l => typeof l.amount?.usedFraction === "number")
						.map(l => ({
							label: usageLimitLabel(l),
							used: l.amount!.usedFraction!,
							resetsAt: l.window?.resetsAt ?? null,
							status: l.status ?? "ok",
						})),
				}))
				.filter(p => p.limits.length)
				.sort((a, b) => providerRank(a.provider) - providerRank(b.provider)),
		};
		usageCache = { at: Date.now(), data };
		return data;
	})().finally(() => {
		usageLoading = null;
	});
	return usageLoading;
}

/** Providers in PROVIDER_LABELS order (Claude first), unknown ones after. */
function providerRank(provider: string): number {
	const i = Object.keys(PROVIDER_LABELS).indexOf(provider);
	return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

// ---------- notifications: history + Web Push ----------

const NOTIFY_POLL_MS = 5_000;
/** Short turns (a quick answer) do not notify. */
const NOTIFY_MIN_TURN_MS = 20_000;

const PUBLIC_ASSETS: Record<string, { file: string; type: string }> = {
	"/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
	"/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json" },
	"/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
};

/**
 * Per host: when the current piece of work started (a turn, then any background subagents/jobs it
 * left running and the turns their results wake), how many polls in a row found it all settled,
 * and whether background work was seen along the way.
 */
const turnState = new Map<string, { busySince: number | null; idlePolls: number; inputRequired: boolean; sawBackground: boolean }>();

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}초`;
	if (s < 3600) return `${Math.floor(s / 60)}분 ${s % 60}초`;
	return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
}

type NotificationKind = "done" | "input" | "plan";

interface NotificationEntry {
	id: string;
	ts: number;
	kind: NotificationKind;
	title: string;
	body: string;
	sessionId: string;
	name: string;
	cwd: string;
}

const NOTIFICATIONS_FILE = path.join(DATA_DIR, "notifications.json");
const NOTIFICATIONS_LIMIT = 200;
const NOTIFICATION_ID_RE = /^[0-9a-f]{16}$/;

/** Newest first; kept even without push devices so the dashboard can list them. */
let notifications: NotificationEntry[] = [];
try {
	notifications = JSON.parse(await fs.readFile(NOTIFICATIONS_FILE, "utf8"));
} catch {}

async function saveNotifications(): Promise<void> {
	await fs.mkdir(DATA_DIR, { recursive: true });
	await fs.writeFile(NOTIFICATIONS_FILE, JSON.stringify(notifications), { mode: 0o600 });
}

/** Records the event and pushes it; the push opens `/n/<id>`, which leads to the session or plan. */
function notify(kind: NotificationKind, sessionId: string, host: Host | undefined, title: string, body: string): void {
	const entry: NotificationEntry = {
		id: crypto.randomBytes(8).toString("hex"),
		ts: Date.now(),
		kind,
		title,
		body,
		sessionId,
		name: host ? hostName(host) : "",
		cwd: host?.cwd ?? "",
	};
	notifications.unshift(entry);
	notifications.length = Math.min(notifications.length, NOTIFICATIONS_LIMIT);
	saveNotifications().catch(err => console.error("알림 기록 저장 실패:", err));
	void broadcast({ title, body, tag: host?.instanceId ?? sessionId, url: `/n/${entry.id}`, id: entry.id, kind });
	const origin = publicOrigin();
	botNotify(title, body, origin ? `https://${origin}/n/${entry.id}` : `/n/${entry.id}`);
}

/**
 * Where a notification leads: the session itself (a fresh collab link), or the dashboard for a
 * pending plan or a session that has ended (`/?n=<id>` explains it there).
 */
async function openNotification(id: string): Promise<Response> {
	const entry = NOTIFICATION_ID_RE.test(id) ? notifications.find(n => n.id === id) : undefined;
	if (!entry) return redirect("/");
	const host = (await allHosts()).find(h => h.sessionId === entry.sessionId);
	if (!host || (entry.kind === "plan" && openReviewFor(entry.sessionId))) return redirect(`/?n=${entry.id}`);
	return redirect((await hostLink(host, host.access === "view" ? "view" : "control")).url);
}

async function watchTurns(): Promise<void> {
	let hosts: Host[];
	try {
		hosts = await allHosts();
	} catch {
		return;
	}
	const now = Date.now();
	const live = new Set(hosts.map(h => h.instanceId));
	for (const id of turnState.keys()) if (!live.has(id)) turnState.delete(id);
	for (const h of hosts) {
		const prev = turnState.get(h.instanceId);
		const name = hostName(h);
		if (!prev) {
			// First sighting: track only, never notify for a turn that started before we watched it.
			turnState.set(h.instanceId, { busySince: null, idlePolls: 0, inputRequired: h.inputRequired, sawBackground: false });
			continue;
		}
		if (h.inputRequired && !prev.inputRequired) {
			notify("input", h.sessionId, h, `입력 필요 · ${name}`, "세션이 답을 기다리고 있습니다.");
		}
		prev.inputRequired = h.inputRequired;
		const background = backgroundWork(h);
		if (h.busy === true || background > 0) {
			// Background subagents still running after the turn ended keep the work open: their results
			// wake the session again, and only the end of all of it is "done", notified once.
			prev.busySince ??= now;
			prev.idlePolls = 0;
			if (background > 0) prev.sawBackground = true;
		} else if (h.busy === false && prev.busySince !== null) {
			// `busy` dips to false between queued follow-ups and result deliveries; require two settled polls.
			if (++prev.idlePolls < 2) continue;
			const took = now - prev.busySince - NOTIFY_POLL_MS;
			const withAgents = prev.sawBackground;
			prev.busySince = null;
			prev.idlePolls = 0;
			prev.sawBackground = false;
			// Waiting on an answer or a plan approval already sent its own notification.
			if (took >= NOTIFY_MIN_TURN_MS && !h.inputRequired && !openReviewFor(h.sessionId)) {
				notify("done", h.sessionId, h, `작업 완료 · ${name}`,
					`${formatDuration(took)} 동안 ${withAgents ? "서브에이전트까지 모두 마치고" : "작업하고"} 쉬는 중입니다.`);
			}
		}
	}
}

// ---------- relay settings & certificate ----------

interface RelaySettings {
	domain: string;
	email: string;
	cfToken: string;
	httpsPort: number;
	/** Point the domain's A record at `lanIp` before issuing. */
	dnsA: boolean;
	lanIp: string;
	/** `https://host[:port]` served by an external reverse proxy in front of the relay port; overrides own HTTPS. */
	publicUrl: string;
}

interface TlsCert {
	certPem: string;
	keyPem: string;
	domain: string;
	notAfter: number;
}

async function loadRelaySettings(): Promise<RelaySettings> {
	const defaults: RelaySettings = {
		domain: "",
		email: "",
		cfToken: "",
		httpsPort: 7443,
		dnsA: true,
		lanIp: lanIp(),
		publicUrl: "",
	};
	try {
		return { ...defaults, ...JSON.parse(await fs.readFile(RELAY_SETTINGS_FILE, "utf8")) };
	} catch {
		return defaults;
	}
}

async function loadTlsCert(): Promise<TlsCert | null> {
	try {
		const certPem = await fs.readFile(TLS_CERT_FILE, "utf8");
		const keyPem = await fs.readFile(TLS_KEY_FILE, "utf8");
		return { certPem, keyPem, domain: certificateDomains(certPem)[0] ?? "", notAfter: certificateNotAfter(certPem) };
	} catch {
		return null;
	}
}

let relaySettings = await loadRelaySettings();
if (relaySettings.publicUrl) setVapidSubject(relaySettings.publicUrl);
let tlsCert = await loadTlsCert();
let httpsServer: Server | null = null;
let httpsError: string | null = null;
const certJob = { status: "idle" as "idle" | "issuing" | "error", error: null as string | null, log: [] as string[] };

function publicOrigin(): string | null {
	if (relaySettings.publicUrl) return new URL(relaySettings.publicUrl).host;
	if (!httpsServer) return null;
	const { domain, httpsPort } = relaySettings;
	return httpsPort === 443 ? domain : `${domain}:${httpsPort}`;
}

function startHttps(): void {
	httpsServer?.stop();
	httpsServer = null;
	httpsError = null;
	if (!tlsCert || tlsCert.domain !== relaySettings.domain) return;
	try {
		httpsServer = Bun.serve({
			hostname: HOST,
			port: relaySettings.httpsPort,
			tls: { cert: tlsCert.certPem, key: tlsCert.keyPem },
			fetch: handle,
			websocket: relayWebsocket,
		});
	} catch (err) {
		httpsError = `HTTPS 포트 ${relaySettings.httpsPort}를 열 수 없습니다: ${err instanceof Error ? err.message : String(err)}`;
		console.error(httpsError);
	}
}

/**
 * Hosts on the local relay mint `http://127.0.0.1:<port>/#ws://127.0.0.1:<port>/r/<room>.<key>`;
 * rewrite to the HTTPS origin so other devices can join. Other relays (my.omp.sh) pass through.
 */
function publicLink(url: string): { url: string; localOnly: boolean } {
	const fragment = url.slice(url.indexOf("#") + 1);
	const m = /^ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)(\/r\/.+)$/.exec(fragment);
	if (!url.includes("#") || !m || Number(m[1]) !== PORT) return { url, localOnly: false };
	const origin = publicOrigin();
	if (!origin) return { url, localOnly: true };
	return { url: `https://${origin}${CLIENT_PATH}#${origin}${m[2]}`, localOnly: false };
}

function relayStatus() {
	const { domain, email, httpsPort, dnsA, lanIp, cfToken, publicUrl } = relaySettings;
	const origin = publicOrigin();
	return {
		settings: { domain, email, httpsPort, dnsA, lanIp, publicUrl, hasToken: cfToken !== "" },
		localRelayUrl: `ws://127.0.0.1:${PORT}`,
		cert: tlsCert ? { domain: tlsCert.domain, notAfter: tlsCert.notAfter } : null,
		httpsUrl: origin ? `https://${origin}` : null,
		httpsError,
		job: certJob,
	};
}

async function saveRelaySettings(req: Request): Promise<Response> {
	const body = await readJsonBody(req);
	// Omitted fields keep their stored value; an explicit "" clears domain/email/publicUrl.
	const domain = typeof body.domain === "string" ? body.domain.trim().toLowerCase() : relaySettings.domain;
	if (domain && !DOMAIN_RE.test(domain)) return json({ error: "도메인 형식이 올바르지 않습니다" }, 400);
	const email = typeof body.email === "string" ? body.email.trim() : relaySettings.email;
	if (email && !EMAIL_RE.test(email)) return json({ error: "이메일 형식이 올바르지 않습니다" }, 400);
	const httpsPort = Number(body.httpsPort ?? relaySettings.httpsPort);
	if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535 || httpsPort === PORT) {
		return json({ error: `HTTPS 포트는 1~65535 사이이며 ${PORT}와 달라야 합니다` }, 400);
	}
	const lanIpValue = typeof body.lanIp === "string" ? body.lanIp.trim() : relaySettings.lanIp;
	if (!IPV4_RE.test(lanIpValue)) return json({ error: "A 레코드 IP 형식이 올바르지 않습니다" }, 400);
	// Empty token keeps the stored one; the token is never sent back to the browser.
	const cfToken = typeof body.cfToken === "string" && body.cfToken.trim() ? body.cfToken.trim() : relaySettings.cfToken;
	let publicUrl = typeof body.publicUrl === "string" ? "" : relaySettings.publicUrl;
	if (typeof body.publicUrl === "string" && body.publicUrl.trim()) {
		let parsed: URL | null = null;
		try {
			parsed = new URL(body.publicUrl.trim());
		} catch {}
		if (!parsed || parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
			return json({ error: "외부 주소는 https://도메인[:포트] 형식이어야 합니다 (경로 없이)" }, 400);
		}
		publicUrl = parsed.origin;
	}
	const dnsA = typeof body.dnsA === "boolean" ? body.dnsA : relaySettings.dnsA;
	const next: RelaySettings = { domain, email, cfToken, httpsPort, dnsA, lanIp: lanIpValue, publicUrl };
	const restart = next.domain !== relaySettings.domain || next.httpsPort !== relaySettings.httpsPort;
	await fs.mkdir(DATA_DIR, { recursive: true });
	await fs.writeFile(RELAY_SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
	relaySettings = next;
	if (next.publicUrl) setVapidSubject(next.publicUrl);
	if (restart) startHttps();
	return json(relayStatus());
}

async function issueCert(): Promise<void> {
	const s = relaySettings;
	certJob.status = "issuing";
	certJob.error = null;
	certJob.log = [];
	const log = (message: string) => {
		certJob.log.push(`[${new Date().toLocaleTimeString("ko-KR")}] ${message}`);
		console.log(`[인증서] ${message}`);
	};
	try {
		const dns = cloudflareDns(s.cfToken);
		if (s.dnsA) {
			log(`A 레코드 설정: ${s.domain} → ${s.lanIp}`);
			await dns.upsertA(s.domain, s.lanIp);
		}
		const issued = await issueCertificate({
			directoryUrl: ACME_DIRECTORY,
			domain: s.domain,
			email: s.email || undefined,
			accountKeyFile: ACME_ACCOUNT_FILE,
			dns,
			log,
		});
		await fs.mkdir(path.dirname(TLS_CERT_FILE), { recursive: true });
		await fs.writeFile(TLS_KEY_FILE, issued.keyPem, { mode: 0o600 });
		await fs.writeFile(TLS_CERT_FILE, issued.certPem);
		tlsCert = { certPem: issued.certPem, keyPem: issued.keyPem, domain: s.domain, notAfter: issued.notAfter };
		startHttps();
		if (httpsError) throw new Error(httpsError);
		if (httpsServer) log(`HTTPS 서비스 시작: https://${publicOrigin()}`);
		certJob.status = "idle";
	} catch (err) {
		certJob.status = "error";
		certJob.error = err instanceof Error ? err.message : String(err);
		log(`실패: ${certJob.error}`);
	}
}

function startIssue(): Response {
	if (certJob.status === "issuing") return json({ error: "이미 인증서를 발급하는 중입니다" }, 409);
	if (!relaySettings.domain || !relaySettings.cfToken) {
		return json({ error: "도메인과 Cloudflare API 토큰을 먼저 저장하세요" }, 400);
	}
	void issueCert();
	return json(relayStatus(), 202);
}

function renewIfDue(): void {
	const { domain, cfToken } = relaySettings;
	if (certJob.status === "issuing" || !domain || !cfToken || tlsCert?.domain !== domain) return;
	if (tlsCert.notAfter - Date.now() < RENEW_BEFORE_MS) void issueCert();
}

async function stopHost(instanceId: string): Promise<Response> {
	const host = (await listHosts()).find(h => h.instanceId === instanceId);
	if (!host) return json({ error: "호스트를 찾을 수 없습니다" }, 404);
	try {
		process.kill(host.pid, "SIGTERM");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return json({ error: "호스트를 찾을 수 없습니다" }, 404);
		throw err;
	}
	return json({ ok: true, pid: host.pid });
}

async function createSession(req: Request): Promise<Response> {
	const body = await readJsonBody(req);
	const rawCwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
	const nodeId = typeof body.node === "string" && body.node ? body.node : null;
	// A remote computer has its own paths (and `~`); its agent checks them.
	if (!rawCwd || (!nodeId && !path.isAbsolute(rawCwd))) return json({ error: "cwd는 절대경로여야 합니다" }, 400);
	const cwd = nodeId ? rawCwd : path.resolve(rawCwd);

	const model = typeof body.model === "string" ? body.model.trim() : "";
	if (model && !MODEL_RE.test(model)) return json({ error: "model 형식이 올바르지 않습니다" }, 400);
	const thinking = typeof body.thinking === "string" ? body.thinking.trim() : "";
	if (thinking && !THINKING_LEVELS.has(thinking)) return json({ error: "thinking 값이 올바르지 않습니다" }, 400);
	// Accounts are this server's logins; a remote computer uses its own.
	const accounts = nodeId ? {} : await validAccountChoice(body.accounts);
	if (typeof accounts === "string") return json({ error: accounts }, 400);

	const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
	if (prompt.length > 4000) return json({ error: "prompt는 4000자 이하여야 합니다" }, 400);

	if (nodeId) {
		if (!nodeOnline(nodeId)) return json({ error: "원격 컴퓨터가 연결되어 있지 않습니다" }, 409);
		const tmux = TMUX_PREFIX + Date.now().toString(36);
		const r = await nodeCommand(nodeId, "new", { tmux, cwd, model, thinking, prompt, createDir: body.createDir === true });
		if (r.ok) return json({ ...(r.data && typeof r.data === "object" ? r.data : {}), tmux, node: nodeId }, 201);
		return json({ error: r.error, ...(r.code ? { code: r.code, cwd } : {}) }, r.code === "cwd_missing" ? 409 : 502);
	}

	// Validate everything else first so a rejected request never leaves a directory behind.
	// A missing directory is only created when the client confirmed it (`createDir: true`).
	let created = false;
	try {
		if (!(await fs.stat(cwd)).isDirectory()) {
			return json({ error: `디렉터리가 아닌 파일이 이미 있습니다: ${cwd}` }, 400);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			return json({ error: `작업 디렉터리를 확인할 수 없습니다: ${(err as Error).message}` }, 400);
		}
		if (body.createDir !== true) {
			return json({ error: `작업 디렉터리가 없습니다: ${cwd}`, code: "cwd_missing", cwd }, 409);
		}
		try {
			await fs.mkdir(cwd, { recursive: true });
			created = true;
		} catch (mkErr) {
			return json({ error: `작업 디렉터리를 만들 수 없습니다: ${(mkErr as Error).message}` }, 400);
		}
	}

	// The project's choice: the new session's extension reads it at start and pins those accounts.
	if (Object.keys(accounts).length) await rememberAccounts(accounts, cwd);
	return startOmpInTmux(
		cwd,
		(model ? ` --model ${shellQuote(model)}` : "") + (thinking ? ` --thinking ${shellQuote(thinking)}` : "") +
			(prompt ? ` -- ${shellQuote(prompt)}` : ""),
		{ created },
	);
}

/** Launch `omp --config <overlay><extraArgs>` in a detached tmux session rooted at `cwd`. */
async function startOmpInTmux(cwd: string, extraArgs: string, extra: Record<string, unknown> = {}): Promise<Response> {
	const name = TMUX_PREFIX + Date.now().toString(36);
	const cmd = `${shellQuote(OMP_BIN!)} --config ${shellQuote(OVERLAY_PATH)}${extraArgs}`;
	const proc = Bun.spawn(["tmux", "new-session", "-d", "-s", name, "-c", cwd, "-x", "200", "-y", "50", cmd], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) return json({ error: `tmux 실행 실패: ${stderr.trim()}` }, 502);
	return json({ tmux: name, cwd, ...extra }, 201);
}

// ---------- session resume ----------

interface RecentSession {
	id: string;
	title: string | null;
	cwd: string;
	file: string;
	mtime: number;
	size: number;
	/**
	 * running: hosted on collab or held by a live omp process — resuming would make two writers.
	 * maybe: not cleanly exited and an omp process runs in its cwd (omp has no session lock to ask).
	 */
	state: "running" | "maybe" | "idle";
}

interface OmpProcess {
	cwd: string;
	cmdline: string;
	openSessionFiles: Set<string>;
}

async function runningOmpProcesses(): Promise<OmpProcess[]> {
	const procs: OmpProcess[] = [];
	for (const pid of await fs.readdir("/proc")) {
		if (!/^\d+$/.test(pid)) continue;
		try {
			if ((await fs.readFile(`/proc/${pid}/comm`, "utf8")).trim() !== "omp") continue;
			const cwd = await fs.readlink(`/proc/${pid}/cwd`);
			if (cwd.startsWith(OMP_RUN_DIR)) continue; // omp's own daemons
			const cmdline = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
			const openSessionFiles = new Set<string>();
			for (const fd of await fs.readdir(`/proc/${pid}/fd`)) {
				const target = await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
				if (target.endsWith(".jsonl")) openSessionFiles.add(target);
			}
			procs.push({ cwd, cmdline, openSessionFiles });
		} catch {} // process exited mid-scan
	}
	return procs;
}

/** Title record (line 1, rewritten in place) and session header come first; `session_exit` is last on a clean exit. */
async function readSessionMeta(file: string, size: number) {
	const head = await Bun.file(file).slice(0, SESSION_HEAD_BYTES).text();
	let title: string | null = null;
	let header: { id?: unknown; cwd?: unknown; title?: unknown } | null = null;
	for (const line of head.split("\n").slice(0, 5)) {
		let rec: { type?: string; title?: unknown };
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		if (rec.type === "title" && typeof rec.title === "string") title = rec.title;
		else if (rec.type === "session") {
			header = rec;
			break;
		}
	}
	if (typeof header?.id !== "string" || typeof header.cwd !== "string") return null;
	const tail = await Bun.file(file).slice(Math.max(0, size - SESSION_TAIL_BYTES), size).text();
	let exited = false;
	try {
		exited = JSON.parse(tail.trimEnd().split("\n").pop() ?? "").customType === "session_exit";
	} catch {}
	return {
		id: header.id,
		cwd: header.cwd,
		title: title || (typeof header.title === "string" ? header.title : null),
		exited,
	};
}

async function scanSessions(): Promise<RecentSession[]> {
	const [hosts, procs] = await Promise.all([listHosts().catch(() => [] as Host[]), runningOmpProcesses()]);
	const hostedIds = new Set(hosts.map(h => h.sessionId));
	let projects: Dirent[];
	try {
		projects = await fs.readdir(SESSIONS_DIR, { withFileTypes: true });
	} catch {
		return [];
	}
	const sessions: RecentSession[] = [];
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const dir = path.join(SESSIONS_DIR, project.name);
		let files: string[];
		try {
			files = (await fs.readdir(dir)).filter(f => SESSION_FILE_RE.test(f));
		} catch {
			continue;
		}
		for (const name of files) {
			const file = path.join(dir, name);
			try {
				const { mtimeMs, size } = await fs.stat(file);
				const meta = await readSessionMeta(file, size);
				if (!meta) continue;
				const running =
					hostedIds.has(meta.id) ||
					procs.some(p => p.openSessionFiles.has(file) || p.cmdline.includes(meta.id) || p.cmdline.includes(file));
				const maybe = !meta.exited && procs.some(p => p.cwd === meta.cwd);
				sessions.push({
					id: meta.id,
					title: meta.title,
					cwd: meta.cwd,
					file,
					mtime: mtimeMs,
					size,
					state: running ? "running" : maybe ? "maybe" : "idle",
				});
			} catch {} // unreadable or removed mid-scan
		}
	}
	sessions.sort((a, b) => b.mtime - a.mtime);
	return sessions;
}

async function resumeSession(req: Request): Promise<Response> {
	const body = await readJsonBody(req);
	const id = typeof body.id === "string" ? body.id : "";
	if (!SESSION_ID_RE.test(id)) return json({ error: "세션 ID 형식이 올바르지 않습니다" }, 400);
	const session = (await scanSessions()).find(s => s.id === id);
	if (!session) return json({ error: "세션을 찾을 수 없습니다" }, 404);
	if (session.state === "running") return json({ error: "이미 실행 중인 세션입니다" }, 409);
	if (session.state === "maybe" && body.force !== true) {
		return json(
			{
				error: "같은 디렉터리에서 실행 중인 omp가 이 세션을 쓰고 있을 수 있습니다",
				code: "maybe_running",
			},
			409,
		);
	}
	let cwdOk = false;
	try {
		cwdOk = (await fs.stat(session.cwd)).isDirectory();
	} catch {}
	if (!cwdOk) return json({ error: `세션의 작업 디렉터리가 없습니다: ${session.cwd}` }, 400);
	return startOmpInTmux(session.cwd, ` --resume ${shellQuote(session.file)}`);
}

// sessionId -> artifact dir (`<SESSIONS_DIR>/<project>/<timestamp>_<sessionId>`); `local://` files live in its `local/`.
const artifactDirCache = new Map<string, string>();
async function sessionArtifactDir(sessionId: string): Promise<string | null> {
	const cached = artifactDirCache.get(sessionId);
	if (cached) return cached;
	const suffix = `_${sessionId}`;
	let projects: Dirent[];
	try {
		projects = await fs.readdir(SESSIONS_DIR, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(path.join(SESSIONS_DIR, project.name), { withFileTypes: true });
		} catch {
			continue;
		}
		const hit = entries.find(e => e.isDirectory() && e.name.endsWith(suffix));
		if (hit) {
			const dir = path.join(SESSIONS_DIR, project.name, hit.name);
			artifactDirCache.set(sessionId, dir);
			return dir;
		}
	}
	return null;
}

// ---------- files (session `local://` artifacts + project files) ----------

type FileSource = "plan" | "project";
type FileKind = "markdown" | "image" | "file";
interface FileEntry {
	path: string;
	mtime: number;
	size: number;
	kind: FileKind;
}

const FILE_LIST_LIMIT = 3000;
const FILE_RAW_MAX_BYTES = 50 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	svg: "image/svg+xml",
};

const extOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();
const fileKind = (name: string): FileKind =>
	DOC_EXT_RE.test(name) ? "markdown" : IMAGE_TYPES[extOf(name)] ? "image" : "file";

/** `local://` files of the session (plan mode writes PLAN.md and friends here). */
async function planDocsDir(host: Host): Promise<string | null> {
	if (!SESSION_ID_RE.test(host.sessionId)) return null;
	const dir = await sessionArtifactDir(host.sessionId);
	return dir ? path.join(dir, "local") : null;
}

/** File paths under `root`, relative to it: git-tracked/unignored files in a repo, else a bounded walk. */
async function projectFilePaths(root: string): Promise<{ paths: string[]; truncated: boolean }> {
	const proc = Bun.spawn(["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code === 0) {
		const paths = [...new Set(out.split("\0").filter(p => p && !p.split("/").some(seg => DOC_SKIP_DIRS[seg])))];
		return { paths: paths.slice(0, FILE_LIST_LIMIT), truncated: paths.length > FILE_LIST_LIMIT };
	}
	const paths: string[] = [];
	let queue: { dir: string; depth: number }[] = [{ dir: "", depth: 0 }];
	let visited = 0;
	while (queue.length && paths.length < FILE_LIST_LIMIT && visited < DOC_WALK_MAX_DIRS) {
		const next: typeof queue = [];
		for (const { dir, depth } of queue) {
			if (++visited > DOC_WALK_MAX_DIRS) break;
			const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [] as Dirent[]);
			for (const e of entries) {
				if (e.name.startsWith(".")) continue;
				const rel = dir ? `${dir}/${e.name}` : e.name;
				if (e.isDirectory()) {
					if (depth < DOC_WALK_MAX_DEPTH && !DOC_SKIP_DIRS[e.name]) next.push({ dir: rel, depth: depth + 1 });
				} else if (e.isFile()) {
					paths.push(rel);
				}
			}
		}
		queue = next;
	}
	return { paths: paths.slice(0, FILE_LIST_LIMIT), truncated: paths.length >= FILE_LIST_LIMIT || queue.length > 0 };
}

async function statFiles(root: string, rels: string[]): Promise<FileEntry[]> {
	const entries = await Promise.all(
		rels.map(async rel => {
			const st = await fs.stat(path.join(root, rel)).catch(() => null);
			return st?.isFile() ? { path: rel, mtime: st.mtimeMs, size: st.size, kind: fileKind(rel) } : null;
		}),
	);
	return entries.filter((e): e is FileEntry => e !== null);
}

/** Session `local://` files, recursively (subagents may write into subfolders). */
async function planFilePaths(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [] as Dirent[]);
	return entries
		.filter(e => e.isFile())
		.map(e => path.relative(dir, path.join(e.parentPath, e.name)))
		.slice(0, FILE_LIST_LIMIT);
}

const projectFilesCache = new Map<string, { at: number; paths: string[]; truncated: boolean }>();

async function listFiles(instanceId: string): Promise<Response> {
	const host = (await listHosts()).find(h => h.instanceId === instanceId);
	if (!host) return json({ error: "호스트를 찾을 수 없습니다" }, 404);
	const planDir = await planDocsDir(host);
	let cached = projectFilesCache.get(host.cwd);
	if (!cached || Date.now() - cached.at > DOC_LIST_TTL_MS) {
		cached = { at: Date.now(), ...(await projectFilePaths(host.cwd)) };
		projectFilesCache.set(host.cwd, cached);
	}
	const [session, project] = await Promise.all([
		planDir ? statFiles(planDir, await planFilePaths(planDir)) : [],
		statFiles(host.cwd, cached.paths),
	]);
	session.sort((a, b) => b.mtime - a.mtime);
	project.sort((a, b) => a.path.localeCompare(b.path));
	return json({ root: host.cwd, session, project, projectTruncated: cached.truncated });
}

/** Resolve `source`/`path` to a real file inside the session's own directories (symlinks cannot escape). */
async function resolveHostFile(
	instanceId: string,
	url: URL,
): Promise<{ file: string; rel: string; source: FileSource; size: number; mtime: number } | Response> {
	const host = (await listHosts()).find(h => h.instanceId === instanceId);
	if (!host) return json({ error: "호스트를 찾을 수 없습니다" }, 404);
	const source = url.searchParams.get("source");
	const rel = url.searchParams.get("path") ?? "";
	const base = source === "plan" ? await planDocsDir(host) : source === "project" ? host.cwd : null;
	if (!base) return json({ error: "파일 위치가 올바르지 않습니다" }, 400);
	if (!rel || path.isAbsolute(rel)) return json({ error: "파일 경로가 올바르지 않습니다" }, 400);
	let realBase: string;
	let file: string;
	try {
		realBase = await fs.realpath(base);
		file = await fs.realpath(path.resolve(base, rel));
	} catch {
		return json({ error: "파일을 찾을 수 없습니다" }, 404);
	}
	if (!file.startsWith(realBase + path.sep)) return json({ error: "허용되지 않은 경로입니다" }, 400);
	const st = await fs.stat(file).catch(() => null);
	if (!st?.isFile()) return json({ error: "파일을 찾을 수 없습니다" }, 404);
	return { file, rel, source: source as FileSource, size: st.size, mtime: st.mtimeMs };
}

/** Viewer payload: rendered markdown, plain text, or a note that the file is binary/an image. */
async function readFileView(instanceId: string, url: URL): Promise<Response> {
	const r = await resolveHostFile(instanceId, url);
	if (r instanceof Response) return r;
	const base = { source: r.source, path: r.rel, mtime: r.mtime, size: r.size, kind: fileKind(r.rel) };
	if (base.kind === "image") return json(base);
	const truncated = r.size > DOC_MAX_BYTES;
	const bytes = new Uint8Array(await Bun.file(r.file).slice(0, DOC_MAX_BYTES).arrayBuffer());
	if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return json({ ...base, binary: true });
	const text = new TextDecoder().decode(bytes);
	if (base.kind === "markdown") {
		// Raw HTML is escaped; link/image URLs are filtered client-side.
		return json({ ...base, truncated, html: Bun.markdown.html(text, { noHtmlBlocks: true, noHtmlSpans: true }) });
	}
	return json({ ...base, truncated, text });
}

/**
 * File bytes for <img> and downloads. Images keep their type; everything else downloads as an
 * attachment. The sandbox CSP and nosniff stop an SVG or HTML file from running script on this origin.
 */
async function readFileRaw(instanceId: string, url: URL): Promise<Response> {
	const r = await resolveHostFile(instanceId, url);
	if (r instanceof Response) return r;
	if (r.size > FILE_RAW_MAX_BYTES) return json({ error: "파일이 너무 큽니다" }, 413);
	const type = IMAGE_TYPES[extOf(r.rel)];
	const name = encodeURIComponent(path.basename(r.rel));
	return new Response(Bun.file(r.file), {
		headers: {
			"Content-Type": type ?? "application/octet-stream",
			"Content-Disposition": `${type && url.searchParams.get("download") !== "1" ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
			"Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "private, no-cache",
		},
	});
}

async function listDirs(url: URL): Promise<Response> {
	const requested = url.searchParams.get("path") || DIRS_ROOT;
	if (!path.isAbsolute(requested)) return json({ error: "허용되지 않은 경로입니다" }, 400);
	const resolved = path.resolve(requested);
	const rootPrefix = DIRS_ROOT.endsWith(path.sep) ? DIRS_ROOT : DIRS_ROOT + path.sep;
	if (resolved !== DIRS_ROOT && !resolved.startsWith(rootPrefix)) {
		return json({ error: "허용되지 않은 경로입니다" }, 400);
	}
	try {
		const entries = await fs.readdir(resolved, { withFileTypes: true });
		const dirs = entries
			.filter(e => e.isDirectory() && !e.name.startsWith("."))
			.map(e => path.join(resolved, e.name))
			.sort();
		return json({ path: resolved, root: DIRS_ROOT, dirs });
	} catch {
		return json({ error: "디렉터리를 읽을 수 없습니다" }, 404);
	}
}

async function handle(req: Request, server: Server): Promise<Response | undefined> {
	const relayResponse = handleRelay(req, server);
	if (relayResponse !== null) return relayResponse;

	const url = new URL(req.url);
	const { pathname } = url;
	const method = req.method;

	if (pathname === "/healthz") return new Response("ok");
	if (pathname.startsWith("/internal/")) return await handleInternal(req, server, pathname);
	// Remote computer agents authenticate with the node token, not the dashboard cookie.
	const nodeResponse = await handleNodeEndpoint(req, pathname, publicBaseUrl(url), {
		ompVersion: cachedOmpVersion,
		autoRestart: () => applySettings.autoRestart,
	});
	if (nodeResponse) return nodeResponse;

	// Fetched by the browser itself (service worker install, home-screen icon): no secrets, no login.
	const asset = PUBLIC_ASSETS[pathname];
	if (asset && method === "GET") {
		return new Response(Bun.file(path.resolve(import.meta.dir, "public", asset.file)), {
			headers: { "Content-Type": asset.type, "Cache-Control": "no-cache" },
		});
	}

	if (pathname === "/login") {
		if (method === "GET") return loginPage();
		if (method === "POST") {
			let token: string | null = null;
			try {
				const v = (await req.formData()).get("token");
				token = typeof v === "string" ? v : null;
			} catch {}
			return tokenMatches(token) ? redirect("/", loginCookie(req)) : loginPage("토큰이 올바르지 않습니다", 401);
		}
		return json({ error: "찾을 수 없습니다" }, 404);
	}

	if (method === "GET" && url.searchParams.has("token")) {
		if (tokenMatches(url.searchParams.get("token"))) {
			url.searchParams.delete("token");
			return redirect(pathname + url.search, loginCookie(req));
		}
	}

	if (!tokenMatches(cookieToken(req))) {
		return pathname.startsWith("/api/") ? json({ error: "인증이 필요합니다" }, 401) : redirect("/login");
	}

	if (pathname === "/logout" && method === "POST") return redirect("/login", CLEAR_COOKIE);

	if (pathname === "/" && method === "GET") {
		return new Response(Bun.file(INDEX_PATH), {
			headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
		});
	}

	const notificationPath = /^\/n\/([^/]+)$/.exec(pathname);
	if (notificationPath && method === "GET") {
		try {
			return await openNotification(notificationPath[1]!);
		} catch {
			return redirect(`/?n=${encodeURIComponent(notificationPath[1]!)}`);
		}
	}

	try {
		if (pathname === "/api/hosts" && method === "GET") {
			const hosts = await listHosts();
			// Drop reviews whose session is gone (process exited without a resolved event).
			const live = new Set(hosts.map(h => h.sessionId));
			for (const r of [...planReviews.values()]) if (!live.has(r.sessionId)) closeReview(r.reviewId);
			for (const id of sessionActivity.keys()) if (!live.has(id)) sessionActivity.delete(id);
			for (const id of controls.keys()) if (!live.has(id) && !controls.get(id)!.poller) controls.delete(id);
			return json({
				hosts: [
					...hosts.map(h => {
						const r = openReviewFor(h.sessionId);
						const bg = activityOf(h);
						const withBg = {
							...h,
							...(bg?.running.length || bg?.queued ? { background: { running: bg.running, queued: bg.queued } } : {}),
							thinking: bg?.thinking ?? null,
							modelControl: (bg?.control ?? 0) >= 1,
							accountControl: (bg?.control ?? 0) >= 2,
							accounts: bg?.accounts ?? {},
							accountChoice: bg?.chosen ?? {},
						};
						return r ? { ...withBg, planReview: { reviewId: r.reviewId, title: r.title, createdAt: r.createdAt } } : withBg;
					}),
					...remoteHosts(),
				],
				latestNotificationAt: notifications[0]?.ts ?? 0,
			});
		}
		if (pathname === "/api/nodes" && method === "GET") {
			return json({ ...(await nodesStatus(publicBaseUrl(url))), serverOmpVersion: await cachedOmpVersion() });
		}
		if (pathname === "/api/nodes/rotate-token" && method === "POST") {
			await rotateNodeToken();
			return json({ ...(await nodesStatus(publicBaseUrl(url))), serverOmpVersion: await cachedOmpVersion() });
		}
		const nodeAction = /^\/api\/nodes\/([0-9a-f]{16})\/(forget|permissions|update)$/.exec(pathname);
		if (nodeAction && method === "POST") {
			if (nodeAction[2] === "forget") return forgetNode(nodeAction[1]!) ? json({ ok: true }) : json({ error: "찾을 수 없습니다" }, 404);
			const version = nodeAction[2] === "update" ? await cachedOmpVersion() : null;
			if (nodeAction[2] === "update" && !version) return json({ error: "서버의 omp 버전을 알 수 없습니다" }, 502);
			const r = await nodeCommand(nodeAction[1]!, nodeAction[2] === "update" ? "update" : "permissions", version ? { version } : {});
			return r.ok ? json(r.data ?? {}) : json({ error: r.error }, 502);
		}
		const nodeDirs = /^\/api\/nodes\/([0-9a-f]{16})\/dirs$/.exec(pathname);
		if (nodeDirs && method === "GET") {
			const r = await nodeCommand(nodeDirs[1]!, "dirs", { path: url.searchParams.get("path") ?? "" });
			return r.ok ? json(r.data ?? {}) : json({ error: r.error }, 502);
		}
		if (pathname === "/api/notifications" && method === "GET") return json({ items: notifications });
		if (pathname === "/api/usage" && method === "GET") return json(await aiUsage());
		if (pathname === "/api/notifications/clear" && method === "POST") {
			notifications = [];
			await saveNotifications();
			return json({ ok: true });
		}
		if (pathname === "/api/sessions" && method === "POST") return await createSession(req);
		if (pathname === "/api/sessions/recent" && method === "GET") {
			return json({ sessions: (await scanSessions()).slice(0, RECENT_SESSIONS_LIMIT) });
		}
		if (pathname === "/api/sessions/resume" && method === "POST") return await resumeSession(req);
		if (pathname === "/api/dirs" && method === "GET") return await listDirs(url);
		if (pathname === "/api/relay" && method === "GET") return json(relayStatus());
		if (pathname === "/api/relay/settings" && method === "POST") return await saveRelaySettings(req);
		if (pathname === "/api/relay/issue" && method === "POST") return startIssue();
		if (pathname === "/api/update" && method === "GET") {
			const [status, sessions] = await Promise.all([
				updateStatus(OMP_BIN!, { refresh: url.searchParams.get("refresh") === "1" }),
				sessionUpdateStatus(),
			]);
			return json({ ...status, ...sessions });
		}
		if (pathname === "/api/update" && method === "POST") {
			if (!startUpdate(OMP_BIN!)) return json({ error: "이미 업데이트 중입니다" }, 409);
			return json({ ...(await updateStatus(OMP_BIN!)), ...(await sessionUpdateStatus()) }, 202);
		}
		if (pathname === "/api/update/settings" && method === "POST") return await saveApplySettings(req);
		if (pathname === "/api/push" && method === "GET") {
			const endpoint = url.searchParams.get("endpoint");
			return json({
				publicKey: await vapidPublicKey(),
				devices: await subscriptionCount(),
				subscribed: endpoint ? await hasSubscription(endpoint) : false,
				minTurnSeconds: NOTIFY_MIN_TURN_MS / 1000,
			});
		}
		if (pathname === "/api/push/subscribe" && method === "POST") {
			const body = await readJsonBody(req);
			const sub = validateSubscription(body.subscription);
			if (typeof sub === "string") return json({ error: sub }, 400);
			const label = (typeof body.label === "string" ? body.label : "").slice(0, 80) || "기기";
			await addSubscription(sub, label);
			return json({ ok: true, devices: await subscriptionCount() });
		}
		if (pathname === "/api/push/unsubscribe" && method === "POST") {
			const body = await readJsonBody(req);
			if (typeof body.endpoint !== "string") return json({ error: "endpoint가 필요합니다" }, 400);
			await removeSubscription(body.endpoint);
			return json({ ok: true, devices: await subscriptionCount() });
		}
		if (pathname === "/api/push/test" && method === "POST") {
			const body = await readJsonBody(req);
			const only = typeof body.endpoint === "string" ? body.endpoint : undefined;
			const sent = await broadcast({ title: "omp collab 테스트 알림", body: "알림이 정상으로 도착했습니다.", tag: "test" }, only);
			if (!sent) return json({ error: "알림을 보내지 못했습니다. 알림을 다시 켜 보세요" }, 502);
			return json({ ok: true, sent });
		}
		if (pathname === "/api/update/changelog" && method === "GET") {
			try {
				return json(await releaseNotes(OMP_BIN!, { refresh: url.searchParams.get("refresh") === "1" }));
			} catch (err) {
				return json({ error: err instanceof Error ? err.message : String(err) }, 502);
			}
		}
		if (pathname === "/api/bot" && method === "GET") return json(botStatus(Number(url.searchParams.get("since")) || 0));
		if (pathname === "/api/bot/message" && method === "POST") {
			const b = await readJsonBody(req);
			const text = typeof b.text === "string" ? b.text.trim() : "";
			if (!text) return json({ error: "메시지를 입력하세요" }, 400);
			if (text.length > 8000) return json({ error: "메시지가 너무 깁니다" }, 400);
			await botSend(text, "web");
			return json({ ok: true });
		}
		if (pathname === "/api/bot/abort" && method === "POST") {
			botAbort();
			return json({ ok: true });
		}
		if (pathname === "/api/bot/reset" && method === "POST") {
			await botReset();
			return json({ ok: true });
		}
		if (pathname === "/api/bot/settings" && method === "POST") {
			const error = await botSettings(await readJsonBody(req));
			return error ? json({ error }, 400) : json(botStatus(Number.MAX_SAFE_INTEGER));
		}
		if (pathname === "/api/bot/pair" && method === "POST") return json(await botPair());
		if (pathname === "/api/bot/unlink" && method === "POST") {
			await botUnlink();
			return json({ ok: true });
		}
		if (pathname === "/api/accounts" && method === "GET") {
			try {
				return json({ accounts: await listAccounts(), byCwd: accountPrefs.byCwd });
			} catch {
				return json({ accounts: [], byCwd: {} });
			}
		}
		if (pathname === "/api/models" && method === "GET") {
			try {
				return json({ models: await listModels() });
			} catch {
				return json({ models: [] });
			}
		}
		const m = pathname.match(/^\/api\/hosts\/([^/]+)\/(link|stop|files|file|raw|restart|rename|plan-review|model)$/);
		const readOnly =
			m?.[2] === "files" || m?.[2] === "file" || m?.[2] === "raw" || (m?.[2] === "plan-review" && method === "GET");
		if (m && method === (readOnly ? "GET" : "POST")) {
			let instanceId = decodeURIComponent(m[1]);
			if (!INSTANCE_ID_RE.test(instanceId)) return json({ error: "instanceId 형식이 올바르지 않습니다" }, 400);
			// A restart (update, resume) gives the same session a new instanceId; a page that has not
			// refreshed yet still holds the old one, so fall back to the stable session id it also sends.
			const sid = url.searchParams.get("sid");
			const remote = remoteHost(instanceId, sid);
			if (remote) return await remoteHostAction(remote, m[2]!, req);
			if (sid && SESSION_ID_RE.test(sid)) {
				const hosts = await listHosts();
				if (!hosts.some(h => h.instanceId === instanceId)) {
					instanceId = hosts.find(h => h.sessionId === sid)?.instanceId ?? instanceId;
				}
			}
			if (m[2] === "files") return await listFiles(instanceId);
			if (m[2] === "file") return await readFileView(instanceId, url);
			if (m[2] === "raw") return await readFileRaw(instanceId, url);
			if (m[2] === "restart") return await restartHostNow(instanceId);
			if (m[2] === "rename") return await renameHost(instanceId, req);
			if (m[2] === "model") return await changeModel(instanceId, req);
			if (m[2] === "plan-review") return method === "GET" ? await planReviewForHost(instanceId) : await answerPlanReview(instanceId, req);
			return m[2] === "link" ? await createLink(instanceId, req) : await stopHost(instanceId);
		}
	} catch (err) {
		return errorResponse(err);
	}

	return json({ error: "찾을 수 없습니다" }, 404);
}

Bun.serve({ hostname: HOST, port: PORT, fetch: handle, websocket: relayWebsocket });
startHttps();
renewIfDue();
setInterval(renewIfDue, RENEW_CHECK_MS);
setInterval(() => void applyUpdatesWhenIdle(), APPLY_CHECK_MS);
setInterval(() => void watchTurns(), NOTIFY_POLL_MS);
startBot({ ompBin: OMP_BIN!, cwd: DIRS_ROOT });

function lanIp(): string {
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const a of addrs ?? []) {
			if (a.family === "IPv4" && !a.internal) return a.address;
		}
	}
	return "127.0.0.1";
}

console.log(
	`omp-web 실행 중: http://${HOST}:${PORT}  (로그인: http://${lanIp()}:${PORT}/?token=${encodeURIComponent(TOKEN)})`,
);
console.log("http 평문으로 서비스 중 — TLS 프록시 뒤 또는 신뢰된 LAN에서만 사용하세요.");
console.log(`collab 릴레이: ws://127.0.0.1:${PORT}/r/… (omp용), 세션 화면: ${CLIENT_PATH}`);
if (relaySettings.publicUrl) console.log(`외부 주소: ${relaySettings.publicUrl}`);
else if (httpsServer) console.log(`HTTPS: https://${publicOrigin()}`);
else if (httpsError) console.log(httpsError);
else console.log("외부 주소: 미설정 — 대시보드의 '릴레이 설정'에서 설정하세요");
