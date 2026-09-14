import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkpoint, durableWrite, loadCheckpoint, privateDirectory, readJson, syncFile, uuid } from "./managed-storage.mjs";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export class ManagedRunner {
	constructor({ dataDir, id, cwd = process.cwd(), piPackage, idleTtlMs = 30 * 60_000, maxAwake = 4 }) {
		this.dataDir = resolve(dataDir);
		this.cwd = realpathSync(cwd);
		this.id = id;
		this.bootId = randomUUID();
		this.idleTtlMs = idleTtlMs;
		this.maxAwake = maxAwake;
		this.piPackage = piPackage || resolve(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
		if (readJson(resolve(this.piPackage, "package.json")).version !== "0.85.1") throw new Error("managed mode requires pi 0.85.1");
		privateDirectory(this.dataDir);
		this.lock = resolve(this.dataDir, "writer.lock");
		// Never steal a stale lock: wrapper death says nothing about child death.
		try { mkdirSync(this.lock, { mode: 0o700 }); } catch (error) {
			if (error.code === "EEXIST") throw new Error("writer_locked: another wrapper or an unconfirmed child may exist; refusing startup");
			throw error;
		}
		syncFile(this.dataDir);
		const identityFile = resolve(this.dataDir, "instance.json");
		if (!existsSync(identityFile)) durableWrite(identityFile, { version: 1, instanceId: randomUUID(), runnerId: id, host: hostname() });
		this.identity = readJson(identityFile);
		if (this.identity.version !== 1 || this.identity.runnerId !== id || this.identity.host !== hostname()) throw new Error("runner_identity_mismatch");
		uuid(this.identity.instanceId);
		this.threads = new Map();
		privateDirectory(resolve(this.dataDir, "threads"));
		for (const name of readdirSync(resolve(this.dataDir, "threads"))) {
			const recordFile = resolve(this.dataDir, "threads", uuid(name), "record.json");
			const record = readJson(recordFile);
			this.validateRecord(record, name);
			if (record.awake) throw new Error("unconfirmed_runtime: refusing to start a second writer");
			this.threads.set(name, { record, recordFile, state: "sleeping", runtime: null });
		}
	}

	validateRecord(record, threadId) {
		const dir = resolve(this.dataDir, "threads", threadId);
		if (record.version !== 1 || record.threadId !== threadId || record.runnerInstanceId !== this.identity.instanceId ||
			record.sessionFile !== resolve(dir, "session.jsonl") || record.checkpointFile !== resolve(dir, "checkpoint.json") ||
			typeof record.effectiveCwd !== "string" || typeof record.awake !== "boolean") throw new Error("invalid_registry");
		uuid(record.piSessionId); uuid(record.workspaceId);
	}

	inventory() {
		return [...this.threads.values()].map(({ record, state }) => ({ threadId: record.threadId, workspaceId: record.workspaceId,
			piSessionId: record.piSessionId, state }));
	}

	prepare(threadId) {
		uuid(threadId);
		if (this.threads.has(threadId)) return this.info(threadId);
		const dir = resolve(this.dataDir, "threads", threadId);
		mkdirSync(dir, { mode: 0o700 });
		const record = { version: 1, threadId, runnerInstanceId: this.identity.instanceId, workspaceId: randomUUID(),
			effectiveCwd: this.cwd, piSessionId: randomUUID(), sessionFile: resolve(dir, "session.jsonl"),
			checkpointFile: resolve(dir, "checkpoint.json"), awake: false };
		const header = { type: "session", version: 3, id: record.piSessionId, timestamp: new Date().toISOString(), cwd: this.cwd };
		writeFileSync(record.sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
		syncFile(record.sessionFile);
		durableWrite(record.checkpointFile, checkpoint(header, [], null));
		const entry = { record, recordFile: resolve(dir, "record.json"), state: "sleeping", runtime: null };
		durableWrite(entry.recordFile, record);
		syncFile(resolve(this.dataDir, "threads"));
		this.threads.set(threadId, entry);
		return this.info(threadId);
	}

	info(threadId) {
		const entry = this.threads.get(uuid(threadId));
		if (!entry) throw new Error("unknown_thread");
		return { ...this.inventory().find((item) => item.threadId === threadId), runnerInstanceId: this.identity.instanceId };
	}

	async open(entry) {
		if (entry.runtime) {
			await entry.runtime.ready;
			return entry.runtime;
		}
		if (entry.state !== "sleeping") throw new Error("runtime_unavailable");
		if ([...this.threads.values()].filter((e) => e.runtime).length >= this.maxAwake) throw new Error("awake_limit");
		const record = entry.record;
		if (realpathSync(record.effectiveCwd) !== record.effectiveCwd) throw new Error("workspace_changed");
		loadCheckpoint(record.checkpointFile, record.sessionFile, record.piSessionId, record.effectiveCwd);
		record.awake = true;
		durableWrite(entry.recordFile, record); // Before spawn: any uncertain startup requires operator recovery.
		entry.state = "starting";
		const child = spawn(process.execPath, [fileURLToPath(new URL("./managed-pi.mjs", import.meta.url)), this.piPackage, entry.recordFile], {
			cwd: record.effectiveCwd, stdio: ["pipe", "pipe", "inherit", "ipc"],
		});
		const runtime = { child, pending: new Map(), closing: false, savedShutdown: false };
		entry.runtime = runtime;
		runtime.exited = new Promise((done) => {
			child.once("exit", (code) => {
				clearTimeout(entry.idle);
				for (const p of runtime.pending.values()) { clearTimeout(p.timer); p.reject(new Error("pi_exited")); }
				runtime.pending.clear();
				if (runtime.closing && code === 0 && runtime.savedShutdown) {
					try {
						loadCheckpoint(record.checkpointFile, record.sessionFile, record.piSessionId, record.effectiveCwd);
						record.awake = false;
						durableWrite(entry.recordFile, record);
						entry.state = "sleeping";
					} catch { entry.state = "error"; }
				} else entry.state = "interrupted";
				entry.runtime = null;
				done();
			});
		});
		child.on("error", () => { entry.state = "error"; });
		child.stdin.on("error", () => {}); // Exit rejects pending requests; the durable awake marker remains.
		child.on("message", (message) => {
			if (message.type === "saved_shutdown") runtime.savedShutdown = true;
			if (message.type === "checkpoint") { entry.state = "idle"; this.armIdle(entry); }
			if (message.type === "checkpoint_error") entry.state = "error";
		});
		let buffer = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) { entry.state = "error"; child.kill(); return; }
			let end;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
				if (!line.trim()) continue;
				let event;
				try { event = JSON.parse(line); } catch { entry.state = "error"; child.kill(); return; }
				if (event.type === "response") {
					const p = runtime.pending.get(event.id);
					if (p) { clearTimeout(p.timer); runtime.pending.delete(event.id); event.success ? p.resolve(event.data) : p.reject(new Error(`pi_rejected: ${event.error}`)); }
				}
				if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) entry.state = "waiting_input";
				this.emit?.({ type: "pi_event", threadId: record.threadId, event });
			}
		});
		runtime.ready = this.rpc(runtime, "get_state").then((state) => {
			if (state.sessionId !== record.piSessionId) throw new Error("pi_session_mismatch");
			entry.state = "idle";
			this.armIdle(entry);
		});
		await runtime.ready;
		return runtime;
	}

	rpc(runtime, type, fields = {}) {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { runtime.pending.delete(id); reject(new Error("pi_timeout_unknown")); }, 15000);
			runtime.pending.set(id, { resolve, reject, timer });
			runtime.child.stdin.write(`${JSON.stringify({ ...fields, type, id })}\n`);
		});
	}

	armIdle(entry) {
		clearTimeout(entry.idle);
		if (!this.idleTtlMs || entry.driver || entry.state !== "idle") return;
		entry.idle = setTimeout(() => { this.sleep(entry).catch(() => { entry.state = "error"; }); }, this.idleTtlMs);
	}

	async sleep(entry) {
		if (!entry.runtime) return;
		if (entry.state !== "idle" || entry.driver) throw new Error("runtime_busy");
		entry.state = "stopping";
		const runtime = entry.runtime;
		runtime.closing = true;
		runtime.child.stdin.end();
		const timer = setTimeout(() => runtime.child.kill("SIGKILL"), 10000);
		await runtime.exited;
		clearTimeout(timer);
		if (entry.state !== "sleeping") throw new Error("unclean_shutdown");
	}

	async request({ operation, threadId, message }) {
		if (this.stopping) throw new Error("runner_stopping");
		if (operation === "prepare") return this.prepare(threadId);
		this.info(threadId);
		const entry = this.threads.get(threadId);
		if (operation === "state") return this.info(threadId);
		if (operation === "release") { entry.driver = false; this.armIdle(entry); return this.info(threadId); }
		if (operation === "sleep") { entry.driver = false; await this.sleep(entry); return this.info(threadId); }
		if (operation === "entries") {
			if (entry.runtime) return this.rpc(await this.open(entry), "get_entries");
			const saved = loadCheckpoint(entry.record.checkpointFile, entry.record.sessionFile, entry.record.piSessionId, entry.record.effectiveCwd);
			return { entries: saved.entries, leafId: saved.leafId };
		}
		if (operation === "abort") {
			if (entry.runtime) await this.rpc(await this.open(entry), "abort");
			return this.info(threadId);
		}
		if (operation !== "prompt" || typeof message !== "string" || !message.trim() || message.trimStart().startsWith("/") || Buffer.byteLength(message) > 256 * 1024) throw new Error("invalid_command");
		if (!["sleeping", "idle"].includes(entry.state)) throw new Error("runtime_busy");
		entry.driver = true;
		clearTimeout(entry.idle);
		const runtime = await this.open(entry);
		if (entry.state !== "idle") throw new Error("runtime_busy");
		entry.state = "running";
		// No retries: phase 2 will add durable command receipts and reconciliation.
		await this.rpc(runtime, "prompt", { message });
		return this.info(threadId);
	}

	connect({ hq, token }) {
		const dial = () => {
			if (this.stopping) return;
			const ws = new WebSocket(`${hq}/managed/runner?id=${encodeURIComponent(this.id)}&instance=${this.identity.instanceId}&boot=${this.bootId}`, { headers: { authorization: `Bearer ${token}` } });
			this.ws = ws;
			this.emit = (event) => { if (ws.readyState === 1) ws.send(JSON.stringify({ version: 1, ...event })); };
			ws.onmessage = async ({ data }) => {
				let envelope;
				try {
					envelope = JSON.parse(data);
					if (envelope.type === "welcome") { this.connectionId = uuid(envelope.connectionId); this.emit({ type: "inventory", threads: this.inventory(), piVersion: "0.85.1" }); return; }
					if (envelope.version !== 1 || envelope.connectionId !== this.connectionId || this.ws !== ws || ws.readyState !== 1) throw new Error("stale_connection");
					uuid(envelope.requestId);
					const result = await this.request(envelope);
					if (ws.readyState === 1) ws.send(JSON.stringify({ version: 1, type: "result", requestId: envelope.requestId, result }));
				} catch (error) {
					if (ws.readyState === 1) ws.send(JSON.stringify({ version: 1, type: "result", requestId: envelope?.requestId, error: error.message }));
				}
			};
			ws.onclose = () => {
				this.connectionId = null;
				for (const entry of this.threads.values()) { entry.driver = false; this.armIdle(entry); }
				this.retry = setTimeout(dial, 3000);
			};
			ws.onerror = () => {};
		};
		dial();
	}

	async close() {
		this.stopping = true;
		clearTimeout(this.retry);
		this.ws?.close();
		await Promise.all([...this.threads.values()].map(async (entry) => {
			entry.driver = false;
			clearTimeout(entry.idle);
			try {
				if (entry.state === "starting") await entry.runtime.ready;
				if (["running", "waiting_input"].includes(entry.state)) {
					await this.rpc(entry.runtime, "abort");
					for (let i = 0; i < 100 && entry.state !== "idle"; i++) await delay(50);
				}
				await this.sleep(entry);
			} catch { entry.runtime?.child.kill("SIGKILL"); }
		}));
		if ([...this.threads.values()].some((entry) => entry.record.awake)) throw new Error("unclean_shutdown: writer lock retained");
		rmdirSync(this.lock);
		syncFile(this.dataDir);
	}
}
