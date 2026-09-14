// Process-owning public pi RPC host. Only the runner can feed this child's stdin.
import { pathToFileURL } from "node:url";
import { checkpoint, durableWrite, loadCheckpoint, readJson, syncFile } from "./managed-storage.mjs";

const [packageDir, recordFile] = process.argv.slice(2);
const record = readJson(recordFile);
const saved = loadCheckpoint(record.checkpointFile, record.sessionFile, record.piSessionId, process.cwd());
const api = await import(pathToFileURL(`${packageDir}/dist/index.js`));
const version = readJson(`${packageDir}/package.json`).version;
if (version !== "0.85.1") throw new Error(`unsupported_pi_version: expected 0.85.1, got ${version}`);
const sm = api.SessionManager.open(record.sessionFile);
if (saved.leafId === null) sm.resetLeaf();
else sm.branch(saved.leafId);
if (JSON.stringify(sm.getEntries()) !== JSON.stringify(saved.entries) || sm.getSessionId() !== record.piSessionId) throw new Error("pi_restore_mismatch");

function save() {
	const value = checkpoint(sm.getHeader(), sm.getEntries(), sm.getLeafId());
	if (value.header.id !== record.piSessionId || value.header.cwd !== process.cwd()) throw new Error("pi_identity_changed");
	// Pi owns JSONL writes. Force its existing file before acknowledging the independent leaf record.
	syncFile(record.sessionFile);
	durableWrite(record.checkpointFile, value);
}

const runtime = await api.createAgentSessionRuntime(async (options) => {
	const services = await api.createAgentSessionServices(options);
	return { ...await api.createAgentSessionFromServices({ ...options, services }), services, diagnostics: services.diagnostics };
}, { cwd: process.cwd(), agentDir: api.getAgentDir(), sessionManager: sm });

runtime.session.subscribe((event) => {
	if (event.type === "agent_settled") {
		try { save(); process.send?.({ type: "checkpoint" }); }
		catch { process.send?.({ type: "checkpoint_error" }); process.exit(1); }
	}
});
runtime.setBeforeSessionInvalidate(() => {
	save();
	process.send?.({ type: "saved_shutdown" });
});
// RPC binds extensions before accepting stdin. Its ready get_state response is the startup barrier.
await api.runRpcMode(runtime);
