// Deterministic protocol-boundary fakes; no pi or external provider.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createManagedTower } from "../managed-tower.mjs";

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
let tower;
function open(options = {}) {
	tower = createManagedTower(dir, { maxSnapshotBytes: 2048, maxTotalBytes: 4096, minFreeBytes: 1, maxUploads: 1, maxViewerBuffer: 1024, ...options });
	const db = new Database(resolve(dir, "tower.sqlite"));
	db.prepare(`INSERT OR IGNORE INTO threads(threadId,createKey,runnerId,runnerInstanceId,title,createdAt,workspaceId,piSessionId,updatedAt,createTitle)
		VALUES (?,?,?,?,?,?,?,?,?,?)`).run(threadId, randomUUID(), "fixture", instanceId, "limits", "2026-09-14", workspaceId, sessionId, "2026-09-14", "limits");
	db.close();
	const runner = new Socket();
	tower.routes["/managed/runner"](runner, new URLSearchParams({ id: "fixture", instance: instanceId, boot: randomUUID() }));
	const connectionId = runner.frames[0].connectionId;
	runner.message({ type: "inventory", piVersion: "0.85.1", threads: [{ threadId, piSessionId: sessionId, workspaceId, state: "sleeping" }] });
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
	let headers = open();
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
	tower.close();
	headers = open({ minFreeBytes: Number.MAX_SAFE_INTEGER });
	const low = call(path, "PUT", headers, "{}"); await low.done;
	assert.equal(low.res.body.error, "disk_space_low");
	const after = call("/api/managed/usage", "GET", {}, null); await after.done;
	assert.equal(after.res.body.uploads, 0, "disk rejection cannot leak an upload slot");
	assert.equal(after.res.body.blobBytes, 0);
	console.log("ok managed limits (fake transport): concurrent uploads, oversize, disk threshold, usage, connection fencing and bounded viewer");
} finally { tower?.close(); rmSync(dir, { recursive: true, force: true }); }
