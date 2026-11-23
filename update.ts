/**
 * omp self-update plus a matching rebuild of the vendored collab-web guest client.
 *
 * `omp update` replaces the binary in place; running sessions keep the old one until restarted.
 * The guest client (`collab-web/`) is built from the omp repository at the tag of the installed
 * version so the browser speaks the same protocol as freshly started hosts.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLIENT_DIR, reloadClientFiles } from "./relay";

const OMP_REPO = "https://github.com/can1357/oh-my-pi";
const CLIENT_VERSION_FILE = path.join(CLIENT_DIR, "VERSION");
const CHECK_TTL_MS = 60 * 60_000;
const STEP_TIMEOUT_MS = 15 * 60_000;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface UpdateStatus {
	ompVersion: string | null;
	latestVersion: string | null;
	checkedAt: number | null;
	checkError: string | null;
	clientVersion: string | null;
	job: { status: "idle" | "running" | "error"; error: string | null; log: string[] };
}

const job: UpdateStatus["job"] = { status: "idle", error: null, log: [] };
let lastCheck: { at: number; latest: string | null; error: string | null } | null = null;

function log(message: string): void {
	job.log.push(`[${new Date().toLocaleTimeString("ko-KR")}] ${message}`);
	console.log(`[업데이트] ${message}`);
}

/** Run a command, streaming each output line into the job log; throws on non-zero exit. */
async function run(cmd: string[], opts: { cwd?: string; quiet?: boolean } = {}): Promise<string> {
	const proc = Bun.spawn(cmd, {
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1", CI: "1" },
	});
	const timer = setTimeout(() => proc.kill(), STEP_TIMEOUT_MS);
	let output = "";
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		let pending = "";
		for await (const chunk of stream) {
			const text = decoder.decode(chunk, { stream: true });
			output += text;
			pending += text;
			const lines = pending.split(/\r?\n|\r/);
			pending = lines.pop() ?? "";
			if (!opts.quiet) for (const line of lines) if (line.trim()) log(line.trim());
		}
		if (!opts.quiet && pending.trim()) log(pending.trim());
	};
	try {
		const [, , code] = await Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]);
		if (code !== 0) {
			const tail = output.trim().split("\n").slice(-3).join(" / ");
			throw new Error(`${path.basename(cmd[0]!)} ${cmd[1] ?? ""} 실패 (종료 코드 ${code})${tail ? `: ${tail}` : ""}`);
		}
		return output;
	} finally {
		clearTimeout(timer);
	}
}

export async function ompVersion(ompBin: string): Promise<string | null> {
	try {
		const out = await run([ompBin, "--version"], { quiet: true });
		return /(\d+\.\d+\.\d+[^\s]*)/.exec(out)?.[1] ?? null;
	} catch {
		return null;
	}
}

/**
 * Fixes applied to omp's collab-web source before each build. Bump CLIENT_PATCH_LEVEL when this list
 * changes so existing builds are flagged for a rebuild. A patch whose anchor is gone (upstream changed
 * or fixed it) is skipped with a log line instead of failing the build.
 */
const CLIENT_PATCH_LEVEL = "1";
const CLIENT_PATCH_FILE = path.join(CLIENT_DIR, "PATCH_LEVEL");
const CLIENT_PATCHES: { file: string; find: string; replace: string; label: string }[] = [
	{
		label: "플랜 승인 대기 시 'aborted __omp.silent_abort__' 표시 숨김",
		file: "packages/collab-web/src/components/transcript/Transcript.tsx",
		// The TUI hides silent aborts (plan review, user-initiated handoffs) via isSilentAbort; the web client did not.
		find: `const failed = !pending && (stop === "error" || stop === "aborted");`,
		replace: `const failed = !pending && (stop === "error" || stop === "aborted") && message.errorMessage !== "__omp.silent_abort__";`,
	},
];

async function applyClientPatches(work: string): Promise<void> {
	for (const p of CLIENT_PATCHES) {
		const file = path.join(work, p.file);
		const src = await fs.readFile(file, "utf8").catch(() => null);
		if (src === null || !src.includes(p.find)) {
			log(`패치 건너뜀 (원본 코드가 바뀜): ${p.label}`);
			continue;
		}
		await fs.writeFile(file, src.replace(p.find, p.replace));
		log(`패치 적용: ${p.label}`);
	}
}

/** Built client version; flagged when it predates the current patch list so the UI offers a rebuild. */
async function clientVersion(): Promise<string | null> {
	try {
		const version = (await fs.readFile(CLIENT_VERSION_FILE, "utf8")).trim();
		if (!version) return null;
		const level = (await fs.readFile(CLIENT_PATCH_FILE, "utf8").catch(() => "")).trim();
		return level === CLIENT_PATCH_LEVEL ? version : `${version} (패치 전)`;
	} catch {
		return null;
	}
}

async function checkLatest(ompBin: string, force: boolean): Promise<void> {
	if (!force && lastCheck && Date.now() - lastCheck.at < CHECK_TTL_MS) return;
	try {
		const out = await run([ompBin, "update", "--check"], { quiet: true });
		const available = /New version available:\s*(\S+)/.exec(out)?.[1];
		const current = /Current version:\s*(\S+)/.exec(out)?.[1];
		const latest = available ?? (/Already up to date/i.test(out) ? (current ?? (await ompVersion(ompBin))) : null);
		lastCheck = { at: Date.now(), latest, error: latest ? null : "최신 버전을 확인하지 못했습니다" };
	} catch (err) {
		lastCheck = { at: Date.now(), latest: null, error: err instanceof Error ? err.message : String(err) };
	}
}

// ---------- release notes ----------

const CHANGELOG_URL = "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/CHANGELOG.md";
const CHANGELOG_TTL_MS = 60 * 60_000;
const CHANGELOG_LIMIT = 20;
const RELEASE_HEADING_RE = /^## \[(\d+\.\d+\.\d+[^\]]*)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/;

/** Released sections never change, so a translation is cached on disk forever, keyed by version. */
const TRANSLATION_DIR = path.resolve(import.meta.dir, "data", "changelog-ko");
const TRANSLATION_MODEL = "anthropic/claude-haiku-4-5";
const TRANSLATION_CONCURRENCY = 2;
const TRANSLATION_TIMEOUT_MS = 5 * 60_000;
const TRANSLATION_RETRY_MS = 10 * 60_000;
const TRANSLATION_PROMPT = [
	"You translate software release notes from English to Korean.",
	"Output only the translated Markdown, with no preamble and no code fence around it.",
	"Keep the Markdown structure, headings, list markers, links and URLs exactly.",
	"Never translate or alter text inside backticks, code, identifiers, CLI flags, file paths, setting keys, model names or @usernames.",
	"Translate the section headings Breaking Changes/Added/Changed/Fixed/Removed/Deprecated/Security as 주요 변경/추가/변경/수정/제거/지원 중단/보안.",
	"Write concise, natural Korean in the ~합니다 style.",
].join(" ");

interface ParsedRelease {
	version: string;
	date: string | null;
	markdown: string;
}

export interface Release {
	version: string;
	date: string | null;
	html: string;
	/** html is the Korean translation; false while it is pending or after it failed (English shown). */
	translated: boolean;
}

export interface ReleaseNotes {
	releases: Release[];
	/** Versions still waiting for (or being) translated. */
	translating: number;
	translationError: string | null;
}

let changelogCache: { at: number; releases: ParsedRelease[] } | null = null;
const translations = new Map<string, string>(); // version -> Korean markdown
const translationQueue: { version: string; markdown: string }[] = [];
const translating = new Set<string>();
const translationFailures = new Map<string, { at: number; error: string }>();
let activeTranslations = 0;

// Raw HTML is escaped; link URLs are filtered client-side. Release sections only use `###` headings,
// which a translation sometimes promotes to `#`.
const renderMarkdown = (markdown: string) =>
	Bun.markdown.html(markdown.replace(/^#{1,6} /gm, "### "), { noHtmlBlocks: true, noHtmlSpans: true });
const translationFile = (version: string) => path.join(TRANSLATION_DIR, `${version}.md`);

async function fetchChangelog(refresh: boolean): Promise<ParsedRelease[]> {
	if (!refresh && changelogCache && Date.now() - changelogCache.at < CHANGELOG_TTL_MS) return changelogCache.releases;
	const res = await fetch(CHANGELOG_URL, { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw new Error(`변경 내역을 가져오지 못했습니다 (HTTP ${res.status})`);
	const releases: ParsedRelease[] = [];
	let current: { version: string; date: string | null; lines: string[] } | null = null;
	const flush = () => {
		if (current) releases.push({ version: current.version, date: current.date, markdown: current.lines.join("\n").trim() });
	};
	for (const line of (await res.text()).split("\n")) {
		if (line.startsWith("## ")) {
			flush();
			const m = RELEASE_HEADING_RE.exec(line);
			current = m ? { version: m[1]!, date: m[2] ?? null, lines: [] } : null;
			if (releases.length >= CHANGELOG_LIMIT) break;
			continue;
		}
		current?.lines.push(line);
	}
	if (releases.length < CHANGELOG_LIMIT) flush();
	changelogCache = { at: Date.now(), releases: releases.slice(0, CHANGELOG_LIMIT) };
	return changelogCache.releases;
}

async function translate(ompBin: string, markdown: string): Promise<string> {
	const proc = Bun.spawn(
		[
			ompBin, "-p", "--no-session", "--no-tools", "--no-extensions", "--thinking", "off",
			// `--`: a section can start with a `- ` bullet, which omp would otherwise parse as a flag.
			"--model", TRANSLATION_MODEL, "--system-prompt", TRANSLATION_PROMPT, "--", markdown,
		],
		{ stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } },
	);
	const timer = setTimeout(() => proc.kill(), TRANSLATION_TIMEOUT_MS);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(stderr.trim().split("\n").pop() || `omp 종료 코드 ${code}`);
		const text = stdout.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, "$1").trim();
		// A translation that lost most of the links is a summary or a refusal, not a translation.
		const links = (s: string) => (s.match(/\]\(/g) ?? []).length;
		if (!text || links(text) < Math.floor(links(markdown) * 0.8)) throw new Error("번역 결과가 원문과 맞지 않습니다");
		return text;
	} finally {
		clearTimeout(timer);
	}
}

function pumpTranslations(ompBin: string): void {
	while (activeTranslations < TRANSLATION_CONCURRENCY && translationQueue.length) {
		const { version, markdown } = translationQueue.shift()!;
		activeTranslations++;
		void (async () => {
			try {
				const korean = await translate(ompBin, markdown);
				await fs.mkdir(TRANSLATION_DIR, { recursive: true });
				await fs.writeFile(translationFile(version), korean);
				translations.set(version, korean);
				translationFailures.delete(version);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				translationFailures.set(version, { at: Date.now(), error });
				console.warn(`[변경 내역] v${version} 번역 실패: ${error}`);
			} finally {
				translating.delete(version);
				activeTranslations--;
				pumpTranslations(ompBin);
			}
		})();
	}
}

/** Released sections of omp's CHANGELOG.md, newest first, in Korean where translated (translation runs in the background). */
export async function releaseNotes(ompBin: string, opts: { refresh?: boolean } = {}): Promise<ReleaseNotes> {
	const parsed = await fetchChangelog(opts.refresh === true);
	for (const r of parsed) {
		if (translations.has(r.version) || translating.has(r.version)) continue;
		const cached = await fs.readFile(translationFile(r.version), "utf8").catch(() => null);
		if (cached) {
			translations.set(r.version, cached);
			continue;
		}
		const failure = translationFailures.get(r.version);
		if (r.markdown && (!failure || Date.now() - failure.at > TRANSLATION_RETRY_MS)) {
			translating.add(r.version);
			translationQueue.push({ version: r.version, markdown: r.markdown }); // newest first
		}
	}
	pumpTranslations(ompBin);
	const failed = parsed.find(r => !translations.has(r.version) && translationFailures.has(r.version));
	return {
		releases: parsed.map(r => {
			const korean = translations.get(r.version);
			return { version: r.version, date: r.date, html: renderMarkdown(korean ?? r.markdown), translated: korean !== undefined };
		}),
		translating: parsed.filter(r => translating.has(r.version)).length,
		translationError: failed ? translationFailures.get(failed.version)!.error : null,
	};
}

export async function updateStatus(ompBin: string, opts: { refresh?: boolean } = {}): Promise<UpdateStatus> {
	await checkLatest(ompBin, opts.refresh === true);
	return {
		ompVersion: await ompVersion(ompBin),
		latestVersion: lastCheck?.latest ?? null,
		checkedAt: lastCheck?.at ?? null,
		checkError: lastCheck?.error ?? null,
		clientVersion: await clientVersion(),
		job,
	};
}

/** Build collab-web at `v<version>` and atomically swap it into CLIENT_DIR. */
async function rebuildClient(version: string): Promise<void> {
	if (!VERSION_RE.test(version)) throw new Error(`버전 형식이 올바르지 않습니다: ${version}`);
	const git = Bun.which("git");
	if (!git) throw new Error("git이 설치되어 있지 않아 세션 화면을 다시 빌드할 수 없습니다");
	const work = await fs.mkdtemp(path.join(os.tmpdir(), "omp-web-client-"));
	const staged = `${CLIENT_DIR}.new`;
	const retired = `${CLIENT_DIR}.old`;
	try {
		log(`세션 화면 소스 받는 중: v${version}`);
		await run([git, "clone", "--quiet", "--depth", "1", "--branch", `v${version}`, OMP_REPO, work], { quiet: true });
		log("의존성 설치 중…");
		await run([process.execPath, "install", "--frozen-lockfile"], { cwd: work, quiet: true }).catch(() =>
			run([process.execPath, "install"], { cwd: work, quiet: true }),
		);
		await applyClientPatches(work);
		log("세션 화면 빌드 중…");
		const pkg = path.join(work, "packages", "collab-web");
		await run([process.execPath, "run", "build"], { cwd: pkg, quiet: true });
		const dist = path.join(pkg, "dist");
		const indexFile = path.join(dist, "index.html");
		// Drop the hosted site's third-party analytics script; everything else is served as built.
		const html = (await fs.readFile(indexFile, "utf8"))
			.split("\n")
			.filter(line => !/<script[^>]+src="https?:\/\//.test(line))
			.join("\n");
		await fs.writeFile(indexFile, html);
		await fs.writeFile(path.join(dist, "VERSION"), `${version}\n`);
		await fs.writeFile(path.join(dist, "PATCH_LEVEL"), `${CLIENT_PATCH_LEVEL}\n`);

		await fs.rm(staged, { recursive: true, force: true });
		await fs.rm(retired, { recursive: true, force: true });
		await fs.cp(dist, staged, { recursive: true });
		const hadClient = await fs.stat(CLIENT_DIR).then(() => true, () => false);
		if (hadClient) await fs.rename(CLIENT_DIR, retired);
		await fs.rename(staged, CLIENT_DIR);
		reloadClientFiles();
		await fs.rm(retired, { recursive: true, force: true });
		log(`세션 화면을 v${version}으로 교체했습니다`);
	} catch (err) {
		// Restore the previous client if the swap was interrupted midway.
		if (!(await fs.stat(CLIENT_DIR).catch(() => null)) && (await fs.stat(retired).catch(() => null))) {
			await fs.rename(retired, CLIENT_DIR);
			reloadClientFiles();
		}
		await fs.rm(staged, { recursive: true, force: true });
		throw err;
	} finally {
		await fs.rm(work, { recursive: true, force: true });
	}
}

async function runUpdate(ompBin: string): Promise<void> {
	job.status = "running";
	job.error = null;
	job.log = [];
	try {
		const before = await ompVersion(ompBin);
		log(`현재 omp 버전: ${before ?? "알 수 없음"}`);
		await run([ompBin, "update"]);
		const after = await ompVersion(ompBin);
		if (!after) throw new Error("업데이트 후 omp 버전을 확인할 수 없습니다");
		log(before === after ? `omp는 이미 최신입니다 (${after})` : `omp ${before} → ${after}`);
		lastCheck = null;
		if ((await clientVersion()) === after) log(`세션 화면은 이미 v${after}입니다`);
		else await rebuildClient(after);
		if (before !== after) log("실행 중인 세션은 쉬고 있을 때 새 버전으로 다시 시작됩니다 (자동 적용이 켜져 있으면)");
		log("완료");
		job.status = "idle";
	} catch (err) {
		job.status = "error";
		job.error = err instanceof Error ? err.message : String(err);
		log(`실패: ${job.error}`);
	}
}

/** Starts the update in the background; false if one is already running. */
export function startUpdate(ompBin: string): boolean {
	if (job.status === "running") return false;
	void runUpdate(ompBin);
	return true;
}
