// Run all repository checks from a disposable workspace and empty pi profile.
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = process.env.PI_COMPAT_PACKAGE || resolve(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const temp = mkdtempSync(resolve(tmpdir(), "pi-tower-regression-"));
try {
	for (const dir of ["home", "agent", "workspace"]) mkdirSync(resolve(temp, dir));
	const cwd = resolve(temp, "workspace");
	for (const file of ["src", "package.json", "skills", "test"])
		cpSync(resolve(root, file), resolve(cwd, file), { recursive: true });
	symlinkSync(resolve(root, "node_modules"), resolve(cwd, "node_modules"), "dir");
	const env = { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: resolve(temp, "home"),
		PI_CODING_AGENT_DIR: resolve(temp, "agent"), PI_OFFLINE: "1", PI_COMPAT_PACKAGE: pkg };
	execFileSync(process.execPath, ["run", "verify"], { cwd, env, stdio: "inherit", timeout: 300_000 });
} finally {
	rmSync(temp, { recursive: true, force: true });
}
