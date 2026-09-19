// Bounded crash-boundary tests using durable files and reopened databases.
// These boundaries are simulated deterministically; this test does not send SIGKILL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { createCollaborationStore } from "../src/managed/collaboration-store.mjs";
import { deliverResult } from "../src/managed/collaboration-runtime.mjs";
import { ManagedRunner } from "../src/managed/runner.mjs";
import { durableWrite, readJson } from "../src/managed/storage.mjs";

const root = mkdtempSync(resolve(tmpdir(), "pi-collaboration-recovery-"));
const ids = { source: randomUUID(), target: randomUUID(), instance: randomUUID(), request: randomUUID() };
const request = {
	sourceThreadId: ids.source, targetThreadId: ids.target, targetRunnerInstanceId: ids.instance,
	requestId: ids.request, prompt: "recover this task", sourceRunnerId: "runner-a",
	targetRunnerId: "runner-b", sourceName: "Source", targetName: "Target",
};

try {
	// Simulated boundary: Tower backup exists before task creation; the caller retained
	// the admitted task envelope and reconciles it after restoring that older backup.
	const liveFile = resolve(root, "live.sqlite"), backupFile = resolve(root, "before-task.sqlite");
	let db = new Database(liveFile), store = createCollaborationStore(db);
	await db.backup(backupFile);
	const admitted = store.create(request).task;
	db.close();
	cpSync(backupFile, liveFile);
	db = new Database(liveFile); store = createCollaborationStore(db);
	const recovered = store.reconcile({ ...request, taskId: admitted.taskId, commandId: admitted.commandId });
	assert.equal(recovered.taskId, admitted.taskId, "reconstitution preserves the admitted task ID");
	assert.equal(recovered.commandId, admitted.commandId, "reconstitution preserves the admitted command ID");
	assert.equal(recovered.status, "unknown", "reconstituted work remains uncertain");
	assert.equal(recovered.started, false, "reconstitution itself is not replay evidence");

	// Simulated boundary: late evidence says the original command ran. It marks started
	// without claiming a replay, so an explicit report is permitted.
	const withEvidence = store.transition(admitted.taskId, "running");
	assert.equal(withEvidence.status, "unknown");
	assert.equal(withEvidence.started, true);
	const beforeReport = resolve(root, "before-report.sqlite");
	await db.backup(beforeReport);
	const firstReport = store.report(ids.target, { taskId: admitted.taskId, outcome: "completed", summary: "original result" });
	assert.equal(firstReport.result.notificationId, admitted.taskId);
	db.close();
	cpSync(beforeReport, liveFile);
	db = new Database(liveFile); store = createCollaborationStore(db);
	const restoredReport = store.report(ids.target, { taskId: admitted.taskId, outcome: "completed", summary: "original result" });
	assert.equal(restoredReport.result.notificationId, firstReport.result.notificationId, "restore-before-report reproduces notification identity");
	db.close();

	const deliveryDir = resolve(root, "delivery"); mkdirSync(deliveryDir);
	const notificationId = randomUUID();
	const task = { taskId: randomUUID(), sourceThreadId: ids.source, targetThreadId: ids.target,
		sourceRunnerId: "runner-a", targetRunnerId: "runner-b", targetName: "Target",
		result: { outcome: "completed", summary: "done", notificationId } };
	const recordFile = resolve(deliveryDir, "record.json"); durableWrite(recordFile, {});
	let sends = 0, saves = 0, entries = [];
	const session = { sessionManager: { getEntries: () => entries }, async sendCustomMessage() { sends++; } };

	// Simulated boundary: notification intent is durable, but no session entry exists.
	durableWrite(resolve(deliveryDir, `notification-${notificationId}.json`), { notificationId, taskId: task.taskId, status: "dispatching" });
	assert.deepEqual(await deliverResult(session, task, recordFile, () => saves++), { status: "unknown" });
	assert.equal(sends, 0, "uncertain durable intent is never retriggered");

	// Simulated boundary: the session entry landed before its ACK was observed.
	entries = [{ customType: "tower-collaboration-result", details: { notificationId } }];
	assert.deepEqual(await deliverResult(session, task, recordFile, () => saves++), { status: "delivered" });
	assert.equal(sends, 0, "existing session entry is acknowledged without retriggering");
	assert.equal(saves, 1);

	// Simulated boundary: runner durably saved its report, then lost the HQ ACK.
	const runnerDir = resolve(root, "runner"); mkdirSync(runnerDir);
	const runnerRecordFile = resolve(runnerDir, "record.json"); durableWrite(runnerRecordFile, {});
	const runnerTask = { ...task, taskId: randomUUID(), commandId: randomUUID() };
	const taskFile = resolve(runnerDir, `task-${runnerTask.taskId}.json`);
	durableWrite(taskFile, { task: runnerTask, status: "running", started: true, bootId: randomUUID() });
	const entry = { record: { threadId: ids.target }, recordFile: runnerRecordFile, quarantined: false };
	const interruptedRunner = Object.assign(Object.create(ManagedRunner.prototype), {
		reconciled: true, bootId: randomUUID(), connectionId: randomUUID(),
		async callHQ() { throw new Error("hq_timeout_unknown"); },
	});
	const report = { taskId: runnerTask.taskId, outcome: "completed", summary: "immutable first result" };
	const pending = await interruptedRunner.collaborationTool(entry, "thread_report", report);
	assert.equal(pending.reportSavedLocally, true);
	assert.deepEqual(readJson(taskFile).report, report);
	await assert.rejects(interruptedRunner.collaborationTool(entry, "thread_report", { ...report, summary: "replacement" }), /result_conflict/);

	// Reopening is represented by a fresh runner object reading the same durable directory.
	const recoveredCalls = [];
	const reopenedRunner = Object.assign(Object.create(ManagedRunner.prototype), {
		reconciled: true, bootId: randomUUID(), connectionId: randomUUID(), emit() {},
		async callHQ(_entry, operation, input) {
			recoveredCalls.push({ operation, input });
			// The task ends while its result ACK is in flight.
			durableWrite(taskFile, { ...readJson(taskFile), status: "unknown" });
			return { status: "completed" };
		},
	});
	await reopenedRunner.syncCollaboration({ ...entry, collaborationSyncing: false });
	assert.deepEqual(recoveredCalls.filter(({ operation }) => operation === "thread_report").map(({ input }) => input), [report]);
	assert.equal(readJson(taskFile).reportAck, true, "reopened runner records the recovered HQ ACK");
	assert.deepEqual(readJson(taskFile).report, report, "recovery preserves the first result byte-for-byte");
	assert.equal(readJson(taskFile).status, "unknown", "ACK cannot overwrite newer task-end evidence");

	// Offline local rename competes with a newer Tower version, then is resolved explicitly.
	const naming = { recordFile: resolve(root, "naming.json"), record: { threadId: ids.source, localName: "original", metadataVersion: 1 } };
	let canonical = { title: "web name", metadataVersion: 2 };
	const names = Object.assign(Object.create(ManagedRunner.prototype), { reconciled: false,
		async callHQ(_entry, _operation, input) {
			if (input.title !== undefined) {
				if (input.metadataVersion !== canonical.metadataVersion) throw new Error("metadata_conflict");
				canonical = { title: input.title, metadataVersion: canonical.metadataVersion + 1 };
			}
			return canonical;
		},
	});
	names.observeName(naming, "offline name");
	assert.equal(naming.record.rename.metadataVersion, 1);
	names.reconciled = true;
	await names.syncMetadata(naming);
	assert.ok(naming.record.metadataConflict);
	await names.syncMetadata(naming);
	assert.equal(naming.record.localName, "offline name", "background sync must preserve the conflicting local name");
	assert.equal(naming.record.metadataVersion, 2, "read current version before retrying rename");
	names.observeName(naming, "resolved name");
	while (naming.metadataSyncing) await new Promise((done) => setTimeout(done, 1));
	assert.equal(canonical.title, "resolved name");
	assert.equal(naming.record.metadataConflict, undefined);
	assert.equal(naming.record.rename, undefined);

	console.log("ok collaboration recovery (simulated boundaries, no SIGKILL): preserved IDs, unknown/no replay, late report, stable notification, delivery dedup, and durable runner report recovery");
} finally {
	rmSync(root, { recursive: true, force: true });
}
