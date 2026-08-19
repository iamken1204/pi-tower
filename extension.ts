// pi-tower extension: lets the model dispatch work to remote pi runners via a tower.
// Activate with: pi -e ./extension.ts --tower wss://hq.example.com --tower-token <t>
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatRunners, listRunners, runTask } from "./lib.mjs";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("tower", { type: "string", description: "pi-tower URL (ws:// or wss://)" });
	pi.registerFlag("tower-token", { type: "string", description: "pi-tower auth token" });

	const tower = pi.getFlag("tower") as string | undefined;
	if (!tower) return; // inert without --tower
	const token = (pi.getFlag("tower-token") as string | undefined) ?? process.env.PI_TOWER_TOKEN ?? "";

	pi.registerTool({
		name: "runner_list",
		label: "Runner list",
		description: "List remote pi runners registered with the tower and how many sessions each is running.",
		parameters: Type.Object({}),
		async execute() {
			const text = formatRunners(await listRunners(tower, token));
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
			session: Type.Optional(
				Type.String({
					pattern: "^[A-Za-z0-9._-]{1,64}$",
					description:
						"Session name on the runner (default: main). Same name shares conversation context across tasks; different names run in parallel.",
				}),
			),
			fresh: Type.Optional(Type.Boolean({ description: "Reset the session's conversation first" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			let transcript = "";
			const text = await runTask({
				tower,
				token,
				runnerId: params.runner_id,
				session: params.session,
				prompt: params.prompt,
				fresh: params.fresh,
				signal,
				onDelta: (delta: string) => {
					transcript += delta;
					onUpdate?.({ content: [{ type: "text", text: transcript }], details: {} });
				},
			});
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	});
}
