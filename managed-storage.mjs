// Durable local records and strict session validation. Never repair a session by dropping entries.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export function uuid(value) {
	if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error("invalid_id");
	return value;
}

export function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

export function durableWrite(file, value) {
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		const fd = openSync(temp, "wx", 0o600);
		try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
		renameSync(temp, file);
		syncFile(dirname(file));
	} finally {
		try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
	}
}

export function syncFile(file) {
	const fd = openSync(file, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function privateDirectory(dir) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function checkpoint(header, entries, leafId) {
	if (header?.type !== "session" || header.version !== 3 || typeof header.cwd !== "string") throw new Error("unsupported_session");
	uuid(header.id);
	if (!Array.isArray(entries)) throw new Error("invalid_entries");
	const ids = new Set();
	for (const entry of entries) {
		if (!entry || typeof entry.type !== "string" || entry.type === "session" || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) throw new Error("invalid_entry_id");
		if (entry.parentId !== null && !ids.has(entry.parentId)) throw new Error("invalid_parent");
		ids.add(entry.id);
	}
	if (leafId !== null && !ids.has(leafId)) throw new Error("invalid_leaf");
	const body = { header, entries, leafId };
	return { ...body, hash: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

export function loadCheckpoint(file, sessionFile, sessionId, cwd, recoverAppend = false) {
	const saved = readJson(file);
	const verified = checkpoint(saved.header, saved.entries, saved.leafId);
	if (saved.hash !== verified.hash || saved.header.id !== sessionId || saved.header.cwd !== cwd) throw new Error("checkpoint_identity_or_hash_mismatch");
	const text = readFileSync(sessionFile, "utf8"); // Missing local files require explicit cloud recovery, never recreation here.
	if (!text.endsWith("\n")) throw new Error("incomplete_session_file");
	const records = text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
	if (JSON.stringify(records) !== JSON.stringify([saved.header, ...saved.entries])) {
		const prefix = [saved.header, ...saved.entries];
		if (!recoverAppend || records.length <= prefix.length || !prefix.every((entry, index) => JSON.stringify(entry) === JSON.stringify(records[index]))) throw new Error("session_checkpoint_mismatch");
		// Only after proving the old writer exited: retain every complete appended entry.
		// With no later append the saved independent leaf remains authoritative.
		const recovered = checkpoint(records[0], records.slice(1), records.at(-1).id);
		durableWrite(file, recovered);
		return recovered;
	}
	return verified;
}
