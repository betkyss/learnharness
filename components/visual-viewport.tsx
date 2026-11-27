"use client";

import { useEffect, useState } from "react";

export const SHORT_VIEWPORT_MAX_HEIGHT = 500;
const KEYBOARD_INSET_THRESHOLD = 100;

export interface VisualViewportMetrics {
	width: number;
	height: number;
	offsetTop: number;
	offsetLeft: number;
	keyboardInset: number;
	isShortViewport: boolean;
	isKeyboardOpen: boolean;
}

export interface ViewportWindowLike {
	innerWidth: number;
	innerHeight: number;
	document?: {
		documentElement?: {
			clientHeight?: number;
		};
	};
	visualViewport?: {
		width: number;
		height: number;
		offsetTop: number;
		offsetLeft: number;
		addEventListener?: (type: string, listener: () => void) => void;
		removeEventListener?: (type: string, listener: () => void) => void;
	} | null;
}

/** Pure measurement of the live visual viewport (iOS Safari / Standalone PWA keyboard-aware). */
export function computeVisualViewportMetrics(win: ViewportWindowLike): VisualViewportMetrics {
	const vv = win.visualViewport;
	const width = vv && vv.width > 0 ? Math.round(vv.width) : win.innerWidth;
	const height = vv && vv.height > 0 ? Math.round(vv.height) : win.innerHeight;
	const offsetTop = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0;
	const offsetLeft = vv ? Math.max(0, Math.round(vv.offsetLeft)) : 0;
	const layoutHeight = Math.max(win.innerHeight, win.document?.documentElement?.clientHeight ?? 0);
	const rawInset = Math.max(0, Math.round(layoutHeight - height - offsetTop));
	const isKeyboardOpen = rawInset >= KEYBOARD_INSET_THRESHOLD;
	return {
		width,
		height,
		offsetTop,
		offsetLeft,
		keyboardInset: isKeyboardOpen ? rawInset : 0,
		isShortViewport: height <= SHORT_VIEWPORT_MAX_HEIGHT,
		isKeyboardOpen,
	};
}

/** Apply visual viewport CSS variables & data attributes to `<html>`.
 *  Only sets `--vvh` while a virtual keyboard actually shrinks the visual
 *  viewport: in iOS Standalone PWA (`viewport-fit=cover`) at rest,
 *  `visualViewport.height` under-reports by safe-area-inset-top (~47px), so
 *  removing `--vvh` when closed lets CSS `--lh-app-height` fill the screen. */
export function applyVisualViewportToRoot(root: HTMLElement, metrics: VisualViewportMetrics): void {
	if (metrics.isKeyboardOpen) {
		root.style.setProperty("--vvh", `${metrics.height}px`);
		root.style.setProperty("--keyboard-inset", `${metrics.keyboardInset}px`);
		root.dataset.keyboardOpen = "true";
	} else {
		root.style.removeProperty("--vvh");
		root.style.setProperty("--keyboard-inset", "0px");
		delete root.dataset.keyboardOpen;
	}
	root.style.setProperty("--vvw", `${metrics.width}px`);
	if (metrics.isShortViewport) root.dataset.shortViewport = "true";
	else delete root.dataset.shortViewport;
}

/** Mounted once in the root layout to keep `--vvh` / `--keyboard-inset` /
 *  `data-short-viewport` synced with iOS virtual keyboard resize/scroll events. */
export function VisualViewportSync() {
	useEffect(() => {
		if (typeof window === "undefined") return;
		const root = document.documentElement;
		let raf = 0;
		const sync = () => {
			applyVisualViewportToRoot(root, computeVisualViewportMetrics(window));
		};
		const schedule = () => {
			if (raf) cancelAnimationFrame(raf);
			raf = requestAnimationFrame(sync);
		};
		sync();
		const vv = window.visualViewport;
		vv?.addEventListener("resize", schedule);
		vv?.addEventListener("scroll", schedule);
		window.addEventListener("resize", schedule);
		return () => {
			if (raf) cancelAnimationFrame(raf);
			vv?.removeEventListener("resize", schedule);
			vv?.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
		};
	}, []);
	return null;
}

/** True when either CSS `(max-height: 500px)` OR `window.visualViewport.height <= 500`
 *  (e.g. iOS virtual keyboard reducing visible height without changing layout viewport). */
export function useIsShortViewport(): boolean {
	const [short, setShort] = useState(false);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const media = window.matchMedia?.(`(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT}px)`);
		const update = () => {
			const metrics = computeVisualViewportMetrics(window);
			setShort(Boolean(media?.matches) || metrics.isShortViewport);
		};
		update();
		media?.addEventListener("change", update);
		const vv = window.visualViewport;
		vv?.addEventListener("resize", update);
		window.addEventListener("resize", update);
		return () => {
			media?.removeEventListener("change", update);
			vv?.removeEventListener("resize", update);
			window.removeEventListener("resize", update);
		};
	}, []);
	return short;
}
