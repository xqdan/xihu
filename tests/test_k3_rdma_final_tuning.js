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
// Epilogue-fused ops have no launch of their own.
const mm0=O.mapped(b.x);const launched=mm0.plan.ops.filter(o=>o.unit!=='COMM'&&!o.mapping.fused).length;
assert(Math.abs(b.services.launch-launched*A.TECH.launchUs*O.OPT.launchScale)<1e-9,'launch service must equal launchScale x launched nonCOMM ops x launchUs');
// The time ledger reconciles: services (including assumedGain, tauFloor, tmaFill
// and the negative commOverlap/tmaHidden lines) + DMA wait = raw
// = compute - tmaHidden + comm + wait - overlap.
const booked=Object.values(b.services).reduce((a,v)=>a+v,0);
const mm=O.mapped(b.x);
assert(Math.abs(booked+b.waitUs-b.rawUs)<1e-6,`services + wait must equal raw (${booked+b.waitUs} vs ${b.rawUs})`);
assert(Math.abs(b.rawUs-(b.computeUs-b.tmaHiddenUs+b.commUs+b.waitUs-b.overlapUs))<1e-6,'raw must equal compute - tmaHidden + comm + wait - overlap');
assert(Math.abs(b.services.commOverlap+b.overlapUs)<1e-12,'overlap must be booked as a negative service line');
assert(Math.abs(b.services.tmaHidden+b.tmaHiddenUs)<1e-12,'hidden TMA must be booked as a negative service line');
assert(Math.abs(booked-b.services.commOverlap-b.services.tmaHidden-(b.computeUs+b.commUs))<1e-6,'services before overlap and hidden TMA must equal compute + comm');
// Compute/collective overlap: only the shared experts (data-independent of the
// routed path) may run under a collective, so overlap is bounded by their time.
assert.equal(O.OPT.commOverlap,true);
const marked=mm.plan.ops.filter(o=>o.overlapComm);
assert(marked.length>0&&marked.every(o=>/^Shared (gate\/up|SiLU x up|down)$/.test(o.name)),'only shared-expert ops may overlap a collective');
const sharedUs=marked.reduce((a,o)=>a+o.duration,0);
assert(b.overlapUs>0&&b.overlapUs<=sharedUs+1e-9,`overlap ${b.overlapUs} must be positive and at most the shared-expert time ${sharedUs}`);
{const saved=[O.OPT.commOverlap,O.OPT.tmaLane];O.OPT.commOverlap=false;O.OPT.tmaLane=false;const s0=O.evaluate(b.x);[O.OPT.commOverlap,O.OPT.tmaLane]=saved;
 assert.equal(s0.overlapUs,0);assert.equal(s0.tmaHiddenUs,0);assert(Math.abs(s0.rawUs-(s0.computeUs+s0.commUs+s0.waitUs))<1e-6,'serial mode must keep raw = compute + comm + wait');
 assert(s0.rawUs>b.rawUs,'overlap must shorten raw');}
// Separate TMA lanes: the fill is split out of the op, not added or removed.
// Only DMA-sourced shared->local loads (weights, experts, KV, state) move to the
// lane; the lane-off op durations equal the lane-on body + fill.
assert.equal(O.OPT.tmaLane,true);
const filled=mm.plan.ops.filter(o=>o.tma);
assert(filled.length>0&&filled.every(o=>o.unit!=='COMM'&&o.inputs.some(id=>mm.plan.jobs[id].kind!=='write')),'only ops with DMA-sourced inputs get a TMA fill');
assert(Math.abs(b.services.tmaFill-b.tmaFillUs)<1e-6,'every booked fill must be issued on a lane');
assert(b.tmaHiddenUs>0&&b.tmaHiddenUs<=b.tmaFillUs+1e-9&&b.tmaExposedUs>=-1e-12,'hidden TMA must be positive and at most the fill time');
{const saved=O.OPT.tmaLane;O.OPT.tmaLane=false;const m0=O.mapped(b.x),s1=O.evaluate(b.x);O.OPT.tmaLane=saved;
 assert(Math.abs(m0.plan.ops.reduce((a,o)=>a+o.duration,0)-mm.plan.ops.reduce((a,o)=>a+o.duration,0))<1e-6,'splitting the fill must not change total op service');
 assert.equal(s1.tmaFillUs,0);assert(s1.rawUs>b.rawUs,'TMA lanes must shorten raw at the published point');}
// Cross-layer KV prefetch and DMA preemption: each shortens raw at the published
// point, and preemption parks jobs without changing bytes read.
assert.equal(O.OPT.kvPrefetch,'window');assert.equal(O.OPT.dmaPreempt,true);assert(b.dmaPreemptions>0);
{const saved=[O.OPT.kvPrefetch,O.OPT.dmaPreempt];
 O.OPT.kvPrefetch='layer';const k0=O.evaluate(b.x);O.OPT.kvPrefetch=saved[0];
 O.OPT.dmaPreempt=false;const p0=O.evaluate(b.x);O.OPT.dmaPreempt=saved[1];
 assert(k0.rawUs>b.rawUs,'cross-layer KV prefetch must shorten raw');
 assert(p0.rawUs>b.rawUs,'DMA preemption must shorten raw');
 assert(Math.abs(p0.readBytes-b.readBytes)<1,'preemption must not change bytes read');}
// Decision 2026-09-25: all GAIN factors are neutral, so no net discount remains.
assert(Object.values(O.GAIN).every(v=>v===1),'all GAIN factors must be 1');
assert(Math.abs(b.services.assumedGain)<1e-9,'with GAIN=1 there must be no assumed discount');
// Decision 2026-09-25: every collective costs at least the spec tau (ADR-0004).
assert.equal(O.OPT.tauUs,1.15);
const commOps=mm.plan.ops.filter(o=>o.unit==='COMM');
assert(commOps.every(o=>o.duration>=O.OPT.tauUs-1e-12),'every collective must cost at least tauUs');
assert(b.commUs>=b.collectiveCount*O.OPT.tauUs-1e-6,'comm time must be at least count x tau');
// Dead knobs stay dead: utilization is fixed by mappedPlan(). The prefetch
// lookahead is the searched x.depth (no fixed OPT.overlapDepth override).
assert(!('matrixUtil' in O.OPT)&&!('vectorUtil' in O.OPT),'matrix/vector utilization is not an OPT knob');
assert(!('overlapDepth' in O.OPT),'prefetch depth is searched as x.depth');
assert.equal(mm0.plan.c.depth,b.x.depth);assert.deepStrictEqual(d.search.space.depth,[1,2,3,4]);
assert(O.evaluate({...b.x,depth:1}).rawUs>b.rawUs,'x.depth must reach the simulator');
// Attention and small-op mapping (2026-09-25).
assert.equal(O.OPT.pvMerge,'layer');assert.equal(O.OPT.softmaxFusion,true);assert.equal(O.OPT.epilogueFusion,true);
{// pvMerge=layer: exactly one merging PV op per (layer, head tile), always the last context tile.
 const pv=mm0.plan.ops.filter(o=>o.name.startsWith('PV')),merging=pv.filter(o=>o.mapping.sharedW>0);
 const groups=new Set(pv.map(o=>o.layer+'|'+o.detail.split(';')[1]));
 assert.equal(merging.length,groups.size,'one PV merge per layer and head tile');
 for(const o of merging)assert(!pv.some(q=>q.layer===o.layer&&q.detail.split(';')[1]===o.detail.split(';')[1]&&q.id>o.id),'the merge must sit on the last context tile');
 assert(pv.filter(o=>!o.mapping.sharedW).every(o=>o.timing.reduce===0&&o.timing.dieLink===0),'non-final tiles keep their partials local');}
{// Softmax fusion keeps at least one score block of vector time exposed.
 const sm=mm0.plan.ops.filter(o=>o.name==='Online softmax'),x=b.x,blocks=Math.ceil(Math.ceil(x.kvTile/(A.LIMITS.dies*x.nH))/x.hCols);
 const saved=O.OPT.softmaxFusion;O.OPT.softmaxFusion=false;const un=O.mapped(b.x).plan.ops.filter(o=>o.name==='Online softmax');O.OPT.softmaxFusion=saved;
 sm.forEach((o,i)=>assert(o.timing.kernel>=un[i].timing.kernel/blocks-1e-12&&o.timing.kernel<un[i].timing.kernel,'fused softmax exposes one block'));}
{// Epilogue fusion: only listed elementwise ops, never directly after a collective; vector time kept.
 const fused=mm0.plan.ops.filter(o=>o.mapping&&o.mapping.fused);
 assert(fused.length>0&&fused.every(o=>A.EPILOGUE_OPS.test(o.name)&&mm0.plan.ops[o.id-1].unit!=='COMM'&&o.timing.launch===0));
 assert(!fused.some(o=>/residual add|all-gather|sampling/i.test(o.name)),'residual adds after a collective and counting-basis local ops are not fused');}
{// Each mapping change shortens raw at the published point and moves no bytes.
 for(const f of [{pvMerge:'tile'},{softmaxFusion:false},{epilogueFusion:false}]){const saved={...O.OPT};Object.assign(O.OPT,f);const r=O.evaluate(b.x);Object.assign(O.OPT,saved);
  assert(r.rawUs>b.rawUs,'mapping change must shorten raw: '+JSON.stringify(f));
  if(!f.pvMerge)assert(Math.abs(r.readBytes-b.readBytes)<1,'fusion must not change DMA bytes');}}
// FP8 KV cache (2026-09-25): FlashMLA layout, BF16 compute with in-kernel dequant.
assert.equal(O.OPT.kvCache,'fp8');assert.equal(mm0.plan.kvBytesPerToken,512+512/128*4+64*2);
{const kvJobs=mm0.plan.jobs.filter(j=>j.kind==='kv');
 assert(kvJobs.length>0&&kvJobs.every(j=>Math.abs(j.bytes/j.dequant*512-656)<1e-9),'KV tiles carry 656 B/token and dequant the 512-wide latent');
 // Dequant runs on the H vector lanes inside QK/PV: the kernel is at least the dequant time.
 const x=b.x,qk=mm0.plan.ops.find(o=>/^QK/.test(o.name)),j=mm0.plan.jobs[qk.inputs[0]];
 assert(qk.timing.kernel>=j.dequant/(A.LIMITS.dies*x.nH*x.vectorLanes*A.TECH.unpackParamsPerLaneCycle*x.ghz*1000)-1e-12);
 // Same candidate on BF16 KV: either the local KV staging no longer fits or raw is longer and more bytes move.
 const saved=O.OPT.kvCache;O.OPT.kvCache='bf16';const r=O.evaluate(b.x),r16=O.evaluate({...b.x,kvTile:16384});O.OPT.kvCache=saved;const f16=O.evaluate({...b.x,kvTile:16384});
 assert(!r.feasible||r.rawUs>b.rawUs,'FP8 KV must not lose to BF16 KV at the published point');
 assert(r16.rawUs>f16.rawUs&&r16.readBytes>f16.readBytes,'FP8 KV must shorten raw and cut DMA bytes at a common KV tile');}
// TMA fills pinned for a later op are cancelled rather than deadlocking the head op
// (large FP8 KV tile with a half window used to deadlock); the published point needs none.
assert.equal(b.tmaCancels,0);
{const r=O.evaluate({...b.x,kvTile:32768,windowFraction:.5,reduceLanes:2048});assert(r.feasible===false||r.tmaCancels>0||r.tps>0);}
// Collective counting basis. The published point counts on the reference page's
// basis (393), not the earlier repo basis (510). This is a COUNTING choice, not
// a physical optimization: two of the three withheld groups stay in the DAG as
// local ops, and the shared-output reduction is folded into the Wup reduction.
// It must not be reported as a speedup. See SW-05 and OPEN_ISSUES B-007.
// A.mappedPlan() carries no protocol table (only O.mapped() does), so count COMM ops in the plan.
const ops0=x=>A.mappedPlan(x,1,A.physical(x),{countBasis:'reference-393',kvCache:O.OPT.kvCache}).plan.ops;
const comm=(x,basis)=>A.mappedPlan(x,1,A.physical(x),{countBasis:basis,kvCache:O.OPT.kvCache}).plan.ops.filter(o=>o.unit==='COMM');
const count=x=>comm(x,'reference-393').length;
const repoCount=x=>comm(x,'repo-510').length;
assert.equal(b.collectiveCount,count(b.x),'stored collectiveCount must match a fresh replay');
assert.equal(b.collectiveCount,393,`reference basis must total 393, got ${b.collectiveCount}`);
assert.equal(repoCount(b.x),510,`repo basis must still total 510, got ${repoCount(b.x)}`);
// The folded name carries the shared reduction; the standalone one is gone.
// It must follow every shared-expert op of its layer, or the shared partial sums
// would never be reduced (accepted basis, B-007).
for(const l of [1,4,92]){const ls=ops0(b.x).filter(o=>o.layer===l),fold=ls.findIndex(o=>o.name==='Wup + Shared output all-reduce'),lastShared=ls.map(o=>o.name).lastIndexOf('Shared down');
  assert(fold>lastShared&&lastShared>=0,`layer ${l}: folded reduction must follow the shared experts`);}
const named=(x,n)=>comm(x,'reference-393').filter(o=>o.name===n).length;
assert.equal(named(b.x,'Wup + Shared output all-reduce'),92,'folded Wup + Shared reduction must appear 92 times');
assert.equal(named(b.x,'Shared output all-reduce'),0,'the standalone shared reduction must not be issued on the reference basis');
assert.equal(named(b.x,'Q / new-KV all-gather'),0,'the Q/new-KV all-gather must not be counted on the reference basis');
assert.equal(named(b.x,'Distributed sampling candidates'),0,'the sampling broadcast must not be counted on the reference basis');
// The withheld groups (Q/new-KV all-gather, sampling) become local ops rather
// than disappearing; only the 92 folded standalone shared reductions are removed.
assert.equal(count(b.x),393);
const ops=(x,basis)=>A.mappedPlan(x,1,A.physical(x),{countBasis:basis,kvCache:O.OPT.kvCache}).plan.ops;
const ref=ops(b.x,'reference-393'),repo=ops(b.x,'repo-510');
assert.equal(repo.length-ref.length,92,'switching basis may only remove the 92 folded shared reductions');
for(const n of ['Q / new-KV all-gather','Distributed sampling candidates'])
  assert.equal(ref.filter(o=>o.name===n).length,repo.filter(o=>o.name===n).length,n+' must stay in the DAG as a local op');
// tau basis: the analytic ceiling at the spec per-collective latency is
// recomputed from the spec block and must bound the published point (it takes
// DMA wait as zero, so it can never be below the simulated TPS).
const spec=JSON.parse(fs.readFileSync('docs/design/spec/k3_mc_baseline.json','utf8'));
assert(spec.tauBasis&&spec.collectiveCount,'spec must carry the tau and count-basis blocks');
assert.equal(spec.collectiveCount.total,b.collectiveCount);
const ceiling=N=>1e6/((b.computeUs-b.tmaHiddenUs+N*spec.tauBasis.specNsPerCollective/1000-b.overlapUs)*(b.e2eUs/b.rawUs));
assert(Math.abs(spec.tauBasis.ceilingTpsByCount[393]-ceiling(393))<1e-6,'spec ceiling table must recompute');
assert(ceiling(393)>=b.tps-1e-9,'the analytic ceiling (DMA wait taken as zero) bounds the published point');
// Shared-SRAM port scaling is charged: area and power exceed the unscaled physical() result, and limits still hold.
assert(O.OPT.chargeSharedPortCost===true);const p0=A.physical(b.x);
assert(b.p.dieArea>p0.dieArea&&b.p.diePower>p0.diePower&&b.p.cardPower>p0.cardPower,'shared-port cost must be charged');
assert(b.p.dieArea<=A.LIMITS.dieArea&&b.p.diePower<=A.LIMITS.diePower&&b.p.cardPower<=A.LIMITS.cardPower);
assert(b.localPortModel&&b.localPortModel.chargedCost&&b.localPortModel.chargedCost.powerWPerDie>0);
console.log('PASS final tuning',b.tps.toFixed(2),'TPS',b.rawUs.toFixed(2),'us raw; GAIN=1, tau floor, fold order, shared-expert overlap, TMA lanes, cross-layer KV prefetch, DMA preemption, FP8 KV cache, single launch batching and charged shared-port cost verified');
