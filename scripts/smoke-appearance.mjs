/** Checks appearance controls, computed styles, persistence and reset using isolated data.
 * Run: node scripts/smoke-appearance.mjs (LH_TEST_CHROME overrides Chrome path).
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
	PATH: process.env.PATH, HOME: testHome, TMPDIR: testHome, NODE_ENV: "development",
	LH_DATA_DIR: path.join(testHome, "data"), LH_AUTH_FILE: path.join(testHome, "auth.json"),
	LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1",
	NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(testHome, "fonts.cjs"),
};
let server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
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
await page.setViewport({width:1440,height:1000});
await page.goto(origin + '/chat/new',{waitUntil:'domcontentloaded',timeout:120000});
await page.waitForFunction(()=>document.documentElement.style.getPropertyValue('--lh-prose-size') === '16px');
await new Promise(r=>setTimeout(r,1500));
const q=id=>`[data-testid="${id}"]`;
async function openSettings(){await page.click(q('settings-entry'));await page.waitForSelector(q('settings-nav-appearance'));await page.click(q('settings-nav-appearance'));await page.waitForSelector(q('interface-font-trigger'));}
async function edit(id,value){await page.$eval(q(id),e=>{e.focus();e.select();});await page.keyboard.press('Backspace');if(value)await page.type(q(id),value);await page.keyboard.press('Tab');}
async function waitVar(name,value){await page.waitForFunction((n,v)=>document.documentElement.style.getPropertyValue(n)===v,{},name,value);}
async function styles(){await new Promise(r=>setTimeout(r,350));return page.evaluate(()=>{const get=(s)=>getComputedStyle(document.querySelector(s));return {body:get('body').fontFamily,background:get('body').backgroundColor,sidebar:get('.bg-sidebar').backgroundColor,control:get('[data-testid="interface-font-trigger"]').fontFamily,radius:get('[data-testid="interface-font-trigger"]').borderRadius,panel:get('[data-testid="settings-dialog"]').backgroundColor,panelRadius:get('[data-testid="settings-dialog"]').borderRadius,border:get('[data-testid="settings-dialog"]').borderColor,muted:get('[data-testid="settings-close"]').color,title:get('.font-title').fontWeight,prose:get('.lh-input').fontFamily,label:get('[data-testid="row-interface-font"] .font-ui').fontFamily,overflow:document.documentElement.scrollWidth>innerWidth,contentOverflow:document.querySelector('[data-testid="settings-content"]').scrollWidth>document.querySelector('[data-testid="settings-content"]').clientWidth};});}
await openSettings();
const defaults=await styles();assert.equal(defaults.background,'rgb(0, 0, 0)');assert.equal(defaults.sidebar,'rgb(9, 9, 11)');assert.equal(defaults.panel,'rgb(24, 24, 27)');assert.equal(defaults.radius,'4px');assert.equal(defaults.title,'600');assert.match(defaults.body,/system-ui/);assert.equal(defaults.overflow,false);

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
console.log(JSON.stringify({defaults,changed,narrow,saved,reset:'restored styles and cleared overrides',reload:'persisted'},null,2));
} catch (error) { console.error(logs); throw error; } finally { await browser?.close(); await stop(); fs.rmSync(testHome,{recursive:true,force:true}); }
