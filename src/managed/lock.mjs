// SQLite's OS-backed exclusive lock is released on process death, not by a PID/age guess.
// Local filesystems only. Never unlink these files while a managed process may exist.
import { openDatabase, pragma } from "./sqlite.mjs";

// bun:sqlite closes a handle once nothing references it, which would release the lock while its
// owner still runs. Every guard therefore stays here until close().
const held = new Set();

export function holdWriterLock(file) {
	const db = openDatabase(file);
	try {
		pragma(db, "busy_timeout = 0");
		db.exec("BEGIN EXCLUSIVE");
	} catch (error) {
		db.close();
		if (error.code === "SQLITE_BUSY") throw new Error("writer_locked: an existing managed writer has not exited");
		throw error;
	}
	held.add(db);
	return { close() { held.delete(db); db.close(true); } }; // true: fail loudly rather than keep the lock on a half-closed handle.
}
