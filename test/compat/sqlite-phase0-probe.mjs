import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = process.env.SQLITE_PROBE_FIXTURE;
if (!fixture) throw new Error("SQLITE_PROBE_FIXTURE must point to the isolated npm fixture");
const require = createRequire(`${fixture}/package.json`);
const Database = require("better-sqlite3");
const worker = fileURLToPath(new URL("./sqlite-phase0-worker.mjs", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "pi-tower-sqlite-"));
const database = path.join(directory, "tower.sqlite");
const backup = path.join(directory, "tower.backup.sqlite");
let holder;

function runWorker(mode, ipc = false) {
	return spawn(process.execPath, [worker, mode, database, fixture], {
		stdio: ipc ? ["ignore", "inherit", "inherit", "ipc"] : "inherit",
	});
}

function exited(child) {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

function latest(db) {
	return db.prepare(`
		SELECT t.latest_revision, t.latest_hash, s.body,
		       EXISTS(SELECT 1 FROM snapshot_index i WHERE i.thread_id=t.id AND i.revision=t.latest_revision AND i.hash=t.latest_hash) AS has_index
		FROM threads t JOIN snapshots s
		  ON s.thread_id=t.id AND s.revision=t.latest_revision AND s.hash=t.latest_hash
		WHERE t.id='thread-1'
	`).get();
}

try {
	let db = new Database(database);
	assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
	db.pragma("synchronous = FULL");
	db.pragma("busy_timeout = 1250");
	db.pragma("wal_autocheckpoint = 0");
	assert.equal(db.pragma("synchronous", { simple: true }), 2);
	assert.equal(db.pragma("busy_timeout", { simple: true }), 1250);
	db.exec(`
		CREATE TABLE threads(id TEXT PRIMARY KEY, latest_revision INTEGER, latest_hash TEXT);
		CREATE TABLE snapshots(thread_id TEXT, revision INTEGER, hash TEXT, body BLOB NOT NULL,
			PRIMARY KEY(thread_id, revision), UNIQUE(thread_id, hash));
		CREATE TABLE snapshot_index(thread_id TEXT, revision INTEGER, hash TEXT,
			PRIMARY KEY(thread_id, revision), UNIQUE(thread_id, hash));
		CREATE TABLE receipts(id TEXT PRIMARY KEY, result TEXT NOT NULL);
		INSERT INTO threads VALUES ('thread-1', 1, 'hash-1');
		INSERT INTO snapshots VALUES ('thread-1', 1, 'hash-1', X'736E617073686F742D31');
		INSERT INTO snapshot_index VALUES ('thread-1', 1, 'hash-1');
		INSERT INTO receipts VALUES ('receipt-1', 'accepted');
	`);
	db.close();

	assert.equal((await exited(runWorker("crash-before-commit"))).code, 91);
	db = new Database(database, { readonly: true });
	let row = latest(db);
	assert.deepEqual([row.latest_revision, row.latest_hash, row.body.toString(), row.has_index], [1, "hash-1", "snapshot-1", 1]);
	assert.equal(db.prepare("SELECT count(*) n FROM snapshots WHERE revision=2").get().n, 0);
	db.close();

	assert.equal((await exited(runWorker("crash-after-commit"))).code, 91);
	db = new Database(database);
	db.pragma("busy_timeout = 1250");
	row = latest(db);
	assert.deepEqual([row.latest_revision, row.latest_hash, row.body.toString(), row.has_index], [3, "hash-3", "snapshot-3", 1]);

	holder = runWorker("hold-lock", true);
	await new Promise((resolve, reject) => {
		holder.once("message", resolve);
		holder.once("error", reject);
	});
	const started = performance.now();
	assert.throws(() => db.prepare("INSERT INTO receipts VALUES ('blocked', 'no')").run(), /database is locked/);
	const waited = performance.now() - started;
	assert.ok(waited >= 1_000 && waited < 3_500, `busy timeout was ${waited.toFixed(0)}ms`);
	const holderExit = exited(holder);
	holder.kill("SIGTERM");
	await holderExit;
	holder = undefined;

	// Keep committed rows in WAL and use SQLite's online backup API, never a main-file copy.
	db.pragma("wal_autocheckpoint = 0");
	db.exec("INSERT INTO receipts VALUES ('wal-only', 'settled')");
	assert.ok((await stat(`${database}-wal`)).size > 32);
	const incomplete = path.join(directory, "main-only.sqlite");
	await copyFile(database, incomplete);
	const mainOnly = new Database(incomplete, { readonly: true });
	assert.equal(mainOnly.prepare("SELECT count(*) n FROM receipts WHERE id='wal-only'").get().n, 0);
	mainOnly.close();
	await db.backup(backup);
	db.close();
	const restored = new Database(backup, { readonly: true });
	assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
	row = latest(restored);
	assert.deepEqual([row.latest_revision, row.latest_hash, row.body.toString(), row.has_index], [3, "hash-3", "snapshot-3", 1]);
	assert.deepEqual(restored.prepare("SELECT * FROM receipts ORDER BY id").all(), [
		{ id: "receipt-1", result: "accepted" }, { id: "wal-only", result: "settled" },
	]);
	restored.close();

	const versionDb = new Database(database, { readonly: true });
	const sqliteVersion = versionDb.prepare("select sqlite_version() version").get().version;
	versionDb.close();
	console.log(JSON.stringify({
		result: "PASS",
		node: process.version,
		driver: require("better-sqlite3/package.json").version,
		sqlite: sqliteVersion,
		busyTimeoutMs: 1250,
		observedBusyWaitMs: Math.round(waited),
	}));
} finally {
	if (holder && holder.exitCode === null && holder.signalCode === null) {
		const holderExit = exited(holder);
		holder.kill("SIGTERM");
		await holderExit;
	}
	await rm(directory, { recursive: true, force: true });
}
