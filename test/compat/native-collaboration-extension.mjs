import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const { fauxProvider, fauxAssistantMessage } = await import(process.env.PI_COMPAT_PACKAGE + "/node_modules/@earendil-works/pi-ai/dist/index.js");
export default function(pi) {
	const provider = fauxProvider({ provider: "native-collaboration", tokensPerSecond: 0 });
	const setResponses = provider.setResponses;
	provider.setResponses = steps => setResponses(steps.map(step => context => {
		assert.equal(process.env.PI_TOWER_URL, undefined);
		assert.equal(process.env.PI_TOWER_TOKEN, undefined);
		const tools = context.tools.map(tool => tool.name);
		for (const name of ["thread_list", "thread_delegate", "thread_tasks", "thread_report"]) assert.ok(tools.includes(name), name);
		assert.ok(!tools.includes("runner_task") && !tools.includes("runner_list"));
		assert.match(context.systemPrompt, /These tools reuse this Runner's Tower connection/);
		assert.match(context.systemPrompt, /admission, not completion/);
		assert.ok(context.systemPrompt.includes(process.env.EXPECTED_SKILL));
		assert.ok(!context.systemPrompt.includes(process.env.PROBE_ROOT + "/legacy/skills"));
		appendFileSync(process.env.PROBE_ROOT + "/model-context.jsonl", JSON.stringify({runner:process.env.FIXTURE_RUNNER,tools,systemPrompt:context.systemPrompt}) + "\n");
		return typeof step === "function" ? step(context) : step;
	}));
	const tool = (name, args) => fauxAssistantMessage({type:"toolCall",id:name+"-"+Math.random(),name,arguments:args},{stopReason:"toolUse"});
	const result = context => {
		const message = context.messages.at(-1);
		assert.equal(message.role, "toolResult");
		assert.ok(!message.isError, JSON.stringify(message));
		return message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
	};
	pi.registerProvider(provider.provider);
	pi.registerCommand("fixture-name", { handler: async (name) => pi.setSessionName(name) });
	pi.on("before_agent_start", async (event) => {
		appendFileSync(process.env.PROBE_ROOT + "/prompts.jsonl", JSON.stringify({runner:process.env.FIXTURE_RUNNER,prompt:event.prompt,pid:process.pid}) + "\n");
		const config = existsSync(process.env.PROBE_ROOT + "/fixture.json") ? JSON.parse(readFileSync(process.env.PROBE_ROOT + "/fixture.json", "utf8")) : {};
		const delegated = /^Task ([0-9a-f-]+) from runner/.exec(event.prompt);
		if (delegated) {
			appendFileSync(process.env.PROBE_ROOT + "/target-starts.jsonl", JSON.stringify({taskId:delegated[1],pid:process.pid}) + "\n");
			if (event.prompt.includes("list local Git branches")) {
				provider.setResponses([tool("bash", {command:"git branch --format='%(refname:short)'"}), context => {
					const branches = result(context).trim().split("\n").sort();
					assert.deepEqual(branches, ["fixture-feature", "main"]);
					return tool("thread_report", {taskId:delegated[1],outcome:"completed",summary:"pi branches: " + branches.join(", ")});
				}, fauxAssistantMessage("target has reported branches")]);
				return;
			}
			if (event.prompt.includes("hold-at-barrier")) while (!existsSync(process.env.PROBE_ROOT + "/release")) await new Promise(r => setTimeout(r, 20));
			provider.setResponses([fauxAssistantMessage({type:"toolCall",id:"report-"+delegated[1],name:"thread_report",arguments:{taskId:delegated[1],outcome:"completed",summary:"native result "+delegated[1]}},{stopReason:"toolUse"}), fauxAssistantMessage("distinct ordinary target assistant text")]);
			return;
		}
		const requestId = config.requests?.[event.prompt];
		if (event.prompt === "delegate-back") {
			provider.setResponses([tool("thread_list", {project:"fx"}), context => {
				const matches = JSON.parse(result(context)).threads;
				assert.equal(matches.length, 1);
				assert.equal(matches[0].runnerId, "shared-native");
				assert.equal(matches[0].threadId, config.sourceThreadId);
				return tool("thread_delegate", {targetThreadId:matches[0].threadId,prompt:"reverse collaboration probe",requestId});
			}, fauxAssistantMessage("reverse delegation admitted")]);
			return;
		}
		if (event.prompt === "discover-pi-branches") {
			provider.setResponses([tool("read", {path:process.env.EXPECTED_SKILL}), context => {
				const skill = result(context);
				assert.match(skill, /When `thread_list`/);
				assert.match(skill, /No additional `PI_TOWER_URL` or `PI_TOWER_TOKEN` is needed/);
				assert.match(skill, /Legacy relay in ordinary pi/);
				return tool("thread_list", {project:"pi"});
			}, context => {
				const matches = JSON.parse(result(context)).threads;
				assert.equal(matches.length, 1);
				assert.equal(matches[0].runnerId, "shared-native");
				assert.equal(matches[0].cwd, process.env.TARGET_CWD);
				assert.equal(matches[0].threadId, config.targetThreadId);
				return tool("thread_delegate", {targetThreadId:matches[0].threadId,prompt:"list local Git branches and report them with thread_report",requestId});
			}, fauxAssistantMessage("branch delegation admitted; awaiting explicit report")]);
			return;
		}
		if (event.prompt === "query-branches") {
			provider.setResponses([tool("thread_tasks", {requestId:config.requests["discover-pi-branches"]}), context => {
				const task = JSON.parse(result(context)).tasks[0];
				assert.equal(task.status, "completed");
				assert.equal(task.result.summary, "pi branches: fixture-feature, main");
				return fauxAssistantMessage("verified explicit branch report");
			}]);
			return;
		}
		if (requestId) provider.setResponses([fauxAssistantMessage({type:"toolCall",id:"delegate-"+requestId,name:"thread_delegate",arguments:{targetThreadId:config.targetThreadId,prompt:["delegate-first", "delegate-pending"].includes(event.prompt) ? "hold-at-barrier" : event.prompt,requestId}},{stopReason:"toolUse"}), fauxAssistantMessage("source delegation admitted")]);
		else provider.setResponses([fauxAssistantMessage("ordinary source answer")]);
	});
}
