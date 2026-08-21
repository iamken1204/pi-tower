// Shared tower client: attach → prompt → settle → final-text flow, used by extension.ts and task.mjs.
import { readFileSync } from "node:fs";

const httpFromWs = (url) => url.replace(/^ws/, "http");

export function readTokenFile(path) {
	const token = readFileSync(path, "utf8").replace(/\r?\n$/, "");
	if (!token) throw new Error(`token file is empty: ${path}`);
	return token;
}

export async function listRunners(tower, token) {
	const res = await fetch(`${httpFromWs(tower)}/runners`, { headers: { authorization: `Bearer ${token}` } });
	if (!res.ok) throw new Error(`tower responded ${res.status}`);
	return res.json();
}

export function formatRunners(runners) {
	const count = (n) => (n === 0 ? "idle" : `${n} session${n === 1 ? "" : "s"}`);
	return runners.length
		? runners.map((r) => `${r.id}  ${count(r.sessions)}  connected ${r.connectedAt}`).join("\n")
		: "no runners online";
}

export async function runTask({ tower, token, runnerId, session, prompt, fresh, signal, onDelta }) {
	// { headers } is a Node (undici) WebSocket extension, not the WHATWG standard; fine since engines requires Node >= 22.
	const ws = new WebSocket(
		`${tower}/attach?runner=${encodeURIComponent(runnerId)}` + (session ? `&session=${encodeURIComponent(session)}` : ""),
		{ headers: { authorization: `Bearer ${token}` } },
	);
	const send = (obj) => ws.send(JSON.stringify(obj));

	try {
		return await new Promise((resolve, reject) => {
			ws.onclose = (ev) => reject(new Error(ev.reason || `tower connection closed (${ev.code})`));
			ws.onopen = () => {
				if (fresh) send({ id: "t0", type: "new_session" });
				send({ id: "t1", type: "prompt", message: prompt });
			};
			signal?.addEventListener("abort", () => {
				send({ type: "abort" });
				reject(new Error("task aborted"));
			});
			ws.onmessage = (ev) => {
				const msg = JSON.parse(String(ev.data));
				if (msg.type === "response" && !msg.success) {
					reject(new Error(`runner rejected ${msg.command}: ${JSON.stringify(msg.error ?? msg)}`));
				} else if (msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta") {
					onDelta?.(msg.assistantMessageEvent.delta);
				} else if (msg.type === "agent_settled") {
					send({ id: "t2", type: "get_last_assistant_text" });
				} else if (msg.type === "response" && msg.id === "t2") {
					resolve(msg.data?.text ?? "(no assistant reply)");
				}
			};
		});
	} finally {
		ws.close();
	}
}
