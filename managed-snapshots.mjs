import { createHash } from "node:crypto";
import { checkpoint, uuid } from "./managed-storage.mjs";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function failure(code, status = 409, fields = {}) {
	const error = new Error(code);
	error.code = code;
	error.status = status;
	Object.assign(error, fields);
	return error;
}

function revision(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "counter,generationId") throw failure("invalid_revision", 400);
	uuid(value.generationId);
	if (!Number.isSafeInteger(value.counter) || value.counter < 1) throw failure("invalid_revision", 400);
	return value;
}

export function parseEnvelope(bytes, binding) {
	let value;
	try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw failure("invalid_snapshot_json", 400); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("invalid_snapshot", 400);
	const required = ["schemaVersion", "threadId", "runnerInstanceId", "piSessionId", "piVersion", "revision", "previous", "capturedAt", "settled", "runId", "header", "entries", "leafId"];
	if (Object.keys(value).sort().join(",") !== required.sort().join(",")) throw failure("invalid_snapshot_schema", 400);
	if (value.schemaVersion !== 1 || value.piVersion !== "0.85.1" || typeof value.settled !== "boolean") throw failure("unsupported_snapshot", 400);
	for (const name of ["threadId", "runnerInstanceId", "piSessionId"]) uuid(value[name]);
	if (!binding || value.threadId !== binding.threadId || value.runnerInstanceId !== binding.runnerInstanceId || value.piSessionId !== binding.piSessionId) throw failure("snapshot_binding_mismatch", 409);
	revision(value.revision);
	if (value.previous !== null) {
		if (!value.previous || typeof value.previous !== "object" || Array.isArray(value.previous) || Object.keys(value.previous).sort().join(",") !== "hash,revision") throw failure("invalid_previous", 400);
		revision(value.previous.revision);
		if (typeof value.previous.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.previous.hash)) throw failure("invalid_previous", 400);
	}
	if (typeof value.capturedAt !== "string" || Number.isNaN(Date.parse(value.capturedAt)) || new Date(value.capturedAt).toISOString() !== value.capturedAt) throw failure("invalid_captured_at", 400);
	if (value.runId !== null) uuid(value.runId);
	try { checkpoint(value.header, value.entries, value.leafId); } catch (error) { throw failure(error.message, 400); }
	if (value.header.id !== value.piSessionId) throw failure("snapshot_session_mismatch", 409);
	return value;
}

function sameJson(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function createSnapshotStore(db, { maxSnapshotBytes = 64 * MIB, maxTotalBytes = GIB } = {}) {
	if (!db || typeof db.prepare !== "function" || !Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes < 1 || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new TypeError("invalid_snapshot_store_options");
	db.exec(`CREATE TABLE IF NOT EXISTS managed_snapshot_index (
		thread_id TEXT NOT NULL, generation_id TEXT NOT NULL, counter INTEGER NOT NULL,
		hash TEXT NOT NULL, byte_length INTEGER NOT NULL, captured_at TEXT NOT NULL,
		leaf_id TEXT, blob BLOB, PRIMARY KEY(thread_id,generation_id,counter));
	CREATE TABLE IF NOT EXISTS managed_snapshot_latest (
		thread_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, counter INTEGER NOT NULL,
		hash TEXT NOT NULL, FOREIGN KEY(thread_id,generation_id,counter)
		REFERENCES managed_snapshot_index(thread_id,generation_id,counter));`);

	const byRevision = db.prepare("SELECT * FROM managed_snapshot_index WHERE thread_id=? AND generation_id=? AND counter=?");
	const latestRow = db.prepare(`SELECT i.* FROM managed_snapshot_latest l JOIN managed_snapshot_index i
		ON i.thread_id=l.thread_id AND i.generation_id=l.generation_id AND i.counter=l.counter WHERE l.thread_id=?`);
	const totalBytes = db.prepare("SELECT COALESCE(SUM(byte_length),0) total FROM managed_snapshot_index WHERE blob IS NOT NULL");
	const insert = db.prepare("INSERT INTO managed_snapshot_index VALUES (?,?,?,?,?,?,?,?)");
	const setLatest = db.prepare(`INSERT INTO managed_snapshot_latest VALUES (?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET
		generation_id=excluded.generation_id,counter=excluded.counter,hash=excluded.hash`);
	const prune = db.prepare("UPDATE managed_snapshot_index SET blob=NULL WHERE thread_id=? AND NOT (generation_id=? AND counter=?)");

	const commitTransaction = db.transaction((bytes, envelope, hash) => {
		const rev = envelope.revision;
		const duplicate = byRevision.get(envelope.threadId, rev.generationId, rev.counter);
		if (duplicate) {
			if (duplicate.hash !== hash) throw failure("snapshot_revision_conflict");
			return { revision: rev, hash };
		}
		const current = latestRow.get(envelope.threadId);
		if (!current) {
			if (envelope.previous !== null) throw failure("snapshot_stale_predecessor");
		} else {
			const expected = { revision: { generationId: current.generation_id, counter: current.counter }, hash: current.hash };
			if (!sameJson(envelope.previous, expected)) throw failure("snapshot_stale_predecessor");
			if (rev.generationId === current.generation_id && rev.counter <= current.counter) throw failure("snapshot_counter_regressed");
			if (rev.generationId !== current.generation_id && db.prepare("SELECT 1 FROM managed_snapshot_index WHERE thread_id=? AND generation_id=? LIMIT 1").get(envelope.threadId, rev.generationId)) throw failure("snapshot_generation_retired");
			if (!current.blob) throw failure("latest_snapshot_expired", 500);
			const old = JSON.parse(current.blob.toString("utf8"));
			if (createHash("sha256").update(current.blob).digest("hex") !== current.hash) throw failure("snapshot_corrupt", 500);
			if (!sameJson(old.header, envelope.header) || envelope.entries.length < old.entries.length || !old.entries.every((entry, index) => sameJson(entry, envelope.entries[index]))) throw failure("snapshot_not_append_superset");
		}
		// The verified predecessor is pruned in this same transaction. The quota counts
		// retained BLOBs; filesystem headroom separately covers the old/new WAL overlap.
		if (totalBytes.get().total - (current?.byte_length ?? 0) + bytes.length > maxTotalBytes) throw failure("snapshot_total_quota_exceeded", 413);
		insert.run(envelope.threadId, rev.generationId, rev.counter, hash, bytes.length, envelope.capturedAt, envelope.leafId, bytes);
		setLatest.run(envelope.threadId, rev.generationId, rev.counter, hash);
		prune.run(envelope.threadId, rev.generationId, rev.counter);
		return { revision: rev, hash };
	});

	function commit(bytes, binding) {
		if (!Buffer.isBuffer(bytes)) throw failure("snapshot_bytes_required", 400);
		if (bytes.length > maxSnapshotBytes) throw failure("snapshot_too_large", 413);
		const hash = createHash("sha256").update(bytes).digest("hex");
		const envelope = parseEnvelope(bytes, binding);
		return commitTransaction(bytes, envelope, hash);
	}

	function latest(threadId) {
		const row = latestRow.get(uuid(threadId));
		if (!row || !row.blob) return null;
		const bytes = Buffer.from(row.blob);
		if (createHash("sha256").update(bytes).digest("hex") !== row.hash) throw failure("snapshot_corrupt", 500);
		const raw = JSON.parse(bytes.toString("utf8"));
		const envelope = parseEnvelope(bytes, { threadId, runnerInstanceId: raw.runnerInstanceId, piSessionId: raw.piSessionId });
		if (envelope.revision.generationId !== row.generation_id || envelope.revision.counter !== row.counter) throw failure("snapshot_corrupt", 500);
		return { revision: { generationId: row.generation_id, counter: row.counter }, hash: row.hash, bytes, envelope };
	}

	function history(threadId, requestedRevision, cursor = 0, limit = 100) {
		uuid(threadId);
		if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw failure("invalid_history_page", 400);
		let row;
		if (requestedRevision === undefined || requestedRevision === null) row = latestRow.get(threadId);
		else { const rev = revision(requestedRevision); row = byRevision.get(threadId, rev.generationId, rev.counter); }
		if (!row) return null;
		if (!row.blob) {
			const newest = latestRow.get(threadId);
			throw failure("snapshot_expired", 410, { latestRevision: newest ? { generationId: newest.generation_id, counter: newest.counter } : null });
		}
		if (createHash("sha256").update(row.blob).digest("hex") !== row.hash) throw failure("snapshot_corrupt", 500);
		const envelope = JSON.parse(row.blob.toString("utf8"));
		const entries = envelope.entries.slice(cursor, cursor + limit);
		return { revision: { generationId: row.generation_id, counter: row.counter }, hash: row.hash, leafId: envelope.leafId, entries, nextCursor: cursor + entries.length < envelope.entries.length ? cursor + entries.length : null };
	}

	function usage() {
		const blobBytes = totalBytes.get().total;
		return { blobBytes, maxSnapshotBytes, maxTotalBytes };
	}

	function head(threadId) {
		const row = db.prepare("SELECT generation_id,counter,hash FROM managed_snapshot_latest WHERE thread_id=?").get(uuid(threadId));
		return row ? { revision: { generationId: row.generation_id, counter: row.counter }, hash: row.hash } : null;
	}
	return { commit, latest, head, history, usage, backup: (path) => db.backup(path) };
}
