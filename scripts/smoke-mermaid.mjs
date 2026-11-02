/** Real browser SVG regression for the shared renderer; no app/user data.
 * Run: node scripts/smoke-mermaid.mjs (LH_TEST_CHROME overrides Chrome).
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const profile = await mkdtemp(path.join(os.tmpdir(), "lh-mermaid-smoke-"));
let browser;
let server;
try {
	const bundle = await build({
		stdin: {
			contents: `import { renderMermaid } from "./components/mermaid-render.ts";
import { normalizeMermaidCallEdges } from "./src/core/mermaid-source.ts";
import mermaid from "mermaid";
window.mermaidSmoke = { renderMermaid, normalizeMermaidCallEdges, mermaid };`,
			resolveDir: root,
			loader: "ts",
		},
		bundle: true, write: false, platform: "browser", format: "iife", logLevel: "silent",
		// Drop unused Node builtins reached through the core barrel. If any
		// builtin actually gets used, its external require still fails in Chrome.
		plugins: [{ name: "unused-node-builtins", setup(build) {
			build.onResolve({ filter: /^node:/ }, args => ({ path: args.path, external: true, sideEffects: false }));
		} }],
	});
	server = createServer((request, response) => {
		if (request.url === "/smoke.js") {
			response.writeHead(200, { "Content-Type": "text/javascript" });
			response.end(bundle.outputFiles[0].contents);
		} else {
			response.writeHead(200, { "Content-Type": "text/html" });
			response.end('<!doctype html><html><body><main id="chart"></main><script src="/smoke.js"></script></body></html>');
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	browser = await puppeteer.launch({
		executablePath: process.env.LH_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		headless: true,
		userDataDir: profile,
	});
	const context = await browser.createBrowserContext();
	const page = await context.newPage();
	const pageErrors = [];
	page.on("pageerror", error => pageErrors.push(String(error)));
	await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "load" });
	const fixture = `graph LR
  model["Модель запрашивает lab_jev_check"] --> pi["Pi находит зарегистрированный инструмент"]
  pi --> call["Pi вызывает его функцию execute"]
  call --> result["Pi получает результат и передаёт content модели"]`;
	const report = await page.evaluate(async (source) => {
		const { mermaid, renderMermaid, normalizeMermaidCallEdges } = window.mermaidSmoke;
		function check(condition, message) { if (!condition) throw new Error(message); }
		function inspect(svg) {
			const holder = document.getElementById("chart");
			holder.innerHTML = svg;
			check(holder.querySelector("svg")?.viewBox.baseVal.width > 0, "SVG has a real layout");
			const renderId = holder.querySelector("svg").id;
			return {
				nodes: [...holder.querySelectorAll("g.node")].map(node => ({
					id: node.id.replace(`${renderId}-flowchart-`, "").replace(/-\d+$/, ""),
					label: node.querySelector(".nodeLabel")?.textContent,
				})),
				edges: [...holder.querySelectorAll("path.flowchart-link")].map(edge => ({
					id: edge.id.replace(`${renderId}-`, ""),
					width: getComputedStyle(edge).strokeWidth,
					dash: getComputedStyle(edge).strokeDasharray,
					start: edge.getAttribute("marker-start")?.replace(renderId, "render"),
					end: edge.getAttribute("marker-end")?.replace(renderId, "render"),
				})),
				edgeLabels: [...holder.querySelectorAll(".edgeLabel .edgeLabel")].map(label => label.textContent),
			};
		}
		mermaid.initialize({ securityLevel: "strict", startOnLoad: false });
		let originalError = "";
		try { await mermaid.parse(source); } catch (error) { originalError = String(error); }
		check(/got 'CALLBACKNAME'/.test(originalError), "Original fixture reproduces CALLBACKNAME");
		const firstSvg = await renderMermaid(source);
		const first = inspect(firstSvg);
		check(first.nodes.length === 4 && first.edges.length === 3, "Four nodes and three edges survive");
		const reference = inspect(await renderMermaid(source.replace("call -->", "call-->")));
		check(JSON.stringify(first) === JSON.stringify(reference), `SVG labels, endpoints and edge styles match the safe reference: ${JSON.stringify({ first, reference })}`);
		const arrows = ["-->", "==>", "-.->", "-->|success|", "-- success -->", "== success ==>", "-. success .->", "<-->"];
		for (const arrow of arrows) {
			const input = `flowchart LR\ncall[Call]\nresult[Result]\ncall ${arrow} result`;
			const rendered = inspect(await renderMermaid(input));
			const expected = inspect(await renderMermaid(input.replace(`call ${arrow}`, `call${arrow}`)));
			check(rendered.nodes.length === 2 && rendered.edges.length === 1, `SVG generated for ${arrow}`);
			check(JSON.stringify(rendered) === JSON.stringify(expected), `Edge style and label preserved for ${arrow}`);
		}
		for (const input of [
			"graph TD\nA[Don't worry]\ncall --> B",
			"graph TD\naccTitle: Bob's flow\ncall --> B",
			"graph TD\ncall --> foo/bar",
			"graph TD\ncall --> node:foo",
			"graph TD\ncall --> node$foo",
			"graph TD\ncall --> B:::foo,bar",
			"graph TD\nstyle A fill:red; call --> B",
			"graph TD\nclass A cls; call --> B",
			"graph TD\nclassDef foo fill:red; call --> B",
			"graph TD\ncall --> B\rC --> D",
		]) {
			const actual = inspect(await renderMermaid(input));
			const expected = inspect(await renderMermaid(input.replace("call -->", "call-->")));
			check(JSON.stringify(actual) === JSON.stringify(expected), `Surrounding syntax preserved: ${input}`);
		}
		const protectedSource = 'flowchart TD\nA["call --> label"] --> call[Call]\ncall --> B[Result]\n%% call --> comment\nclick A "https://example.test/call" "call --> tooltip"';
		check(normalizeMermaidCallEdges(protectedSource) === protectedSource.replace("\ncall -->", "\ncall-->"), "Protected source stays byte-identical");
		check(inspect(await renderMermaid(protectedSource)).nodes.some(node => node.label === "call --&gt; label" || node.label === "call --> label"), "Protected label renders");
		const valid = 'flowchart TD\nrecall[Recall] --> call_step[Step] --> my-call[Hyphen]';
		check(inspect(await renderMermaid(valid)).nodes.length === 3, "Similar IDs render unchanged");
		check((await renderMermaid('sequenceDiagram\nAlice->>Bob: hello')).includes("<svg"), "Other diagram types still render");
		for (const invalid of ['flowchart TD\nA --> [', 'flowchart TD\ncall --> B\nC --> [']) {
			let rejected = false;
			try { await renderMermaid(invalid); } catch { rejected = true; }
			check(rejected, "Invalid/residual syntax remains an error");
		}
		const sanitized = await renderMermaid('flowchart TD\nA["<img src=x onerror=alert(1)>"] --> B');
		check(!/onerror\s*=/.test(sanitized), "SVG sanitation remains active");
		localStorage.setItem("saved-message", JSON.stringify({ source }));
		return { originalError: originalError.split("\n")[0], first, arrows, sourceUnchanged: source === JSON.parse(localStorage.getItem("saved-message")).source };
	}, fixture);
	assert.equal(report.sourceUnchanged, true);
	assert.deepEqual(report.first.nodes.map(node => node.id), ["model", "pi", "call", "result"]);
	assert.deepEqual(report.first.nodes.map(node => node.label), [
		"Модель запрашивает lab_jev_check", "Pi находит зарегистрированный инструмент",
		"Pi вызывает его функцию execute", "Pi получает результат и передаёт content модели",
	]);
	assert.deepEqual(report.first.edges.map(edge => edge.id), ["L_model_pi_0", "L_pi_call_0", "L_call_result_0"]);
	await page.reload({ waitUntil: "load" });
	const reopened = await page.evaluate(async () => {
		const before = localStorage.getItem("saved-message");
		const { source } = JSON.parse(before);
		const inline = await window.mermaidSmoke.renderMermaid(source);
		const expanded = await window.mermaidSmoke.renderMermaid(source);
		return { inline: inline.includes("<svg"), expanded: expanded.includes("<svg"), distinct: inline !== expanded, unchanged: before === localStorage.getItem("saved-message") };
	});
	assert.deepEqual(reopened, { inline: true, expanded: true, distinct: true, unchanged: true });
	assert.deepEqual(pageErrors, [], "No uncaught browser errors");
	console.log(JSON.stringify({ ...report, reopened }, null, 2));
} finally {
	await browser?.close();
	if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	await rm(profile, { recursive: true, force: true });
}
