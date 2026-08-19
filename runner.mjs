#!/usr/bin/env node
// pi-runner: registers a local `pi --mode rpc` with a pi-tower and pipes RPC JSONL both ways.
import { spawn } from "node:child_process";
import { hostname } from "node:os";

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

const child = spawn("pi", ["--mode", "rpc", ...piArgs], { stdio: ["pipe", "pipe", "inherit"] });
child.on("exit", (code) => process.exit(code ?? 1));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));

let ws = null;

// LF-only framing per pi docs/rpc.md; readline is not protocol-compliant
let buf = "";
child.stdout.on("data", (chunk) => {
	buf += chunk.toString("utf8");
	let nl;
	while ((nl = buf.indexOf("\n")) !== -1) {
		let line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (line && ws?.readyState === WebSocket.OPEN) ws.send(line);
	}
});

function connect() {
	ws = new WebSocket(`${hq}/runner?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
	ws.onopen = () => console.error(`pi-runner "${id}" connected to ${hq}`);
	ws.onmessage = (ev) => child.stdin.write(`${ev.data}\n`);
	ws.onclose = (ev) => {
		console.error(`disconnected (${ev.code}); retrying in 3s`);
		setTimeout(connect, 3000);
	};
	ws.onerror = () => {}; // close fires afterwards and drives the retry
}
connect();
