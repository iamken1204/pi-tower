import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createTower } from "../../tower.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const fakeBin = resolve(here, "fixtures/phase0-crash-bin");
const token = "phase0-crash-probe-token";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const owned = new Set();

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
}

async function until(description, fn, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value) return value;
		await pause(25);
	}
	throw new Error(`timed out waiting for ${description}`);
}

async function events(log) {
	try {
		return (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse);
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

async function stopOwned(pid) {
	if (!owned.delete(pid) || !alive(pid)) return;
	process.kill(pid, "SIGTERM");
	for (let i = 0; i < 20 && alive(pid); i++) await pause(25);
	if (alive(pid)) process.kill(pid, "SIGKILL");
}

const server = createTower({ token, idleTtlMs: 0 });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const temp = await mkdtemp(resolve(tmpdir(), "pi-tower-phase0-crash-"));

async function probe(mode) {
	const real = mode.startsWith("real-");
	const pkg = real && (process.env.PI_COMPAT_PACKAGE || resolve(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent"));
	const base = resolve(temp, mode);
	const home = resolve(base, "home");
	const cwd = resolve(base, "cwd");
	const data = resolve(base, "data");
	const log = resolve(base, "fake-pi.jsonl");
	await Promise.all([mkdir(home, { recursive: true }), mkdir(cwd, { recursive: true }), mkdir(data, { recursive: true })]);
	const id = `phase0-crash-${mode}`;
	const piArgs = real ? ["--", "--no-session", "-ne", "-ns", "-np", "--no-themes", "-e", resolve(here, "pi-extension.mjs"), "--provider", "phase0", "--model", "faux-1"] : [];
	const runner = spawn(process.execPath, [resolve(root, "runner.mjs"), "--hq", `ws://127.0.0.1:${port}`, "--id", id, "--token", token, ...piArgs], {
		cwd,
		env: { HOME: home, XDG_DATA_HOME: data, PI_CODING_AGENT_DIR: data, PI_OFFLINE: "1",
			PHASE0_REAL_PI: real ? resolve(pkg, "dist/bundle/cli.js") : "", PI_COMPAT_PACKAGE: pkg || "",
			PI_COMPAT_EVENTS: resolve(base, "events.jsonl"), PHASE0_CRASH_LOG: log, PATH: `${fakeBin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH}` },
		stdio: ["ignore", "ignore", "pipe"],
	});
	owned.add(runner.pid);
	let stderr = "";
	runner.stderr.on("data", (chunk) => (stderr += chunk));
	await until("runner registration", async () =>
		(await fetch(`http://127.0.0.1:${port}/runners`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json())).some(
			(r) => r.id === id,
		),
	);
	const ws = new WebSocket(`ws://127.0.0.1:${port}/attach?runner=${id}&session=probe`, {
		headers: { authorization: `Bearer ${token}` },
	});
	await once(ws, "open");
	const started = await until("fake pi start", async () => (await events(log)).find((event) => event.event === "started"));
	owned.add(started.pid);
	if (real) {
		const frames = [];
		ws.addEventListener("message", (event) => frames.push(JSON.parse(event.data)));
		ws.send(JSON.stringify({ id: "ready", type: "get_state" }));
		await until("real pi RPC ready", () => frames.some((f) => f.id === "ready" && f.success), 15000);
		if (mode === "real-dialog") {
			ws.send(JSON.stringify({ id: "dialog", type: "prompt", message: "/probe-dialogs" }));
			await until("real pi pending dialog", () => frames.some((f) => f.type === "extension_ui_request"));
		}
	}
	if (mode === "busy") {
		const frames = [];
		ws.addEventListener("message", (event) => frames.push(JSON.parse(event.data)));
		ws.send(JSON.stringify({ id: "work", type: "prompt", message: "remain busy" }));
		await until("fake pi busy input", async () => (await events(log)).some((event) => event.event === "busy"));
		await until("fragmented UTF-8 frame", () => frames.length);
		assert.equal(frames.length, 1);
		assert.equal(frames[0].text, "台灣🙂\u2028中段\u2029末段");
		console.log("ok legacy runner: split UTF-8 bytes preserve exact text in one LF frame");
	}

	process.kill(runner.pid, "SIGKILL");
	await once(runner, "exit");
	owned.delete(runner.pid);
	if (real) {
		await pause(750);
		console.log(`observed ${mode}: real pi alive 750ms after wrapper SIGKILL = ${alive(started.pid)}`);
		ws.close();
		await stopOwned(started.pid);
		return;
	}
	await until("fake pi stdin EOF", async () => (await events(log)).some((event) => event.event === "eof"));
	assert.equal(alive(started.pid), true, `${mode} pi child must still exist immediately after wrapper SIGKILL`);
	await pause(750);
	assert.equal(alive(started.pid), true, `${mode} pi child must survive 750ms after wrapper SIGKILL`);
	ws.close();
	await stopOwned(started.pid);
	console.log(`ok ${mode}: wrapper SIGKILL orphaned fake pi pid=${started.pid}; child survived EOF and 750ms observation`);
	assert.match(stderr, /spawned pi --mode rpc/);
}

try {
	await probe("idle");
	await probe("busy");
	await probe("real-idle");
	await probe("real-dialog");
	console.log(`versions: node=${process.version}`);
	console.log("verify-crash: current runner exhibits orphan survival in idle and busy cases");
} finally {
	for (const pid of [...owned]) await stopOwned(pid);
	server.closeAllConnections?.();
	await new Promise((resolve) => server.close(resolve));
	await rm(temp, { recursive: true, force: true });
}
