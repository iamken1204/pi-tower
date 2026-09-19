// Bun's built-in SQLite, plus the two operations the stores and their tests share.
import { Database } from "bun:sqlite";

// strict binds @name parameters from bare object keys and rejects a missing one.
export function openDatabase(file, options = {}) {
	return new Database(file, { strict: true, ...options });
}

// close() waits for every statement to be finalized, and a connection left waiting keeps its
// locks, so these one-off statements are finalized here instead of by the garbage collector.
function once(db, source, use) {
	const statement = db.prepare(source);
	try { return use(statement); } finally { statement.finalize(); }
}

// Runs one PRAGMA and returns its first column, or undefined when it yields no row.
export function pragma(db, source) {
	const row = once(db, `PRAGMA ${source}`, (statement) => statement.get());
	return row ? Object.values(row)[0] : undefined;
}

// Writes a consistent copy, committed WAL frames included. The destination must not exist yet.
export function backup(db, path) {
	once(db, "VACUUM INTO ?", (statement) => statement.run(path));
}
