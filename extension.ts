// pi-tower extension: lets the model dispatch work to remote pi runners via a tower.
// Activate with: pi -e ./extension.ts --tower wss://hq.example.com --tower-token <t>
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("tower", { type: "string", description: "pi-tower URL (ws:// or wss://)" });
	pi.registerFlag("tower-token", { type: "string", description: "pi-tower auth token" });

	const tower = pi.getFlag("tower") as string | undefined;
	if (!tower) return; // inert without --tower
	const token = (pi.getFlag("tower-token") as string | undefined) ?? process.env.PI_TOWER_TOKEN ?? "";
	const httpUrl = tower.replace(/^ws/, "http");

	pi.registerTool({
		name: "runner_list",
		label: "Runner list",
		description: "List remote pi runners registered with the tower and whether each is busy.",
		parameters: Type.Object({}),
		async execute() {
			const res = await fetch(`${httpUrl}/runners?token=${encodeURIComponent(token)}`);
			if (!res.ok) throw new Error(`tower responded ${res.status}`);
			const runners = (await res.json()) as { id: string; connectedAt: string; busy: boolean }[];
			const text = runners.length
				? runners.map((r) => `${r.id}  ${r.busy ? "busy" : "idle"}  connected ${r.connectedAt}`).join("\n")
				: "no runners online";
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	});

	pi.registerTool({
		name: "runner_task",
		label: "Runner task",
		description:
			"Run a prompt on a remote pi runner (a full coding agent on another machine) and return its final answer. Use runner_list to see available runner ids.",
		parameters: Type.Object({
			runner_id: Type.String({ description: "Runner id as shown by runner_list" }),
			prompt: Type.String({ description: "Task for the remote agent" }),
			fresh: Type.Optional(Type.Boolean({ description: "Start a fresh session on the runner first" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			const ws = new WebSocket(
				`${tower}/attach?runner=${encodeURIComponent(params.runner_id)}&token=${encodeURIComponent(token)}`,
			);
			const send = (obj: unknown) => ws.send(JSON.stringify(obj));
			let transcript = "";

			try {
				return await new Promise((resolve, reject) => {
					ws.onclose = (ev) => reject(new Error(ev.reason || `tower connection closed (${ev.code})`));
					ws.onopen = () => {
						if (params.fresh) send({ id: "t0", type: "new_session" });
						send({ id: "t1", type: "prompt", message: params.prompt });
					};
					signal?.addEventListener("abort", () => {
						send({ type: "abort" });
						reject(new Error("runner_task aborted"));
					});
					ws.onmessage = (ev) => {
						const msg = JSON.parse(String(ev.data));
						if (msg.type === "response" && !msg.success) {
							reject(new Error(`runner rejected ${msg.command}: ${JSON.stringify(msg.error ?? msg)}`));
						} else if (msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta") {
							transcript += msg.assistantMessageEvent.delta;
							onUpdate?.({ content: [{ type: "text", text: transcript }], details: {} });
						} else if (msg.type === "agent_settled") {
							send({ id: "t2", type: "get_last_assistant_text" });
						} else if (msg.type === "response" && msg.id === "t2") {
							resolve({
								content: [{ type: "text" as const, text: msg.data?.text ?? "(no assistant reply)" }],
								details: {},
							});
						}
					};
				});
			} finally {
				ws.close();
			}
		},
	});
}
