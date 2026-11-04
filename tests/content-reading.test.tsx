import React, { act } from 'react';
(globalThis as Record<string, unknown>).React = React;
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { DeleteSessionBody } from '../components/delete-session-dialog';
import { DeleteSourceBody } from '../components/delete-source-dialog';
import { SourceMetadata } from '../components/source-folder-tree';
import { SubagentSteerCard } from '../components/artifacts/steer-card';
import { QuestionDock } from '../components/question-dock';
import type { LhViewMessage } from '../src/core';

it('long deletion titles follow consequences and graph choice, with full title inside the single scroll body', () => {
 const title = 'Synthetic session: definitions and proof. '.repeat(30);
 const html = renderToStaticMarkup(<DeleteSessionBody chat={{id:'disposable',title}} traces={false} busy={false} failure={null} onTraces={()=>{}} onClose={()=>{}} onRun={()=>{}}/>);
 const {document} = parseHTML(html);
 assert.ok(html.indexOf('delete-traces-checkbox') < html.indexOf('session-title-preview'));
 assert.equal(document.querySelector('details p')?.textContent,title);
 assert.match(document.querySelector('summary')!.textContent!,/Show full title/);
 assert.ok(document.querySelector('.lh-confirm-body details'));
 assert.equal(document.querySelectorAll('.lh-confirm-actions button').length,2);
});
it('empty-folder deletion names the actual object and retains its full name', () => {
 const html=renderToStaticMarkup(<DeleteSourceBody sources={[]} folders={[{id:'f',name:'Empty folder',createdAt:'synthetic',parentId:null}]} deleteSessions={false} onDeleteSessions={()=>{}} busy={false} failure="" onClose={()=>{}} onRun={()=>{}}/>);
 assert.match(html,/Delete this empty folder\?/);assert.match(html,/0 sources, 1 folder/);assert.match(html,/Empty folder/);
});
it('mobile source metadata preserves the creation date and labelled proposition count',()=>{
 const html=renderToStaticMarkup(<SourceMetadata count={7} created="2026-11-04T12:00:00Z"/>);
 assert.match(html,/Propositions: /);assert.match(html,/>7</);assert.match(html,/Created: 2026-11-04/);assert.match(html,/<details/);
});
it('completed briefs expose real content, sources and pages; failures remain failures',()=>{
 const render=(kind:string,result:unknown)=>renderToStaticMarkup(<SubagentSteerCard message={{id:'result',parts:[{type:'data-subagent-artifact',data:{kind,result}}]} as unknown as LhViewMessage}/>);
 const research=render('research',{brief:'A real saved synthetic brief.',sources:[{url:'https://example.test/definition',title:'Definition'}]});
 assert.match(research,/research-complete-badge/);assert.match(research,/aria-expanded="false"/);assert.match(research,/min-h-9/);assert.match(research,/lucide-chevron-right/);assert.match(research,/A real saved synthetic brief/);assert.match(research,/https:\/\/example.test\/definition/);
 const pdf=render('pdf',{brief:'PDF saved brief',pagesRead:[1],pagesConsulted:[1,2]});assert.match(pdf,/Pages consulted/);assert.match(pdf,/1, 2/);
 assert.doesNotMatch(render('research',{brief:'Research failed: unavailable',sources:[]}),/research-complete-badge/);
 assert.doesNotMatch(render('pdf',{brief:'PDF failed: unavailable',pagesRead:[],pagesConsulted:[]}),/pdf-complete-badge/);
});
it('long questions appear once above the thinking editor and preserve draft selection and confidence',async()=>{
 const dom=parseHTML('<html><body><div id="root"></div></body></html>');
 Object.assign(globalThis,{window:dom.window,document:dom.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const root=createRoot(document.querySelector('#root')!);
 const label='Long selected answer. '.repeat(30),question='Use the definition to decide. '.repeat(20);
 try {
  await act(async()=>root.render(<QuestionDock toolName="quiz" toolCallId="synthetic-q" input={{question,options:[{label},{label:'No'}],correctAnswer:label,explanation:'Definition'}} expanded onExpand={()=>{}} onSubmit={()=>{}} dictationClaim={false} initialDraft={{selection:{selected:new Set([0]),otherSelected:false,dontKnow:false},thinking:'My unsent reasoning',other:'',text:'',confidenceIndex:3}}/>));
  assert.equal(document.querySelector('[data-testid="question-context"]')===null,true,'question context should not be duplicated');
  assert.equal(document.body.textContent!.split(question.trim()).length-1,1);
  const thinkingField=document.querySelector('[data-testid="thinking-field"]')!;
  assert.equal(thinkingField.firstElementChild?.textContent,'YOUR THINKING');
  assert.ok(thinkingField.querySelector('[role="textbox"]'));
  assert.match(document.body.textContent!,/My unsent reasoning/);
  assert.equal(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.includes('Long selected answer'),true);
  assert.equal(document.querySelector('[data-testid="confidence-value"]')?.textContent,'70%');
 } finally {await act(async()=>root.unmount());}
});
it('Enter on a native disclosure stays native and does not submit the lesson',async()=>{
 const {useEnterSubmits}=await import('../components/enter-submits');
 const dom=parseHTML('<html><body><div id="root"></div></body></html>');
 Object.assign(globalThis,{window:dom.window,document:dom.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const root=createRoot(document.querySelector('#root')!);let submits=0;
 function Harness(){useEnterSubmits(()=>submits++);return <details><summary><span>Saved brief</span></summary><p>Saved content</p></details>;}
 try{
  await act(async()=>root.render(<Harness/>));
  const event=new dom.window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:'Enter'});
  await act(async()=>document.querySelector('summary span')!.dispatchEvent(event));
  assert.equal(event.defaultPrevented,false);assert.equal(submits,0);
  const bodyEnter=new dom.window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(bodyEnter,'key',{value:'Enter'});
  await act(async()=>document.body.dispatchEvent(bodyEnter));assert.equal(submits,1);
 }finally{await act(async()=>root.unmount());}
});
