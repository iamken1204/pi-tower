import { createHash, randomUUID } from "node:crypto";

export const COLLABORATION_TEXT_BYTES = Number(process.env.PI_MANAGED_TEXT_BYTES ?? 256 * 1024);
export const COLLABORATION_METADATA_BYTES = 4096;
export const COLLABORATION_PAGE_DEFAULT = 10;
export const COLLABORATION_PAGE_MAX = 20;

if (!Number.isSafeInteger(COLLABORATION_TEXT_BYTES) || COLLABORATION_TEXT_BYTES < 1) throw new Error("invalid_managed_text_limit");

const TASK_STATUSES = new Set(["dispatching", "accepted", "running", "completed", "failed", "rejected", "unknown"]);
const TRANSITIONS = new Set(["accepted", "running", "unknown", "rejected"]);
const OUTCOMES = new Set(["completed", "failed"]);
const RECEIPT_STATUSES = new Set(["accepted", "rejected", "settled", "unknown"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function collaborationId(value) {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error("invalid_collaboration_id");
	return value;
}

export function collaborationText(value, field = "text") {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > COLLABORATION_TEXT_BYTES) throw new Error(`invalid_${field}`);
	return value;
}

export function collaborationMetadata(value, field = "metadata") {
	if (typeof value !== "string" || Buffer.byteLength(value) > COLLABORATION_METADATA_BYTES) throw new Error(`invalid_${field}`);
	return value;
}

export function collaborationPageLimit(value = COLLABORATION_PAGE_DEFAULT) {
	if (!Number.isSafeInteger(value) || value < 1 || value > COLLABORATION_PAGE_MAX) throw new Error("invalid_limit");
	return value;
}

const hash = (value) => createHash("sha256").update(value).digest("hex");

export function createCollaborationStore(db) {
	if (!db || typeof db.prepare !== "function" || typeof db.transaction !== "function") throw new Error("invalid_database");
	db.exec(`CREATE TABLE IF NOT EXISTS managed_collaboration_tasks (
		task_id TEXT PRIMARY KEY,
		command_id TEXT NOT NULL UNIQUE,
		source_thread_id TEXT NOT NULL,
		target_thread_id TEXT NOT NULL,
		target_runner_instance_id TEXT NOT NULL,
		request_id TEXT NOT NULL,
		prompt TEXT NOT NULL,
		prompt_hash TEXT NOT NULL,
		source_runner_id TEXT NOT NULL,
		target_runner_id TEXT NOT NULL,
		source_name TEXT NOT NULL,
		target_name TEXT NOT NULL,
		status TEXT NOT NULL,
		started INTEGER NOT NULL DEFAULT 0,
		result_outcome TEXT,
		result_summary TEXT,
		result_hash TEXT,
		notification_id TEXT UNIQUE,
		notification_status TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		UNIQUE(source_thread_id, request_id)
	);
	CREATE INDEX IF NOT EXISTS managed_collaboration_source_tasks ON managed_collaboration_tasks(source_thread_id, task_id);
	CREATE INDEX IF NOT EXISTS managed_collaboration_target_tasks ON managed_collaboration_tasks(target_thread_id, task_id);
	CREATE INDEX IF NOT EXISTS managed_collaboration_pending_notifications ON managed_collaboration_tasks(source_thread_id, notification_status, task_id);`);

	const selectTask = db.prepare("SELECT * FROM managed_collaboration_tasks WHERE task_id = ?");
	const selectRequest = db.prepare("SELECT * FROM managed_collaboration_tasks WHERE source_thread_id = ? AND request_id = ?");
	const insertTask = db.prepare(`INSERT INTO managed_collaboration_tasks
		(task_id,command_id,source_thread_id,target_thread_id,target_runner_instance_id,request_id,prompt,prompt_hash,source_runner_id,target_runner_id,source_name,target_name,status,created_at,updated_at)
		VALUES (@taskId,@commandId,@sourceThreadId,@targetThreadId,@targetRunnerInstanceId,@requestId,@prompt,@promptHash,@sourceRunnerId,@targetRunnerId,@sourceName,@targetName,'dispatching',@now,@now)`);
	const updateState = db.prepare("UPDATE managed_collaboration_tasks SET status = ?, started = ?, updated_at = ? WHERE task_id = ?");
	const saveResult = db.prepare(`UPDATE managed_collaboration_tasks SET status=@outcome, result_outcome=@outcome,
		result_summary=@summary, result_hash=@resultHash, notification_id=@notificationId,
		notification_status='pending', updated_at=@now WHERE task_id=@taskId`);
	const saveNotification = db.prepare("UPDATE managed_collaboration_tasks SET notification_status = ?, updated_at = ? WHERE task_id = ?");

	function task(row) {
		if (!row) return null;
		return {
			taskId: row.task_id, commandId: row.command_id,
			sourceThreadId: row.source_thread_id, targetThreadId: row.target_thread_id,
			targetRunnerInstanceId: row.target_runner_instance_id, requestId: row.request_id,
			prompt: row.prompt, sourceRunnerId: row.source_runner_id, targetRunnerId: row.target_runner_id,
			sourceName: row.source_name, targetName: row.target_name, status: row.status,
			createdAt: row.created_at, updatedAt: row.updated_at, started: Boolean(row.started),
			result: row.result_outcome ? { outcome: row.result_outcome, summary: row.result_summary, notificationId: row.notification_id } : null,
			notificationStatus: row.notification_status,
		};
	}

	const create = db.transaction((input) => {
		const parsed = parseCreate(input);
		const previous = selectRequest.get(parsed.sourceThreadId, parsed.requestId);
		if (previous) {
			if (previous.target_thread_id !== parsed.targetThreadId || previous.prompt_hash !== parsed.promptHash) throw new Error("collaboration_request_conflict");
			return { task: task(previous), created: false };
		}
		const now = new Date().toISOString();
		const record = { ...parsed, taskId: randomUUID(), commandId: randomUUID(), now };
		insertTask.run(record);
		return { task: task(selectTask.get(record.taskId)), created: true };
	});

	const report = db.transaction((targetThreadId, input) => {
		collaborationId(targetThreadId);
		const taskId = collaborationId(input?.taskId);
		if (!OUTCOMES.has(input?.outcome)) throw new Error("invalid_outcome");
		const summary = collaborationText(input?.summary, "summary");
		const row = selectTask.get(taskId);
		if (!row) throw new Error("unknown_collaboration_task");
		if (row.target_thread_id !== targetThreadId) throw new Error("collaboration_target_mismatch");
		const resultHash = hash(JSON.stringify([input.outcome, summary]));
		if (row.result_hash) {
			if (row.result_hash !== resultHash) throw new Error("collaboration_result_conflict");
			return task(row);
		}
		if (!row.started || row.status === "rejected") throw new Error("collaboration_task_not_reportable");
		// A restored Tower backup must reproduce the same notification identity.
		saveResult.run({ taskId, outcome: input.outcome, summary, resultHash, notificationId: taskId, now: new Date().toISOString() });
		return task(selectTask.get(taskId));
	});
	const transition = db.transaction((taskId, status) => {
		collaborationId(taskId);
		if (!TRANSITIONS.has(status)) throw new Error("invalid_status");
		const row = selectTask.get(taskId);
		if (!row) throw new Error("unknown_collaboration_task");
		if (row.result_outcome || row.status === "rejected") return task(row);
		if (row.status === "unknown") {
			if (status === "running" && !row.started) updateState.run("unknown", 1, new Date().toISOString(), taskId);
			return task(selectTask.get(taskId));
		}
		if (row.status === "running" && status === "accepted") return task(row);
		updateState.run(status, row.started || status === "running" ? 1 : 0, new Date().toISOString(), taskId);
		return task(selectTask.get(taskId));
	});

	return {
		create,
		reconcile: db.transaction((input) => {
			const parsed = parseCreate(input);
			collaborationId(input.taskId); collaborationId(input.commandId);
			const previous = selectTask.get(input.taskId) ?? selectRequest.get(parsed.sourceThreadId, parsed.requestId);
			if (previous) {
				if (previous.task_id !== input.taskId || previous.command_id !== input.commandId || previous.target_thread_id !== input.targetThreadId || previous.prompt_hash !== parsed.promptHash) throw new Error("collaboration_reconciliation_conflict");
				return task(previous);
			}
			insertTask.run({ ...parsed, taskId: input.taskId, commandId: input.commandId, now: new Date().toISOString() });
			updateState.run("unknown", 0, new Date().toISOString(), input.taskId);
			return task(selectTask.get(input.taskId));
		}),
		get(taskId) { return task(selectTask.get(collaborationId(taskId))); },
		list(threadId, options = {}) {
			collaborationId(threadId);
			const limit = collaborationPageLimit(options.limit);
			const clauses = ["(source_thread_id = @threadId OR target_thread_id = @threadId)"];
			const values = { threadId, limit: limit + 1 };
			if (options.taskId !== undefined) { clauses.push("task_id = @taskId"); values.taskId = collaborationId(options.taskId); }
			if (options.requestId !== undefined) { clauses.push("source_thread_id = @threadId AND request_id = @requestId"); values.requestId = collaborationId(options.requestId); }
			if (options.status !== undefined) { if (!TASK_STATUSES.has(options.status)) throw new Error("invalid_status"); clauses.push("status = @status"); values.status = options.status; }
			if (options.cursor !== undefined) { clauses.push("task_id > @cursor"); values.cursor = collaborationId(options.cursor); }
			const rows = db.prepare(`SELECT * FROM managed_collaboration_tasks WHERE ${clauses.join(" AND ")} ORDER BY task_id LIMIT @limit`).all(values);
			const more = rows.length > limit;
			const page = rows.slice(0, limit);
			return { tasks: page.map(task), nextCursor: more ? page.at(-1).task_id : null };
		},
		transition,
		report,
		acknowledge(sourceThreadId, taskId, status) {
			collaborationId(sourceThreadId); collaborationId(taskId);
			if (!new Set(["delivered", "unknown"]).has(status)) throw new Error("invalid_notification_status");
			const row = selectTask.get(taskId);
			if (!row) throw new Error("unknown_collaboration_task");
			if (row.source_thread_id !== sourceThreadId) throw new Error("collaboration_source_mismatch");
			if (!row.result_outcome) throw new Error("collaboration_notification_missing");
			if (row.notification_status === "delivered") return task(row);
			saveNotification.run(status, new Date().toISOString(), taskId);
			return task(selectTask.get(taskId));
		},
		pendingNotifications(sourceThreadId) {
			collaborationId(sourceThreadId);
			return db.prepare("SELECT * FROM managed_collaboration_tasks WHERE source_thread_id = ? AND notification_status = 'pending' ORDER BY task_id LIMIT ?")
				.all(sourceThreadId, COLLABORATION_PAGE_MAX).map(task);
		},
		interruptTarget(targetThreadId) {
			collaborationId(targetThreadId);
			return db.prepare("UPDATE managed_collaboration_tasks SET status='unknown', updated_at=? WHERE target_thread_id=? AND result_outcome IS NULL AND status IN ('dispatching','accepted','running') RETURNING *")
				.all(new Date().toISOString(), targetThreadId).map(task);
		},
		recover() {
			return db.prepare("UPDATE managed_collaboration_tasks SET status = 'unknown', updated_at = ? WHERE result_outcome IS NULL AND status IN ('dispatching','accepted','running')")
				.run(new Date().toISOString()).changes;
		},
		updateByCommand(threadId, receipt) {
			collaborationId(threadId); collaborationId(receipt?.commandId);
			if (!RECEIPT_STATUSES.has(receipt?.status)) throw new Error("invalid_command_receipt");
			const row = db.prepare("SELECT * FROM managed_collaboration_tasks WHERE command_id = ? AND target_thread_id = ?").get(receipt.commandId, threadId);
			if (!row) throw new Error("unknown_collaboration_command");
			const mapped = receipt.status === "accepted" ? "accepted" : receipt.status === "rejected" ? "rejected" : "unknown";
			return transition(row.task_id, mapped);
		},
	};
}

function parseCreate(input) {
	if (!input || typeof input !== "object") throw new Error("invalid_collaboration_task");
	const sourceThreadId = collaborationId(input.sourceThreadId);
	const targetThreadId = collaborationId(input.targetThreadId);
	if (sourceThreadId === targetThreadId) throw new Error("collaboration_self_delegate");
	const prompt = collaborationText(input.prompt, "prompt");
	return {
		sourceThreadId, targetThreadId, prompt, promptHash: hash(prompt),
		targetRunnerInstanceId: collaborationId(input.targetRunnerInstanceId), requestId: collaborationId(input.requestId),
		sourceRunnerId: collaborationMetadata(input.sourceRunnerId, "source_runner_id"),
		targetRunnerId: collaborationMetadata(input.targetRunnerId, "target_runner_id"),
		sourceName: collaborationMetadata(input.sourceName, "source_name"),
		targetName: collaborationMetadata(input.targetName, "target_name"),
	};
}
