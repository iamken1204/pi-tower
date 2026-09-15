// Native TUI + public SDK, isolated profile and faux provider. Requires tmux.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.argv[2] === "host") {
	const { InteractiveMode, SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } =
		await import(pathToFileURL(`${process.env.PI_COMPAT_PACKAGE}/dist/index.js`));
	const runtime = await createAgentSessionRuntime(async (options) => {
		const services = await createAgentSessionServices(options);
		return { ...await createAgentSessionFromServices({ ...options, services }), services, diagnostics: services.diagnostics };
	}, { cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: SessionManager.create(process.cwd()) });
	const tui = new InteractiveMode(runtime);
	await tui.init();
	const extensionRunner = runtime.session.extensionRunner;
	const native = extensionRunner.getUIContext();
	let dialog;
	extensionRunner.setUIContext({ ...native, confirm: async (title, message, options) => {
		const controller = new AbortController();
		const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		const remote = new Promise((resolve) => { dialog = { title, resolve }; });
		try { return await Promise.race([remote, native.confirm(title, message, { ...options, signal })]); }
		finally { controller.abort(); dialog = undefined; }
	} }, "tui");
	const server = createServer(async (req, res) => {
		let text = ""; for await (const chunk of req) text += chunk;
		const input = text ? JSON.parse(text) : {};
		if (req.url === "/prompt") {
			void runtime.session.prompt(input.text, { source: "rpc", streamingBehavior: "followUp" }).catch((error) => {
				writeFileSync(process.env.PROBE_ERROR, error.stack);
			});
		} else if (req.url === "/answer") dialog?.resolve(input.value);
		else if (req.url === "/disconnect") server.close();
		res.end(JSON.stringify({ id: runtime.session.sessionManager.getSessionId(), entries: runtime.session.sessionManager.getEntries(),
			idle: runtime.session.isIdle, pending: runtime.session.pendingMessageCount, dialog: dialog?.title ?? null }));
	});
	server.listen(process.env.PROBE_SOCKET);
	await tui.run();
} else {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const dir = mkdtempSync(resolve(tmpdir(), "pi-tui-"));
	const socket = resolve(dir, "rpc.sock");
	const tmuxSocket = resolve(dir, "tmux.sock");
	const tmux = (...args) => execFileSync("tmux", ["-S", tmuxSocket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const pkg = process.env.PI_COMPAT_PACKAGE || resolve(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
	const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
	const rpc = (path = "/state", input = {}) => new Promise((resolve, reject) => {
		const req = httpRequest({ socketPath: socket, path, method: "POST" }, (res) => {
			let data = ""; res.on("data", (chunk) => { data += chunk; }); res.on("end", () => resolve(JSON.parse(data)));
		});
		req.on("error", reject); req.end(JSON.stringify(input));
	});
	const until = async (fn, label) => {
		for (let n = 0; n < 150; n++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); }
		throw new Error(`timeout: ${label}\n${tmux("capture-pane", "-p", "-S", "-100")}`);
	};
	const send = (text) => { tmux("send-keys", "-l", text); tmux("send-keys", "Enter"); };
	const hasUser = (state, text) => state.entries.some((entry) => entry.message?.role === "user" && JSON.stringify(entry.message.content).includes(text));
	try {
		for (const name of ["home", "agent/extensions", "workspace"]) mkdirSync(resolve(dir, name), { recursive: true });
		const fixture = readFileSync(resolve(root, "test/compat/managed-extension.mjs"), "utf8");
		writeFileSync(resolve(dir, "agent/extensions/fixture.js"), fixture.replace("tokensPerSecond: 0", "tokensPerSecond: 4"));
		writeFileSync(resolve(dir, "agent/settings.json"), JSON.stringify({ defaultProvider: "phase1", defaultModel: "faux-1", compaction: { enabled: false }, quietStartup: true }));
		const env = { HOME: resolve(dir, "home"), PI_CODING_AGENT_DIR: resolve(dir, "agent"), PI_OFFLINE: "1", PI_COMPAT_PACKAGE: pkg,
			MANAGED_TEST_LOG: resolve(dir, "starts.jsonl"), PROBE_SOCKET: socket, PROBE_ERROR: resolve(dir, "error.txt") };
		const command = `env ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} host`;
		tmux("-f", "/dev/null", "new-session", "-d", "-s", "probe", "-x", "120", "-y", "40", "-c", resolve(dir, "workspace"), command);
		await until(async () => { try { return (await rpc()).idle; } catch { return false; } }, "native TUI ready");
		const original = await rpc();
		send("local-first-73");
		await until(async () => { const state = await rpc(); return state.idle && hasUser(state, "local-first-73"); }, "local turn");
		await rpc("/prompt", { text: "remote-second-29" });
		await until(async () => { const state = await rpc(); return state.idle && hasUser(state, "remote-second-29"); }, "remote turn");
		await until(async () => tmux("capture-pane", "-p", "-S", "-100").includes("remote-second-29"), "remote prompt appears in native TUI");
		send("slow");
		await until(async () => !(await rpc()).idle, "busy native turn");
		await rpc("/prompt", { text: "queued-remote-41" });
		assert.equal((await rpc()).pending, 1, "remote message queues while native run is active");
		await until(async () => { const state = await rpc(); return state.idle && hasUser(state, "queued-remote-41"); }, "remote follow-up");
		send("dialog");
		await until(async () => (await rpc()).dialog, "local confirm mirrored");
		await rpc("/answer", { value: true });
		await until(async () => (await rpc()).idle, "remote answer closes native confirm");
		send("after-dialog-83");
		await until(async () => { const state = await rpc(); return state.idle && hasUser(state, "after-dialog-83"); }, "native editor restored");
		const beforeDisconnect = await rpc();
		assert.equal(beforeDisconnect.id, original.id);
		assert.ok(beforeDisconnect.entries.some((entry) => entry.customType === "dialog-answer" && entry.data.confirmed === true));
		await rpc("/disconnect");
		send("offline-local-97");
		await until(async () => tmux("capture-pane", "-p", "-S", "-100").includes("offline-local-97"), "local input after transport loss");
		// Wait for a real assistant response after the offline user, not merely editor echo.
		await until(async () => {
			const screen = tmux("capture-pane", "-p", "-S", "-100");
			return screen.slice(screen.lastIndexOf("offline-local-97")).includes("已完成");
		}, "offline local answer");
		console.log("ok native pi TUI: same session local/remote input, remote follow-up during local run, remote confirm answer closes native dialog, local continues after transport closes; no LLM calls");
	} finally {
		try { tmux("send-keys", "C-d"); await new Promise((r) => setTimeout(r, 500)); tmux("kill-server"); } catch { /* TUI may already have exited. */ }
		rmSync(dir, { recursive: true, force: true });
	}
}
