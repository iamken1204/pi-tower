// Package loading: `pi -e .` must register the extension (no extension_error) and the remote-runner skill.
// --tower proves the extension loaded: pi rejects flags no extension registered as "Unknown option".
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const pi = spawn(
	"pi",
	// -ne isolates from user-installed packages (a global pi-tower would conflict on --tower)
	["-ne", "-e", ".", "--tower", "ws://127.0.0.1:9", "--tower-token", "x", "--mode", "rpc", "--no-session"],
	{
		cwd: new URL("..", import.meta.url).pathname,
		stdio: ["pipe", "pipe", "inherit"],
	},
);
const killTimer = setTimeout(() => {
	console.error("timeout waiting for pi");
	pi.kill("SIGKILL");
	process.exit(1);
}, 60000);

const extensionErrors = [];
const responses = new Map();
let buf = "";
const waiters = new Map();
pi.stdout.on("data", (chunk) => {
	buf += chunk.toString("utf8");
	let nl;
	while ((nl = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, nl).replace(/\r$/, "");
		buf = buf.slice(nl + 1);
		if (!line) continue;
		const msg = JSON.parse(line);
		if (msg.type === "extension_error") extensionErrors.push(msg);
		if (msg.type === "response" && msg.id) {
			responses.set(msg.id, msg);
			waiters.get(msg.id)?.(msg);
		}
	}
});

const request = (id, type) => {
	const p = new Promise((r) => waiters.set(id, r));
	pi.stdin.write(`${JSON.stringify({ id, type })}\n`);
	return p;
};

const state = await request("p1", "get_state");
assert.equal(state.success, true);
console.log("ok pi -e . accepts --tower (extension loaded via package manifest)");

const commands = await request("p2", "get_commands");
assert.equal(commands.success, true);
const skill = commands.data.commands.find((c) => c.name === "skill:remote-runner");
assert.ok(skill, "skill:remote-runner listed in get_commands");
assert.equal(skill.source, "skill");
console.log("ok remote-runner skill registered");

assert.deepEqual(extensionErrors, [], "no extension_error events");
console.log("ok no extension errors");

clearTimeout(killTimer);
pi.kill("SIGTERM");
console.log("verify-package: all green");
process.exit(0);
