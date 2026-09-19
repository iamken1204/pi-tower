// Stands in for the pi package behind --pi-package: logs its lifecycle, then either is the real pi or a fake RPC process.
import { appendFileSync } from "node:fs";

const log = (event) =>
	appendFileSync(process.env.PHASE0_CRASH_LOG, `${JSON.stringify({ event, pid: process.pid, ppid: process.ppid, at: Date.now() })}\n`);

export async function main(args) {
	log("started");
	process.stdin.setEncoding("utf8");
	process.stdin.on("end", () => log("eof"));
	if (process.env.PHASE0_REAL_PI) return (await import(process.env.PHASE0_REAL_PI)).main(args);

	process.stdin.on("data", async () => {
		log("busy");
		const bytes = Buffer.from(JSON.stringify({ text: "台灣🙂 中段 末段" }) + "\n");
		for (const byte of bytes) {
			process.stdout.write(Buffer.from([byte]));
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	});
	process.stdin.resume();

	// Deliberately model both an idle RPC process and work that continues after its
	// wrapper's pipe disappears. The probe owns and explicitly terminates this PID.
	return new Promise(() => setInterval(() => {}, 60_000));
}
