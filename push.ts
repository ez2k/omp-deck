/**
 * Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291), no dependencies.
 * Subscriptions and the VAPID key pair live in `data/`.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dir, "data");
const VAPID_FILE = path.join(DATA_DIR, "vapid.json");
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "push-subscriptions.json");
/**
 * Apple's push service rejects a `sub` on a reserved domain (`localhost`) with BadJwtToken, so the
 * server sets this to its public https URL when it has one.
 */
let vapidSubject = "mailto:omp-web@example.com";
export function setVapidSubject(subject: string): void {
	vapidSubject = subject;
}
const PUSH_TTL_SECONDS = 24 * 3600;
const RECORD_SIZE = 4096;
/** Browser push services only; the server never POSTs to an arbitrary URL. */
const PUSH_HOST_RE = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;

export interface PushSubscription {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	/** Device label shown in the dashboard (user agent summary). */
	label: string;
	createdAt: number;
}

export interface PushMessage {
	title: string;
	body: string;
	/** Same tag replaces an older notification instead of stacking. */
	tag?: string;
	url?: string;
	/** Dashboard notification id and kind, so the service worker can route a click. */
	id?: string;
	kind?: string;
}

const b64u = (buf: Uint8Array) => Buffer.from(buf).toString("base64url");
const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

let vapid: { publicKey: string; privateJwk: crypto.JsonWebKey } | null = null;

async function loadVapid() {
	if (vapid) return vapid;
	try {
		vapid = JSON.parse(await fs.readFile(VAPID_FILE, "utf8"));
		return vapid!;
	} catch {}
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = publicKey.export({ format: "jwk" });
	// Uncompressed point 0x04 || X || Y is what PushManager.subscribe expects as applicationServerKey.
	const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
	vapid = { publicKey: b64u(raw), privateJwk: privateKey.export({ format: "jwk" }) };
	await fs.mkdir(DATA_DIR, { recursive: true });
	await fs.writeFile(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 });
	return vapid;
}

export async function vapidPublicKey(): Promise<string> {
	return (await loadVapid()).publicKey;
}

let subscriptions: PushSubscription[] | null = null;

async function loadSubscriptions(): Promise<PushSubscription[]> {
	if (subscriptions) return subscriptions;
	try {
		subscriptions = JSON.parse(await fs.readFile(SUBSCRIPTIONS_FILE, "utf8"));
	} catch {
		subscriptions = [];
	}
	return subscriptions!;
}

async function saveSubscriptions(): Promise<void> {
	await fs.mkdir(DATA_DIR, { recursive: true });
	await fs.writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions ?? [], null, 2), { mode: 0o600 });
}

export function validateSubscription(raw: unknown): Omit<PushSubscription, "label" | "createdAt"> | string {
	const s = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
	if (!s || typeof s.endpoint !== "string" || typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string") {
		return "구독 정보 형식이 올바르지 않습니다";
	}
	let url: URL;
	try {
		url = new URL(s.endpoint);
	} catch {
		return "구독 주소가 올바르지 않습니다";
	}
	if (url.protocol !== "https:" || !PUSH_HOST_RE.test(url.hostname)) return "지원하지 않는 푸시 서비스입니다";
	if (fromB64u(s.keys.p256dh).length !== 65 || fromB64u(s.keys.auth).length !== 16) return "구독 키 형식이 올바르지 않습니다";
	return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

export async function addSubscription(sub: Omit<PushSubscription, "label" | "createdAt">, label: string): Promise<void> {
	const list = await loadSubscriptions();
	subscriptions = [...list.filter(s => s.endpoint !== sub.endpoint), { ...sub, label, createdAt: Date.now() }];
	await saveSubscriptions();
}

export async function removeSubscription(endpoint: string): Promise<boolean> {
	const list = await loadSubscriptions();
	subscriptions = list.filter(s => s.endpoint !== endpoint);
	await saveSubscriptions();
	return subscriptions.length !== list.length;
}

export async function hasSubscription(endpoint: string): Promise<boolean> {
	return (await loadSubscriptions()).some(s => s.endpoint === endpoint);
}

export async function subscriptionCount(): Promise<number> {
	return (await loadSubscriptions()).length;
}

function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Buffer {
	return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
}

/** RFC 8291 aes128gcm body for one record. */
function encryptPayload(sub: PushSubscription, plaintext: Uint8Array): Buffer {
	const uaPublic = fromB64u(sub.keys.p256dh);
	const authSecret = fromB64u(sub.keys.auth);
	const ecdh = crypto.createECDH("prime256v1");
	const asPublic = ecdh.generateKeys();
	const sharedSecret = ecdh.computeSecret(uaPublic);
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
	const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);
	const salt = crypto.randomBytes(16);
	const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
	const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
	// 0x02 marks the last (and only) record.
	const encrypted = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
	const header = Buffer.alloc(16 + 4 + 1);
	salt.copy(header, 0);
	header.writeUInt32BE(RECORD_SIZE, 16);
	header.writeUInt8(asPublic.length, 20);
	return Buffer.concat([header, asPublic, encrypted]);
}

async function vapidAuthorization(endpoint: string): Promise<string> {
	const keys = await loadVapid();
	const key = crypto.createPrivateKey({ key: keys.privateJwk, format: "jwk" });
	const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 3600, sub: vapidSubject };
	const body = b64u(Buffer.from(JSON.stringify(claims)));
	// ieee-p1363 gives the raw r||s signature JWS ES256 requires.
	const signature = crypto.sign("sha256", Buffer.from(`${header}.${body}`), { key, dsaEncoding: "ieee-p1363" });
	return `vapid t=${header}.${body}.${b64u(signature)}, k=${keys.publicKey}`;
}

async function sendOne(sub: PushSubscription, message: PushMessage): Promise<"ok" | "gone" | "error"> {
	try {
		const res = await fetch(sub.endpoint, {
			method: "POST",
			headers: {
				Authorization: await vapidAuthorization(sub.endpoint),
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
				TTL: String(PUSH_TTL_SECONDS),
				Urgency: "high",
			},
			body: encryptPayload(sub, Buffer.from(JSON.stringify(message))),
			signal: AbortSignal.timeout(15_000),
		});
		if (res.status === 404 || res.status === 410) return "gone";
		if (!res.ok) {
			console.warn(`[알림] 전송 실패 (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
			return "error";
		}
		return "ok";
	} catch (err) {
		console.warn(`[알림] 전송 실패: ${err instanceof Error ? err.message : String(err)}`);
		return "error";
	}
}

/** Send to every subscribed device; expired subscriptions are dropped. Returns how many accepted it. */
export async function broadcast(message: PushMessage, only?: string): Promise<number> {
	const list = (await loadSubscriptions()).filter(s => !only || s.endpoint === only);
	const results = await Promise.all(list.map(s => sendOne(s, message)));
	const gone = new Set(list.filter((_, i) => results[i] === "gone").map(s => s.endpoint));
	if (gone.size) {
		subscriptions = (await loadSubscriptions()).filter(s => !gone.has(s.endpoint));
		await saveSubscriptions();
	}
	return results.filter(r => r === "ok").length;
}
