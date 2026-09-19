// Finds and loads the pi SDK a runner drives. A compiled runner carries pi and its assets inside
// the executable; from source it uses the installed dependency. --pi-package overrides both.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJson } from "./storage.mjs";

export const PI_VERSION = "0.85.1";

// scripts/build-runner.mjs embeds this tree; node:fs reads it in place, so nothing is unpacked.
const embedded = resolve(dirname(fileURLToPath(import.meta.url)), "embedded");
const embeddedPi = resolve(embedded, "pi");
const compiled = existsSync(resolve(embeddedPi, "package.json"));

export function piPackageDir(explicit) {
	const directory = explicit ? resolve(explicit) : compiled ? embeddedPi : installedPi();
	if (readJson(resolve(directory, "package.json")).version !== PI_VERSION) throw new Error(`pi-runner requires pi ${PI_VERSION}`);
	return directory;
}

function installedPi() {
	try {
		return resolve(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")), "../..");
	} catch {
		throw new Error(`pi ${PI_VERSION} is not installed beside pi-tower: run bun install, or pass --pi-package <directory>`);
	}
}

export async function loadPi(directory) {
	if (directory !== embeddedPi) return import(pathToFileURL(resolve(directory, "dist/index.js")));
	process.env.PI_PACKAGE_DIR = embeddedPi; // pi reads its version, themes and templates from here.
	return import("@earendil-works/pi-coding-agent");
}

// The remote-runner skill that ships with these tools.
export const skillsDir = compiled ? resolve(embedded, "skills/remote-runner") : fileURLToPath(new URL("../../skills/remote-runner", import.meta.url));

// A compiled runner has no script files to start, so it re-enters itself through a subcommand.
// From source, Bun would otherwise load the workspace's .env files into the child's environment.
const reenter = (command, script) => (...args) =>
	compiled ? [command, ...args] : ["--no-env-file", fileURLToPath(new URL(script, import.meta.url)), ...args];

export const HOST_COMMAND = "__pi-host"; // hosts one managed thread's pi
export const hostArgs = reenter(HOST_COMMAND, "./pi.mjs");
export const CLI_COMMAND = "__pi"; // the pi CLI itself, one per legacy relay session
export const cliArgs = reenter(CLI_COMMAND, "./pi-cli.mjs");
