import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import WebSocket from "ws";
import { createTower } from "../tower.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(resolve(tmpdir(), "pi-native-"));
const socket = resolve(dir, "tmux.sock");
const tmux = (...args) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const pkg = process.env.PI_COMPAT_PACKAGE || resolve(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const token = "isolated-native-test";
let tower, port;
const clients = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label) => {
	for (let i = 0; i < 250; i++) { if (await fn()) return; await delay(100); }
	throw new Error(`timeout: ${label}\n${tmux("capture-pane", "-p", "-S", "-150")}`);
};
const api = (path) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
const send = (text) => { tmux("send-keys", "-l", text); tmux("send-keys", "Enter"); };
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
async function startTower() {
	tower = createTower({ token, dataDir: resolve(dir, "tower") }); tower.listen(port ?? 0, "127.0.0.1"); await once(tower, "listening"); port = tower.address().port;
}
async function attach(id) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/managed/client?thread=${id}`, { headers: { authorization: `Bearer ${token}` } });
	clients.push(ws); let epoch; const frames = [];
	ws.on("message", (data) => { const event = JSON.parse(data); frames.push(event); if (event.type === "access_changed") epoch = event.epoch; });
	await once(ws, "open"); await until(() => epoch, "automatic access");
	return { frames, get epoch() { return epoch; }, async request(operation, fields = {}, expectedError) {
		const requestId = randomUUID();
		ws.send(JSON.stringify({ version: 1, requestId, commandId: randomUUID(), operation, epoch, ...fields }));
		await until(() => frames.some((f) => f.requestId === requestId), operation);
		const reply = frames.find((f) => f.requestId === requestId); assert.equal(reply.error, expectedError, JSON.stringify(reply)); return reply.result;
	} };
}
try {
	for (const name of ["home", "agent/extensions", "workspace", "runner", "tower"]) mkdirSync(resolve(dir, name), { recursive: true });
	writeFileSync(resolve(dir, "agent/extensions/fixture.js"), readFileSync(resolve(root, "test/compat/managed-extension.mjs"), "utf8").replace("tokensPerSecond: 0", "tokensPerSecond: 4"));
	writeFileSync(resolve(dir, "agent/extensions/dialogs.js"), `export default function(pi) {
		pi.registerCommand("fixture-custom", { handler: async () => { pi.appendEntry("idle-custom", { value: 73 }); } });
		pi.registerCommand("fixture-tree", { handler: async (_, ctx) => {
			const target = ctx.sessionManager.getEntries().find((entry) => entry.message?.role === "assistant");
			await ctx.navigateTree(target.id, { summarize: false });
		} });
		for (const method of ["select", "input", "editor"]) pi.registerCommand("fixture-" + method, {
			handler: async (_, ctx) => { const value = await ctx.ui[method]("Fixture " + method, method === "select" ? ["first", "second"] : ""); pi.appendEntry("fixture-answer", { method, value }); }
		});
	}`);
	writeFileSync(resolve(dir, "agent/settings.json"), JSON.stringify({ defaultProvider: "phase1", defaultModel: "faux-1", compaction: { enabled: false }, quietStartup: true }));
	await startTower();
	const env = { HOME: resolve(dir, "home"), PI_CODING_AGENT_DIR: resolve(dir, "agent"), PI_OFFLINE: "1", PI_COMPAT_PACKAGE: pkg, MANAGED_TEST_LOG: resolve(dir, "starts.jsonl") };
	const args = [process.execPath, resolve(root, "runner.mjs"), "--interactive", "--hq", `ws://127.0.0.1:${port}`, "--id", "native-test", "--token", token, "--data-dir", resolve(dir, "runner"), "--pi-package", pkg];
	const launch = `env ${Object.entries(env).map(([k,v]) => `${k}=${quote(v)}`).join(" ")} ${args.map(quote).join(" ")}`;
	tmux("-f", "/dev/null", "new-session", "-d", "-s", "native", "-x", "120", "-y", "40", "-c", resolve(dir, "workspace"), launch);
	tmux("set-option", "remain-on-exit", "on");
	let id;
	await until(async () => { id = (await api("/api/threads")).threads?.[0]?.threadId; return id; }, "local thread registers");
	await until(async () => (await api("/api/state")).runners.some((item) => item.id === "native-test" && item.managed && item.sessions.some((session) => session.threadId === id)), "home page lists the interactive runner and its thread");
	const a = await attach(id), b = await attach(id);
	assert.deepEqual(a.epoch, b.epoch);
	send("/fixture-custom");
	await until(async () => JSON.stringify(await api(`/api/threads/${id}/history`)).includes("idle-custom"), "idle custom entry syncs without an agent run");
	send("local-native-73");
	await until(async () => (await a.request("entries")).entries.some((e) => JSON.stringify(e.message ?? null).includes("local-native-73")), "local message");
	await until(async () => (await api(`/api/threads/${id}`)).title === "local-native-73", "local prompt supplies title");
	await a.request("prompt", { message: "remote-A-29" });
	await b.request("prompt", { message: "remote-B-41" });
	await until(async () => { const s = await a.request("state"); return s.state === "idle" && s.queue.length === 0 && s.sync === "synced"; }, "both clients finish");
	const history = await a.request("entries");
	for (const text of ["local-native-73", "remote-A-29", "remote-B-41"]) assert.ok(JSON.stringify(history).includes(text));
	assert.ok(tmux("capture-pane", "-p", "-S", "-100").includes("remote-B-41"));
	send("dialog");
	await until(async () => (await a.request("state")).pendingDialogs.length, "native dialog");
	const state = await a.request("state");
	const answer = { targetRunId: state.runId, dialogId: state.pendingDialogs[0].id, value: true };
	await b.request("extension_ui_response", answer);
	await a.request("extension_ui_response", answer, "stale_or_invalid_dialog");
	await until(async () => (await a.request("state")).state === "idle", "dialog ends");
	for (const method of ["select", "input", "editor"]) {
		send(`/fixture-${method}`);
		await until(async () => (await a.request("state")).pendingDialogs.some((item) => item.method === method), method);
		const state = await a.request("state"), dialog = state.pendingDialogs[0];
		if (method === "editor") {
			assert.equal(dialog.localOnly, true);
			await a.request("extension_ui_response", { targetRunId: state.runId, dialogId: dialog.id, value: "forbidden" }, "stale_or_invalid_dialog");
			tmux("send-keys", "Escape");
		} else await b.request("extension_ui_response", { targetRunId: state.runId, dialogId: dialog.id, value: method === "select" ? "second" : "遠端答案73" });
		await until(async () => !(await a.request("state")).pendingDialogs.length, `${method} closes`);
	}
	const answers = (await a.request("entries")).entries.filter((item) => item.customType === "fixture-answer");
	assert.ok(answers.some((item) => item.data.method === "select" && item.data.value === "second"));
	assert.ok(answers.some((item) => item.data.method === "input" && item.data.value === "遠端答案73"));
	await a.request("prompt", { message: "slow" });
	const queued = await b.request("prompt", { message: "cancelled-queue-83" });
	await until(async () => (await a.request("state")).queue.some((item) => item.message === "cancelled-queue-83"), "queued during preflight");
	assert.ok(tmux("capture-pane", "-p").includes("Web follow-up: 1"));
	await a.request("abort", { targetRunId: (await a.request("state")).runId });
	await until(async () => (await a.request("command", { commandId: queued.commandId })).status === "unknown", "cancelled receipt stays uncertain");
	await until(async () => (await a.request("state")).state === "idle", "abort finishes");
	assert.ok(!JSON.stringify(await a.request("entries")).includes("cancelled-queue-83"));
	const eventStart = a.frames.length;
	await a.request("prompt", { message: "before-steering-47" });
	await until(() => a.frames.slice(eventStart).some((item) => item.event?.type === "message_update"), "real streaming before steer");
	await b.request("prompt", { message: "steering-59", behavior: "steer" });
	await until(async () => (await a.request("state")).state === "idle", "steered run settles");
	assert.ok(JSON.stringify(await a.request("entries")).includes("steering-59"));
	const oldEpoch = a.epoch;
	await tower.shutdown();
	send("offline-native-97");
	await until(() => { const screen = tmux("capture-pane", "-p", "-S", "-100"); return screen.slice(screen.lastIndexOf("offline-native-97")).includes("已完成"); }, "offline local response");
	await startTower();
	await until(async () => (await api(`/api/threads/${id}`)).online, "runner reconnects");
	const c = await attach(id);
	await c.request("prompt", { message: "stale", epoch: oldEpoch }, "stale_access");
	await until(async () => JSON.stringify(await api(`/api/threads/${id}/history`)).includes("offline-native-97"), "offline progress syncs");
	send("/reload");
	await delay(1500);
	await c.request("prompt", { message: "after-reload-53" });
	await until(async () => { const s = await c.request("state"); return s.state === "idle" && s.sync === "synced"; }, "reload rebind");
	assert.ok(JSON.stringify(await c.request("entries")).includes("after-reload-53"));
	send("/new");
	await until(async () => (await api("/api/threads")).threads.length === 2, "new native session registers");
	assert.equal((await c.request("state")).inputReady, false);
	await c.request("prompt", { message: "must not restart old native" }, "start_thread_in_local_terminal");
	const nextId = (await api("/api/threads")).threads.find((t) => t.threadId !== id).threadId;
	await until(async () => (await api("/api/threads?active=true")).threads.map((t) => t.threadId).join() === nextId, "only the current native thread is active");
	await until(async () => { const sessions = (await api("/api/state")).runners.find((item) => item.id === "native-test").sessions; return sessions.length === 1 && sessions[0].threadId === nextId; }, "home page follows the native session switch");
	const d = await attach(nextId);
	await d.request("prompt", { message: "new-native-67" });
	await until(async () => { const s = await d.request("state"); return s.state === "idle" && s.sync === "synced"; }, "new session usable");
	assert.ok(JSON.stringify(await d.request("entries")).includes("new-native-67"));
	await d.request("prompt", { message: "retained-other-branch-71" });
	await until(async () => (await d.request("state")).state === "idle", "second branch message");
	send("/fixture-tree");
	await until(async () => {
		const history = await d.request("entries");
		return history.leafId === history.entries.find((item) => item.message?.role === "assistant")?.id;
	}, "navigate original active leaf");
	const saved = await d.request("entries");
	assert.ok(JSON.stringify(saved.entries).includes("retained-other-branch-71"));
	assert.notEqual(saved.leafId, saved.entries.at(-1).id);
	const pid = JSON.parse(readFileSync(resolve(dir, "starts.jsonl"), "utf8").trim().split("\n").at(-1)).pid;
	process.kill(pid, "SIGKILL");
	await until(() => tmux("display-message", "-p", "#{pane_dead}").trim() === "1", "crashed native exits");
	tmux("respawn-pane", "-c", resolve(dir, "home"), `${launch} --thread ${quote(nextId)}`);
	await until(async () => (await api(`/api/threads/${nextId}`)).online, "restart original thread");
	const e = await attach(nextId);
	assert.deepEqual(await e.request("entries"), saved);
	await e.request("prompt", { message: "after-native-crash-89" });
	await until(async () => (await e.request("state")).state === "idle", "crash continuation");
	const starts = readFileSync(resolve(dir, "starts.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	assert.equal(starts.at(-1).cwd, realpathSync(resolve(dir, "workspace")));
	console.log("ok native integration: automatic shared access, local + two remote writers to one runtime, dialog race rejection, offline local and reconnect fencing");
	if (process.env.PI_NATIVE_PREVIEW === "1") {
		let done;
		const finished = new Promise((resolve) => { done = resolve; });
		const control = createServer((req, res) => { res.end("done"); done(); });
		control.listen(0, "127.0.0.1"); await once(control, "listening");
		console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/threads/${nextId}`, stop: `http://127.0.0.1:${control.address().port}`, token, socket, dir }));
		await finished; control.close();
	}
} finally {
	for (const ws of clients) ws.close();
	try { tmux("send-keys", "C-d"); await delay(600); tmux("kill-server"); } catch {}
	await tower?.shutdown(); rmSync(dir, { recursive: true, force: true });
}
