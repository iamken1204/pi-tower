#!/usr/bin/env node
// pi-runner: registers with a pi-tower and runs one `pi --mode rpc` child per opened session.
import { spawn } from "node:child_process";
import { hostname } from "node:os";

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function parseArgs(argv) {
	const opts = { hq: undefined, id: hostname(), token: process.env.PI_TOWER_TOKEN, piArgs: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--hq") opts.hq = argv[++i];
		else if (argv[i] === "--id") opts.id = argv[++i];
		else if (argv[i] === "--token") opts.token = argv[++i];
		else if (argv[i] === "--") {
			opts.piArgs = argv.slice(i + 1);
			break;
		} else {
			console.error(`unknown option ${argv[i]}\nusage: pi-runner --hq <ws(s)://host[:port]> [--id name] [--token t] [-- <pi args>]`);
			process.exit(1);
		}
	}
	if (!opts.hq || !opts.token) {
		console.error("missing --hq or token (--token / PI_TOWER_TOKEN)");
		process.exit(1);
	}
	return opts;
}

const { hq, id, token, piArgs } = parseArgs(process.argv.slice(2));

const children = new Map(); // session name -> { child, buf, ws }
let control = null;

// Keep idle children alive so detaching and reattaching preserves session context.
function ensureSession(name) {
	let entry = children.get(name);
	if (!entry) {
		const child = spawn("pi", ["--mode", "rpc", ...piArgs], { stdio: ["pipe", "pipe", "inherit"] });
		entry = { child, buf: "", ws: null };
		children.set(name, entry);
		// LF-only framing per pi docs/rpc.md; readline is not protocol-compliant
		child.stdout.on("data", (chunk) => {
			entry.buf += chunk.toString("utf8");
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
		`${hq}/runner-session?id=${encodeURIComponent(id)}&session=${encodeURIComponent(name)}&token=${encodeURIComponent(token)}`,
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
	control = new WebSocket(`${hq}/runner?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
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
		if (msg.type === "open" && typeof msg.session === "string" && NAME_RE.test(msg.session)) ensureSession(msg.session);
	};
	control.onclose = (ev) => {
		console.error(`control disconnected (${ev.code}); retrying in 3s`);
		setTimeout(connect, 3000);
	};
	control.onerror = () => {};
}
connect();

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		for (const { child } of children.values()) child.kill(sig);
		process.exit(0);
	});
}
