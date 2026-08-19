#!/usr/bin/env node
// pi-tower: relays RPC JSONL frames between clients and per-session pi processes on registered runners.
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function parseArgs(argv) {
	const opts = { port: 9000, token: process.env.PI_TOWER_TOKEN };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--port") opts.port = Number(argv[++i]);
		else if (argv[i] === "--token") opts.token = argv[++i];
		else {
			console.error(`unknown option ${argv[i]}\nusage: pi-tower [--port 9000] [--token t]`);
			process.exit(1);
		}
	}
	if (!opts.token) {
		console.error("missing token: pass --token or set PI_TOWER_TOKEN");
		process.exit(1);
	}
	return opts;
}

export function createTower({ token, openTimeoutMs = 15000 }) {
	// id -> { ws (control socket), connectedAt, sessions: Map<name, { ws (data pipe), client }> }
	const runners = new Map();
	// "id/name" -> { client, queue, timer } — client held while the runner opens the session
	const pending = new Map();
	const authorized = (req) => req.headers.authorization === `Bearer ${token}`;

	const listing = () =>
		[...runners.entries()].map(([id, r]) => ({ id, connectedAt: r.connectedAt, sessions: r.sessions.size }));

	const server = createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		if (url.pathname === "/") {
			res.end("pi-tower");
			return;
		}
		if (url.pathname === "/runners") {
			if (!authorized(req)) {
				res.writeHead(401).end();
				return;
			}
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(listing()));
			return;
		}
		res.writeHead(404).end();
	});

	const wss = new WebSocketServer({ noServer: true });
	const routes = { "/runner": handleControl, "/runner-session": handleSession, "/attach": handleAttach };

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url, "http://x");
		const route = routes[url.pathname];
		if (!route) {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			if (!authorized(req)) {
				ws.close(4001, "bad token");
				return;
			}
			route(ws, url.searchParams);
		});
	});

	function failPending(key, code, reason) {
		const p = pending.get(key);
		if (!p) return;
		pending.delete(key);
		clearTimeout(p.timer);
		p.client.close(code, reason);
	}

	function handleControl(ws, params) {
		const id = params.get("id");
		if (!id || !NAME_RE.test(id)) {
			ws.close(1008, "invalid runner id");
			return;
		}
		const prev = runners.get(id);
		const runner = {
			ws,
			connectedAt: prev?.connectedAt ?? new Date().toISOString(),
			sessions: prev?.sessions ?? new Map(),
		};
		if (prev) prev.ws.terminate(); // new control wins; session pipes survive
		runners.set(id, runner);
		ws.on("close", () => {
			if (runners.get(id)?.ws !== ws) return; // replaced
			runners.delete(id);
			for (const s of runner.sessions.values()) {
				s.client?.close(4006, "session disconnected");
				s.ws.terminate();
			}
			for (const key of [...pending.keys()]) {
				if (key.startsWith(`${id}/`)) failPending(key, 4007, "runner failed to open session");
			}
		});
	}

	function handleSession(ws, params) {
		const id = params.get("id");
		const name = params.get("session");
		const runner = runners.get(id);
		if (!runner || !name || !NAME_RE.test(name)) {
			ws.close(1008, "unknown runner or invalid session");
			return;
		}
		const key = `${id}/${name}`;
		const prev = runner.sessions.get(name);
		const p = pending.get(key);
		const session = { ws, client: prev?.client ?? p?.client ?? null };
		if (prev) prev.ws.terminate(); // new pipe wins, attached client kept
		runner.sessions.set(name, session);
		if (p) {
			pending.delete(key);
			clearTimeout(p.timer);
			for (const frame of p.queue) ws.send(frame);
		}
		ws.on("message", (data) => {
			if (runner.sessions.get(name)?.ws !== ws) return; // replaced
			session.client?.send(data.toString());
		});
		ws.on("close", () => {
			const s = runners.get(id)?.sessions.get(name);
			if (s?.ws !== ws) return; // replaced
			s.client?.close(4006, "session disconnected");
			runners.get(id).sessions.delete(name);
		});
	}

	function handleAttach(ws, params) {
		const id = params.get("runner");
		const name = params.get("session") ?? "main";
		if (!NAME_RE.test(name)) {
			ws.close(1008, "invalid session name");
			return;
		}
		const runner = runners.get(id);
		if (!runner) {
			const ids = runners.size ? [...runners.keys()].join(",") : "none";
			ws.close(4004, `unknown runner; online: ${ids}`.slice(0, 120));
			return;
		}
		const key = `${id}/${name}`;
		const live = runner.sessions.get(name);
		if (live?.client || pending.has(key)) {
			ws.close(4005, "busy");
			return;
		}
		if (live) live.client = ws;
		else if (runner.ws.readyState !== 1) {
			ws.close(4007, "runner failed to open session");
			return;
		} else {
			runner.ws.send(JSON.stringify({ type: "open", session: name }));
			pending.set(key, {
				client: ws,
				queue: [], // Frames wait here for at most openTimeoutMs while the runner opens the session.
				timer: setTimeout(() => failPending(key, 4007, "runner failed to open session"), openTimeoutMs),
			});
		}
		ws.on("message", (data) => {
			const p = pending.get(key);
			if (p?.client === ws) {
				p.queue.push(data.toString());
				return;
			}
			const s = runners.get(id)?.sessions.get(name);
			if (s?.client === ws) s.ws.send(data.toString());
		});
		ws.on("close", () => {
			const p = pending.get(key);
			if (p?.client === ws) {
				pending.delete(key);
				clearTimeout(p.timer);
				return;
			}
			const s = runners.get(id)?.sessions.get(name);
			if (s?.client === ws) s.client = null; // pipe stays idle, session context preserved for reattach
		});
	}

	return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	const { port, token } = parseArgs(process.argv.slice(2));
	createTower({ token }).listen(port, () => console.log(`pi-tower listening on :${port}`));
}
