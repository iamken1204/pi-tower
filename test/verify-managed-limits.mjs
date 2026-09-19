// Deterministic protocol-boundary fakes; no pi or external provider.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createManagedTower } from "../src/managed/tower.mjs";

class Socket extends EventEmitter {
	readyState = 1;
	bufferedAmount = 0;
	frames = [];
	send(bytes) { this.frames.push(JSON.parse(bytes)); }
	close(code, reason) { this.closed = { code, reason }; this.readyState = 3; }
	terminate() { this.close(1006, "terminated"); }
	message(value) { this.emit("message", Buffer.from(JSON.stringify({ version: 1, ...value }))); }
}
const dir = mkdtempSync(resolve(tmpdir(), "pi-managed-limits-"));
const threadId = randomUUID(), instanceId = randomUUID(), sessionId = randomUUID(), workspaceId = randomUUID();
let tower, fixtureRunner;
function open(options = {}) {
	tower = createManagedTower(dir, { maxSnapshotBytes: 2048, maxTotalBytes: 4096, minFreeBytes: 1, maxUploads: 1, maxViewerBuffer: 1024, ...options });
	const db = new Database(resolve(dir, "tower.sqlite"));
	db.prepare(`INSERT OR IGNORE INTO threads(threadId,createKey,runnerId,runnerInstanceId,title,createdAt,workspaceId,piSessionId,updatedAt,createTitle)
		VALUES (?,?,?,?,?,?,?,?,?,?)`).run(threadId, randomUUID(), "fixture", instanceId, "limits", "2026-09-14", workspaceId, sessionId, "2026-09-14", "limits");
	db.close();
	const runner = new Socket(); fixtureRunner = runner;
	tower.routes["/managed/runner"](runner, new URLSearchParams({ id: "fixture", instance: instanceId, boot: randomUUID() }));
	const connectionId = runner.frames[0].connectionId;
	runner.message({ type: "inventory", piVersion: "0.85.1", cwd: "/fixture", threads: [{ threadId, piSessionId: sessionId, workspaceId, cwd: "/fixture", state: "sleeping" }] });
	runner.message({ type: "reconciled", connectionId });
	assert.equal(runner.frames.at(-1).type, "inventory_confirmed");
	return { "x-runner-instance": instanceId, "x-runner-connection": connectionId };
}
function call(path, method, headers, body, unfinished = false) {
	const req = new PassThrough(); req.method = method; req.headers = headers;
	const res = { status: 200, setHeader() {}, writeHead(status) { this.status = status; return this; }, end(bytes) { this.body = bytes ? JSON.parse(bytes) : null; } };
	const done = tower.http(req, res, new URL(path, "http://fixture"));
	if (unfinished) req.write(body); else req.end(body);
	return { req, res, done };
}
try {
	let presenceChanges = 0;
	let headers = open({ onPresence: () => presenceChanges++ });
	assert.equal(presenceChanges, 1, "ready announces presence");
	const path = `/api/managed/snapshots/${threadId}`;
	const blocked = call(path, "PUT", headers, " ", true);
	const competing = call(path, "PUT", headers, "{}"); await competing.done;
	assert.equal(competing.res.body.error, "upload_limit");
	const usage = call("/api/managed/usage", "GET", {}, null); await usage.done;
	assert.equal(usage.res.body.uploads, 1);
	assert.ok(usage.res.body.databaseBytes > 0 && usage.res.body.walBytes > 0 && usage.res.body.freeBytes > 0);
	blocked.req.end("{}"); await blocked.done;
	assert.equal(blocked.res.body.error, "invalid_snapshot_schema");
	const oversized = call(path, "PUT", headers, Buffer.alloc(2049)); await oversized.done;
	assert.equal(oversized.res.body.error, "snapshot_too_large");
	const stale = call(path, "PUT", { ...headers, "x-runner-connection": randomUUID() }, "{}"); await stale.done;
	assert.equal(stale.res.body.error, "stale_snapshot_connection");
	const slow = new Socket(); slow.bufferedAmount = 1025;
	tower.routes["/managed/client"](slow, new URLSearchParams({ thread: threadId }));
	assert.deepEqual(slow.closed, { code: 1009, reason: "resync_required" });
	assert.equal(slow.frames.length, 0, "a slow viewer must not accumulate another event");
	const normal = new Socket(); normal.bufferedAmount = 1024;
	tower.routes["/managed/client"](normal, new URLSearchParams({ thread: threadId }));
	assert.equal(normal.frames[0].type, "state");
	const catalog = new Database(resolve(dir, "tower.sqlite"));
	const expected = [];
	for (let i = 0; i < 23; i++) {
		const id = randomUUID(), archived = i % 5 === 0;
		catalog.prepare("INSERT INTO threads(threadId,createKey,runnerId,runnerInstanceId,title,createTitle,createdAt,updatedAt,archivedAt) VALUES(?,?,?,?,?,?,?,?,?)")
			.run(id, randomUUID(), "fixture", instanceId, "pagination", "pagination", "2026-09-15", "2026-09-15", archived ? "2026-09-15" : null);
		if (!archived) expected.push(id);
	}
	catalog.close();
	const found = [];
	let cursor = null;
	do {
		const page = call(`/api/threads?q=pagination&runner=fixture&limit=7${cursor ? `&cursor=${cursor}` : ""}`, "GET", {}, null); await page.done;
		assert.equal(page.res.status, 200);
		found.push(...page.res.body.threads.map((row) => row.threadId));
		cursor = page.res.body.nextCursor;
	} while (cursor);
	assert.deepEqual(found, expected.sort().reverse(), "tied timestamps paginate without duplicate or omitted threads and exclude archives");
	const archivedPage = call("/api/threads?q=pagination&archived=true", "GET", {}, null); await archivedPage.done;
	assert.equal(archivedPage.res.body.threads.length, 5);
	console.log("ok catalog: filtered keyset pagination across tied timestamps and archived rows");
	const active = async () => { const page = call("/api/threads?active=true", "GET", {}, null); await page.done; return page.res.body.threads.map((row) => row.threadId); };
	assert.deepEqual(tower.presence().map((runner) => runner.sessions), [[]], "a sleeping thread is not a session");
	assert.deepEqual(await active(), []);
	fixtureRunner.message({ type: "runtime_state", threadId, state: "idle", sync: "synced" });
	assert.equal(presenceChanges, 2, "waking announces presence");
	assert.deepEqual(tower.presence()[0].sessions, [{ name: "limits", threadId, state: "idle", managed: true }]);
	assert.deepEqual(await active(), [threadId], "catalog rows without a live runtime are inactive");
	fixtureRunner.message({ type: "runtime_state", threadId, state: "starting", sync: "synced" });
	assert.equal(tower.presence()[0].sessions[0].state, "opening");
	fixtureRunner.message({ type: "runtime_state", threadId, state: "sleeping", sync: "synced" });
	assert.equal(presenceChanges, 4);
	assert.deepEqual(tower.presence()[0].sessions, []);
	assert.deepEqual(await active(), []);
	fixtureRunner.message({ type: "runtime_state", threadId, state: "sleeping", sync: "pending" });
	assert.equal(presenceChanges, 4, "same state does not rebroadcast");
	console.log("ok active threads: presence sessions, state transitions and active list filter");
	tower.close();
	headers = open({ minFreeBytes: Number.MAX_SAFE_INTEGER });
	const low = call(path, "PUT", headers, "{}"); await low.done;
	assert.equal(low.res.body.error, "disk_space_low");
	const after = call("/api/managed/usage", "GET", {}, null); await after.done;
	assert.equal(after.res.body.uploads, 0, "disk rejection cannot leak an upload slot");
	assert.equal(after.res.body.blobBytes, 0);
	console.log("ok managed limits (fake transport): concurrent uploads, oversize, disk threshold, usage, connection fencing and bounded viewer");
} finally { tower?.close(); rmSync(dir, { recursive: true, force: true }); }
