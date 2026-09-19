// Disposable static fixture: no real Tower data, sessions, credentials, runner, or LLM.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const threadId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const otherSourceId = "33333333-3333-4333-8333-333333333333";
const now = "2026-09-15T08:30:00.000Z";
const thread = {
	threadId,
	title: "Docs integration",
	runnerId: "runner-docs",
	online: false,
	canDelegate: false,
	unavailableReason: "Runner is offline",
	archivedAt: null,
	metadataVersion: 3,
	updatedAt: now,
	project: "documentation", cwd: "/Users/fixture/workspaces/documentation", hostname: "docs-host.local",
	runtime: { state: "sleeping", sync: "synced", inputReady: false, queue: [] },
	latestSnapshotRevision: { generationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", counter: 2 },
};
const tasks = [
	{
		taskId: "44444444-4444-4444-8444-444444444444", sourceThreadId: otherSourceId, targetThreadId: threadId,
		sourceRunnerId: "runner-tests", targetRunnerId: "runner-docs", sourceName: "Test coverage", targetName: thread.title,
		prompt: "Check migration notes.", status: "completed", createdAt: now, updatedAt: now,
		result: { outcome: "completed", summary: "Migration notes checked. The existing session IDs stay unchanged.", notificationId: "44444444-4444-4444-8444-444444444444" }, notificationStatus: "delivered",
	},
	{
		taskId: "task-received", commandId: "command-1", sourceThreadId: sourceId, targetThreadId: threadId,
		sourceRunnerId: "runner-app", targetRunnerId: "runner-docs", sourceName: "App work", targetName: thread.title,
		prompt: "Update the guide without exposing <script>alert('fixture')</script>.", status: "completed", createdAt: now, updatedAt: now,
		result: { outcome: "completed", summary: "Updated the API guide. <img src=x onerror=alert(1)>", notificationId: "notice-1" }, notificationStatus: "pending",
	},
	{
		taskId: "task-sent", commandId: "command-2", sourceThreadId: threadId, targetThreadId: sourceId,
		sourceRunnerId: "runner-docs", targetRunnerId: "runner-app", sourceName: thread.title, targetName: "App work",
		prompt: "Check the app examples.", status: "failed", createdAt: now, updatedAt: now,
		result: { outcome: "failed", summary: "Examples need a newer SDK.", notificationId: "notice-2" }, notificationStatus: "delivered",
	},
];
const history = [{ type: "custom", customType: "tower-collaboration-report", timestamp: now, data: { summary: "DUPLICATE MUST NOT RENDER" } },
	{ message: { role: "assistant", content: [{ type: "text", text: "A normal user-facing assistant answer." }] }, timestamp: now }];

const server = createServer((request, response) => {
	const url = new URL(request.url, "http://fixture");
	if (url.pathname === "/ui.css") return response.writeHead(200, { "content-type": "text/css; charset=utf-8" }).end(readFileSync(resolve(root, "ui.css")));
	if ([`/threads/${threadId}`, `/threads/${sourceId}`].includes(url.pathname)) {
		let html = readFileSync(resolve(root, "threads.html"), "utf8");
		html = html.replace("<script>", "<script>\nclass WebSocket extends EventTarget { static OPEN = 1; readyState = 3; send() {} close() {} }");
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
		return;
	}
	if (url.pathname === "/api/managed/runners") return json(response, []);
	if (url.pathname === "/api/threads") return json(response, { threads: [thread], nextCursor: null });
	if (url.pathname === `/api/threads/${sourceId}`) return json(response, { ...thread, threadId: sourceId, title: "App work", runnerId: "runner-app" });
	if (url.pathname === `/api/threads/${sourceId}/tasks`) return json(response, { tasks: tasks.filter((task) => task.sourceThreadId === sourceId || task.targetThreadId === sourceId), nextCursor: null });
	if (url.pathname === `/api/threads/${sourceId}/history`) return json(response, { entries: history, nextCursor: null, revision: thread.latestSnapshotRevision });
	if (url.pathname === `/api/threads/${threadId}`) return json(response, thread);
	if (url.pathname === `/api/threads/${threadId}/tasks`) return json(response, { tasks, nextCursor: null });
	if (url.pathname === `/api/threads/${threadId}/history`) return json(response, { entries: history, nextCursor: null, revision: thread.latestSnapshotRevision });
	response.writeHead(404).end("fixture route not found");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/threads/${threadId}` }));

function json(response, value) {
	response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
