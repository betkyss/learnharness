/** Checks appearance controls, computed styles, persistence and reset using isolated data.
 * Run: node scripts/smoke-appearance.mjs (LH_TEST_CHROME overrides Chrome path).
 * After next build, LH_TEST_PRODUCTION=1 checks the production styles.
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
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "lh-appearance-"));
fs.mkdirSync(path.join(testHome, "data"));
fs.writeFileSync(path.join(testHome, "auth.json"), "{}\n");
// Real transcript surfaces: lesson, reading input, reveal card and sidebar.
// Synthetic records never invoke a model or modify the user's sessions.
fs.mkdirSync(path.join(testHome, "data/chats"));
const assistant = (id, content) => ({ id, role: "assistant", content, api: "openai-completions", provider: "fixture", model: "synthetic", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 });
const lesson = "## Учимся рассуждать\n\nПрочитайте пример и объясните ход мысли своими словами. The same type scale supports both languages.\n\n| Понятие | Значение |\n| --- | --- |\n| Функция | Повторяемое действие |\n\n`const answer = 42;`";
fs.writeFileSync(path.join(testHome, "data/chats/typography.json"), JSON.stringify({
	version: 1, id: "typography", title: "Typography · Размеры текста", kind: "teach", createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z",
	messages: [
		assistant("probe", [{ type: "toolCall", id: "probe", name: "probe_done", arguments: { assessment: { strands: [{ strand: "Functions", assessment: "Ready for a check." }] } } }]),
		{ id: "probe-result", role: "toolResult", toolCallId: "probe", toolName: "probe_done", content: [{ type: "text", text: "ok" }], details: { ok: true }, isError: false, timestamp: 2 },
		assistant("lesson", [{ type: "text", text: lesson }, { type: "toolCall", id: "quiz", name: "quiz", arguments: { type: "check", nodeId: "functions", question: "Что возвращает эта функция? What does it return?", options: [{ value: "42", label: "42" }, { value: "0", label: "0" }], correctAnswer: "42", explanation: "Она возвращает 42." } }]),
	],
}));
// Next's supported font fixture avoids external font downloads in this check.
const require = createRequire(path.join(root, "package.json"));
const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [
	getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"),
	`@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`,
]));
fs.writeFileSync(path.join(testHome, "fonts.cjs"), `module.exports = ${JSON.stringify(fonts)};\n`);
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = {
	PATH: process.env.PATH, HOME: testHome, TMPDIR: testHome, NODE_ENV: process.env.LH_TEST_PRODUCTION ? "production" : "development",
	LH_DATA_DIR: path.join(testHome, "data"), LH_AUTH_FILE: path.join(testHome, "auth.json"),
	LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1",
	NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(testHome, "fonts.cjs"),
};
let server = spawn(process.execPath, ["node_modules/next/dist/bin/next", process.env.LH_TEST_PRODUCTION ? "start" : "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
	cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
const capture = data => { logs = (logs + data).slice(-24000); };
server.stdout.on("data", capture); server.stderr.on("data", capture);

let browser;
const errors = [];



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
try {
await ready();
browser = await puppeteer.launch({executablePath: process.env.LH_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless:true});
await fetch(origin + '/api/settings/appearance',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'});
const page = await browser.newPage();
page.on('pageerror',error=>{errors.push(error.message);console.error('Browser:',error.message);});
await page.setViewport({width:1440,height:1000});
await page.goto(origin + '/chat/typography',{waitUntil:'domcontentloaded',timeout:120000});
await page.waitForFunction(()=>document.documentElement.style.getPropertyValue('--lh-prose-size') === '16px');
await page.waitForSelector('[data-testid="reading-thinking-field"]');
await new Promise(r=>setTimeout(r,1500));
const q=id=>`[data-testid="${id}"]`;
async function typography(){return page.evaluate(()=>{
	const read = selector => { const el = document.querySelector(selector); if (!el) throw new Error(`Missing ${selector}`); const s = getComputedStyle(el); return { size: parseFloat(s.fontSize), leading: parseFloat(s.lineHeight) }; };
	return {
		reading: read('[data-testid="reading-thinking-field"] [data-file-path-input]'),
		caption: read('[data-testid="reading-thinking-field"] > div:first-child'),
		cardTitle: read('[data-testid="teach-check-reveal"] .text-sm'),
		preview: read('[data-testid="teach-check-reveal"] .text-xs'),
		open: read('[data-testid="teach-check-reveal"] > span:last-child'),
		sidebar: read('[data-testid="session-row"] .font-ui'),
		paragraph: read('.lh-prose p'),
		table: read('[data-streamdown="table"] td'),
		label: document.querySelector('[data-testid="row-interface-font"]') ? read('[data-testid="row-interface-font"] .font-ui') : null,
	};
});}
function checkTypography(actual, proseSize = 16, scale = 1){
	for (const key of ['reading','paragraph','table']) assert.equal(actual[key].size, proseSize, key);
	for (const key of ['caption','preview']) assert.equal(actual[key].size, 12 * scale, key);
	for (const key of ['cardTitle','open','sidebar']) assert.equal(actual[key].size, 14 * scale, key);
	if(actual.label) assert.equal(actual.label.size, 14 * scale, 'settings label');
	assert.equal(actual.reading.leading, proseSize * 1.25);
	assert.equal(actual.paragraph.leading, proseSize * 1.5);
}
async function screenshot(name){if(process.env.LH_TEST_SCREENSHOTS){fs.mkdirSync(process.env.LH_TEST_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.LH_TEST_SCREENSHOTS,name+'.png')});}}
async function openSettings(){await page.click(q('settings-entry'));await page.waitForSelector(q('settings-nav-appearance'));await page.click(q('settings-nav-appearance'));await page.waitForSelector(q('interface-font-trigger'));}
async function edit(id,value){await page.$eval(q(id),e=>{e.focus();e.select();});await page.keyboard.press('Backspace');if(value)await page.type(q(id),value);await page.keyboard.press('Tab');}
async function waitVar(name,value){await page.waitForFunction((n,v)=>document.documentElement.style.getPropertyValue(n)===v,{},name,value);}
async function styles(){await new Promise(r=>setTimeout(r,350));return page.evaluate(()=>{const get=(s)=>getComputedStyle(document.querySelector(s));return {body:get('body').fontFamily,background:get('body').backgroundColor,sidebar:get('.bg-sidebar').backgroundColor,control:get('[data-testid="interface-font-trigger"]').fontFamily,radius:get('[data-testid="interface-font-trigger"]').borderRadius,panel:get('[data-testid="settings-dialog"]').backgroundColor,panelRadius:get('[data-testid="settings-dialog"]').borderRadius,border:get('[data-testid="settings-dialog"]').borderColor,muted:get('[data-testid="settings-close"]').color,title:get('.font-title').fontWeight,prose:get('.lh-input').fontFamily,label:get('[data-testid="row-interface-font"] .font-ui').fontFamily,overflow:document.documentElement.scrollWidth>innerWidth,contentOverflow:document.querySelector('[data-testid="settings-content"]').scrollWidth>document.querySelector('[data-testid="settings-content"]').clientWidth};});}
await openSettings();
const defaults=await styles();assert.equal(defaults.background,'rgb(0, 0, 0)');assert.equal(defaults.sidebar,'rgb(9, 9, 11)');assert.equal(defaults.panel,'rgb(24, 24, 27)');assert.equal(defaults.radius,'4px');assert.equal(defaults.title,'600');assert.match(defaults.body,/system-ui/);assert.equal(defaults.overflow,false);
const defaultTypography=await typography();checkTypography(defaultTypography);
await screenshot('settings-wide');
await edit('input-prose-size','24');await waitVar('--lh-prose-size','24px');
const largerReading=await typography();checkTypography(largerReading,24);
await page.reload({waitUntil:'domcontentloaded'});await waitVar('--lh-prose-size','24px');await page.waitForSelector('[data-testid="reading-thinking-field"]');checkTypography(await typography(),24);
await openSettings();await edit('input-prose-size','');await waitVar('--lh-prose-size','16px');
await page.evaluate(()=>document.documentElement.style.fontSize='20px');checkTypography(await typography(),16,1.25);
await page.evaluate(()=>document.documentElement.style.removeProperty('font-size'));

await page.click(q('font-trigger'));await page.waitForSelector(q('font-search'));await page.type(q('font-search'),'Georgia');await page.waitForSelector(q('font-option-Georgia'));await page.click(q('font-option-Georgia'));await waitVar('--font-prose','"Georgia", ui-sans-serif, system-ui, sans-serif');
await page.click(q('interface-font-trigger'));await page.waitForSelector(q('font-search'));await page.type(q('font-search'),'Arial');await page.waitForSelector(q('font-option-Arial'));await page.click(q('font-option-Arial'));await waitVar('--font-ui','"Arial", ui-sans-serif, system-ui, sans-serif');
await edit('input-corner-radius','0');await waitVar('--radius','0px');
await page.select(q('select-contrast'),'high');await waitVar('--muted-foreground','#d4d4d8');
await edit('input-background','#102030');await waitVar('--background','#102030');
const changed=await styles();assert.match(changed.control,/Arial/);assert.match(changed.label,/Arial/);assert.match(changed.body,/Arial/);assert.equal(changed.radius,'0px');assert.equal(changed.panelRadius,'0px');assert.equal(changed.sidebar,'rgb(25, 41, 59)');assert.equal(changed.panel,'rgb(40, 56, 75)');assert.equal(changed.border,'rgba(255, 255, 255, 0.2)');assert.equal(changed.muted,'rgb(212, 212, 216)');assert.match(changed.prose,/Georgia/);
const saved=await page.evaluate(async()=>(await (await fetch('/api/settings')).json()).settings.appearance);assert.deepEqual(saved,{fontFamily:'Georgia',interfaceFontFamily:'Arial',cornerRadius:0,contrast:'high',background:'#102030'});
await page.reload({waitUntil:'domcontentloaded'});await waitVar('--radius','0px');await new Promise(r=>setTimeout(r,1000));await openSettings();assert.equal((await styles()).sidebar,changed.sidebar);
await page.click(q('interface-font-trigger'));await page.waitForSelector(q('font-option-default'));await page.click(q('font-option-default'));await waitVar('--font-ui','');
await page.click(q('font-trigger'));await page.waitForSelector(q('font-option-default'));await page.click(q('font-option-default'));await waitVar('--font-prose','');
await edit('input-corner-radius','');await waitVar('--radius','');await page.select(q('select-contrast'),'normal');await waitVar('--border','');await edit('input-background','');await waitVar('--background','');
assert.deepEqual(await styles(),defaults);
await page.setViewport({width:640,height:600});await new Promise(r=>setTimeout(r,250));const narrow=await styles();assert.equal(narrow.overflow,false);assert.equal(narrow.contentOverflow,false);
await screenshot('settings-narrow');
await page.click(q('settings-close'));
for (const width of [1440, 390]) {
	await page.setViewport({width,height:900});
	if(width===390) await page.evaluate(()=>document.querySelector('aside[aria-hidden="false"] [aria-label="Close sidebar"]')?.click());
	await new Promise(r=>setTimeout(r,300));
	checkTypography(await typography());
	assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow at ${width}`);
	await screenshot(`lesson-${width}`);
}
console.log(JSON.stringify({defaults,defaultTypography,largerReading,changed,narrow,saved,reset:'restored styles and cleared overrides',reload:'persisted',rootScaling:'12/14px scaled to 15/17.5px',viewports:[1440,640,390]},null,2));
} catch (error) { console.error(logs); throw error; } finally { await browser?.close(); await stop(); fs.rmSync(testHome,{recursive:true,force:true}); }
