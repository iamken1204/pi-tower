// Real Tower, runners, SQLite and pi; only model responses are scripted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

if (process.argv[2] !== "worker") {
	const dir = mkdtempSync(resolve(tmpdir(), "pi-collaboration-"));
	const pkg = process.env.PI_COMPAT_PACKAGE || resolve(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
	try {
		for (const name of ["home", "agent/extensions", "source-project", "docs-project", "tests-project"]) mkdirSync(resolve(dir, name), { recursive: true });
		writeFileSync(resolve(dir, "agent/settings.json"), JSON.stringify({ defaultProvider: "collaboration", defaultModel: "faux-1", compaction: { enabled: false } }));
		writeFileSync(resolve(dir, "agent/extensions/fixture.js"), `
import { appendFileSync, existsSync } from "node:fs";
const { fauxProvider, fauxAssistantMessage } = await import(process.env.PI_COMPAT_PACKAGE + "/node_modules/@earendil-works/pi-ai/dist/index.js");
export default function(pi) {
 const provider = fauxProvider({ provider: "collaboration", tokensPerSecond: 0 });
 pi.registerProvider(provider.provider);
 pi.on("before_agent_start", async (event) => {
  const taskId = /^Task ([0-9a-f-]+) from runner/.exec(event.prompt)?.[1];
  if (taskId) {
   appendFileSync(process.env.PROBE_ROOT + "/starts.jsonl", JSON.stringify({taskId,pid:process.pid,cwd:process.cwd()}) + "\\n");
   if (event.prompt.includes("barrier")) while (!existsSync(process.env.PROBE_ROOT + "/release")) await new Promise(r => setTimeout(r, 20));
   provider.setResponses(event.prompt.includes("no-report") ? [fauxAssistantMessage("This is only an ordinary answer")]
    : [fauxAssistantMessage({type:"toolCall",id:taskId,name:"thread_report",arguments:{taskId,outcome:"completed",summary:"Result for " + taskId}}, {stopReason:"toolUse"}), fauxAssistantMessage("User-facing answer, not a report")]);
  } else provider.setResponses(Array.from({length:30}, () => fauxAssistantMessage("Ordinary answer")));
 });
}`);
		execFileSync(process.execPath, [fileURLToPath(import.meta.url), "worker"], { cwd: resolve(dir, "source-project"), stdio: "inherit", timeout: 100_000,
			env: { PATH: process.env.PATH, HOME: resolve(dir, "home"), PI_CODING_AGENT_DIR: resolve(dir, "agent"), PI_OFFLINE: "1", PI_COMPAT_PACKAGE: pkg, PROBE_ROOT: dir } });
	} finally { rmSync(dir, { recursive: true, force: true }); }
} else {
	const { createTower } = await import("../src/tower.mjs");
	const { ManagedRunner } = await import("../src/managed/runner.mjs");
	const dir = process.env.PROBE_ROOT, token = "isolated-collaboration";
	const tower = createTower({ token, dataDir: resolve(dir, "tower") });
	tower.listen(0, "127.0.0.1"); await once(tower, "listening");
	const port = tower.address().port, runners = [];
	const api = (path) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
	const until = async (predicate, label) => { for (let n = 0; n < 500; n++) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error(`timeout: ${label}`); };
	const starts = () => existsSync(resolve(dir, "starts.jsonl")) ? readFileSync(resolve(dir, "starts.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
	try {
		for (const [id, project] of [["A", "source-project"], ["B", "docs-project"], ["C", "tests-project"]]) {
			const runner = new ManagedRunner({ id, dataDir: resolve(dir, `runner-${id}`), cwd: resolve(dir, project), piPackage: process.env.PI_COMPAT_PACKAGE, idleTtlMs: 0 });
			const threadId = randomUUID(); runner.prepare(threadId);
			const entry = runner.threads.get(threadId);
			entry.record.registration = { createKey: threadId, title: `Thread ${id}`, createdAt: new Date().toISOString() };
			runner.connect({ hq: `ws://127.0.0.1:${port}`, token });
			runners.push({ runner, entry, threadId });
		}
		const [a, b, c] = runners;
		await until(async () => (await api("/api/threads")).threads?.filter((t) => t.canDelegate).length === 3, "all threads synced");
		await a.runner.open(a.entry);
		const call = (who, op, input = {}) => who.runner.collaborationTool(who.entry, op, input);
		const metadata = await call(a, "thread_metadata");
		await call(a, "thread_metadata", { title: "", metadataVersion: metadata.metadataVersion });
		while (a.entry.metadataSyncing) await new Promise((done) => setTimeout(done, 1));
		await a.runner.syncMetadata(a.entry);
		await until(async () => !(await a.runner.rpc(a.entry.runtime, "get_state")).sessionName, "blank Tower name reaches background pi via public session API");
		assert.equal((await a.runner.rpc(a.entry.runtime, "get_entries")).entries.filter((entry) => entry.type === "session_info").at(-1).name, "");
		const listing = await call(a, "thread_list");
		assert.deepEqual(listing.threads.map((t) => t.runnerId).sort(), ["B", "C"]);
		assert.equal((await call(a, "thread_list", { project: "docs-project" })).threads[0].threadId, b.threadId);
		const requestId = randomUUID();
		const taskB = await call(a, "thread_delegate", { requestId, targetThreadId: b.threadId, prompt: "barrier B" });
		const taskC = await call(a, "thread_delegate", { requestId: randomUUID(), targetThreadId: c.threadId, prompt: "barrier C" });
		assert.ok(["accepted", "running"].includes(taskB.status), JSON.stringify(taskB));
		await until(() => starts().length === 2, "both targets simultaneously inside execution barrier");
		assert.equal(new Set(starts().map((s) => s.pid)).size, 2);
		assert.equal((await call(a, "thread_delegate", { requestId, targetThreadId: b.threadId, prompt: "barrier B" })).taskId, taskB.taskId);
		await assert.rejects(call(a, "thread_delegate", { requestId, targetThreadId: b.threadId, prompt: "different" }), /conflict/);
		await assert.rejects(call(c, "thread_report", { taskId: taskB.taskId, outcome: "completed", summary: "forged" }), /not_started/);
		const queued = await call(c, "thread_delegate", { requestId: randomUUID(), targetThreadId: b.threadId, prompt: "second B" });
		assert.equal(starts().length, 2, "queued B task cannot start a second writer");
		await a.runner.rpc(a.entry.runtime, "prompt", { message: "independent source work" });
		await until(async () => JSON.stringify(await a.runner.rpc(a.entry.runtime, "get_entries")).includes("independent source work"), "source progresses while both targets blocked");
		writeFileSync(resolve(dir, "release"), "release");
		await until(async () => (await call(a, "thread_tasks", { taskId: taskB.taskId })).tasks[0]?.result, "B explicit report");
		await until(async () => (await call(a, "thread_tasks", { taskId: taskC.taskId })).tasks[0]?.result, "C explicit report");
		await until(async () => (await call(c, "thread_tasks", { taskId: queued.taskId })).tasks[0]?.result, "B FIFO second report");
		assert.deepEqual(starts().filter((s) => s.cwd.endsWith("docs-project")).map((s) => s.taskId), [taskB.taskId, queued.taskId]);
		await until(async () => (await call(a, "thread_tasks", { taskId: taskB.taskId })).tasks[0]?.notificationStatus === "delivered", "source automatically receives result");
		const entries = await a.runner.rpc(a.entry.runtime, "get_entries");
		assert.equal(entries.entries.filter((e) => e.customType === "tower-collaboration-result" && e.details.taskId === taskB.taskId).length, 1);
		const noReport = await call(a, "thread_delegate", { requestId: randomUUID(), targetThreadId: b.threadId, prompt: "no-report" });
		await until(async () => (await call(a, "thread_tasks", { taskId: noReport.taskId })).tasks[0]?.status === "unknown", "ordinary answer stays unknown");
		assert.equal((await call(a, "thread_tasks", { taskId: noReport.taskId })).tasks[0].result, null);
		console.log(`ok real pi ${JSON.parse(readFileSync(resolve(process.env.PI_COMPAT_PACKAGE, "package.json"))).version}, Bun ${Bun.version}: cross-project discovery, parallel targets, nonblocking source, FIFO writer, explicit reports, auto receipt, dedup and unknown`);
	} finally {
		writeFileSync(resolve(dir, "release"), "cleanup");
		for (const { runner } of runners) await runner.close();
		await new Promise((r) => tower.close(r));
	}
}
