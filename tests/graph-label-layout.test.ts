import assert from "node:assert/strict";
import { test } from "node:test";
import { nonOverlappingLabels } from "../components/graph-label-layout";
test("Fit labels remain inside measured usable bounds and prioritize interaction",()=>{
 const boxes=Array.from({length:96},(_,i)=>({id:String(i),left:(i%8)*42,top:150+Math.floor(i/8)*10,right:(i%8)*42+95,bottom:176+Math.floor(i/8)*10,priority:i===4?1:0}));
 const chosen=nonOverlappingLabels(boxes,{left:8,top:148,right:382,bottom:260});
 assert.ok(chosen.size>1);assert.ok(chosen.has("4"));
 const selected=boxes.filter(x=>chosen.has(x.id));
 for(const a of selected){assert.ok(a.left>=8&&a.bottom<=260);for(const b of selected)if(a!==b)assert.ok(a.right+8<=b.left||b.right+8<=a.left||a.bottom+6<=b.top||b.bottom+6<=a.top);}
});
