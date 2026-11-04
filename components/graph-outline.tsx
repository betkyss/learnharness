"use client";

import { useEffect, useRef, useState } from "react";
import type { GraphSnapshot } from "@/src/core";
import { MenuShell } from "./menu-shell";

/** Provenance groups only. A proposition can belong to more than one source. */
export function graphSourceGroups(snapshot: GraphSnapshot) {
 const sources = new Map<string, string[]>();
 for (const node of snapshot.propositions) for (const id of snapshot.nodeSessions[node.id] ?? []) {
  const members = sources.get(id) ?? []; members.push(node.id); sources.set(id, members);
 }
 return [...sources].map(([id, nodeIds]) => {
  const members = new Set(nodeIds);
  const chains = snapshot.chains.filter(chain => [chain.conclusion, ...chain.premises].every(node => members.has(node)));
  return { id, name: snapshot.sessions[id] ?? snapshot.fileSources[id] ?? id, nodeIds, chains };
 }).sort((a, b) => a.name.localeCompare(b.name));
}

export function GraphOutline({ snapshot, query, visibleIds, onFocus }: { snapshot: GraphSnapshot; query: string; visibleIds: ReadonlySet<string>; onFocus: (ids: string[], selectNode?: boolean) => void }) {
 const [open, setOpen] = useState(false);
 const [readingChain, setReadingChain] = useState<string | null>(null);
 const anchor = useRef<HTMLDivElement>(null);
 const reading = useRef<HTMLElement>(null);
 useEffect(() => { reading.current?.scrollIntoView({block: "nearest"}); }, [readingChain]);
 useEffect(() => {
  if (!open) return;
  const dismiss = (e: PointerEvent) => { const target = e.target as Element; if (!anchor.current?.contains(target) && !target.closest('[data-lh-menu]')) setOpen(false); };
  const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); anchor.current?.querySelector('button')?.focus(); } };
  document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape);
  return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
 }, [open]);
 const groups = graphSourceGroups(snapshot);
 const chain = snapshot.chains.find(item => item.id === readingChain);
 const readChain = (id: string) => {
  const selected = snapshot.chains.find(item => item.id === id);
  if (!selected) return;
  setReadingChain(id);
  onFocus([selected.conclusion, ...selected.premises], true);
 };
 const matches = query.trim() ? snapshot.propositions.filter(node => visibleIds.has(node.id)) : [];
 const pick = (ids: string[], selectNode = false) => { setOpen(false); onFocus(ids, selectNode); };
 return <div ref={anchor} className="graph-outline flex max-w-full flex-wrap justify-end gap-1 text-xs">
  <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="rounded-lg border bg-card px-3 py-1.5 hover:bg-accent">{query.trim() ? `${matches.length} results` : `${groups.length} sources · ${snapshot.chains.length} chains`}</button>
  <div className="graph-source-anchors flex flex-wrap justify-end gap-1">{groups.slice(0, 2).map(group => <button type="button" key={group.id} title={group.name} onClick={() => pick(group.nodeIds)} className="max-w-52 truncate rounded-lg border bg-card px-2 py-1.5 text-muted-foreground hover:text-foreground">{group.name} · {group.nodeIds.length}</button>)}</div>
  {open && <MenuShell anchorRef={anchor} testid="graph-outline-menu" preferredSide="down" menuClass="w-80 rounded-xl border bg-card p-3 text-xs shadow-lg">
   <h2 className="mb-2 font-medium">{query.trim() ? "Search results" : "Sources and chains"}</h2>
   {chain && <section ref={reading} data-testid="graph-chain-reading" className="mb-3 border-b pb-3">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">Reasoning chain</h3><button type="button" aria-label="Close chain reading" className="min-h-8 rounded-sm px-2 text-muted-foreground hover:bg-accent" onClick={() => setReadingChain(null)}>Close</button></div>
    {[...chain.premises, chain.conclusion].map(id => {
     const node = snapshot.propositions.find(item => item.id === id);
     if (!node) return null;
     return <article key={id} className="py-2"><div className="mb-1 text-sm font-medium">{node.name}<span className="ml-2 text-xs font-normal text-muted-foreground">{id === chain.conclusion ? "Conclusion" : "Premise"}</span></div><p className="knowledge-statement-text text-foreground">{node.statement}</p></article>;
    })}
    <button type="button" className="min-h-8 rounded-sm border px-2" onClick={() => pick([chain.conclusion, ...chain.premises], true)}>Show this chain in graph</button>
   </section>}
   {query.trim() ? matches.map(node => <button type="button" key={node.id} onClick={() => pick([node.id], true)} className="block w-full rounded px-2 py-2 text-left hover:bg-accent">{node.name}</button>) : groups.map(group => <div key={group.id} className="border-t py-2">
    <button type="button" className="block w-full rounded p-1 text-left hover:bg-accent" onClick={() => pick(group.nodeIds)}>{group.name}<span className="mt-1 block text-muted-foreground">{group.nodeIds.length} propositions · {group.chains.length} chains · Show in graph</span></button>
    <details className="pl-2"><summary className="cursor-pointer py-1 text-muted-foreground">Browse propositions and chains</summary>
     {group.chains.map(chain => <button type="button" key={chain.id} onClick={() => readChain(chain.id)} className="block w-full rounded py-1 text-left hover:bg-accent">Read chain: {snapshot.propositions.find(node => node.id === chain.conclusion)?.name ?? chain.conclusion}</button>)}
     {group.nodeIds.map(id => <button type="button" key={id} onClick={() => pick([id], true)} className="block w-full rounded py-1 text-left text-muted-foreground hover:bg-accent">{snapshot.propositions.find(node => node.id === id)?.name ?? id}</button>)}
    </details>
   </div>)}
   {!query.trim() && <details className="border-t pt-2"><summary className="cursor-pointer py-1">All {snapshot.chains.length} recorded chains</summary>{snapshot.chains.map(chain => <button type="button" key={chain.id} onClick={() => readChain(chain.id)} className="block w-full rounded py-2 text-left hover:bg-accent">{snapshot.propositions.find(node => node.id === chain.conclusion)?.name ?? chain.conclusion}<span className="block text-muted-foreground">{chain.premises.length} premises</span></button>)}</details>}
  </MenuShell>}
 </div>;
}
