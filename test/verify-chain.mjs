// Full chain: probe client -> tower -> runner.mjs -> real `pi --mode rpc`. No LLM call.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createTower } from "../tower.mjs";

const TOKEN = "t0k";
const server = createTower({ token: TOKEN });
server.listen(0);
await once(server, "listening");
const port = server.address().port;

const runner = spawn(
	"node",
	["runner.mjs", "--hq", `ws://127.0.0.1:${port}`, "--id", "chain-test", "--token", TOKEN, "--", "--no-session"],
	{ stdio: ["ignore", "inherit", "inherit"] },
);

// wait for the runner to register
for (let i = 0; ; i++) {
	const list = await fetch(`http://127.0.0.1:${port}/runners?token=${TOKEN}`).then((r) => r.json());
	if (list.some((r) => r.id === "chain-test")) break;
	assert.ok(i < 100, "runner never registered");
	await new Promise((r) => setTimeout(r, 200));
}
console.log("ok runner registered");

const client = new WebSocket(`ws://127.0.0.1:${port}/attach?runner=chain-test&token=${TOKEN}`);
await new Promise((resolve, reject) => {
	client.onopen = resolve;
	client.onclose = (ev) => reject(new Error(`attach closed: ${ev.code} ${ev.reason}`));
});
const reply = new Promise((r) => {
	client.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.type === "response" && msg.id === "q1") r(msg);
	};
});
client.send(JSON.stringify({ id: "q1", type: "get_state" }));
const state = await reply;
assert.equal(state.success, true);
assert.ok(state.data.sessionId, "sessionId present");
console.log(`ok get_state through full chain (sessionId=${state.data.sessionId})`);

client.close();
runner.kill("SIGTERM");
server.close();
console.log("verify-chain: all green");
process.exit(0);
