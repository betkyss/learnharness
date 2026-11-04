import React, { act } from 'react';
(globalThis as Record<string, unknown>).React=React;
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {renderToString} from 'react-dom/server';
import {hydrateRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {useChatSession} from '../components/session';
import {QuestionDock} from '../components/question-dock';
import {writeQuestionDraft} from '../components/question-draft-storage';
import {pendingQuestionOf, CONFIDENCE_STOPS, type LhMessage} from '../src/core';

it('hydrates the server empty form before restoring the complete saved draft, without overwriting it',async()=>{
 const dom=parseHTML('<html><body><div id="root"></div></body></html>');
 Object.assign(globalThis,{window:dom.window,document:dom.document,HTMLElement:dom.window.HTMLElement,CustomEvent:dom.window.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true});
 const entries=new Map<string,string>();
 Object.defineProperty(window,'sessionStorage',{configurable:true,value:{getItem:(key:string)=>entries.get(key)??null,setItem:(key:string,value:string)=>entries.set(key,value),removeItem:(key:string)=>entries.delete(key)}});
 const input={question:'Which integer is even?',options:[{label:'Eight',value:'8'},{label:'Seven',value:'7'}],correctAnswer:'8',explanation:'Eight is twice four.'};
 const messages=[{id:'m',role:'assistant',content:[{type:'toolCall',id:'q',name:'quiz',arguments:input}],stopReason:'toolUse',timestamp:1}] as unknown as LhMessage[];
 const pending=pendingQuestionOf(messages)!;
 writeQuestionDraft('synthetic-hydration',pending.key,{form:{selection:{selected:new Set([0]),otherSelected:false,dontKnow:false},thinking:'Twice four is eight.',other:'',text:'',confidenceIndex:CONFIDENCE_STOPS.length-1}});
 function Harness(){const session=useChatSession({chatId:'synthetic-hydration',initialMessages:messages});return <QuestionDock key={Number(session.draftsReady)} toolName="quiz" toolCallId="q" input={input} expanded onExpand={()=>{}} onSubmit={()=>{}} dictationClaim={false} initialDraft={session.questionDraft(pending.key)?.form} onSaveDraft={form=>session.saveQuestionDraft(pending.key,{form})}/>;}
 const host=document.querySelector('#root')!;host.innerHTML=renderToString(<Harness/>);
 // Browsers lowercase HTML attribute names; linkedom preserves React SSR's casing.
 for(const element of host.querySelectorAll('*')) for(const attr of [...element.attributes]) {if(attr.name!==attr.name.toLowerCase()){element.removeAttribute(attr.name);element.setAttribute(attr.name.toLowerCase(),attr.value);}}
 assert.equal(host.querySelector('[role=radio][aria-checked=true]'),null);
 const firstLabel=host.querySelector('[role=radio]')!.textContent;
 const errors:unknown[]=[];let root:ReturnType<typeof hydrateRoot>|undefined;
 try{
  await act(async()=>{root=hydrateRoot(host,<Harness/>,{onRecoverableError:error=>errors.push(error)});});
  assert.deepEqual(errors,[]);
  assert.equal(host.querySelector('[role=radio][aria-checked=true]')!.textContent,firstLabel);
  assert.match(host.textContent!,/Twice four is eight/);assert.match(host.textContent!,/100%/);
  const saved=JSON.parse([...entries.values()][0]!);assert.equal(saved.form.thinking,'Twice four is eight.');assert.deepEqual(saved.form.selection.selected,[0]);
 }finally{await act(async()=>root?.unmount());}
});
