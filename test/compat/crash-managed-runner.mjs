// Fault injection around this project's persistence/RPC boundary, not pi internals.
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const [boundary, runnerFile, ...args] = process.argv.slice(2);
const crash = () => process.kill(process.pid, "SIGKILL");
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
	const status = to.includes("/commands/") ? JSON.parse(fs.readFileSync(from, "utf8")).status : null;
	if (status && boundary === `before_${status}`) crash();
	rename(from, to);
	if (status && boundary === status) crash();
};
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
	const child = spawn(...args);
	const write = child.stdin.write.bind(child.stdin);
	child.stdin.write = (chunk, ...rest) => {
		const prompt = JSON.parse(String(chunk)).type === "prompt";
		if (prompt && boundary === "before_send") crash();
		const result = write(chunk, ...rest);
		if (prompt && boundary === "after_send") crash();
		return result;
	};
	return child;
};
syncBuiltinESMExports();
process.argv = [process.execPath, runnerFile, ...args];
await import(runnerFile);
