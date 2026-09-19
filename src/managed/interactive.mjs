// One native pi runtime owns the session; Tower is another input transport.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ManagedRunner } from "./runner.mjs";
import { checkpoint, durableWrite, firstPrompt, loadCheckpoint, readJson, syncFile } from "./storage.mjs";
import { holdWriterLock } from "./lock.mjs";
import { loadPi } from "./pi-sdk.mjs";
import { collaborationSkills, registerCollaborationTools, taskPrompt, deliverResult } from "./collaboration-runtime.mjs";

export async function runInteractive(options) {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("interactive_requires_terminal");
	const runner = new ManagedRunner({ ...options, idleTtlMs: 0 });
	const api = await loadPi(runner.piPackage);
	let runtime, current;
	const guards = new Map();
	const publish = () => { if (runner.ws?.readyState === 1) runner.announce(); };
	function attach(session, entry) {
		if (entry.native?.session === session && entry.native.ui === session.extensionRunner.getUIContext()) return;
		entry.native?.dispose();
		entry.detach?.();
		current = entry;
		const sm = session.sessionManager;
		let admission = false;
		let abortRequested = false;
		const queued = [];
		const pending = new Map();
		let disposed = false;
		const originalPrompt = session.prompt.bind(session);
		const originalAbort = session.abort.bind(session);
		session.abort = async () => {
			abortRequested = true;
			for (const id of pending.keys()) pending.set(id, false);
			for (const item of queued.splice(0)) item.reject(new Error("aborted_before_dispatch"));
			for (const [id, answer] of answers) {
				answer(entry.dialogs.get(id)?.method === "confirm" ? false : undefined);
				answers.delete(id);
			}
			session.clearQueue();
			await originalAbort();
		};
		const answers = new Map();
		let savedHash;
		const notify = () => {
			session.extensionRunner.getUIContext().setStatus("tower-queue", queued.length ? `Web follow-up: ${queued.length}` : undefined);
			runner.emit?.({ type: "runtime_state", ...runner.info(entry.record.threadId) });
		};
		const save = (settled = session.isIdle) => {
			const value = checkpoint(sm.getHeader(), sm.getEntries(), sm.getLeafId());
			if (value.hash !== savedHash) {
				syncFile(entry.record.sessionFile); durableWrite(entry.record.checkpointFile, value);
				savedHash = value.hash;
			}
			runner.stageSnapshot(entry, settled); void runner.syncSnapshot(entry);
		};
		// Custom extension commands can append entries without an agent/message event.
		const checkpointTimer = setInterval(() => save(), 5000);
		const drain = () => {
			if (admission || entry.dialogs.size || disposed) return;
			const next = queued.shift();
			if (next) void submit(next.message, next.opts, next.commandId).then(next.resolve, next.reject);
			else { entry.state = "idle"; notify(); }
		};
		// Set the admission barrier before pi's asynchronous input/auth/extension preflight.
		// Both the native TUI and remote calls enter this public method.
		const submit = (text, opts = {}, commandId) => {
			const behavior = opts.streamingBehavior ?? "followUp";
			if (admission || entry.dialogs.size) {
				if (behavior === "steer" && session.isStreaming) return session.steer(text, opts.images).then(() => session.waitForIdle());
				return new Promise((resolve, reject) => { queued.push({ message: text, behavior, opts, commandId, resolve, reject }); notify(); });
			}
			entry.activeCommand = commandId ?? randomUUID();
			abortRequested = false;
			entry.record.runId = entry.activeCommand; entry.state = "running";
			durableWrite(entry.recordFile, entry.record);
			admission = true;
			notify();
			if (opts.task) runner.taskState(entry, opts.task, "running");
			const work = opts.notification ? deliverResult(session, opts.notification, entry.recordFile, save)
				: originalPrompt(opts.task ? taskPrompt(opts.task) : text, { ...opts, expandPromptTemplates: opts.task ? false : opts.expandPromptTemplates });
			return work.finally(() => {
				if (opts.task) runner.taskState(entry, opts.task, "unknown");
				admission = false; drain();
			});
		};
		session.prompt = (text, opts) => submit(text, opts);
		const native = session.extensionRunner.getUIContext();
		const composed = { ...native };
		for (const method of ["select", "confirm", "input", "editor"]) {
			composed[method] = async (...args) => {
				const [title, content] = args;
				const id = randomUUID();
				const controller = new AbortController();
				const dialog = { id, method, title, localOnly: method === "editor",
					...(method === "select" ? { options: content } : method === "confirm" ? { message: content } : { prefill: content }) };
				if (!admission) entry.activeCommand = randomUUID();
				entry.dialogs.set(id, dialog); entry.state = "waiting_input"; notify();
				try {
					if (method === "editor") return await native.editor(...args);
					const settings = args[2] ?? {};
					args[2] = { ...settings, signal: settings.signal ? AbortSignal.any([settings.signal, controller.signal]) : controller.signal };
					return await Promise.race([new Promise((resolve) => answers.set(id, resolve)), native[method](...args)]);
				} finally {
					controller.abort(); answers.delete(id); entry.dialogs.delete(id);
					entry.state = admission ? "running" : "idle"; notify();
					setTimeout(() => { if (!disposed) { save(); drain(); } }, 50);
				}
			};
		}
		session.extensionRunner.setUIContext(composed, "tui");
		entry.native = { session, ui: session.extensionRunner.getUIContext(),
			entries: () => ({ entries: sm.getEntries(), leafId: sm.getLeafId() }),
			notify: (task) => submit(`Task report ${task.taskId}`, { notification: task }),
			queue: () => [...queued.map(({ message, behavior }) => ({ message, behavior })),
				...session.getSteeringMessages().map((message) => ({ message, behavior: "steer" })),
				...session.getFollowUpMessages().map((message) => ({ message, behavior: "followUp" }))],
			async command(input) {
				const { operation, commandId } = input;
				if (operation === "prompt") {
					if (entry.syncError || entry.cloudCheck) throw new Error("sync_not_ready");
					pending.set(commandId, true);
					runner.commandStatus(entry, commandId, "accepted");
					void submit(input.message, { source: "rpc", streamingBehavior: input.behavior ?? "followUp", task: input.task }, commandId).then(() => {
						if (disposed) return;
						save();
						runner.commandStatus(entry, commandId, pending.get(commandId) ? "settled" : "unknown"); pending.delete(commandId);
					}, () => {
						if (input.task) {
							const file = runner.taskFile(entry, input.task.taskId);
							runner.taskState(entry, input.task, existsSync(file) && readJson(file).started ? "unknown" : "rejected");
						}
						runner.commandStatus(entry, commandId, "unknown"); pending.delete(commandId);
					});
					return;
				}
				if (input.targetRunId !== entry.activeCommand) throw new Error("stale_run");
				if (operation === "abort") {
					await session.abort();
				} else {
					const dialog = entry.dialogs.get(input.dialogId);
					if (!dialog || !answers.has(input.dialogId) || dialog.localOnly ||
						(dialog.method === "confirm" ? typeof input.value !== "boolean" : typeof input.value !== "string") ||
						(dialog.method === "select" && !dialog.options.includes(input.value))) throw new Error("stale_or_invalid_dialog");
					const answer = answers.get(input.dialogId); answers.delete(input.dialogId); answer(input.value);
				}
				runner.commandStatus(entry, commandId, "settled");
			},
			save,
			dispose() {
				disposed = true;
				clearInterval(checkpointTimer);
				session.prompt = originalPrompt;
				session.abort = originalAbort;
				for (const item of queued.splice(0)) item.reject(new Error("session_changed"));
				for (const id of pending.keys()) runner.commandStatus(entry, id, "unknown");
			},
		};
		entry.state = "idle";
		entry.detach = session.subscribe((event) => {
			if (event.type === "agent_start") {
				entry.state = "running"; entry.activeCommand ??= randomUUID();
				if (abortRequested) void session.abort();
			}
			if (event.type === "agent_settled") { entry.state = "idle"; save(true); }
			if (event.type === "message_end") setTimeout(() => { if (entry.native?.session === session) save(session.isIdle); }, 50);
			runner.emit?.({ type: "pi_event", threadId: entry.record.threadId, bootId: runner.bootId, runId: entry.activeCommand, sequence: ++entry.sequence, event });
			notify();
		});
		entry.record.awake = true; durableWrite(entry.recordFile, entry.record); save(); publish();
	}
	const initial = await chooseThread(runner, options);
	guards.set(initial.recordFile, holdWriterLock(resolve(initial.recordFile, "../runtime.sqlite")));
	const saved = loadCheckpoint(initial.record.checkpointFile, initial.record.sessionFile, initial.record.piSessionId, initial.record.effectiveCwd);
	if (realpathSync(initial.record.effectiveCwd) !== initial.record.effectiveCwd) throw new Error("workspace_changed");
	process.chdir(initial.record.effectiveCwd);
	let manager = api.SessionManager.open(initial.record.sessionFile);
	saved.leafId === null ? manager.resetLeaf() : manager.branch(saved.leafId);
	const factory = async (opts) => {
		let entry = [...runner.threads.values()].find((item) => item.record.piSessionId === opts.sessionManager.getSessionId());
		if (!entry) {
			const id = randomUUID(); runner.prepare(id); entry = runner.threads.get(id);
			const sm = opts.sessionManager;
			const value = checkpoint(sm.getHeader(), sm.getEntries(), sm.getLeafId());
			entry.record.piSessionId = value.header.id; entry.record.effectiveCwd = value.header.cwd;
			writeFileSync(entry.record.sessionFile, [value.header, ...value.entries].map(JSON.stringify).join("\n") + "\n", { mode: 0o600 });
			syncFile(entry.record.sessionFile); durableWrite(entry.record.checkpointFile, value);
			opts.sessionManager = api.SessionManager.open(entry.record.sessionFile);
			value.leafId === null ? opts.sessionManager.resetLeaf() : opts.sessionManager.branch(value.leafId);
		}
		if (!guards.has(entry.recordFile)) guards.set(entry.recordFile, holdWriterLock(resolve(entry.recordFile, "../runtime.sqlite")));
		entry.record.interactive = true;
		if (!entry.record.registered) entry.record.registration ??= { createKey: entry.record.threadId, title: opts.sessionManager.getSessionName() ?? "", createdAt: new Date().toISOString() };
		entry.record.localName ??= opts.sessionManager.getSessionName() ?? "";
		durableWrite(entry.recordFile, entry.record);
		let session;
		const services = await api.createAgentSessionServices({ ...opts, resourceLoaderOptions: { skillsOverride: (base) => collaborationSkills(api, base), extensionFactories: [(pi) => {
			registerCollaborationTools(pi, (operation, input) => runner.collaborationTool(entry, operation, input));
			pi.on("session_start", () => { queueMicrotask(() => attach(session, entry)); });
			pi.on("session_info_changed", (_, ctx) => runner.observeName(entry, ctx.sessionManager.getSessionName() ?? ""));
			for (const event of ["session_tree", "session_compact", "session_info_changed"]) pi.on(event, () => {
				queueMicrotask(() => entry.native?.save());
			});
			pi.on("session_shutdown", () => {
				entry.native?.save(); entry.native?.dispose(); entry.detach?.(); entry.native = null; entry.state = "sleeping";
				entry.record.awake = false; durableWrite(entry.recordFile, entry.record); publish();
			});
		}] } });
		// Provider registration refreshes asynchronously; resolve availability before model selection.
		await services.modelRuntime.getAvailable();
		const created = await api.createAgentSessionFromServices({ ...opts, services }); session = created.session;
		return { ...created, services, diagnostics: services.diagnostics };
	};
	runtime = await api.createAgentSessionRuntime(factory, { cwd: initial.record.effectiveCwd, agentDir: api.getAgentDir(), sessionManager: manager });
	const tui = new api.InteractiveMode(runtime);
	await tui.init();
	attach(runtime.session, initial);
	runner.connect(options);
	process.on("exit", () => {
		try { current?.native?.save(); if (current) { current.record.awake = false; durableWrite(current.recordFile, current.record); } } catch { /* Recovery validates any interrupted append on next start. */ }
	});
	await tui.run();
}

// Like native pi: --thread names one, -c continues the newest thread of this cwd, -r picks among them, otherwise start fresh here.
// A terminal only ever hosts terminal threads; browser-created ones stay with the headless wrapper.
async function chooseThread(runner, options) {
	if (options.threadId) {
		const entry = runner.adopt(options.threadId);
		if (!entry.record.interactive) throw new Error("thread_is_headless: browser-created threads run in the --managed-threads runner");
		return entry;
	}
	const recent = runner.records().filter(({ record }) => record.interactive && record.effectiveCwd === runner.cwd)
		.sort((a, b) => statSync(b.record.checkpointFile).mtimeMs - statSync(a.record.checkpointFile).mtimeMs);
	if (options.resume) return runner.adopt(await pickThread(recent));
	if (options.continueRecent && recent.length) return runner.adopt(recent[0].threadId);
	const id = randomUUID();
	runner.prepare(id);
	const entry = runner.threads.get(id);
	entry.record.interactive = true;
	durableWrite(entry.recordFile, entry.record);
	return entry;
}

async function pickThread(items) {
	if (!items.length) throw new Error("no_threads_in_workspace");
	for (const [index, { record }] of items.entries()) {
		const preview = firstPrompt(readJson(record.checkpointFile).entries).slice(0, 60) || "(untitled)";
		console.log(`${index + 1}. ${statSync(record.checkpointFile).mtime.toLocaleString()}  ${preview}`);
	}
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await prompt.question("Resume thread: ");
	prompt.close();
	const chosen = items[Number(answer) - 1];
	if (!chosen) throw new Error("invalid_choice");
	return chosen.threadId;
}
