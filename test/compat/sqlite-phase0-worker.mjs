import { createRequire } from "node:module";

const [mode, database, fixture] = process.argv.slice(2);
if (!mode || !database || !fixture) throw new Error("usage: worker MODE DATABASE FIXTURE");

const require = createRequire(`${fixture}/package.json`);
const Database = require("better-sqlite3");
const db = new Database(database);
db.pragma("synchronous = FULL");
db.pragma("busy_timeout = 1250");

if (mode === "hold-lock") {
	db.exec("BEGIN IMMEDIATE");
	process.send?.("locked");
	setInterval(() => db.pragma("user_version", { simple: true }), 1_000);
} else {
	const revision = mode === "crash-before-commit" ? 2 : 3;
	const hash = `hash-${revision}`;
	db.exec("BEGIN IMMEDIATE");
	db.prepare("INSERT INTO snapshots(thread_id, revision, hash, body) VALUES (?, ?, ?, ?)")
		.run("thread-1", revision, hash, Buffer.from(`snapshot-${revision}`));
	db.prepare("INSERT INTO snapshot_index(thread_id, revision, hash) VALUES (?, ?, ?)")
		.run("thread-1", revision, hash);
	db.prepare("UPDATE threads SET latest_revision = ?, latest_hash = ? WHERE id = ?")
		.run(revision, hash, "thread-1");
	if (mode === "crash-after-commit") db.exec("COMMIT");
	process.exit(91);
}
