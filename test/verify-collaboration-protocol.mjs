// Fake managed-runner protocol coverage only. This does not simulate pi or its extension SDK.
import assert from "node:assert/strict";
import { once } from "node:events";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { createTower } from "../tower.mjs";
import { commandPayload, payloadHash } from "../managed-journal.mjs";

const token = "fake-collaboration-protocol";
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(fn, label, timeout = 5000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(10); }
	throw new Error(`timeout: ${label}`);
}

const temp = mkdtempSync(resolve(tmpdir(), "pi-collaboration-protocol-"));
let directory = resolve(temp, "tower");
mkdirSync(directory);
let server, port;
async function start() {
	server = createTower({ token, dataDir: directory, idleTtlMs: 0, managedOptions: { minFreeBytes: 1 }, subjectHeader: "X-Forwarded-User" });
	server.listen(port ?? 0, "127.0.0.1");
	await once(server, "listening");
	port = server.address().port;
}
async function stop() { await server.shutdown(); }

class FakeRunner {
	constructor(id, environment, saved = {}) {
		this.id = id;
		this.instanceId = saved.instanceId ?? randomUUID();
		this.bootId = randomUUID();
		this.threadId = saved.threadId ?? randomUUID();
		this.createKey = saved.createKey ?? randomUUID();
		this.workspaceId = saved.workspaceId ?? randomUUID();
		this.piSessionId = saved.piSessionId ?? randomUUID();
		this.title = saved.title ?? `${id} thread`;
		this.environment = environment;
		this.frames = [];
		this.prompts = [];
		this.notifications = [];
		this.failNotificationOnce = false;
	}
	get saved() { return { instanceId: this.instanceId, threadId: this.threadId, createKey: this.createKey, workspaceId: this.workspaceId, piSessionId: this.piSessionId, title: this.title }; }
	async connect() {
		this.ws = new WebSocket(`ws://127.0.0.1:${port}/managed/runner?id=${this.id}&instance=${this.instanceId}&boot=${this.bootId}`, { headers: { authorization: `Bearer ${token}` } });
		this.ws.on("message", (bytes) => this.#receive(JSON.parse(bytes.toString())));
		await once(this.ws, "open");
		await until(() => this.ready, `${this.id} inventory confirmation`);
	}
	send(value) { this.ws.send(JSON.stringify({ version: 1, ...value })); }
	#inventory() {
		return { threadId: this.threadId, registration: { createKey: this.createKey, title: this.title, createdAt: new Date().toISOString() }, workspaceId: this.workspaceId,
			piSessionId: this.piSessionId, cwd: this.environment.cwd, hostname: this.environment.hostname, state: "idle", sync: "synced", collaborationReady: true, inputReady: true };
	}
	#receive(frame) {
		this.frames.push(frame);
		if (frame.type === "welcome") { this.connectionId = frame.connectionId; this.send({ type: "inventory", piVersion: "0.85.1", cwd: this.environment.cwd, createSupported: false, threads: [this.#inventory()] }); return; }
		if (frame.type === "inventory_ready") { this.send({ type: "reconciled", connectionId: this.connectionId }); return; }
		if (frame.type === "inventory_confirmed") { this.ready = true; return; }
		if (!frame.operation) return;
		if (frame.operation === "access") return this.reply(frame, { epoch: frame.epoch });
		if (frame.operation === "viewers") return this.reply(frame, { count: frame.count });
		if (frame.operation === "state") return this.reply(frame, this.#inventory());
		if (frame.operation === "collaboration_notify") {
			this.notifications.push(frame.task.result.notificationId);
			if (this.failNotificationOnce) { this.failNotificationOnce = false; return this.reply(frame, null, "ack_lost"); }
			return this.reply(frame, { status: "delivered" });
		}
		if (frame.operation === "prompt") {
			this.prompts.push(frame);
			const payload = commandPayload(frame);
			if (frame.task) this.send({ type: "collaboration_event", connectionId: this.connectionId, threadId: this.threadId, taskId: frame.task.taskId, status: "running" });
			return this.reply(frame, { commandId: frame.commandId, payload, payloadHash: payloadHash(payload), epoch: frame.epoch, bootId: this.bootId, status: "accepted" });
		}
		this.reply(frame, {});
	}
	reply(frame, result, error) { this.send({ type: "result", requestId: frame.requestId, ...(error ? { error } : { result }) }); }
	async call(operation, input = {}, extra = {}) {
		const requestId = randomUUID();
		this.send({ type: "collaboration_request", connectionId: this.connectionId, requestId, threadId: this.threadId, operation, input, ...extra });
		const response = await until(() => this.frames.find((f) => f.type === "collaboration_response" && f.requestId === requestId), operation);
		return response.error ? { error: response.error } : response.result;
	}
	state(fields) { this.send({ type: "runtime_state", threadId: this.threadId, ...this.#inventory(), ...fields }); }
	close() { this.ws.close(); }
}
// A browser (or bearer API client) on a thread's stream; resolves once Tower granted input access.
async function browser(threadId, headers = {}) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/api/threads/${threadId}/stream`, { headers: { authorization: `Bearer ${token}`, ...headers } });
	const frames = [];
	ws.on("message", (bytes) => frames.push(JSON.parse(bytes.toString())));
	await once(ws, "open");
	const access = await until(() => frames.find((f) => f.type === "access_changed" && f.epoch), "browser access");
	return { ws, async request(operation, fields = {}) {
		const requestId = randomUUID();
		ws.send(JSON.stringify({ version: 1, requestId, operation, epoch: access.epoch, ...fields }));
		return (await until(() => frames.find((f) => f.type === "result" && f.requestId === requestId), operation)).result;
	} };
}

try {
	await start();
	// Project is the directory's last component, so a and c share one while living in different checkouts.
	const a = new FakeRunner("runner-a", { cwd: "/work/alpha", hostname: "host-a" });
	const b = new FakeRunner("runner-b", { cwd: "/srv/beta", hostname: "host-b" });
	const c = new FakeRunner("runner-c", { cwd: "/other/alpha", hostname: "host-c" });
	await Promise.all([a.connect(), b.connect(), c.connect()]);

	const allA = await a.call("thread_list");
	assert.deepEqual(new Set(allA.threads.map((t) => t.threadId)), new Set([b.threadId, c.threadId]), "unfiltered discovery crosses project/cwd/host");
	assert.equal((await b.call("thread_list")).threads.some((t) => t.threadId === a.threadId), true, "discovery works both ways");
	assert.deepEqual((await a.call("thread_list", { project: "alpha" })).threads.map((t) => t.threadId), [c.threadId], "project filter is exact and explicit");
	assert.deepEqual((await a.call("thread_list", { hostname: "host-b" })).threads.map((t) => t.threadId), [b.threadId]);
	assert.deepEqual((await a.call("thread_list", { runnerId: "runner-c" })).threads.map((t) => t.threadId), [c.threadId]);
	const page = await a.call("thread_list", { limit: 1 });
	assert.equal(page.threads.length, 1); assert.ok(page.nextCursor);
	assert.equal((await a.call("thread_list", { limit: 1, cursor: page.nextCursor })).threads.length, 1);

	const requestId = randomUUID();
	const delegated = await a.call("thread_delegate", { targetThreadId: b.threadId, requestId, prompt: "do beta", sourceThreadId: c.threadId, sourceName: "spoof" });
	assert.equal(delegated.sourceThreadId, a.threadId); assert.equal(delegated.sourceName, a.title, "source identity comes from authenticated binding");
	assert.equal(delegated.status, "running", "explicit target event records that execution started"); assert.equal(b.prompts.length, 1);
	assert.equal((await a.call("thread_delegate", { targetThreadId: b.threadId, requestId, prompt: "do beta" })).taskId, delegated.taskId);
	assert.equal(b.prompts.length, 1, "same request is deduplicated");
	assert.equal((await a.call("thread_delegate", { targetThreadId: b.threadId, requestId, prompt: "different" })).error, "collaboration_request_conflict");
	const receiptOf = async (threadId, commandId) => (await fetch(`http://127.0.0.1:${port}/api/threads/${threadId}/commands/${commandId}`, { headers: { authorization: `Bearer ${token}` } })).json();
	const delegatedReceipt = await receiptOf(b.threadId, b.prompts[0].commandId);
	assert.equal(delegatedReceipt.status, "accepted");
	assert.deepEqual(delegatedReceipt.actor, { kind: "thread", threadId: a.threadId, runnerId: "runner-a" }, "receipt names the authenticated source thread and keeps it through the runner's update");
	const forged = { commandId: randomUUID(), payload: commandPayload({ operation: "prompt", message: "forged" }), epoch: {}, bootId: b.bootId, status: "accepted", actor: { kind: "user", subject: "forged" } };
	b.send({ type: "command_status", threadId: b.threadId, receipt: { ...forged, payloadHash: payloadHash(forged.payload) } });
	assert.equal((await until(() => receiptOf(b.threadId, forged.commandId), "runner-originated receipt")).actor, null, "a runner cannot name the actor of a command Tower never admitted");
	const named = await browser(c.threadId, { "x-forwarded-user": "alice@example.com" });
	assert.deepEqual((await named.request("prompt", { commandId: randomUUID(), message: "as alice" })).actor, { kind: "user", subject: "alice@example.com" }, "the proxy-named person reaches the receipt");
	named.ws.close();
	const anonymous = await browser(c.threadId);
	assert.deepEqual((await anonymous.request("prompt", { commandId: randomUUID(), message: "unnamed" })).actor, { kind: "user" }, "a token holder without a subject header stays an unnamed user");
	anonymous.ws.close();
	const overlong = new WebSocket(`ws://127.0.0.1:${port}/api/threads/${c.threadId}/stream`, { headers: { authorization: `Bearer ${token}`, "x-forwarded-user": "x".repeat(201) } });
	assert.equal((await once(overlong, "close"))[0], 4001, "an unusable subject fails closed");

	const premature = await b.call("thread_report", { taskId: randomUUID(), outcome: "completed", summary: "no" });
	assert.equal(premature.error, "unknown_collaboration_task");
	a.failNotificationOnce = true;
	const result = await b.call("thread_report", { taskId: delegated.taskId, outcome: "completed", summary: "finished beta" });
	assert.equal(result.result.summary, "finished beta");
	assert.equal((await a.call("thread_tasks", { taskId: delegated.taskId })).tasks[0].result.summary, "finished beta", "ACK loss does not lose result");
	assert.equal((await c.call("thread_report", { taskId: delegated.taskId, outcome: "completed", summary: "forged" })).error, "collaboration_target_mismatch");
	assert.equal((await b.call("thread_report", { taskId: delegated.taskId, outcome: "completed", summary: "changed" })).error, "collaboration_result_conflict");
	a.state({ state: "idle" });
	await until(() => a.notifications.length === 2, "notification retry");
	assert.equal(a.notifications[0], a.notifications[1], "notification retry keeps stable ID");

	const reverse = await b.call("thread_delegate", { targetThreadId: a.threadId, requestId: randomUUID(), prompt: "cross-host reverse direction" });
	await a.call("thread_report", { taskId: reverse.taskId, outcome: "failed", summary: "reverse result" });
	await until(async () => (await b.call("thread_tasks", { taskId: reverse.taskId })).tasks[0].notificationStatus === "delivered", "reverse result receipt");
	assert.equal((await a.call("thread_delegate", { targetThreadId: randomUUID(), requestId: randomUUID(), prompt: "other HQ" })).error, "unknown_thread");

	const renamed = await a.call("thread_metadata", { title: "Web rename <>&", metadataVersion: 1 });
	assert.equal(renamed.metadataVersion, 2);
	assert.equal((await a.call("thread_metadata", { title: "offline local rename", metadataVersion: 1 })).error, "metadata_conflict");
	a.state({ title: "heartbeat must not rename" });
	assert.equal((await a.call("thread_metadata")).title, "Web rename <>&");
	assert.equal((await a.call("thread_metadata", { title: "", metadataVersion: 2 })).title, "", "blank names are valid");
	a.title = "";
	b.state({ sync: "error" }); await pause(20);
	assert.equal((await a.call("thread_delegate", { targetThreadId: b.threadId, requestId: randomUUID(), prompt: "sync failure" })).status, "rejected");
	b.state({ sync: "synced" });
	b.state({ collaborationReady: false }); await pause(20);
	assert.equal((await a.call("thread_delegate", { targetThreadId: b.threadId, requestId: randomUUID(), prompt: "unavailable" })).status, "rejected");
	b.state({ collaborationReady: true }); await pause(20);
	const archivedResponse = await fetch(`http://127.0.0.1:${port}/api/threads/${b.threadId}`, {
		method: "PATCH", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ archived: true, metadataVersion: 1 }),
	});
	assert.equal(archivedResponse.status, 200);
	assert.equal((await a.call("thread_delegate", { targetThreadId: b.threadId, requestId: randomUUID(), prompt: "archived" })).status, "rejected");
	b.close(); await once(b.ws, "close");
	assert.equal((await a.call("thread_delegate", { targetThreadId: b.threadId, requestId: randomUUID(), prompt: "offline" })).status, "rejected");

	const oversized = "x".repeat(256 * 1024 + 1);
	assert.equal((await a.call("thread_delegate", { targetThreadId: c.threadId, requestId: randomUUID(), prompt: oversized })).error, "invalid_prompt");
	assert.equal((await a.call("thread_list", { project: "x".repeat(4097) })).error, "invalid_project");
	assert.equal((await c.call("thread_report", { taskId: delegated.taskId, outcome: "failed", summary: oversized })).error, "invalid_summary");

	const dispatch = await a.call("thread_delegate", { targetThreadId: c.threadId, requestId: randomUUID(), prompt: "accepted before restart" });
	assert.equal(dispatch.status, "running");
	const backup = resolve(temp, "backup.sqlite");
	const db = new Database(resolve(directory, "tower.sqlite")); await db.backup(backup); db.close();
	c.close(); await once(c.ws, "close");
	await until(async () => (await a.call("thread_tasks", { taskId: dispatch.taskId })).tasks[0].status === "unknown", "lost target becomes unknown without restarting Tower");
	assert.equal((await a.call("thread_tasks", { taskId: delegated.taskId })).tasks[0].status, "completed", "disconnect cannot erase a submitted report");
	a.close(); await stop();
	await start();
	const a2 = new FakeRunner("runner-a", a.environment, a.saved), c2 = new FakeRunner("runner-c", c.environment, c.saved);
	await Promise.all([a2.connect(), c2.connect()]);
	assert.equal(c2.prompts.length, 0, "Tower restart never replays accepted task");
	assert.equal((await a2.call("thread_tasks", { taskId: dispatch.taskId })).tasks[0].status, "unknown");
	await stop();
	directory = resolve(temp, "restored"); mkdirSync(directory); cpSync(backup, resolve(directory, "tower.sqlite")); await start();
	const a3 = new FakeRunner("runner-a", a.environment, a.saved), c3 = new FakeRunner("runner-c", c.environment, c.saved);
	await Promise.all([a3.connect(), c3.connect()]);
	assert.equal(c3.prompts.length, 0, "backup restore never replays collaboration commands");
	assert.equal((await a3.call("thread_tasks", { taskId: dispatch.taskId })).tasks[0].status, "unknown");

	// A schema-3 catalog must retain metadata and snapshot tables while adding cwd, hostname and task state.
	await stop();
	const legacyDir = resolve(temp, "legacy"); mkdirSync(legacyDir);
	const legacy = new Database(resolve(legacyDir, "tower.sqlite"));
	legacy.exec("CREATE TABLE managed_runners (runnerId TEXT PRIMARY KEY, instanceId TEXT NOT NULL); CREATE TABLE threads (threadId TEXT PRIMARY KEY, createKey TEXT UNIQUE NOT NULL, runnerId TEXT NOT NULL, runnerInstanceId TEXT NOT NULL, title TEXT NOT NULL, createdAt TEXT NOT NULL, workspaceId TEXT, piSessionId TEXT, metadataVersion INTEGER NOT NULL DEFAULT 1, updatedAt TEXT, archivedAt TEXT, createTitle TEXT); CREATE TABLE managed_commands (threadId TEXT NOT NULL, commandId TEXT NOT NULL, payloadHash TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(threadId,commandId)); CREATE TABLE sentinel_snapshots (value TEXT); INSERT INTO sentinel_snapshots VALUES ('preserved'); PRAGMA user_version=3;");
	legacy.close(); directory = legacyDir; await start(); await stop();
	const migrated = new Database(resolve(legacyDir, "tower.sqlite"));
	assert.equal(migrated.pragma("user_version", { simple: true }), 5);
	assert.equal(migrated.prepare("SELECT value FROM sentinel_snapshots").get().value, "preserved");
	for (const column of ["cwd", "hostname"]) assert.ok(migrated.prepare("SELECT name FROM pragma_table_info('threads') WHERE name=?").get(column), column);
	assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE name='managed_collaboration_tasks'").get()); migrated.close();
	console.log("ok fake collaboration protocol: discovery, identity, delegation, reports, retry, restart/restore, limits and schema-3 migration");
} finally {
	try { await server?.shutdown(); } catch {}
	rmSync(temp, { recursive: true, force: true });
}
