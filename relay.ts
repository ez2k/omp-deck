/**
 * Self-hosted collab relay, ported from omp's `packages/collab-web/scripts/local-relay.ts` (v18.15.0),
 * plus static serving of the collab-web guest client built from the same tag (`collab-web/`).
 *
 * Contract (identical to wss://my.omp.sh):
 * - `GET /r/<roomId>?role=host|guest` upgrades to a WebSocket.
 * - The host creates the room; a second host is closed with 4009, a guest for a missing room with 4004.
 * - Host binary frames: envelope peerId 0 broadcasts to every guest, peerId N targets that guest.
 * - Guest binary frames: the 4-byte envelope header is rewritten to the sender's peerId, then sent to the host.
 * - TEXT control to the host: `{"t":"peer-joined","peer":N}` / `{"t":"peer-left","peer":N}`.
 * - Host disconnect: TEXT `{"t":"room-closed"}` to every guest, then close 4001.
 * Payloads are end-to-end encrypted; the relay never sees plaintext.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import fs from "node:fs";
import path from "node:path";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const ENVELOPE_HEADER_LENGTH = 4;
const HASHED_ASSET_RE = /^\/[a-z0-9]{8}\.[a-z0-9]+$/;

interface SocketData {
	roomId: string;
	role: "host" | "guest";
	/** Assigned on open for guests; the host stays 0. */
	peerId: number;
}

type RelaySocket = ServerWebSocket<SocketData>;

interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
}

const rooms = new Map<string, Room>();

/** Bun's `send` returns 0 when it drops a frame; a dropped snapshot chunk stalls the guest's join. */
function forward(ws: RelaySocket, message: Buffer): void {
	if (ws.send(message) === 0) {
		console.warn(`[relay] frame dropped: room=${ws.data.roomId} ${ws.data.role} peer=${ws.data.peerId} buffered=${ws.getBufferedAmount()}`);
	}
}

export const relayWebsocket: WebSocketHandler<SocketData> = {
	// The host pushes a whole session snapshot (tens of MB) over loopback at once while a remote
	// guest drains slowly. Bun's default 16 MB limit silently drops the rest, stalling the join at
	// N%; buffer generously and close (guest rejoins) rather than drop if a guest falls this far behind.
	backpressureLimit: 256 * 1024 * 1024,
	closeOnBackpressureLimit: true,
	maxPayloadLength: 64 * 1024 * 1024,
	open(ws) {
		const { roomId, role } = ws.data;
		if (role === "host") {
			if (rooms.has(roomId)) {
				ws.close(4009, "a host is already connected for this room");
				return;
			}
			rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
			return;
		}
		const room = rooms.get(roomId);
		if (!room) {
			ws.close(4004, "no such room");
			return;
		}
		const peerId = room.nextPeerId++;
		ws.data.peerId = peerId;
		room.guests.set(peerId, ws);
		room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
	},
	message(ws, message) {
		if (typeof message === "string") return; // clients never send TEXT
		const room = rooms.get(ws.data.roomId);
		if (!room) return;
		if (message.byteLength < ENVELOPE_HEADER_LENGTH) return;
		const view = new DataView(message.buffer, message.byteOffset, ENVELOPE_HEADER_LENGTH);
		if (ws.data.role === "host") {
			if (room.host !== ws) return;
			const peerId = view.getUint32(0, false);
			if (peerId === 0) {
				for (const guest of room.guests.values()) forward(guest, message);
			} else {
				const guest = room.guests.get(peerId);
				if (guest) forward(guest, message);
			}
			return;
		}
		view.setUint32(0, ws.data.peerId, false);
		forward(room.host, message);
	},
	close(ws) {
		const { roomId, role, peerId } = ws.data;
		const room = rooms.get(roomId);
		if (!room) return;
		if (role === "host") {
			// Rejected second host: the live room is not ours to tear down.
			if (room.host !== ws) return;
			rooms.delete(roomId);
			const closure = JSON.stringify({ t: "room-closed" });
			for (const guest of room.guests.values()) {
				guest.send(closure);
				guest.close(4001, "room closed");
			}
			room.guests.clear();
			return;
		}
		if (room.guests.delete(peerId)) {
			room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
		}
	},
};

export const CLIENT_DIR = path.resolve(import.meta.dir, "collab-web");

function scanClientFiles(): Map<string, string> {
	// Not in the repository: a fresh install builds it from the update dialog.
	if (!fs.existsSync(CLIENT_DIR)) return new Map();
	return new Map(
		fs.readdirSync(CLIENT_DIR, { withFileTypes: true })
			.filter(e => e.isFile())
			.map(e => [`/${e.name}`, path.join(CLIENT_DIR, e.name)]),
	);
}

// Fixed file list: request paths never touch the filesystem directly.
let clientFiles = scanClientFiles();

/** Pick up a rebuilt client after `CLIENT_DIR` was swapped. */
export function reloadClientFiles(): void {
	clientFiles = scanClientFiles();
}

/** Guest client mount point; assets are referenced relatively (`./x.js`), so any prefix works. */
export const CLIENT_PATH = "/join/";

/**
 * Routes relay traffic: `/r/<roomId>` WebSocket upgrades and the guest client under CLIENT_PATH.
 * Both are unauthenticated by design (rooms are end-to-end encrypted; keys live in URL fragments).
 * Returns `null` for every other path so the caller can serve its own routes.
 */
export function handleRelay(req: Request, server: Server): Response | undefined | null {
	const url = new URL(req.url);
	const match = ROOM_PATH_RE.exec(url.pathname);
	if (match) {
		const role = url.searchParams.get("role");
		if (role !== "host" && role !== "guest") return new Response("not found", { status: 404 });
		const data: SocketData = { roomId: match[1]!, role, peerId: 0 };
		if (server.upgrade(req, { data })) return undefined;
		return new Response("websocket upgrade required", { status: 426 });
	}
	if (url.pathname === CLIENT_PATH.slice(0, -1)) {
		return new Response(null, { status: 308, headers: { Location: CLIENT_PATH } });
	}
	if (!url.pathname.startsWith(CLIENT_PATH)) return null;
	if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
	const name = `/${url.pathname.slice(CLIENT_PATH.length)}`;
	const file = clientFiles.get(name === "/" ? "/index.html" : name);
	if (!file) return new Response("not found", { status: 404 });
	const cache = HASHED_ASSET_RE.test(name)
		? "public, max-age=31536000, immutable"
		: name === "/" || name === "/index.html"
			? "no-cache"
			: "public, max-age=86400";
	return new Response(Bun.file(file), { headers: { "Cache-Control": cache, "Referrer-Policy": "no-referrer" } });
}
