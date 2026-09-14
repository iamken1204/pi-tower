// Phase-1 catalog and isolated programmatic transport. No raw pi RPC reaches managed children.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { statSync, statfsSync } from "node:fs";
import { privateDirectory, uuid } from "./managed-storage.mjs";
import { createSnapshotStore } from "./managed-snapshots.mjs";
import { commandPayload, payloadHash } from "./managed-journal.mjs";

export function createManagedTower(dataDir, {
	maxSnapshotBytes = Number(process.env.PI_TOWER_MAX_SNAPSHOT_BYTES ?? 64 * 1024 * 1024),
	maxTotalBytes = Number(process.env.PI_TOWER_MAX_SNAPSHOT_TOTAL_BYTES ?? 1024 * 1024 * 1024),
	minFreeBytes = Number(process.env.PI_TOWER_MIN_FREE_BYTES ?? 256 * 1024 * 1024),
	maxUploads = Number(process.env.PI_TOWER_MAX_UPLOADS ?? 2),
	maxViewerBuffer = Number(process.env.PI_TOWER_VIEWER_BUFFER_BYTES ?? 1024 * 1024),
} = {}) {
	for (const value of [maxSnapshotBytes, maxTotalBytes, minFreeBytes, maxUploads, maxViewerBuffer]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid_managed_limit");
	privateDirectory(dataDir);
	const db = new Database(resolve(dataDir, "tower.sqlite"));
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = FULL");
	db.pragma("busy_timeout = 1250");
	db.pragma("wal_autocheckpoint = 1000");
	const schema = db.pragma("user_version", { simple: true });
	if (schema > 3) { db.close(); throw new Error("unsupported_tower_schema"); }
	db.transaction(() => {
		db.exec(`CREATE TABLE IF NOT EXISTS managed_runners (runnerId TEXT PRIMARY KEY, instanceId TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS threads (
			threadId TEXT PRIMARY KEY, createKey TEXT UNIQUE NOT NULL, runnerId TEXT NOT NULL,
			runnerInstanceId TEXT NOT NULL, title TEXT NOT NULL, createdAt TEXT NOT NULL,
			workspaceId TEXT, piSessionId TEXT, metadataVersion INTEGER NOT NULL DEFAULT 1);
		CREATE TABLE IF NOT EXISTS managed_commands (threadId TEXT NOT NULL, commandId TEXT NOT NULL, payloadHash TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(threadId,commandId));
		PRAGMA user_version = 3;`);
		if (schema < 3) db.exec(`ALTER TABLE threads ADD COLUMN updatedAt TEXT;
			ALTER TABLE threads ADD COLUMN archivedAt TEXT;
			ALTER TABLE threads ADD COLUMN createTitle TEXT;
			UPDATE threads SET updatedAt=createdAt, createTitle=title;
			CREATE INDEX threads_activity ON threads(updatedAt DESC,threadId DESC);`);
	})();
	const snapshots = createSnapshotStore(db, { maxSnapshotBytes, maxTotalBytes });
	let uploads = 0;
	const checkpointTimer = setInterval(() => { try { db.pragma("wal_checkpoint(PASSIVE)"); } catch { /* Busy timeout is bounded; committed WAL remains durable. */ } }, 60_000);
	checkpointTimer.unref();
	const freeBytes = () => { const fs = statfsSync(dataDir); return fs.bavail * fs.bsize; };
	const requireDiskSpace = () => { if (freeBytes() < minFreeBytes) throw new Error("disk_space_low"); };
	const command = (threadId, commandId) => {
		const row = db.prepare("SELECT receipt FROM managed_commands WHERE threadId=? AND commandId=?").get(threadId, uuid(commandId));
		return row ? JSON.parse(row.receipt) : null;
	};
	for (const row of db.prepare("SELECT threadId,commandId,receipt FROM managed_commands").all()) {
		const receipt = JSON.parse(row.receipt);
		if (["received", "dispatching", "accepted"].includes(receipt.status)) db.prepare("UPDATE managed_commands SET receipt=? WHERE threadId=? AND commandId=?").run(JSON.stringify({ ...receipt, status: "unknown" }), row.threadId, row.commandId);
	}
	const runners = new Map();
	const clients = new Map(); // thread -> read-only subscribers, including its current driver
	const owners = new Map();
	const metadataChanging = new Set();
	const restores = new Map();
	const incarnation = randomUUID(); // Never restored from SQLite or a backup.
	let epochCounter = 0;
	const liveStates = new Map();
	const thread = (id) => {
		const row = db.prepare("SELECT threadId, runnerId, runnerInstanceId, title, createdAt, updatedAt, archivedAt, workspaceId, piSessionId, metadataVersion FROM threads WHERE threadId=?").get(uuid(id));
		if (!row) throw new Error("unknown_thread");
		return row;
	};
	const describe = (row) => ({ ...row, online: !!runners.get(row.runnerId)?.ready,
		runtime: liveStates.get(row.threadId) ?? { state: "sleeping", sync: "pending" },
		latestSnapshotRevision: snapshots.head(row.threadId)?.revision ?? null });
	const send = (ws, value) => {
		if (ws.readyState !== 1) return;
		if (ws.bufferedAmount > maxViewerBuffer) { ws.close(1009, "resync_required"); return; }
		ws.send(JSON.stringify({ version: 1, ...value }));
	};
	const broadcast = (threadId, value) => {
		for (const client of clients.get(threadId) ?? []) send(client, value);
	};
	function ownershipChanged(threadId) {
		const owner = owners.get(threadId);
		for (const client of clients.get(threadId) ?? []) send(client, { type: "ownership_changed", threadId,
			driver: owner?.ws === client && owner.confirmed, occupied: !!owner?.ws,
			epoch: owner?.ws === client && owner.confirmed ? owner.epoch : null });
	}
	function requireDriver(row, ws, epoch) {
		const owner = owners.get(row.threadId);
		if (!owner?.confirmed || owner.ws !== ws || JSON.stringify(epoch) !== JSON.stringify(owner.epoch)) throw new Error("stale_ownership");
	}
	async function ownership(row, ws, operation, confirmed) {
		const old = owners.get(row.threadId);
		if (operation === "acquire" && old?.ws && old.ws !== ws) throw new Error("driver_occupied");
		if (operation === "takeover" && confirmed !== true) throw new Error("takeover_confirmation_required");
		if (operation === "release" && old?.ws !== ws) return;
		const runner = runners.get(row.runnerId);
		if (!runner?.ready) throw new Error("runner_offline");
		const owner = { ws: operation === "release" ? null : ws, confirmed: false,
			epoch: { incarnation, connectionId: runner.connectionId, bootId: runner.bootId, counter: ++epochCounter } };
		owners.set(row.threadId, owner); // Revoke first; no browser may write until the runner acknowledges.
		ownershipChanged(row.threadId);
		await request(row, "ownership", { epoch: owner.epoch, driver: !!owner.ws });
		if (owners.get(row.threadId) !== owner || (owner.ws && owner.ws.readyState !== 1)) throw new Error("ownership_superseded");
		owner.confirmed = true;
		ownershipChanged(row.threadId);
		return { driver: !!owner.ws, epoch: owner.ws ? owner.epoch : null };
	}
	function saveReceipt(threadId, receipt) {
		uuid(receipt.commandId);
		if (payloadHash(receipt.payload) !== receipt.payloadHash || !["received", "dispatching", "accepted", "rejected", "settled", "unknown"].includes(receipt.status)) throw new Error("invalid_receipt");
		const old = command(threadId, receipt.commandId);
		if (old && old.payloadHash !== receipt.payloadHash) throw new Error("command_payload_conflict");
		if (old && ["settled", "rejected"].includes(old.status)) return old;
		db.prepare("INSERT INTO managed_commands VALUES (?,?,?,?) ON CONFLICT(threadId,commandId) DO UPDATE SET receipt=excluded.receipt")
			.run(threadId, receipt.commandId, receipt.payloadHash, JSON.stringify(receipt));
		broadcast(threadId, { type: "command_status", threadId, receipt });
		return receipt;
	}
	async function execute(row, input) {
		row = thread(row.threadId);
		if (input.operation === "prompt") requireDiskSpace();
		if (metadataChanging.has(row.threadId) || restores.has(row.threadId)) throw new Error("metadata_update_in_progress");
		if (input.operation === "prompt" && row.archivedAt) throw new Error("thread_archived");
		const payload = commandPayload(input);
		uuid(input.commandId);
		const old = command(row.threadId, input.commandId);
		if (old) {
			if (old.payloadHash !== payloadHash(payload)) throw new Error("command_payload_conflict");
			return old; // Query/reconcile is separate; never resend an uncertain command automatically.
		}
		const receipt = saveReceipt(row.threadId, { commandId: input.commandId, payload, payloadHash: payloadHash(payload), epoch: input.epoch, bootId: input.epoch.bootId, status: "received" });
		if (input.operation === "prompt") db.prepare("UPDATE threads SET updatedAt=?,title=CASE WHEN title='' THEN ? ELSE title END WHERE threadId=?")
			.run(new Date().toISOString(), payload.message.trim().slice(0, 80), row.threadId);
		try { return saveReceipt(row.threadId, await request(row, input.operation, { ...payload, commandId: input.commandId, epoch: input.epoch })); }
		catch (error) {
			const latest = command(row.threadId, input.commandId);
			if (!["settled", "rejected"].includes(latest.status)) saveReceipt(row.threadId, { ...receipt, status: "unknown" });
			throw error;
		}
	}
	function request(row, operation, fields = {}) {
		const runner = runners.get(row.runnerId);
		if (!runner?.ready || runner.instanceId !== row.runnerInstanceId) throw new Error("runner_offline_or_instance_mismatch");
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { runner.pending.delete(requestId); reject(new Error("runner_timeout_unknown")); }, 20000);
			runner.pending.set(requestId, { resolve, reject, timer });
			send(runner.ws, { ...fields, requestId, connectionId: runner.connectionId, threadId: row.threadId, operation });
		});
	}
	function bind(row, result) {
		if (result.threadId !== row.threadId || result.runnerInstanceId !== row.runnerInstanceId) throw new Error("thread_binding_mismatch");
		uuid(result.piSessionId); uuid(result.workspaceId);
		if (row.piSessionId && (row.piSessionId !== result.piSessionId || row.workspaceId !== result.workspaceId)) throw new Error("session_binding_mismatch");
		db.prepare("UPDATE threads SET piSessionId=?, workspaceId=? WHERE threadId=?").run(result.piSessionId, result.workspaceId, row.threadId);
	}
	function handleRunner(ws, params) {
		let id, instanceId;
		try {
			id = params.get("id"); instanceId = uuid(params.get("instance")); uuid(params.get("boot"));
			if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error("invalid_runner");
			if (runners.has(id)) throw new Error("duplicate_runner");
			const known = db.prepare("SELECT instanceId FROM managed_runners WHERE runnerId=?").get(id);
			if (known && known.instanceId !== instanceId) throw new Error("runner_instance_mismatch");
			db.prepare("INSERT OR IGNORE INTO managed_runners VALUES (?,?)").run(id, instanceId);
		} catch (error) { ws.close(1008, error.message); return; }
		const runner = { ws, instanceId, bootId: params.get("boot"), ready: false, connectionId: randomUUID(), pending: new Map() };
		runners.set(id, runner);
		send(ws, { type: "welcome", connectionId: runner.connectionId });
		ws.on("message", (bytes) => {
			try {
				if (runners.get(id) !== runner) return;
				const message = JSON.parse(bytes.toString());
				if (message.version !== 1) throw new Error("unsupported_protocol");
				if (message.type === "inventory") {
					if (message.piVersion !== "0.85.1" || !Array.isArray(message.threads)) throw new Error("unsupported_capability");
					runner.inventory = [];
					runner.orphans = new Set();
					for (const item of message.threads) {
						if (!db.prepare("SELECT 1 FROM threads WHERE threadId=?").get(uuid(item.threadId))) {
							runner.orphans.add(item.threadId);
							console.error(JSON.stringify({ event: "thread_missing_from_catalog", threadId: item.threadId, runnerId: id }));
							continue; // An older Tower backup cannot recreate Tower-owned metadata from inventory.
						}
						const row = thread(item.threadId);
						if (row.runnerId !== id || row.runnerInstanceId !== instanceId) throw new Error("inventory_binding_mismatch");
						bind(row, { ...item, runnerInstanceId: instanceId });
						liveStates.set(row.threadId, item);
						runner.inventory.push(item);
					}
					send(ws, { type: "inventory_ready", connectionId: runner.connectionId });
				} else if (message.type === "reconciled") {
					if (!runner.inventory || message.connectionId !== runner.connectionId) throw new Error("invalid_reconciliation");
					runner.ready = true;
					send(ws, { type: "inventory_confirmed", connectionId: runner.connectionId, quarantined: [...runner.orphans], heads: runner.inventory.map((item) => ({ threadId: item.threadId, head: snapshots.head(item.threadId) })) });
					for (const item of runner.inventory) broadcast(item.threadId, { type: "state", thread: describe(thread(item.threadId)), runtime: item, online: true });
				} else if (message.type === "command_status" || message.type === "runtime_state") {
					if (runner.orphans?.has(message.threadId)) return;
					const row = thread(message.threadId);
					if (row.runnerId !== id || row.runnerInstanceId !== instanceId) throw new Error("event_binding_mismatch");
					if (message.type === "command_status") saveReceipt(row.threadId, message.receipt);
					else { liveStates.set(row.threadId, message); broadcast(row.threadId, { type: "state", thread: describe(row), runtime: message, online: true }); }
				} else if (message.type === "result") {
					const p = runner.pending.get(message.requestId);
					if (!p) return;
					clearTimeout(p.timer); runner.pending.delete(message.requestId);
					message.error ? p.reject(new Error(message.error)) : p.resolve(message.result);
				} else if (message.type === "pi_event") {
					if (runner.orphans?.has(message.threadId)) return;
					const row = thread(message.threadId);
					if (row.runnerId !== id || row.runnerInstanceId !== instanceId) throw new Error("event_binding_mismatch");
					// Internal get_state responses include local paths. They are never browser events.
					if (message.event?.type !== "response") broadcast(row.threadId, message);
				}
			} catch (error) { ws.close(1008, error.message.slice(0, 100)); }
		});
		ws.on("close", () => {
			if (runners.get(id) !== runner) return;
			runners.delete(id);
			for (const p of runner.pending.values()) { clearTimeout(p.timer); p.reject(new Error("runner_disconnected_unknown")); }
			for (const threadId of clients.keys()) if (thread(threadId).runnerId === id) {
				owners.delete(threadId); ownershipChanged(threadId);
				broadcast(threadId, { type: "resync_required", threadId, runner: "offline" });
			}
		});
	}
	function handleClient(ws, params) {
		let row;
		try { row = thread(params.get("thread")); } catch (error) { ws.close(1008, error.message); return; }
		if (!clients.has(row.threadId)) clients.set(row.threadId, new Set());
		clients.get(row.threadId).add(ws);
		send(ws, { type: "state", thread: describe(row), runtime: liveStates.get(row.threadId), online: !!runners.get(row.runnerId)?.ready });
		ownershipChanged(row.threadId);
		ws.on("message", async (bytes) => {
			let message;
			try {
				message = JSON.parse(bytes.toString());
				row = thread(row.threadId);
				if (message.version !== 1 || !["subscribe", "acquire", "takeover", "state", "entries", "prompt", "abort", "extension_ui_response", "command", "sleep", "release"].includes(message.operation)) throw new Error("invalid_command");
				uuid(message.requestId);
				if (["prompt", "abort", "extension_ui_response", "sleep"].includes(message.operation)) requireDriver(row, ws, message.epoch);
				const result = ["acquire", "takeover", "release"].includes(message.operation)
					? await ownership(row, ws, message.operation, message.confirmed)
					: message.operation === "subscribe" ? { thread: describe(row), runtime: liveStates.get(row.threadId), online: !!runners.get(row.runnerId)?.ready }
					: ["prompt", "abort", "extension_ui_response"].includes(message.operation)
					? await execute(row, message)
					: message.operation === "command" ? command(row.threadId, message.commandId)
					: await request(row, message.operation, message.operation === "sleep" ? { epoch: message.epoch } : {});
				send(ws, { type: "result", requestId: message.requestId, result });
			} catch (error) { send(ws, { type: "result", requestId: message?.requestId, error: error.message }); }
		});
		ws.on("close", () => {
			clients.get(row.threadId)?.delete(ws);
			if (!clients.get(row.threadId)?.size) clients.delete(row.threadId);
			void ownership(row, ws, "release").catch(() => {}); // A disconnected runner also revokes its lease.
		});
	}
	async function http(req, res, url) {
		res.setHeader("content-type", "application/json");
		res.setHeader("cache-control", "no-store");
		try {
			if (req.method === "GET" && url.pathname === "/api/managed/usage") {
				const size = (file) => { try { return statSync(resolve(dataDir, file)).size; } catch (error) { if (error.code === "ENOENT") return 0; throw error; } };
				res.end(JSON.stringify({ ...snapshots.usage(), databaseBytes: size("tower.sqlite"), walBytes: size("tower.sqlite-wal"), freeBytes: freeBytes(), minFreeBytes, uploads, maxUploads })); return;
			}
			if (req.method === "GET" && url.pathname === "/api/managed/runners") {
				res.end(JSON.stringify(db.prepare("SELECT runnerId AS id FROM managed_runners ORDER BY runnerId").all().map((row) => ({ ...row, online: !!runners.get(row.id)?.ready })))); return;
			}
			if (["GET", "PUT"].includes(req.method) && url.pathname.startsWith("/api/managed/snapshots/")) {
				const row = thread(url.pathname.slice("/api/managed/snapshots/".length));
				const runner = runners.get(row.runnerId);
				const authorized = () => runner?.ready && runners.get(row.runnerId) === runner && runner.instanceId === row.runnerInstanceId &&
					req.headers["x-runner-instance"] === runner.instanceId && req.headers["x-runner-connection"] === runner.connectionId;
				if (!authorized()) throw new Error("stale_snapshot_connection");
				if (req.method === "GET") {
					const restore = restores.get(row.threadId);
					const reconcile = url.searchParams.get("latest") === "1";
					if (!reconcile && (!restore || restore.restoreId !== url.searchParams.get("restore"))) throw new Error("restore_not_confirmed");
					const latest = snapshots.latest(row.threadId);
					if (!latest && reconcile) { res.writeHead(404).end(); return; }
					if (!latest || (!reconcile && latest.hash !== restore.hash)) throw new Error("restore_revision_changed");
					res.setHeader("x-snapshot-hash", latest.hash);
					res.setHeader("content-length", latest.bytes.length); res.end(latest.bytes); return;
				}
				if (uploads >= maxUploads) throw new Error("upload_limit");
				requireDiskSpace();
				uploads++;
				try {
					const chunks = []; let size = 0;
					for await (const chunk of req) { size += chunk.length; if (size > maxSnapshotBytes) throw new Error("snapshot_too_large"); chunks.push(chunk); }
					if (!authorized()) throw new Error("stale_snapshot_connection");
					if (restores.has(row.threadId)) throw new Error("restore_in_progress");
					requireDiskSpace();
					const ack = snapshots.commit(Buffer.concat(chunks), row);
					res.end(JSON.stringify(ack));
					broadcast(row.threadId, { type: "checkpoint_available", threadId: row.threadId, ...ack });
				} finally { uploads--; }
				return;
			}
			const history = /^\/api\/threads\/([^/]+)\/history$/.exec(url.pathname);
			if (req.method === "GET" && history) {
				const row = thread(history[1]);
				const revision = url.searchParams.has("revision") ? JSON.parse(url.searchParams.get("revision")) : undefined;
				res.end(JSON.stringify(snapshots.history(row.threadId, revision, Number(url.searchParams.get("cursor") ?? 0), Number(url.searchParams.get("limit") ?? 100)))); return;
			}
			const receiptPath = /^\/api\/threads\/([^/]+)\/commands\/([^/]+)$/.exec(url.pathname);
			if (req.method === "GET" && receiptPath) { thread(receiptPath[1]); res.end(JSON.stringify(command(receiptPath[1], receiptPath[2]))); return; }
			if (req.method === "GET" && url.pathname === "/api/threads") {
				const limit = Number(url.searchParams.get("limit") ?? 50);
				if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_page_limit");
				const cursor = url.searchParams.has("cursor") ? JSON.parse(Buffer.from(url.searchParams.get("cursor"), "base64url").toString()) : null;
				if (cursor && (typeof cursor.updatedAt !== "string" || !uuid(cursor.threadId))) throw new Error("invalid_cursor");
				const rows = db.prepare(`SELECT threadId FROM threads WHERE (archivedAt IS NOT NULL)=? AND (?='' OR runnerId=?)
					AND instr(lower(title),lower(?))>0 AND (? IS NULL OR updatedAt<? OR (updatedAt=? AND threadId<?))
					ORDER BY updatedAt DESC,threadId DESC LIMIT ?`).all(url.searchParams.get("archived") === "true" ? 1 : 0,
					url.searchParams.get("runner") ?? "", url.searchParams.get("runner") ?? "", url.searchParams.get("q") ?? "",
					cursor?.updatedAt ?? null, cursor?.updatedAt ?? null, cursor?.updatedAt ?? null, cursor?.threadId ?? null, limit + 1);
				const page = rows.slice(0, limit).map(({ threadId }) => describe(thread(threadId)));
				const last = page.at(-1);
				res.end(JSON.stringify({ threads: page, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, threadId: last.threadId })).toString("base64url") : null }));
				return;
			}
			if (req.method === "GET" && url.pathname.startsWith("/api/threads/")) {
				const row = thread(url.pathname.slice("/api/threads/".length));
				if (runners.get(row.runnerId)?.ready) liveStates.set(row.threadId, await request(row, "state"));
				res.end(JSON.stringify(describe(row))); return;
			}
			const metadataPath = /^\/api\/threads\/([^/]+)$/.exec(url.pathname);
			const restorePath = /^\/api\/threads\/([^/]+)\/restore$/.exec(url.pathname);
			if (!(req.method === "POST" && (url.pathname === "/api/threads" || restorePath)) && !(req.method === "PATCH" && metadataPath)) { res.writeHead(404).end(); return; }
			let body = "";
			req.setEncoding("utf8");
			for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) throw new Error("request_too_large"); }
			const input = JSON.parse(body);
			if (restorePath) {
				const row = thread(restorePath[1]);
				if (input.confirmed !== true) throw new Error("restore_confirmation_required");
				if (restores.has(row.threadId) || metadataChanging.has(row.threadId)) throw new Error("restore_in_progress");
				const latest = snapshots.latest(row.threadId);
				if (!latest || JSON.stringify(latest.revision) !== JSON.stringify(input.expectedRevision)) throw new Error("restore_revision_changed");
				const restore = { restoreId: randomUUID(), expectedRevision: latest.revision, hash: latest.hash };
				restores.set(row.threadId, restore);
				try {
					const runtime = await request(row, "restore", restore);
					liveStates.set(row.threadId, runtime);
					const updated = describe(row);
					broadcast(row.threadId, { type: "state", thread: updated, runtime, online: true });
					res.end(JSON.stringify(updated)); return;
				} finally { restores.delete(row.threadId); }
			}
			if (req.method === "PATCH") {
				const row = thread(metadataPath[1]);
				if (metadataChanging.has(row.threadId)) throw new Error("metadata_update_in_progress");
				if (input.metadataVersion !== row.metadataVersion) throw new Error("metadata_conflict");
				if ((input.title !== undefined && (typeof input.title !== "string" || input.title.length > 200)) ||
					(input.archived !== undefined && typeof input.archived !== "boolean")) throw new Error("invalid_metadata");
				metadataChanging.add(row.threadId);
				try {
					if (input.archived === true) {
						const runtime = await request(row, "state");
						if (!["idle", "sleeping"].includes(runtime.state)) throw new Error("runtime_busy");
					}
					db.prepare("UPDATE threads SET title=?,archivedAt=?,metadataVersion=metadataVersion+1 WHERE threadId=?")
						.run(input.title ?? row.title, input.archived === undefined ? row.archivedAt : input.archived ? new Date().toISOString() : null, row.threadId);
					const updated = describe(thread(row.threadId));
					broadcast(row.threadId, { type: "state", thread: updated, runtime: updated.runtime, online: updated.online });
					res.end(JSON.stringify(updated)); return;
				} finally { metadataChanging.delete(row.threadId); }
			}
			const createKey = uuid(input.idempotencyKey);
			if (typeof input.runnerId !== "string" || (input.title !== undefined && typeof input.title !== "string") || (input.title?.length ?? 0) > 200) throw new Error("invalid_create");
			const runner = runners.get(input.runnerId);
			if (!runner?.ready) throw new Error("runner_offline");
			let row = db.prepare("SELECT * FROM threads WHERE createKey=?").get(createKey);
			if (row && (row.runnerId !== input.runnerId || row.createTitle !== (input.title ?? ""))) throw new Error("create_key_conflict");
			if (!row) {
				const threadId = randomUUID();
				const now = new Date().toISOString();
				db.prepare("INSERT INTO threads (threadId,createKey,runnerId,runnerInstanceId,title,createTitle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)")
					.run(threadId, createKey, input.runnerId, runner.instanceId, input.title ?? "", input.title ?? "", now, now);
				row = thread(threadId);
			}
			bind(row, await request(row, "prepare"));
			void request(thread(row.threadId), "sync").catch(() => {});
			res.writeHead(201).end(JSON.stringify(thread(row.threadId)));
		} catch (error) {
			res.writeHead(error.status ?? 409).end(JSON.stringify({ error: error.code ?? error.message, latestRevision: error.latestRevision }));
		}
	}
	return { http, isManagedSession: (name) => !!db.prepare("SELECT 1 FROM threads WHERE threadId=?").get(name),
		routes: { "/managed/runner": handleRunner, "/managed/client": handleClient },
		close() {
			clearInterval(checkpointTimer);
			for (const viewers of clients.values()) for (const client of viewers) client.terminate();
			clients.clear();
			for (const runner of runners.values()) {
				for (const p of runner.pending.values()) { clearTimeout(p.timer); p.reject(new Error("tower_shutdown_unknown")); }
				runner.ws.terminate();
			}
			runners.clear();
			db.close();
		} };
}
