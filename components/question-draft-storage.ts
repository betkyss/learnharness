import { CONFIDENCE_STOPS, type QuestionDraft } from "@/src/core";

const PREFIX = "lh.question-draft.v1:";
function storage(): Storage | null {
	try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}
const keyOf = (chatId: string) => PREFIX + encodeURIComponent(chatId);

/** One current question per chat, scoped to this browser tab. */
export function readQuestionDraft(chatId: string, pendingKey: string | undefined): QuestionDraft | undefined {
	const store = storage();
	if (!store) return;
	try {
		const raw = store.getItem(keyOf(chatId));
		if (!raw) return;
		const saved = JSON.parse(raw);
		if (!pendingKey || saved.key !== pendingKey) { store.removeItem(keyOf(chatId)); return; }
		const draft: QuestionDraft = {};
		if (typeof saved.readingThinking === "string") draft.readingThinking = saved.readingThinking;
		const form = saved.form;
		if (form && [form.thinking, form.other, form.text].every((v) => typeof v === "string") &&
			Number.isInteger(form.confidenceIndex) && form.confidenceIndex >= 0 && form.confidenceIndex < CONFIDENCE_STOPS.length &&
			Array.isArray(form.selection?.selected) && form.selection.selected.every((i: unknown) => Number.isInteger(i) && (i as number) >= 0) &&
			typeof form.selection.otherSelected === "boolean" && typeof form.selection.dontKnow === "boolean") {
			draft.form = { ...form, selection: { ...form.selection, selected: new Set<number>(form.selection.selected) } };
		}
		return draft;
	} catch { try { store.removeItem(keyOf(chatId)); } catch {} return; }
}

export function writeQuestionDraft(chatId: string, key: string, draft: QuestionDraft): void {
	try { storage()?.setItem(keyOf(chatId), JSON.stringify({ key, ...draft, form: draft.form ? { ...draft.form, selection: { ...draft.form.selection, selected: [...draft.form.selection.selected] } } : undefined })); } catch {}
}

export function retainQuestionDraft(chatId: string, pendingKey: string | undefined): void {
	readQuestionDraft(chatId, pendingKey);
}

export function clearChatQuestionDraft(chatId: string): void {
 try { storage()?.removeItem(keyOf(chatId)); } catch {}
}
