import assert from "node:assert/strict";
import { once } from "node:events";
import { createTower } from "../tower.mjs";
import { connectFakeRunner } from "./fake-runner.mjs";

const TOKEN = "t0k";
const server = createTower({ token: TOKEN });
server.listen(0);
await once(server, "listening");
const port = server.address().port;

const attach = (runner, token = TOKEN) =>
	new WebSocket(`ws://127.0.0.1:${port}/attach?runner=${runner}&token=${token}`);
const closed = (ws) => new Promise((r) => (ws.onclose = (ev) => r(ev)));
const opened = (ws) => new Promise((r) => (ws.onopen = () => r(ws)));

// health
const health = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
assert.equal(health, "pi-tower");
console.log("ok health");

// auth reject on attach and /runners
assert.equal((await closed(attach("x", "wrong"))).code, 4001);
assert.equal((await fetch(`http://127.0.0.1:${port}/runners?token=wrong`)).status, 401);
console.log("ok auth 4001/401");

// unknown runner names online ids
const runner = await connectFakeRunner(port, TOKEN, "r1");
const ev404 = await closed(attach("nope"));
assert.equal(ev404.code, 4004);
assert.match(ev404.reason, /r1/);
console.log("ok unknown runner 4004 lists ids");

// attach + get_state roundtrip through relay
const client = await opened(attach("r1"));
const reply = new Promise((r) => (client.onmessage = (ev) => r(JSON.parse(ev.data))));
client.send(JSON.stringify({ id: "q1", type: "get_state" }));
const state = await reply;
assert.equal(state.success, true);
assert.equal(state.data.sessionId, "fake-1");
console.log("ok get_state roundtrip");

// second attach busy
assert.equal((await closed(attach("r1"))).code, 4005);
console.log("ok busy 4005");

// /runners listing
const list = await fetch(`http://127.0.0.1:${port}/runners?token=${TOKEN}`).then((r) => r.json());
assert.deepEqual(list.map((r) => [r.id, r.busy]), [["r1", true]]);
console.log("ok /runners listing");

// reconnect replaces old socket, attached client survives and routes to new socket
const runner2 = await connectFakeRunner(port, TOKEN, "r1");
await new Promise((r) => setTimeout(r, 50)); // let old-socket close settle
const reply2 = new Promise((r) => (client.onmessage = (ev) => r(JSON.parse(ev.data))));
client.send(JSON.stringify({ id: "q2", type: "get_state" }));
assert.equal((await reply2).success, true);
console.log("ok reconnect replaces runner, client survives");

// runner death closes client 4006, then unknown again
const clientClosed = closed(client);
runner2.close();
assert.equal((await clientClosed).code, 4006);
assert.equal((await closed(attach("r1"))).code, 4004);
console.log("ok runner death 4006");

runner.close();
server.close();
console.log("verify-tower: all green");
