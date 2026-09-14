import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
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
const processes = new Set();
const sockets = new Set();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, description, ms = 15000) {
	const end = Date.now() + ms;
	while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(25); }
	throw new Error(`timeout: ${description}`);
}
async function tower() {
	server = createTower({ token, dataDir: resolve(temp, "tower"), idleTtlMs: 0 });
	server.listen(port ?? 0, "127.0.0.1"); await once(server, "listening"); port = server.address().port;
}
function runner(cwd = "workspace", data = "data") {
	const child = spawn(process.execPath, [resolve(root, "runner.mjs"), "--hq", `ws://127.0.0.1:${port}`, "--id", "managed-test", "--token", token,
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
async function attach(threadId) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/managed/client?thread=${threadId}`, { headers: { authorization: `Bearer ${token}` } });
	sockets.add(ws);
	const frames = [];
	ws.onmessage = ({ data }) => frames.push(JSON.parse(data));
	await once(ws, "open");
	return { ws, frames, async request(operation, fields = {}, allowError = false) {
		const requestId = randomUUID();
		ws.send(JSON.stringify({ version: 1, requestId, operation, ...fields }));
		const reply = await until(() => frames.find((f) => f.requestId === requestId), operation, 25000);
		if (!allowError) assert.equal(reply.error, undefined, JSON.stringify({ reply, starts: starts() }));
		return reply.error ? reply : reply.result;
	} };
}
function close(client) { client.ws.close(); sockets.delete(client.ws); }
const starts = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];

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
	assert.equal((await fetch(`http://127.0.0.1:${port}/api/threads`)).status, 401);
	let client = await attach(id);
	assert.deepEqual(await client.request("entries"), { entries: [], leafId: null });
	assert.equal(starts().length, 0, "reading must not spawn pi");
	close(client);
	await stop(r);
	r = runner("other"); // Existing thread must retain workspace, not follow new runner cwd.
	await until(async () => (await create(key)).status === 201, "restart registration");
	client = await attach(id);
	assert.equal((await client.request("state")).piSessionId, created.piSessionId);
	await client.request("prompt", { message: "first" });
	await until(async () => (await client.request("state")).state === "idle", "settled");
	const before = await client.request("entries");
	assert.equal(before.entries.filter((e) => e.message?.role === "assistant").length, 1);
	assert.equal(before.entries.find((e) => e.customType === "phase1-cwd").data.cwd, resolve(temp, "workspace"));
	assert.equal(starts().length, 1);
	assert.equal((await client.request("switch_session", {}, true)).error, "invalid_command");
	assert.equal((await client.request("prompt", { message: "/new" }, true)).error, "invalid_command");
	close(client);
	await pause(700);
	client = await attach(id);
	await until(async () => (await client.request("state")).state === "sleeping", "TTL sleep");
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
	const duplicate = runner();
	await once(duplicate, "exit"); processes.delete(duplicate);
	assert.notEqual(duplicate.exitCode, 0); assert.match(duplicate.log, /writer_locked/);
	client.ws.send(JSON.stringify({ version: 1, requestId: randomUUID(), operation: "prompt", message: "slow" }));
	await until(async () => (await client.request("state")).state === "running", "slow run started");
	assert.equal((await client.request("prompt", { message: "competing", }, true)).error, "runtime_busy");
	close(client);
	await pause(500);
	client = await attach(id);
	assert.equal((await client.request("state")).state, "running", "no-output run must survive TTL");
	const count = starts().length;
	await stop(r, "SIGKILL");
	const refused = runner();
	await once(refused, "exit"); processes.delete(refused);
	assert.match(refused.log, /writer_locked/);
	assert.equal(starts().length, count, "crash must never spawn a replacement writer");
	console.log("ok managed: duplicate wrappers and post-SIGKILL restart fail closed; busy run survives detach/TTL");
} finally {
	for (const ws of sockets) ws.close();
	for (const child of processes) { if (child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGKILL"); await done; } }
	for (const { pid } of starts()) { try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
	await pause(200);
	server?.closeAllConnections();
	await new Promise((done) => server ? server.close(done) : done());
	rmSync(temp, { recursive: true, force: true });
}
