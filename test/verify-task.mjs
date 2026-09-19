// Drives the pi-task CLI against a real tower + fake runner, no pi process involved.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTower } from "../src/tower.mjs";
import { CANNED_ANSWER, cannedAnswer, connectFakeRunner } from "./fake-runner.mjs";

const TOKEN = "t0k";
const server = createTower({ token: TOKEN });
server.listen(0);
await once(server, "listening");
const port = server.address().port;
const runner = await connectFakeRunner(port, TOKEN, "fake-1");

const run = promisify(execFile);
const taskBin = fileURLToPath(new URL("../src/task.mjs", import.meta.url));
const env = { ...process.env, PI_TOWER_URL: `ws://127.0.0.1:${port}`, PI_TOWER_TOKEN: TOKEN };

const taskOut = await run("node", [taskBin, "fake-1", "do it"], { env });
assert.equal(taskOut.stdout.trim(), CANNED_ANSWER);
assert.equal(taskOut.stderr, "", "piped stderr stays clean (deltas are TTY-only)");
console.log("ok pi-task final answer on stdout, piped stderr clean");

// two named sessions in parallel, each answer tagged with its session
const [s1, s2] = await Promise.all([
	run("node", [taskBin, "--session", "s1", "fake-1", "p"], { env }),
	run("node", [taskBin, "--session", "s2", "fake-1", "p"], { env }),
]);
assert.equal(s1.stdout.trim(), cannedAnswer("s1"));
assert.equal(s2.stdout.trim(), cannedAnswer("s2"));
console.log("ok parallel pi-task sessions route independently");

const listOut = await run("node", [taskBin, "--list"], { env });
assert.match(listOut.stdout, /fake-1\s+3 sessions/);
console.log("ok pi-task --list with session count");

const tokenDir = await mkdtemp(join(tmpdir(), "pi-tower-"));
const tokenPath = join(tokenDir, "token");
try {
	await writeFile(tokenPath, `${TOKEN}\n`);
	const tokenFileEnv = { ...process.env, PI_TOWER_URL: `ws://127.0.0.1:${port}`, PI_TOWER_TOKEN_FILE: tokenPath };
	delete tokenFileEnv.PI_TOWER_TOKEN;
	assert.match((await run("node", [taskBin, "--list"], { env: tokenFileEnv })).stdout, /fake-1\s+3 sessions/);
	assert.match(
		(await run("node", [taskBin, "--token-file", tokenPath, "--list"], { env: { ...env, PI_TOWER_TOKEN: "wrong" } })).stdout,
		/fake-1\s+3 sessions/,
	);
} finally {
	await rm(tokenDir, { recursive: true, force: true });
}
console.log("ok pi-task reads token from flag and environment file");

await assert.rejects(
	run("node", [taskBin, "ghost", "x"], { env }),
	(err) => err.code === 1 && /unknown runner/.test(err.stderr),
);
console.log("ok pi-task unknown runner exits 1 with reason");

runner.close();
server.close();
console.log("verify-task: all green");
process.exit(0);
