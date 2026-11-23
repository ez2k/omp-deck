/**
 * The control bot: one omp agent (RPC mode, `omp-extension/control-tools.ts` loaded) that operates the
 * dashboard on request. People talk to it from the dashboard's chat panel and from Telegram; both
 * share one conversation. Dashboard notifications are forwarded to the linked Telegram chats.
 *
 * State in data/: bot.json (settings, linked chats), bot-chat.json (recent chat for the panel),
 * bot-sessions/ (the agent's own omp session, continued across restarts).
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Subprocess } from "bun";

const DATA_DIR = path.resolve(import.meta.dir, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "bot.json");
const CHAT_FILE = path.join(DATA_DIR, "bot-chat.json");
const SESSION_DIR = path.join(DATA_DIR, "bot-sessions");
const PROMPT_FILE = path.join(DATA_DIR, "bot-system.md");
const EXTENSION = path.resolve(import.meta.dir, "omp-extension", "control-tools.ts");
const CHAT_LIMIT = 300;
const PAIR_TTL_MS = 10 * 60_000;
const TELEGRAM_TEXT_MAX = 4000;
const RESTART_BACKOFF_MS = 5_000;

const SYSTEM_PROMPT = `# omp-web 제어 봇

너는 사용자의 omp-web 대시보드를 대신 조작하는 비서다. 사용자는 폰(텔레그램)이나 대시보드 채팅창에서 너에게 말한다.
- 항상 한국어로, 폰에서 읽기 좋게 짧게 답한다. 표 대신 짧은 목록("- ")을 쓴다. 답은 텔레그램에 그대로 가므로 **굵게**, # 제목, 코드 블록 같은 마크다운 서식은 쓰지 않는다.
- 대시보드 일은 dashboard_* 도구로 한다: 세션 목록·대화 읽기·지시 보내기·만들기·모델/생각 수준/계정 바꾸기·종료·재시작·플랜 승인, 사용량, 알림, 계정, 모델, 연결된 컴퓨터.
- 사용자의 Mac 같은 원격 컴퓨터 화면에서 할 일은 remote_computer 도구로 맡긴다.
- 세션은 제목 일부나 폴더 이름으로 부를 수 있다. 모호하면 dashboard_sessions로 확인하고 골라서 묻는다.
- 세션 종료처럼 되돌리기 어려운 일은 사용자가 정확히 그것을 시킨 게 아니면 먼저 확인한다.
- 세션에 지시를 보낸 뒤에는 그 세션이 일을 마쳐야 결과가 나온다. 바로 결과를 기다리지 말고, 보냈다고 알리고 나중에 dashboard_session_read로 확인한다.
- 서버의 파일을 직접 고치는 일은 그 프로젝트의 세션에게 맡긴다. 너는 조작과 확인, 요약을 맡는다.
`;

export interface ChatEntry {
	seq: number;
	ts: number;
	role: "user" | "assistant" | "tool" | "notice" | "error";
	source: "web" | "telegram" | "bot";
	text: string;
}

interface Settings {
	telegramToken: string;
	/** Telegram bot username (from getMe), for the pairing link. */
	telegramUsername: string;
	/** Linked Telegram chats: they may talk to the bot and receive notifications. */
	chats: { id: number; name: string }[];
	/** provider/model for the bot, "" = omp's default. */
	model: string;
	pair: { code: string; expiresAt: number } | null;
}

let settings: Settings = { telegramToken: "", telegramUsername: "", chats: [], model: "", pair: null };
try {
	settings = { ...settings, ...JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")) };
} catch {}

let chat: ChatEntry[] = [];
try {
	chat = JSON.parse(await fs.readFile(CHAT_FILE, "utf8"));
} catch {}
let seq = chat.at(-1)?.seq ?? 0;
/** Changes when a new conversation starts, so the panel reloads instead of appending. */
let epoch = chat[0]?.ts ?? Date.now();

async function saveSettings(): Promise<void> {
	await fs.mkdir(DATA_DIR, { recursive: true });
	await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

let chatSaveTimer: Timer | null = null;
function addChat(role: ChatEntry["role"], source: ChatEntry["source"], text: string): ChatEntry {
	const entry: ChatEntry = { seq: ++seq, ts: Date.now(), role, source, text };
	chat.push(entry);
	if (chat.length > CHAT_LIMIT) chat.splice(0, chat.length - CHAT_LIMIT);
	chatSaveTimer ??= setTimeout(() => {
		chatSaveTimer = null;
		fs.writeFile(CHAT_FILE, JSON.stringify(chat), { mode: 0o600 }).catch(err => console.error("봇 대화 저장 실패:", err));
	}, 1_000);
	return entry;
}

// ---------- the agent (omp --mode rpc) ----------

let ompBin = "";
let cwd = "/";
let proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
let starting: Promise<void> | null = null;
let lastExit = 0;
let busy = false;
/** Assistant text streaming right now (shown live in the panel). */
let streaming = "";
/** Telegram chats waiting for the reply to what they sent. */
const replyChats = new Set<number>();

function write(frame: Record<string, unknown>): void {
	if (!proc) throw new Error("봇이 실행 중이 아닙니다");
	proc.stdin.write(JSON.stringify(frame) + "\n");
	proc.stdin.flush();
}

function textOf(message: { content?: unknown } | undefined): string {
	const c = message?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c.filter((p: { type?: string }) => p?.type === "text").map((p: { text?: string }) => p.text ?? "").join("").trim();
}

function onFrame(f: Record<string, any>): void {
	switch (f.type) {
		case "agent_start":
			busy = true;
			streaming = "";
			break;
		case "message_update":
			if (f.assistantMessageEvent?.type === "text_delta") streaming += f.assistantMessageEvent.delta ?? "";
			break;
		case "message_end": {
			if (f.message?.role !== "assistant") break;
			streaming = "";
			// Markdown emphasis shows as raw asterisks in Telegram and the panel.
			const text = textOf(f.message).replace(/\*\*(.+?)\*\*/g, "$1");
			if (text) {
				addChat("assistant", "bot", text);
				for (const id of replyChats) void telegramSend(id, text);
			}
			if (f.message?.stopReason === "error" && f.message?.errorMessage) addChat("error", "bot", String(f.message.errorMessage));
			break;
		}
		case "tool_execution_start":
			addChat("tool", "bot", toolLabel(f.toolName, f.args));
			break;
		case "agent_end":
		case "session_settled":
			busy = false;
			streaming = "";
			if (f.type === "session_settled") replyChats.clear();
			break;
		case "response":
			if (f.success === false && f.command !== "negotiate_protocol") addChat("error", "bot", `${f.command}: ${f.error ?? "실패"}`);
			break;
		case "extension_error":
			console.error("봇 확장 오류:", f.extensionPath, f.error);
			break;
	}
}

const TOOL_NAMES: Record<string, string> = {
	dashboard_sessions: "세션 목록 확인",
	dashboard_session_read: "세션 대화 읽기",
	dashboard_session_send: "세션에 지시 보내기",
	dashboard_session_create: "새 세션 만들기",
	dashboard_session_change: "모델·계정 바꾸기",
	dashboard_session_stop: "세션 종료",
	dashboard_session_restart: "세션 다시 시작",
	dashboard_session_link: "접속 링크 만들기",
	dashboard_plan_get: "플랜 읽기",
	dashboard_plan_answer: "플랜 답하기",
	dashboard_usage: "사용량 확인",
	dashboard_notifications: "알림 확인",
	dashboard_accounts: "계정 확인",
	dashboard_models: "모델 목록 확인",
	dashboard_computers: "연결된 컴퓨터 확인",
	dashboard_dirs: "폴더 찾기",
	remote_computer: "원격 컴퓨터에 작업 맡기기",
};

function toolLabel(name: string, args: Record<string, unknown> | undefined): string {
	const what = TOOL_NAMES[name] ?? name;
	const target = typeof args?.session === "string" ? ` · ${args.session}` : typeof args?.cwd === "string" ? ` · ${args.cwd}` : "";
	return what + target;
}

async function readLoop(stream: ReadableStream<Uint8Array>): Promise<void> {
	const decoder = new TextDecoder();
	let buf = "";
	for await (const chunk of stream) {
		buf += decoder.decode(chunk, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			try {
				onFrame(JSON.parse(line));
			} catch {}
		}
	}
}

async function ensureAgent(): Promise<void> {
	if (proc) return;
	starting ??= (async () => {
		const wait = lastExit + RESTART_BACKOFF_MS - Date.now();
		if (wait > 0) await Bun.sleep(wait);
		await fs.mkdir(SESSION_DIR, { recursive: true });
		await fs.writeFile(PROMPT_FILE, SYSTEM_PROMPT);
		const args = [ompBin, "--mode", "rpc", "--no-ui", "-e", EXTENSION, "--session-dir", SESSION_DIR, "-c",
			"--append-system-prompt", PROMPT_FILE, ...(settings.model ? ["--model", settings.model] : [])];
		const p = Bun.spawn(args, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_NO_TITLE: "1" } });
		proc = p;
		busy = false;
		void readLoop(p.stdout);
		void (async () => {
			const err = await new Response(p.stderr).text();
			const code = await p.exited;
			if (proc === p) proc = null;
			busy = false;
			streaming = "";
			lastExit = Date.now();
			if (code !== 0 && code !== 143) addChat("error", "bot", `봇이 종료되었습니다 (코드 ${code}). 다음 메시지에서 다시 시작합니다.${err.trim() ? `\n${err.trim().split("\n").slice(-3).join("\n")}` : ""}`);
		})();
	})().finally(() => {
		starting = null;
	});
	await starting;
}

/** A message for the bot, from the dashboard panel or a linked Telegram chat. */
export async function botSend(text: string, source: "web" | "telegram", telegramChat?: number): Promise<void> {
	addChat("user", source, text);
	if (telegramChat !== undefined) replyChats.add(telegramChat);
	await ensureAgent();
	// While it works, a new message waits for the current run to end instead of interrupting it.
	write({ id: crypto.randomUUID(), type: "prompt", message: text, streamingBehavior: "followUp" });
}

export function botAbort(): void {
	if (proc && busy) write({ type: "abort" });
}

/** Starts a fresh conversation for the bot (its earlier one stays saved). */
export async function botReset(): Promise<void> {
	await ensureAgent();
	write({ type: "new_session" });
	chat = [];
	epoch = Date.now();
	addChat("notice", "bot", "새 대화를 시작했습니다");
}

export function botStatus(since: number) {
	return {
		epoch,
		entries: chat.filter(e => e.seq > since),
		lastSeq: seq,
		running: proc !== null,
		busy,
		streaming,
		model: settings.model,
		telegram: {
			configured: !!settings.telegramToken,
			username: settings.telegramUsername,
			chats: settings.chats.map(c => c.name),
			pair: settings.pair && settings.pair.expiresAt > Date.now() ? settings.pair : null,
		},
	};
}

export async function botSettings(body: { telegramToken?: unknown; model?: unknown }): Promise<string | null> {
	if (typeof body.model === "string" && body.model !== settings.model) {
		if (body.model && !/^[A-Za-z0-9_./:-]{1,80}$/.test(body.model)) return "모델 형식이 올바르지 않습니다";
		settings.model = body.model;
		// Takes effect on the next message, when the agent starts with the new model.
		if (proc && !busy) proc.kill();
	}
	if (typeof body.telegramToken === "string") {
		const token = body.telegramToken.trim();
		if (token) {
			const me = await telegram<{ username: string }>(token, "getMe", {}).catch((err: Error) => err);
			if (me instanceof Error) return `텔레그램 봇 토큰을 확인할 수 없습니다: ${me.message}. BotFather가 준 '숫자:문자' 형식 전체를 넣으세요`;
			settings.telegramUsername = me.username;
		} else settings.telegramUsername = "";
		if (token !== settings.telegramToken) {
			settings.telegramToken = token;
			settings.chats = [];
			settings.pair = null;
			restartTelegram();
		}
	}
	await saveSettings();
	return null;
}

/** A one-time code the user sends as `/start <code>` to link a Telegram chat. */
export async function botPair(): Promise<{ code: string; expiresAt: number; link: string | null }> {
	const code = String(crypto.randomInt(100000, 1000000));
	settings.pair = { code, expiresAt: Date.now() + PAIR_TTL_MS };
	await saveSettings();
	return { ...settings.pair, link: settings.telegramUsername ? `https://t.me/${settings.telegramUsername}?start=${code}` : null };
}

export async function botUnlink(): Promise<void> {
	settings.chats = [];
	await saveSettings();
}

/** Forwards a dashboard notification to the linked Telegram chats. */
export function botNotify(title: string, body: string, url: string): void {
	for (const c of settings.chats) void telegramSend(c.id, `🔔 ${title}\n${body}\n${url}`);
}

// ---------- Telegram (long polling) ----------

async function telegram<T>(token: string, method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
	const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(params),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
	if (!data?.ok) throw new Error(data?.description ?? `HTTP ${res.status}`);
	return data.result as T;
}

async function telegramSend(chatId: number, text: string): Promise<void> {
	if (!settings.telegramToken) return;
	for (let i = 0; i < text.length; i += TELEGRAM_TEXT_MAX) {
		await telegram(settings.telegramToken, "sendMessage", {
			chat_id: chatId,
			text: text.slice(i, i + TELEGRAM_TEXT_MAX),
			link_preview_options: { is_disabled: true },
		}).catch(err => console.error("텔레그램 전송 실패:", err));
	}
}

let pollGeneration = 0;

function restartTelegram(): void {
	const gen = ++pollGeneration;
	if (settings.telegramToken) void pollTelegram(gen);
}

async function pollTelegram(gen: number): Promise<void> {
	let offset = 0;
	while (gen === pollGeneration && settings.telegramToken) {
		let updates: { update_id: number; message?: { chat: { id: number; first_name?: string; username?: string; title?: string }; text?: string } }[];
		try {
			updates = await telegram(settings.telegramToken, "getUpdates", { offset, timeout: 30, allowed_updates: ["message"] }, 40_000);
		} catch (err) {
			console.error("텔레그램 수신 실패:", err instanceof Error ? err.message : err);
			await Bun.sleep(10_000);
			continue;
		}
		for (const u of updates) {
			offset = u.update_id + 1;
			if (gen !== pollGeneration) return;
			const m = u.message;
			if (m?.text) void onTelegramMessage(m.chat, m.text.trim());
		}
	}
}

async function onTelegramMessage(c: { id: number; first_name?: string; username?: string; title?: string }, text: string): Promise<void> {
	const linked = settings.chats.some(x => x.id === c.id);
	const start = /^\/start(?:@\w+)?\s*(\d{6})?$/.exec(text);
	if (start) {
		const code = start[1];
		if (code && settings.pair && settings.pair.code === code && settings.pair.expiresAt > Date.now()) {
			if (!linked) settings.chats.push({ id: c.id, name: c.title ?? c.username ?? c.first_name ?? String(c.id) });
			settings.pair = null;
			await saveSettings();
			return telegramSend(c.id, "연결되었습니다. 이제 여기서 대시보드에 일을 시킬 수 있고, 작업 알림도 여기로 옵니다.\n예: \"세션 상태 알려줘\", \"쇼핑 세션 지금 뭐 해?\"");
		}
		if (!linked) return telegramSend(c.id, "대시보드의 봇 창에서 '텔레그램 연결'을 눌러 받은 코드를 /start 123456 처럼 보내세요.");
	}
	if (!linked) return telegramSend(c.id, "연결되지 않은 대화입니다. 대시보드의 봇 창에서 연결 코드를 받아 /start 코드 로 보내세요.");
	if (text === "/new") {
		await botReset();
		return telegramSend(c.id, "새 대화를 시작했습니다.");
	}
	if (text === "/stop") {
		botAbort();
		return telegramSend(c.id, "멈췄습니다.");
	}
	if (start) return telegramSend(c.id, "이미 연결되어 있습니다.");
	void typing(c.id);
	await botSend(text, "telegram", c.id).catch(err => telegramSend(c.id, `봇을 시작하지 못했습니다: ${err instanceof Error ? err.message : err}`));
}

/** "typing…" in the chat while the bot works on its message. */
async function typing(chatId: number): Promise<void> {
	await Bun.sleep(300);
	for (let i = 0; i < 120 && (busy || starting); i++) {
		await telegram(settings.telegramToken, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
		await Bun.sleep(5_000);
	}
}

export function startBot(opts: { ompBin: string; cwd: string }): void {
	ompBin = opts.ompBin;
	cwd = opts.cwd;
	restartTelegram();
}
