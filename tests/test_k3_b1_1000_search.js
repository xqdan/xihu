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
// Collective counting basis. The published point counts on the reference page's
// basis (393), not the earlier repo basis (510). Pinned in both directions so a
// silent reversion is caught; see ADR-0004 and SW-05. `steps` is NOT rebuilt
// here: it depends on per-operator naming, so reconstructing it from a name
// rule duplicates the model instead of checking it. It is used only as an input
// to the self-consistency relations below.
assert.equal(z.collectives,393);
const zRepo=A.mappedPlan(d.extended.best.x,1,A.physical(d.extended.best.x),'repo-510').plan.ops.filter(o=>o.unit==='COMM');
assert.equal(zRepo.length,510,'repo basis must still total 510');
close(z.networkStartup,z.steps*A.TECH.rdmaStepUs);
close(z.dieStartup,z.collectives*6*A.TECH.ucieHopUs);
close(z.floorUs,z.networkStartup+z.dieStartup);
close(z.targetRawUs,1000/1.17);assert(d.extended.best.rawUs>=z.floorUs);
close(z.latencySweeps[0].tps,d.extended.best.tps);
const html=fs.readFileSync('reports/search/k3_b1_1000_report.html','utf8');
assert(html.includes('1000 TPS'));assert(html.includes('viewBox="0 0 1100 540"'));assert(!/NaN|undefined|Infinity/.test(html));
assert.equal((html.match(/<svg /g)||[]).length,2);
console.log('PASS',tests,'B1 designs: physics, single-objective ranking, time/bytes/SRAM constraints, B32 exclusion, replay, communication floor and static HTML.');
