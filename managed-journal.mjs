import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { durableWrite, privateDirectory, readJson, uuid } from "./managed-storage.mjs";

const textLimit = Number(process.env.PI_MANAGED_TEXT_BYTES ?? 256 * 1024);
if (!Number.isSafeInteger(textLimit) || textLimit < 1) throw new Error("invalid_managed_text_limit");

export function commandPayload(input) {
	if (!["prompt", "abort", "extension_ui_response"].includes(input.operation)) throw new Error("invalid_command");
	if (input.operation === "prompt" && (typeof input.message !== "string" || !input.message.trim() || input.message.trimStart().startsWith("/") || Buffer.byteLength(input.message) > textLimit)) throw new Error("invalid_command");
	if (input.operation === "prompt" && input.behavior !== undefined && !["followUp", "steer"].includes(input.behavior)) throw new Error("invalid_command");
	if (input.operation !== "prompt") uuid(input.targetRunId);
	if (input.operation === "extension_ui_response" && (typeof input.dialogId !== "string" || !["boolean", "string"].includes(typeof input.value) || Buffer.byteLength(String(input.value)) > textLimit)) throw new Error("invalid_command");
	const payload = { operation: input.operation, message: input.message ?? null, targetRunId: input.targetRunId ?? null,
		dialogId: input.dialogId ?? null, value: input.value ?? null };
	// Absence is the legacy durable representation and means followUp on dispatch.
	if (input.operation === "prompt" && input.behavior !== undefined) payload.behavior = input.behavior;
	if (input.operation === "prompt" && input.task !== undefined) {
		const task = input.task;
		for (const key of ["taskId", "commandId", "sourceThreadId", "targetThreadId", "targetRunnerInstanceId"]) uuid(task[key]);
		if (task.commandId !== input.commandId || task.prompt !== input.message || input.behavior !== "followUp") throw new Error("invalid_task_command");
		payload.task = task;
	}
	return payload;
}
export const payloadHash = (payload) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

export class CommandJournal {
	constructor(directory, bootId) {
		this.directory = directory;
		this.bootId = bootId;
		privateDirectory(directory);
		for (const receipt of this.all()) {
			if (["received", "dispatching", "accepted"].includes(receipt.status)) this.save({ ...receipt, status: "unknown" });
		}
	}
	file(id) { return resolve(this.directory, `${uuid(id)}.json`); }
	get(id) {
		const file = this.file(id);
		if (!existsSync(file)) return null;
		const receipt = readJson(file);
		if (receipt.commandId !== id || receipt.payloadHash !== payloadHash(receipt.payload) ||
			!["received", "dispatching", "accepted", "rejected", "settled", "unknown"].includes(receipt.status)) throw new Error("invalid_command_journal");
		return receipt;
	}
	all() { return readdirSync(this.directory).filter((file) => file.endsWith(".json")).map((file) => this.get(file.slice(0, -5))); }
	save(receipt) { durableWrite(this.file(receipt.commandId), receipt); return receipt; }
	receive(commandId, payload, epoch = null) {
		const previous = this.get(commandId);
		const hash = payloadHash(payload);
		if (previous && previous.payloadHash !== hash) throw new Error("command_payload_conflict");
		return previous || this.save({ commandId, payload, payloadHash: hash, bootId: this.bootId, epoch, status: "received" });
	}
	transition(commandId, status) {
		const receipt = this.get(commandId);
		if (!receipt) throw new Error("unknown_command");
		if (["rejected", "settled"].includes(receipt.status)) return receipt;
		if (receipt.status === "unknown" && !(status === "settled" && receipt.bootId === this.bootId)) return receipt;
		return this.save({ ...receipt, status });
	}
}
