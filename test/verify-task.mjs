// Drives `pi-runner task` against a real tower + fake runner, no pi process involved.
// PI_RUNNER_BIN runs it from a compiled runner.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const [executable, ...entry] = process.env.PI_RUNNER_BIN ? [resolve(process.env.PI_RUNNER_BIN)] : [process.execPath, fileURLToPath(new URL("../src/runner.mjs", import.meta.url))];
const run = (args, options) => promisify(execFile)(executable, [...entry, "task", ...args], options);
const env = { ...process.env, PI_TOWER_URL: `ws://127.0.0.1:${port}`, PI_TOWER_TOKEN: TOKEN };

const taskOut = await run(["fake-1", "do it"], { env });
assert.equal(taskOut.stdout.trim(), CANNED_ANSWER);
assert.equal(taskOut.stderr, "", "piped stderr stays clean (deltas are TTY-only)");
console.log("ok task final answer on stdout, piped stderr clean");

// two named sessions in parallel, each answer tagged with its session
const [s1, s2] = await Promise.all([
	run(["--session", "s1", "fake-1", "p"], { env }),
	run(["--session", "s2", "fake-1", "p"], { env }),
]);
assert.equal(s1.stdout.trim(), cannedAnswer("s1"));
assert.equal(s2.stdout.trim(), cannedAnswer("s2"));
console.log("ok parallel task sessions route independently");

const listOut = await run(["--list"], { env });
assert.match(listOut.stdout, /fake-1\s+3 sessions/);
console.log("ok task --list with session count");

const tokenDir = await mkdtemp(join(tmpdir(), "pi-tower-"));
const tokenPath = join(tokenDir, "token");
try {
	await writeFile(tokenPath, `${TOKEN}\n`);
	const tokenFileEnv = { ...process.env, PI_TOWER_URL: `ws://127.0.0.1:${port}`, PI_TOWER_TOKEN_FILE: tokenPath };
	delete tokenFileEnv.PI_TOWER_TOKEN;
	assert.match((await run(["--list"], { env: tokenFileEnv })).stdout, /fake-1\s+3 sessions/);
	assert.match(
		(await run(["--token-file", tokenPath, "--list"], { env: { ...env, PI_TOWER_TOKEN: "wrong" } })).stdout,
		/fake-1\s+3 sessions/,
	);
} finally {
	await rm(tokenDir, { recursive: true, force: true });
}
console.log("ok task reads token from flag and environment file");

await assert.rejects(
	run(["ghost", "x"], { env }),
	(err) => err.code === 1 && /unknown runner/.test(err.stderr),
);
console.log("ok task unknown runner exits 1 with reason");

runner.close();
server.close();
console.log("verify-task: all green");
process.exit(0);
