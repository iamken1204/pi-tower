// Drives extension.ts's tools against a real tower + fake runner, no pi process involved.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createJiti } from "jiti";
import { createTower } from "../tower.mjs";
import { CANNED_ANSWER, connectFakeRunner } from "./fake-runner.mjs";

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

runner.close();
server.close();
console.log("verify-extension: all green");
process.exit(0);
