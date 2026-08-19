#!/usr/bin/env node
// pi-tower: relays RPC JSONL frames between one attached client and a registered runner.
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

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

export function createTower({ token }) {
	// id -> { socket, connectedAt, client } ; client is the attached client socket or null
	const runners = new Map();

	const listing = () =>
		[...runners.entries()].map(([id, r]) => ({ id, connectedAt: r.connectedAt, busy: r.client !== null }));

	const server = createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		if (url.pathname === "/") {
			res.end("pi-tower");
			return;
		}
		if (url.pathname === "/runners") {
			if (url.searchParams.get("token") !== token) {
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

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url, "http://x");
		if (url.pathname !== "/runner" && url.pathname !== "/attach") {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			if (url.searchParams.get("token") !== token) {
				ws.close(4001, "bad token");
				return;
			}
			if (url.pathname === "/runner") handleRunner(ws, url.searchParams.get("id"));
			else handleAttach(ws, url.searchParams.get("runner"));
		});
	});

	function handleRunner(ws, id) {
		if (!id) {
			ws.close(4001, "missing id");
			return;
		}
		const prev = runners.get(id);
		if (prev) prev.socket.terminate(); // new connection wins; reconnect converges
		const runner = { socket: ws, connectedAt: new Date().toISOString(), client: prev?.client ?? null };
		runners.set(id, runner);
		ws.on("message", (data) => {
			if (runner.client) runner.client.send(data.toString());
		});
		ws.on("close", () => {
			if (runners.get(id) !== runner) return; // already replaced
			runners.delete(id);
			runner.client?.close(4006, "runner disconnected");
		});
	}

	function handleAttach(ws, id) {
		const runner = runners.get(id);
		if (!runner) {
			const ids = runners.size ? [...runners.keys()].join(",") : "none";
			ws.close(4004, `unknown runner; online: ${ids}`.slice(0, 120));
			return;
		}
		if (runner.client) {
			ws.close(4005, "busy");
			return;
		}
		runner.client = ws;
		// route via the map: the runner entry may be replaced by a reconnect mid-attachment
		ws.on("message", (data) => runners.get(id)?.socket.send(data.toString()));
		ws.on("close", () => {
			const cur = runners.get(id);
			if (cur?.client === ws) cur.client = null;
		});
	}

	return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	const { port, token } = parseArgs(process.argv.slice(2));
	createTower({ token }).listen(port, () => console.log(`pi-tower listening on :${port}`));
}
