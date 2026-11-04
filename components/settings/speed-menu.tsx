"use client";

import { useEffect, useRef, useState } from "react";
import { resolveModelSpeed, supportedModelSpeeds, type ModelSpeed } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { SettingsMenuTrigger } from "./controls";

export const SPEED_LABEL: Record<ModelSpeed, string> = { standard: "Standard", fast: "Fast", ultrafast: "Ultrafast" };
const OPEN_EVENT = "lh:speed-open";

/** Uses the same control for chats, model slots and per-worker overrides. */
export function SpeedControl({ provider, modelId, value, inherited, inheritLabel, testid, onPick, onOpen, compact = false }: {
	provider?: string;
	modelId?: string;
	value?: ModelSpeed;
	inherited?: ModelSpeed;
	inheritLabel?: string;
	testid: string;
	onPick: (speed: ModelSpeed | undefined) => void;
	onOpen?: () => void;
	compact?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLSpanElement>(null);
	const menuId = `${testid}-menu`;
	const speeds = supportedModelSpeeds(provider ?? "", modelId ?? "");
	const effective = resolveModelSpeed(provider ?? "", modelId ?? "", value ?? inherited);
	useEffect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => {
			const target = event.target as Element;
			if (!anchor.current?.contains(target) && !target.closest(`[data-testid="${menuId}"]`)) setOpen(false);
		};
		const other = (event: Event) => { if ((event as CustomEvent).detail !== testid) setOpen(false); };
		document.addEventListener("pointerdown", outside);
		window.addEventListener(OPEN_EVENT, other);
		return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener(OPEN_EVENT, other); };
	}, [open, menuId, testid]);
	useEffect(() => { if (!speeds.length) setOpen(false); }, [speeds.length]);
	useEffect(() => {
		if (!open) return;
		const frame = requestAnimationFrame(() => document.getElementById(menuId)?.querySelector<HTMLButtonElement>("button")?.focus());
		return () => cancelAnimationFrame(frame);
	}, [open, menuId]);
	if (!effective) return null;
	const label = value === undefined && inheritLabel ? `${SPEED_LABEL[effective]} · ${inheritLabel}` : SPEED_LABEL[effective];
	const choose = (speed: ModelSpeed | undefined) => { onPick(speed); setOpen(false); anchor.current?.querySelector<HTMLButtonElement>("button")?.focus(); };
	return <span ref={anchor} className="relative inline-flex" onKeyDown={(event) => {
		if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); anchor.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
	}}>
		<SettingsMenuTrigger
			data-testid={testid}
			aria-label="Speed"
			aria-expanded={open}
			aria-haspopup="menu"
			aria-controls={open ? menuId : undefined}
			title={`Speed: ${label}`}
			value={label}
			className={compact ? "h-auto rounded-full bg-card/85 px-2.5 py-1 shadow-lg backdrop-blur" : undefined}
			onClick={() => { onOpen?.(); window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: testid })); setOpen(!open); }}
		/>
		{open && <MenuShell anchorRef={anchor} testid={menuId} preferredSide={compact ? "up" : "down"} menuClass="flex w-52 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl">
			<div id={menuId} role="menu" aria-label="Speed" onKeyDown={(event) => {
				if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); anchor.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
				if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
					event.preventDefault();
					const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
					const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
					const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
					buttons[next]?.focus();
				}
			}}>
				{inheritLabel && <button type="button" role="menuitemradio" aria-checked={value === undefined} data-testid="speed-option-inherit" onClick={() => choose(undefined)} className="flex w-full justify-between rounded-lg px-2 py-1.5 text-left hover:bg-muted">Use {inheritLabel}<span>{value === undefined ? "✓" : ""}</span></button>}
				{speeds.map(speed => <button key={speed} type="button" role="menuitemradio" aria-checked={value === speed || (!inheritLabel && effective === speed)} data-testid={`speed-option-${speed}`} onClick={() => choose(speed)} className="flex w-full justify-between rounded-lg px-2 py-1.5 text-left hover:bg-muted"><span>{SPEED_LABEL[speed]}</span><span>{value === speed || (!inheritLabel && effective === speed) ? "✓" : ""}</span></button>)}
			</div>
		</MenuShell>}
	</span>;
}
