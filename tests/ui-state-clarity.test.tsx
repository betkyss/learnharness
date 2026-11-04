import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DispatchCard } from "../components/artifacts/dispatch-card";
import { JobsContext } from "../components/jobs-context";
import { ProbeDoneCard } from "../components/artifacts/probe-done-card";
import type { JobRecord } from "../src/core";
(globalThis as Record<string,unknown>).React=React;
test("native abort delivery is cancelled while actual failure remains failed",()=>{
 const job:JobRecord={id:"j",kind:"research",chatId:"c",toolCallId:"t",status:"error",activity:"aborted",createdAt:"",updatedAt:"",delivery:{kind:"abort",status:"delivered"}};
 const render=(j:JobRecord)=>renderToStaticMarkup(<JobsContext.Provider value={[j]}><DispatchCard toolCallId="t" kind="research"/></JobsContext.Provider>);
 assert.match(render(job),/cancelled/);assert.doesNotMatch(render(job),/failed/);
 assert.match(render({...job,activity:"failed",delivery:{kind:"result",status:"delivered"}}),/failed/);
});
test("assessment writing and refusal do not claim conclusion",()=>{
 const writing=renderToStaticMarkup(<ProbeDoneCard part={{state:"input-streaming"}}/>);
 assert.match(writing,/Writing your assessment/);assert.doesNotMatch(writing,/concluded/);
 const refused=renderToStaticMarkup(<ProbeDoneCard part={{state:"output-available",output:{ok:false,error:"fixture diagnostic"}}}/>);
 assert.match(refused,/Assessment not accepted/);assert.match(refused,/<details/);assert.doesNotMatch(refused,/retried|concluded/);
});
