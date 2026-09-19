// Opt-in: requires a running Docker engine. Uses only uniquely named disposable resources.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const name = `pi-tower-test-${randomUUID()}`;
const image = `${name}:local`;
const volumes = [`${name}-data`, `${name}-restored`];
const temp = realpathSync(mkdtempSync(resolve(tmpdir(), "pi-docker-")));
const token = "disposable-docker-test";
const docker = (...args) => execFileSync("docker", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const pkg = process.env.PI_COMPAT_PACKAGE || resolve(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
let runner, client, port;
async function until(fn, description) {
	for (let i = 0; i < 300; i++) {
		const result = await fn(); if (result) return result;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`timeout: ${description}`);
}
const api = async (path, body) => {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? "POST" : "GET",
		headers: { authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
	return { status: response.status, body: await response.json() };
};
async function start(volume) {
	docker("run", "-d", "--name", name, "-p", `127.0.0.1:${port ?? ""}:9000`, "-v", `${volume}:/data`,
		"-e", `PI_TOWER_TOKEN=${token}`, "-e", "PI_TOWER_DATA_DIR=/data", image);
	port ??= Number(docker("port", name, "9000/tcp").split(":").at(-1));
	await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { return false; } }, "container health");
}
async function attach(id) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/managed/client?thread=${id}`, { headers: { authorization: `Bearer ${token}` } });
	client = ws;
	const frames = []; let epoch;
	ws.on("message", (data) => { const frame = JSON.parse(data); frames.push(frame); if (frame.type === "access_changed") epoch = frame.epoch; });
	await once(ws, "open");
	const request = async (operation, fields = {}) => {
		const requestId = randomUUID();
		ws.send(JSON.stringify({ version: 1, requestId, commandId: randomUUID(), operation, epoch, ...fields }));
		const reply = await until(() => frames.find((frame) => frame.requestId === requestId), operation);
		assert.equal(reply.error, undefined, JSON.stringify(reply)); return reply.result;
	};
	await until(() => epoch, "automatic access"); return request;
}
try {
	docker("info");
	docker("build", "-t", image, ".");
	for (const volume of volumes) docker("volume", "create", volume);
	await start(volumes[0]);
	assert.equal(docker("exec", name, "id", "-u"), "1000");
	assert.equal(docker("exec", name, "bun", "--version"), "1.4.2");
	assert.ok((await fetch(`http://127.0.0.1:${port}/threads`)).ok);
	for (const dir of ["home", "agent/extensions", "workspace", "runner", "backup"]) mkdirSync(resolve(temp, dir), { recursive: true });
	cpSync(resolve(root, "test/compat/managed-extension.mjs"), resolve(temp, "agent/extensions/fixture.js"));
	writeFileSync(resolve(temp, "agent/settings.json"), JSON.stringify({ defaultProvider: "phase1", defaultModel: "faux-1", compaction: { enabled: false } }));
	runner = spawn(process.execPath, [resolve(root, "src/runner.mjs"), "--hq", `ws://127.0.0.1:${port}`, "--id", name, "--token", token,
		"--managed-threads", "--data-dir", resolve(temp, "runner"), "--pi-package", pkg], {
		cwd: resolve(temp, "workspace"), stdio: ["ignore", "ignore", "inherit"],
		env: { PATH: process.env.PATH, HOME: resolve(temp, "home"), PI_CODING_AGENT_DIR: resolve(temp, "agent"), PI_OFFLINE: "1", PI_COMPAT_PACKAGE: pkg, MANAGED_TEST_LOG: resolve(temp, "children.jsonl") },
	});
	const key = randomUUID();
	const created = await until(async () => { const response = await api("/api/threads", { idempotencyKey: key, runnerId: name, title: "Docker continuity" }); return response.status === 201 && response.body; }, "runner registration");
	let request = await attach(created.threadId);
	const commandId = randomUUID();
	await request("prompt", { message: "smoke-write", commandId });
	await until(async () => { const state = await request("state"); return state.state === "idle" && state.sync === "synced"; }, "committed tool result");
	const before = (await api(`/api/threads/${created.threadId}/history`)).body;
	assert.ok(JSON.stringify(before.entries).includes("cloud-threads-smoke-73"));
	client.close();
	docker("stop", name); docker("rm", name);
	// Follow the documented stopped-Tower archive procedure, then restore to an empty volume.
	docker("run", "--rm", "--user", "0", "-v", `${volumes[0]}:/data`, "-v", `${temp}/backup:/backup`, image,
		"sh", "-c", "tar -C /data -czf /backup/data.tgz .");
	docker("run", "--rm", "--user", "0", "-v", `${volumes[1]}:/data`, "-v", `${temp}/backup:/backup`, image,
		"sh", "-c", "tar -C /data -xzf /backup/data.tgz");
	const inspect = `import assert from 'node:assert/strict'; import {openDatabase,pragma} from './src/managed/sqlite.mjs'; import {createSnapshotStore} from './src/managed/snapshots.mjs';
		const db=openDatabase('/data/tower.sqlite',{readonly:true}); assert.equal(pragma(db,'integrity_check'),'ok');
		const snapshot=createSnapshotStore(db).latest('${created.threadId}');
		assert.equal(snapshot.hash,'${before.hash}'); assert.equal(snapshot.envelope.leafId,${JSON.stringify(before.leafId)});
		assert.equal(db.prepare('SELECT title FROM threads WHERE threadId=?').get('${created.threadId}').title,'Docker continuity');
		assert.equal(JSON.parse(db.prepare('SELECT receipt FROM managed_commands WHERE commandId=?').get('${commandId}').receipt).status,'settled'); db.close();`;
	docker("run", "--rm", "-v", `${volumes[1]}:/data`, image, "bun", "-e", inspect);
	// Rebuild and replace the container, with the original runner and restored volume.
	docker("build", "-t", image, ".");
	await start(volumes[1]);
	assert.deepEqual((await api(`/api/threads/${created.threadId}/history`)).body, before);
	await until(async () => (await api(`/api/threads/${created.threadId}`)).body.online, "runner reconnect");
	request = await attach(created.threadId);
	assert.equal((await request("prompt", { message: "smoke-write", commandId })).status, "settled");
	await request("prompt", { message: "smoke-check" });
	await until(async () => { const state = await request("state"); return state.state === "idle" && state.sync === "synced"; }, "continued snapshot");
	const after = (await api(`/api/threads/${created.threadId}/history`)).body;
	assert.deepEqual(after.entries.slice(0, before.entries.length), before.entries);
	const results = after.entries.slice(before.entries.length).filter((entry) => entry.message?.role === "toolResult");
	assert.ok(JSON.stringify(results).includes("cloud-threads-smoke-73"));
	assert.ok(JSON.stringify(results).includes(resolve(temp, "workspace")));
	console.log("ok Docker: Bun Alpine/non-root image, full SQLite archive restored to new volume, hash/leaf/catalog/receipt intact, rebuild/reconnect and real pi bash continuation in original cwd");
} finally {
	client?.close();
	if (runner && runner.exitCode === null && runner.signalCode === null) { const exited = once(runner, "exit"); runner.kill("SIGTERM"); await exited; }
	for (const args of [["rm", "-f", name], ...volumes.map((volume) => ["volume", "rm", volume]), ["image", "rm", image]]) {
		try { docker(...args); } catch { /* A failed build/start may not have created this resource. */ }
	}
	rmSync(temp, { recursive: true, force: true });
}
