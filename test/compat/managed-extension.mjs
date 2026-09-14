// Real pi SDK provider and hooks, no network or credentials.
import { appendFileSync } from "node:fs";
const { fauxProvider, fauxAssistantMessage } = await import(`${process.env.PI_COMPAT_PACKAGE}/node_modules/@earendil-works/pi-ai/dist/index.js`);
export default function (pi) {
	const provider = fauxProvider({ provider: "phase1", tokensPerSecond: 0 });
	provider.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("已完成🙂")));
	pi.registerProvider(provider.provider);
	pi.on("session_start", (_, ctx) => appendFileSync(process.env.MANAGED_TEST_LOG, `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), model: ctx.model })}\n`));
	pi.on("before_agent_start", async (event) => {
		pi.appendEntry("phase1-cwd", { cwd: process.cwd() });
		if (event.prompt === "slow") await new Promise((resolve) => setTimeout(resolve, 1500));
	});
}
