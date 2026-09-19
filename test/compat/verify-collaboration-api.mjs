// Public SDK gate. The parent supplies an empty HOME and a network-free provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.argv[2] !== "worker") {
	const dir = mkdtempSync(resolve(tmpdir(), "pi-collaboration-api-"));
	const pkg = process.env.PI_COMPAT_PACKAGE || resolve(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
	try {
		for (const name of ["home", "agent", "workspace"]) mkdirSync(resolve(dir, name));
		execFileSync(process.execPath, [fileURLToPath(import.meta.url), "worker"], {
			cwd: resolve(dir, "workspace"), stdio: "inherit", timeout: 60_000,
			env: { PATH: process.env.PATH, HOME: resolve(dir, "home"), PI_CODING_AGENT_DIR: resolve(dir, "agent"), PI_OFFLINE: "1", PI_COMPAT_PACKAGE: pkg },
		});
	} finally { rmSync(dir, { recursive: true, force: true }); }
} else {
	const pkg = process.env.PI_COMPAT_PACKAGE;
	const api = await import(pathToFileURL(`${pkg}/dist/index.js`));
	const { fauxProvider, fauxAssistantMessage } = await import(pathToFileURL(`${pkg}/node_modules/@earendil-works/pi-ai/dist/index.js`));
	console.log(`collaboration public API: Bun ${Bun.version}, pi ${JSON.parse(readFileSync(`${pkg}/package.json`)).version}`);
	let activeTask, release, entered;
	const reports = [];
	const factory = async (options) => {
		const provider = fauxProvider({ provider: "collaboration-gate", tokensPerSecond: 0 });
		const services = await api.createAgentSessionServices({ ...options, resourceLoaderOptions: {
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => {
				pi.registerProvider(provider.provider);
				pi.registerTool({ name: "thread_report", label: "Report", description: "Report the active task",
					parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
					async execute(_, args) {
						assert.equal(args.taskId, activeTask);
						pi.appendEntry("gate-report", { taskId: args.taskId }); reports.push(args.taskId);
						return { content: [{ type: "text", text: "recorded" }], details: { taskId: args.taskId } };
					} });
				pi.on("before_agent_start", async (event) => {
					if (event.prompt === "busy") { entered(); await new Promise((r) => { release = r; }); }
					provider.setResponses(activeTask ? [fauxAssistantMessage({ type: "toolCall", id: `call-${activeTask}`, name: "thread_report", arguments: { taskId: activeTask } }, { stopReason: "toolUse" }), fauxAssistantMessage("ordinary answer")]
						: Array.from({ length: 10 }, () => fauxAssistantMessage("ordinary answer")));
				});
			}] } });
		return { ...await api.createAgentSessionFromServices({ ...options, services, model: provider.getModel(), noTools: "builtin" }), services, diagnostics: services.diagnostics };
	};
	const runtime = await api.createAgentSessionRuntime(factory, { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: api.SessionManager.create(process.cwd()) });
	runtime.setRebindSession((session) => session.bindExtensions({}));
	await runtime.session.bindExtensions({});
	try {
		activeTask = "task-73";
		await runtime.session.prompt("delegated work", { expandPromptTemplates: false });
		activeTask = undefined;
		assert.deepEqual(reports, ["task-73"]);
		await runtime.session.prompt("user answer is not a report");
		assert.deepEqual(reports, ["task-73"]);
		console.log("ok registered tool executes in real pi; explicit task report persists; ordinary answer cannot report");
		const originalId = runtime.session.sessionManager.getSessionId();
		const file = runtime.session.sessionManager.getSessionFile();
		const hasNotification = (id) => runtime.session.sessionManager.getEntries().filter((e) => e.customType === "gate-result" && e.details.notificationId === id);
		const deliver = async (id, thread = originalId) => {
			if (runtime.session.sessionManager.getSessionId() !== thread) return "wrong_thread";
			if (hasNotification(id).length) return "duplicate";
			await runtime.session.sendCustomMessage({ customType: "gate-result", content: `Result ${id}`, display: true, details: { notificationId: id, taskId: "task-73" } }, { triggerTurn: true, deliverAs: "followUp" });
			return "delivered";
		};
		await deliver("idle-29"); await runtime.session.waitForIdle();
		assert.equal(hasNotification("idle-29").length, 1);
		assert.equal(await deliver("idle-29"), "duplicate");
		const barrier = new Promise((r) => { entered = r; });
		const busy = runtime.session.prompt("busy"); await barrier;
		// The host's admission queue includes asynchronous prompt preflight, when
		// pi can still report idle. Do not race sendCustomMessage against it.
		const delivery = busy.then(() => deliver("busy-41"));
		release(); await busy; await delivery; await runtime.session.waitForIdle();
		assert.equal(hasNotification("busy-41").length, 1);
		assert.equal(runtime.session.sessionManager.getEntries().at(-1).message.role, "assistant");
		console.log("ok idle and busy automatic custom follow-up with structured ID and persisted answer");
		await runtime.session.reload();
		assert.equal(await deliver("busy-41"), "duplicate");
		await runtime.newSession();
		assert.equal(await deliver("new-53"), "wrong_thread");
		assert.equal(hasNotification("busy-41").length, 0);
		await runtime.switchSession(file);
		assert.equal(await deliver("idle-29"), "duplicate");
		assert.equal(runtime.session.sessionManager.getEntries().filter((e) => e.customType === "gate-report").length, 1);
		console.log("ok reload/new/resume preserve task identity; old results never enter the new session");
		runtime.session.dispose();
		const restored = await factory({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: api.SessionManager.open(file) });
		await restored.session.bindExtensions({});
		assert.equal(restored.session.sessionManager.getEntries().filter((e) => e.customType === "gate-result").length, 2);
		restored.session.dispose();
		console.log("ok reopened durable session retains both notification IDs and task report");
	} finally { runtime.session.dispose(); }
}
