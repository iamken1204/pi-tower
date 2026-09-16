// Phase-1 catalog and isolated programmatic transport. No raw pi RPC reaches managed children.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { statSync, statfsSync } from "node:fs";
import { firstPrompt, privateDirectory, uuid } from "./managed-storage.mjs";
import { createSnapshotStore } from "./managed-snapshots.mjs";
import { commandPayload, payloadHash } from "./managed-journal.mjs";

// Runtime states with a live pi process; sleeping, interrupted and error threads are inactive.
const AWAKE = new Set(["starting", "idle", "running", "waiting_input", "stopping"]);

export function createManagedTower(dataDir, {
	maxSnapshotBytes = Number(process.env.PI_TOWER_MAX_SNAPSHOT_BYTES ?? 64 * 1024 * 1024),
	maxTotalBytes = Number(process.env.PI_TOWER_MAX_SNAPSHOT_TOTAL_BYTES ?? 1024 * 1024 * 1024),
	minFreeBytes = Number(process.env.PI_TOWER_MIN_FREE_BYTES ?? 256 * 1024 * 1024),
	maxUploads = Number(process.env.PI_TOWER_MAX_UPLOADS ?? 2),
	maxViewerBuffer = Number(process.env.PI_TOWER_VIEWER_BUFFER_BYTES ?? 1024 * 1024),
	onPresence = () => {}, // Fires when a runner's readiness or a thread's runtime state changes.
} = {}) {
	for (const value of [maxSnapshotBytes, maxTotalBytes, minFreeBytes, maxUploads, maxViewerBuffer]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid_managed_limit");
	privateDirectory(dataDir);
	const db = new Database(resolve(dataDir, "tower.sqlite"));
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = FULL");
	db.pragma("busy_timeout = 1250");
	db.pragma("wal_autocheckpoint = 1000");
	const schema = db.pragma("user_version", { simple: true });
	if (schema > 5) { db.close(); throw new Error("unsupported_tower_schema"); }
	db.transaction(() => {
		db.exec(`CREATE TABLE IF NOT EXISTS managed_runners (runnerId TEXT PRIMARY KEY, instanceId TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS threads (
			threadId TEXT PRIMARY KEY, createKey TEXT UNIQUE NOT NULL, runnerId TEXT NOT NULL,
			runnerInstanceId TEXT NOT NULL, title TEXT NOT NULL, createdAt TEXT NOT NULL,
			workspaceId TEXT, piSessionId TEXT, metadataVersion INTEGER NOT NULL DEFAULT 1);
		CREATE TABLE IF NOT EXISTS managed_commands (threadId TEXT NOT NULL, commandId TEXT NOT NULL, payloadHash TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(threadId,commandId));
		PRAGMA user_version = 5;`);
		if (schema < 3) db.exec(`ALTER TABLE threads ADD COLUMN updatedAt TEXT;
			ALTER TABLE threads ADD COLUMN archivedAt TEXT;
			ALTER TABLE threads ADD COLUMN createTitle TEXT;
			UPDATE threads SET updatedAt=createdAt, createTitle=title;
			CREATE INDEX threads_activity ON threads(updatedAt DESC,threadId DESC);`);
		if (schema < 4) db.exec("ALTER TABLE threads ADD COLUMN cwd TEXT");
		if (schema < 5) db.exec("ALTER TABLE threads ADD COLUMN hostname TEXT");
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
	const runners = new Map(); // connectionId -> live runner process; one machine (runner id) may hold several.
	const hosts = new Map(); // threadId -> the connection currently serving it.
	const clients = new Map();
	const accesses = new Map(); // One runner-installed epoch shared by every attached browser.
	const metadataChanging = new Set();
	const restores = new Map();
	const incarnation = randomUUID(); // Never restored from SQLite or a backup.
	let epochCounter = 0;
	const liveStates = new Map();
	const thread = (id) => {
		const row = db.prepare("SELECT threadId, runnerId, runnerInstanceId, title, createdAt, updatedAt, archivedAt, workspaceId, piSessionId, cwd, hostname, metadataVersion FROM threads WHERE threadId=?").get(uuid(id));
		if (!row) throw new Error("unknown_thread");
		return row;
	};
	const workspace = (value) => { if (typeof value !== "string" || !value) throw new Error("invalid_workspace"); return value; };
	const hostnameOf = (value) => { if (value == null) return null; if (typeof value !== "string" || !value || Buffer.byteLength(value) > 4096) throw new Error("invalid_hostname"); return value; };
	const connections = (runnerId) => [...runners.values()].filter((runner) => runner.id === runnerId && runner.ready);
	const host = (row) => { const runner = hosts.get(row.threadId); return runner?.ready ? runner : undefined; };
	// Where a runner can host new threads: every directory one of its processes started in or already has a thread in.
	const workspaces = (runnerId) => [...new Set([...connections(runnerId).map((runner) => runner.cwd), ...db.prepare("SELECT DISTINCT cwd FROM threads WHERE runnerId=? AND cwd IS NOT NULL").pluck().all(runnerId)])].sort();
	const isActive = (row) => !row.archivedAt && !!host(row) && AWAKE.has(liveStates.get(row.threadId)?.state);
	const describe = (row) => ({ ...row, project: row.cwd ? basename(row.cwd) || row.cwd : null, online: !!host(row), active: isActive(row),
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
	function accessChanged(threadId, epoch = accesses.get(threadId)?.epoch ?? null) {
		broadcast(threadId, { type: "access_changed", threadId, epoch });
	}
	function requireAccess(row, epoch) {
		const access = accesses.get(row.threadId);
		if (!access?.epoch || JSON.stringify(epoch) !== JSON.stringify(access.epoch)) throw new Error("stale_access");
	}
	function ensureAccess(row) {
		const runner = host(row);
		if (!runner) throw new Error("runner_offline");
		void request(row, "viewers", { count: clients.get(row.threadId)?.size ?? 0 }).catch(() => {});
		const old = accesses.get(row.threadId);
		if (old?.epoch && old.connectionId === runner.connectionId) return Promise.resolve(old.epoch);
		if (old?.pending && old.connectionId === runner.connectionId) return old.pending;
		const access = { connectionId: runner.connectionId, epoch: null };
		const epoch = { incarnation, connectionId: runner.connectionId, bootId: runner.bootId, counter: ++epochCounter };
		access.pending = request(row, "access", { epoch })
			.then((result) => {
				if (accesses.get(row.threadId) !== access || !runner.ready || hosts.get(row.threadId) !== runner) throw new Error("access_superseded");
				if (JSON.stringify(result?.epoch) !== JSON.stringify(epoch)) throw new Error("invalid_access_ack");
				access.epoch = epoch;
				access.pending = null; accessChanged(row.threadId); return access.epoch;
			}).catch((error) => { if (accesses.get(row.threadId) === access) accesses.delete(row.threadId); throw error; });
		accesses.set(row.threadId, access);
		return access.pending;
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
	function request(row, operation, fields = {}, runner = host(row)) {
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
		uuid(result.piSessionId); uuid(result.workspaceId); workspace(result.cwd);
		if (row.piSessionId && (row.piSessionId !== result.piSessionId || row.workspaceId !== result.workspaceId || (row.cwd && row.cwd !== result.cwd))) throw new Error("session_binding_mismatch");
		db.prepare("UPDATE threads SET piSessionId=?, workspaceId=?, cwd=?, hostname=COALESCE(?, hostname) WHERE threadId=?").run(result.piSessionId, result.workspaceId, result.cwd, hostnameOf(result.hostname), row.threadId);
	}
	function handleRunner(ws, params) {
		let id, instanceId;
		try {
			id = params.get("id"); instanceId = uuid(params.get("instance")); uuid(params.get("boot"));
			if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error("invalid_runner");
			const known = db.prepare("SELECT instanceId FROM managed_runners WHERE runnerId=?").get(id);
			if (known && known.instanceId !== instanceId) throw new Error("runner_instance_mismatch");
			db.prepare("INSERT OR IGNORE INTO managed_runners VALUES (?,?)").run(id, instanceId);
		} catch (error) { ws.close(1008, error.message); return; }
		const runner = { id, ws, instanceId, bootId: params.get("boot"), ready: false, connectedAt: new Date().toISOString(), connectionId: randomUUID(), pending: new Map() };
		// A reconnecting process replaces its own stale socket instead of waiting for the heartbeat to reap it.
		for (const old of runners.values()) if (old.id === id && old.bootId === runner.bootId) { drop(old); old.ws.terminate(); }
		runners.set(runner.connectionId, runner);
		send(ws, { type: "welcome", connectionId: runner.connectionId });
		ws.on("message", (bytes) => {
			try {
				if (runners.get(runner.connectionId) !== runner) return;
				const message = JSON.parse(bytes.toString());
				if (message.version !== 1) throw new Error("unsupported_protocol");
				if (message.type === "inventory") {
					if (message.piVersion !== "0.85.1" || !Array.isArray(message.threads)) throw new Error("unsupported_capability");
					runner.cwd = workspace(message.cwd);
					runner.createSupported = message.createSupported === true;
					runner.inventory = [];
					runner.orphans = new Set();
					for (const [threadId, owner] of hosts) if (owner === runner) hosts.delete(threadId);
					for (const item of message.threads) {
						if (item.registration && !db.prepare("SELECT 1 FROM threads WHERE threadId=?").get(uuid(item.threadId))) {
							const { createKey, title, createdAt } = item.registration;
							uuid(createKey); uuid(item.piSessionId); uuid(item.workspaceId);
							if (typeof title !== "string" || title.length > 200 || typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) throw new Error("invalid_registration");
							db.prepare("INSERT INTO threads (threadId,createKey,runnerId,runnerInstanceId,title,createTitle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)")
								.run(item.threadId, createKey, id, instanceId, title, title, createdAt, createdAt);
						}
						if (!db.prepare("SELECT 1 FROM threads WHERE threadId=?").get(uuid(item.threadId))) {
							runner.orphans.add(item.threadId);
							console.error(JSON.stringify({ event: "thread_missing_from_catalog", threadId: item.threadId, runnerId: id }));
							continue; // An older Tower backup cannot recreate Tower-owned metadata from inventory.
						}
						const row = thread(item.threadId);
						if (row.runnerId !== id || row.runnerInstanceId !== instanceId) throw new Error("inventory_binding_mismatch");
						if (hosts.has(item.threadId)) throw new Error("thread_already_hosted");
						bind(row, { ...item, runnerInstanceId: instanceId });
						hosts.set(item.threadId, runner);
						liveStates.set(row.threadId, item);
						runner.inventory.push(item);
					}
					send(ws, { type: "inventory_ready", connectionId: runner.connectionId });
				} else if (message.type === "reconciled") {
					if (!runner.inventory || message.connectionId !== runner.connectionId) throw new Error("invalid_reconciliation");
					runner.ready = true;
					onPresence();
					send(ws, { type: "inventory_confirmed", connectionId: runner.connectionId, quarantined: [...runner.orphans], heads: runner.inventory.map((item) => ({ threadId: item.threadId, head: snapshots.head(item.threadId) })) });
					for (const item of runner.inventory) broadcast(item.threadId, { type: "state", thread: describe(thread(item.threadId)), runtime: item, online: true });
					for (const item of runner.inventory) if (clients.has(item.threadId)) void ensureAccess(thread(item.threadId)).catch(() => {});
				} else if (message.type === "command_status" || message.type === "runtime_state") {
					if (runner.orphans?.has(message.threadId)) return;
					const row = thread(message.threadId);
					if (row.runnerId !== id || row.runnerInstanceId !== instanceId) throw new Error("event_binding_mismatch");
					if (message.type === "command_status") saveReceipt(row.threadId, message.receipt);
					else {
						const before = liveStates.get(row.threadId)?.state;
						liveStates.set(row.threadId, message);
						broadcast(row.threadId, { type: "state", thread: describe(row), runtime: message, online: true });
						if (before !== message.state) onPresence();
					}
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
		ws.on("close", () => drop(runner));
	}
	function drop(runner) {
		if (runners.get(runner.connectionId) !== runner) return;
		runners.delete(runner.connectionId);
		if (runner.ready) onPresence();
		for (const p of runner.pending.values()) { clearTimeout(p.timer); p.reject(new Error("runner_disconnected_unknown")); }
		for (const [threadId, owner] of hosts) if (owner === runner) {
			hosts.delete(threadId);
			if (!clients.has(threadId)) continue;
			accesses.delete(threadId); accessChanged(threadId);
			broadcast(threadId, { type: "resync_required", threadId, runner: "offline" });
		}
	}
	function handleClient(ws, params) {
		let row;
		try { row = thread(params.get("thread")); } catch (error) { ws.close(1008, error.message); return; }
		if (!clients.has(row.threadId)) clients.set(row.threadId, new Set());
		clients.get(row.threadId).add(ws);
		send(ws, { type: "state", thread: describe(row), runtime: liveStates.get(row.threadId), online: !!host(row) });
		if (host(row)) void ensureAccess(row).then((epoch) => send(ws, { type: "access_changed", epoch })).catch(() => send(ws, { type: "access_changed", epoch: null }));
		ws.on("message", async (bytes) => {
			let message;
			try {
				message = JSON.parse(bytes.toString());
				row = thread(row.threadId);
				if (message.version !== 1 || !["subscribe", "state", "entries", "prompt", "abort", "extension_ui_response", "command", "sleep"].includes(message.operation)) throw new Error("invalid_command");
				uuid(message.requestId);
				if (["prompt", "abort", "extension_ui_response", "sleep"].includes(message.operation)) requireAccess(row, message.epoch);
				const result = message.operation === "subscribe" ? { thread: describe(row), runtime: liveStates.get(row.threadId), online: !!host(row) }
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
			if (host(row)) void request(row, "viewers", { count: clients.get(row.threadId)?.size ?? 0 }).catch(() => {});
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
				res.end(JSON.stringify(db.prepare("SELECT runnerId AS id FROM managed_runners ORDER BY runnerId").all().map((row) => ({ ...row, online: connections(row.id).length > 0,
					createSupported: connections(row.id).some((runner) => runner.createSupported), cwds: workspaces(row.id) })))); return;
			}
			if (["GET", "PUT"].includes(req.method) && url.pathname.startsWith("/api/managed/snapshots/")) {
				const row = thread(url.pathname.slice("/api/managed/snapshots/".length));
				const runner = hosts.get(row.threadId);
				const authorized = () => runner?.ready && hosts.get(row.threadId) === runner && runner.instanceId === row.runnerInstanceId &&
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
					if (!row.title) {
						const title = firstPrompt(snapshots.latest(row.threadId).envelope.entries).slice(0, 80);
						if (title) db.prepare("UPDATE threads SET title=? WHERE threadId=? AND title=''").run(title, row.threadId);
					}
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
				const awakeThreads = [...liveStates.entries()].filter(([threadId, runtime]) => AWAKE.has(runtime.state) && host({ threadId })).map(([threadId]) => threadId);
				const rows = db.prepare(`SELECT threadId FROM threads WHERE (archivedAt IS NOT NULL)=? AND (?='' OR runnerId=?)
					AND instr(lower(title),lower(?))>0 AND (? IS NULL OR updatedAt<? OR (updatedAt=? AND threadId<?))
					AND (?=0 OR (archivedAt IS NULL AND threadId IN (SELECT value FROM json_each(?))))
					ORDER BY updatedAt DESC,threadId DESC LIMIT ?`).all(url.searchParams.get("archived") === "true" ? 1 : 0,
					url.searchParams.get("runner") ?? "", url.searchParams.get("runner") ?? "", url.searchParams.get("q") ?? "",
					cursor?.updatedAt ?? null, cursor?.updatedAt ?? null, cursor?.updatedAt ?? null, cursor?.threadId ?? null,
					url.searchParams.get("active") === "true" ? 1 : 0, JSON.stringify(awakeThreads), limit + 1);
				const page = rows.slice(0, limit).map(({ threadId }) => describe(thread(threadId)));
				const last = page.at(-1);
				res.end(JSON.stringify({ threads: page, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, threadId: last.threadId })).toString("base64url") : null }));
				return;
			}
			if (req.method === "GET" && url.pathname.startsWith("/api/threads/")) {
				const row = thread(url.pathname.slice("/api/threads/".length));
				if (host(row)) liveStates.set(row.threadId, await request(row, "state"));
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
					if (input.archived === true && host(row)) { // An unhosted thread has no runtime to be busy.
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
			const runner = connections(input.runnerId).find((candidate) => candidate.createSupported);
			if (!runner) throw new Error(connections(input.runnerId).length ? "create_needs_managed_threads_runner" : "runner_offline");
			if (input.cwd !== undefined && !workspaces(input.runnerId).includes(input.cwd)) throw new Error("unknown_workspace");
			let row = db.prepare("SELECT * FROM threads WHERE createKey=?").get(createKey);
			if (row && (row.runnerId !== input.runnerId || row.createTitle !== (input.title ?? ""))) throw new Error("create_key_conflict");
			if (!row) {
				const threadId = randomUUID();
				const now = new Date().toISOString();
				db.prepare("INSERT INTO threads (threadId,createKey,runnerId,runnerInstanceId,title,createTitle,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)")
					.run(threadId, createKey, input.runnerId, runner.instanceId, input.title ?? "", input.title ?? "", now, now);
				row = thread(threadId);
			}
			bind(row, await request(row, "prepare", { cwd: input.cwd }, runner));
			hosts.set(row.threadId, runner);
			void request(thread(row.threadId), "sync").catch(() => {});
			res.writeHead(201).end(JSON.stringify(thread(row.threadId)));
		} catch (error) {
			res.writeHead(error.status ?? 409).end(JSON.stringify({ error: error.code ?? error.message, latestRevision: error.latestRevision }));
		}
	}
	return { http, isManagedSession: (name) => !!db.prepare("SELECT 1 FROM threads WHERE threadId=?").get(name),
		// Active threads double as the runner's sessions on the home page.
		presence: () => {
			const machines = new Map(); // runner id -> earliest ready connection time
			for (const runner of runners.values()) if (runner.ready && !(machines.get(runner.id) <= runner.connectedAt)) machines.set(runner.id, runner.connectedAt);
			return [...machines].map(([id, connectedAt]) => ({ id, connectedAt,
				sessions: db.prepare("SELECT threadId, runnerId, title, archivedAt FROM threads WHERE runnerId=? AND archivedAt IS NULL ORDER BY updatedAt DESC, threadId DESC").all(id)
					.filter(isActive).map((row) => {
						const state = liveStates.get(row.threadId).state;
						return { name: row.title || row.threadId, threadId: row.threadId, state: state === "starting" ? "opening" : state, managed: true };
					}) }));
		},
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
