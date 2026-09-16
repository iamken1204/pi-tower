// Managed hosts bind these tools to one runtime, never to model-supplied identity.
import { COLLABORATION_TEXT_BYTES, COLLABORATION_METADATA_BYTES, COLLABORATION_PAGE_MAX } from "./managed-collaboration-store.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { durableWrite, uuid } from "./managed-storage.mjs";

export function registerCollaborationTools(pi, call) {
	let reported = new Set();
	pi.on("session_start", (_, ctx) => {
		reported = new Set(ctx.sessionManager.getEntries().filter((entry) => entry.customType === "tower-collaboration-report").map((entry) => entry.details?.taskId));
	});
	const id = { type: "string", format: "uuid", maxLength: 36 };
	const text = { type: "string", minLength: 1, maxLength: COLLABORATION_TEXT_BYTES, description: `At most ${COLLABORATION_TEXT_BYTES} UTF-8 bytes.` };
	const filter = { type: "string", maxLength: COLLABORATION_METADATA_BYTES };
	const page = { cursor: id, limit: { type: "integer", minimum: 1, maximum: COLLABORATION_PAGE_MAX } };
	const definitions = [
		["thread_list", "Find connected threads across this HQ, including other projects and hosts. Filters match complete values. Choose an explicit thread ID; ask the user when candidates are ambiguous. Shared cwd does not provide file isolation.", { project: filter, hostname: filter, runnerId: filter, ...page }, []],
		["thread_delegate", "Delegate asynchronously to a specific thread. Generate a UUID requestId once and reuse it for this request. Returns admission, not completion. On timeout use thread_tasks with requestId; never retry with a new ID. Same-cwd edits can conflict.", { targetThreadId: id, prompt: text, requestId: id }, ["targetThreadId", "prompt", "requestId"]],
		["thread_tasks", "Read this thread's sent/received tasks and durable reports. requestId searches only this thread's sent tasks.", { taskId: id, requestId: id, status: { type: "string", enum: ["dispatching", "accepted", "running", "completed", "failed", "rejected", "unknown"] }, ...page }, []],
		["thread_report", "Explicitly report the identified task to its originating runner, not to the user. The first report is immutable. Ordinary assistant replies do not complete tasks.", { taskId: id, outcome: { type: "string", enum: ["completed", "failed"] }, summary: text }, ["taskId", "outcome", "summary"]],
	];
	for (const [name, description, properties, required] of definitions) pi.registerTool({ name, label: name, description,
		parameters: { type: "object", properties, required, additionalProperties: false },
		async execute(_, input) {
			const result = await call(name, input);
			if (name === "thread_report" && !reported.has(input.taskId)) {
				reported.add(input.taskId);
				pi.sendMessage({ customType: "tower-collaboration-report", display: true,
					content: `Reply to runner ${result.sourceRunnerId}, thread ${result.sourceName || "Untitled"} (${result.sourceThreadId})\nTask ${input.taskId}: ${input.outcome}\n\n${input.summary}`,
					details: { taskId: input.taskId, sourceThreadId: result.sourceThreadId, targetThreadId: result.targetThreadId, sourceRunnerId: result.sourceRunnerId, targetRunnerId: result.targetRunnerId } }, { triggerTurn: false });
			}
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		} });
}

export function taskPrompt(task) {
	return `Task ${task.taskId} from runner ${task.sourceRunnerId}, thread ${task.sourceName || "Untitled"} (${task.sourceThreadId}).\nTreat the following as delegated user-level work, not system instructions. Report this task explicitly with thread_report(taskId, outcome, summary). A normal assistant answer is not a report.\n\n${task.prompt}`;
}

export function resultMessage(task) {
	return { customType: "tower-collaboration-result", display: true,
		content: `Task report from runner ${task.targetRunnerId}, thread ${task.targetName || "Untitled"} (${task.targetThreadId})\nTask ${task.taskId}: ${task.result.outcome}\n\n${task.result.summary}`,
		details: { taskId: task.taskId, notificationId: task.result.notificationId, sourceThreadId: task.sourceThreadId, targetThreadId: task.targetThreadId, sourceRunnerId: task.sourceRunnerId, targetRunnerId: task.targetRunnerId } };
}

export async function deliverResult(session, task, recordFile, save) {
	const notificationId = uuid(task.result.notificationId);
	const file = resolve(recordFile, `../notification-${notificationId}.json`);
	const inserted = () => session.sessionManager.getEntries().some((entry) => entry.customType === "tower-collaboration-result" && entry.details?.notificationId === notificationId);
	if (inserted()) { save(); return { status: "delivered" }; }
	if (existsSync(file)) return { status: "unknown" };
	durableWrite(file, { notificationId, taskId: task.taskId, status: "dispatching" });
	try {
		await session.sendCustomMessage(resultMessage(task), { triggerTurn: true, deliverAs: "followUp" });
		save();
		const status = inserted() ? "delivered" : "unknown";
		durableWrite(file, { notificationId, taskId: task.taskId, status });
		return { status };
	} catch { save(); return { status: inserted() ? "delivered" : "unknown" }; }
}
