#!/usr/bin/env node
// pi-tower: relays RPC JSONL frames between clients and per-session pi processes on registered runners.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { readTokenFile } from "./lib.mjs";

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const UI_HTML = readFileSync(new URL("./ui.html", import.meta.url));
const UI_SESSION_COOKIE = "pi_tower_ui_session";
const UI_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function parseArgs(argv) {
	const opts = {
		port: 9000,
		token: process.env.PI_TOWER_TOKEN,
		tokenFile: process.env.PI_TOWER_TOKEN ? undefined : process.env.PI_TOWER_TOKEN_FILE,
	};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--port") opts.port = Number(argv[++i]);
		else if (argv[i] === "--token") {
			opts.token = argv[++i];
			opts.tokenFile = undefined;
		} else if (argv[i] === "--token-file") {
			opts.tokenFile = argv[++i];
			opts.token = undefined;
		} else {
			console.error(`unknown option ${argv[i]}\nusage: pi-tower [--port 9000] [--token t | --token-file path]`);
			process.exit(1);
		}
	}
	if (opts.tokenFile) {
		try {
			opts.token = readTokenFile(opts.tokenFile);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	}
	if (!opts.token) {
		console.error("missing token: pass --token, --token-file, or set PI_TOWER_TOKEN / PI_TOWER_TOKEN_FILE");
		process.exit(1);
	}
	return opts;
}

export function createTower({ token, openTimeoutMs = 15000 }) {
	// id -> { ws (control socket), connectedAt, sessions: Map<name, { ws (data pipe), client }> }
	const runners = new Map();
	// "id/name" -> { client, queue, timer } — client held while the runner opens the session
	const pending = new Map();
	const bearerAuthorized = (req) => req.headers.authorization === `Bearer ${token}`;
	const signUiSession = (payload) => createHmac("sha256", token).update(payload).digest("base64url");
	const issueUiSession = () => {
		const payload = `${Date.now() + UI_SESSION_TTL_SECONDS * 1000}.${randomBytes(18).toString("base64url")}`;
		return `${payload}.${signUiSession(payload)}`;
	};
	const uiSessionCookie = (req) => {
		const prefix = `${UI_SESSION_COOKIE}=`;
		return req.headers.cookie
			?.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith(prefix))
			?.slice(prefix.length);
	};
	const uiSessionAuthorized = (req) => {
		const value = uiSessionCookie(req);
		if (!value) return false;
		const [expires, nonce, signature, ...extra] = value.split(".");
		if (extra.length || !expires || !nonce || !signature || Number(expires) <= Date.now()) return false;
		const expected = Buffer.from(signUiSession(`${expires}.${nonce}`));
		const supplied = Buffer.from(signature);
		return supplied.length === expected.length && timingSafeEqual(supplied, expected);
	};
	const uiAuthorized = (req) => bearerAuthorized(req) || uiSessionAuthorized(req);
	const secureRequest = (req) =>
		req.socket.encrypted === true || req.headers["x-forwarded-proto"]?.split(",", 1)[0].trim() === "https";
	const setUiSessionCookie = (req, res, value, maxAge = UI_SESSION_TTL_SECONDS) => {
		res.setHeader(
			"set-cookie",
			`${UI_SESSION_COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureRequest(req) ? "; Secure" : ""}`,
		);
	};

	const listing = () =>
		[...runners.entries()].map(([id, r]) => ({ id, connectedAt: r.connectedAt, sessions: r.sessions.size }));
	const snapshot = () => ({
		runners: [...runners.entries()].map(([id, runner]) => ({
			id,
			connectedAt: runner.connectedAt,
			sessions: [
				...[...runner.sessions.entries()].map(([name, session]) => ({
					name,
					state: session.client ? "attached" : "idle",
				})),
				...[...pending.keys()]
					.filter((key) => key.startsWith(`${id}/`))
					.map((key) => ({ name: key.slice(id.length + 1), state: "opening" })),
			],
		})),
	});

	const server = createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		if (url.pathname === "/") {
			res.end("pi-tower");
			return;
		}
		if (url.pathname === "/runners") {
			if (!bearerAuthorized(req)) {
				res.writeHead(401).end();
				return;
			}
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(listing()));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/session") {
			let body = "";
			let tooLarge = false;
			req.setEncoding("utf8");
			req.on("data", (chunk) => {
				body += chunk;
				if (body.length > 4096) tooLarge = true;
			});
			req.on("end", () => {
				res.setHeader("cache-control", "no-store");
				if (tooLarge) {
					res.writeHead(413).end();
					return;
				}
				const submittedToken = new URLSearchParams(body).get("token");
				if (submittedToken === token) {
					setUiSessionCookie(req, res, issueUiSession());
					res.writeHead(303, { location: "/ui/" }).end();
					return;
				}
				if (uiSessionCookie(req)) setUiSessionCookie(req, res, "", 0);
				res.writeHead(303, { location: "/ui/?auth=failed" }).end();
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/state") {
			if (!uiAuthorized(req)) {
				if (uiSessionCookie(req)) setUiSessionCookie(req, res, "", 0);
				res.writeHead(401).end();
				return;
			}
			res.setHeader("content-type", "application/json");
			res.setHeader("cache-control", "no-store");
			res.end(JSON.stringify(snapshot()));
			return;
		}
		if (req.method === "GET" && url.pathname === "/ui/") {
			res.setHeader("content-type", "text/html; charset=utf-8");
			res.end(UI_HTML);
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
			if (!bearerAuthorized(req)) {
				ws.close(4001, "bad token");
				return;
			}
			ws.isAlive = true;
			ws.on("pong", () => (ws.isAlive = true));
			route(ws, url.searchParams);
		});
	});

	// Proxies (Cloudflare's edge among them) drop idle WebSockets; a peer that misses
	// two pings is gone, so terminate it to trigger the normal close-path cleanup.
	const heartbeat = setInterval(() => {
		for (const ws of wss.clients) {
			if (ws.isAlive === false) {
				ws.terminate();
				continue;
			}
			ws.isAlive = false;
			ws.ping();
		}
	}, 30000);
	server.on("close", () => clearInterval(heartbeat));

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
	// As container PID 1, node has no default signal dispositions, so docker stop would otherwise hang 10s to SIGKILL.
	for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
}
