import assert from "node:assert/strict";
import { once } from "node:events";
import { createTower } from "../tower.mjs";
import { connectFakeRunner } from "./fake-runner.mjs";

const TOKEN = "t0k";
const server = createTower({ token: TOKEN, openTimeoutMs: 400 });
server.listen(0);
await once(server, "listening");
const port = server.address().port;

const attach = (runner, session, token = TOKEN) =>
	new WebSocket(
		`ws://127.0.0.1:${port}/attach?runner=${runner}${session ? `&session=${session}` : ""}`,
		{ headers: { authorization: `Bearer ${token}` } },
	);
const closed = (ws) => new Promise((r) => (ws.onclose = (ev) => r(ev)));
const opened = (ws) => new Promise((r) => (ws.onopen = () => r(ws)));
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const getState = (ws) => {
	const id = `q${++seq}`;
	const reply = new Promise((r) => {
		ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.type === "response" && msg.id === id) r(msg);
		};
	});
	ws.send(JSON.stringify({ id, type: "get_state" }));
	return reply;
};
const sessions = async () =>
	(await fetch(`http://127.0.0.1:${port}/runners`, { headers: { authorization: `Bearer ${TOKEN}` } })
		.then((r) => r.json())).map((r) => [r.id, r.sessions]);
const runners = () =>
	fetch(`http://127.0.0.1:${port}/runners`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
const apiState = () =>
	fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());

// health
assert.equal(await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()), "pi-tower");
console.log("ok health");

// auth reject on attach and /runners
assert.equal((await closed(attach("x", "s", "wrong"))).code, 4001);
assert.equal((await fetch(`http://127.0.0.1:${port}/runners`, { headers: { authorization: "Bearer wrong" } })).status, 401);
assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: "Bearer wrong" } })).status, 401);
console.log("ok auth 4001/401");

// missing Authorization header also rejected
assert.equal((await fetch(`http://127.0.0.1:${port}/runners`)).status, 401);
assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
console.log("ok missing auth header 401");

const uiResponse = await fetch(`http://127.0.0.1:${port}/ui/`);
assert.equal(uiResponse.status, 200);
assert.match(uiResponse.headers.get("content-type"), /^text\/html;\s*charset=utf-8$/i);
assert.match(await uiResponse.text(), /pi-tower state/i);
console.log("ok public UI shell");

// unknown runner names online ids
const fake1 = await connectFakeRunner(port, TOKEN, "r1");
const ev404 = await closed(attach("nope"));
assert.equal(ev404.code, 4004);
assert.match(ev404.reason, /r1/);
console.log("ok unknown runner 4004 lists ids");

// invalid session name
assert.equal((await closed(attach("r1", "bad%20name"))).code, 1008);
console.log("ok invalid session name 1008");

// two sessions on one runner round-trip in parallel; frames sent while pending are queued
const [cA, cB] = await Promise.all([opened(attach("r1", "a")), opened(attach("r1", "b"))]);
const [stateA, stateB] = await Promise.all([getState(cA), getState(cB)]);
assert.equal(stateA.data.sessionId, "r1:a");
assert.equal(stateB.data.sessionId, "r1:b");
assert.deepEqual([...fake1.opens].sort(), ["a", "b"]);
console.log("ok parallel sessions round-trip");

// same-session second attach busy
assert.equal((await closed(attach("r1", "a"))).code, 4005);
console.log("ok same-session busy 4005");

// /runners shows session count
assert.deepEqual(await sessions(), [["r1", 2]]);
for (const runner of await runners()) {
	assert.deepEqual(Object.keys(runner), ["id", "connectedAt", "sessions"]);
	assert.equal(typeof runner.sessions, "number");
}
console.log("ok /runners session count");

// detach + reattach pairs to the same pipe, no new open
cA.close();
await settle();
assert.deepEqual((await apiState()).runners[0].sessions.toSorted((a, b) => a.name.localeCompare(b.name)), [
	{ name: "a", state: "idle" },
	{ name: "b", state: "attached" },
]);
const cA2 = await opened(attach("r1", "a"));
assert.equal((await getState(cA2)).data.sessionId, "r1:a");
assert.equal(fake1.opens.length, 2, "reattach must not re-open");
console.log("ok reattach reuses idle session, no new open");

// control reconnect replaces the socket; live sessions survive
const fake1b = await connectFakeRunner(port, TOKEN, "r1");
await settle();
assert.equal((await getState(cA2)).data.sessionId, "r1:a");
assert.deepEqual(await sessions(), [["r1", 2]]);
console.log("ok control reconnect keeps sessions");

// session pipe death closes its client 4006 and drops the session
const cA2closed = closed(cA2);
fake1.pipes.get("a").close();
assert.equal((await cA2closed).code, 4006);
assert.deepEqual(await sessions(), [["r1", 1]]);
console.log("ok session pipe death 4006");

// runner offline: remaining clients 4006, then unknown
const cBclosed = closed(cB);
fake1b.ws.close();
assert.equal((await cBclosed).code, 4006);
assert.equal((await closed(attach("r1", "b"))).code, 4004);
console.log("ok runner offline closes all 4006 then 4004");

// runner that never opens the session -> 4007 after timeout
const fake2 = await connectFakeRunner(port, TOKEN, "r2", { ignoreOpen: true });
const pendingClient = await opened(attach("r2", "x"));
const pendingClosed = closed(pendingClient);
assert.deepEqual(await sessions(), [["r2", 0]]);
assert.deepEqual((await apiState()).runners[0].sessions, [{ name: "x", state: "opening" }]);
assert.equal((await pendingClosed).code, 4007);
fake2.close();
console.log("ok open timeout 4007");

server.close();
console.log("verify-tower: all green");
process.exit(0);
