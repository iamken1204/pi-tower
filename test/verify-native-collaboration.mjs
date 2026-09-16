// Two real native pi TUIs and Tower; only provider responses are scripted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createTower } from "../tower.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(resolve(tmpdir(), "pi-native-collaboration-"));
const socket = resolve(dir, "tmux.sock");
const token = "isolated-native-collaboration";
const pkg = process.env.PI_COMPAT_PACKAGE || resolve(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const tmux = (...args) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let tower;
const launches = new Map();

const until = async (predicate, label) => {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (await predicate()) return;
		await delay(50);
	}
	const panes = ["A", "B"].map((name) => `--- ${name} ---\n${tmux("capture-pane", "-pt", `${name}:0`, "-S", "-100")}`).join("\n");
	throw new Error(`timeout: ${label}\n${panes}`);
};

try {
	for (const name of ["home", "agent/extensions", "workspace-A", "workspace-B", "runner-A", "runner-B", "tower"]) mkdirSync(resolve(dir, name), { recursive: true });
	writeFileSync(resolve(dir, "agent/settings.json"), JSON.stringify({ defaultProvider: "native-collaboration", defaultModel: "faux-1", compaction: { enabled: false }, quietStartup: true }));
	writeFileSync(resolve(dir, "agent/extensions/fixture.js"), `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const { fauxProvider, fauxAssistantMessage } = await import(process.env.PI_COMPAT_PACKAGE + "/node_modules/@earendil-works/pi-ai/dist/index.js");
export default function(pi) {
 const provider = fauxProvider({ provider: "native-collaboration", tokensPerSecond: 0 });
 pi.registerProvider(provider.provider);
 pi.registerCommand("fixture-name", { handler: async (name) => pi.setSessionName(name) });
 pi.on("before_agent_start", async (event) => {
  appendFileSync(process.env.PROBE_ROOT + "/prompts.jsonl", JSON.stringify({runner:process.env.FIXTURE_RUNNER,prompt:event.prompt,pid:process.pid}) + "\\n");
  const config = existsSync(process.env.PROBE_ROOT + "/fixture.json") ? JSON.parse(readFileSync(process.env.PROBE_ROOT + "/fixture.json", "utf8")) : {};
  const delegated = /^Task ([0-9a-f-]+) from runner/.exec(event.prompt);
  if (delegated) {
   appendFileSync(process.env.PROBE_ROOT + "/target-starts.jsonl", JSON.stringify({taskId:delegated[1],pid:process.pid}) + "\\n");
   if (event.prompt.includes("hold-at-barrier")) while (!existsSync(process.env.PROBE_ROOT + "/release")) await new Promise(r => setTimeout(r, 20));
   provider.setResponses([fauxAssistantMessage({type:"toolCall",id:"report-"+delegated[1],name:"thread_report",arguments:{taskId:delegated[1],outcome:"completed",summary:"native result "+delegated[1]}},{stopReason:"toolUse"}), fauxAssistantMessage("distinct ordinary target assistant text")]);
   return;
  }
  const requestId = config.requests?.[event.prompt];
  if (requestId) provider.setResponses([fauxAssistantMessage({type:"toolCall",id:"delegate-"+requestId,name:"thread_delegate",arguments:{targetThreadId:config.targetThreadId,prompt:["delegate-first", "delegate-pending"].includes(event.prompt) ? "hold-at-barrier" : event.prompt,requestId}},{stopReason:"toolUse"}), fauxAssistantMessage("source delegation admitted")]);
  else provider.setResponses([fauxAssistantMessage("ordinary source answer")]);
 });
}`);

	tower = createTower({ token, dataDir: resolve(dir, "tower") });
	tower.listen(0, "127.0.0.1");
	await once(tower, "listening");
	const port = tower.address().port;
	const api = (path) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } }).then(async (response) => {
		const body = await response.text();
		assert.equal(response.status, 200, `${path}: ${body}`);
		return JSON.parse(body);
	});
	const common = { HOME: resolve(dir, "home"), PI_CODING_AGENT_DIR: resolve(dir, "agent"), PI_OFFLINE: "1", PI_COMPAT_PACKAGE: pkg, PROBE_ROOT: dir };
	for (const name of ["A", "B"]) {
		cpSync(resolve(dir, "agent"), resolve(dir, `agent-${name}`), { recursive: true });
		const env = { ...common, PI_CODING_AGENT_DIR: resolve(dir, `agent-${name}`), FIXTURE_RUNNER: name };
		const args = [process.execPath, resolve(root, "runner.mjs"), "--interactive", "--hq", `ws://127.0.0.1:${port}`, "--id", name, "--token", token, "--data-dir", resolve(dir, `runner-${name}`), "--pi-package", pkg];
		const launch = `env ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} ${args.map(quote).join(" ")}`;
		launches.set(name, launch);
		tmux("-f", "/dev/null", "new-session", "-d", "-s", name, "-x", "120", "-y", "35", "-c", resolve(dir, `workspace-${name}`), launch);
	}
	const send = (runner, text) => { tmux("send-keys", "-t", `${runner}:0`, "-l", text); tmux("send-keys", "-t", `${runner}:0`, "Enter"); };
	let threads;
	await until(async () => { threads = (await api("/api/threads")).threads; return threads?.length === 2 && threads.every((thread) => thread.canDelegate); }, "both native threads register");
	const sourceId = threads.find((thread) => thread.runnerId === "A").threadId;
	const targetId = threads.find((thread) => thread.runnerId === "B").threadId;
	const requests = { "delegate-first": randomUUID(), "delegate-queued": randomUUID(), "delegate-after-reload": randomUUID(), "delegate-pending": randomUUID() };
	writeFileSync(resolve(dir, "fixture.json"), JSON.stringify({ targetThreadId: targetId, requests }));
	const taskFor = async (requestId) => (await api(`/api/threads/${sourceId}/tasks?requestId=${requestId}`)).tasks?.[0];
	const history = (threadId) => api(`/api/threads/${threadId}/history`);
	const starts = () => existsSync(resolve(dir, "target-starts.jsonl")) ? readFileSync(resolve(dir, "target-starts.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];

	send("A", "delegate-first");
	await until(() => starts().length === 1, "B enters delegated-task fixture barrier");
	const first = await taskFor(requests["delegate-first"]);
	assert.ok(["accepted", "running"].includes(first.status), JSON.stringify(first));
	send("A", "native-input-while-B-held");
	await until(async () => JSON.stringify(await history(sourceId)).includes("native-input-while-B-held"), "source accepts another native input while target is busy");
	send("A", "delegate-queued");
	await until(async () => Boolean(await taskFor(requests["delegate-queued"])), "second B task is admitted");
	assert.equal(starts().length, 1, "busy target uses one writer and queues its next task");
	writeFileSync(resolve(dir, "release"), "release");
	await until(async () => (await taskFor(requests["delegate-first"]))?.notificationStatus === "delivered", "first report automatically reaches source");
	await until(async () => (await taskFor(requests["delegate-queued"]))?.notificationStatus === "delivered", "queued report automatically reaches source");
	assert.equal(starts().length, 2);
	const sourceHistory = await history(sourceId), targetHistory = await history(targetId);
	assert.equal(JSON.stringify(sourceHistory).match(new RegExp(`native result ${first.taskId}`, "g"))?.length, 1, "custom result is delivered exactly once");
	assert.ok(JSON.stringify(targetHistory).includes("tower-collaboration-report"), "target history persists thread_report");
	assert.ok(JSON.stringify(targetHistory).includes("distinct ordinary target assistant text"), "ordinary target answer remains distinct from report");

	send("A", "/reload");
	await delay(1000);
	send("A", "delegate-after-reload");
	await until(async () => (await taskFor(requests["delegate-after-reload"]))?.notificationStatus === "delivered", "collaboration tools remain bound after reload");
	send("A", "/fixture-name local name 73");
	await until(async () => (await api(`/api/threads/${sourceId}`)).title === "local name 73", "local name uses versioned Tower update");
	const named = await api(`/api/threads/${sourceId}`);
	assert.ok(named.metadataVersion > 1);
	unlinkSync(resolve(dir, "release"));
	send("A", "delegate-pending");
	await until(() => starts().length === 4, "pending report task starts before source switches");
	const pending = await taskFor(requests["delegate-pending"]);
	send("A", "/new");
	await until(async () => (await api("/api/threads")).threads.length === 3, "source creates a new native thread");
	const newSourceId = (await api("/api/threads")).threads.find((thread) => thread.runnerId === "A" && thread.threadId !== sourceId).threadId;
	assert.ok(!JSON.stringify(await history(newSourceId)).includes(first.taskId), "old collaboration result is absent from new thread");
	assert.equal((await api(`/api/threads/${sourceId}/tasks?requestId=${requests["delegate-first"]}`)).tasks[0].taskId, first.taskId, "authoritative task remains attached to old source thread");
	writeFileSync(resolve(dir, "release"), "release old-thread result");
	await until(async () => (await taskFor(requests["delegate-pending"]))?.result, "target reports after source new");
	assert.equal((await taskFor(requests["delegate-pending"])).notificationStatus, "pending");
	assert.ok(!JSON.stringify(await history(newSourceId)).includes(pending.taskId));
	tmux("kill-session", "-t", "A");
	await until(async () => !(await api("/api/threads")).threads.find((thread) => thread.threadId === sourceId).online, "source exits");
	tmux("new-session", "-d", "-s", "A", "-x", "120", "-y", "35", "-c", resolve(dir, "workspace-A"), `${launches.get("A")} --thread ${quote(sourceId)}`);
	await until(async () => (await taskFor(requests["delegate-pending"]))?.notificationStatus === "delivered", "restarted original source receives pending report");
	await until(async () => JSON.stringify(await history(sourceId)).includes(`native result ${pending.taskId}`), "resumed source saves result");
	assert.equal(JSON.stringify(await history(sourceId)).match(new RegExp(`native result ${pending.taskId}`, "g"))?.length, 1);
	console.log("ok native collaboration: two TUIs, real tool round trip, nonblocking source, FIFO writer, result dedup, report history, reload, versioned name, /new isolation and pending-result recovery after restart");
} finally {
	try { tmux("kill-server"); } catch {}
	await delay(500);
	await tower?.shutdown();
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
