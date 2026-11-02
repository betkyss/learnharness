/** A conservative repair for Mermaid's `call\s+` callback lexer rule.
 * This is not a Mermaid formatter: only whitespace in recognized edge
 * statements is removed. Unknown syntax is left for Mermaid to reject. */

const identifier = /^(?:[\p{L}\p{N}_.$/]|:(?!::)|-(?![->.]))+/u;
const command = /^(?:click|style|linkStyle|classDef|class|direction|subgraph|end|accTitle|accDescr)\b/;
const freeTextCommand = /^(?:click|subgraph|accTitle|accDescr)\b/;
const link = /^[xo<]?(?:--+[-xo>]|==+[=xo>]|-?\.+-[xo>]?|~~~+)/;

/** Skip an entire label/metadata/quoted span, including multiline content.
 * An unterminated span protects the remainder rather than guessing. */
function protectedEnd(text: string, start: number): number {
	const opening = text[start]!;
	const closing = ({ "[": "]", "(": ")", "{": "}", ">": "]" } as Record<string, string>)[opening] ?? opening;
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] === closing) return i + 1;
		if (opening === '"') continue;
		if ('"([{'.includes(text[i]!)) i = protectedEnd(text, i) - 1;
	}
	return text.length;
}

function edgeEnd(text: string, start: number): number | null {
	const direct = link.exec(text.slice(start));
	let end: number;
	if (direct) {
		end = start + direct[0].length;
	} else {
		// Mermaid's other label notation: -- label -->, == label ==>, -. label .->.
		const opener = /^(?:[xo<]?)(--|==|-\.)/.exec(text.slice(start));
		if (!opener) return null;
		const closer = opener[1] === "--" ? /^--+[-xo>]/ : opener[1] === "==" ? /^==+[=xo>]/ : /^\.+-[xo>]?/;
		let i = start + opener[0].length;
		for (; i < text.length; i++) {
			if (text[i] === '"') { i = protectedEnd(text, i) - 1; continue; }
			const match = closer.exec(text.slice(i));
			if (match) { i += match[0].length; break; }
		}
		if (i >= text.length) return null;
		end = i;
	}
	while (/[ \t\r]/.test(text[end] ?? "")) end++;
	if (text[end] === "|") end = protectedEnd(text, end);
	return end;
}

/** Parse only node/edge chains. Applying edits only after recognizing the
 * whole statement keeps commands, URLs and unrecognized syntax untouched. */
function normalizeStatement(text: string): string {
	if (command.test(text.trimStart())) return text;
	const removals: Array<[number, number]> = [];
	let i = 0;
	while (i < text.length) {
		while (/\s/.test(text[i] ?? "")) i++;
		const id = identifier.exec(text.slice(i));
		if (!id) return text;
		i += id[0].length;
		const idEnd = i;
		if ("[({>".includes(text[i] ?? " ")) i = protectedEnd(text, i);
		if (text.slice(i, i + 2) === "@{") i = protectedEnd(text, i + 1);
		if (text.slice(i, i + 3) === ":::") {
			const className = /^[\p{L}\p{N}_.-]+(?:,[\p{L}\p{N}_.-]+)*/u.exec(text.slice(i + 3));
			if (!className) return text;
			i += 3 + className[0].length;
		}
		const gapStart = i;
		while (/[ \t\r]/.test(text[i] ?? "")) i++;
		if (i === text.length) break;
		if (text[i] === "&") { i++; continue; }
		const end = edgeEnd(text, i);
		if (end === null) return text;
		if (id[0] === "call" && idEnd === gapStart && i > gapStart) removals.push([gapStart, i]);
		i = end;
	}
	for (const [start, end] of removals.reverse()) text = text.slice(0, start) + text.slice(end);
	return text;
}

/** Return the original string unless it is a flowchart/graph with recognized
 * `call <edge>` positions. Frontmatter, directives, comments, labels and
 * control statements are copied byte for byte. Statement newlines stay put. */
export function normalizeMermaidCallEdges(source: string): string {
	let start = /^(?:\uFEFF)?\s*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)?.[0].length ?? 0;
	let output = source.slice(0, start);
	let headerSeen = false;
	const append = (end: number) => {
		const statement = source.slice(start, end);
		if (!statement.trim()) { output += statement; return true; }
		if (!headerSeen) {
			if (!/^\s*(?:flowchart|graph)(?:\s+(?:TB|TD|BT|RL|LR))?\s*$/.test(statement)) return false;
			headerSeen = true;
			output += statement;
		} else output += normalizeStatement(statement);
		return true;
	};
	for (let i = start; i < source.length; i++) {
		if (source.startsWith("%%", i)) {
			if (!append(i)) return source;
			const directive = source.startsWith("%%{", i);
			const close = source.indexOf(directive ? "}%%" : "\n", i + 2);
			const end = close < 0 ? source.length : close + (directive ? 3 : 0);
			output += source.slice(i, end);
			start = end;
			i = end - 1;
			continue;
		}
		const ch = source[i]!;
		// Unquoted edge labels can span lines and contain statement-looking
		// text. Keep the entire edge token together, just like a node label.
		if ("-=~<xo".includes(ch)) {
			const end = edgeEnd(source, i);
			if (end !== null) { i = end - 1; continue; }
		}
		if ('"([{|'.includes(ch) || (ch === ">" && /[\p{L}\p{N}_]/u.test(source[i - 1] ?? ""))) {
			i = protectedEnd(source, i) - 1;
			continue;
		}
		if (ch === "\n" || ch === "\r" || ch === ";") {
			// Free-text commands may contain unquoted URLs or text with `;`.
			// Do not reinterpret their suffix as a node statement.
			if (ch === ";" && freeTextCommand.test(source.slice(start, i).trimStart())) continue;
			if (!append(i)) return source;
			output += ch;
			start = i + 1;
		}
	}
	return append(source.length) ? output : source;
}
