import assert from "node:assert/strict";
import { describe, it } from "node:test";
import mermaid from "mermaid";
import type { MermaidConfig } from "mermaid";
import { renderMermaid, mermaidTheme } from "../components/mermaid-render.ts";

const callbackError = () => new Error("Parse error: expected NODE_STRING, got 'CALLBACKNAME'");

describe("shared Mermaid renderer", () => {
	it("parses and renders valid source unchanged with strict security", async (t) => {
		const source = 'graph TD\nA["call --> label"] --> B';
		const calls: string[] = [];
		t.mock.method(mermaid, "initialize", (config: MermaidConfig) => {
			assert.equal(config.securityLevel, "strict");
			assert.equal(config.suppressErrorRendering, true);
		});
		t.mock.method(mermaid, "parse", async (chart: string) => { calls.push(`parse:${chart}`); return { diagramType: "flowchart-v2" }; });
		t.mock.method(mermaid, "render", async (id: string, chart: string) => {
			assert.match(id, /^lh-mermaid-/);
			calls.push(`render:${chart}`);
			return { svg: "<svg/>" };
		});
		assert.equal(await renderMermaid(source), "<svg/>");
		assert.deepEqual(calls, [`parse:${source}`, `render:${source}`]);
		assert.equal(mermaidTheme.securityLevel, "strict");
	});

	it("retries only the parse and then renders the validated candidate", async (t) => {
		const source = 'flowchart TD\ncall --> result';
		const candidate = 'flowchart TD\ncall--> result';
		const calls: string[] = [];
		t.mock.method(mermaid, "parse", async (chart: string) => {
			calls.push(`parse:${chart}`);
			if (chart === source) throw callbackError();
			return { diagramType: "flowchart-v2" };
		});
		t.mock.method(mermaid, "render", async (_id: string, chart: string) => { calls.push(`render:${chart}`); return { svg: "<svg/>" }; });
		assert.equal(await renderMermaid(source), "<svg/>");
		assert.deepEqual(calls, [`parse:${source}`, `parse:${candidate}`, `render:${candidate}`]);
	});

	it("does not repair an already valid call edge", async (t) => {
		const source = 'graph TD\ncall --> result';
		t.mock.method(mermaid, "parse", async () => ({ diagramType: "flowchart-v2" }));
		const render = t.mock.method(mermaid, "render", async () => ({ svg: "<svg/>" }));
		await renderMermaid(source);
		assert.equal(render.mock.calls[0]?.arguments[1], source);
	});

	for (const [source, error] of [
		['graph TD\ncall --> result', new Error("got 'OTHER'")],
		['graph TD\ncall --> result', new Error("expected CALLBACKNAME, got 'OTHER'")],
		['graph TD\ncall --> result', new Error("Parse error near label got 'CALLBACKNAME'\nExpecting NODE_STRING, got 'OTHER'")],
		['sequenceDiagram\ncall --> result: hello', callbackError()],
		['graph TD\nA["call --> label"]', callbackError()],
	] as const) {
		it(`propagates without retry: ${source} / ${error.message}`, async (t) => {
			const parse = t.mock.method(mermaid, "parse", async () => { throw error; });
			const render = t.mock.method(mermaid, "render", async () => ({ svg: "unexpected" }));
			await assert.rejects(renderMermaid(source), (caught) => caught === error);
			assert.equal(parse.mock.callCount(), 1);
			assert.equal(render.mock.callCount(), 0);
		});
	}

	it("propagates a residual parse error with at most one fallback", async (t) => {
		const residual = callbackError();
		let count = 0;
		const parse = t.mock.method(mermaid, "parse", async () => { throw ++count === 1 ? callbackError() : residual; });
		const render = t.mock.method(mermaid, "render", async () => ({ svg: "unexpected" }));
		await assert.rejects(renderMermaid('graph TD\ncall --> result'), (caught) => caught === residual);
		assert.equal(parse.mock.callCount(), 2);
		assert.equal(render.mock.callCount(), 0);
	});

	it("propagates render failures without retrying SVG generation", async (t) => {
		const error = callbackError();
		const parse = t.mock.method(mermaid, "parse", async () => ({ diagramType: "flowchart-v2" }));
		const render = t.mock.method(mermaid, "render", async () => { throw error; });
		await assert.rejects(renderMermaid('graph TD\ncall --> result'), (caught) => caught === error);
		assert.equal(parse.mock.callCount(), 1);
		assert.equal(render.mock.callCount(), 1);
	});

	it("can reopen and expand the same unchanged source with distinct render ids", async (t) => {
		const source = 'graph TD\ncall --> result';
		t.mock.method(mermaid, "parse", async (chart: string) => {
			if (chart === source) throw callbackError();
			return { diagramType: "flowchart-v2" };
		});
		const render = t.mock.method(mermaid, "render", async () => ({ svg: "<svg/>" }));
		await renderMermaid(source);
		await renderMermaid(source);
		assert.equal(source, 'graph TD\ncall --> result');
		assert.notEqual(render.mock.calls[0]?.arguments[0], render.mock.calls[1]?.arguments[0]);
		assert.equal(render.mock.calls[0]?.arguments[1], render.mock.calls[1]?.arguments[1]);
	});
});
