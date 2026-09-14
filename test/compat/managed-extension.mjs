// Real pi SDK provider and hooks, no network or credentials.
import { appendFileSync } from "node:fs";
const { fauxProvider, fauxAssistantMessage } = await import(`${process.env.PI_COMPAT_PACKAGE}/node_modules/@earendil-works/pi-ai/dist/index.js`);
export default function (pi) {
	const provider = fauxProvider({ provider: "phase1", tokensPerSecond: 0 });
	provider.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("已完成🙂")));
	pi.registerProvider(provider.provider);
	pi.on("session_start", (_, ctx) => appendFileSync(process.env.MANAGED_TEST_LOG, `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), model: ctx.model })}\n`));
	pi.on("before_agent_start", async (event, ctx) => {
		pi.appendEntry("phase1-cwd", { cwd: process.cwd() });
		if (["smoke-write", "smoke-write-slow", "smoke-check"].includes(event.prompt)) {
			const tool = fauxAssistantMessage("");
			tool.content = [{ type: "toolCall", id: `fixture-${Date.now()}`, name: "bash", arguments: {
				command: event.prompt === "smoke-check" ? "pwd; cat smoke.txt" : "printf 'cloud-threads-smoke-73\\n' > smoke.txt; pwd; cat smoke.txt",
			} }];
			tool.stopReason = "toolUse";
			provider.setResponses([tool, fauxAssistantMessage("Fixture tool finished. See the bash result for the original workspace and file contents."),
				...Array.from({ length: 20 }, () => fauxAssistantMessage("已完成🙂"))]);
		}
		if (event.prompt === "smoke-write-slow") await new Promise((resolve) => setTimeout(resolve, 5000));
		if (event.prompt === "slow") await new Promise((resolve) => setTimeout(resolve, 1500));
		if (event.prompt === "dialog") pi.appendEntry("dialog-answer", { confirmed: await ctx.ui.confirm("Continue fixture?", "No external actions") });
	});
}
