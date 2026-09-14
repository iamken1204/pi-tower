// Test-only extension. The provider returns scripted messages without network IO.
import { appendFileSync, readFileSync } from "node:fs";
const { fauxProvider, fauxAssistantMessage } = await import(`${process.env.PI_COMPAT_PACKAGE}/node_modules/@earendil-works/pi-ai/dist/index.js`);

export default function (pi) {
	const faux = fauxProvider({ provider: "phase0", tokensPerSecond: 0 });
	faux.setResponses(Array.from({ length: 12 }, (_, i) => fauxAssistantMessage(`回答${i}：台灣🙂\u2028中段\u2029末段`)));
	pi.registerProvider(faux.provider);
	for (const type of ["message_end", "agent_end", "agent_settled"]) {
		pi.on(type, (event, ctx) => {
			const file = ctx.sessionManager.getSessionFile();
			let disk = [];
			try { disk = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse); } catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			appendFileSync(process.env.PI_COMPAT_EVENTS, `${JSON.stringify({ type, message: event.message, entries: ctx.sessionManager.getEntries(), disk })}\n`);
		});
	}
	pi.registerCommand("probe-custom", { handler: async () => pi.appendEntry("phase0", { nested: ["台灣", 73] }) });
	pi.registerCommand("probe-header", { handler: async (_, ctx) => ctx.ui.notify(JSON.stringify(ctx.sessionManager.getHeader()), "info") });
	pi.registerCommand("probe-dialogs", {
		handler: async (_, ctx) => {
			const values = [await ctx.ui.select("select", ["甲", "乙"]), await ctx.ui.confirm("confirm", "繼續？"),
				await ctx.ui.input("input"), await ctx.ui.editor("editor", "原文")];
			pi.appendEntry("dialogs", values);
		},
	});
	pi.on("session_before_compact", (event) => ({ compaction: {
		summary: "測試壓縮摘要", firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore, details: { phase0: true },
	} }));
}
