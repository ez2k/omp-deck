/**
 * Remote computers ("nodes"): a Mac (or another machine) runs `node-agent/agent.ts`, which posts its
 * omp collab sessions to `/node/sync` every couple of seconds and picks up commands queued here
 * (start/stop a session, make a join link, ask for screen permissions). The sessions themselves
 * join this server's relay, so the dashboard opens them like local ones.
 *
 * Auth: one shared node token (`data/node-token`, `Authorization: Bearer`), separate from the
 * dashboard login so an install command never grants dashboard access.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dir, "data");
const TOKEN_FILE = path.join(DATA_DIR, "node-token");
const NODES_FILE = path.join(DATA_DIR, "nodes.json");
const AGENT_PATH = path.resolve(import.meta.dir, "node-agent", "agent.ts");
/** A node that has not synced for this long is offline and its sessions are hidden. */
const NODE_OFFLINE_MS = 15_000;
const COMMAND_TIMEOUT_MS = 20_000;
const NODE_ID_RE = /^[0-9a-f]{16}$/;
const LAUNCHD_LABEL = "dev.omp-deck.node";

export interface RemoteHost {
	instanceId: string;
	sessionId: string;
	pid: number;
	cwd: string;
	tmux?: string | null;
	[key: string]: unknown;
}

interface NodeInfo {
	id: string;
	name: string;
	platform: string;
	arch: string;
	hostname: string;
	agentVersion: string;
	/** sha256 of the agent.ts it runs; differs from ours until it replaces itself. */
	agentHash: string | null;
	/** Run by launchd, so it can replace itself and be restarted. */
	managed: boolean;
	ompVersion: string | null;
	permissions: { screen: boolean | null; accessibility: boolean | null } | null;
	hostsError: string | null;
	update: { state: "idle" | "updating" | "failed"; targetVersion: string | null; error: string | null; at: number } | null;
	/** The Bun binary running the agent: what macOS privacy settings must allow. */
	runtime: string | null;
	lastSeen: number;
}

/** What every agent is told to converge on. */
export interface NodeTargets {
	ompVersion: () => Promise<string | null>;
	/** Restart sessions on the old omp once idle (the dashboard's own setting). */
	autoRestart: () => boolean;
}

let agentHashCache: { mtimeMs: number; hash: string } | null = null;
async function agentHash(): Promise<string> {
	const { mtimeMs } = await fs.stat(AGENT_PATH);
	if (agentHashCache?.mtimeMs !== mtimeMs) {
		agentHashCache = { mtimeMs, hash: crypto.createHash("sha256").update(await fs.readFile(AGENT_PATH)).digest("hex") };
	}
	return agentHashCache.hash;
}

interface NodeCommand {
	id: string;
	type: "new" | "stop" | "link" | "permissions" | "update" | "task" | "task-cancel" | "dirs";
	[key: string]: unknown;
}

export type CommandResult = { ok: true; data?: unknown } | { ok: false; error: string; code?: string };

interface NodeState {
	info: NodeInfo;
	hosts: RemoteHost[];
	dirs: string[];
	/** Not yet handed to the agent. */
	queue: NodeCommand[];
}

const nodes = new Map<string, NodeState>();
const waiters = new Map<string, { resolve: (r: CommandResult) => void; timer: Timer }>();

let token = "";
async function nodeToken(): Promise<string> {
	if (token) return token;
	try {
		token = (await fs.readFile(TOKEN_FILE, "utf8")).trim();
	} catch {}
	if (!token) await rotateNodeToken();
	return token;
}

export async function rotateNodeToken(): Promise<void> {
	token = crypto.randomBytes(24).toString("base64url");
	await fs.mkdir(DATA_DIR, { recursive: true });
	await fs.writeFile(TOKEN_FILE, token + "\n", { mode: 0o600 });
}

// Offline nodes stay listed (name, last seen) across restarts until the user removes them.
try {
	for (const info of JSON.parse(await fs.readFile(NODES_FILE, "utf8")) as NodeInfo[]) {
		if (NODE_ID_RE.test(info.id)) nodes.set(info.id, { info, hosts: [], dirs: [], queue: [] });
	}
} catch {}

let saveTimer: Timer | null = null;
function saveNodesSoon(): void {
	saveTimer ??= setTimeout(() => {
		saveTimer = null;
		const list = [...nodes.values()].map(n => n.info);
		fs.writeFile(NODES_FILE, JSON.stringify(list), { mode: 0o600 }).catch(err => console.error("노드 목록 저장 실패:", err));
	}, 1_000);
}

const online = (n: NodeState) => Date.now() - n.info.lastSeen < NODE_OFFLINE_MS;

async function authorized(req: Request): Promise<boolean> {
	const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
	if (!m) return false;
	const given = Buffer.from(m[1]!);
	const expected = Buffer.from(await nodeToken());
	return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

async function sync(req: Request, targets: NodeTargets): Promise<Response> {
	let body: Record<string, any>;
	try {
		body = (await req.json()) as Record<string, any>;
	} catch {
		return Response.json({ error: "JSON이 아닙니다" }, { status: 400 });
	}
	const n = body.node ?? {};
	if (!NODE_ID_RE.test(String(n.id))) return Response.json({ error: "node.id가 올바르지 않습니다" }, { status: 400 });
	const prev = nodes.get(n.id);
	const perms = n.permissions && typeof n.permissions === "object"
		? { screen: typeof n.permissions.screen === "boolean" ? n.permissions.screen : null,
			accessibility: typeof n.permissions.accessibility === "boolean" ? n.permissions.accessibility : null }
		: null;
	const info: NodeInfo = {
		id: n.id,
		name: str(n.name, 80) || "원격 컴퓨터",
		platform: str(n.platform, 20),
		arch: str(n.arch, 20),
		hostname: str(n.hostname, 120),
		agentVersion: str(n.agentVersion, 20),
		agentHash: /^[0-9a-f]{64}$/.test(String(n.agentHash)) ? n.agentHash : null,
		managed: n.managed === true,
		ompVersion: str(n.ompVersion, 40) || null,
		permissions: perms,
		hostsError: str(n.hostsError, 500) || null,
		update: n.update && typeof n.update === "object" && ["idle", "updating", "failed"].includes(n.update.state)
			? { state: n.update.state, targetVersion: str(n.update.targetVersion, 40) || null, error: str(n.update.error, 1000) || null,
				at: typeof n.update.at === "number" ? n.update.at : 0 }
			: null,
		runtime: str(n.runtime, 400) || null,
		lastSeen: Date.now(),
	};
	const state: NodeState = prev ?? { info, hosts: [], dirs: [], queue: [] };
	if (!prev || prev.info.name !== info.name || prev.info.ompVersion !== info.ompVersion) saveNodesSoon();
	state.info = info;
	state.hosts = Array.isArray(body.hosts)
		? (body.hosts as RemoteHost[]).filter(h => h && typeof h.instanceId === "string" && typeof h.sessionId === "string")
		: [];
	state.dirs = Array.isArray(body.dirs) ? (body.dirs as unknown[]).filter((d): d is string => typeof d === "string").slice(0, 200) : [];
	nodes.set(info.id, state);
	for (const r of Array.isArray(body.results) ? body.results : []) {
		const w = waiters.get(r?.id);
		if (!w) continue;
		clearTimeout(w.timer);
		waiters.delete(r.id);
		w.resolve(r.ok === true ? { ok: true, data: r.data } : { ok: false, error: str(r.error, 1000) || "실패", code: str(r.code, 40) || undefined });
	}
	syncTasks(info, body);
	const commands = state.queue.splice(0);
	return Response.json({
		commands,
		target: { ompVersion: await targets.ompVersion(), agentHash: await agentHash(), autoRestart: targets.autoRestart() },
	});
}

/** Queues a command for the node's agent and waits for its answer (the agent polls every ~2 s). */
export function nodeCommand(nodeId: string, type: NodeCommand["type"], args: Record<string, unknown> = {}): Promise<CommandResult> {
	const node = nodes.get(nodeId);
	if (!node || !online(node)) return Promise.resolve({ ok: false, error: "원격 컴퓨터가 연결되어 있지 않습니다" });
	const id = crypto.randomUUID();
	node.queue.push({ ...args, id, type });
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			waiters.delete(id);
			node.queue = node.queue.filter(c => c.id !== id);
			resolve({ ok: false, error: `${node.info.name}이(가) 응답하지 않습니다` });
		}, COMMAND_TIMEOUT_MS);
		waiters.set(id, { resolve, timer });
	});
}

/** Sessions of every online node, tagged with the node they run on. */
export function remoteHosts(): (RemoteHost & { node: { id: string; name: string } })[] {
	return [...nodes.values()]
		.filter(online)
		.flatMap(n => n.hosts.map(h => ({ ...h, node: { id: n.info.id, name: n.info.name } })));
}

export function remoteHost(instanceId: string, sessionId?: string | null) {
	const hosts = remoteHosts();
	return hosts.find(h => h.instanceId === instanceId) ?? (sessionId ? hosts.find(h => h.sessionId === sessionId) : undefined);
}

// ---------- tasks: a session on this server hands work to a remote computer ----------

interface RemoteTask {
	id: string;
	nodeId: string;
	nodeName: string;
	state: "running" | "done" | "failed" | "cancelled";
	output: string;
	error: string | null;
	/** The remote screen when the task ended (JPEG base64). */
	image: string | null;
	createdAt: number;
	finishedAt: number | null;
}

const tasks = new Map<string, RemoteTask>();
/** Finished tasks are kept this long for the caller to collect. */
const TASK_KEEP_MS = 60 * 60_000;
/** A running task whose computer stays away this long is given up. */
const TASK_OFFLINE_MS = 2 * 60_000;

function syncTasks(info: NodeInfo, body: Record<string, any>): void {
	for (const u of Array.isArray(body.tasks) ? body.tasks : []) {
		const t = tasks.get(String(u?.taskId));
		if (!t || t.nodeId !== info.id || t.state !== "running") continue;
		t.state = ["done", "failed", "cancelled"].includes(u.state) ? u.state : "failed";
		t.output = str(u.output, 40_000);
		t.error = str(u.error, 2_000) || null;
		t.image = typeof u.image === "string" && u.image.length < 4_000_000 ? u.image : null;
		t.finishedAt = Date.now();
	}
	// The agent lists what it still runs: a task it no longer knows was lost (e.g. the agent restarted).
	const running = new Set(Array.isArray(body.runningTasks) ? body.runningTasks.map(String) : []);
	for (const t of tasks.values()) {
		if (t.nodeId === info.id && t.state === "running" && Date.now() - t.createdAt > 15_000 && !running.has(t.id) && !(body.tasks ?? []).some((u: { taskId?: string }) => u?.taskId === t.id)) {
			Object.assign(t, { state: "failed", error: "원격 컴퓨터의 연결 프로그램이 다시 시작되어 작업이 끊겼습니다", finishedAt: Date.now() });
		}
	}
}

function pruneTasks(): void {
	const now = Date.now();
	for (const t of tasks.values()) {
		const node = nodes.get(t.nodeId);
		if (t.state === "running" && (!node || now - node.info.lastSeen > TASK_OFFLINE_MS)) {
			Object.assign(t, { state: "failed", error: `${t.nodeName}의 연결이 끊겨 작업 결과를 받을 수 없습니다`, finishedAt: now });
		}
		if (t.finishedAt && now - t.finishedAt > TASK_KEEP_MS) tasks.delete(t.id);
	}
}

/** The online computer named (by name or id, case-insensitive), or the only one when none is named. */
function pickNode(selector: string | null | undefined): NodeState | string {
	const list = [...nodes.values()].filter(online);
	if (!list.length) return "연결된 원격 컴퓨터가 없습니다. 대시보드의 '원격' 창에서 Mac을 연결하세요";
	if (!selector) {
		if (list.length === 1) return list[0]!;
		return `원격 컴퓨터가 여러 대 연결되어 있습니다 (${list.map(n => n.info.name).join(", ")}). computer로 하나를 고르세요`;
	}
	const s = selector.toLowerCase();
	return list.find(n => n.info.id === selector || n.info.name.toLowerCase() === s)
		?? list.find(n => n.info.name.toLowerCase().includes(s))
		?? `'${selector}' 컴퓨터를 찾을 수 없습니다. 연결된 컴퓨터: ${list.map(n => n.info.name).join(", ")}`;
}

export function remoteComputers() {
	return [...nodes.values()].filter(online).map(n => ({
		name: n.info.name,
		platform: n.info.platform,
		permissions: n.info.permissions,
		runningTasks: [...tasks.values()].filter(t => t.nodeId === n.info.id && t.state === "running").length,
	}));
}

export async function startRemoteTask(opts: {
	computer?: string | null;
	prompt: string;
	key: string;
	fresh?: boolean;
	cwd?: string;
	timeoutSec?: number;
	model?: string;
}): Promise<{ task: RemoteTask } | { error: string }> {
	pruneTasks();
	const node = pickNode(opts.computer);
	if (typeof node === "string") return { error: node };
	const id = crypto.randomUUID();
	// Registered before the command goes out: a run that ends at once reports in the same sync
	// that acknowledges the command, and that report must find its task.
	const task: RemoteTask = {
		id, nodeId: node.info.id, nodeName: node.info.name, state: "running",
		output: "", error: null, image: null, createdAt: Date.now(), finishedAt: null,
	};
	tasks.set(id, task);
	const r = await nodeCommand(node.info.id, "task", {
		taskId: id, prompt: opts.prompt, key: opts.key, fresh: opts.fresh === true,
		cwd: opts.cwd, timeoutSec: opts.timeoutSec, model: opts.model,
	});
	if (!r.ok) {
		tasks.delete(id);
		return { error: r.error };
	}
	return { task };
}

export function remoteTask(id: string): RemoteTask | undefined {
	pruneTasks();
	return tasks.get(id);
}

export async function cancelRemoteTask(id: string): Promise<CommandResult> {
	const t = tasks.get(id);
	if (!t || t.state !== "running") return { ok: false, error: "실행 중인 작업이 아닙니다" };
	return await nodeCommand(t.nodeId, "task-cancel", { taskId: id });
}

export function nodeOnline(nodeId: string): boolean {
	const n = nodes.get(nodeId);
	return !!n && online(n);
}

export async function nodesStatus(baseUrl: string) {
	const hash = await agentHash();
	return {
		nodes: [...nodes.values()].map(n => ({
			...n.info,
			online: online(n),
			sessions: online(n) ? n.hosts.length : 0,
			dirs: n.dirs,
			agentCurrent: n.info.agentHash === hash,
		})),
		installCommand: `curl -fsSL -H 'Authorization: Bearer ${await nodeToken()}' ${baseUrl}/node/install.sh | bash`,
	};
}

export function forgetNode(nodeId: string): boolean {
	const removed = nodes.delete(nodeId);
	if (removed) saveNodesSoon();
	return removed;
}

function installScript(baseUrl: string, ompVersion: string | null): string {
	const relay = baseUrl.replace(/^http/, "ws");
	const pin = ompVersion ? `@${ompVersion}` : "";
	return `#!/bin/bash
# omp-web 원격 연결 설치: 이 컴퓨터의 omp 세션을 ${baseUrl} 대시보드에서 쓰게 합니다.
set -euo pipefail
URL=${shq(baseUrl)}
TOKEN=${shq(token)}
DIR="$HOME/.omp-web-node"
LABEL=${LAUNCHD_LABEL}

say() { printf '\\n\\033[1m== %s\\033[0m\\n' "$*"; }
if [ "$(uname)" != "Darwin" ]; then echo "이 설치 스크립트는 macOS용입니다."; exit 1; fi

say "Bun 확인"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v bun >/dev/null; then curl -fsSL https://bun.sh/install | bash; fi
BUN="$(command -v bun)"

say "omp 확인"
if ! command -v omp >/dev/null; then
	bun install -g @oh-my-pi/pi-coding-agent${pin}
fi
# omp 패키지는 최신 Bun을 요구합니다: 실행되지 않으면 Bun을 올립니다.
if ! omp --version >/dev/null 2>&1; then bun upgrade; fi
if ! omp --version >/dev/null 2>&1; then omp --version; echo "omp를 실행할 수 없습니다."; exit 1; fi
echo "설치됨: $(omp --version 2>/dev/null | head -n 1)${ompVersion ? ` (서버는 ${ompVersion}, 다르면 연결 후 자동으로 맞춥니다)` : ""}"

say "tmux 확인"
if ! command -v tmux >/dev/null; then
	if command -v brew >/dev/null; then brew install tmux
	else echo "tmux가 필요합니다. Homebrew(https://brew.sh)를 설치한 뒤 이 명령을 다시 실행하세요."; exit 1; fi
fi

say "연결 프로그램 설치 ($DIR)"
mkdir -p "$DIR"
curl -fsSL -H "Authorization: Bearer $TOKEN" "$URL/node/agent.ts" -o "$DIR/agent.ts"
# 대시보드에서 시작한 세션에만 적용: 이 서버 릴레이로 공유, 컴퓨터 제어 켜기, 화면 제어 묻지 않고 허용.
# omp 버전은 연결 프로그램이 대시보드에 맞추므로 세션이 스스로 업데이트하지 않게 합니다.
cat > "$DIR/overlay.yml" <<EOF
collab:
  autoStart: control
  relayUrl: ${relay}
  webUrl: ${baseUrl}/join
computer:
  enabled: true
tools:
  approval:
    computer.control: allow
update:
  auto: false
EOF

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array><string>$BUN</string><string>$DIR/agent.ts</string></array>
	<key>EnvironmentVariables</key><dict>
		<key>PATH</key><string>$PATH</string>
		<key>OMP_WEB_URL</key><string>$URL</string>
		<key>OMP_WEB_NODE_TOKEN</key><string>$TOKEN</string>
		<key>OMP_WEB_NODE_MANAGED</key><string>1</string>
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>AbandonProcessGroup</key><true/>
	<key>ProcessType</key><string>Interactive</string>
	<key>StandardOutPath</key><string>$DIR/agent.log</string>
	<key>StandardErrorPath</key><string>$DIR/agent.log</string>
</dict></plist>
EOF
chmod 600 "$PLIST"
# Earlier installs may have used another label: remove those agents so only one runs.
for OLD in "$HOME/Library/LaunchAgents/"*omp-web-node.plist; do
	[ -e "$OLD" ] && [ "$OLD" != "$PLIST" ] || continue
	launchctl bootout "gui/$(id -u)" "$OLD" 2>/dev/null || true
	rm -f "$OLD"
done
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

say "완료"
echo "대시보드의 '원격 컴퓨터' 창에 이 Mac이 곧 나타납니다. 로그: $DIR/agent.log"
echo "남은 일:"
echo " 1. 이 Mac에서 omp를 처음 쓰면 터미널에서 'omp'를 한 번 실행해 모델 로그인을 하세요."
echo " 2. 대시보드 '원격 컴퓨터' 창에서 [권한 요청]을 누른 뒤, 이 Mac의 시스템 설정 > 개인정보 보호 및 보안에서"
echo "    '화면 및 시스템 오디오 녹음'과 '손쉬운 사용'에 bun을 허용하세요 ($BUN)."
echo "제거: launchctl bootout gui/\\$(id -u)/$LABEL; rm -rf \\"$DIR\\" \\"$PLIST\\""
`;
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** `/node/*` endpoints used by agents (and the installer). Returns null for other paths. */
export async function handleNodeEndpoint(req: Request, pathname: string, baseUrl: string, targets: NodeTargets): Promise<Response | null> {
	if (!pathname.startsWith("/node/")) return null;
	if (!(await authorized(req))) return Response.json({ error: "인증이 필요합니다" }, { status: 401 });
	if (pathname === "/node/sync" && req.method === "POST") return await sync(req, targets);
	if (pathname === "/node/agent.ts" && req.method === "GET") {
		return new Response(Bun.file(AGENT_PATH), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
	}
	if (pathname === "/node/install.sh" && req.method === "GET") {
		return new Response(installScript(baseUrl, await targets.ompVersion()), {
			headers: { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-store" },
		});
	}
	return Response.json({ error: "찾을 수 없습니다" }, { status: 404 });
}
