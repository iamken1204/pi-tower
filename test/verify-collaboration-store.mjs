import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/managed/sqlite.mjs";
import { COLLABORATION_METADATA_BYTES, COLLABORATION_PAGE_MAX, COLLABORATION_TEXT_BYTES, createCollaborationStore } from "../src/managed/collaboration-store.mjs";

const directory = mkdtempSync(resolve(tmpdir(), "pi-collaboration-store-"));
let db = openDatabase(resolve(directory, "tower.db"));
const ids = { source: randomUUID(), target: randomUUID(), other: randomUUID(), instance: randomUUID() };
const input = (overrides = {}) => ({ sourceThreadId: ids.source, targetThreadId: ids.target, targetRunnerInstanceId: ids.instance,
	requestId: randomUUID(), prompt: "do work", sourceRunnerId: "runner-a", targetRunnerId: "runner-b", sourceName: "A", targetName: "B", ...overrides });

try {
	let store = createCollaborationStore(db);
	const request = input();
	const first = store.create(request);
	assert.equal(first.created, true);
	assert.match(first.task.taskId, /^[0-9a-f-]{36}$/);
	assert.match(first.task.commandId, /^[0-9a-f-]{36}$/);
	assert.equal(first.task.status, "dispatching");
	assert.equal(first.task.started, false);
	assert.equal(first.task.result, null);
	assert.equal(first.task.notificationStatus, null);
	assert.deepEqual(store.create(request), { task: first.task, created: false });
	assert.throws(() => store.create({ ...request, prompt: "different" }), /request_conflict/);
	assert.throws(() => store.create({ ...request, targetThreadId: ids.other }), /request_conflict/);
	assert.equal(store.create({ ...request, sourceThreadId: ids.other }).created, true, "request IDs are isolated by source");
	assert.equal(store.list(ids.target, { requestId: request.requestId }).tasks.length, 0, "request IDs only search sent tasks");
	assert.equal(store.list(ids.source, { requestId: request.requestId }).tasks[0].taskId, first.task.taskId);

	assert.throws(() => store.report(ids.target, { taskId: first.task.taskId, outcome: "completed", summary: "early" }), /not_reportable/);
	assert.equal(store.updateByCommand(ids.target, { commandId: first.task.commandId, status: "accepted" }).status, "accepted");
	assert.equal(store.transition(first.task.taskId, "running").started, true);
	assert.equal(store.transition(first.task.taskId, "accepted").status, "running", "running does not regress");
	assert.throws(() => store.report(ids.other, { taskId: first.task.taskId, outcome: "completed", summary: "spoof" }), /target_mismatch/);
	const reported = store.report(ids.target, { taskId: first.task.taskId, outcome: "completed", summary: "done" });
	assert.equal(reported.status, "completed");
	assert.deepEqual(reported.result.outcome, "completed");
	assert.equal(reported.notificationStatus, "pending");
	assert.equal(store.report(ids.target, { taskId: first.task.taskId, outcome: "completed", summary: "done" }).result.notificationId, reported.result.notificationId);
	assert.throws(() => store.report(ids.target, { taskId: first.task.taskId, outcome: "failed", summary: "done" }), /result_conflict/);
	assert.equal(store.transition(first.task.taskId, "unknown").status, "completed", "terminal result is immutable");
	assert.equal(store.pendingNotifications(ids.source).length, 1);
	assert.throws(() => store.acknowledge(ids.other, first.task.taskId, "delivered"), /source_mismatch/);
	assert.equal(store.acknowledge(ids.source, first.task.taskId, "delivered").notificationStatus, "delivered");
	assert.equal(store.acknowledge(ids.source, first.task.taskId, "unknown").notificationStatus, "delivered");

	const late = store.create(input()).task;
	store.transition(late.taskId, "running");
	store.transition(late.taskId, "unknown");
	assert.equal(store.report(ids.target, { taskId: late.taskId, outcome: "failed", summary: "late" }).status, "failed");
	const rejected = store.create(input()).task;
	store.transition(rejected.taskId, "rejected");
	assert.equal(store.transition(rejected.taskId, "running").status, "rejected");
	assert.throws(() => store.report(ids.target, { taskId: rejected.taskId, outcome: "failed", summary: "no" }), /not_reportable/);

	const recoverAccepted = store.create(input()).task;
	store.transition(recoverAccepted.taskId, "accepted");
	const recoverRunning = store.create(input()).task;
	store.transition(recoverRunning.taskId, "running");
	const recoverDispatching = store.create(input()).task;
	assert.throws(() => store.updateByCommand(ids.other, { commandId: recoverDispatching.commandId, status: "accepted" }), /unknown_collaboration_command/);
	db.close();
	db = openDatabase(resolve(directory, "tower.db"));
	store = createCollaborationStore(db);
	assert.equal(store.recover(), 4);
	for (const id of [recoverAccepted.taskId, recoverRunning.taskId, recoverDispatching.taskId]) assert.equal(store.get(id).status, "unknown");
	assert.equal(store.get(recoverRunning.taskId).started, true);
	assert.equal(store.get(first.task.taskId).status, "completed");
	assert.equal(store.get(first.task.taskId).notificationStatus, "delivered");

	for (let i = 0; i < 24; i++) store.create(input());
	const page1 = store.list(ids.source);
	assert.equal(page1.tasks.length, 10); assert.ok(page1.nextCursor);
	const page2 = store.list(ids.source, { cursor: page1.nextCursor, limit: COLLABORATION_PAGE_MAX });
	assert.equal(page2.tasks.length, 20);
	assert.ok(page1.tasks.at(-1).taskId < page2.tasks[0].taskId);
	assert.throws(() => store.list(ids.source, { limit: COLLABORATION_PAGE_MAX + 1 }), /invalid_limit/);

	assert.equal(store.create(input({ prompt: "x".repeat(COLLABORATION_TEXT_BYTES) })).created, true);
	assert.throws(() => store.create(input({ prompt: "x".repeat(COLLABORATION_TEXT_BYTES + 1) })), /invalid_prompt/);
	assert.equal(store.create(input({ sourceName: "x".repeat(COLLABORATION_METADATA_BYTES) })).created, true);
	assert.throws(() => store.create(input({ sourceName: "x".repeat(COLLABORATION_METADATA_BYTES + 1) })), /invalid_source_name/);
	assert.throws(() => store.create(input({ requestId: "not-uuid" })), /invalid_collaboration_id/);
	console.log("ok collaboration store: idempotency, state, reports, notifications, recovery, pagination, and limits");
} finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
