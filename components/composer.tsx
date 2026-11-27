"use client";

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowRightIcon, ArrowUpIcon, CornerDownLeftIcon, PlusIcon, SquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { PathInput } from "@/components/path-input";
import { AttachFilesButton } from "@/components/attach-files-button";
import { InlineDictationIndicator, MobileDictationButton, MobileDictationError, type Dictation } from "@/components/dictation";
import { PendingImageStrip, type PendingImage } from "@/components/mobile-image-attachments";
import { useOptionalInteractionLayers } from "./interaction-layers";
import { isInteractionScopeEligible } from "./plugin-input-focus";

const noSubscribe = () => () => {};
function useIsElectronDesktop(): boolean {
	return useSyncExternalStore(noSubscribe, () => Boolean(window.lh?.getPathForFile), () => false);
}

/**
 * The chat composer — content row ONLY (the persistent rounded shell lives in
 * the chat view's overlay, so the shell can later morph chat → question
 * without remounting).
 *
 * Controls share the configurable radius scale with the dock shell.
 */
/** What one Enter press does, in precedence order: stop a busy stream,
 *  otherwise send the message, otherwise — practice sessions only — fire
 *  the next-problem signal while the between-problems pause is live
 *  (owner round 16: Enter on an EMPTY composer is the go-ahead; typing
 *  anything makes Enter a send again). Pure so the static-render harness
 *  can pin the decision (key events can't be simulated in
 *  renderToStaticMarkup). */
export function enterAction(state: {
	busy: boolean;
	canSend: boolean;
	/** The between-problems pause is live: practice session, nothing
	 *  active, no turn/compaction in flight (the caller's fold). */
	nextProblem?: boolean;
}): "stop" | "send" | "next" | "none" {
	// Composer steering (owner arc 2026-10-03): while a turn runs, typed
	// text makes Enter a STEER (the queue-and-redirect send); Enter with
	// an empty composer stays the stop shortcut. The button itself keeps
	// the square — Stop stays one click away at all times.
	if (state.busy) return state.canSend ? "send" : "stop";
	if (state.canSend) return "send";
	if (state.nextProblem) return "next";
	return "none";
}

/**
 * Session composer with local keystroke state. The owning Chat keeps the
 * current draft in a ref for send/dictation, so typing doesn't rerender the
 * transcript; revision signals explicit parent-driven draft resets.
 */
export function ChatSessionComposer({
	busy,
	value,
	revision,
	onChange,
	onSend,
	onStop,
	sendAllowed,
	dictationActive,
	autoFocus,
	inputRef,
	onEscape,
	placeholder,
	mobilePlaceholder,
	nextProblem,
	onNext,
	pendingInput = false,
	dictation,
	dictationDisabled = false,
	mobileSessionControl,
	pendingImages,
	onAttachImages,
	onRemoveImage,
	imageError,
}: {
	busy: boolean;
	value: string;
	revision: number;
	onChange: (value: string) => void;
	onSend: () => void;
	onStop: () => void;
	sendAllowed: boolean;
	dictationActive: boolean;
	autoFocus?: boolean;
	inputRef?: React.RefObject<HTMLDivElement | null>;
	onEscape?: () => void;
	placeholder?: string;
	mobilePlaceholder?: string;
	nextProblem?: boolean;
	onNext?: () => void;
	pendingInput?: boolean;
	dictation?: Dictation;
	dictationDisabled?: boolean;
	mobileSessionControl?: ReactNode;
	pendingImages?: readonly PendingImage[];
	onAttachImages?: (files: FileList) => void;
	onRemoveImage?: (id: string) => void;
	imageError?: string | null;
}) {
	const [draft, setDraft] = useState(value);
	useLayoutEffect(() => { setDraft(value); }, [revision, value]);
	const hasImages = (pendingImages?.length ?? 0) > 0;
	const canSend = sendAllowed && (draft.trim().length > 0 || dictationActive || pendingInput || hasImages);
	const applyDraft = useCallback((next: string) => {
		setDraft(next);
		onChange(next);
	}, [onChange]);

	return (
		<Composer
			busy={busy}
			value={draft}
			onChange={applyDraft}
			onSend={onSend}
			onStop={onStop}
			canSend={canSend}
			autoFocus={autoFocus}
			inputRef={inputRef}
			onEscape={onEscape}
			placeholder={placeholder}
			mobilePlaceholder={mobilePlaceholder}
			nextProblem={nextProblem}
			onNext={onNext}
			dictation={dictation}
			dictationDisabled={dictationDisabled}
			mobileSessionControl={mobileSessionControl}
			pendingImages={pendingImages}
			onAttachImages={onAttachImages}
			onRemoveImage={onRemoveImage}
			imageError={imageError}
		/>
	);
}

export function Composer({
	busy,
	value,
	onChange,
	onSend,
	onStop,
	canSend,
	autoFocus,
	inputRef,
	onEscape,
	placeholder = "Ask, answer, or steer the lesson…",
	mobilePlaceholder = "Ask anything…",
	nextProblem = false,
	onNext,
	defaultDropTarget = true,
	fileInsertion = true,
	dictation,
	dictationDisabled = false,
	mobileSessionControl,
	pendingImages,
	onAttachImages,
	onRemoveImage,
	imageError,
}: {
	busy: boolean;
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	onStop: () => void;
	canSend: boolean;
	autoFocus?: boolean;
	/** The page's handle to the textarea — the dictation-end focus (owner,
	 *  2026-10-01): a run ending hands the cursor to the bare composer. */
	inputRef?: React.RefObject<HTMLDivElement | null>;
	/** Escape while a dictation runs stops it (STT wave, 2026-09-17). No-op
	 *  when absent — Esc otherwise means nothing in the composer. */
	onEscape?: () => void;
	/** The textarea's placeholder (owner refinement round, 2026-09-24):
	 *  active sessions read "Ask, answer, or steer the lesson…"; the fresh
	 *  new-session page asks the graph view's opening question instead. */
	placeholder?: string;
	/** Short single-line placeholder shown on mobile (<768px) so the empty pill stays 48px tall. */
	mobilePlaceholder?: string;
	/** The practice pause is live (owner round 16): Enter on the empty
	 *  composer fires the next-problem signal instead of doing nothing —
	 *  the keyboard-first move-on. */
	nextProblem?: boolean;
	/** The signal's dispatcher (send({type:"next"})) — the chip and the
	 *  empty-Enter share it. */
	onNext?: () => void;
	/** Neutral plugin composers opt out without changing core defaults. */
	defaultDropTarget?: boolean;
	fileInsertion?: boolean;
	/** Optional mobile-compact controls (T3 Code single-row pill on <768px; desktop untouched). */
	dictation?: Dictation;
	dictationDisabled?: boolean;
	mobileSessionControl?: ReactNode;
	pendingImages?: readonly PendingImage[];
	onAttachImages?: (files: FileList) => void;
	onRemoveImage?: (id: string) => void;
	imageError?: string | null;
}) {
	const controller = useOptionalInteractionLayers();
	const electronDesktop = useIsElectronDesktop();
	const mobileImageInputRef = useRef<HTMLInputElement>(null);
	const act = () => {
		const action = enterAction({ busy, canSend, nextProblem });
		if (action === "stop") onStop();
		else if (action === "send") onSend();
		else if (action === "next") onNext?.();
	};
	const ownInputRef = useRef<HTMLDivElement>(null);
	const editorRef = inputRef ?? ownInputRef;
	const hasMobilePill = Boolean(mobileSessionControl || dictation || onAttachImages);
	const dictationActive = Boolean(dictation?.active);
	return (
		<div className="flex flex-col">
			{pendingImages && pendingImages.length > 0 && onRemoveImage && (
				<PendingImageStrip images={pendingImages} onRemove={onRemoveImage} />
			)}
			{imageError && (
				<p role="alert" data-testid="composer-image-error" className="px-3 pt-1.5 text-xs text-destructive">
					{imageError}
				</p>
			)}
			{hasMobilePill && dictation && <MobileDictationError dictation={dictation} />}
			<form
				data-testid="composer"
				data-mobile-pill={hasMobilePill ? "true" : undefined}
				data-recording={hasMobilePill && dictationActive ? "true" : undefined}
				className={cn(
					"flex items-end gap-1.5 p-1.5",
					hasMobilePill && "max-md:min-h-12 max-md:gap-0.5 max-md:px-1 max-md:py-0.5",
				)}
				onSubmit={(e) => {
					e.preventDefault();
					act();
				}}
			>
				{/* Mobile left "+" attach button (exact T3 Code 44×44 hitbox) */}
				{hasMobilePill && !dictationActive && (
					<div className="shrink-0 md:hidden">
						{!electronDesktop && onAttachImages ? (
							<>
								<input
									ref={mobileImageInputRef}
									type="file"
									accept="image/*"
									multiple
									hidden
									data-testid="mobile-attach-image-input"
									onChange={(e) => {
										if (e.currentTarget.files && e.currentTarget.files.length > 0) {
											onAttachImages(e.currentTarget.files);
										}
										e.currentTarget.value = "";
									}}
								/>
								<button
									type="button"
									aria-label="Attach image"
									data-testid="mobile-attach-button"
									onClick={() => mobileImageInputRef.current?.click()}
									className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-accent hover:text-foreground"
								>
									<PlusIcon className="size-5" />
								</button>
							</>
						) : (
							<AttachFilesButton editorRef={editorRef} />
						)}
					</div>
				)}

				{/* Mobile inline minimalist dictation indicator — replaces input in-place inside the same pill */}
				{hasMobilePill && dictationActive && dictation && (
					<div className="flex min-w-0 flex-1 items-center md:hidden">
						<InlineDictationIndicator dictation={dictation} />
					</div>
				)}

				<PathInput
					ref={editorRef}
					value={value}
					onValueChange={onChange}
					defaultDropTarget={defaultDropTarget}
					fileInsertion={fileInsertion}
					data-mobile-placeholder={hasMobilePill ? mobilePlaceholder : undefined}
					onKeyDown={(e) => {
						if (!isInteractionScopeEligible(e.currentTarget, controller)) return;
						// Esc ends dictation before anything else Esc might someday mean
						// here (the dictate decisions: click-again or Esc to stop).
						// stopPropagation claims the Esc (keyboard wave A): the
						// window-level chain must not also abort a turn under us.
						if (e.key === "Escape" && onEscape) {
							controller?.claimEscape(e);
							e.preventDefault();
							e.stopPropagation();
							onEscape();
							return;
						}
						// Chat convention: Enter sends, Shift+Enter is a newline.
						// ⌘/Ctrl+Enter also sends — the universal submit shortcut
						// across every input in the app (thinking field, answers).
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
							e.preventDefault();
							act();
						}
					}}
					placeholder={placeholder}
					autoFocus={autoFocus}
					className={cn(
						"field-sizing-content lh-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground",
						hasMobilePill && "max-md:max-h-36 max-md:min-h-11 max-md:px-1.5 max-md:py-2.5 max-md:leading-6",
						hasMobilePill && dictationActive && "max-md:hidden",
					)}
				/>

				{/* Desktop paperclip — unchanged */}
				<div className={hasMobilePill ? "hidden shrink-0 md:block" : "shrink-0"}>
					<AttachFilesButton editorRef={editorRef} />
				</div>

				{/* Mobile right controls: model sheet trigger + mic icon */}
				{hasMobilePill && !dictationActive && mobileSessionControl && (
					<div className="shrink-0 md:hidden">{mobileSessionControl}</div>
				)}
				{hasMobilePill && dictation && (
					<MobileDictationButton
						dictation={dictation}
						disabled={dictationDisabled}
						className="md:hidden"
					/>
				)}

				{/* Send / Stop / Next button */}
				{nextProblem && !busy && !canSend ? (
					<button
						type="submit"
						data-testid="next-problem-button"
						aria-label="Next problem"
						className={cn(
							"flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-md bg-success px-4 font-ui text-xs font-medium uppercase tracking-wide text-success-foreground transition-colors hover:bg-success/85",
							hasMobilePill && "max-md:h-9 max-md:my-1 max-md:rounded-full max-md:px-3",
						)}
					>
						<span className={hasMobilePill ? "max-md:hidden" : undefined}>Next problem</span>
						{hasMobilePill && <span className="md:hidden">Next</span>}
						<ArrowRightIcon className="size-4" />
					</button>
				) : (
					<button
						type="submit"
						aria-label={busy && !canSend ? "Stop" : "Send"}
						disabled={!busy && !canSend}
						className={cn(
							"flex size-10 shrink-0 items-center justify-center rounded-md transition-colors",
							hasMobilePill && "max-md:size-11 max-md:bg-transparent max-md:hover:opacity-100 max-md:disabled:opacity-100",
							busy && !canSend
								? "bg-secondary text-foreground hover:bg-accent"
								: "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40",
						)}
					>
						{hasMobilePill ? (
							<>
								<span className="hidden md:inline-flex">
									{busy && !canSend ? <SquareIcon className="size-4" /> : <CornerDownLeftIcon className="size-5" />}
								</span>
								<span
									className={cn(
										"flex size-9 items-center justify-center rounded-full transition-colors md:hidden",
										busy && !canSend
											? "bg-secondary text-foreground"
											: canSend
												? "bg-primary text-primary-foreground"
												: "bg-secondary text-muted-foreground/70",
									)}
								>
									{busy && !canSend ? <SquareIcon className="size-3.5" /> : <ArrowUpIcon className="size-[18px]" />}
								</span>
							</>
						) : (
							busy && !canSend ? <SquareIcon className="size-4" /> : <CornerDownLeftIcon className="size-5" />
						)}
					</button>
				)}
			</form>
		</div>
	);
}
