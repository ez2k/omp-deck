/**
 * Minimal RFC 8555 (ACME) client for a single-domain certificate via the dns-01 challenge,
 * plus a Cloudflare DNS provider. No dependencies: WebCrypto for the account JWS, `openssl` for the
 * certificate key and CSR.
 */
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LETSENCRYPT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";

export interface DnsProvider {
	/** Publish a TXT record; resolves to a cleanup function that removes it. */
	addTxt(name: string, value: string): Promise<() => Promise<void>>;
	/** Resolves once the TXT value is publicly resolvable. */
	waitTxt(name: string, value: string): Promise<void>;
}

export interface IssueOptions {
	directoryUrl: string;
	domain: string;
	email?: string;
	/** JSON file holding the ACME account private JWK; created on first use. */
	accountKeyFile: string;
	dns: DnsProvider;
	log: (message: string) => void;
}

export interface IssuedCertificate {
	certPem: string;
	keyPem: string;
	notAfter: number;
}

const encoder = new TextEncoder();
const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 180_000;

function b64u(data: string | ArrayBuffer | Uint8Array): string {
	if (typeof data === "string") return Buffer.from(data).toString("base64url");
	return Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)).toString("base64url");
}

export function certificateNotAfter(certPem: string): number {
	return Date.parse(new X509Certificate(certPem).validTo);
}

/** DNS names covered by the leaf certificate. */
export function certificateDomains(certPem: string): string[] {
	const san = new X509Certificate(certPem).subjectAltName ?? "";
	return san
		.split(",")
		.map(s => s.trim())
		.filter(s => s.startsWith("DNS:"))
		.map(s => s.slice(4).toLowerCase());
}

async function loadAccountKey(file: string): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey }> {
	let jwk: JsonWebKey;
	try {
		jwk = JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		const pair = (await crypto.subtle.generateKey(ECDSA_P256, true, ["sign", "verify"])) as CryptoKeyPair;
		jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, JSON.stringify(jwk), { mode: 0o600 });
	}
	const privateKey = await crypto.subtle.importKey("jwk", jwk, ECDSA_P256, false, ["sign"]);
	return { privateKey, publicJwk: { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } };
}

interface AcmeDirectory {
	newNonce: string;
	newAccount: string;
	newOrder: string;
}

interface AcmeProblem {
	type?: string;
	detail?: string;
}

class AcmeClient {
	private nonce: string | null = null;
	private kid: string | null = null;

	private constructor(
		readonly directory: AcmeDirectory,
		private readonly privateKey: CryptoKey,
		private readonly publicJwk: JsonWebKey,
	) {}

	static async create(directoryUrl: string, accountKeyFile: string): Promise<AcmeClient> {
		const res = await fetch(directoryUrl);
		if (!res.ok) throw new Error(`ACME 디렉터리를 불러올 수 없습니다 (HTTP ${res.status})`);
		const { privateKey, publicJwk } = await loadAccountKey(accountKeyFile);
		return new AcmeClient((await res.json()) as AcmeDirectory, privateKey, publicJwk);
	}

	async thumbprint(): Promise<string> {
		const { crv, kty, x, y } = this.publicJwk;
		// RFC 7638: required members only, lexicographic order, no whitespace.
		const canonical = JSON.stringify({ crv, kty, x, y });
		return b64u(await crypto.subtle.digest("SHA-256", encoder.encode(canonical)));
	}

	private async takeNonce(): Promise<string> {
		if (this.nonce) {
			const nonce = this.nonce;
			this.nonce = null;
			return nonce;
		}
		const res = await fetch(this.directory.newNonce, { method: "HEAD" });
		const nonce = res.headers.get("replay-nonce");
		if (!nonce) throw new Error("ACME 서버가 nonce를 주지 않았습니다");
		return nonce;
	}

	/** Signed POST; `payload === null` is POST-as-GET. */
	async post(url: string, payload: unknown, accept?: string): Promise<Response> {
		for (let attempt = 0; ; attempt++) {
			const header = {
				alg: "ES256",
				nonce: await this.takeNonce(),
				url,
				...(this.kid ? { kid: this.kid } : { jwk: this.publicJwk }),
			};
			const protectedB64 = b64u(JSON.stringify(header));
			const payloadB64 = payload === null ? "" : b64u(JSON.stringify(payload));
			// WebCrypto ECDSA signatures are raw r||s, which is exactly JWS ES256.
			const signature = await crypto.subtle.sign(
				{ name: "ECDSA", hash: "SHA-256" },
				this.privateKey,
				encoder.encode(`${protectedB64}.${payloadB64}`),
			);
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/jose+json", ...(accept ? { Accept: accept } : {}) },
				body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature: b64u(signature) }),
			});
			const nonce = res.headers.get("replay-nonce");
			if (nonce) this.nonce = nonce;
			if (res.ok) return res;
			const problem = (await res.json().catch(() => ({}))) as AcmeProblem;
			if (problem.type === "urn:ietf:params:acme:error:badNonce" && attempt < 3) continue;
			throw new Error(`ACME 오류 (HTTP ${res.status}): ${problem.detail ?? problem.type ?? "알 수 없는 오류"}`);
		}
	}

	async postJson<T>(url: string, payload: unknown): Promise<{ body: T; location: string | null }> {
		const res = await this.post(url, payload);
		return { body: (await res.json()) as T, location: res.headers.get("location") };
	}

	async register(email?: string): Promise<void> {
		const { location } = await this.postJson(this.directory.newAccount, {
			termsOfServiceAgreed: true,
			...(email ? { contact: [`mailto:${email}`] } : {}),
		});
		if (!location) throw new Error("ACME 계정 URL을 받지 못했습니다");
		this.kid = location;
	}

	async poll<T extends { status: string }>(url: string, pending: string[], what: string): Promise<T> {
		const deadline = Date.now() + POLL_TIMEOUT_MS;
		for (;;) {
			const { body } = await this.postJson<T>(url, null);
			if (!pending.includes(body.status)) return body;
			if (Date.now() > deadline) throw new Error(`${what} 대기 시간이 초과되었습니다 (상태: ${body.status})`);
			await Bun.sleep(POLL_INTERVAL_MS);
		}
	}
}

interface AcmeOrder {
	status: string;
	authorizations: string[];
	finalize: string;
	certificate?: string;
	error?: AcmeProblem;
}

interface AcmeChallenge {
	type: string;
	url: string;
	token: string;
	error?: AcmeProblem;
}

interface AcmeAuthorization {
	status: string;
	identifier: { type: string; value: string };
	challenges: AcmeChallenge[];
}

async function run(cmd: string[]): Promise<void> {
	const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`${cmd[0]} 실패: ${stderr.trim()}`);
}

async function createKeyAndCsr(domain: string): Promise<{ keyPem: string; csrDer: Uint8Array }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-web-acme-"));
	try {
		const keyFile = path.join(dir, "key.pem");
		const csrFile = path.join(dir, "csr.der");
		await run(["openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", keyFile]);
		await run([
			"openssl", "req", "-new", "-key", keyFile, "-subj", `/CN=${domain}`,
			"-addext", `subjectAltName=DNS:${domain}`, "-outform", "DER", "-out", csrFile,
		]);
		return { keyPem: await fs.readFile(keyFile, "utf8"), csrDer: await fs.readFile(csrFile) };
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

export async function issueCertificate(opts: IssueOptions): Promise<IssuedCertificate> {
	const { domain, dns, log } = opts;
	log(`ACME 서버 연결: ${opts.directoryUrl}`);
	const client = await AcmeClient.create(opts.directoryUrl, opts.accountKeyFile);
	await client.register(opts.email);
	log("ACME 계정 확인 완료");

	const { body: order, location: orderUrl } = await client.postJson<AcmeOrder>(client.directory.newOrder, {
		identifiers: [{ type: "dns", value: domain }],
	});
	if (!orderUrl) throw new Error("ACME 주문 URL을 받지 못했습니다");
	log(`주문 생성: ${domain}`);

	const cleanups: Array<() => Promise<void>> = [];
	try {
		const thumbprint = await client.thumbprint();
		for (const authzUrl of order.authorizations) {
			const { body: authz } = await client.postJson<AcmeAuthorization>(authzUrl, null);
			if (authz.status === "valid") continue;
			const challenge = authz.challenges.find(c => c.type === "dns-01");
			if (!challenge) throw new Error("ACME 서버가 dns-01 인증을 제공하지 않습니다");
			const keyAuth = `${challenge.token}.${thumbprint}`;
			const txtValue = b64u(await crypto.subtle.digest("SHA-256", encoder.encode(keyAuth)));
			const txtName = `_acme-challenge.${authz.identifier.value}`;
			log(`TXT 레코드 등록: ${txtName}`);
			cleanups.push(await dns.addTxt(txtName, txtValue));
			log("TXT 레코드 전파 대기 중…");
			await dns.waitTxt(txtName, txtValue);
			log("TXT 레코드 확인됨, 검증 요청");
			await client.post(challenge.url, {});
			const done = await client.poll<AcmeAuthorization>(authzUrl, ["pending", "processing"], "도메인 검증");
			if (done.status !== "valid") {
				const detail = done.challenges.find(c => c.type === "dns-01")?.error?.detail;
				throw new Error(`도메인 검증 실패 (${done.status})${detail ? `: ${detail}` : ""}`);
			}
			log("도메인 검증 통과");
		}

		const { keyPem, csrDer } = await createKeyAndCsr(domain);
		log("인증서 서명 요청(CSR) 제출");
		await client.post(order.finalize, { csr: b64u(csrDer) });
		const finalOrder = await client.poll<AcmeOrder>(orderUrl, ["pending", "ready", "processing"], "인증서 발급");
		if (finalOrder.status !== "valid" || !finalOrder.certificate) {
			throw new Error(`인증서 발급 실패 (${finalOrder.status})${finalOrder.error?.detail ? `: ${finalOrder.error.detail}` : ""}`);
		}
		const certPem = await (await client.post(finalOrder.certificate, null, "application/pem-certificate-chain")).text();
		const notAfter = certificateNotAfter(certPem);
		log(`인증서 발급 완료 (만료: ${new Date(notAfter).toLocaleString("ko-KR")})`);
		return { certPem, keyPem, notAfter };
	} finally {
		for (const cleanup of cleanups) {
			try {
				await cleanup();
			} catch (err) {
				log(`TXT 레코드 정리 실패: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
}

// ---------- Cloudflare ----------

interface CloudflareEnvelope<T> {
	success: boolean;
	errors?: { message: string }[];
	result: T;
}

export interface CloudflareDns extends DnsProvider {
	/** Create or update a DNS-only A record. */
	upsertA(name: string, ip: string): Promise<void>;
}

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const TXT_WAIT_MS = 180_000;

export function cloudflareDns(token: string): CloudflareDns {
	async function api<T>(method: string, pathname: string, body?: unknown): Promise<T> {
		const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const data = (await res.json().catch(() => null)) as CloudflareEnvelope<T> | null;
		if (!data?.success) {
			const msg = data?.errors?.map(e => e.message).join(", ") || `HTTP ${res.status}`;
			const hint = [400, 401, 403].includes(res.status)
				? " — API 토큰 값과 권한(Zone:Read, DNS:Edit)을 확인하세요"
				: "";
			throw new Error(`Cloudflare API 오류: ${msg}${hint}`);
		}
		return data.result;
	}

	const zoneCache = new Map<string, string>();
	async function zoneFor(name: string): Promise<string> {
		const labels = name.split(".");
		for (let i = 0; i < labels.length - 1; i++) {
			const candidate = labels.slice(i).join(".");
			const cached = zoneCache.get(candidate);
			if (cached) return cached;
			const zones = await api<{ id: string }[]>("GET", `/zones?name=${encodeURIComponent(candidate)}`);
			if (zones.length > 0) {
				zoneCache.set(candidate, zones[0]!.id);
				return zones[0]!.id;
			}
		}
		throw new Error(
			`Cloudflare에서 ${name}의 영역(zone)을 찾을 수 없습니다. 토큰 권한(Zone:Read, DNS:Edit)과 도메인을 확인하세요`,
		);
	}

	return {
		async addTxt(name, value) {
			const zone = await zoneFor(name);
			const record = await api<{ id: string }>("POST", `/zones/${zone}/dns_records`, {
				type: "TXT",
				name,
				content: value,
				ttl: 60,
			});
			return async () => {
				await api("DELETE", `/zones/${zone}/dns_records/${record.id}`);
			};
		},
		async waitTxt(name, value) {
			const deadline = Date.now() + TXT_WAIT_MS;
			while (Date.now() < deadline) {
				try {
					const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(name)}&type=TXT`, {
						headers: { Accept: "application/dns-json" },
					});
					const data = (await res.json()) as { Answer?: { data: string }[] };
					if (data.Answer?.some(a => a.data.replaceAll('"', "") === value)) return;
				} catch {}
				await Bun.sleep(5_000);
			}
			throw new Error("TXT 레코드가 3분 안에 전파되지 않았습니다");
		},
		async upsertA(name, ip) {
			const zone = await zoneFor(name);
			const existing = await api<{ id: string }[]>(
				"GET",
				`/zones/${zone}/dns_records?type=A&name=${encodeURIComponent(name)}`,
			);
			const record = { type: "A", name, content: ip, ttl: 300, proxied: false };
			if (existing.length > 0) await api("PUT", `/zones/${zone}/dns_records/${existing[0]!.id}`, record);
			else await api("POST", `/zones/${zone}/dns_records`, record);
		},
	};
}
