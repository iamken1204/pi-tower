import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = process.env.PI_COMPAT_PACKAGE || resolve(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const temp = realpathSync(mkdtempSync(resolve(tmpdir(), "pi-tower-pi-compat-")));
for (const dir of ["home", "workspace", "agent"]) mkdirSync(resolve(temp, dir));
writeFileSync(resolve(temp, "agent/settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1 } }));
const cwd = resolve(temp, "workspace");
const eventsFile = resolve(temp, "events.jsonl");
const env = { PATH: process.env.PATH, HOME: resolve(temp, "home"), PI_CODING_AGENT_DIR: resolve(temp, "agent"),
	PI_OFFLINE: "1", PI_COMPAT_PACKAGE: pkg, PI_COMPAT_EVENTS: eventsFile };
const cli = resolve(pkg, "dist/bundle/cli.js");
const args = [cli, "--mode", "rpc", "-ne", "-ns", "-np", "--no-themes", "-e", resolve(here, "pi-extension.mjs"), "--provider", "phase0", "--model", "faux-1"];
const children = new Set();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function start(extra = []) {
	const child = spawn(process.execPath, [...args, ...extra], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	children.add(child);
	const frames = [];
	let buf = "", stderr = "", seq = 0;
	child.stderr.on("data", (c) => stderr += c);
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).replace(/\r$/, ""); buf = buf.slice(nl + 1);
			if (line) frames.push(JSON.parse(line));
		}
	});
	async function wait(predicate, from = 0) {
		for (let i = 0; i < 1500; i++) {
			const frame = frames.slice(from).find(predicate);
			if (frame) return frame;
			if (child.exitCode !== null) throw new Error(`pi exited: ${stderr.slice(-2500)}`);
			await pause(10);
		}
		throw new Error(`RPC timeout: ${stderr}\n${JSON.stringify(frames.slice(-5))}`);
	}
	return { child, frames, wait,
		async request(type, fields = {}, fragmented = false) {
			const id = `q${++seq}`;
			const bytes = Buffer.from(`${JSON.stringify({ id, type, ...fields })}\r\n`);
			if (fragmented) for (const byte of bytes) { child.stdin.write(Buffer.from([byte])); await pause(1); }
			else child.stdin.write(bytes);
			const response = await wait((f) => f.type === "response" && f.id === id);
			assert.equal(response.success, true, JSON.stringify(response));
			return response.data;
		},
		async stop() { const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; children.delete(child); },
	};
}

try {
	console.log(`versions: Node ${process.version}, pi ${JSON.parse(readFileSync(resolve(pkg, "package.json"))).version}`);
	const pi = start();
	const blank = await pi.request("get_state");
	assert.ok(blank.sessionId);
	assert.equal(existsSync(blank.sessionFile), false);
	await pi.stop();
	const emptyRestart = start();
	assert.notEqual((await emptyRestart.request("get_state")).sessionId, blank.sessionId);
	await emptyRestart.stop();
	console.log("ok real CLI: blank session has ID but no file; fresh restart gets a different ID");

	const live = start();
	for (const message of ["第一輪🙂\u2028第二段\u2029第三段", "第二輪"]) {
		const from = live.frames.length;
		await live.request("prompt", { message }, true);
		await live.wait((f) => f.type === "agent_settled", from);
	}
	const before = await live.request("get_entries");
	assert.equal(before.entries.filter((e) => e.message?.role === "assistant").length, 2);
	assert.equal(before.entries.find((e) => e.message?.role === "user").message.content[0].text, "第一輪🙂\u2028第二段\u2029第三段");
	await live.request("prompt", { message: "/probe-custom" });
	await live.request("compact");
	const compacted = await live.request("get_entries");
	assert.deepEqual(compacted.entries.slice(0, before.entries.length), before.entries);
	assert.ok(compacted.entries.some((e) => e.type === "compaction"));
	assert.ok(compacted.entries.some((e) => e.customType === "phase0"));
	const cursor = before.entries.at(-1).id;
	assert.deepEqual((await live.request("get_entries", { since: cursor })).entries, compacted.entries.slice(before.entries.length));
	console.log("ok real CLI + faux provider: LF/CRLF fragmented UTF-8, full entries, custom entry, compaction, cursor");

	const logs = readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse);
	for (const log of logs.filter((e) => e.type === "message_end")) {
		assert.ok(!log.entries.some((e) => e.message && JSON.stringify(e.message) === JSON.stringify(log.message)));
		assert.ok(!log.disk.some((e) => e.message && JSON.stringify(e.message) === JSON.stringify(log.message)));
	}
	const settled = logs.filter((e) => e.type === "agent_settled");
	assert.equal(settled.length, 2);
	assert.equal(settled.at(-1).entries.filter((e) => e.message?.role === "assistant").length, 2);
	assert.deepEqual(settled.at(-1).disk.slice(1), settled.at(-1).entries);
	assert.ok(live.frames.findIndex((e) => e.type === "agent_end") < live.frames.findIndex((e) => e.type === "agent_settled"));
	console.log("ok real event ordering: message_end precedes memory/disk append; settled sees persisted messages");

	const from = live.frames.length;
	const dialogDone = live.request("prompt", { message: "/probe-dialogs" });
	let offset = from;
	for (const [method, value] of [["select", "乙"], ["confirm", true], ["input", "接手裝置"], ["editor", "多行\n回覆"]]) {
		const pending = await live.wait((f) => f.type === "extension_ui_request" && f.method === method, offset);
		offset = live.frames.indexOf(pending) + 1;
		// A replacement logical client retains the pending ID. Pi has no browser ownership concept.
		live.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: "stale-id", value: "wrong" })}\n`);
		await pause(30);
		live.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: pending.id, ...(method === "confirm" ? { confirmed: value } : { value }) })}\n`);
	}
	await dialogDone;
	const full = await live.request("get_entries");
	assert.deepEqual(full.entries.find((e) => e.customType === "dialogs").data, ["乙", true, "接手裝置", "多行\n回覆"]);
	const state = await live.request("get_state");
	await live.request("prompt", { message: "/probe-header" });
	const headerFrame = await live.wait((f) => f.type === "extension_ui_request" && f.method === "notify");
	const header = JSON.parse(headerFrame.message);
	assert.equal(header.id, state.sessionId);
	assert.equal(header.cwd, cwd);
	await live.stop();
	console.log("ok real extension dialogs: select/confirm/input/editor can be answered by replacement logical client; stale IDs ignored");

	const snapshot = resolve(temp, "snapshot.json");
	const sdk = (mode) => console.log(execFileSync(process.execPath, [resolve(here, "pi-sdk-worker.mjs"), mode, state.sessionFile, snapshot], { cwd, env, encoding: "utf8" }).trim());
	sdk("capture");
	const saved = JSON.parse(readFileSync(snapshot));
	const reopened = start(["--session", state.sessionFile]);
	assert.equal((await reopened.request("get_state")).sessionId, state.sessionId);
	assert.deepEqual((await reopened.request("get_entries")).entries, saved.entries);
	assert.notEqual((await reopened.request("get_entries")).leafId, saved.leafId);
	await reopened.stop();
	sdk("restore");
	// Model a lost local session restored from an independently stored full snapshot.
	rmSync(state.sessionFile);
	writeFileSync(state.sessionFile, [saved.header, ...saved.entries].map(JSON.stringify).join("\n") + "\n", { flag: "wx" });
	sdk("restore");
	console.log("verify-pi: PASS (real pi CLI/SDK, synthetic provider, zero paid LLM calls)");
} finally {
	for (const child of children) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
	}
	rmSync(temp, { recursive: true, force: true });
}
