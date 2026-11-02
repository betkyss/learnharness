/** Checks real layout, live settings, persistence and plan geometry using isolated data.
 * Run: node scripts/smoke-chat-width.mjs (LH_TEST_CHROME overrides Chrome path).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-width-"));
fs.mkdirSync(path.join(home, "data"));
fs.writeFileSync(path.join(home, "auth.json"), "{}\n");
// Next's supported font fixture avoids external font downloads in this check.
const require = createRequire(path.join(root, "package.json"));
const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [
	getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"),
	`@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`,
]));
fs.writeFileSync(path.join(home, "fonts.cjs"), `module.exports = ${JSON.stringify(fonts)};\n`);
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = {
	PATH: process.env.PATH, HOME: home, TMPDIR: home, NODE_ENV: "development",
	LH_DATA_DIR: path.join(home, "data"), LH_AUTH_FILE: path.join(home, "auth.json"),
	LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1",
	NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(home, "fonts.cjs"),
};
let server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
	cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
const capture = data => { logs = (logs + data).slice(-24000); };
server.stdout.on("data", capture); server.stderr.on("data", capture);

let browser;
const errors = [];
const widths = { comfortable: 736, wide: 1152, full: Infinity };
const laneSelector = '[class*="max-w-(--lh-chat-max-width)"]';

async function ready() {
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error(logs)), 90000);
		function finish(error) {
			clearTimeout(timer);
			server.stdout.off("data", inspect);
			server.off("exit", exited);
			if (error) reject(error); else resolve();
		}
		const inspect = () => { if (logs.includes("Ready in")) finish(); };
		const exited = code => finish(new Error(`Next exited ${code}: ${logs}`));
		server.stdout.on("data", inspect);
		server.once("exit", exited);
		inspect();
	});
}
async function stop() {
	if (server.exitCode !== null || server.signalCode !== null) return;
	const exited = once(server, "exit");
	server.kill("SIGTERM");
	const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
	await exited;
	clearTimeout(timer);
}
function fixtures() {
	const tree = { nodes: [{ id: "a", title: "Basics" }, { id: "b", title: "Practice" }], edges: [{ from: "a", to: "b" }], version: 1 };
	const assistant = (id, content) => ({ id, role: "assistant", content, api: "openai-completions", provider: "fixture", model: "synthetic", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse", timestamp: 1 });
	const plan = [assistant("p", [{ type: "toolCall", id: "plan", name: "plan_init", arguments: {} }]), { id: "pr", role: "toolResult", toolCallId: "plan", toolName: "plan_init", content: [{ type: "text", text: "ok" }], details: { ok: true, tree }, isError: false, timestamp: 2 }];
	const text = assistant("text", [{ type: "text", text: "A synthetic lesson to check shared width. ".repeat(15) }]);
	const question = assistant("q", [{ type: "toolCall", id: "question", name: "quiz", arguments: { question: "Which value is correct?", options: [{ label: "One", value: "one" }, { label: "Two", value: "two" }], correctAnswer: "one", explanation: "One is correct", nodeId: "a" } }]);
	const problem = assistant("problem", [{ type: "toolCall", id: "problem", name: "problem", arguments: { statement: "Explain one useful example." } }]);
	fs.mkdirSync(path.join(home, "data/chats"), { recursive: true });
	for (const [id, messages, kind] of [["width_chat", [text], "teach"], ["width_question", [...plan, text, question], "teach"], ["width_practice", [text, problem], "practice"]]) {
		fs.writeFileSync(path.join(home, "data/chats", id + ".json"), JSON.stringify({ id, title: "Width fixture", messages, kind, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
	}
	fs.writeFileSync(path.join(home, "data/settings.json"), JSON.stringify({ version: 1, appearance: { proseFontSize: 18 } }));
}
try {
	fixtures();
	await ready();
	browser = await puppeteer.launch({ executablePath: process.env.LH_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, userDataDir: path.join(home, "browser"), args: ["--disable-background-networking", "--no-first-run"] });
	const page = await browser.newPage();
	page.setDefaultTimeout(45000);
	page.on("pageerror", error => errors.push(error.message));
	await page.setRequestInterception(true);
	page.on("request", async request => {
		try {
			const url = new URL(request.url());
			if (url.origin !== origin) return await request.abort();
			if (url.pathname === "/api/events") return await request.respond({ status: 204 });
			if (request.method() === "POST") {
				errors.push(`Unexpected POST ${url.pathname}`);
				return await request.abort();
			}
			await request.continue();
		} catch (error) { errors.push(String(error)); }
	});
	async function open(route) {
		await page.goto(origin + route, { waitUntil: "domcontentloaded", timeout: 120000 });
		await page.waitForSelector('[data-file-path-input]');
		await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--lh-chat-max-width") !== "");
	}
	async function select(mode) {
		await page.evaluate(() => document.querySelector('[data-testid="settings-entry"]').click());
		await page.waitForSelector('[data-testid="settings-nav-appearance"]');
		await page.click('[data-testid="settings-nav-appearance"]');
		await page.waitForSelector('[data-testid="select-chat-width"]');
		if (await page.$eval('[data-testid="select-chat-width"]', e => e.value) !== mode) {
			const response = page.waitForResponse(r => r.url().endsWith("/api/settings/appearance") && r.request().method() === "PUT");
			await page.select('[data-testid="select-chat-width"]', mode);
			assert.equal((await response).status(), 200);
		}
		await page.waitForFunction(m => getComputedStyle(document.documentElement).getPropertyValue("--lh-chat-max-width").trim() === m, {}, { comfortable: "46rem", wide: "72rem", full: "100%" }[mode]);
		await page.click('[aria-label="Close settings"]');
		await page.waitForFunction(() => !document.querySelector('[data-testid="settings-dialog"]'));
	}
	async function check(mode, route) {
		const data = await page.evaluate(selector => {
			const boxes = [...document.querySelectorAll(selector)].map(e => {
				const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect();
				return { width: r.width, parent: p.width, center: r.x + r.width / 2, parentCenter: p.x + p.width / 2 };
			});
			return { boxes, body: document.documentElement.scrollWidth, viewport: innerWidth };
		}, laneSelector);
		assert.equal(data.boxes.length, route.startsWith("/chat/width_") ? 2 : 1);
		for (const box of data.boxes) {
			assert.ok(Math.abs(box.width - Math.min(widths[mode], box.parent)) < 2, JSON.stringify({ mode, route, box }));
			assert.ok(Math.abs(box.center - box.parentCenter) < 2, JSON.stringify(box));
		}
		assert.ok(data.body <= data.viewport, JSON.stringify(data));
	}
	for (const viewport of [{ width: 1920, height: 1000 }, { width: 390, height: 844 }]) {
		await page.setViewport(viewport);
		for (const route of ["/", "/chat/new", "/chat/width_chat", "/chat/width_question", "/chat/width_practice"]) {
			await open(route);
			if (viewport.width === 390) {
				await page.evaluate(() => document.querySelector('aside[aria-hidden="false"] [aria-label="Close sidebar"]')?.click());
				await page.waitForFunction(selector => [...document.querySelectorAll(selector)].every(e => e.parentElement.getBoundingClientRect().width >= 360), {}, laneSelector);
			}
			for (const mode of Object.keys(widths)) { await select(mode); await check(mode, route); }
		}
	}
	// Same viewport, changing only the preference must move and hide the plan.
	await page.setViewport({ width: 1500, height: 1000 });
	await open("/chat/width_question");
	const positions = [];
	for (const mode of Object.keys(widths)) {
		await select(mode);
		await page.waitForFunction(() => {
			const e = document.querySelector('[data-testid="plan-marginalia"]');
			const r = e.getBoundingClientRect();
			return getComputedStyle(e).opacity === (r.width >= 220 ? "1" : "0");
		});
		const plan = await page.$eval('[data-testid="plan-marginalia"]', e => ({ left: e.getBoundingClientRect().left, width: e.getBoundingClientRect().width, hidden: e.getAttribute("aria-hidden"), tab: e.tabIndex }));
		assert.equal(plan.hidden, mode === "comfortable" ? "false" : "true");
		assert.equal(plan.tab, mode === "comfortable" ? 0 : -1);
		if (mode === "full") assert.equal(plan.width, 0);
		positions.push(plan.left);
		await check(mode, "/chat/width_question");
	}
	assert.ok(positions[1] > positions[0]);
	await select("wide");
	assert.equal(JSON.parse(fs.readFileSync(path.join(home, "data/settings.json"))).appearance.proseFontSize, 18);
	await stop();
	logs = "";
	server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
	server.stdout.on("data", capture); server.stderr.on("data", capture);
	await ready();
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--lh-chat-max-width") === "72rem");
	assert.equal(JSON.parse(fs.readFileSync(path.join(home, "data/settings.json"))).appearance.chatWidth, "wide");
	const reset = await page.evaluate(async () => (await fetch("/api/settings/appearance", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status);
	assert.equal(reset, 200);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--lh-chat-max-width") === "46rem");
	assert.deepEqual(errors, []);
	console.log("PASS: all routes/presets, narrow layout, plan geometry/focus, preserved settings, restart and reset");
} catch (error) {
	console.error(error, logs);
	process.exitCode = 1;
} finally {
	await browser?.close();
	await stop();
	fs.rmSync(home, { recursive: true, force: true });
}
