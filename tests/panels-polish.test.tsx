import React, { act } from 'react';
(globalThis as Record<string, unknown>).React = React;
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { DeleteSourceBody } from '../components/delete-source-dialog';
import { graphSourceGroups } from '../components/graph-outline';
import type { GraphSnapshot, SourceEntry } from '../src/core';

it('long source selections disclose every name, preserve the session option, and cancel without deletion', async () => {
 const dom = parseHTML('<html><body><div id="root"></div></body></html>');
 Object.assign(globalThis, {window:dom.window, document:dom.document, IS_REACT_ACT_ENVIRONMENT:true});
 const root = createRoot(document.querySelector('#root')!); let cancelled = 0, deleted = 0, sessions = false;
 const sources = Array.from({length:12}, (_,i) => ({id:`scratch-${i}`,kind:'chat',label:`${i} ${'Long source name '.repeat(20)}`})) as SourceEntry[];
 try {
  await act(async () => root.render(<DeleteSourceBody sources={sources} folders={[]} deleteSessions={false} onDeleteSessions={value => {sessions=value;}} busy={false} failure="" onClose={() => cancelled++} onRun={() => deleted++}/>));
  assert.match(document.querySelector('summary')!.textContent!, /12 sources, 0 folders/);
  assert.equal(document.querySelectorAll('li').length,12);
  assert.equal(document.querySelector('li:last-child')!.textContent,sources[11]!.label);
  const checkbox = document.querySelector<HTMLInputElement>('input')!;
  assert.equal(checkbox.checked,false);
  assert.equal(sessions,false);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="source-delete-cancel"]')!.click());
  assert.equal(cancelled,1); assert.equal(deleted,0);
  assert.ok(document.querySelector('.lh-confirm-body details'));
  assert.ok(document.querySelector('.lh-confirm-actions [data-testid="source-delete-confirm"]'));
 } finally {await act(async () => root.unmount());}
});
it('overview uses recorded provenance, counts shared nodes in each source and never invents cross-source chains', () => {
 const graph = {propositions:[{id:'a'},{id:'b'},{id:'c'}],nodeSessions:{a:['x'],b:['x','y'],c:['y']},sessions:{x:'Lesson X',y:'Lesson Y'},fileSources:{},chains:[{id:'ab',premises:['a'],conclusion:'b'},{id:'bc',premises:['b'],conclusion:'c'},{id:'ac',premises:['a'],conclusion:'c'}]} as unknown as GraphSnapshot;
 const groups=graphSourceGroups(graph);
 assert.deepEqual(groups.map(g=>({name:g.name,nodes:g.nodeIds,chains:g.chains.map(c=>c.id)})),[{name:'Lesson X',nodes:['a','b'],chains:['ab']},{name:'Lesson Y',nodes:['b','c'],chains:['bc']}]);
});
