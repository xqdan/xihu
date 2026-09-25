'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm'),crypto=require('crypto');
const {BASE,SPACE,LIMITS,TECH,physical,mappedPlan,evaluate,dominates,pareto,rng}=require('../../integration/detailed/k3_architecture_search.js');
const {simulate,MiB}=require('../../integration/detailed/k3_operator_sram_sim.js');
const close=(a,b,tol=1e-7)=>assert(Math.abs(a-b)<=tol*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const p=physical(BASE);
assert(p.feasible);close(p.lTF,32.768);close(p.hTF,262.144);close(p.totalMiB,96);
close(p.uciePortGB,409.6);close(p.dieCutGB,819.2);close(p.rdmaCardGB,336);
close(p.dieArea,Object.values(p.area).reduce((a,b)=>a+b,0));
close(p.cardPower,8*p.diePower+p.mcPower+80);
const fast=physical({...BASE,ghz:1.2});close(fast.lTF,p.lTF*1.2);assert(fast.power.matrix>p.power.matrix*1.2);
assert(!physical({...BASE,nL:10000}).feasible);
assert(!mappedPlan({...BASE,hMiB:.001},32).feasible,'local H SRAM cannot borrow global SRAM');
assert(!mappedPlan({...BASE,sharedMiB:.001},32).feasible,'shared SRAM cannot borrow local SRAM');
assert(dominates({f1:3,f2:2},{f1:2,f2:2}));assert(!dominates({f1:3,f2:1},{f1:2,f2:2}));
assert.deepEqual(pareto([{f1:1,f2:1},{f1:2,f2:1},{f1:1,f2:2}]),[{f1:1,f2:2},{f1:2,f2:1}]);
let a=rng(4),b=rng(4);for(let i=0;i<100;i++)close(a(),b());
const data=JSON.parse(fs.readFileSync('out/search/k3_architecture_search_results.json','utf8'));
const hash=crypto.createHash('sha256').update(fs.readFileSync('integration/detailed/k3_architecture_search.js')).update(fs.readFileSync('integration/detailed/k3_operator_sram_sim.js')).update(fs.readFileSync('teams/model/src/design_engine.js')).digest('hex');
assert.equal(hash,data.inputHash);
assert(data.rows.length>=data.options.samples+data.options.generations*data.options.offspring);
assert.equal(data.history.at(-1).evaluated,data.rows.length);
assert.equal(data.attempted,data.physicalReject+data.mappingReject+data.rows.length);
assert.deepEqual(pareto(data.rows).map(r=>r.id),data.frontIds);
const ids=Object.values(data.selected);
close(data.rows.find(r=>r.id===data.selected.best1).f1,Math.max(...data.rows.map(r=>r.f1)));
close(data.rows.find(r=>r.id===data.selected.best2).f2,Math.max(...data.rows.map(r=>r.f2)));
const max1=Math.max(...data.rows.map(r=>r.f1)),max2=Math.max(...data.rows.map(r=>r.f2));
const bal=data.rows.find(r=>r.id===data.selected.balanced);
close(Math.min(bal.f1/max1,bal.f2/max2),Math.max(...data.rows.map(r=>Math.min(r.f1/max1,r.f2/max2))));
let timelineTests=0;
for(const row of data.rows){
 assert(row.feasible);const p=physical(row.x);assert(p.feasible);
 for(const k of Object.keys(SPACE))assert(SPACE[k].includes(row.x[k]),k);
 for(const B of [1,32]){const r=row.runs[B];
  assert(r.feasible&&Number.isFinite(r.tps)&&r.tps>0);
  assert(r.peakReservedMiB<=r.sramMiB+1e-7);
  assert(r.peakLiveMiB<=r.peakReservedMiB+1e-7);
  close(r.rawUs,r.computeUs+r.commUs+r.waitUs);
  close(r.rawUs,Object.values(r.services).reduce((a,b)=>a+b,0)+r.waitUs);
  close(r.tokensPerSecond,B*r.tps);
  close(r.tps,1e6/(r.rawUs*1.17));
  close(r.sharedUsable,8*row.x.sharedMiB*LIMITS.usable);
  close(r.sramMiB,r.sharedUsable*row.x.windowFraction);
  assert(r.hLocalMiB<=row.x.hMiB*LIMITS.usable+1e-8);
  assert(r.lLocalMiB<=row.x.lMiB*LIMITS.usable+1e-8);
  assert(r.backingGB<=128);
  assert(r.dmaEffective<=r.dmaPeak);
  assert(r.rawUs+1e-6>=(r.readBytes+r.writeBytes)/(r.dmaEffective*1e6));
  if(row.x.depth===0)close(r.predBytes,0);
  timelineTests++;
 }
 close(row.f1,row.runs[1].tps);close(row.f2,row.runs[32].tokensPerSecond);
}
for(const id of new Set(ids)){
 const row=data.rows.find(r=>r.id===id),r=evaluate(row.x);
 close(r.f1,row.f1);close(r.f2,row.f2);
 for(const B of [1,32]){
  const m=mappedPlan(row.x,B),p=m.plan,expectedKV=p.jobs.filter(j=>j.kind==='kv').reduce((s,j)=>s+j.bytes,0);
  const kvSharedReads=p.ops.filter(o=>o.inputs.some(id=>p.jobs[id].kind==='kv')).reduce((s,o)=>s+(o.mapping.sharedR||0),0);
  close(kvSharedReads,expectedKV); // KV is loaded once per full batch/context tile.
  assert.equal(p.layers.length,93);
  assert.equal(p.layers.filter(l=>l.kind==='Softmax MLA').length,24);
  for(const o of p.ops){assert(o.duration>0&&Number.isFinite(o.duration));
   assert(o.duration+1e-6>=o.read/(p.c.sramReadTBs*1e6));
   assert(o.duration+1e-6>=o.write/(p.c.sramWriteTBs*1e6));
   assert(o.duration+1e-6>=o.linkBytes/(p.c.fabricTBs*1e6));
   if(o.unit!=='COMM'){
    assert(o.duration+1e-6>=o.mapping.localReadBytes/(o.mapping.localReadTBs*1e6));
    assert(o.duration+1e-6>=o.mapping.localWriteBytes/(o.mapping.localWriteTBs*1e6));
   }
  }
  assert.equal(row.runs[B].layers.length,93);
 }
}
// Runtime smoke test for report controls; no external browser dependency.
const html=fs.readFileSync('out/search/k3_architecture_search_report.html','utf8'),els={};
for(const m of html.matchAll(/id="([^"]+)"/g))els[m[1]]={innerHTML:'',textContent:'',value:'',handlers:{},addEventListener(k,f){this.handlers[k]=f;}};
els['report-data'].textContent=html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
els.choice.value=String(data.selected.balanced);els.batch.value='32';els.layer.value='4';
const script=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
vm.runInNewContext(script,{document:{getElementById(id){assert(els[id],id);return els[id];}}});
for(const id of new Set([...ids,...data.frontIds]))for(const B of ['1','32']){
 els.choice.value=String(id);els.batch.value=B;els.choice.handlers.change();
 for(let l=0;l<93;l++){els.layer.value=String(l);els.layer.handlers.change();}
 for(const [k,e]of Object.entries(els))if(k!=='report-data')assert(!/NaN|undefined|Infinity/.test(e.innerHTML+e.textContent),k);
}
assert(els.dieDiagram.innerHTML.includes('TMA'));
assert(els.cardDiagram.innerHTML.includes('RDMA'));
console.log('PASS physical arithmetic, Pareto/seed, constraints,',timelineTests,'saved full-step time/byte/capacity invariants; selected cases recomputed; HTML controls/93 layers validated.');
