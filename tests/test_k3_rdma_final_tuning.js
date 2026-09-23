'use strict';
const fs=require('fs'),assert=require('assert'),O=require('../src/rdma/k3_rdma_final_tuning_model.js');
const d=require('../data/rdma/k3_rdma_final_tuning_results.json'),b=d.search.best;
assert.equal(d.target,1000);assert(b.feasible);assert.equal(b.tps,Math.max(...d.search.rows.map(r=>r.tps)));assert(b.peakReservedMiB<=b.sramMiB+1e-7);
assert(!/NaN|undefined|Infinity/.test(fs.readFileSync('reports/rdma/k3_rdma_final_tuning_report.html','utf8')));
// Stored result must replay exactly from the current model.
const r=O.evaluate(b.x);assert(Math.abs(r.tps-b.tps)<1e-7);assert(Math.abs(r.p.dieArea-b.p.dieArea)<1e-9);assert(Math.abs(r.p.cardPower-b.p.cardPower)<1e-9);
// Model hygiene: OPT literal has no duplicate keys (a duplicate silently overrides the earlier value).
const src=fs.readFileSync('src/rdma/k3_rdma_final_tuning_model.js','utf8');
const optBlock=src.slice(src.indexOf('const OPT={'),src.indexOf('};',src.indexOf('const OPT={')));
const keys=[...optBlock.matchAll(/(?:^|[,{\s])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(m=>m[1]);
const dup=keys.filter((k,i)=>keys.indexOf(k)!==i);assert.deepStrictEqual(dup,[],'duplicate OPT keys: '+dup.join(','));
// Every empirical factor is named in GAIN; the stored result records the same table.
assert(Object.keys(O.GAIN).length>=20);assert.deepStrictEqual(d.gainFactors,O.GAIN);
// Launch batching is applied exactly once: launch service equals launchScale x the unbatched launch budget.
const A=require('../src/search/k3_architecture_search.js');
const plan=A.mappedPlan(b.x,1);const nonComm=plan.plan.ops.filter(o=>o.unit!=='COMM').length;
assert(Math.abs(b.services.launch-nonComm*A.TECH.launchUs*O.OPT.launchScale)<1e-9,'launch service must equal launchScale x nonCOMM ops x launchUs');
// Shared-SRAM port scaling is charged: area and power exceed the unscaled physical() result, and limits still hold.
assert(O.OPT.chargeSharedPortCost===true);const p0=A.physical(b.x);
assert(b.p.dieArea>p0.dieArea&&b.p.diePower>p0.diePower&&b.p.cardPower>p0.cardPower,'shared-port cost must be charged');
assert(b.p.dieArea<=A.LIMITS.dieArea&&b.p.diePower<=A.LIMITS.diePower&&b.p.cardPower<=A.LIMITS.cardPower);
assert(b.localPortModel&&b.localPortModel.chargedCost&&b.localPortModel.chargedCost.powerWPerDie>0);
console.log('PASS final tuning',b.tps.toFixed(2),'TPS',b.rawUs.toFixed(2),'us raw; GAIN table, single launch batching and charged shared-port cost verified');
