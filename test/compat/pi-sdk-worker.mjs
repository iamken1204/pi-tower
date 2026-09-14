// Public SDK only; each invocation runs in the fixture's original cwd.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { SessionManager, createAgentSession, DefaultResourceLoader, ModelRuntime } = await import(pathToFileURL(`${process.env.PI_COMPAT_PACKAGE}/dist/index.js`));
const { fauxProvider, fauxAssistantMessage } = await import(`${process.env.PI_COMPAT_PACKAGE}/node_modules/@earendil-works/pi-ai/dist/index.js`);
const [mode, file, snapshotFile] = process.argv.slice(2);
const sm = SessionManager.open(file);
if (mode === "capture") {
	const original = sm.getEntries();
	const firstAssistant = original.find((e) => e.type === "message" && e.message.role === "assistant");
	sm.branch(firstAssistant.id);
	sm.appendMessage({ role: "user", content: "abandoned tool branch", timestamp: 1 });
	sm.appendMessage(fauxAssistantMessage({ type: "toolCall", id: "probe-call", name: "probe", arguments: {} }, { stopReason: "toolUse" }));
	sm.appendMessage({ role: "toolResult", toolCallId: "probe-call", toolName: "probe", isError: false,
		content: [{ type: "text", text: "工具結果🙂".repeat(20_000) }], details: { preserved: 73 }, timestamp: 2 });
	sm.appendCustomEntry("abandoned-branch", { value: 19 });
	sm.branch(original.at(-1).id);
	writeFileSync(snapshotFile, JSON.stringify({ header: sm.getHeader(), entries: sm.getEntries(), leafId: sm.getLeafId() }));
	assert.notEqual(sm.getLeafId(), sm.getEntries().at(-1).id);
} else {
	const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
	assert.notEqual(sm.getLeafId(), snapshot.leafId, "JSONL alone loses non-tail leaf");
	sm.branch(snapshot.leafId);
	assert.deepEqual(sm.getEntries(), snapshot.entries);
	assert.deepEqual(sm.getHeader(), snapshot.header);
	const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	const faux = fauxProvider({ provider: "phase0", tokensPerSecond: 0 });
	faux.setResponses([fauxAssistantMessage("還原後回答")]);
	const modelRuntime = await ModelRuntime.create({ authPath: `${process.env.PI_CODING_AGENT_DIR}/auth.json`, allowModelNetwork: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
		sessionManager: sm, resourceLoader: loader, modelRuntime, model: faux.getModel(), tools: [] });
	assert.equal(session.sessionManager.getSessionId(), snapshot.header.id);
	assert.equal(session.sessionManager.getLeafId(), snapshot.leafId);
	assert.equal(session.sessionManager.getCwd(), process.cwd());
	assert.deepEqual(session.sessionManager.getEntries(), snapshot.entries);
	const memory = SessionManager.inMemory(process.cwd(), undefined, [snapshot.header, ...snapshot.entries]);
	memory.resetLeaf();
	assert.equal(memory.getLeafId(), null);
	assert.deepEqual(memory.getEntries(), snapshot.entries);
	memory.branch(snapshot.leafId);
	assert.deepEqual(memory.buildSessionContext(), sm.buildSessionContext());
	await session.prompt("還原後接續");
	const appended = sm.getEntries().slice(snapshot.entries.length);
	assert.equal(appended[0].parentId, snapshot.leafId);
	assert.equal(appended[0].message.role, "user");
	assert.equal(appended.at(-1).message.role, "assistant");
	assert.equal(appended.at(-1).message.stopReason, "stop");
	assert.deepEqual(sm.getEntries().slice(0, snapshot.entries.length), snapshot.entries);
	const shell = await session.executeBash("pwd");
	assert.equal(shell.exitCode, 0);
	assert.equal(shell.output.trim(), process.cwd());
	session.dispose();
}
console.log(`ok SDK ${mode}: full tree, session ID, cwd, leaf`);
