"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MenuShell } from "@/components/menu-shell";

/** Keep the reading area useful when a keyboard or short window reduces height. */
export function ShortControls({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
 const [short, setShort] = useState(false);
 const [open, setOpen] = useState(false);
 const anchor = useRef<HTMLDivElement>(null);
 useEffect(() => {
  if (!window.matchMedia) return;
  const media = window.matchMedia("(max-height: 500px)");
  const update = () => { setShort(media.matches); setOpen(false); };
  update(); media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
 }, []);
 useEffect(() => {
  if (!open) return;
  const dismiss = (event: PointerEvent) => {
   const target = event.target as Element;
   if (!anchor.current?.contains(target) && !target.closest("[data-lh-menu]")) setOpen(false);
  };
  const escape = (event: KeyboardEvent) => {
   if (event.key !== "Escape") return;
   event.stopPropagation(); setOpen(false); anchor.current?.querySelector("button")?.focus();
  };
  document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", escape);
  return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
 }, [open]);
 if (!short) return children;
 return <div ref={anchor} className="pointer-events-auto flex justify-end pt-1" data-short-controls="">
  <button type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} className="h-7 rounded-md border bg-card px-3 text-xs text-foreground hover:bg-accent">Controls</button>
  {open && <MenuShell anchorRef={anchor} testid="short-controls-menu" preferredSide="up" menuClass="short-controls-panel w-80 rounded-xl border bg-card p-2 shadow-lg">{extra}{children}</MenuShell>}
 </div>;
}
