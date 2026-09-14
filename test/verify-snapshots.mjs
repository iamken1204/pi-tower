import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createSnapshotStore } from "../managed-snapshots.mjs";

const dir = mkdtempSync(resolve(tmpdir(), "pi-snapshots-"));
const path = resolve(dir, "tower.sqlite");
const backup = resolve(dir, "backup.sqlite");
const ids = { threadId: randomUUID(), runnerInstanceId: randomUUID(), piSessionId: randomUUID() };
const generationId = randomUUID();
const entry = (id, parentId, extra = {}) => ({ type: "custom", id, parentId, ...extra });
function bytes(counter, entries, previous = null, leafId = entries.at(-1)?.id ?? null) {
	return Buffer.from(JSON.stringify({ schemaVersion: 1, ...ids, piVersion: "0.85.1", revision: { generationId, counter }, previous,
		capturedAt: new Date(counter * 1000).toISOString(), settled: true, runId: null,
		header: { type: "session", version: 3, id: ids.piSessionId, timestamp: "fixture", cwd: "/tmp/work" }, entries, leafId }));
}
const expectCode = (fn, code) => assert.throws(fn, (error) => error.code === code);
let db;
try {
	db = new Database(path); db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL");
	let store = createSnapshotStore(db, { maxSnapshotBytes: 4096, maxTotalBytes: 8192 });
	const a = entry("a", null, { unknownPayload: { kept: true } });
	const branch = entry("branch", "a");
	const firstBytes = bytes(1, [a, branch], null, "a");
	const first = store.commit(firstBytes, ids);
	assert.deepEqual(store.commit(firstBytes, ids), first, "ack-lost replay is idempotent");
	expectCode(() => store.commit(Buffer.from(firstBytes.toString().replace('"kept":true', '"kept":false')), ids), "snapshot_revision_conflict");
	const main = entry("main", "a");
	const secondBytes = bytes(2, [a, branch, main], { revision: first.revision, hash: first.hash }, "main");
	const second = store.commit(secondBytes, ids);
	assert.equal(store.latest(ids.threadId).envelope.entries[0].unknownPayload.kept, true);
	assert.deepEqual(store.commit(firstBytes, ids), first, "replay of a pruned revision remains acknowledged");
	expectCode(() => store.history(ids.threadId, first.revision), "snapshot_expired");
	assert.deepEqual(store.history(ids.threadId, second.revision, 1, 1), { revision: second.revision, hash: second.hash, leafId: "main", entries: [branch], nextCursor: 2 });
	const missingBranch = bytes(3, [a, main], { revision: second.revision, hash: second.hash }, "main");
	expectCode(() => store.commit(missingBranch, ids), "snapshot_not_append_superset");
	db.close(); db = new Database(path); store = createSnapshotStore(db, { maxSnapshotBytes: 4096, maxTotalBytes: 8192 });
	expectCode(() => store.commit(bytes(3, [a, branch, main], { revision: first.revision, hash: first.hash }), ids), "snapshot_stale_predecessor");
	expectCode(() => store.commit(Buffer.alloc(4097), ids), "snapshot_too_large");
	await store.backup(backup);
	const copy = new Database(backup, { readonly: true });
	assert.equal(copy.pragma("integrity_check", { simple: true }), "ok");
	const restored = createSnapshotStore(copy).latest(ids.threadId);
	assert.equal(restored.hash, second.hash); assert.equal(restored.envelope.leafId, "main"); copy.close();
	const thirdBytes = bytes(3, [a, branch, main, entry("later", "main")], { revision: second.revision, hash: second.hash });
	const tiny = createSnapshotStore(db, { maxSnapshotBytes: 4096, maxTotalBytes: thirdBytes.length - 1 });
	expectCode(() => tiny.commit(thirdBytes, ids), "snapshot_total_quota_exceeded");
	assert.equal(store.latest(ids.threadId).hash, second.hash);
	const exact = createSnapshotStore(db, { maxSnapshotBytes: thirdBytes.length, maxTotalBytes: thirdBytes.length });
	exact.commit(thirdBytes, ids);
	assert.equal(exact.usage().blobBytes, thirdBytes.length, "replacement fits at the quota after atomic pruning");
	for (const [edit, code] of [
		[(value) => { value.leafId = "absent"; }, "invalid_leaf"],
		[(value) => { value.entries[1].parentId = "absent"; }, "invalid_parent"],
		[(value) => { value.entries[1].id = "a"; }, "invalid_entry_id"],
		[(value) => { value.schemaVersion = 2; }, "unsupported_snapshot"],
		[(value) => { value.header.version = 2; }, "unsupported_session"],
	]) {
		const value = JSON.parse(thirdBytes); edit(value);
		expectCode(() => store.commit(Buffer.from(JSON.stringify(value)), ids), code);
	}
	expectCode(() => store.commit(Buffer.from([0xff]), ids), "invalid_snapshot_json");
	db.prepare("UPDATE managed_snapshot_index SET blob=? WHERE thread_id=? AND counter=3").run(Buffer.from("corrupt"), ids.threadId);
	expectCode(() => store.latest(ids.threadId), "snapshot_corrupt");
	expectCode(() => store.history(ids.threadId), "snapshot_corrupt");
	console.log("ok snapshots: validation, append branches, replay, restart, quotas, expiry and WAL backup");
} finally {
	db?.close(); rmSync(dir, { recursive: true, force: true });
}
