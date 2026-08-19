#!/usr/bin/env node
// pi-task: dispatch a prompt to a remote pi runner via a tower; final answer on stdout.
import { formatRunners, listRunners, runTask } from "./lib.mjs";

const usage = `usage: pi-task [--tower <ws(s)://url>] [--token <t>] [--session <name>] [--fresh] <runner-id> "<prompt>"
       pi-task --list
env fallbacks: PI_TOWER_URL, PI_TOWER_TOKEN
quickstart:
  pi-task --list                    # who's online
  pi-task win-test-1 "run the failing job and report the error"
--session: same name shares context across tasks, different names run in parallel (default: main)
progress streams to stderr; stdout carries only the final answer`;

function fail(msg) {
	console.error(`${msg}\n${usage}`);
	process.exit(1);
}

function parseArgs(argv) {
	const opts = {
		tower: process.env.PI_TOWER_URL,
		token: process.env.PI_TOWER_TOKEN,
		session: undefined,
		fresh: false,
		list: false,
		rest: [],
	};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--tower") opts.tower = argv[++i];
		else if (argv[i] === "--token") opts.token = argv[++i];
		else if (argv[i] === "--session") opts.session = argv[++i];
		else if (argv[i] === "--fresh") opts.fresh = true;
		else if (argv[i] === "--list") opts.list = true;
		else if (argv[i] === "--help" || argv[i] === "-h") {
			console.log(usage);
			process.exit(0);
		} else if (argv[i].startsWith("--")) fail(`unknown option ${argv[i]}`);
		else opts.rest.push(argv[i]);
	}
	return opts;
}

const { tower, token, session, fresh, list, rest } = parseArgs(process.argv.slice(2));
if (!tower || !token) fail("missing tower url or token");
if (session !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(session)) fail("invalid --session name");

try {
	if (list) {
		console.log(formatRunners(await listRunners(tower, token)));
	} else {
		if (rest.length !== 2) fail("expected <runner-id> and <prompt>");
		const ctl = new AbortController();
		process.on("SIGINT", () => ctl.abort()); // forwards abort to the runner before dying
		const text = await runTask({
			tower,
			token,
			runnerId: rest[0],
			session,
			prompt: rest[1],
			fresh,
			signal: ctl.signal,
			// deltas only for humans; piped stderr (agent callers) gets just the failure reason
			onDelta: process.stderr.isTTY ? (delta) => process.stderr.write(delta) : undefined,
		});
		if (process.stderr.isTTY) process.stderr.write("\n");
		console.log(text);
	}
	process.exit(0);
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
