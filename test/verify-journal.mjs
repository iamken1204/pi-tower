import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { CommandJournal, commandPayload } from "../src/managed/journal.mjs";

const directory = mkdtempSync(resolve(tmpdir(), "pi-command-journal-"));
try {
	const atLimit = "🙂".repeat(65536);
	assert.equal(commandPayload({ operation: "prompt", message: atLimit }).message, atLimit);
	assert.throws(() => commandPayload({ operation: "prompt", message: atLimit + "x" }), /invalid_command/);
	assert.equal(commandPayload({ operation: "prompt", message: "queued" }).behavior, undefined);
	assert.equal(commandPayload({ operation: "prompt", message: "now", behavior: "steer" }).behavior, "steer");
	assert.throws(() => commandPayload({ operation: "prompt", message: "bad", behavior: "interrupt" }), /invalid_command/);
	const payload = commandPayload({ operation: "prompt", message: "asymmetric fixture 73" });
	let journal = new CommandJournal(directory, randomUUID());
	const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
	for (const id of ids) journal.receive(id, payload);
	journal.transition(ids[1], "dispatching");
	journal.transition(ids[2], "accepted");
	journal.transition(ids[3], "settled");
	journal = new CommandJournal(directory, randomUUID());
	assert.deepEqual(ids.map((id) => journal.receive(id, payload).status), ["unknown", "unknown", "unknown", "settled"]);
	assert.throws(() => journal.receive(ids[1], commandPayload({ operation: "prompt", message: "different" })), /command_payload_conflict/);
	assert.equal(journal.transition(ids[1], "dispatching").status, "unknown", "an old boot's uncertain operation cannot be reactivated");
	assert.equal(journal.transition(ids[1], "settled").status, "unknown", "new boot cannot claim to observe the old run settle");
	assert.equal(journal.transition(ids[3], "accepted").status, "settled", "late acceptance cannot overwrite completion");
	console.log("ok journal: durable received/dispatching/accepted boundaries become unknown on restart, terminal receipts survive");
} finally { rmSync(directory, { recursive: true, force: true }); }
