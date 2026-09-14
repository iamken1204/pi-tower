import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { createSnapshotStore } from "../managed-snapshots.mjs";

const ids = {
	threadId: "10000000-0000-4000-8000-000000000001",
	runnerInstanceId: "10000000-0000-4000-8000-000000000002",
	piSessionId: "10000000-0000-4000-8000-000000000003",
};
const generationId = "10000000-0000-4000-8000-000000000004";
const entry = (id, parentId, payload) => ({ type: "custom", id, parentId, ...(payload === undefined ? {} : { payload }) });
const oldEntries = [entry("root", null, { immutable: true }), entry("old-leaf", "root")];

function snapshot(counter, entries, previous = null) {
	return Buffer.from(JSON.stringify({
		schemaVersion: 1, ...ids, piVersion: "0.85.1", revision: { generationId, counter }, previous,
		capturedAt: new Date(counter * 1000).toISOString(), settled: true, runId: null,
		header: { type: "session", version: 3, id: ids.piSessionId, timestamp: "fixture", cwd: "/disposable" },
		entries, leafId: entries.at(-1).id,
	}));
}

const firstBytes = snapshot(1, oldEntries);
const firstHash = createHash("sha256").update(firstBytes).digest("hex");
const firstReceipt = { revision: { generationId, counter: 1 }, hash: firstHash };
const newEntries = [...oldEntries, entry("new-leaf", "old-leaf", { committed: true })];
const secondBytes = snapshot(2, newEntries, firstReceipt);
const secondHash = createHash("sha256").update(secondBytes).digest("hex");

function open(path) {
	const db = new Database(path);
	db.pragma("journal_mode=WAL");
	db.pragma("synchronous=FULL");
	db.pragma("wal_autocheckpoint=0");
	return db;
}

function installCrashTrigger(db, boundary) {
	db.function("crash_at_snapshot_boundary", () => process.kill(process.pid, "SIGKILL"));
	const trigger = {
		before_blob_insert: "BEFORE INSERT ON managed_snapshot_index WHEN NEW.counter=2",
		after_blob_insert: "AFTER INSERT ON managed_snapshot_index WHEN NEW.counter=2",
		before_latest_update: "BEFORE UPDATE ON managed_snapshot_latest WHEN NEW.counter=2",
		after_latest_update: "AFTER UPDATE ON managed_snapshot_latest WHEN NEW.counter=2",
		before_prune: "BEFORE UPDATE OF blob ON managed_snapshot_index WHEN OLD.counter=1 AND NEW.blob IS NULL",
		after_prune: "AFTER UPDATE OF blob ON managed_snapshot_index WHEN OLD.counter=1 AND NEW.blob IS NULL",
	}[boundary];
	assert.ok(trigger, `unknown crash boundary: ${boundary}`);
	db.exec(`CREATE TEMP TRIGGER injected_crash ${trigger} BEGIN SELECT crash_at_snapshot_boundary(); END`);
}

if (process.argv[2] === "--worker") {
	const [, , , path, boundary] = process.argv;
	const db = open(path);
	const store = createSnapshotStore(db, { maxSnapshotBytes: 8192, maxTotalBytes: 16384 });
	if (boundary !== "after_commit_before_ack") installCrashTrigger(db, boundary);
	store.commit(secondBytes, ids);
	if (boundary === "after_commit_before_ack") process.kill(process.pid, "SIGKILL");
	throw new Error(`fault injection did not fire: ${boundary}`);
}

if (process.argv[2] === "--hold") {
	const db = open(process.argv[3]);
	db.exec("BEGIN IMMEDIATE");
	process.send("locked");
	process.on("message", () => { db.close(); process.exit(0); });
	await new Promise(() => {});
}

function initialize(path) {
	const db = open(path);
	const receipt = createSnapshotStore(db, { maxSnapshotBytes: 8192, maxTotalBytes: 16384 }).commit(firstBytes, ids);
	assert.deepEqual(receipt, firstReceipt);
	db.close();
}

function verifyRestart(path, expectNew) {
	const db = open(path);
	try {
		assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
		const dangling = db.prepare(`SELECT COUNT(*) count FROM managed_snapshot_latest l LEFT JOIN managed_snapshot_index i
			ON i.thread_id=l.thread_id AND i.generation_id=l.generation_id AND i.counter=l.counter WHERE i.thread_id IS NULL`).get().count;
		assert.equal(dangling, 0, "latest pointer must always reference an index row");
		const rows = db.prepare("SELECT counter,hash,byte_length,captured_at,leaf_id,blob FROM managed_snapshot_index ORDER BY counter").all();
		assert.equal(rows.length, expectNew ? 2 : 1, "transactions must expose no partial index row");
		const latest = createSnapshotStore(db).latest(ids.threadId);
		const expectedBytes = expectNew ? secondBytes : firstBytes;
		assert.equal(latest.hash, expectNew ? secondHash : firstHash);
		assert.equal(latest.envelope.leafId, expectNew ? "new-leaf" : "old-leaf");
		assert.deepEqual(latest.envelope.entries.slice(0, oldEntries.length), oldEntries, "prior entries changed");
		assert.deepEqual(latest.bytes, expectedBytes, "restart exposed an incomplete snapshot");
		assert.equal(rows.at(-1).hash, latest.hash, "pointer metadata and BLOB hash disagree");
		assert.equal(rows.at(-1).byte_length, expectedBytes.length);
		assert.equal(rows.at(-1).leaf_id, latest.envelope.leafId);
		if (expectNew) assert.equal(rows[0].blob, null, "superseded BLOB was not pruned atomically");
		else assert.deepEqual(rows[0].blob, firstBytes, "old BLOB changed during rolled-back commit");
		return { db, latest };
	} catch (error) {
		db.close();
		throw error;
	}
}

const root = mkdtempSync(resolve(tmpdir(), "pi-snapshot-crash-"));
const transactionBoundaries = ["before_blob_insert", "after_blob_insert", "before_latest_update", "after_latest_update", "before_prune", "after_prune"];
const backupPath = resolve(root, "restored", "tower.sqlite");
try {
	for (const boundary of [...transactionBoundaries, "after_commit_before_ack"]) {
		const path = resolve(root, boundary, "tower.sqlite");
		mkdirSync(dirname(path), { recursive: true });
		initialize(path);
		const child = spawnSync(process.execPath, [import.meta.filename, "--worker", path, boundary], { encoding: "utf8" });
		assert.equal(child.signal, "SIGKILL", `${boundary} did not terminate at the injected boundary: ${child.stderr}`);
		const expectNew = boundary === "after_commit_before_ack";
		if (expectNew) assert.ok(existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0, "committed state was not present in WAL");
		const { db, latest } = verifyRestart(path, expectNew);
		try {
			if (expectNew) {
				const store = createSnapshotStore(db);
				assert.deepEqual(store.commit(secondBytes, ids), { revision: { generationId, counter: 2 }, hash: secondHash });
				assert.equal(db.prepare("SELECT blob IS NULL pruned FROM managed_snapshot_index WHERE counter=1").get().pruned, 1, "ack-lost replay resurrected a pruned BLOB");
				const conflict = Buffer.from(secondBytes.toString().replace('"committed":true', '"committed":false'));
				assert.throws(() => store.commit(conflict, ids), (error) => error.code === "snapshot_revision_conflict");
				assert.equal(latest.hash, secondHash);
				mkdirSync(dirname(backupPath), { recursive: true });
				await store.backup(backupPath);
			}
		} finally { db.close(); }
	}

	const restored = verifyRestart(backupPath, true);
	assert.equal(restored.latest.hash, secondHash);
	assert.equal(restored.latest.envelope.leafId, "new-leaf");
	restored.db.close();
	// SQLite itself returns FULL without filling the host's disk. The prior transaction survives.
	const fullPath = resolve(root, "full.sqlite");
	initialize(fullPath);
	const full = open(fullPath);
	try {
		const store = createSnapshotStore(full, { maxSnapshotBytes: 2 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 });
		const large = snapshot(2, [...oldEntries, entry("large", "old-leaf", "x".repeat(1024 * 1024))], firstReceipt);
		full.pragma(`max_page_count=${full.pragma("page_count", { simple: true }) + 1}`);
		assert.throws(() => store.commit(large, ids), (error) => error.code === "SQLITE_FULL");
		assert.equal(store.latest(ids.threadId).hash, firstHash);
		assert.equal(full.pragma("integrity_check", { simple: true }), "ok");
		full.pragma("max_page_count=2147483646");
		const lock = spawn(process.execPath, [import.meta.filename, "--hold", fullPath], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
		await once(lock, "message");
		try {
			full.pragma("busy_timeout=1250");
			const started = performance.now();
			assert.throws(() => store.commit(large, ids), (error) => error.code === "SQLITE_BUSY");
			const elapsed = performance.now() - started;
			assert.ok(elapsed < 5000, `busy wait exceeded its bounded timeout: ${elapsed}`);
			assert.equal(store.latest(ids.threadId).hash, firstHash);
		} finally { const exited = once(lock, "exit"); lock.send("release"); await exited; }
		const started = performance.now();
		store.commit(large, ids);
		assert.deepEqual(store.latest(ids.threadId).bytes, large);
		console.log(`snapshot capacity: 1 MiB payload commit/read ${(performance.now() - started).toFixed(1)}ms; DB ${statSync(fullPath).size} bytes; WAL ${statSync(`${fullPath}-wal`).size} bytes`);
	} finally { full.close(); }
	console.log("ok snapshot crash: 6 in-transaction SIGKILL boundaries, post-commit ack loss/replay, pruning, and committed-WAL backup restore");
} finally {
	rmSync(root, { recursive: true, force: true });
}
