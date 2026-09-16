import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkpoint, durableWrite, loadCheckpoint, privateDirectory, readJson, syncFile, uuid } from "./managed-storage.mjs";
import { CommandJournal, commandPayload } from "./managed-journal.mjs";
import { parseEnvelope } from "./managed-snapshots.mjs";
import { holdWriterLock } from "./managed-lock.mjs";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export class ManagedRunner {
	constructor({ dataDir, id, cwd = process.cwd(), piPackage, idleTtlMs = 30 * 60_000, maxAwake = 4 }) {
		this.dataDir = resolve(dataDir);
		this.cwd = realpathSync(cwd);
		this.id = id;
		this.bootId = randomUUID();
		this.idleTtlMs = idleTtlMs;
		this.maxAwake = maxAwake;
		this.maxSnapshotBytes = Number(process.env.PI_RUNNER_MAX_SNAPSHOT_BYTES ?? 64 * 1024 * 1024);
		if (!Number.isSafeInteger(this.maxSnapshotBytes) || this.maxSnapshotBytes < 1) throw new Error("invalid_snapshot_limit");
		this.piPackage = piPackage || resolve(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
		if (readJson(resolve(this.piPackage, "package.json")).version !== "0.85.1") throw new Error("managed mode requires pi 0.85.1");
		privateDirectory(this.dataDir);
		privateDirectory(resolve(this.dataDir, "threads"));
		const identityFile = resolve(this.dataDir, "instance.json");
		try {
			writeFileSync(identityFile, JSON.stringify({ version: 1, instanceId: randomUUID(), runnerId: id, host: hostname() }), { flag: "wx", mode: 0o600 });
			syncFile(identityFile); syncFile(this.dataDir);
		} catch (error) { if (error.code !== "EEXIST") throw error; }
		this.identity = readJson(identityFile);
		if (this.identity.version !== 1 || this.identity.runnerId !== id || this.identity.host !== hostname()) throw new Error("runner_identity_mismatch");
		uuid(this.identity.instanceId);
		this.threads = new Map(); // Threads this process hosts; several processes may share the data directory.
		this.createSupported = false;
	}

	// Headless wrapper: one per data directory, hosting every thread no terminal owns and accepting browser-created ones.
	hostAll() {
		this.lock = resolve(this.dataDir, "writer.lock");
		this.writerGuard = holdWriterLock(resolve(this.dataDir, "writer.sqlite"));
		// Pre-lock-protocol children cannot be proven dead. Their old marker is never stolen.
		if (existsSync(this.lock) && !existsSync(resolve(this.lock, "kernel-v1.json"))) throw new Error("writer_locked: legacy child exit is unconfirmed");
		mkdirSync(this.lock, { recursive: true, mode: 0o700 });
		durableWrite(resolve(this.lock, "kernel-v1.json"), { version: 1 });
		syncFile(this.dataDir);
		for (const { threadId, record } of this.records()) if (!record.interactive) this.adopt(threadId);
		this.createSupported = true;
	}

	records() {
		const threads = resolve(this.dataDir, "threads");
		return readdirSync(threads).filter((name) => !name.startsWith(".prepare-")).map((name) => { // Unpublished prepare dirs retain crash evidence.
			const recordFile = resolve(threads, uuid(name), "record.json");
			const record = readJson(recordFile);
			this.validateRecord(record, name);
			return { threadId: name, record, recordFile };
		});
	}

	// Host one thread. An awake record whose writer still lives in another process fails with writer_locked.
	adopt(threadId) {
		const recordFile = resolve(this.dataDir, "threads", uuid(threadId), "record.json");
		if (!existsSync(recordFile)) throw new Error("unknown_thread");
		const record = readJson(recordFile);
		this.validateRecord(record, threadId);
		const entry = this.entry(record, recordFile);
		if (record.awake) this.recoverExited(entry);
		this.threads.set(threadId, entry);
		return entry;
	}

	recoverExited(entry) {
		const guard = holdWriterLock(resolve(entry.recordFile, "../runtime.sqlite"));
		try {
			const record = entry.record;
			loadCheckpoint(record.checkpointFile, record.sessionFile, record.piSessionId, record.effectiveCwd, true);
			record.awake = false;
			record.interrupted = true;
			durableWrite(entry.recordFile, record);
			entry.state = "interrupted";
		} finally { guard.close(); }
	}

	entry(record, recordFile) {
		const syncFile = resolve(recordFile, "../sync.json");
		return { record, recordFile, state: record.interrupted ? "interrupted" : "sleeping", activeCommand: record.runId ?? null, runtime: null, counter: 0, sequence: 0, dialogs: new Map(),
			journal: new CommandJournal(resolve(recordFile, "../commands"), this.bootId), syncFile,
			sync: existsSync(syncFile) ? readJson(syncFile) : { ack: null, pending: null } };
	}

	validateRecord(record, threadId) {
		const dir = resolve(this.dataDir, "threads", threadId);
		if (record.version !== 1 || record.threadId !== threadId || record.runnerInstanceId !== this.identity.instanceId ||
			record.sessionFile !== resolve(dir, "session.jsonl") || record.checkpointFile !== resolve(dir, "checkpoint.json") ||
			typeof record.effectiveCwd !== "string" || typeof record.awake !== "boolean") throw new Error("invalid_registry");
		uuid(record.piSessionId); uuid(record.workspaceId);
	}

	announce() {
		this.emit({ type: "inventory", cwd: this.cwd, createSupported: this.createSupported, threads: this.inventory(), piVersion: "0.85.1" });
	}

	inventory() {
		return [...this.threads.values()].map(({ record, state, sync, syncError, cloudCheck, activeCommand, dialogs, native }) => ({ threadId: record.threadId, workspaceId: record.workspaceId, cwd: record.effectiveCwd, hostname: this.identity.host,
			registration: record.registration, inputReady: record.interactive ? !!native : undefined, queueSupported: !!native, queue: native?.queue() ?? [],
			piSessionId: record.piSessionId, state, runId: activeCommand ?? null, pendingDialogs: [...dialogs.values()],
			missingSession: !existsSync(record.sessionFile),
			sync: syncError ? "error" : cloudCheck || sync.pending || !sync.ack ? "pending" : "synced", latestRevision: sync.ack?.revision ?? null }));
	}

	// Tower may only place a thread in a workspace this runner already works in; browsers never name server paths.
	prepare(threadId, cwd = this.cwd) {
		uuid(threadId);
		if (this.threads.has(threadId)) return this.info(threadId);
		const dir = resolve(this.dataDir, "threads", threadId);
		if (existsSync(dir)) { this.adopt(threadId); return this.info(threadId); } // Published before a crash: keep its identity.
		if (cwd !== this.cwd && !this.records().some((item) => item.record.effectiveCwd === cwd)) throw new Error("unknown_workspace");
		const preparing = resolve(this.dataDir, "threads", `.prepare-${threadId}-${randomUUID()}`);
		mkdirSync(preparing, { mode: 0o700 });
		const record = { version: 1, threadId, runnerInstanceId: this.identity.instanceId, workspaceId: randomUUID(),
			effectiveCwd: cwd, piSessionId: randomUUID(), sessionFile: resolve(dir, "session.jsonl"),
			checkpointFile: resolve(dir, "checkpoint.json"), awake: false };
		const header = { type: "session", version: 3, id: record.piSessionId, timestamp: new Date().toISOString(), cwd };
		writeFileSync(resolve(preparing, "session.jsonl"), `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
		syncFile(resolve(preparing, "session.jsonl"));
		durableWrite(resolve(preparing, "checkpoint.json"), checkpoint(header, [], null));
		durableWrite(resolve(preparing, "record.json"), record);
		renameSync(preparing, dir); // Publish the entire registry/session/checkpoint bundle atomically.
		syncFile(resolve(this.dataDir, "threads"));
		const entry = this.entry(record, resolve(dir, "record.json"));
		this.threads.set(threadId, entry);
		return this.info(threadId);
	}

	stageSnapshot(entry, settled = true) {
		if (entry.sync.pending) return;
		const value = readJson(entry.record.checkpointFile);
		const verified = checkpoint(value.header, value.entries, value.leafId);
		if (verified.hash !== value.hash) throw new Error("checkpoint_hash_mismatch");
		const fingerprint = JSON.stringify([value.hash, settled, entry.activeCommand ?? null]);
		if (entry.sync.ack?.fingerprint === fingerprint) return;
		const envelope = { schemaVersion: 1, threadId: entry.record.threadId, runnerInstanceId: this.identity.instanceId,
			piSessionId: entry.record.piSessionId, piVersion: "0.85.1", revision: { generationId: entry.generationId ?? this.bootId, counter: ++entry.counter },
			previous: entry.sync.ack ? { revision: entry.sync.ack.revision, hash: entry.sync.ack.hash } : null,
			capturedAt: new Date().toISOString(), settled, runId: entry.activeCommand ?? null,
			header: value.header, entries: value.entries, leafId: value.leafId };
		const next = { ...entry.sync, pending: { bytes: JSON.stringify(envelope), fingerprint } };
		durableWrite(entry.syncFile, next);
		entry.sync = next;
	}

	syncSnapshot(entry) {
		if (entry.restoring || entry.quarantined) return;
		if (entry.syncing) return entry.syncing;
		entry.syncing = (async () => {
			if (!this.reconciled || !this.connectionId || this.ws?.readyState !== 1) return;
			if (entry.cloudCheck) await this.reconcileSnapshot(entry);
			for (let i = 0; i < 2; i++) {
				this.stageSnapshot(entry, !["running", "waiting_input"].includes(entry.state));
				const pending = entry.sync.pending;
				if (!pending) return;
				const response = await fetch(`${this.httpUrl}/api/managed/snapshots/${entry.record.threadId}`, {
					method: "PUT", headers: { authorization: `Bearer ${this.token}`, "x-runner-instance": this.identity.instanceId,
						"x-runner-connection": this.connectionId }, body: pending.bytes, signal: AbortSignal.timeout(10000),
				});
				if (!response.ok) {
					const error = await response.json();
					if (error.error === "snapshot_stale_predecessor") { entry.cloudCheck = true; await this.reconcileSnapshot(entry); continue; }
					entry.syncError = true; throw new Error(error.error || "snapshot_upload_rejected");
				}
				const ack = await response.json();
				if (ack.hash !== createHash("sha256").update(pending.bytes).digest("hex") || JSON.stringify(ack.revision) !== JSON.stringify(JSON.parse(pending.bytes).revision)) throw new Error("invalid_snapshot_ack");
				const next = { ack: { ...ack, fingerprint: pending.fingerprint }, pending: null };
				durableWrite(entry.syncFile, next);
				entry.sync = next;
				entry.syncError = false;
				entry.lastSyncError = null;
				this.emit?.({ type: "runtime_state", ...this.info(entry.record.threadId) });
			}
		})().catch((error) => {
			if (error.code === "ENOSPC" || error.code === "EIO" || error.message === "invalid_snapshot_ack") entry.syncError = true;
			const code = error.code || (error instanceof SyntaxError ? "invalid_json" : error.message);
			if (entry.lastSyncError !== code) console.error(JSON.stringify({ event: "snapshot_sync_failed", threadId: entry.record.threadId, bootId: this.bootId, code }));
			entry.lastSyncError = code;
			if (entry.syncError) this.emit?.({ type: "runtime_state", ...this.info(entry.record.threadId) });
		}).finally(() => { entry.syncing = null; });
		return entry.syncing;
	}

	async reconcileSnapshot(entry) {
		const connectionId = this.connectionId;
		const response = await fetch(`${this.httpUrl}/api/managed/snapshots/${entry.record.threadId}?latest=1`, {
			headers: { authorization: `Bearer ${this.token}`, "x-runner-instance": this.identity.instanceId, "x-runner-connection": connectionId }, signal: AbortSignal.timeout(10000),
		});
		if (!response.ok && response.status !== 404) throw new Error("snapshot_reconciliation_failed");
		let remote = null, hash = null;
		if (response.ok) {
			const chunks = []; let size = 0;
			for await (const chunk of response.body) { size += chunk.length; if (size > this.maxSnapshotBytes) throw new Error("snapshot_too_large"); chunks.push(chunk); }
			const bytes = Buffer.concat(chunks);
			hash = createHash("sha256").update(bytes).digest("hex");
			if (hash !== response.headers.get("x-snapshot-hash")) throw new Error("invalid_snapshot_ack");
			remote = parseEnvelope(bytes, entry.record);
		}
		if (connectionId !== this.connectionId) throw new Error("stale_connection");
		const local = readJson(entry.record.checkpointFile);
		if (checkpoint(local.header, local.entries, local.leafId).hash !== local.hash) throw new Error("checkpoint_hash_mismatch");
		const candidates = [remote, entry.sync.pending && parseEnvelope(Buffer.from(entry.sync.pending.bytes), entry.record)].filter(Boolean);
		for (const candidate of candidates) {
			if (JSON.stringify(candidate.header) !== JSON.stringify(local.header) || candidate.entries.length > local.entries.length ||
				!candidate.entries.every((item, index) => JSON.stringify(item) === JSON.stringify(local.entries[index])) ||
				(candidate === remote && candidate.entries.length === local.entries.length && candidate.leafId !== local.leafId)) {
				entry.syncError = true; throw new Error("snapshot_divergence");
			}
		}
		// A backup may have rolled Tower back. Re-publish the verified superset under a fresh generation;
		// never rewrite local pi context, reuse old revision values, or lose uncertain outbox evidence.
		durableWrite(resolve(entry.recordFile, `../reconciled-${randomUUID()}.json`), entry.sync);
		const next = { ack: remote ? { revision: remote.revision, hash } : null, pending: null };
		durableWrite(entry.syncFile, next);
		entry.sync = next; entry.generationId = randomUUID(); entry.counter = 0; entry.cloudCheck = false;
	}

	async restore(entry, input) {
		const { record } = entry;
		const requireMissing = () => {
			if (entry.runtime || record.awake || existsSync(record.sessionFile)) throw new Error("restore_requires_missing_session_and_no_child");
			if (realpathSync(record.effectiveCwd) !== record.effectiveCwd) throw new Error("workspace_changed");
		};
		requireMissing();
		if (entry.restoring) throw new Error("restore_in_progress");
		entry.restoring = true;
		try {
			await entry.syncing;
			const response = await fetch(`${this.httpUrl}/api/managed/snapshots/${record.threadId}?restore=${uuid(input.restoreId)}`, {
				headers: { authorization: `Bearer ${this.token}`, "x-runner-instance": this.identity.instanceId, "x-runner-connection": this.connectionId }, signal: AbortSignal.timeout(10000),
			});
			if (!response.ok) throw new Error("restore_download_rejected");
			const chunks = []; let length = 0;
			for await (const chunk of response.body) { length += chunk.length; if (length > this.maxSnapshotBytes) throw new Error("snapshot_too_large"); chunks.push(chunk); }
			const bytes = Buffer.concat(chunks);
			if (createHash("sha256").update(bytes).digest("hex") !== input.hash) throw new Error("restore_hash_mismatch");
			const envelope = parseEnvelope(bytes, record);
			if (JSON.stringify(envelope.revision) !== JSON.stringify(input.expectedRevision) || envelope.header.cwd !== record.effectiveCwd) throw new Error("restore_identity_mismatch");
			requireMissing();
			const value = checkpoint(envelope.header, envelope.entries, envelope.leafId);
			// Preserve any unique unsynced checkpoint/outbox evidence before restoring cloud history.
			durableWrite(resolve(entry.recordFile, `../recovery-${input.restoreId}.json`), { checkpoint: readJson(record.checkpointFile), sync: entry.sync });
			writeFileSync(record.sessionFile, [envelope.header, ...envelope.entries].map((item) => JSON.stringify(item)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
			syncFile(record.sessionFile);
			durableWrite(record.checkpointFile, value);
			const sync = { ack: { revision: envelope.revision, hash: input.hash, fingerprint: JSON.stringify([value.hash, envelope.settled, envelope.runId]) }, pending: null };
			durableWrite(entry.syncFile, sync);
			entry.sync = sync; entry.syncError = false; entry.state = "sleeping";
			loadCheckpoint(record.checkpointFile, record.sessionFile, record.piSessionId, record.effectiveCwd);
			return this.info(record.threadId);
		} finally { entry.restoring = false; }
	}

	commandStatus(entry, commandId, status) {
		const receipt = entry.journal.transition(commandId, status);
		this.emit?.({ type: "command_status", threadId: entry.record.threadId, receipt });
		return receipt;
	}

	requireDriver(entry, epoch) {
		if (!this.reconciled || entry.quarantined || !epoch || epoch.connectionId !== this.connectionId ||
			JSON.stringify(epoch) !== JSON.stringify(entry.epoch)) throw new Error("stale_access");
	}

	info(threadId) {
		const entry = this.threads.get(uuid(threadId));
		if (!entry) throw new Error("unknown_thread");
		return { ...this.inventory().find((item) => item.threadId === threadId), runnerInstanceId: this.identity.instanceId };
	}

	async open(entry) {
		if (entry.restoring) throw new Error("restore_in_progress");
		if (entry.record.interactive) throw new Error("start_thread_in_local_terminal");
		if (entry.runtime) {
			await entry.runtime.ready;
			return entry.runtime;
		}
		if (!["sleeping", "interrupted"].includes(entry.state)) throw new Error("runtime_unavailable");
		if (entry.record.awake) this.recoverExited(entry);
		if ([...this.threads.values()].filter((e) => e.runtime).length >= this.maxAwake) throw new Error("awake_limit");
		const record = entry.record;
		if (realpathSync(record.effectiveCwd) !== record.effectiveCwd) throw new Error("workspace_changed");
		loadCheckpoint(record.checkpointFile, record.sessionFile, record.piSessionId, record.effectiveCwd);
		record.awake = true;
		record.interrupted = false;
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
						this.stageSnapshot(entry);
					} catch { entry.state = "error"; }
				} else {
					entry.state = "interrupted";
					if (entry.activeCommand) this.commandStatus(entry, entry.activeCommand, "unknown");
				}
				entry.dialogs.clear();
				entry.runtime = null;
				this.emit?.({ type: "runtime_state", ...this.info(record.threadId) });
				done();
			});
		});
		child.on("error", () => { entry.state = "error"; });
		child.stdin.on("error", () => {}); // Exit rejects pending requests; the durable awake marker remains.
		child.on("message", (message) => {
			if (message.type === "saved_shutdown") runtime.savedShutdown = true;
			if (message.type === "checkpoint") {
				if (message.settled !== false) {
					entry.state = "idle";
					entry.dialogs.clear();
					if (entry.activeCommand) this.commandStatus(entry, entry.activeCommand, "settled");
					for (const commandId of entry.dialogCommands ?? []) this.commandStatus(entry, commandId, "settled");
					entry.dialogCommands = [];
					this.armIdle(entry);
				}
				try { this.stageSnapshot(entry, message.settled !== false); void this.syncSnapshot(entry); }
				catch { entry.syncError = true; }
			}
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
				if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
					entry.state = "waiting_input"; entry.dialogs.set(event.id, event);
				}
				if (event.type !== "response") this.emit?.({ type: "pi_event", threadId: record.threadId, bootId: this.bootId, runId: entry.activeCommand ?? null, sequence: ++entry.sequence, event });
				if (event.type === "extension_ui_request") this.emit?.({ type: "runtime_state", ...this.info(record.threadId) });
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

	async sleep(entry, driven = false) {
		if (!entry.runtime) return;
		if (entry.state !== "idle" || (entry.driver && !driven)) throw new Error("runtime_busy");
		entry.state = "stopping";
		const runtime = entry.runtime;
		runtime.closing = true;
		runtime.child.stdin.end();
		const timer = setTimeout(() => runtime.child.kill("SIGKILL"), 10000);
		await runtime.exited;
		clearTimeout(timer);
		if (entry.state !== "sleeping") throw new Error("unclean_shutdown");
	}

	async request(input) {
		const { operation, threadId, message, commandId, targetRunId, dialogId, value } = input;
		if (this.stopping) throw new Error("runner_stopping");
		if (operation === "prepare") return this.prepare(threadId, input.cwd);
		this.info(threadId);
		const entry = this.threads.get(threadId);
		if (operation === "state") return this.info(threadId);
		if (operation === "restore") return this.restore(entry, input);
		if (operation === "viewers") {
			if (!Number.isSafeInteger(input.count) || input.count < 0) throw new Error("invalid_viewer_count");
			entry.driver = input.count > 0; this.armIdle(entry); return this.info(threadId);
		}
		if (operation === "access") {
			const epoch = input.epoch;
			if (!this.reconciled || epoch?.connectionId !== this.connectionId || epoch?.bootId !== this.bootId || !Number.isSafeInteger(epoch.counter) || epoch.counter < 1) throw new Error("stale_access");
			uuid(epoch.incarnation);
			if (entry.epoch?.connectionId === epoch.connectionId && epoch.counter <= entry.epoch.counter) throw new Error("stale_access");
			entry.epoch = epoch;
			this.armIdle(entry);
			return { epoch };
		}
		if (operation === "sync") { this.stageSnapshot(entry); void this.syncSnapshot(entry); return this.info(threadId); }
		if (operation === "command") return entry.journal.get(commandId);
		if (operation === "release") { entry.driver = false; this.armIdle(entry); return this.info(threadId); }
		if (operation === "sleep") { this.requireDriver(entry, input.epoch); await this.sleep(entry, true); return this.info(threadId); }
		if (operation === "entries") {
			if (entry.native) return entry.native.entries();
			if (entry.runtime) return this.rpc(await this.open(entry), "get_entries");
			const saved = loadCheckpoint(entry.record.checkpointFile, entry.record.sessionFile, entry.record.piSessionId, entry.record.effectiveCwd);
			return { entries: saved.entries, leafId: saved.leafId };
		}
		this.requireDriver(entry, input.epoch);
		const payload = commandPayload(input);
		uuid(commandId);
		const previous = entry.journal.get(commandId);
		const receipt = entry.journal.receive(commandId, payload, input.epoch);
		if (previous) return receipt;
		try {
			if (entry.native) {
				this.commandStatus(entry, commandId, "dispatching");
				await entry.native.command(input);
				return entry.journal.get(commandId);
			}
			if (operation === "prompt") {
				if (entry.syncError) throw new Error("sync_error");
				if (entry.cloudCheck) throw new Error("sync_reconciling");
				if (entry.state === "stopping") await entry.runtime.exited;
				if (!["sleeping", "idle", "interrupted"].includes(entry.state)) throw new Error("runtime_busy");
				clearTimeout(entry.idle);
				const runtime = await this.open(entry);
				this.requireDriver(entry, input.epoch); // A takeover may occur while the child is starting.
				if (entry.state !== "idle") throw new Error("runtime_busy");
				entry.state = "running";
				entry.activeCommand = commandId;
				entry.record.runId = commandId;
				durableWrite(entry.recordFile, entry.record);
				this.commandStatus(entry, commandId, "dispatching");
				void this.rpc(runtime, "prompt", { message, streamingBehavior: input.behavior ?? "followUp" }).then(() => {
					this.commandStatus(entry, commandId, "accepted");
				}).catch(() => { this.commandStatus(entry, commandId, "unknown"); });
				return entry.journal.get(commandId);
			}
			if (!entry.runtime || !targetRunId || targetRunId !== entry.activeCommand) throw new Error("stale_run");
			if (operation === "abort") {
				this.commandStatus(entry, commandId, "dispatching");
				await this.rpc(entry.runtime, "abort");
				return this.commandStatus(entry, commandId, "settled");
			}
			const dialog = entry.dialogs.get(dialogId);
			if (!dialog || (dialog.method === "confirm" ? typeof value !== "boolean" : typeof value !== "string")) throw new Error("stale_or_invalid_dialog");
			this.commandStatus(entry, commandId, "dispatching");
			entry.runtime.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: dialogId,
				...(dialog.method === "confirm" ? { confirmed: value } : { value }) })}\n`);
			(entry.dialogCommands ??= []).push(commandId);
			entry.dialogs.delete(dialogId);
			entry.state = "running";
			return entry.journal.get(commandId);
		} catch (error) {
			this.commandStatus(entry, commandId, entry.journal.get(commandId).status === "received" ? "rejected" : "unknown");
			throw error;
		} finally {
			this.emit?.({ type: "runtime_state", ...this.info(threadId) });
		}
	}

	connect({ hq, token }) {
		this.httpUrl = hq.replace(/^ws/, "http");
		this.token = token;
		this.syncTimer = setInterval(() => { for (const entry of this.threads.values()) void this.syncSnapshot(entry); }, 5000);
		const dial = () => {
			if (this.stopping) return;
			const ws = new WebSocket(`${hq}/managed/runner?id=${encodeURIComponent(this.id)}&instance=${this.identity.instanceId}&boot=${this.bootId}`, { headers: { authorization: `Bearer ${token}` } });
			this.ws = ws;
			this.emit = (event) => { if (ws.readyState === 1) ws.send(JSON.stringify({ version: 1, ...event })); };
			ws.onmessage = async ({ data }) => {
				let envelope;
				try {
					envelope = JSON.parse(data);
					if (envelope.type === "welcome") { this.connectionId = uuid(envelope.connectionId); this.announce(); return; }
					if (envelope.type === "inventory_ready" && envelope.connectionId === this.connectionId) {
						for (const entry of this.threads.values()) {
							for (const receipt of entry.journal.all()) this.emit({ type: "command_status", threadId: entry.record.threadId, receipt });
						}
						this.emit({ type: "reconciled", connectionId: this.connectionId });
						return;
					}
					if (envelope.type === "inventory_confirmed" && envelope.connectionId === this.connectionId) {
						this.reconciled = true;
						for (const entry of this.threads.values()) {
							if (!envelope.heads?.some((item) => item.threadId === entry.record.threadId) && !envelope.quarantined?.includes(entry.record.threadId)) continue;
							entry.quarantined = envelope.quarantined?.includes(entry.record.threadId) === true;
							if (entry.quarantined) {
								console.error(JSON.stringify({ event: "thread_missing_from_catalog", threadId: entry.record.threadId, bootId: this.bootId }));
								continue;
							}
							if (entry.record.registration) {
								entry.record.registered = true;
								delete entry.record.registration;
								durableWrite(entry.recordFile, entry.record);
							}
							const head = envelope.heads?.find((item) => item.threadId === entry.record.threadId)?.head;
							const pendingHash = entry.sync.pending && createHash("sha256").update(entry.sync.pending.bytes).digest("hex");
							entry.cloudCheck = (head?.hash ?? null) !== (entry.sync.ack?.hash ?? null) && head?.hash !== pendingHash;
							void this.syncSnapshot(entry);
						}
						return;
					}
					if (envelope.version !== 1 || envelope.connectionId !== this.connectionId || this.ws !== ws || ws.readyState !== 1) throw new Error("stale_connection");
					uuid(envelope.requestId);
					const result = await this.request(envelope);
					if (ws.readyState === 1) ws.send(JSON.stringify({ version: 1, type: "result", requestId: envelope.requestId, result }));
				} catch (error) {
					const code = error.code || (error instanceof SyntaxError ? "invalid_json" : error.message.startsWith("pi_rejected:") ? "pi_rejected" : error.message);
					console.error(JSON.stringify({ event: "managed_request_failed", threadId: envelope?.threadId, commandId: envelope?.commandId, bootId: this.bootId, code }));
					if (ws.readyState === 1) ws.send(JSON.stringify({ version: 1, type: "result", requestId: envelope?.requestId, error: code }));
				}
			};
			ws.onclose = () => {
				this.connectionId = null;
				this.reconciled = false;
				for (const entry of this.threads.values()) { entry.driver = false; entry.epoch = null; this.armIdle(entry); }
				this.retry = setTimeout(dial, 3000);
			};
			ws.onerror = () => {};
		};
		dial();
	}

	async close() {
		this.stopping = true;
		clearTimeout(this.retry);
		clearInterval(this.syncTimer);
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
		if (!this.writerGuard) return;
		unlinkSync(resolve(this.lock, "kernel-v1.json"));
		rmdirSync(this.lock);
		syncFile(this.dataDir);
		this.writerGuard.close();
	}
}
