import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionModel } from "../components/session-core";
import { pendingQuestionOf, type LhMessage } from "../src/core";
import { readQuestionDraft } from "../components/question-draft-storage";

const message = (id: string): LhMessage => ({ id, role: "assistant", content: [{type:"toolCall",id,name:"quiz",arguments:{question:"Even?",options:[{label:"2",value:"two"},{label:"3",value:"three"}],correctAnswer:"two",explanation:"Even."}}],stopReason:"toolUse",timestamp:1 } as unknown as LhMessage);
test("tab drafts restore all fields after a new session model, without submitting, and clean resolved/stale keys", () => {
 const entries = new Map<string,string>();
 const previous = Object.getOwnPropertyDescriptor(globalThis,"window");
 Object.defineProperty(globalThis,"window",{configurable:true,value:{sessionStorage:{getItem:(k:string)=>entries.get(k)??null,setItem:(k:string,v:string)=>entries.set(k,v),removeItem:(k:string)=>entries.delete(k)}}});
 try {
  let submissions=0;const make=(messages:LhMessage[])=>new SessionModel({chatId:"draft-chat",initialMessages:messages,fetch:async()=>{submissions++;throw Error("No submit");}});
  const messages=[message("q1")], key=pendingQuestionOf(messages)!.key;
  const form={selection:{selected:new Set([0]),otherSelected:true,dontKnow:false},thinking:"Reason",other:"Other",text:"Text",confidenceIndex:2};
  make(messages).saveQuestionDraft(key,{form,readingThinking:"Reading"});
  assert.deepEqual(make(messages).questionDraft(key),{form,readingThinking:"Reading"});
  assert.equal(submissions,0);
  const next=make([message("q2")]);assert.equal(next.questionDraft(pendingQuestionOf([message("q2")])!.key),undefined);assert.equal(entries.size,0);
  const model=make(messages);model.saveQuestionDraft(key,{form});model.setMessages([]);assert.equal(entries.size,0);
  entries.set("lh.question-draft.v1:draft-chat","{broken");assert.equal(readQuestionDraft("draft-chat",key),undefined);
  entries.set("lh.question-draft.v1:draft-chat",JSON.stringify({key,form:{selection:{selected:"invalid"}}}));assert.equal(readQuestionDraft("draft-chat",key)?.form,undefined);
  Object.defineProperty(globalThis,"window",{configurable:true,get(){throw Error("Blocked");}});assert.equal(readQuestionDraft("draft-chat",key),undefined);
 } finally {if(previous)Object.defineProperty(globalThis,"window",previous);else Reflect.deleteProperty(globalThis,"window");}
});
