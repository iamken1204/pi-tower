// In-process fake runner: control socket plus one canned-RPC session pipe per tower "open".
export const cannedAnswer = (session) => `canned final answer from ${session}`;
export const CANNED_ANSWER = cannedAnswer("main");

function dialPipe(port, token, id, session, pipes) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/runner-session?id=${id}&session=${session}&token=${token}`);
	pipes.set(session, ws);
	ws.onmessage = (ev) => {
		const cmd = JSON.parse(ev.data);
		const send = (obj) => ws.send(JSON.stringify(obj));
		if (cmd.type === "get_state") {
			send({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionId: `${id}:${session}` } });
		} else if (cmd.type === "new_session") {
			send({ id: cmd.id, type: "response", command: "new_session", success: true, data: { cancelled: false } });
		} else if (cmd.type === "prompt") {
			send({ id: cmd.id, type: "response", command: "prompt", success: true });
			send({ type: "agent_start" });
			send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "canned final " } });
			send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `answer from ${session}` } });
			send({ type: "agent_end", messages: [] });
			send({ type: "agent_settled" });
		} else if (cmd.type === "get_last_assistant_text") {
			send({ id: cmd.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: cannedAnswer(session) } });
		}
	};
}

export function connectFakeRunner(port, token, id, { ignoreOpen = false } = {}) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/runner?id=${id}&token=${token}`);
	const opens = [];
	const pipes = new Map(); // session name -> pipe ws
	ws.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.type !== "open") return;
		opens.push(msg.session);
		if (!ignoreOpen) dialPipe(port, token, id, msg.session, pipes);
	};
	return new Promise((resolve) => {
		ws.onopen = () =>
			resolve({
				ws,
				opens,
				pipes,
				close() {
					ws.close();
					for (const pipe of pipes.values()) pipe.close();
				},
			});
	});
}
