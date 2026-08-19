// Full chain: probe clients -> tower -> runner.mjs -> one real `pi --mode rpc` per session. No LLM call.
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
	const list = await fetch(`http://127.0.0.1:${port}/runners`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) =>
		r.json(),
	);
	if (list.some((r) => r.id === "chain-test")) break;
	assert.ok(i < 100, "runner never registered");
	await new Promise((r) => setTimeout(r, 200));
}
console.log("ok runner registered");

let seq = 0;
async function attachAndGetState(session) {
	const ws = new WebSocket(
		`ws://127.0.0.1:${port}/attach?runner=chain-test&session=${session}`,
		{ headers: { authorization: `Bearer ${TOKEN}` } },
	);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onclose = (ev) => reject(new Error(`attach ${session} closed: ${ev.code} ${ev.reason}`));
	});
	const id = `q${++seq}`;
	const reply = new Promise((r) => {
		ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.type === "response" && msg.id === id) r(msg);
		};
	});
	ws.send(JSON.stringify({ id, type: "get_state" }));
	const state = await reply;
	assert.equal(state.success, true, `get_state on session ${session}`);
	return { ws, sessionId: state.data.sessionId };
}

// two sessions concurrently -> two distinct pi processes
const [a, b] = await Promise.all([attachAndGetState("a"), attachAndGetState("b")]);
assert.ok(a.sessionId && b.sessionId);
assert.notEqual(a.sessionId, b.sessionId, "distinct pi processes per session");
console.log(`ok parallel sessions, distinct pi processes (a=${a.sessionId} b=${b.sessionId})`);

// detach and reattach "a": same pi process, same session
a.ws.close();
await new Promise((r) => setTimeout(r, 100));
const a2 = await attachAndGetState("a");
assert.equal(a2.sessionId, a.sessionId, "reattach reaches the same pi session");
console.log("ok reattach continuity, same sessionId");

b.ws.close();
a2.ws.close();
runner.kill("SIGTERM");
server.close();
console.log("verify-chain: all green");
process.exit(0);
