import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, loadCheckpoint } from "../src/managed/storage.mjs";

if (process.argv[2] === "--worker") {
	const [, , , dir, threadId, boundary] = process.argv;
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		const publish = to === resolve(dir, "data/threads", threadId);
		if (publish && boundary === "before") process.kill(process.pid, "SIGKILL");
		rename(from, to);
		if (publish && boundary === "after") process.kill(process.pid, "SIGKILL");
	};
	syncBuiltinESMExports(); // Test-only filesystem fault injection, never patch pi.
	const { ManagedRunner } = await import("../src/managed/runner.mjs");
	new ManagedRunner({ dataDir: resolve(dir, "data"), cwd: dir, id: "prepare-test", piPackage: resolve(dir, "fake-pi") }).prepare(threadId);
	throw new Error("crash boundary did not fire");
}

const { ManagedRunner } = await import("../src/managed/runner.mjs");
const root = fs.realpathSync(fs.mkdtempSync(resolve(tmpdir(), "pi-prepare-crash-")));
try {
	for (const boundary of ["before", "after"]) {
		const dir = resolve(root, boundary), threadId = randomUUID();
		fs.mkdirSync(resolve(dir, "fake-pi"), { recursive: true });
		fs.writeFileSync(resolve(dir, "fake-pi/package.json"), JSON.stringify({ version: "0.85.1" }));
		const child = spawnSync(process.execPath, [import.meta.filename, "--worker", dir, threadId, boundary], { encoding: "utf8" });
		assert.equal(child.signal, "SIGKILL", child.stderr);
		const published = resolve(dir, "data/threads", threadId, "record.json");
		const before = fs.existsSync(published) ? readJson(published) : null;
		assert.equal(!!before, boundary === "after");
		const runner = new ManagedRunner({ dataDir: resolve(dir, "data"), cwd: dir, id: "prepare-test", piPackage: resolve(dir, "fake-pi") });
		try {
			const prepared = runner.prepare(threadId);
			assert.equal(prepared.threadId, threadId);
			assert.deepEqual(runner.prepare(threadId), prepared);
			if (before) assert.equal(prepared.piSessionId, before.piSessionId, "lost prepare ack cannot allocate a second identity");
			const record = readJson(published);
			assert.deepEqual(loadCheckpoint(record.checkpointFile, record.sessionFile, record.piSessionId, dir).entries, []);
			assert.equal(runner.threads.get(threadId).runtime, null, "creation recovery never starts pi");
		} finally { await runner.close(); }
	}
	console.log("ok prepare crash (fake package, no pi): SIGKILL before/after atomic publication; blank thread retry retains committed identity without starting a child");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
