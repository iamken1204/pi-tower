#!/usr/bin/env -S bun --no-env-file
// pi-runner: registers with a pi-tower and runs one `pi --mode rpc` child per opened session, killed when the tower closes it.
import { spawn } from "node:child_process";
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import { loadToken } from "./lib.mjs";
import { HOST_COMMAND } from "./managed/pi-sdk.mjs";
import { ManagedRunner } from "./managed/runner.mjs";

// A compiled runner has no separate host script; it starts itself again to host one thread's pi.
if (process.argv[2] === HOST_COMMAND) {
	process.argv.splice(2, 1);
	await import("./managed/pi.mjs");
	process.exit();
}

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function parseArgs(argv) {
	const opts = {
		hq: undefined,
		id: hostname(),
		token: process.env.PI_TOWER_TOKEN,
		tokenFile: process.env.PI_TOWER_TOKEN ? undefined : process.env.PI_TOWER_TOKEN_FILE,
		piArgs: [],
		dataDir: process.env.PI_RUNNER_DATA_DIR ?? resolve(homedir(), ".pi-tower"),
		interactive: undefined, // Interactive unless a headless mode is chosen below.
	};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--help") {
			console.log("pi-runner --hq <ws(s)://host[:port]> [--id name] [--token t | --token-file path]\nToken: --token, --token-file, PI_TOWER_TOKEN, PI_TOWER_TOKEN_FILE, else ~/.pi-tower/token. --id defaults to the hostname.\nDefault mode is the interactive TUI + web thread [--thread <UUID> | -c | -r]: start in the workspace; like pi, -c/--continue resumes this directory's newest thread, -r/--resume picks one of them, --thread names a UUID. Every thread keeps its original cwd.\n--data-dir defaults to ~/.pi-tower (or PI_RUNNER_DATA_DIR); one process per data directory.\nHeadless: --managed-threads (browser-created threads) or --no-interactive [-- <pi args>] (legacy relay; pi args imply it). Managed modes reject pi args.\n--pi-package <npm package directory> replaces the pi this runner ships with; --managed-idle-ms 1800000 (0 disables); --managed-max-awake 4\nPI_MANAGED_TEXT_BYTES=262144 (set on Tower too)\nPI_RUNNER_MAX_SNAPSHOT_BYTES=67108864 (download limit)\nOnly pi 0.85.1 and local-filesystem locks are tested; copying runner data to another host is unsupported.");
			process.exit(0);
		}
		else if (argv[i] === "--hq") opts.hq = argv[++i];
		else if (argv[i] === "--id") opts.id = argv[++i];
		else if (argv[i] === "--managed-threads") { opts.managed = true; opts.interactive ??= false; }
		else if (argv[i] === "--interactive") opts.interactive = true;
		else if (argv[i] === "--no-interactive") opts.interactive = false;
		else if (argv[i] === "--thread") opts.threadId = argv[++i];
		else if (argv[i] === "--continue" || argv[i] === "-c") opts.continueRecent = true;
		else if (argv[i] === "--resume" || argv[i] === "-r") opts.resume = true;
		else if (argv[i] === "--data-dir") opts.dataDir = argv[++i];
		else if (argv[i] === "--pi-package") opts.piPackage = argv[++i];
		else if (argv[i] === "--managed-idle-ms") opts.idleTtlMs = Number(argv[++i]);
		else if (argv[i] === "--managed-max-awake") opts.maxAwake = Number(argv[++i]);
		else if (argv[i] === "--token") {
			opts.token = argv[++i];
			opts.tokenFile = undefined;
		} else if (argv[i] === "--token-file") {
			opts.tokenFile = argv[++i];
			opts.token = undefined;
		} else if (argv[i] === "--") {
			opts.piArgs = argv.slice(i + 1);
			opts.interactive ??= false;
			break;
		} else {
			console.error(
				`unknown option ${argv[i]}\nusage: pi-runner --hq <ws(s)://host[:port]> [--id name] [--token t | --token-file path] [--managed-threads | --no-interactive [-- <pi args>]]`,
			);
			process.exit(1);
		}
	}
	opts.interactive ??= true;
	if (opts.interactive) opts.managed = true;
	try {
		opts.token = loadToken(opts);
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
	if (!opts.hq) {
		console.error("missing --hq <ws(s)://host[:port]>");
		process.exit(1);
	}
	if (opts.managed && opts.piArgs.length) throw new Error("managed mode rejects passthrough pi args; configure pi through its settings");
	const picks = [opts.threadId, opts.continueRecent, opts.resume].filter(Boolean).length;
	if (picks && !opts.interactive) throw new Error("--thread, --continue and --resume require --interactive");
	if (picks > 1) throw new Error("choose one of --thread, --continue, --resume");
	if (opts.idleTtlMs !== undefined && (!Number.isSafeInteger(opts.idleTtlMs) || opts.idleTtlMs < 0)) throw new Error("invalid managed idle TTL");
	if (opts.maxAwake !== undefined && (!Number.isSafeInteger(opts.maxAwake) || opts.maxAwake < 1)) throw new Error("invalid awake limit");
	return opts;
}

const options = parseArgs(process.argv.slice(2));
if (options.interactive) {
	await (await import("./managed/interactive.mjs")).runInteractive(options);
	process.exit(0);
}
const { hq, id, token, piArgs } = options;
const managed = options.managed ? new ManagedRunner(options) : null;
managed?.hostAll();
managed?.connect({ hq, token });
// { headers } is a Bun WebSocket extension, not the WHATWG standard.
const wsOpts = { headers: { authorization: `Bearer ${token}` } };

const children = new Map(); // session name -> { child, buf, ws }
let control = null;

// Keep idle children alive so detaching and reattaching preserves session context.
function ensureSession(name) {
	if (managed?.threads.has(name)) return;
	let entry = children.get(name);
	if (!entry) {
		const child = spawn("pi", ["--mode", "rpc", ...piArgs], { stdio: ["pipe", "pipe", "inherit"] });
		entry = { child, buf: "", ws: null };
		children.set(name, entry);
		// LF-only framing per pi docs/rpc.md; readline is not protocol-compliant
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			entry.buf += chunk;
			let nl;
			while ((nl = entry.buf.indexOf("\n")) !== -1) {
				let line = entry.buf.slice(0, nl);
				entry.buf = entry.buf.slice(nl + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line && entry.ws?.readyState === WebSocket.OPEN) entry.ws.send(line);
			}
		});
		child.on("exit", (code) => {
			console.error(`session "${name}": pi exited (${code})`);
			children.delete(name);
			entry.ws?.close();
		});
		console.error(`session "${name}": spawned pi --mode rpc`);
	}
	dialSession(name);
}

function dialSession(name) {
	const entry = children.get(name);
	if (!entry || entry.ws) return;
	const ws = new WebSocket(
		`${hq}/runner-session?id=${encodeURIComponent(id)}&session=${encodeURIComponent(name)}`,
		wsOpts,
	);
	entry.ws = ws;
	ws.onmessage = (ev) => entry.child.stdin.write(`${ev.data}\n`);
	ws.onclose = () => {
		if (entry.ws !== ws) return;
		entry.ws = null;
		if (children.get(name) === entry && control?.readyState === WebSocket.OPEN) {
			setTimeout(() => dialSession(name), 3000);
		}
	};
	ws.onerror = () => {}; // close fires afterwards and drives the retry
}

function connect() {
	control = new WebSocket(`${hq}/runner?id=${encodeURIComponent(id)}`, wsOpts);
	control.onopen = () => {
		console.error(`pi-runner "${id}" connected to ${hq}`);
		for (const name of children.keys()) dialSession(name);
	};
	control.onmessage = (ev) => {
		let msg;
		try {
			msg = JSON.parse(String(ev.data));
		} catch {
			return;
		}
		if (typeof msg.session !== "string" || !NAME_RE.test(msg.session)) return;
		if (msg.type === "open") ensureSession(msg.session);
		else if (msg.type === "close") children.get(msg.session)?.child.kill();
	};
	control.onclose = (ev) => {
		console.error(`control disconnected (${ev.code}); retrying in 3s`);
		setTimeout(connect, 3000);
	};
	control.onerror = () => {};
}
connect();

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, async () => {
		if (stopping) return;
		stopping = true;
		for (const { child } of children.values()) child.kill(sig);
		try { await managed?.close(); process.exit(0); }
		catch (error) { console.error(error.message); process.exit(1); }
	});
}
