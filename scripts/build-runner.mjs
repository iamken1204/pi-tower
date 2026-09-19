#!/usr/bin/env bun
// Compiles pi-runner, pi included, into one executable.
// usage: bun scripts/build-runner.mjs [--outfile dist/pi-runner] [--target bun-linux-x64]
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piPackageDir } from "../src/managed/pi-sdk.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const outfile = resolve(root, option("--outfile", "dist/pi-runner"));
const target = option("--target");

// The layout pi expects beside its own compiled binary, plus this project's skill.
const pi = piPackageDir();
const stage = resolve(root, "build/embedded");
rmSync(stage, { recursive: true, force: true });
mkdirSync(resolve(stage, "pi"), { recursive: true });
for (const [from, to] of [
	["package.json", "pi/package.json"],
	["dist/modes/interactive/theme", "pi/theme"],
	["dist/modes/interactive/assets", "pi/assets"],
	["dist/core/export-html", "pi/export-html"],
]) cpSync(resolve(pi, from), resolve(stage, to), { recursive: true });
cpSync(resolve(root, "skills/remote-runner"), resolve(stage, "skills/remote-runner"), { recursive: true });

// A runner starts inside other people's projects, so their .env and bunfig.toml never configure it.
const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
	...(target ? [`--target=${target}`] : []), "--asset=embedded", resolve(root, "src/runner.mjs"), "--outfile", outfile],
{ cwd: resolve(root, "build"), stdio: ["ignore", "inherit", "inherit"] });
process.exit(build.exitCode);
