import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const token = "disposable-browser-fixture";
let fixture;
let browser;
let fixtureInfo;
let collaborationFixture;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(predicate, label) {
	for (let attempt = 0; attempt < 150; attempt++) {
		if (await predicate()) return;
		await sleep(100);
	}
	throw new Error(`timeout: ${label}`);
}

function startFixture() {
	return new Promise((resolveFixture, rejectFixture) => {
		fixture = spawn(process.execPath, [resolve(root, "test/compat/browser-fixture.mjs")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		fixture.stdout.on("data", (chunk) => {
			stdout += chunk;
			const line = stdout.split("\n").find((value) => value.startsWith("{"));
			if (!line) return;
			try { resolveFixture(JSON.parse(line)); } catch {}
		});
		fixture.stderr.on("data", (chunk) => { stderr += chunk; });
		fixture.once("error", rejectFixture);
		fixture.once("exit", (code) => rejectFixture(new Error(`browser fixture exited ${code}: ${stderr}`)));
	});
}

function startCollaborationFixture() {
	return new Promise((resolveFixture, rejectFixture) => {
		collaborationFixture = spawn(process.execPath, [resolve(root, "test/compat/collaboration-browser-fixture.mjs")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		collaborationFixture.stdout.on("data", (chunk) => {
			stdout += chunk;
			const line = stdout.split("\n").find((value) => value.startsWith("{"));
			if (!line) return;
			try { resolveFixture(JSON.parse(line)); } catch {}
		});
		collaborationFixture.stderr.on("data", (chunk) => { stderr += chunk; });
		collaborationFixture.once("error", rejectFixture);
		collaborationFixture.once("exit", (code) => rejectFixture(new Error(`collaboration fixture exited ${code}: ${stderr}`)));
	});
}

async function visibleText(locator, text) {
	await locator.waitFor({ state: "visible" });
	await until(async () => (await locator.innerText()).toLocaleLowerCase().includes(text.toLocaleLowerCase()), `visible ${text}`);
}

async function openToolDetails(page) {
	await page.locator("#conversation details").evaluateAll((items) => items.forEach((item) => { item.open = true; }));
}

async function visibleToolText(page, text) {
	await until(async () => {
		if (!(await page.locator("#conversation").textContent()).includes(text)) return false;
		await openToolDetails(page);
		return (await page.locator("#conversation").innerText()).includes(text);
	}, `visible tool text ${text}`);
}

async function stopChild(child) {
	if (!child || child.exitCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	await Promise.race([exited, sleep(2_000)]);
	if (child.exitCode === null) child.kill("SIGKILL");
}

try {
	fixtureInfo = await startFixture();
	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	const errors = [];
	const attachDiagnostics = (page) => {
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("console", (message) => {
		if (message.type() === "error" && !/Failed to load resource: the server responded with a status of (401|404)/.test(message.text())) errors.push(message.text());
		});
	};
	const page = await context.newPage();
	attachDiagnostics(page);

	await page.goto(fixtureInfo.url, { waitUntil: "networkidle" });
	await page.locator("#token").fill(token);
	await Promise.all([page.waitForNavigation({ waitUntil: "networkidle" }), page.locator("#login button").click()]);
	await page.locator("#create").waitFor({ state: "visible" });
	const stylesheet = await page.evaluate(async () => {
		const response = await fetch("/ui.css");
		return { status: response.status, contentType: response.headers.get("content-type") };
	});
	assert.equal(stylesheet.status, 200, "The shared stylesheet must load.");
	assert.match(stylesheet.contentType || "", /^text\/css\b/i);
	await page.locator("#create").click();
	await page.locator("#edit-title").fill("Browser acceptance");
	await page.locator("#edit-form .primary").click();
	await page.waitForURL(/\/threads\/[0-9a-f-]{36}$/i);
	await visibleText(page.locator("#thread-title"), "Browser acceptance");

	await page.locator("#prompt").fill("smoke-write");
	await page.locator("#send").click();
	await visibleText(page.locator("#conversation"), "Fixture tool finished.");
	await visibleToolText(page, "cloud-threads-smoke-73");
	assert.equal(readFileSync(resolve(fixtureInfo.directory, "workspace", "smoke.txt"), "utf8"), "cloud-threads-smoke-73\n");

	await page.reload({ waitUntil: "networkidle" });
	await visibleText(page.locator("#conversation"), "Fixture tool finished.");
	await visibleToolText(page, "cloud-threads-smoke-73");
	const entriesBeforeComposition = await page.locator("#conversation .entry").count();
	await page.evaluate(() => {
		window.promptFrames = 0;
		const send = WebSocket.prototype.send;
		WebSocket.prototype.send = function (data) {
			if (typeof data === "string" && data.includes('"operation":"prompt"')) window.promptFrames++;
			return send.call(this, data);
		};
	});
	await page.locator("#prompt").fill("composing draft");
	await page.locator("#prompt").evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
	await sleep(250);
	assert.equal(await page.locator("#prompt").inputValue(), "composing draft");
	assert.equal(await page.evaluate(() => window.promptFrames), 0);
	assert.equal(await page.locator("#conversation .entry").count(), entriesBeforeComposition);
	await page.locator("#prompt").press("Shift+Enter");
	assert.equal(await page.locator("#prompt").inputValue(), "composing draft\n");
	await page.locator("#prompt").fill("");

	await page.locator("#rename").click();
	await page.locator("#edit-title").fill("Renamed acceptance");
	await page.locator("#edit-form .primary").click();
	await visibleText(page.locator("#thread-title"), "Renamed acceptance");
	await visibleText(page.locator("#thread-list"), "Renamed acceptance");

	const filtered = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return url.pathname === "/api/threads" && url.searchParams.get("q") === "thread-not-in-catalog" && response.status() === 200;
	});
	await page.locator("#search").fill("thread-not-in-catalog");
	await filtered;
	await page.locator("#empty").waitFor({ state: "visible" });
	await visibleText(page.locator("#thread-title"), "Renamed acceptance");
	await visibleText(page.locator("#conversation"), "Fixture tool finished.");
	await page.locator("#search").fill("");

	const draft = "draft survives thread switch";
	await page.locator("#prompt").fill(draft);
	await page.locator("#create").click();
	await page.locator("#edit-title").fill("Second acceptance");
	await page.locator("#edit-form .primary").click();
	await visibleText(page.locator("#thread-title"), "Second acceptance");
	await page.locator("#thread-list a", { hasText: "Renamed acceptance" }).click();
	await visibleText(page.locator("#thread-title"), "Renamed acceptance");
	assert.equal(await page.locator("#prompt").inputValue(), draft, "The pending draft stays with its thread.");

	const archiveLabel = await page.locator("#archive-action").innerText();
	await page.locator("#archive-action").click();
	await until(async () => (await page.locator("#archive-action").innerText()) !== archiveLabel, "archive action updates");
	await page.locator("#archive-action").click();
	await until(async () => (await page.locator("#archive-action").innerText()) === archiveLabel, "unarchive action updates");

	await page.locator("#prompt").fill("draft survives connection state");
	await fetch(`${fixtureInfo.control}/runner-offline`, { method: "POST" });
	await until(async () => await page.locator("#send").isDisabled(), "send disabled offline");
	await fetch(`${fixtureInfo.control}/runner-online`, { method: "POST" });
	await until(async () => !(await page.locator("#send").isDisabled()), "send enabled after reconnect");

	const tablet = await context.newPage();
	attachDiagnostics(tablet);
	await tablet.setViewportSize({ width: 900, height: 900 });
	await tablet.goto(page.url(), { waitUntil: "networkidle" });
	await tablet.locator("#inspector-toggle").click();
	await tablet.keyboard.press("Control+K");
	await until(async () => await tablet.locator("#search").evaluate((element) => document.activeElement === element), "search focus after inspector shortcut");
	assert.equal(await tablet.locator("#main").evaluate((element) => element.hasAttribute("inert")), false);
	assert.equal(await tablet.locator("#thread-sidebar").evaluate((element) => element.hasAttribute("inert")), false);

	const mobile = await context.newPage();
	attachDiagnostics(mobile);
	await mobile.setViewportSize({ width: 390, height: 844 });
	await mobile.goto(page.url(), { waitUntil: "networkidle" });
	await mobile.locator("#sidebar-toggle").focus();
	await mobile.locator("#sidebar-toggle").click();
	await mobile.locator("#thread-sidebar").waitFor({ state: "visible" });
	assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "Mobile layout must not overflow horizontally.");
	await mobile.keyboard.press("Escape");
	await mobile.locator("#thread-sidebar").waitFor({ state: "hidden" });
	assert.equal(await mobile.locator("#sidebar-toggle").evaluate((element) => document.activeElement === element), true, "Closing the drawer returns focus to its trigger.");

	const collaboration = await startCollaborationFixture();
	const collaborationPage = await context.newPage();
	attachDiagnostics(collaborationPage);
	await collaborationPage.goto(collaboration.url, { waitUntil: "networkidle" });
	await collaborationPage.locator("#tasks-tab").click();
	await visibleText(collaborationPage.locator("#task-list"), "Migration notes checked. The existing session IDs stay unchanged.");
	await visibleText(collaborationPage.locator("#task-list"), "Updated the API guide. <img src=x onerror=alert(1)>");
	assert.equal(await collaborationPage.locator("#task-list img").count(), 0, "Task text must not create HTML elements.");
	await visibleText(collaborationPage.locator("#conversation"), "A normal user-facing assistant answer.");
	assert.equal((await collaborationPage.locator("#conversation").innerText()).includes("DUPLICATE MUST NOT RENDER"), false);

	assert.deepEqual(errors, [], `browser errors: ${errors.join(" | ")}`);
	console.log("ok browser UI: managed thread and collaboration views preserve persisted behavior, safe text, reconnects, and mobile access");
} finally {
	await browser?.close();
	if (fixtureInfo?.control) {
		try { await fetch(`${fixtureInfo.control}/stop`, { method: "POST" }); } catch {}
	}
	await stopChild(fixture);
	await stopChild(collaborationFixture);
}
