// Drives extension.ts's tools and the pi-task CLI against a real tower + fake runner, no pi process involved.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createJiti } from "jiti";
import { createTower } from "../tower.mjs";
import { CANNED_ANSWER, cannedAnswer, connectFakeRunner } from "./fake-runner.mjs";

const TOKEN = "t0k";
const server = createTower({ token: TOKEN });
server.listen(0);
await once(server, "listening");
const port = server.address().port;
const runner = await connectFakeRunner(port, TOKEN, "fake-1");

// stub ExtensionAPI: capture tools, feed flags
const tools = new Map();
const flags = { tower: `ws://127.0.0.1:${port}`, "tower-token": TOKEN };
const piStub = {
	registerFlag() {},
	getFlag: (name) => flags[name],
	registerTool: (t) => tools.set(t.name, t),
};

const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": "data:text/javascript," } });
const factory = await jiti.import("../extension.ts", { default: true });
factory(piStub);
assert.deepEqual([...tools.keys()].sort(), ["runner_list", "runner_task"]);
console.log("ok tools registered");

const list = await tools.get("runner_list").execute();
assert.match(list.content[0].text, /fake-1\s+idle/);
console.log("ok runner_list output");

const updates = [];
const result = await tools
	.get("runner_task")
	.execute("tc1", { runner_id: "fake-1", prompt: "do it" }, undefined, (p) => updates.push(p.content[0].text));
assert.equal(result.content[0].text, CANNED_ANSWER);
assert.equal(updates.at(-1), CANNED_ANSWER, "streamed transcript reaches final text");
console.log("ok runner_task returns canned answer with streamed updates");

await assert.rejects(
	tools.get("runner_task").execute("tc2", { runner_id: "ghost", prompt: "x" }, undefined, undefined),
	/unknown runner/,
);
console.log("ok runner_task surfaces unknown-runner close reason");

// two named sessions in parallel, each answer tagged with its session
const [r1, r2] = await Promise.all([
	tools.get("runner_task").execute("tc3", { runner_id: "fake-1", prompt: "p", session: "s1" }, undefined, undefined),
	tools.get("runner_task").execute("tc4", { runner_id: "fake-1", prompt: "p", session: "s2" }, undefined, undefined),
]);
assert.equal(r1.content[0].text, cannedAnswer("s1"));
assert.equal(r2.content[0].text, cannedAnswer("s2"));
console.log("ok parallel runner_task sessions route independently");

const run = promisify(execFile);
const taskBin = fileURLToPath(new URL("../task.mjs", import.meta.url));
const env = { ...process.env, PI_TOWER_URL: `ws://127.0.0.1:${port}`, PI_TOWER_TOKEN: TOKEN };

const listOut = await run("node", [taskBin, "--list"], { env });
assert.match(listOut.stdout, /fake-1\s+3 sessions/);
console.log("ok pi-task --list with session count");

const taskOut = await run("node", [taskBin, "fake-1", "do it"], { env });
assert.equal(taskOut.stdout.trim(), CANNED_ANSWER);
assert.equal(taskOut.stderr, "", "piped stderr stays clean (deltas are TTY-only)");
console.log("ok pi-task final answer on stdout, piped stderr clean");

const sessOut = await run("node", [taskBin, "--session", "s3", "fake-1", "do it"], { env });
assert.equal(sessOut.stdout.trim(), cannedAnswer("s3"));
console.log("ok pi-task --session routes to the named session");

await assert.rejects(
	run("node", [taskBin, "ghost", "x"], { env }),
	(err) => err.code === 1 && /unknown runner/.test(err.stderr),
);
console.log("ok pi-task unknown runner exits 1 with reason");

runner.close();
server.close();
console.log("verify-extension: all green");
process.exit(0);
