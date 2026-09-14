// Disposable, no-LLM browser fixture. POST /stop on its separate control URL cleans up.
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTower } from "../../tower.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = mkdtempSync(resolve(tmpdir(), "pi-browser-fixture-"));
const pkg = process.env.PI_COMPAT_PACKAGE || resolve(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
for (const dir of ["home", "agent/extensions", "workspace", "runner", "tower"]) mkdirSync(resolve(directory, dir), { recursive: true });
cpSync(resolve(root, "test/compat/managed-extension.mjs"), resolve(directory, "agent/extensions/fixture.js"));
writeFileSync(resolve(directory, "agent/settings.json"), JSON.stringify({ defaultProvider: "phase1", defaultModel: "faux-1", compaction: { enabled: false } }));
const token = "disposable-browser-fixture";
let tower = createTower({ token, dataDir: resolve(directory, "tower") });
tower.listen(0, "127.0.0.1"); await once(tower, "listening");
const port = tower.address().port;
let runner;
function startRunner() {
	runner = spawn(process.execPath, [resolve(root, "runner.mjs"), "--hq", `ws://127.0.0.1:${port}`, "--id", "fixture-runner", "--token", token,
		"--managed-threads", "--data-dir", resolve(directory, "runner"), "--pi-package", pkg, "--managed-idle-ms", "1000"], {
		cwd: resolve(directory, "workspace"), stdio: ["ignore", "ignore", "inherit"],
		env: { PATH: process.env.PATH, HOME: resolve(directory, "home"), PI_CODING_AGENT_DIR: resolve(directory, "agent"), PI_OFFLINE: "1", PI_COMPAT_PACKAGE: pkg, MANAGED_TEST_LOG: resolve(directory, "children.jsonl") },
	});
}
async function stopRunner() {
	if (runner.exitCode !== null || runner.signalCode !== null) return;
	const exited = once(runner, "exit"); runner.kill("SIGTERM"); await exited;
}
startRunner();
const control = createServer(async (req, res) => {
	if (req.method !== "POST") { res.writeHead(405).end(); return; }
	try {
		if (req.url === "/runner-offline") await stopRunner();
		else if (req.url === "/runner-online") startRunner();
		else if (req.url === "/restart-tower") {
			await tower.shutdown(); tower = createTower({ token, dataDir: resolve(directory, "tower") });
			tower.listen(port, "127.0.0.1"); await once(tower, "listening");
		} else if (req.url === "/stop") {
			await stopRunner(); await tower.shutdown(); res.end("stopped"); control.close();
			rmSync(directory, { recursive: true, force: true }); return;
		} else { res.writeHead(404).end(); return; }
		res.end("ok");
	} catch (error) { res.writeHead(500).end(error.message); }
});
control.listen(0, "127.0.0.1"); await once(control, "listening");
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/threads`, control: `http://127.0.0.1:${control.address().port}`, token, directory }));
