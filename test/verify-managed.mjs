import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createTower } from "../tower.mjs";
import { checkpoint, durableWrite, readJson } from "../managed-storage.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = process.env.PI_COMPAT_PACKAGE || resolve(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const temp = realpathSync(mkdtempSync(resolve(tmpdir(), "pi-managed-")));
for (const dir of ["home", "agent", "workspace", "other", "data", "tower"]) mkdirSync(resolve(temp, dir));
mkdirSync(resolve(temp, "agent/extensions"));
cpSync(resolve(root, "test/compat/managed-extension.mjs"), resolve(temp, "agent/extensions/test.js"));
writeFileSync(resolve(temp, "agent/settings.json"), JSON.stringify({ defaultProvider: "phase1", defaultModel: "faux-1", compaction: { enabled: false } }));
const log = resolve(temp, "children.jsonl");
const env = { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: resolve(temp, "home"), PI_CODING_AGENT_DIR: resolve(temp, "agent"),
	PI_OFFLINE: "1", PI_COMPAT_PACKAGE: pkg, MANAGED_TEST_LOG: log };
const token = "isolated-managed-test";
let server;
let port;
let towerDirectory = resolve(temp, "tower");
const processes = new Set();
const sockets = new Set();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, description, ms = 15000) {
	const end = Date.now() + ms;
	while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(25); }
	throw new Error(`timeout: ${description}`);
}
async function tower() {
	server = createTower({ token, dataDir: towerDirectory, idleTtlMs: 0 });
	server.listen(port ?? 0, "127.0.0.1"); await once(server, "listening"); port = server.address().port;
}
function runner(cwd = "workspace", data = "data", boundary) {
	const executable = boundary ? [resolve(root, "test/compat/crash-managed-runner.mjs"), boundary, resolve(root, "runner.mjs")] : [resolve(root, "runner.mjs")];
	const child = spawn(process.execPath, [...executable, "--hq", `ws://127.0.0.1:${port}`, "--id", "managed-test", "--token", token,
		"--managed-threads", "--data-dir", resolve(temp, data), "--pi-package", pkg, "--managed-idle-ms", "150"],
	{ cwd: resolve(temp, cwd), env, stdio: ["ignore", "ignore", "pipe"] });
	processes.add(child);
	child.log = ""; child.stderr.on("data", (data) => { child.log += data; });
	return child;
}
async function stop(child, signal = "SIGTERM") {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit"); child.kill(signal); await exited;
	processes.delete(child);
	if (signal === "SIGTERM") assert.equal(child.exitCode, 0, child.log);
}
async function create(key, title = "測試") {
	const response = await fetch(`http://127.0.0.1:${port}/api/threads`, { method: "POST", headers: { authorization: `Bearer ${token}` },
		body: JSON.stringify({ idempotencyKey: key, runnerId: "managed-test", title }) });
	return { status: response.status, body: await response.json() };
}
async function attach(threadId, drive = true) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/managed/client?thread=${threadId}`, { headers: { authorization: `Bearer ${token}` } });
	sockets.add(ws);
	const frames = [];
	let epoch;
	ws.onmessage = ({ data }) => { const frame = JSON.parse(data); frames.push(frame); if (frame.type === "access_changed") epoch = frame.epoch; };
	await once(ws, "open");
	const client = { ws, frames, get epoch() { return epoch; }, async request(operation, fields = {}, allowError = false) {
		const requestId = randomUUID();
		ws.send(JSON.stringify({ version: 1, requestId, commandId: randomUUID(), operation, epoch, ...fields }));
		const reply = await until(() => frames.find((f) => f.requestId === requestId), operation, 25000);
		if (!allowError) assert.equal(reply.error, undefined, JSON.stringify({ reply, starts: starts() }));
		return reply.error ? reply : reply.result;
	} };
	await until(() => epoch, "automatic access");
	return client;
}
function close(client) { client.ws.close(); sockets.delete(client.ws); }
const starts = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const history = (id) => fetch(`http://127.0.0.1:${port}/api/threads/${id}/history`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());

try {
	await tower();
	let r = runner();
	const key = randomUUID();
	const created = await until(async () => { const result = await create(key); return result.status === 201 && result.body; }, "registration");
	const id = created.threadId;
	assert.deepEqual((await create(key)).body, created);
	assert.equal((await create(key, "different")).status, 409);
	assert.equal(starts().length, 0, "prepare must not spawn pi");
	const legacy = new WebSocket(`ws://127.0.0.1:${port}/attach?runner=managed-test&session=${id}`, { headers: { authorization: `Bearer ${token}` } });
	assert.equal((await once(legacy, "close"))[0].reason, "managed_namespace");
	const duplicateRegistration = new WebSocket(`ws://127.0.0.1:${port}/managed/runner?id=managed-test&instance=${randomUUID()}&boot=${randomUUID()}`, { headers: { authorization: `Bearer ${token}` } });
	assert.equal((await once(duplicateRegistration, "close"))[0].reason, "duplicate_runner");
	// A runner that only speaks the managed protocol (interactive mode) must still show on the home page.
	// connection: close keeps these out of the keep-alive pool, which the tower restart below would otherwise reset.
	const state = () => fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: `Bearer ${token}`, connection: "close" } }).then((response) => response.json());
	const events = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { authorization: `Bearer ${token}` } });
	const sse = events.body.getReader();
	let sseText = "";
	const nextEvent = (label) => Promise.race([(async () => {
		for (;;) {
			while (!sseText.includes("\n\n")) sseText += new TextDecoder().decode((await sse.read()).value);
			const cut = sseText.indexOf("\n\n");
			const data = sseText.slice(0, cut).split("\n").find((line) => line.startsWith("data: "));
			sseText = sseText.slice(cut + 2);
			if (data) return JSON.parse(data.slice(6));
		}
	})(), pause(5000).then(() => { throw new Error(`timeout: ${label}`); })]);
	assert.deepEqual((await nextEvent("initial SSE snapshot")).runners.map((item) => item.id), ["managed-test"]);
	const managedOnly = new WebSocket(`ws://127.0.0.1:${port}/managed/runner?id=managed-only&instance=${randomUUID()}&boot=${randomUUID()}`, { headers: { authorization: `Bearer ${token}` } });
	sockets.add(managedOnly);
	const confirmed = new Promise((resolve) => { managedOnly.onmessage = ({ data }) => {
		const frame = JSON.parse(data);
		if (frame.type === "welcome") managedOnly.send(JSON.stringify({ version: 1, type: "inventory", piVersion: "0.85.1", threads: [] }));
		if (frame.type === "inventory_ready") managedOnly.send(JSON.stringify({ version: 1, type: "reconciled", connectionId: frame.connectionId }));
		if (frame.type === "inventory_confirmed") resolve();
	}; });
	await confirmed;
	// Runtime state changes also broadcast, so read until the registration shows up.
	for (let i = 0; !(await nextEvent("SSE announces the managed-only runner")).runners.some((item) => item.id === "managed-only"); i++) assert.ok(i < 20, "SSE never announced the managed-only runner");
	const listed = (await state()).runners;
	assert.deepEqual(listed.map(({ id, managed, sessions }) => ({ id, managed, sessions })),
		[{ id: "managed-test", managed: true, sessions: [] }, { id: "managed-only", managed: true, sessions: [] }]);
	assert.ok(listed.every((item) => Number.isFinite(Date.parse(item.connectedAt))));
	const legacyListing = await fetch(`http://127.0.0.1:${port}/runners`, { headers: { authorization: `Bearer ${token}`, connection: "close" } }).then((response) => response.json());
	assert.deepEqual(legacyListing.map((item) => item.id), ["managed-test"], "legacy /runners contract unchanged");
	managedOnly.close(); sockets.delete(managedOnly);
	await until(async () => !(await state()).runners.some((item) => item.id === "managed-only"), "managed-only runner leaves the home page");
	await sse.cancel();
	assert.equal((await fetch(`http://127.0.0.1:${port}/api/threads`)).status, 401);
	let client = await attach(id);
	assert.deepEqual(await client.request("entries"), { entries: [], leafId: null });
	assert.equal(starts().length, 0, "reading must not spawn pi");
	const oversizedClient = await attach(id, false);
	const oversizedClosed = once(oversizedClient.ws, "close");
	oversizedClient.ws.send(Buffer.alloc(512 * 1024 + 1));
	assert.equal((await oversizedClosed)[0].code, 1009);
	assert.equal((await client.request("state")).state, "sleeping", "oversize peer cannot terminate Tower or wake pi");
	close(client);
	await stop(r);
	r = runner("other"); // Existing thread must retain workspace, not follow new runner cwd.
	await until(async () => (await create(key)).status === 201, "restart registration");
	client = await attach(id);
	assert.equal((await client.request("state")).piSessionId, created.piSessionId);
	const firstCommand = randomUUID();
	await client.request("prompt", { message: "first", commandId: firstCommand });
	await until(async () => (await client.request("state")).state === "idle", "settled");
	const before = await client.request("entries");
	await until(async () => (await client.request("state")).sync === "synced", "first snapshot committed");
	const activeList = () => fetch(`http://127.0.0.1:${port}/api/threads?active=true`, { headers: { authorization: `Bearer ${token}`, connection: "close" } }).then((response) => response.json());
	// The runner reports idle before its runtime_state frame reaches the tower, so poll rather than assert once.
	await until(async () => JSON.stringify((await state()).runners.find((item) => item.id === "managed-test").sessions) === JSON.stringify([{ name: "測試", threadId: id, state: "idle", managed: true }]), "an awake thread is a home page session");
	assert.deepEqual((await activeList()).threads.map((row) => row.threadId), [id]);
	assert.deepEqual((await history(id)).entries, before.entries);
	assert.equal((await client.request("prompt", { message: "first", commandId: firstCommand })).status, "settled");
	assert.equal((await client.request("prompt", { message: "changed", commandId: firstCommand }, true)).error, "command_payload_conflict");
	assert.deepEqual(await client.request("entries"), before, "command replay cannot append another message");
	assert.equal(before.entries.filter((e) => e.message?.role === "assistant").length, 1);
	assert.equal(before.entries.find((e) => e.customType === "phase1-cwd").data.cwd, resolve(temp, "workspace"));
	assert.equal(starts().length, 1);
	assert.equal((await client.request("switch_session", {}, true)).error, "invalid_command");
	assert.equal((await client.request("prompt", { message: "/new" }, true)).error, "invalid_command");
	close(client);
	await pause(700);
	client = await attach(id);
	await until(async () => (await client.request("state")).state === "sleeping", "TTL sleep");
	await until(async () => (await state()).runners.find((item) => item.id === "managed-test").sessions.length === 0, "a sleeping thread leaves the home page");
	assert.deepEqual((await activeList()).threads, [], "a sleeping thread is inactive");
	assert.equal((await fetch(`http://127.0.0.1:${port}/api/threads`, { headers: { authorization: `Bearer ${token}`, connection: "close" } }).then((response) => response.json())).threads.length, 1, "the unfiltered list keeps it");
	assert.deepEqual(await client.request("entries"), before);
	close(client);
	await stop(r);
	// Add a full-tree fixture with a non-tail leaf while no process owns the session.
	const record = readJson(resolve(temp, "data/threads", id, "record.json"));
	const snapshotFile = resolve(temp, "branch.json");
	execFileSync(process.execPath, [resolve(root, "test/compat/pi-sdk-worker.mjs"), "capture", record.sessionFile, snapshotFile], { cwd: record.effectiveCwd, env });
	const branch = readJson(snapshotFile);
	durableWrite(record.checkpointFile, checkpoint(branch.header, branch.entries, branch.leafId));
	await new Promise((done) => server.close(done));
	await tower();
	r = runner("other");
	await until(async () => (await create(key)).status === 201, "tower and runner restart");
	client = await attach(id);
	assert.deepEqual(await client.request("entries"), { entries: branch.entries, leafId: branch.leafId });
	await client.request("prompt", { message: "second" });
	await until(async () => (await client.request("state")).state === "idle", "second settled");
	const after = await client.request("entries");
	assert.deepEqual(after.entries.slice(0, branch.entries.length), branch.entries);
	assert.equal(after.entries[branch.entries.length].parentId, branch.leafId);
	assert.equal((await client.request("state")).piSessionId, created.piSessionId);
	assert.ok(starts().every((item) => item.cwd === resolve(temp, "workspace")));
	console.log("ok managed: blank identity, catalog restart, original cwd, full branches, leaf and TTL restore");
	await until(async () => (await client.request("state")).sync === "synced", "second snapshot committed");
	assert.deepEqual((await history(id)).entries, after.entries);
	// Capture the real catalog, receipts and current WAL while Tower remains online.
	const backupSource = new Database(resolve(towerDirectory, "tower.sqlite"));
	const backupPath = resolve(temp, "consistent-backup.sqlite");
	await backupSource.backup(backupPath);
	const backedUpHead = await history(id);
	backupSource.close();
	const orphan = (await create(randomUUID(), "created after backup")).body;
	const orphanRecordFile = resolve(temp, "data/threads", orphan.threadId, "record.json");
	const orphanRecord = readFileSync(orphanRecordFile, "utf8");
	const oldOwnership = client.epoch;
	await client.request("prompt", { message: "committed after backup" });
	await until(async () => (await client.request("state")).state === "idle" && (await client.request("state")).sync === "synced", "post-backup commit");
	const offlineCommand = randomUUID();
	await client.request("prompt", { message: "slow", commandId: offlineCommand });
	close(client);
	await server.shutdown();
	await pause(2100); // The run and idle sleep finish with no Tower and no viewer.
	const offlineCheckpoint = readJson(record.checkpointFile);
	assert.equal(offlineCheckpoint.entries.filter((e) => e.message?.role === "assistant").length, 5); // Includes the synthetic abandoned tool-call assistant.
	towerDirectory = resolve(temp, "restored-tower");
	mkdirSync(towerDirectory);
	cpSync(backupPath, resolve(towerDirectory, "tower.sqlite"));
	const restoredDatabase = new Database(resolve(towerDirectory, "tower.sqlite"));
	assert.equal(restoredDatabase.pragma("integrity_check", { simple: true }), "ok");
	assert.equal(restoredDatabase.prepare("SELECT title FROM threads WHERE threadId=?").get(id).title, created.title);
	assert.equal(JSON.parse(restoredDatabase.prepare("SELECT receipt FROM managed_commands WHERE commandId=?").get(firstCommand).receipt).status, "settled");
	restoredDatabase.close();
	await tower();
	assert.deepEqual(await history(id), backedUpHead, "backup starts from its own verified checkpoint, before runner reconciliation");
	await until(async () => (await create(key)).status === 201, "offline runner reconnect");
	client = await attach(id);
	await until(async () => (await client.request("state")).sync === "synced", "offline outbox uploaded");
	assert.deepEqual((await history(id)).entries, offlineCheckpoint.entries);
	assert.equal(readFileSync(orphanRecordFile, "utf8"), orphanRecord, "a catalog orphan remains untouched on its original runner");
	assert.equal((await fetch(`http://127.0.0.1:${port}/api/threads/${orphan.threadId}`, { headers: { authorization: `Bearer ${token}` } }).then((res) => res.json())).error, "unknown_thread");
	assert.notEqual((await history(id)).revision.generationId, backedUpHead.revision.generationId, "rollback reconciliation requires a fresh generation");
	assert.equal((await client.request("prompt", { message: "stale permission", epoch: oldOwnership }, true)).error, "stale_access");
	assert.equal((await client.request("command", { commandId: offlineCommand })).status, "settled");
	await client.request("prompt", { message: "slow", commandId: offlineCommand });
	assert.deepEqual(await client.request("entries"), { entries: offlineCheckpoint.entries, leafId: offlineCheckpoint.leafId });
	console.log("ok managed: live-WAL catalog/receipt backup restored in new directory; offline superset reconciles rollback with fresh revision/ownership and no replay");
	const origin = `http://127.0.0.1:${port}`;
	const login = await fetch(`${origin}/api/session`, { method: "POST", body: new URLSearchParams({ token }), redirect: "manual" });
	const cookie = login.headers.get("set-cookie").split(";")[0];
	assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
	const api = async (path, method = "GET", body, headers = {}) => {
		const response = await fetch(`${origin}${path}`, { method, headers: { cookie, origin, "x-pi-csrf": "1", ...headers }, body: body && JSON.stringify(body) });
		return { status: response.status, body: await response.text().then((text) => text ? JSON.parse(text) : null) };
	};
	assert.equal((await api("/api/threads", "POST", {}, { origin: "https://hostile.invalid" })).status, 403);
	assert.equal((await api("/api/threads", "POST", {}, { "x-pi-csrf": "" })).status, 403);
	const browser = new WebSocket(`ws://127.0.0.1:${port}/api/threads/${id}/stream`, { headers: { cookie, origin } });
	sockets.add(browser); await once(browser, "open");
	const hostile = new WebSocket(`ws://127.0.0.1:${port}/api/threads/${id}/stream`, { headers: { cookie, origin: "https://hostile.invalid" } });
	assert.equal((await once(hostile, "close"))[0].reason, "bad token");
	await client.request("sleep");
	await until(async () => (await client.request("state")).sync === "synced", "checkpoint before restore");
	const committed = (await history(id)).revision;
	const restore = (revision = committed) => api(`/api/threads/${id}/restore`, "POST", { confirmed: true, expectedRevision: revision });
	assert.equal((await restore()).body.error, "restore_requires_missing_session_and_no_child");
	rmSync(record.sessionFile);
	assert.equal((await restore({ ...committed, counter: committed.counter + 999 })).body.error, "restore_revision_changed");
	assert.equal(existsSync(record.sessionFile), false);
	const corruptDatabase = new Database(resolve(towerDirectory, "tower.sqlite"));
	const blobRow = corruptDatabase.prepare("SELECT blob FROM managed_snapshot_index WHERE thread_id=? AND generation_id=? AND counter=?").get(id, committed.generationId, committed.counter);
	const changeBlob = corruptDatabase.prepare("UPDATE managed_snapshot_index SET blob=? WHERE thread_id=? AND generation_id=? AND counter=?");
	changeBlob.run(Buffer.from("corrupt"), id, committed.generationId, committed.counter);
	assert.equal((await restore()).body.error, "snapshot_corrupt");
	assert.equal(existsSync(record.sessionFile), false, "corrupt latest must not fall back or create a local session");
	changeBlob.run(blobRow.blob, id, committed.generationId, committed.counter);
	corruptDatabase.close();
	const restored = await restore();
	assert.equal(restored.status, 200, JSON.stringify(restored));
	assert.deepEqual(await client.request("entries"), { entries: offlineCheckpoint.entries, leafId: offlineCheckpoint.leafId });
	assert.equal((await restore()).body.error, "restore_requires_missing_session_and_no_child");
	await until(() => client.epoch, "access after restore");
	let metadata = (await api(`/api/threads/${id}`)).body;
	const updatedAt = metadata.updatedAt;
	metadata = (await api(`/api/threads/${id}`, "PATCH", { title: "Search needle 73", metadataVersion: metadata.metadataVersion })).body;
	assert.equal(metadata.updatedAt, updatedAt, "metadata edits and heartbeats do not invent run activity");
	assert.equal((await api(`/api/threads/${id}`, "PATCH", { title: "stale edit", metadataVersion: metadata.metadataVersion - 1 })).body.error, "metadata_conflict");
	assert.equal((await api("/api/threads?q=needle%2073&limit=1")).body.threads[0].threadId, id);
	metadata = (await api(`/api/threads/${id}`, "PATCH", { archived: true, metadataVersion: metadata.metadataVersion })).body;
	assert.equal((await client.request("prompt", { message: "archived" }, true)).error, "thread_archived");
	assert.equal((await api("/api/threads?archived=true")).body.threads[0].threadId, id);
	await api(`/api/threads/${id}`, "PATCH", { archived: false, metadataVersion: metadata.metadataVersion });
	assert.equal((await create(key)).status, 201, "rename must not change create idempotency identity");
	browser.close(); sockets.delete(browser);
	assert.equal((await api("/api/logout", "POST")).status, 204);
	console.log("ok managed HTTP: cookie/Origin/CSRF, missing-file latest-only restore, optimistic metadata, search and archive");
	const broken = (await create(randomUUID(), "broken fixture")).body;
	const brokenRecord = readJson(resolve(temp, "data/threads", broken.threadId, "record.json"));
	const brokenClient = await attach(broken.threadId);
	rmSync(brokenRecord.sessionFile);
	assert.match((await brokenClient.request("prompt", { message: "must not run" }, true)).error, /ENOENT/);
	assert.equal(existsSync(brokenRecord.sessionFile), false, "no silent recreation of a missing session");
	writeFileSync(brokenRecord.sessionFile, "{broken}\n");
	assert.ok((await brokenClient.request("prompt", { message: "must not run" }, true)).error);
	assert.equal(starts().length, 2, "invalid sessions must fail before child startup");
	close(brokenClient);
	const viewer = await attach(id, false);
	assert.deepEqual(viewer.epoch, client.epoch, "both devices have the same nonexclusive access");
	assert.equal((await viewer.request("prompt", { message: "missing epoch", epoch: null }, true)).error, "stale_access");
	const dialogRun = randomUUID();
	await client.request("prompt", { message: "dialog", commandId: dialogRun });
	const waiting = await until(async () => { const state = await client.request("state"); return state.state === "waiting_input" && state; }, "pending dialog");
	const replyFields = { targetRunId: dialogRun, dialogId: waiting.pendingDialogs[0].id, value: true };
	assert.deepEqual((await viewer.request("state")).pendingDialogs, waiting.pendingDialogs, "another client sees the same blocking dialog");
	await viewer.request("extension_ui_response", replyFields);
	await until(async () => (await viewer.request("state")).state === "idle", "dialog run settled");
	assert.equal((await viewer.request("entries")).entries.find((e) => e.customType === "dialog-answer").data.confirmed, true);
	assert.equal((await viewer.request("extension_ui_response", replyFields, true)).error, "stale_or_invalid_dialog");
	close(viewer);
	console.log("ok access: both clients can operate without takeover; missing epoch rejected; real pi dialog resolves once");
	const duplicate = runner();
	await once(duplicate, "exit"); processes.delete(duplicate);
	assert.notEqual(duplicate.exitCode, 0); assert.match(duplicate.log, /writer_locked/);
	let interruptedCommand = randomUUID();
	client.ws.send(JSON.stringify({ version: 1, requestId: randomUUID(), commandId: interruptedCommand, epoch: client.epoch, operation: "prompt", message: "slow" }));
	await until(async () => (await client.request("state")).state === "running", "slow run started");
	assert.equal((await client.request("prompt", { message: "competing", }, true)).error, "runtime_busy");
	close(client);
	await pause(500);
	client = await attach(id);
	assert.equal((await client.request("state")).state, "running", "no-output run must survive TTL");
	await until(async () => (await client.request("state")).state === "idle", "silent run finishes");
	interruptedCommand = randomUUID();
	await client.request("prompt", { message: "dialog", commandId: interruptedCommand });
	const crashedDialog = await until(async () => { const state = await client.request("state"); return state.state === "waiting_input" && state.pendingDialogs[0]; }, "dialog before crash");
	const count = starts().length;
	const heldChild = starts().at(-1).pid;
	process.kill(heldChild, "SIGSTOP"); // Keep the actual child alive and holding its OS-backed lock.
	await stop(r, "SIGKILL");
	const refused = runner();
	await once(refused, "exit"); processes.delete(refused);
	assert.match(refused.log, /writer_locked/);
	assert.equal(starts().length, count, "crash must never spawn a replacement writer");
	process.kill(heldChild, "SIGCONT");
	await until(() => { try { process.kill(heldChild, 0); return false; } catch (error) { return error.code === "ESRCH"; } }, "old child actually exits");
	close(client);
	r = runner();
	await until(async () => (await create(key)).status === 201, "restart after proven child exit");
	client = await attach(id);
	assert.equal((await client.request("state")).state, "interrupted");
	assert.equal((await client.request("command", { commandId: interruptedCommand })).status, "unknown");
	assert.deepEqual((await client.request("state")).pendingDialogs, []);
	assert.equal((await client.request("extension_ui_response", { targetRunId: interruptedCommand, dialogId: crashedDialog.id, value: true }, true)).error, "stale_run");
	assert.equal(starts().length, count, "reconciliation cannot replay a run or wake a child");
	await client.request("prompt", { message: "explicit continuation after crash" });
	await until(async () => (await client.request("state")).state === "idle", "explicit continuation");
	assert.equal((await client.request("state")).piSessionId, created.piSessionId);
	assert.equal(starts().length, count + 1);
	await client.request("sleep");
	await client.request("prompt", { message: "same driver after manual sleep" });
	await until(async () => (await client.request("state")).state === "idle", "manual sleep retains consistent ownership");
	assert.equal(starts().length, count + 2);
	console.log("ok managed: live orphan fences restart; after confirmed exit recover as interrupted/unknown without replay, then explicitly continue");
	close(client);
	for (const boundary of ["before_received", "received", "dispatching", "before_send", "after_send", "accepted", "settled"]) {
		await stop(r);
		r = runner("workspace", "data", boundary);
		const faultKey = randomUUID();
		const faultThread = await until(async () => { const result = await create(faultKey, boundary); return result.status === 201 && result.body; }, `fault runner ${boundary}`);
		client = await attach(faultThread.threadId);
		const commandId = randomUUID(), startCount = starts().length;
		client.ws.send(JSON.stringify({ version: 1, requestId: randomUUID(), commandId, epoch: client.epoch, operation: "prompt", message: "smoke-write" }));
		await until(() => r.signalCode || r.exitCode !== null, `injected ${boundary}`);
		assert.equal(r.signalCode, "SIGKILL", r.log);
		for (const child of starts().slice(startCount)) await until(() => {
			try { process.kill(child.pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; }
		}, `child exit after ${boundary}`);
		close(client);
		r = runner();
		await until(async () => (await create(faultKey, boundary)).status === 201, `reconcile ${boundary}`);
		client = await attach(faultThread.threadId);
		const entries = await client.request("entries");
		const started = starts().length;
		const receipt = await client.request("prompt", { commandId, message: "smoke-write" });
		assert.equal(receipt.status, boundary === "settled" ? "settled" : "unknown");
		assert.deepEqual(await client.request("entries"), entries, `${boundary}: retry appended a second prompt`);
		assert.equal(starts().length, started, `${boundary}: retry started another child`);
		assert.ok(entries.entries.filter((entry) => entry.message?.role === "user").length <= 1);
		close(client);
		console.log(`ok command SIGKILL: ${boundary}, durable status ${receipt.status}, no replay`);
	}
} catch (error) {
	for (const child of processes) console.error("runner diagnostics:", child.log);
	console.error("child starts:", starts());
	throw error;
} finally {
	for (const ws of sockets) ws.close();
	for (const child of processes) { if (child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGKILL"); await done; } }
	for (const { pid } of starts()) { try { process.kill(pid, "SIGCONT"); process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
	await pause(200);
	server?.closeAllConnections();
	await new Promise((done) => server ? server.close(done) : done());
	rmSync(temp, { recursive: true, force: true });
}
