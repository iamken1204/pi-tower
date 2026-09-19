// Process-owning public pi RPC host. Only the runner can feed this child's stdin.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { checkpoint, durableWrite, loadCheckpoint, readJson, syncFile } from "./storage.mjs";
import { holdWriterLock } from "./lock.mjs";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { collaborationSkills, registerCollaborationTools, taskPrompt, deliverResult } from "./collaboration-runtime.mjs";

const [packageDir, recordFile] = process.argv.slice(2);
// Never closed: only OS process teardown releases this lock.
holdWriterLock(resolve(recordFile, "../runtime.sqlite"));
const record = readJson(recordFile);
const saved = loadCheckpoint(record.checkpointFile, record.sessionFile, record.piSessionId, process.cwd());
const api = await import(pathToFileURL(`${packageDir}/dist/index.js`));
const version = readJson(`${packageDir}/package.json`).version;
if (version !== "0.85.1") throw new Error(`unsupported_pi_version: expected 0.85.1, got ${version}`);
const sm = api.SessionManager.open(record.sessionFile);
if (saved.leafId === null) sm.resetLeaf();
else sm.branch(saved.leafId);
if (JSON.stringify(sm.getEntries()) !== JSON.stringify(saved.entries) || sm.getSessionId() !== record.piSessionId) throw new Error("pi_restore_mismatch");

function save() {
	const value = checkpoint(sm.getHeader(), sm.getEntries(), sm.getLeafId());
	if (value.header.id !== record.piSessionId || value.header.cwd !== process.cwd()) throw new Error("pi_identity_changed");
	// Pi owns JSONL writes. Force its existing file before acknowledging the independent leaf record.
	syncFile(record.sessionFile);
	durableWrite(record.checkpointFile, value);
}

const calls = new Map();
function callRunner(operation, input) {
	const requestId = randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { calls.delete(requestId); reject(new Error("runner_timeout_unknown")); }, 11_000);
		calls.set(requestId, { resolve, reject, timer });
		process.send?.({ type: "collaboration_request", requestId, operation, input });
	});
}
const runtime = await api.createAgentSessionRuntime(async (options) => {
	const services = await api.createAgentSessionServices({ ...options, resourceLoaderOptions: { skillsOverride: (base) => collaborationSkills(api, base), extensionFactories: [(pi) => {
		registerCollaborationTools(pi, callRunner);
		pi.on("session_info_changed", (_, ctx) => process.send?.({ type: "session_name", name: ctx.sessionManager.getSessionName() ?? "" }));
	}] } });
	// Provider registration refreshes asynchronously; resolve availability before model selection.
	await services.modelRuntime.getAvailable();
	return { ...await api.createAgentSessionFromServices({ ...options, services }), services, diagnostics: services.diagnostics };
}, { cwd: process.cwd(), agentDir: api.getAgentDir(), sessionManager: sm });

// All inputs share the preflight barrier, including prompt work before isStreaming.
let admitted = false;
const queue = [];
function enqueue(work) {
	return new Promise((resolve, reject) => { queue.push({ work, resolve, reject }); drain(); });
}
function drain() {
	if (admitted || !queue.length) return;
	const item = queue.shift(); admitted = true;
	void Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => { admitted = false; drain(); });
}
const prompt = runtime.session.prompt.bind(runtime.session);
const abort = runtime.session.abort.bind(runtime.session);
runtime.session.prompt = (text, options) => enqueue(() => prompt(text, options));
runtime.session.abort = async () => {
	for (const item of queue.splice(0)) item.reject(new Error("aborted_before_dispatch"));
	await abort();
};
process.on("message", (message) => {
	if (message.type === "metadata_name" && (sm.getSessionName() ?? "") !== message.name.trim()) {
		runtime.session.setSessionName(message.name);
		save();
		process.send?.({ type: "checkpoint", settled: false });
	}
	if (message.type === "collaboration_response") {
		const call = calls.get(message.requestId);
		if (call) { clearTimeout(call.timer); calls.delete(message.requestId); message.error ? call.reject(new Error(message.error)) : call.resolve(message.result); }
	}
	if (message.type === "collaboration_task") {
		const task = message.task;
		let started = false;
		void enqueue(async () => {
			const file = resolve(recordFile, `../task-${task.taskId}.json`);
			if (existsSync(file)) throw new Error("task_already_dispatched");
			durableWrite(file, { task, started: true, status: "running" });
			started = true;
			process.send?.({ type: "collaboration_state", task, status: "running" });
			await prompt(taskPrompt(task), { expandPromptTemplates: false, source: "rpc" });
			save();
		}).finally(() => {
			process.send?.({ type: "collaboration_state", task, status: started ? "unknown" : "rejected" });
			process.send?.({ type: "collaboration_command_done", commandId: task.commandId, status: started ? "unknown" : "rejected" });
		}).catch(() => {});
	}
	if (message.type === "collaboration_notify") void enqueue(() => deliverResult(runtime.session, message.task, recordFile, save)).then(
		(result) => process.send?.({ type: "collaboration_notification_done", requestId: message.requestId, result }),
		(error) => process.send?.({ type: "collaboration_notification_done", requestId: message.requestId, error: error.message }));
});

let checkpointTimer;
runtime.session.subscribe((event) => {
	if (event.type === "message_end" && !checkpointTimer) {
		checkpointTimer = setTimeout(() => {
			checkpointTimer = null;
			try { save(); process.send?.({ type: "checkpoint", settled: false }); }
			catch { process.send?.({ type: "checkpoint_error" }); process.exit(1); }
		}, 50);
	}
	if (event.type === "agent_settled") {
		clearTimeout(checkpointTimer); checkpointTimer = null;
		try { save(); process.send?.({ type: "checkpoint", settled: true }); }
		catch { process.send?.({ type: "checkpoint_error" }); process.exit(1); }
	}
});
runtime.setBeforeSessionInvalidate(() => {
	clearTimeout(checkpointTimer);
	save();
	process.send?.({ type: "saved_shutdown" });
});
// RPC binds extensions before accepting stdin. Its ready get_state response is the startup barrier.
await api.runRpcMode(runtime);
