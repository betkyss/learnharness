import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeMermaidCallEdges as normalize } from "../src/core/mermaid-source.ts";

describe("Mermaid call edge normalization", () => {
	it("changes only the gap before an edge in a four-node diagram", () => {
		const source = 'flowchart TD\ninput[Input] --> prepare[Prepare]\nprepare --> call[Call]\ncall --> result[Result]';
		assert.equal(normalize(source), source.replace("call -->", "call-->"));
	});

	for (const arrow of ["-->", "==>", "-.->", "---->", "<-->", "o--o", "x--x", "-->|success|", '-->|"call --> stays"|', "-- success -->", "== success ==>", "-. success .->"]) {
		it(`preserves the ${arrow} edge`, () => {
			assert.equal(normalize(`graph LR\ncall \t ${arrow} result`), `graph LR\ncall${arrow} result`);
		});
	}

	it("recognizes chains, grouped nodes, semicolons, indentation and CRLF", () => {
		const source = 'graph TD; A --> call --> B; call ==> C\r\n  A & call -.-> D\r\n';
		assert.equal(normalize(source), 'graph TD; A --> call--> B; call==> C\r\n  A & call-.-> D\r\n');
	});

	it("keeps all protected content while repairing adjacent statements", () => {
		const protectedLines = [
			'%% call --> comment; call --> comment',
			'%%{init: {"themeVariables": {"fontFamily": "call --> directive"}}}%%',
			'A[call --> label]',
			'A["call --> quoted; call --> label"]',
			'A["`call --> markdown\ncall --> multiline`"]',
			'A[unquoted\ncall --> multiline]',
			'A>asymmetric; call --> label]',
			'A((call --> circle))',
			'A@{ shape: rect, label: "call --> metadata" }',
			'A -->|call --> edge label| B',
			'A -- call --> B',
			'A -- multiline\ncall --> B',
			'A == multiline; call ==> B',
			'A -. multiline\ncall .-> B',
			'click A call callback("call --> argument")',
			'click A "https://example.test/call --> url" "call --> tooltip"',
			'click A https://example.test/;call --> url',
			'style call fill:red',
			'class call selected',
			'classDef selected fill:red',
			'accTitle: call --> title',
			'accTitle: title; call --> title',
			'accDescr {\ncall --> description\n}',
			'subgraph call --> title',
			'end',
		];
		for (const line of protectedLines) {
			const source = `flowchart TD\n${line}\ncall --> result`;
			assert.equal(normalize(source), `flowchart TD\n${line}\ncall--> result`, line);
		}
	});

	it("preserves leading frontmatter, comments and multiline directives", () => {
		const preamble = '---\ntitle: call --> title\nconfig:\n  theme: dark\n---\n%% call --> comment\n%%{init: {\n"theme": "dark", "fontFamily": "call --> font"\n}}%%\n';
		assert.equal(normalize(`${preamble}graph LR\ncall --> B`), `${preamble}graph LR\ncall--> B`);
	});

	it("retains comments at the end of an edge", () => {
		assert.equal(normalize('graph TD\ncall --> B %% call --> comment'), 'graph TD\ncall--> B %% call --> comment');
	});

	it("never changes similar identifiers, labels on call, or statement boundaries", () => {
		for (const statement of ['recall --> B', 'call_step --> B', 'my-call --> B', 'call[Call] --> B', 'call:::selected --> B', 'call\n--> B', 'CALL --> B', 'call--> B']) {
			const source = `graph TD\n${statement}`;
			assert.equal(normalize(source), source);
		}
	});

	it("leaves unknown syntax and unterminated labels untouched", () => {
		for (const statement of ['call --> B unexpected', 'A["unterminated\ncall --> B', 'A[unterminated\ncall --> B', 'click call call callback', 'call banana B', 'https://example.test/call --> B']) {
			const source = `flowchart TD\n${statement}`;
			assert.equal(normalize(source), source);
		}
	});

	it("never normalizes other diagram types or a missing header", () => {
		for (const source of ['sequenceDiagram\ncall --> result: hello', 'stateDiagram-v2\ncall --> result', 'call --> result', '%% flowchart\nsequenceDiagram\ncall --> result']) assert.equal(normalize(source), source);
	});

	it("is idempotent", () => {
		const once = normalize('graph TD\ncall --> B; B --> call ==> C');
		assert.equal(normalize(once), once);
	});
});

// Valid Mermaid constructs adjacent to the repair must not block it.
describe("Mermaid call repair with surrounding syntax", () => {
	for (const source of [
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
		it(source, () => assert.equal(normalize(source), source.replace("call -->", "call-->")));
	}
});
