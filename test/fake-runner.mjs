// In-process fake runner speaking canned pi RPC JSONL over a tower /runner socket.
export const CANNED_ANSWER = "canned final answer";

export function connectFakeRunner(port, token, id) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/runner?id=${id}&token=${token}`);
	ws.onmessage = (ev) => {
		const cmd = JSON.parse(ev.data);
		const send = (obj) => ws.send(JSON.stringify(obj));
		if (cmd.type === "get_state") {
			send({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionId: "fake-1" } });
		} else if (cmd.type === "new_session") {
			send({ id: cmd.id, type: "response", command: "new_session", success: true, data: { cancelled: false } });
		} else if (cmd.type === "prompt") {
			send({ id: cmd.id, type: "response", command: "prompt", success: true });
			send({ type: "agent_start" });
			send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "canned " } });
			send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "final answer" } });
			send({ type: "agent_end", messages: [] });
			send({ type: "agent_settled" });
		} else if (cmd.type === "get_last_assistant_text") {
			send({ id: cmd.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: CANNED_ANSWER } });
		}
	};
	return new Promise((resolve) => {
		ws.onopen = () => resolve(ws);
	});
}
