"use client";
/**
 * THE APPEARANCE APPLICATION (thin settings wave, 2026-09-19): the settings
 * record's appearance section actually DOES something — resolved against
 * the factory defaults and applied as RUNTIME CSS variables on <html>.
 *
 * Why variables and not className swaps: every seam the settings touch was
 * built token-first (--font-prose, --lh-prose-size, --lh-ink-strong, …),
 * so application is setProperty and nothing re-renders. The ONE thing the
 * variables can't reach — the mode — is dark-only this wave (the light
 * palette is designed in the later design wave; <html class="dark"> is
 * static in app/layout.tsx).
 *
 * The provider is mounted at the ROOT LAYOUT level (like ActivityProvider):
 * every page picks appearance up on load. The settings page writes a
 * section, hands the new appearance here, and the vars move immediately.
 *
 * (The open-settings keyboard chord lives in components/keyboard-shortcuts.tsx
 * with the other navigations — mod+, pushes /settings from anywhere.)
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { FACTORY_SETTINGS, type AppearanceSettings } from "@/src/core";

/** The resolved, fully-concrete appearance view (delta + factory merged). */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		chatWidth: delta?.chatWidth ?? f.chatWidth,
		mode: delta?.mode ?? f.mode,
		background: delta?.background ?? f.background,
		fontFamily: delta?.fontFamily ?? f.fontFamily,
		interfaceFontFamily: delta?.interfaceFontFamily ?? f.interfaceFontFamily,
		cornerRadius: delta?.cornerRadius ?? f.cornerRadius,
		contrast: delta?.contrast ?? f.contrast,
		proseFontSize: delta?.proseFontSize ?? f.proseFontSize,
		sessionNameSerif: delta?.sessionNameSerif ?? f.sessionNameSerif,
		mdRendering: {
			headingWeight: delta?.mdRendering?.headingWeight ?? f.mdRendering.headingWeight,
			boldColor: delta?.mdRendering?.boldColor ?? f.mdRendering.boldColor,
			italicColor: delta?.mdRendering?.italicColor ?? f.mdRendering.italicColor,
		},
	};
}

/** RGB offsets preserve the approved surface relationships for custom backgrounds. */
function raise(hex: string, offsets: readonly number[]): string {
	const n = hex.length === 4
		? hex.slice(1).split("").map((c) => parseInt(c + c, 16))
		: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	return `#${n.map((c, i) => Math.min(255, c + (offsets[i] ?? 0)).toString(16).padStart(2, "0")).join("")}`;
}

export function derivedPalette(background: string): Record<string, string> {
	const card = raise(background, [24, 24, 27]);
	return {
		"--background": background,
		"--sidebar": raise(background, [9, 9, 11]),
		"--card": card,
		"--popover": card,
		"--secondary": card,
		"--muted": card,
		"--accent": raise(background, [39, 39, 42]),
		"--primary-foreground": background,
	};
}

/** Escape a family as one CSS string, retaining a system fallback for unknown fonts. */
function fontStack(family: string): string {
	const quoted = family.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\n\r\f]/g, " ");
	// Keep explicitly saved bundled families available after the default changes.
	const normalized = family.toLowerCase();
	const bundled = normalized === "source sans 3" ? "var(--font-sans3), " : normalized === "cmu serif" ? '"lh-cmu", ' : "";
	return `"${quoted}", ${bundled}ui-sans-serif, system-ui, sans-serif`;
}

/** Only overrides are written inline; reset removes them and restores stylesheet defaults. */
export function appearanceVars(a: ReturnType<typeof resolveAppearance>): Record<string, string> {
	const vars: Record<string, string> = {};
	vars["--lh-chat-max-width"] = { comfortable: "46rem", wide: "72rem", full: "100%" }[a.chatWidth];
	if (a.background !== null) Object.assign(vars, derivedPalette(a.background));
	if (a.fontFamily !== null) vars["--font-prose"] = fontStack(a.fontFamily);
	if (a.interfaceFontFamily !== null) vars["--font-ui"] = fontStack(a.interfaceFontFamily);
	if (a.cornerRadius !== FACTORY_SETTINGS.appearance.cornerRadius) vars["--radius"] = `${a.cornerRadius}px`;
	if (a.contrast === "high") {
		vars["--border"] = "rgb(255 255 255 / 20%)";
		vars["--input"] = "rgb(255 255 255 / 20%)";
		vars["--muted-foreground"] = "#d4d4d8";
	}
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	if (a.sessionNameSerif) vars["--font-title"] = '"lh-cmu", serif';
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
	if (a.mdRendering.boldColor !== null) vars["--lh-ink-strong"] = a.mdRendering.boldColor;
	if (a.mdRendering.italicColor !== null) vars["--lh-ink-italic"] = a.mdRendering.italicColor;
	return vars;
}

/** Pure: the previously-applied names ABSENT from the next var set —
 *  these get removeProperty so the factory stylesheet value returns.
 *  (Owner repro, fix wave: resets and toggle-backs never reverted because
 *  application only ever SET properties — the removal half was missing.)
 *  Exported for tests. */
export function staleVarNames(
	prevNames: readonly string[],
	nextVars: Record<string, string>,
): string[] {
	return prevNames.filter((n) => !(n in nextVars));
}

interface AppearanceContextValue {
	/** Resolved appearance; factory until the record arrives. */
	appearance: ReturnType<typeof resolveAppearance>;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	onAppearanceChange: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(undefined);
	const appliedRef = useRef<string>("");

	// The vars apply on every change — stringified as the change signal.
	const vars = useMemo(() => appearanceVars(resolveAppearance(delta)), [delta]);
	const key = useMemo(() => JSON.stringify(vars), [vars]);
	// REMOVAL is half the job (owner repro, fix wave): a later write that
	// OMITS a var (empty field = factory, serif toggle back on) must clear
	// the previously-set inline value or the stale one wins forever —
	// backgrounds never reset, toggles looked dead. Every name this effect
	// has ever set is tracked; names absent from the new set are removed so
	// the factory stylesheet value returns.
	const appliedNamesRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (appliedRef.current === key) return;
		appliedRef.current = key;
		const root = document.documentElement;
		for (const name of staleVarNames([...appliedNamesRef.current], vars)) {
			root.style.removeProperty(name);
			appliedNamesRef.current.delete(name);
		}
		for (const [name, value] of Object.entries(vars)) {
			root.style.setProperty(name, value);
			appliedNamesRef.current.add(name);
		}
	}, [key, vars]);

	// One fetch per app load: the record (sanitized server-side) carries the
	// delta; resolution happens here against the compiled factory.
	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((r) => r.json())
			.then((body: { settings?: Record<string, unknown> }) => {
				if (!alive) return;
				// The record arrives sanitized server-side; the appearance
				// slice is unknown-shaped here, so it goes through the same
				// resolve (absent/invalid fields = factory anyway).
				const appearance = body.settings?.appearance;
				setDelta(
					appearance && typeof appearance === "object" ? (appearance as AppearanceSettings) : undefined,
				);
			})
			.catch(() => {/* settings stay factory — not worth a crash */});
		return () => {
			alive = false;
		};
	}, []);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		setDelta(next);
	}, []);

	const value = useMemo(
		() => ({ appearance: resolveAppearance(delta), onAppearanceChange }),
		[delta, onAppearanceChange],
	);
	return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}