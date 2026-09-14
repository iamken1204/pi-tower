// Phase-1 catalog and isolated programmatic transport. No raw pi RPC reaches managed children.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { privateDirectory, uuid } from "./managed-storage.mjs";

export function createManagedTower(dataDir) {
	privateDirectory(dataDir);
	const db = new Database(resolve(dataDir, "tower.sqlite"));
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = FULL");
	db.pragma("busy_timeout = 1250");
	const schema = db.pragma("user_version", { simple: true });
	if (schema > 1) { db.close(); throw new Error("unsupported_tower_schema"); }
	db.transaction(() => {
		db.exec(`CREATE TABLE IF NOT EXISTS managed_runners (runnerId TEXT PRIMARY KEY, instanceId TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS threads (
			threadId TEXT PRIMARY KEY, createKey TEXT UNIQUE NOT NULL, runnerId TEXT NOT NULL,
			runnerInstanceId TEXT NOT NULL, title TEXT NOT NULL, createdAt TEXT NOT NULL,
			workspaceId TEXT, piSessionId TEXT, metadataVersion INTEGER NOT NULL DEFAULT 1);
		PRAGMA user_version = 1;`);
	})();
	const runners = new Map();
	const clients = new Map();
	const thread = (id) => {
		const row = db.prepare("SELECT threadId, runnerId, runnerInstanceId, title, createdAt, workspaceId, piSessionId, metadataVersion FROM threads WHERE threadId=?").get(uuid(id));
		if (!row) throw new Error("unknown_thread");
		return row;
	};
	const send = (ws, value) => {
		if (ws.readyState !== 1) return;
		if (ws.bufferedAmount > 1024 * 1024) { ws.close(1009, "resync_required"); return; }
		ws.send(JSON.stringify({ version: 1, ...value }));
	};
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
		const runner = { ws, instanceId, ready: false, connectionId: randomUUID(), pending: new Map() };
		runners.set(id, runner);
		send(ws, { type: "welcome", connectionId: runner.connectionId });
		ws.on("message", (bytes) => {
			try {
				if (runners.get(id) !== runner) return;
				const message = JSON.parse(bytes.toString());
				if (message.version !== 1) throw new Error("unsupported_protocol");
				if (message.type === "inventory") {
					if (message.piVersion !== "0.85.1" || !Array.isArray(message.threads)) throw new Error("unsupported_capability");
					for (const item of message.threads) {
						const row = thread(item.threadId);
						if (row.runnerId !== id || row.runnerInstanceId !== instanceId) throw new Error("inventory_binding_mismatch");
						bind(row, { ...item, runnerInstanceId: instanceId });
					}
					runner.ready = true;
				} else if (message.type === "result") {
					const p = runner.pending.get(message.requestId);
					if (!p) return;
					clearTimeout(p.timer); runner.pending.delete(message.requestId);
					message.error ? p.reject(new Error(message.error)) : p.resolve(message.result);
				} else if (message.type === "pi_event") {
					const row = thread(message.threadId);
					if (row.runnerId !== id || row.runnerInstanceId !== instanceId) throw new Error("event_binding_mismatch");
					const client = clients.get(row.threadId);
					// Internal get_state responses include local paths. They are never browser events.
					if (client && message.event?.type !== "response") send(client, message);
				}
			} catch (error) { ws.close(1008, error.message.slice(0, 100)); }
		});
		ws.on("close", () => {
			if (runners.get(id) !== runner) return;
			runners.delete(id);
			for (const p of runner.pending.values()) { clearTimeout(p.timer); p.reject(new Error("runner_disconnected_unknown")); }
			for (const [threadId, client] of clients) if (thread(threadId).runnerId === id) client.close(1012, "runner_disconnected");
		});
	}
	function handleClient(ws, params) {
		let row;
		try { row = thread(params.get("thread")); } catch (error) { ws.close(1008, error.message); return; }
		if (clients.has(row.threadId)) { ws.close(4005, "busy"); return; }
		clients.set(row.threadId, ws);
		send(ws, { type: "state", thread: row });
		ws.on("message", async (bytes) => {
			let message;
			try {
				message = JSON.parse(bytes.toString());
				if (message.version !== 1 || !["state", "entries", "prompt", "abort", "sleep", "release"].includes(message.operation)) throw new Error("invalid_command");
				uuid(message.requestId);
				const result = await request(row, message.operation, { message: message.message });
				send(ws, { type: "result", requestId: message.requestId, result });
			} catch (error) { send(ws, { type: "result", requestId: message?.requestId, error: error.message }); }
		});
		ws.on("close", () => {
			if (clients.get(row.threadId) !== ws) return;
			clients.delete(row.threadId);
			try { request(row, "release").catch(() => {}); } catch { /* Offline runner clears its own leases. */ }
		});
	}
	async function http(req, res, url) {
		res.setHeader("content-type", "application/json");
		res.setHeader("cache-control", "no-store");
		try {
			if (req.method === "GET" && url.pathname === "/api/threads") {
				res.end(JSON.stringify(db.prepare("SELECT threadId, runnerId, runnerInstanceId, title, createdAt, piSessionId, workspaceId, metadataVersion FROM threads ORDER BY createdAt DESC, threadId").all()));
				return;
			}
			if (req.method === "GET" && url.pathname.startsWith("/api/threads/")) {
				res.end(JSON.stringify(thread(url.pathname.slice("/api/threads/".length)))); return;
			}
			if (req.method !== "POST" || url.pathname !== "/api/threads") { res.writeHead(404).end(); return; }
			let body = "";
			for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) throw new Error("request_too_large"); }
			const input = JSON.parse(body);
			const createKey = uuid(input.idempotencyKey);
			if (typeof input.runnerId !== "string" || (input.title !== undefined && typeof input.title !== "string") || (input.title?.length ?? 0) > 200) throw new Error("invalid_create");
			const runner = runners.get(input.runnerId);
			if (!runner?.ready) throw new Error("runner_offline");
			let row = db.prepare("SELECT * FROM threads WHERE createKey=?").get(createKey);
			if (row && (row.runnerId !== input.runnerId || row.title !== (input.title ?? ""))) throw new Error("create_key_conflict");
			if (!row) {
				const threadId = randomUUID();
				db.prepare("INSERT INTO threads (threadId,createKey,runnerId,runnerInstanceId,title,createdAt) VALUES (?,?,?,?,?,?)")
					.run(threadId, createKey, input.runnerId, runner.instanceId, input.title ?? "", new Date().toISOString());
				row = thread(threadId);
			}
			bind(row, await request(row, "prepare"));
			res.writeHead(201).end(JSON.stringify(thread(row.threadId)));
		} catch (error) {
			res.writeHead(409).end(JSON.stringify({ error: error.message }));
		}
	}
	return { http, isManagedSession: (name) => !!db.prepare("SELECT 1 FROM threads WHERE threadId=?").get(name),
		routes: { "/managed/runner": handleRunner, "/managed/client": handleClient },
		close() {
			for (const client of clients.values()) client.terminate();
			clients.clear();
			for (const runner of runners.values()) {
				for (const p of runner.pending.values()) { clearTimeout(p.timer); p.reject(new Error("tower_shutdown_unknown")); }
				runner.ws.terminate();
			}
			runners.clear();
			db.close();
		} };
}
