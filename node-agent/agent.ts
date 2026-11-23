#!/usr/bin/env bun
/**
 * omp-web node agent: runs on another computer (a Mac), reports its omp collab sessions to the
 * omp-web dashboard and carries out the dashboard's commands (start/stop a session, make a join link,
 * ask for macOS screen permissions). It only ever talks to the dashboard over HTTPS; the sessions
 * themselves join the dashboard's relay through the collab overlay written by install.sh.
 *
 * Env: OMP_WEB_URL (https://dashboard), OMP_WEB_NODE_TOKEN. Installed by `<dashboard>/node/install.sh`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";

const AGENT_VERSION = "2";
const SERVER = (process.env.OMP_WEB_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.OMP_WEB_NODE_TOKEN ?? "";
if (!SERVER || !TOKEN) {
	console.error("OMP_WEB_URL와 OMP_WEB_NODE_TOKEN이 필요합니다");
	process.exit(2);
}
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".omp-web-node");
const OVERLAY = path.join(STATE_DIR, "overlay.yml");
/** The omp this agent installed (`bun install -g`, pinned to the dashboard's version) wins over a PATH lookup. */
const OMP_PATH_FILE = path.join(STATE_DIR, "omp-path");
/** Bun global dir (BUN_INSTALL) the agent installs its pinned omp into. */
const OMP_PREFIX = path.join(STATE_DIR, "bun");
let OMP = process.env.OMP_BIN || (await fs.readFile(OMP_PATH_FILE, "utf8").then(s => s.trim(), () => "")) ||
	Bun.which("omp") || path.join(HOME, ".bun", "bin", "omp");
const TMUX = Bun.which("tmux") ?? "tmux";
/** Same prefix the dashboard uses, so its "starting…" card finds the session by tmux name. */
const TMUX_PREFIX = "omp-web-";
const SYNC_MS = 2_000;
const IS_MAC = process.platform === "darwin";

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

async function run(cmd: string[], timeoutMs = 20_000, env?: Record<string, string>) {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", ...(env ? { env: { ...process.env, ...env } } : {}) });
	const timer = setTimeout(() => proc.kill(), timeoutMs);
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

async function nodeId(): Promise<string> {
	const file = path.join(STATE_DIR, "node-id");
	try {
		const id = (await fs.readFile(file, "utf8")).trim();
		if (/^[0-9a-f]{16}$/.test(id)) return id;
	} catch {}
	const id = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex");
	await fs.mkdir(STATE_DIR, { recursive: true });
	await fs.writeFile(file, id + "\n");
	return id;
}

async function computerName(): Promise<string> {
	if (IS_MAC) {
		const r = await run(["scutil", "--get", "ComputerName"]).catch(() => null);
		if (r?.code === 0 && r.stdout.trim()) return r.stdout.trim();
	}
	return os.hostname();
}

async function ompVersion(bin = OMP): Promise<string | null> {
	const r = await run([bin, "--version"]).catch(() => null);
	return r?.code === 0 ? (/(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1] ?? null) : null;
}

// ---------- sessions ----------

interface Host {
	instanceId: string;
	pid: number;
	sessionId: string;
	cwd: string;
	tmux?: string | null;
	[key: string]: unknown;
}

/** pid -> parent pid for every process (`ps` works on macOS and Linux alike). */
async function parentPids(): Promise<Map<number, number>> {
	const map = new Map<number, number>();
	const r = await run(["ps", "-A", "-o", "pid=,ppid="]);
	for (const line of r.stdout.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)/.exec(line);
		if (m) map.set(Number(m[1]), Number(m[2]));
	}
	return map;
}

async function tmuxSessionsByPanePid(): Promise<Map<number, string>> {
	const map = new Map<number, string>();
	const r = await run([TMUX, "list-panes", "-a", "-F", "#{pane_pid} #{session_name}"]).catch(() => null);
	if (r?.code !== 0) return map;
	for (const line of r.stdout.split("\n")) {
		const m = /^(\d+) (.+)$/.exec(line);
		if (m) map.set(Number(m[1]), m[2]!);
	}
	return map;
}

async function listHosts(): Promise<Host[]> {
	const r = await run([OMP, "collab", "list", "--json"]);
	if (r.code !== 0) throw new Error(r.stderr.trim() || `omp collab list 실패 (${r.code})`);
	const { hosts } = JSON.parse(r.stdout) as { hosts: Host[] };
	const [ppids, panes] = await Promise.all([parentPids(), tmuxSessionsByPanePid()]);
	for (const h of hosts) {
		let cur: number | undefined = h.pid;
		let session: string | undefined;
		for (let hop = 0; hop < 10 && cur && cur > 1 && !session; hop++) {
			session = panes.get(cur);
			cur = ppids.get(cur);
		}
		h.tmux = session?.startsWith(TMUX_PREFIX) ? session : null;
		// Shown on the dashboard card as "업데이트 대기", like local sessions on an old build.
		h.stale = isStale(h);
		h.runningVersion = h.stale ? replaced.from : null;
	}
	return hosts;
}

/** Folders offered in the dashboard's "new session" form: home, its folders, and session folders. */
async function suggestedDirs(hosts: Host[]): Promise<string[]> {
	const dirs = new Set([HOME, ...hosts.map(h => h.cwd)]);
	try {
		for (const e of await fs.readdir(HOME, { withFileTypes: true })) {
			if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "Library") dirs.add(path.join(HOME, e.name));
		}
	} catch {}
	return [...dirs].sort().slice(0, 200);
}

// ---------- macOS: screen permissions and keeping the display awake ----------

type Permissions = { screen: boolean | null; accessibility: boolean | null } | null;

const PERMISSIONS_TTL_MS = 15_000;
const PERMISSIONS_PROBE = `
const { dlopen, FFIType } = require("bun:ffi");
const cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", { CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool } });
const ax = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", { AXIsProcessTrusted: { args: [], returns: FFIType.bool } });
console.log(JSON.stringify({ screen: cg.symbols.CGPreflightScreenCaptureAccess(), accessibility: ax.symbols.AXIsProcessTrusted() }));
`;
let permissionsCache: { at: number; value: Permissions } | null = null;

/**
 * macOS charges Screen Recording / Accessibility to the process that launched omp: sessions run as
 * launchd → this agent → tmux → omp, so this agent's grant is theirs. Checked in a fresh child
 * process, because a process keeps the answer it got first until it restarts, and a child sees
 * exactly what the sessions (also its descendants) get.
 */
async function permissions(force = false): Promise<Permissions> {
	if (!IS_MAC) return null;
	if (!force && permissionsCache && Date.now() - permissionsCache.at < PERMISSIONS_TTL_MS) return permissionsCache.value;
	let value: Permissions = { screen: null, accessibility: null };
	const r = await run([process.execPath, "-e", PERMISSIONS_PROBE], 10_000).catch(() => null);
	try {
		if (r?.code === 0) value = JSON.parse(r.stdout.trim().split("\n").pop()!);
		else log("권한 확인 실패:", r?.stderr.trim());
	} catch {}
	permissionsCache = { at: Date.now(), value };
	return value;
}

async function requestPermissions() {
	if (!IS_MAC) throw new Error("이 컴퓨터에서는 권한 요청을 지원하지 않습니다");
	try {
		// Adds this agent to the Screen Recording list and shows the system prompt.
		const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
		dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
			CGRequestScreenCaptureAccess: { args: [], returns: FFIType.bool },
		}).symbols.CGRequestScreenCaptureAccess();
	} catch (err) {
		log("화면 기록 권한 요청 실패:", err);
	}
	const before = await permissions(true);
	if (!before?.screen) await run(["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);
	if (!before?.accessibility) await run(["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]);
	return { permissions: before };
}

/**
 * The Mac never goes to sleep while the agent runs (`caffeinate -i`, idle sleep on battery too),
 * so tasks and new sessions can always reach it. The display still turns off as usual: it is woken
 * when work arrives, and omp keeps it on itself during a turn that uses the desktop.
 */
let caffeinate: Subprocess | null = null;
function keepAwake(on: boolean) {
	if (!IS_MAC) return;
	if (on && !caffeinate) {
		caffeinate = Bun.spawn(["caffeinate", "-i"], { stdout: "ignore", stderr: "ignore" });
		void caffeinate.exited.then(() => { caffeinate = null; });
	} else if (!on && caffeinate) {
		caffeinate.kill();
		caffeinate = null;
	}
}
const wakeDisplay = () => IS_MAC && run(["caffeinate", "-u", "-t", "2"]).catch(() => {});

// ---------- updates: omp follows the dashboard's version; the agent replaces itself ----------

/** Run by launchd (install.sh sets this), which starts the agent again after it replaced itself. */
const MANAGED = process.env.OMP_WEB_NODE_MANAGED === "1";
const PACKAGE = "@oh-my-pi/pi-coding-agent";
/** A failed automatic update of the same version is retried after this long (a manual one at once). */
const UPDATE_RETRY_MS = 30 * 60_000;
/** Sessions still on the old omp restart after idling this long (like the dashboard's own). */
const RESTART_IDLE_MS = 2 * 60_000;
const REPLACED_FILE = path.join(STATE_DIR, "omp-replaced.json");

interface Target {
	ompVersion: string | null;
	agentHash: string | null;
	autoRestart: boolean;
}

interface UpdateState {
	state: "idle" | "updating" | "failed";
	targetVersion: string | null;
	error: string | null;
	at: number;
}

let ompVer: string | null = null;
const update: UpdateState = { state: "idle", targetVersion: null, error: null, at: 0 };
/** When omp was last replaced here, and the version sessions started before then still run. */
let replaced: { at: number; from: string | null } = { at: 0, from: null };
try {
	replaced = JSON.parse(await fs.readFile(REPLACED_FILE, "utf8"));
} catch {}

const sha256 = (data: ArrayBuffer | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
const SELF_HASH = sha256(await Bun.file(import.meta.path).arrayBuffer());

/**
 * Installs exactly `target` with `bun install -g` (whatever installed omp before) and uses that omp
 * from now on; `omp update` could only go to the latest release, not the dashboard's version.
 */
async function updateOmp(target: string, reason: string): Promise<void> {
	if (update.state === "updating") return;
	Object.assign(update, { state: "updating", targetVersion: target, error: null, at: Date.now() });
	const from = ompVer;
	log(`omp 업데이트 시작: ${from ?? "없음"} → ${target} (${reason})`);
	try {
		// Into the agent's own Bun global dir: the user's global omp (however it was installed) can
		// make `bun install -g` fail to link (EEXIST), and stays untouched this way.
		const r = await run([process.execPath, "install", "-g", `${PACKAGE}@${target}`], 600_000, { BUN_INSTALL: OMP_PREFIX });
		if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `종료 코드 ${r.code}`);
		const installed = path.join(OMP_PREFIX, "bin", "omp");
		let version = await ompVersion(installed);
		if (!version) {
			// A newer omp can require a newer Bun than this computer has ("Bun runtime must be >= …").
			log("omp가 실행되지 않아 Bun을 업그레이드합니다");
			const u = await run([process.execPath, "upgrade"], 600_000);
			if (u.code !== 0) throw new Error(`Bun 업그레이드 실패: ${(u.stderr || u.stdout).trim().split("\n").pop()}`);
			version = await ompVersion(installed);
		}
		if (version !== target) throw new Error(`설치한 omp의 버전이 ${version ?? "확인 불가"}입니다 (목표 ${target})`);
		OMP = installed;
		ompVer = version;
		await fs.writeFile(OMP_PATH_FILE, installed + "\n");
		replaced = { at: Date.now(), from };
		await fs.writeFile(REPLACED_FILE, JSON.stringify(replaced));
		Object.assign(update, { state: "idle", error: null, at: Date.now() });
		log(`omp ${target}로 업데이트했습니다`);
	} catch (err) {
		Object.assign(update, { state: "failed", error: err instanceof Error ? err.message : String(err), at: Date.now() });
		log("omp 업데이트 실패:", update.error);
	}
	wake?.();
}

function followTarget(target: Target): void {
	const v = target.ompVersion;
	if (!v || v === ompVer || update.state === "updating") return;
	if (update.state === "failed" && update.targetVersion === v && Date.now() - update.at < UPDATE_RETRY_MS) return;
	void updateOmp(v, "대시보드 버전에 맞춤");
}

/** Started before omp was replaced, so still running the previous build. */
const isStale = (h: Host) => replaced.at > 0 && typeof h.startedAt === "number" && h.startedAt < replaced.at;

const idleSince = new Map<string, number>();
const restarting = new Set<string>();

function restartStaleWhenIdle(hosts: Host[], autoRestart: boolean): void {
	const now = Date.now();
	const live = new Set(hosts.map(h => h.instanceId));
	for (const id of idleSince.keys()) if (!live.has(id)) idleSince.delete(id);
	for (const h of hosts) {
		// Only sessions this agent started (its tmux sessions, its overlay) are restarted.
		if (!autoRestart || !h.stale || !h.tmux || restarting.has(h.instanceId)) continue;
		if (h.busy !== false || h.inputRequired) {
			idleSince.delete(h.instanceId);
			continue;
		}
		const since = idleSince.get(h.instanceId) ?? now;
		idleSince.set(h.instanceId, since);
		if (now - since >= RESTART_IDLE_MS) void restartSession(h);
	}
}

/** The saved conversation (`~/.omp/agent/sessions/<cwd>/<time>_<id>.jsonl`), if omp wrote one. */
async function findSessionFile(sessionId: string): Promise<string | null> {
	const root = path.join(HOME, ".omp", "agent", "sessions");
	const suffix = `_${sessionId}.jsonl`;
	const subdirs = (await fs.readdir(root).catch(() => [] as string[])).map(d => path.join(root, d));
	for (const dir of [root, ...subdirs]) {
		const hit = (await fs.readdir(dir).catch(() => [] as string[])).find(f => f.endsWith(suffix));
		if (hit) return path.join(dir, hit);
	}
	return null;
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
	}
	return false;
}

/** Replaces the session's omp with the new build in the same tmux pane, continuing the conversation. */
async function restartSession(h: Host): Promise<void> {
	restarting.add(h.instanceId);
	let paneId = "";
	let paneRoot = false;
	try {
		const r = await run([TMUX, "list-panes", "-t", h.tmux!, "-F", "#{pane_pid} #{pane_id}"]);
		const [pid, id] = r.stdout.trim().split("\n")[0]?.split(" ") ?? [];
		if (!id) throw new Error("tmux 창을 찾을 수 없습니다");
		paneId = id;
		paneRoot = Number(pid) === h.pid;
		log(`${h.tmux}: 쉬는 중이라 새 omp로 다시 시작합니다`);
		if (paneRoot) await run([TMUX, "set-option", "-p", "-t", paneId, "remain-on-exit", "on"]);
		process.kill(h.pid, "SIGTERM");
		if (!(await waitForExit(h.pid, 20_000))) throw new Error("omp가 20초 안에 종료되지 않았습니다");
		// Look up after exit: a session file is only written once the conversation has content.
		const file = await findSessionFile(h.sessionId);
		if (!file) log(`${h.tmux}: 저장된 대화가 없어 새 세션으로 시작합니다`);
		const cmd = `${q(OMP)} --config ${q(OVERLAY)}${file ? ` --restore ${q(file)}` : ""}`;
		if (paneRoot) await run([TMUX, "respawn-pane", "-t", paneId, "-c", h.cwd, cmd]);
		else {
			await run([TMUX, "send-keys", "-t", paneId, "-l", `cd ${q(h.cwd)} && ${cmd}`]);
			await run([TMUX, "send-keys", "-t", paneId, "Enter"]);
		}
	} catch (err) {
		log(`${h.tmux}: 재시작 실패:`, err instanceof Error ? err.message : err);
	} finally {
		if (paneRoot && paneId) await run([TMUX, "set-option", "-p", "-t", paneId, "remain-on-exit", "off"]).catch(() => {});
		restarting.delete(h.instanceId);
		idleSince.delete(h.instanceId);
	}
}

let selfUpdateFailed: { hash: string; at: number } | null = null;

/** Swaps in the dashboard's agent.ts and exits; launchd starts the new one. Sessions keep running. */
async function selfUpdate(hash: string | null): Promise<void> {
	if (!MANAGED || !hash || hash === SELF_HASH || update.state === "updating" || restarting.size || runningTasks.size) return;
	if (selfUpdateFailed?.hash === hash && Date.now() - selfUpdateFailed.at < 10 * 60_000) return;
	try {
		const res = await fetch(`${SERVER}/node/agent.ts`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(30_000) });
		const body = new Uint8Array(await res.arrayBuffer());
		if (!res.ok || sha256(body) !== hash) throw new Error(`내려받은 파일이 맞지 않습니다 (HTTP ${res.status})`);
		const tmp = `${import.meta.path}.new`;
		await fs.writeFile(tmp, body);
		await fs.rename(tmp, import.meta.path);
		log("연결 프로그램을 새 버전으로 바꿨습니다. 다시 시작합니다");
		keepAwake(false);
		process.exit(0);
	} catch (err) {
		selfUpdateFailed = { hash, at: Date.now() };
		log("연결 프로그램 업데이트 실패:", err instanceof Error ? err.message : err);
	}
}

// ---------- commands from the dashboard ----------

interface Command {
	id: string;
	type: "new" | "stop" | "link" | "permissions" | "update" | "task" | "task-cancel" | "dirs";
	[key: string]: unknown;
}
type Result = { ok: true; data?: unknown } | { ok: false; error: string; code?: string };

const expandHome = (p: string) => (p === "~" ? HOME : p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p);

/** Subfolders of `p` (default home) for the dashboard's folder picker; the whole disk is browsable. */
async function listDirs(p: string): Promise<Result> {
	const dir = path.resolve(expandHome(p.trim() || "~"));
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		const dirs = entries
			.filter(e => e.isDirectory() && !e.name.startsWith("."))
			.map(e => path.join(dir, e.name))
			.sort((a, b) => a.localeCompare(b))
			.slice(0, 1000);
		return { ok: true, data: { path: dir, root: "/", home: HOME, dirs } };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return { ok: false, error: code === "ENOENT" ? `폴더가 없습니다: ${dir}` : code === "EPERM" || code === "EACCES" ? `읽을 권한이 없습니다: ${dir}` : `폴더를 읽을 수 없습니다: ${dir}` };
	}
}

async function startSession(c: Command): Promise<Result> {
	const tmux = String(c.tmux ?? "");
	if (!tmux.startsWith(TMUX_PREFIX) || !/^[\w-]+$/.test(tmux)) return { ok: false, error: "tmux 이름이 올바르지 않습니다" };
	const cwd = path.resolve(expandHome(String(c.cwd ?? "").trim()));
	if (!path.isAbsolute(cwd)) return { ok: false, error: "작업 디렉터리는 절대경로여야 합니다" };
	let created = false;
	try {
		if (!(await fs.stat(cwd)).isDirectory()) return { ok: false, error: `디렉터리가 아닌 파일이 이미 있습니다: ${cwd}` };
	} catch {
		if (c.createDir !== true) return { ok: false, error: `작업 디렉터리가 없습니다: ${cwd}`, code: "cwd_missing" };
		await fs.mkdir(cwd, { recursive: true });
		created = true;
	}
	const model = typeof c.model === "string" && c.model ? ` --model ${q(c.model)}` : "";
	const thinking = typeof c.thinking === "string" && /^[a-z]+$/.test(c.thinking) ? ` --thinking ${c.thinking}` : "";
	const prompt = typeof c.prompt === "string" && c.prompt ? ` -- ${q(c.prompt)}` : "";
	const r = await run([TMUX, "new-session", "-d", "-s", tmux, "-c", cwd, "-x", "200", "-y", "50",
		`${q(OMP)} --config ${q(OVERLAY)}${model}${thinking}${prompt}`]);
	if (r.code !== 0) return { ok: false, error: `tmux 실행 실패: ${r.stderr.trim()}` };
	void wakeDisplay();
	return { ok: true, data: { tmux, cwd, created } };
}

async function handle(c: Command): Promise<Result> {
	try {
		if (c.type === "new") return await startSession(c);
		if (c.type === "permissions") return { ok: true, data: await requestPermissions() };
		if (c.type === "dirs") return await listDirs(String(c.path ?? ""));
		if (c.type === "task") return startTask(c);
		if (c.type === "task-cancel") return cancelTask(String(c.taskId ?? ""));
		if (c.type === "update") {
			if (typeof c.version !== "string" || !/^\d+\.\d+\.\d+\S*$/.test(c.version)) return { ok: false, error: "버전이 올바르지 않습니다" };
			if (update.state === "updating") return { ok: false, error: "이미 업데이트하는 중입니다" };
			void updateOmp(c.version, "대시보드에서 요청");
			return { ok: true };
		}
		const host = (await listHosts()).find(h => h.instanceId === c.instanceId);
		if (!host) return { ok: false, error: "세션을 찾을 수 없습니다" };
		if (c.type === "stop") {
			process.kill(host.pid, "SIGTERM");
			return { ok: true };
		}
		if (c.type === "link") {
			const r = await run([OMP, "collab", "link", host.instanceId, ...(c.access === "view" ? ["--view"] : []), "--json"]);
			if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "링크를 만들 수 없습니다" };
			void wakeDisplay();
			return { ok: true, data: JSON.parse(r.stdout) };
		}
		return { ok: false, error: `알 수 없는 명령: ${c.type}` };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// ---------- tasks: a server-side session hands work to this computer ----------

/**
 * One headless `omp -p` run per task, with computer control on (the overlay). Runs for the same
 * `key` (the calling session) continue one conversation in `tasks/<key>`, so follow-up tasks
 * remember what happened before; `fresh` starts it over.
 */
const TASKS_DIR = path.join(STATE_DIR, "tasks");
const TASK_DEFAULT_TIMEOUT_S = 20 * 60;
const TASK_OUTPUT_LIMIT = 30_000;

interface TaskUpdate {
	taskId: string;
	state: "done" | "failed" | "cancelled";
	output: string;
	error: string | null;
	/** Final screen, JPEG base64, so the caller sees what the task left behind. */
	image: string | null;
}

/** Task id -> its omp process; null while the run is still being set up. */
const runningTasks = new Map<string, Subprocess | null>();
const taskUpdates: TaskUpdate[] = [];

function startTask(c: Command): Result {
	const taskId = String(c.taskId ?? "");
	const prompt = typeof c.prompt === "string" ? c.prompt.trim() : "";
	const key = String(c.key ?? "default").replace(/[^\w-]/g, "").slice(0, 80) || "default";
	if (!/^[\w-]{8,64}$/.test(taskId) || !prompt) return { ok: false, error: "작업 내용이 없습니다" };
	if (runningTasks.size >= 2) return { ok: false, error: "이 컴퓨터에서 이미 작업 2개가 실행 중입니다" };
	runningTasks.set(taskId, null); // listed as running from the very next sync on
	void runTask(taskId, prompt, key, c);
	return { ok: true };
}

async function runTask(taskId: string, prompt: string, key: string, c: Command): Promise<void> {
	const dir = path.join(TASKS_DIR, key);
	const out: TaskUpdate = { taskId, state: "failed", output: "", error: null, image: null };
	try {
		if (c.fresh === true) await fs.rm(dir, { recursive: true, force: true });
		await fs.mkdir(dir, { recursive: true });
		const cwd = path.resolve(expandHome(typeof c.cwd === "string" && c.cwd ? c.cwd : "~"));
		const timeoutS = typeof c.timeoutSec === "number" && c.timeoutSec > 0 ? Math.min(c.timeoutSec, 3600) : TASK_DEFAULT_TIMEOUT_S;
		void wakeDisplay();
		const model = typeof c.model === "string" && c.model ? ["--model", c.model] : [];
		log(`작업 시작 ${taskId} (${key}): ${prompt.slice(0, 80)}`);
		if (!runningTasks.has(taskId)) throw new Error("시작 전에 취소되었습니다");
		const proc = Bun.spawn([OMP, "-p", "--config", OVERLAY, "--session-dir", dir, "-c", ...model, prompt], {
			cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore",
		});
		runningTasks.set(taskId, proc);
		keepAwake(true);
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutS * 1000);
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		clearTimeout(timer);
		const cancelled = !runningTasks.has(taskId);
		out.output = stdout.trim().slice(-TASK_OUTPUT_LIMIT);
		if (cancelled) out.state = "cancelled";
		else if (timedOut) out.error = `${Math.round(timeoutS / 60)}분 안에 끝나지 않아 중단했습니다`;
		else if (/API key environment variable|models\.yml/.test(stderr)) {
			out.error = "이 컴퓨터의 omp가 모델에 로그인되어 있지 않습니다. 이 컴퓨터의 터미널에서 `omp login anthropic`(또는 `omp login`)을 한 번 실행하세요";
		} else if (code !== 0) out.error = stderr.trim().split("\n").slice(-5).join("\n") || `omp 종료 코드 ${code}`;
		else out.state = "done";
		out.image = await screenshot(taskId);
	} catch (err) {
		out.error = err instanceof Error ? err.message : String(err);
	} finally {
		runningTasks.delete(taskId);
	}
	log(`작업 ${out.state} ${taskId}${out.error ? `: ${out.error}` : ""}`);
	taskUpdates.push(out);
	wake?.();
}

function cancelTask(taskId: string): Result {
	if (!runningTasks.has(taskId)) return { ok: false, error: "실행 중인 작업이 아닙니다" };
	const proc = runningTasks.get(taskId);
	runningTasks.delete(taskId); // marks it cancelled for runTask
	proc?.kill();
	return { ok: true };
}

/** The whole screen as a ≤1280px JPEG (`screencapture` needs the Screen Recording grant). */
async function screenshot(taskId: string): Promise<string | null> {
	if (!IS_MAC) return null;
	const file = path.join(os.tmpdir(), `omp-web-task-${taskId}.jpg`);
	try {
		if ((await run(["screencapture", "-x", "-t", "jpg", file])).code !== 0) return null;
		await run(["sips", "-Z", "1280", "-s", "formatOptions", "70", file, "--out", file]);
		return Buffer.from(await fs.readFile(file)).toString("base64");
	} catch {
		return null;
	} finally {
		await fs.rm(file, { force: true });
	}
}

// ---------- sync loop ----------

const results: ({ id: string } & Result)[] = [];
let wake: (() => void) | null = null;

async function main() {
	const id = await nodeId();
	const name = await computerName();
	ompVer = await ompVersion();
	let versionAt = Date.now();
	log(`omp-web 연결 시작: ${SERVER} (${name}, omp ${ompVer ?? "없음"}, 연결 프로그램 ${SELF_HASH.slice(0, 12)})`);
	let lastError = "";
	for (;;) {
		const sent = results.splice(0);
		const sentTasks = taskUpdates.splice(0);
		try {
			if (Date.now() - versionAt > 3_600_000 && update.state !== "updating") {
				ompVer = await ompVersion();
				versionAt = Date.now();
			}
			let hosts: Host[] = [];
			let hostsError: string | null = null;
			try {
				hosts = await listHosts();
			} catch (err) {
				hostsError = err instanceof Error ? err.message : String(err);
			}
			keepAwake(true); // re-held if caffeinate ever exits
			const res = await fetch(`${SERVER}/node/sync`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					node: { id, name, platform: process.platform, arch: process.arch, hostname: os.hostname(),
						agentVersion: AGENT_VERSION, agentHash: SELF_HASH, managed: MANAGED, ompVersion: ompVer,
						permissions: await permissions(), hostsError, update, runtime: process.execPath },
					hosts,
					dirs: await suggestedDirs(hosts),
					results: sent,
					tasks: sentTasks,
					runningTasks: [...runningTasks.keys()],
				}),
				signal: AbortSignal.timeout(15_000),
			});
			if (res.status === 401) throw new Error("대시보드가 토큰을 거부했습니다 (재발급되었다면 설치 명령을 다시 실행하세요)");
			if (!res.ok) throw new Error(`대시보드 응답 ${res.status}`);
			const { commands = [], target } = (await res.json()) as { commands?: Command[]; target?: Target };
			for (const c of commands) {
				void handle(c).then(r => {
					results.push({ id: c.id, ...r });
					wake?.();
				});
			}
			if (target) {
				followTarget(target);
				restartStaleWhenIdle(hosts, target.autoRestart);
				await selfUpdate(target.agentHash);
			}
			if (lastError) log("다시 연결되었습니다");
			lastError = "";
		} catch (err) {
			results.unshift(...sent); // deliver them on the next successful sync
			taskUpdates.unshift(...sentTasks);
			const msg = err instanceof Error ? err.message : String(err);
			if (msg !== lastError) log("동기화 실패:", msg);
			lastError = msg;
		}
		await Promise.race([sleep(lastError ? SYNC_MS * 5 : SYNC_MS), new Promise<void>(r => (wake = r))]);
		wake = null;
	}
}

process.on("SIGTERM", () => {
	keepAwake(false);
	process.exit(0);
});
await main();
