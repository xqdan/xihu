'use strict';
const fs=require('fs'),assert=require('assert'),crypto=require('crypto');
const A=require('../src/search/k3_architecture_search.js'),S=require('../src/search/k3_b1_1000_search.js');
const close=(a,b)=>assert(Math.abs(a-b)<1e-7*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const d=JSON.parse(fs.readFileSync('data/search/k3_b1_1000_results.json','utf8'));
assert.equal(d.batch,1);assert.equal(d.target,1000);assert.equal(d.tp,32);assert.equal(d.context,1048576);
const hash=crypto.createHash('sha256');for(const f of ['src/search/k3_b1_1000_search.js','src/search/k3_architecture_search.js','src/simulation/k3_operator_sram_sim.js','src/core/design_engine.js','data/search/k3_architecture_search_results.json'])hash.update(fs.readFileSync(f));assert.equal(d.inputHash,hash.digest('hex'));
let tests=0;
for(const stage of [d.original,d.extended]){
 assert.equal(stage.qualified,stage.rows.filter(r=>r.tps>=1000).length);
 close(stage.best.tps,Math.max(...stage.rows.map(r=>r.tps)));
 for(const r of stage.rows){
  assert(A.physical(r.x).feasible);assert(r.feasible);
  for(const[k,v]of Object.entries(r.x))assert(stage.space[k].includes(v),k);
  close(r.rawUs,r.computeUs+r.commUs+r.waitUs);
  close(r.rawUs,Object.values(r.services).reduce((a,b)=>a+b,0)+r.waitUs);
  close(r.e2eUs,r.rawUs*1.17);close(r.tps,1e6/r.e2eUs);close(r.tokensPerSecond,r.tps);
  assert(r.peakReservedMiB<=r.sramMiB+1e-7);
  assert(r.localL<=r.x.lMiB*.85+1e-7);assert(r.localH<=r.x.hMiB*.85+1e-7);
  assert(r.backingGB<=128);assert(r.rawUs+1e-6>=(r.readBytes+r.writeBytes)/(r.dmaTBs*1e6));tests++;
 }
 const replay=S.evaluate(stage.best.x,true);close(replay.tps,stage.best.tps);assert.equal(replay.layers.length,93);
 assert.equal(replay.layers.filter(l=>l.kind==='Softmax MLA').length,24);
}
// Explicit counterexample: a B1-feasible design must NOT be rejected merely
// because the same hardware / tile cannot accommodate B32.
const x={...A.BASE,hMiB:1,kvTile:2048};assert(S.evaluate(x).feasible);assert(!A.mappedPlan(x,32).feasible);
const z=d.diagnostics;
assert.equal(z.collectives,510);assert.equal(z.steps,4520);
close(z.networkStartup,632.8);close(z.dieStartup,76.5);close(z.floorUs,709.3);
close(z.targetRawUs,1000/1.17);assert(d.extended.best.rawUs>=z.floorUs);
close(z.latencySweeps[0].tps,d.extended.best.tps);
const html=fs.readFileSync('reports/search/k3_b1_1000_report.html','utf8');
assert(html.includes('1000 TPS'));assert(html.includes('viewBox="0 0 1100 540"'));assert(!/NaN|undefined|Infinity/.test(html));
assert.equal((html.match(/<svg /g)||[]).length,2);
console.log('PASS',tests,'B1 designs: physics, single-objective ranking, time/bytes/SRAM constraints, B32 exclusion, replay, communication floor and static HTML.');
