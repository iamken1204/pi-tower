// SQLite's OS-backed exclusive lock is released on process death, not by a PID/age guess.
// Local filesystems only. Never unlink these files while a managed process may exist.
import Database from "better-sqlite3";

export function holdWriterLock(file) {
	const db = new Database(file);
	try {
		db.pragma("busy_timeout = 0");
		db.exec("BEGIN EXCLUSIVE");
		return db;
	} catch (error) {
		db.close();
		if (error.code === "SQLITE_BUSY") throw new Error("writer_locked: an existing managed writer has not exited");
		throw error;
	}
}
