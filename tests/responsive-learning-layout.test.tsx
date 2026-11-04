import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { dockHeightBudget } from '../components/dock-height';
import { fitVisibleGraph } from '../components/graph-canvas';
import { teaserText } from '../components/question-dock';
import { GraphCostPanel } from '../components/graph-view';
import { SettingsRow } from '../components/settings/controls';
import { PracticeDock } from '../components/practice-dock';
import type { GraphCostSummary } from '../src/core';

it('uses a single form scroll at keyboard-like heights despite a small answer footer', () => {
 for (const columnHeight of [180, 240, 320, 420, 500]) {
  const budget = dockHeightBudget({columnHeight, outsideHeight:32,beforeShellHeight:0,shellBorderHeight:2,contentHeight:2200,questionHeight:2100,questionPaddingHeight:12});
  assert.equal(budget.scrollWholeContent,true);
  assert.ok(budget.viewportMaxHeight <= columnHeight-32);
 }
 assert.equal(dockHeightBudget({columnHeight:780,outsideHeight:60,beforeShellHeight:0,shellBorderHeight:2,contentHeight:600,questionHeight:450,questionPaddingHeight:12}).scrollWholeContent,false);
});
it('offers a readable Fit with pan when actual available height cannot contain a large graph',()=>{
 const box={minX:-600,maxX:600,minY:-400,maxY:400};
 const camera=fitVisibleGraph(box,390,420,{top:122,bottom:130},.35);
 assert.equal(camera.k,.35);
 assert.equal(camera.x,195);
 assert.equal(camera.y,206);
});
it('keeps prices inside the shell width, preserving full amounts and unknown pricing',()=>{
 const tokens={inputTokens:12345,outputTokens:678,cacheReadTokens:0,cacheWriteTokens:0,reasoningTokens:0};
 const stage={runs:2,dollars:12345.6789,unpricedRuns:1,tokens};
 const html=renderToStaticMarkup(<GraphCostPanel costs={{totalDollars:12345.6789,unpricedRuns:1,stages:{extraction:stage,audit:stage},runs:[]} as GraphCostSummary}/>);
 assert.match(html,/w-full min-w-0 max-w-full/);
 assert.doesNotMatch(html,/w-80/);
 assert.match(html,/12345/);
 assert.match(html,/unpriced/);
});
it('keeps settings label and controls as complete wrapping units',()=>{
 const html=renderToStaticMarkup(<SettingsRow label="Strong" hint="The teacher and prober"><button>Model</button><button>Thinking</button></SettingsRow>);
 assert.match(html,/settings-label/); assert.match(html,/flex-wrap/); assert.match(html,/settings-control/);
});
it('renders the practice problem preview without raw inline math delimiters',()=>{
 assert.equal(teaserText('Given $a=2m$ and $b=2n$.'),'Given a=2m and b=2n.');
 const html=renderToStaticMarkup(<PracticeDock problemCallId="p" input={{statement:'Given $a=2m$ and $b=2n$.'}} expanded={false} onExpand={()=>{}} onSubmit={()=>{}}/>);
 assert.doesNotMatch(html,/\$/); assert.match(html,/a=2m/);
});

it('uses a neutral cancellation icon for native aborted delivery, preserving successful dispatch icons',async()=>{
 const { JobsContext }=await import('../components/jobs-context');
 const { DispatchCard }=await import('../components/artifacts/dispatch-card');
 const job={id:'j',toolCallId:'t',chatId:'c',kind:'research',status:'error',activity:'aborted',createdAt:'2026-11-04',updatedAt:'2026-11-04'} as import('../src/core').JobRecord;
 const html=renderToStaticMarkup(<JobsContext.Provider value={[job]}><DispatchCard toolCallId="t" kind="research"/></JobsContext.Provider>);
 assert.match(html,/cancelled/);assert.match(html,/lucide-circle-x/);assert.doesNotMatch(html,/lucide-check/);
});
