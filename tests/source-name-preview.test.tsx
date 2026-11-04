import React, { act } from 'react';
(globalThis as Record<string,unknown>).React=React;
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { EditableSourceName } from '../components/source-folder-tree';
it('expands a full source name without entering rename or writing data',async()=>{
 const dom=parseHTML('<html><body><div id="root"></div></body></html>');
 Object.assign(globalThis,{window:dom.window,document:dom.document,IS_REACT_ACT_ENVIRONMENT:true});
 const root=createRoot(document.querySelector('#root')!);let writes=0;
 const name='Synthetic source with definitions and proof prerequisites. '.repeat(5);
 try {
  await act(async()=>root.render(<EditableSourceName name={name} onSave={async()=>{writes++;}}/>));
  const expand=document.querySelector<HTMLButtonElement>('.source-name-expand')!;
  assert.equal(expand.getAttribute('aria-expanded'),'false');
  assert.equal(document.querySelector('.source-name-preview')?.getAttribute('aria-label'),`Rename ${name}`);
  await act(async()=>expand.click());
  assert.equal(expand.getAttribute('aria-expanded'),'true');
  assert.equal(document.querySelector('.source-name')?.getAttribute('data-full-name'),'true');
  assert.equal(document.querySelector('input'),null);assert.equal(writes,0);
  await act(async()=>expand.click());assert.equal(expand.getAttribute('aria-expanded'),'false');
 } finally {await act(async()=>root.unmount());}
});
