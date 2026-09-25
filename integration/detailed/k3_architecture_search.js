/* Die physical model, operator-to-core mapping and the design space shared by
 * the final tuning search (k3_rdma_final_tuning_search.js); no vendor PPA claims.
 * The standalone multi-objective search() is kept as a library function only.
 */
'use strict';
const {build,simulate,MiB}=require('./k3_operator_sram_sim.js');
const LIMITS={dies:8,tp:32,context:1048576,dieArea:400,diePower:260,cardPower:2400,packageArea:5248,packageUtil:1,mcCountPerDie:2,mcArea:100,mcGB:8,networkGBs:800,usable:.85};
// Only SRAM density and reference matrix density are inherited from local concept documents.
// All other coefficients below are explicit, editable analytical cost assumptions.
const TECH={matrixTFPerMm2:1.60,sramMiBPerMm2:1.26,bankArea:.020,coreOverhead:.8,vectorLaneArea:.0015,tmaArea:.35,ucieLaneArea:.028,ucieControllerArea:2,rdmaLaneArea:.35,rdmaControllerArea:5,ucieLanesPerMm:24,rdmaLaneMm:.18,phyEdgeFraction:.70,
 matrixWattsPerTF:.48,vectorWattsPerTOP:.65,sramLeakWPerMiB:.09,localPortWPerTB:.55,sharedPortWPerTB:.75,nocWPerTB:1.5,tmaControlW:.08,reduceLaneW:.008,uciePjPerBit:1.2,rdmaPjPerBit:5,mcBaseW:7,mcPjPerBit:5,
 bankUtil:.75,nocUtil:.65,ucieUtil:.8,mcUtil:.7,rdmaUtil:.75,matrixUtil:.65,vectorUtil:.35,reduceUtil:.65,layoutImbalance:1.15,routerCycles:2,ucieHopUs:.025,rdmaStepUs:.14,launchUs:.015,tmaSetupCycles:16,unpackParamsPerLaneCycle:2};
const SPACE={nL:[4,8,12,16],nH:[4,8,12,16],lRows:[4,8,16],lCols:[64,128],lEngines:[1,2,4],hRows:[8,16,32,64],hCols:[32,64,128],hEngines:[2,4,8],ghz:[.8,1,1.2],vectorLanes:[128,256,512],
 lMiB:[1,2,4,8],hMiB:[1,2,4,8],lBanks:[8,16,32,64],hBanks:[8,16,32,64],bankBytes:[32,64],sharedMiB:[16,24,32,48,64],sharedSlices:[8,16,32],tmaEngines:[1,2,4],tmaBytes:[128,256,512],nocBytes:[256,512,1024],nocLanes:[1,2,4],reduceLanes:[64,128,256,512],ucieLanes:[64,128,256],ucieGbps:[16,32,64],mcGBs:[160,320,640],rdmaLanes:[4,8,16],weightTileMiB:[2,4,8],kvTile:[1024,2048,4096],headTile:[8,16,32],depth:[0,1,2,4],windowFraction:[.5,.75,1]};
const BASE={nL:8,nH:8,lRows:16,lCols:128,lEngines:1,hRows:64,hCols:64,hEngines:4,ghz:1,vectorLanes:256,lMiB:8,hMiB:2,lBanks:64,hBanks:16,bankBytes:64,sharedMiB:16,sharedSlices:16,tmaEngines:2,tmaBytes:256,nocBytes:512,nocLanes:2,reduceLanes:256,ucieLanes:128,ucieGbps:32,mcGBs:320,rdmaLanes:4,weightTileMiB:8,kvTile:1024,headTile:8,depth:2,windowFraction:1};
function physical(x){
 const D=LIMITS.dies,f=x.ghz,n=x.nL+x.nH;
 const lTF=x.nL*x.lRows*x.lCols*x.lEngines*2*f/1000,hTF=x.nH*x.hRows*x.hCols*x.hEngines*2*f/1000;
 const vectorTOP=n*x.vectorLanes*2*f/1000;
 const localMiB=x.nL*x.lMiB+x.nH*x.hMiB,totalMiB=localMiB+x.sharedMiB;
 const lRead=x.lBanks*x.bankBytes*f/1000*TECH.bankUtil,hRead=x.hBanks*x.bankBytes*f/1000*TECH.bankUtil;
 const sharedRead=x.sharedSlices*512*f/1000*TECH.bankUtil,sharedWrite=sharedRead/2;
 const meshSide=Math.ceil(Math.sqrt(n+x.sharedSlices+3));
 const nocTB=2*meshSide*x.nocBytes*x.nocLanes*f/1000*TECH.nocUtil;
 const coreTma=x.tmaEngines*x.tmaBytes*f/1000*.8;
 const uciePortGB=x.ucieLanes*x.ucieGbps/8*TECH.ucieUtil;
 const mcDieGB=2*Math.min(x.mcGBs*TECH.mcUtil,uciePortGB);
 const dieCutGB=2*uciePortGB; // Eight-die bidirectional ring: two links across the cut, NOT 8x injection.
 const rdmaDieGB=x.rdmaLanes*112/8*TECH.rdmaUtil,rdmaCardGB=Math.min(D*rdmaDieGB,LIMITS.networkGBs);
 const reduceTOP=x.reduceLanes*f/1000*TECH.reduceUtil;
 const area={matrix:(lTF+hTF)/f/TECH.matrixTFPerMm2,vector:n*x.vectorLanes*TECH.vectorLaneArea,sram:totalMiB/TECH.sramMiBPerMm2,
 banks:(x.nL*x.lBanks+x.nH*x.hBanks+x.sharedSlices*32)*TECH.bankArea,
 cores:n*TECH.coreOverhead,tma:n*x.tmaEngines*TECH.tmaArea,noc:6+meshSide**2*x.nocBytes*x.nocLanes*.0006,
 reduce:2+x.reduceLanes*.008,ucie:4*(TECH.ucieControllerArea+x.ucieLanes*TECH.ucieLaneArea),rdma:TECH.rdmaControllerArea+x.rdmaLanes*TECH.rdmaLaneArea,misc:12};
 const dieArea=Object.values(area).reduce((a,b)=>a+b,0),clockScale=f**1.2;
 const power={matrix:(lTF+hTF)*TECH.matrixWattsPerTF*clockScale,vector:vectorTOP*TECH.vectorWattsPerTOP*clockScale,
 sram:totalMiB*TECH.sramLeakWPerMiB+(x.nL*lRead+x.nH*hRead)*TECH.localPortWPerTB+sharedRead*TECH.sharedPortWPerTB,
   noc:nocTB*TECH.nocWPerTB,tma:n*x.tmaEngines*TECH.tmaControlW*f,reduce:x.reduceLanes*TECH.reduceLaneW*f,
   ucie:4*uciePortGB*8/1000*TECH.uciePjPerBit,rdma:rdmaDieGB*8/1000*TECH.rdmaPjPerBit,control:20+n*.3};
 const diePower=Object.values(power).reduce((a,b)=>a+b,0),mcPower=16*(TECH.mcBaseW+x.mcGBs*TECH.mcUtil*8/1000*TECH.mcPjPerBit);
 const cardPower=D*diePower+mcPower+80,packageArea=D*dieArea+16*LIMITS.mcArea;
 const shoreline=4*x.ucieLanes/TECH.ucieLanesPerMm+x.rdmaLanes*TECH.rdmaLaneMm,edgeBudget=4*Math.sqrt(dieArea)*TECH.phyEdgeFraction;
 const reasons=[];
 if(dieArea>LIMITS.dieArea)reasons.push('die area');if(diePower>LIMITS.diePower)reasons.push('die power');if(cardPower>LIMITS.cardPower)reasons.push('card power');if(packageArea>LIMITS.packageArea*LIMITS.packageUtil)reasons.push('package area');if(shoreline>edgeBudget)reasons.push('PHY shoreline');
 return {lTF,hTF,vectorTOP,localMiB,totalMiB,lRead,hRead,sharedRead,sharedWrite,meshSide,nocTB,coreTma,uciePortGB,mcDieGB,dieCutGB,rdmaDieGB,rdmaCardGB,reduceTOP,area,power,dieArea,diePower,mcPower,cardPower,packageArea,shoreline,edgeBudget,feasible:!reasons.length,reasons};
}
// basis: a countBasis string, or an object whose simulator keys
// {countBasis, commOverlap, tmaLane, kvPrefetch, dmaPreempt} are forwarded to
// build() and whose mapping keys are consumed here:
//  pvMerge 'tile' (historical): every context tile merges its token-partitioned
//   PV partials and gathers the die partials onto one die over the ring.
//   'layer': FlashDecoding-style -- each H core carries its m/l/O accumulator
//   (already reserved in hLocalBytes) across the context tiles of a layer, the
//   partials are merged once on the layer's last tile, and the cross-die step
//   is a bidirectional-ring reduce-scatter by heads (each die ends with ht/D
//   heads, which feed the head-sharded output projection whose partial sums
//   already go to the attention output all-reduce).
//  softmaxFusion: the online softmax runs on the H-core vector lanes inside the
//   fused QK/softmax/PV kernel, pipelined by score blocks of hCols tokens; only
//   one block (the pipeline fill), or any excess over the QK matrix time, stays exposed.
//  epilogueFusion: elementwise ops (EPILOGUE_OPS) run in the epilogue of the
//   preceding kernel on the same data: no separate shared->local stage or
//   launch; the flush is kept only when a collective reads the result next.
//   Their vector time and shared-SRAM bytes stay booked. Ops that follow a
//   collective (the residual adds) head a chain and keep their stage.
//  kvCache 'fp8' (forwarded to the simulator): KV tiles are stored, fetched and
//   staged in local SRAM in the FlashMLA FP8 layout; QK and PV each dequantize
//   the FP8 latent in-kernel on the H-core vector lanes (same rate as weight
//   unpack), overlapped with the BF16 matrix work. That vector time is taken out
//   of the budget the fused online softmax may hide under QK.
const SIM_KEYS=['countBasis','commOverlap','tmaLane','kvPrefetch','dmaPreempt','kvCache'];
const EPILOGUE_OPS=/^(Attention RMSNorm|MoE RMSNorm|SiLU x up|Shared SiLU x up|Expert weighted sum|Dispatch local pack|RoPE|KV append source)$/;
function mappedPlan(x,batch,p=physical(x),basis){
 const b0=typeof basis==='string'?{countBasis:basis}:(basis||{});
 const extra=Object.fromEntries(SIM_KEYS.filter(k=>b0[k]!==undefined).map(k=>[k,b0[k]]));
 const pvMerge=b0.pvMerge||'tile',softmaxFusion=!!b0.softmaxFusion,epilogueFusion=!!b0.epilogueFusion;
 if(!['tile','layer'].includes(pvMerge))throw Error('Invalid pvMerge '+pvMerge);
 const D=LIMITS.dies,NL=D*x.nL,NH=D*x.nH,B=batch;
 // Shared SRAM holds backing objects; LOCAL SRAM is never added to this pool.
 // Keep physical capacity reserve separate from timing/imbalance margin.
 // The simulator itself accounts for scratch and live-object peaks.
 const sharedUsable=D*x.sharedMiB*LIMITS.usable;
 const plan=build({batch,context:LIMITS.context,depth:x.depth,prediction:.8,weightTileMiB:x.weightTileMiB,kvTile:x.kvTile,headTile:x.headTile,
 lTflops:p.lTF*D,hTflops:p.hTF*D,vectorTops:p.vectorTOP*D,lUtil:TECH.matrixUtil,hUtil:TECH.matrixUtil,vectorUtil:TECH.vectorUtil,
 sramReadTBs:D*p.sharedRead,sramWriteTBs:D*p.sharedWrite,memTBs:D*p.mcDieGB/1000,fabricTBs:D*p.nocTB,linkGBs:p.rdmaCardGB,margin:1.17,
 ...extra});
 // KV persists across all head tiles of this context tile. Reserve the
 // FULL batch share, not an unmodelled smaller batch tile: otherwise
 // claiming one shared->local KV read would hide actual reload traffic.
 const tokensPerCore=Math.ceil(B*x.kvTile/NH),ht=x.headTile;
 // Two KV slabs, FP32 double score, output accumulator and Q/work/control.
 const hLocalBytes=(2*tokensPerCore*plan.kvBytesPerToken+2*ht*tokensPerCore*4+ht*512*4+ht*576*2+65536)*TECH.layoutImbalance;
 let lLocalBytes=0;
 for(const o of plan.ops)if(o.unit==='L'){
  const w=o.inputs.reduce((a,id)=>a+plan.jobs[id].bytes,0),activation=Math.max(0,o.read-w);
  lLocalBytes=Math.max(lLocalBytes,(2*w/NL+2*activation/NL+o.write/NL*2+65536)*TECH.layoutImbalance);
 }
 const constraints=[];
 if(hLocalBytes>x.hMiB*MiB*LIMITS.usable)constraints.push('H local tile');if(lLocalBytes>x.lMiB*MiB*LIMITS.usable)constraints.push('L local tile');
 const window=sharedUsable*x.windowFraction;
 if(window*MiB<plan.minCapacity)constraints.push('shared window');
 if(plan.backingBytes>128e9)constraints.push('DRAM capacity');
 if(constraints.length)return {feasible:false,reasons:constraints,hLocalBytes,lLocalBytes,window,sharedUsable};
 const meshLatency=p.meshSide*TECH.routerCycles/(x.ghz*1000),tmaSetup=TECH.tmaSetupCycles/(x.ghz*1000);
 // DMA: remote spill budget 12.5%; one aggregate non-preemptive read/write lane.
 // All compute->MC are direct. The ring budget accounts for misplacement/rebalance,
 // not an imaginary all-to-all ring bandwidth equal to the sum of endpoint injection.
 const remote=.125,remoteTB=p.dieCutGB/1000/remote;
 const dmaPeak=Math.min(D*p.mcDieGB/1000,D*p.nocTB,remoteTB,D*p.sharedWrite);
 const reads=plan.jobs.filter(j=>['weight','expert','prediction','kv','state'].includes(j.kind));
 const meanBytes=reads.reduce((s,j)=>s+j.bytes,0)/reads.length;
 const dmaStartup=2*TECH.ucieHopUs+meshLatency;
 plan.c.memTBs=1/(1/dmaPeak+dmaStartup*1e6/meanBytes);
 const seenKV=new Set(),services={},limiters={};
 function stageTime(bytes,cores,localRead){return bytes? tmaSetup+meshLatency+Math.max(bytes/(D*p.nocTB*1e6),bytes/(D*p.sharedRead*1e6),bytes/(cores*p.coreTma*1e6),bytes/(cores*localRead*.5*1e6)):0;}
 function record(o,timing,extra){
  o.timing=timing;o.mapping=extra;
  o.duration=Object.values(timing).reduce((a,b)=>a+b,0);
  for(const[k,v]of Object.entries(timing))services[k]=(services[k]||0)+v;
 }
 // pvMerge 'layer': the last PV op of each (layer, head tile) carries the merge.
 const lastPV=new Set();
 if(pvMerge==='layer'){const last={};for(const o of plan.ops)if(o.name.startsWith('PV'))last[o.layer+'|'+o.detail.split(';')[1]]=o.id;for(const id of Object.values(last))lastPV.add(id);}
 let qkKernel=0,qkDequant=0;
 for(const o of plan.ops){
  const oldRead=o.read,oldWrite=o.write;
  if(o.unit==='COMM'){
   const payload=o.linkBytes/2,isGather=o.name.includes('all-gather'),factor=isGather?31/32:2*31/32;
   const wire=payload*factor,steps=isGather?5:10;
   const network=steps*TECH.rdmaStepUs+wire/(p.rdmaCardGB*1000);
   const dieMerge=6*TECH.ucieHopUs+payload*2/(p.dieCutGB*1000);
   const localReduce=payload/4*2/(D*p.reduceTOP*1e6);
   const ports=Math.max(wire/(D*p.sharedRead*1e6),wire/(D*p.sharedWrite*1e6));
   o.read=o.write=wire;o.linkBytes=wire+payload*2;
   record(o,{collective:Math.max(network,ports)+dieMerge+localReduce+meshLatency},{payload,wire,network,dieMerge,localReduce});continue;
  }
  let domain=o.unit==='H'||/Online softmax|RoPE/.test(o.name)?'H':'L';
  let cores=domain==='H'?NH:NL,localRead=domain==='H'?p.hRead:p.lRead;
  // Recurrent state is head-sharded: only three heads/card, not NH
  // independent head updates at B=1.
  if(o.name.startsWith('Linear recurrent'))cores=Math.min(NH,3*B);
  let sharedR=oldRead,sharedW=oldWrite,reduceUs=0,dieUs=0,reduceRead=0,reduceWrite=0;
  const kv=o.inputs.find(id=>plan.jobs[id].kind==='kv');
  if(kv!==undefined){
   sharedR=seenKV.has(kv)?0:plan.jobs[kv].bytes;seenKV.add(kv);sharedW=0;
   if(o.name.startsWith('PV')&&(pvMerge==='tile'||lastPV.has(o.id))){
    // Token partition across cores => explicit FP32 m/l/O partial merge.
    const part=ht*(512+2)*4;
    sharedW=Math.max(B,NH)*part;
    reduceRead=sharedW;reduceWrite=Math.max(B,D)*part;
    reduceUs=Math.max(sharedW/4*8/(D*p.reduceTOP*1e6),reduceRead/(D*p.sharedRead*1e6),reduceWrite/(D*p.sharedWrite*1e6));
    if(pvMerge==='tile'){
     const ringBytes=Math.max(0,D-B)*part;
     dieUs=ringBytes?3*TECH.ucieHopUs+ringBytes/(p.dieCutGB*1000):0;
    }else{
     // Bidirectional-ring reduce-scatter: D-1 steps, each moving part/D split over both directions.
     dieUs=B<D?(D-1)*(TECH.ucieHopUs+part/D/2/(p.uciePortGB*1000)):0;
    }
   }
  }
  let fill=1,peak=0;
  if(o.unit==='L'){
   const routed=o.name.startsWith('Expert '),rows=routed?B*16/plan.U:B;
   fill=Math.min(1,rows/x.lRows);peak=D*p.lTF*TECH.matrixUtil*fill;
  }else if(o.unit==='H'){
   const m=o.name.startsWith('Linear')?1:ht;
   const n=o.name.startsWith('PV')?512:Math.max(1,tokensPerCore);
   fill=Math.min(1,m/x.hRows)*Math.min(1,n/x.hCols);peak=D*p.hTF*TECH.matrixUtil*fill*cores/NH;
  }else{
   peak=cores*x.vectorLanes*2*x.ghz/1000*TECH.vectorUtil;
  }
  const alu=o.flops/(peak*1e6),readTime=oldRead/(cores*localRead*1e6),writeTime=oldWrite/(cores*localRead*.5*1e6);
  const wparams=o.inputs.reduce((s,id)=>s+(plan.jobs[id].params||0),0);
  const kvDequant=o.unit==='H'&&kv!==undefined?(plan.jobs[kv].dequant||0):0;
  const unpack=wparams/(NL*x.vectorLanes*TECH.unpackParamsPerLaneCycle*x.ghz*1000)+kvDequant/(cores*x.vectorLanes*TECH.unpackParamsPerLaneCycle*x.ghz*1000);
  let kernel=Math.max(alu,readTime,writeTime,unpack)*TECH.layoutImbalance;
  if(o.name.startsWith('QK')){qkKernel=kernel;qkDequant=kvDequant?unpack*TECH.layoutImbalance:0;}
  if(softmaxFusion&&o.name==='Online softmax')kernel=Math.max(kernel/Math.max(1,Math.ceil(tokensPerCore/x.hCols)),kernel-(qkKernel-qkDequant));
  const prev=plan.ops[o.id-1],next=plan.ops[o.id+1];
  const fused=epilogueFusion&&EPILOGUE_OPS.test(o.name)&&prev&&prev.unit!=='COMM';
  const names=['matrix/vector','local SRAM read','local SRAM write','unpack'];const times=[alu,readTime,writeTime,unpack];const limiter=names[times.indexOf(Math.max(...times))];limiters[limiter]=(limiters[limiter]||0)+kernel;
  // The global op stays serialized; local double-buffer chunks pipeline only within it.
  const chunkMiB=domain==='H'?x.hMiB:x.lMiB;
  const chunks=Math.max(1,Math.ceil((sharedR+sharedW)/(cores*chunkMiB*MiB*LIMITS.usable/2)));
  const stage=stageTime(sharedR,cores,localRead);
  const nominalPipeline=chunks===1?stage+kernel:stage/chunks+Math.max(stage*(chunks-1)/chunks,kernel);
  // TMA fills and matrix/vector stores share the LOCAL write port. TMA
  // must not get free SRAM bandwidth simply by having more engines.
  const pipelined=Math.max(nominalPipeline,(oldWrite+sharedR)/(cores*localRead*.5*1e6),oldRead/(cores*localRead*1e6));
  const flush=sharedW?Math.max(sharedW/(D*p.sharedWrite*1e6),sharedW/(D*p.nocTB*1e6),sharedW/(cores*p.coreTma*1e6),sharedW/(cores*localRead*1e6))+meshLatency:0;
  const localTma=fused?(next&&next.unit==='COMM'?flush:0):Math.max(0,pipelined-kernel)+flush,launch=fused?0:TECH.launchUs;
  // tmaLane: the DMA-sourced (weight/expert/KV/state) share of the first
  // shared->local stage becomes a separate TMA fill that the simulator may
  // issue ahead of the op into the domain's free double-buffer half. The rest
  // (activation fill, local-port excess, flush) stays in the op as localTma.
  const dmaBytes=Math.min(sharedR,o.inputs.reduce((s,id)=>s+(plan.jobs[id].kind!=='write'?plan.jobs[id].bytes:0),0));
  const tmaFill=extra.tmaLane&&sharedR&&!fused?Math.min(localTma-flush,stage/chunks)*dmaBytes/sharedR:0;
  const timing=extra.tmaLane?{kernel,localTma:localTma-tmaFill,tmaFill,reduce:reduceUs,dieLink:dieUs,launch}:{kernel,localTma,reduce:reduceUs,dieLink:dieUs,launch};
  record(o,timing,{domain,fill,limiter,chunks,sharedR,sharedW,fused,
   localReadBytes:oldRead+sharedW,localWriteBytes:oldWrite+sharedR,localReadTBs:cores*localRead,localWriteTBs:cores*localRead*.5});
  // The filled tile holds one double-buffer half of its domain until the last
  // consumer of its inputs finishes (KV tiles are reused across head tiles);
  // a multi-chunk op streams through both halves.
  if(tmaFill>0)o.tma={us:tmaFill,bytes:dmaBytes/chunks,domain,halves:chunks===1?1:2,localWriteTBs:cores*localRead*.5,
   release:Math.max(...o.inputs.map(id=>plan.jobs[id].last))};
  o.read=sharedR+reduceRead;o.write=sharedW+reduceWrite;o.linkBytes=sharedR+sharedW;
 }
 return {feasible:true,plan,window,sharedUsable,hLocalBytes,lLocalBytes,services,limiters,dmaPeak,dmaEffective:plan.c.memTBs};
}
function evaluate(x,{details=false}={}){
 const p=physical(x);if(!p.feasible)return {feasible:false,reasons:p.reasons};
 const runs={};
 for(const B of [1,32]){
  const m=mappedPlan(x,B,p);if(!m.feasible)return {feasible:false,reasons:m.reasons};
  const r=simulate(m.plan,m.window);
  if(!r.feasible)return r;
  const {layerStats,events,occupancy,...summary}=r;
  runs[B]={...summary,services:m.services,limiters:m.limiters,sharedUsable:m.sharedUsable,hLocalMiB:m.hLocalBytes/MiB,lLocalMiB:m.lLocalBytes/MiB,backingGB:m.plan.backingBytes/1e9,dmaPeak:m.dmaPeak,dmaEffective:m.dmaEffective,ops:m.plan.ops.length};
  if(details){runs[B].layers=layerStats;runs[B].sampleOps=m.plan.ops.filter(o=>o.layer===4).map(o=>({name:o.name,unit:o.unit,duration:o.duration,flops:o.flops,read:o.read,write:o.write,timing:o.timing,mapping:o.mapping}));}
 }
 return {feasible:true,x:{...x},p,runs,f1:runs[1].tps,f2:runs[32].tokensPerSecond};
}
function dominates(a,b){return a.f1>=b.f1&&a.f2>=b.f2&&(a.f1>b.f1||a.f2>b.f2);}
function pareto(rows){return rows.filter((r,i)=>!rows.some((s,j)=>i!==j&&dominates(s,r))).sort((a,b)=>a.f1-b.f1);}
function rng(seed){let s=seed>>>0;return ()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return (s>>>0)/4294967296;};}
function search({samples=192,generations=4,offspring=48,polish=2,seed=20260919}={}){
 const random=rng(seed),pick=a=>a[Math.floor(random()*a.length)],keys=Object.keys(SPACE),seen=new Set(),rows=[],rejected={},history=[];
 let attempted=0,physicalReject=0,mappingReject=0;
 const test=x=>{
  const key=keys.map(k=>x[k]).join('|');if(seen.has(key))return false;seen.add(key);attempted++;
  const p=physical(x);if(!p.feasible){physicalReject++;for(const k of p.reasons)rejected[k]=(rejected[k]||0)+1;return false;}
  const r=evaluate(x);if(!r.feasible){mappingReject++;for(const k of r.reasons||[r.reason])rejected[k]=(rejected[k]||0)+1;return false;}
  r.id=rows.length;rows.push(r);if(rows.length%25===0)console.log('evaluated',rows.length,'attempts',attempted,'front',pareto(rows).length);return true;
 };
 const baseline=evaluate(BASE);if(baseline.feasible)test(BASE);
 const start=Date.now();let tries=0;
 while(rows.length<samples&&tries++<samples*1000){const x=Object.fromEntries(keys.map(k=>[k,pick(SPACE[k])]));test(x);}
 if(!rows.length)throw Error('No feasible design; inspect constraints');
 for(let g=0;g<generations;g++){
  const front=pareto(rows),max1=Math.max(...rows.map(r=>r.f1)),max2=Math.max(...rows.map(r=>r.f2));
  const elite=[...front,...rows.slice().sort((a,b)=>b.f1/max1+b.f2/max2-a.f1/max1-a.f2/max2).slice(0,12)];
  const target=rows.length+offspring;tries=0;
  while(rows.length<target&&tries++<offspring*1000){const a=pick(elite),b=pick(elite),x={...a.x};if(random()<.35)for(const k of keys)if(random()<.5)x[k]=b.x[k];for(let i=0,n=1+Math.floor(random()*5);i<n;i++){const k=pick(keys);x[k]=pick(SPACE[k]);}test(x);}
  const f=pareto(rows);history.push({generation:g+1,evaluated:rows.length,front:f.length,max1:Math.max(...rows.map(r=>r.f1)),max2:Math.max(...rows.map(r=>r.f2))});
 }
 // Deterministic coordinate polish checks every alternative of every knob
 // around both endpoints and the balanced candidate. This prevents reporting
 // a known, one-knob strictly better sensitivity case as "not searched".
 // Equal performance is tie-broken by smaller area, then lower card power.
 const choose=(a,b,score)=>{
  const sa=score(a),sb=score(b);
  if(sa!==sb)return sa>sb?a:b;
  return a.p.dieArea!==b.p.dieArea?(a.p.dieArea<b.p.dieArea?a:b):(a.p.cardPower<=b.p.cardPower?a:b);
 };
 function picks(){
  const best1=rows.reduce((a,b)=>choose(a,b,r=>r.f1)),best2=rows.reduce((a,b)=>choose(a,b,r=>r.f2));
  const balanced=pareto(rows).reduce((a,b)=>choose(a,b,r=>Math.min(r.f1/best1.f1,r.f2/best2.f2)));
  return {best1,best2,balanced};
 }
 for(let pass=0;pass<polish;pass++){
  const parents=[...new Map(Object.values(picks()).map(r=>[r.id,r])).values()];
  for(const parent of parents)for(const k of keys)for(const v of SPACE[k])if(v!==parent.x[k])test({...parent.x,[k]:v});
  const f=pareto(rows);
  history.push({generation:`local-${pass+1}`,evaluated:rows.length,front:f.length,max1:Math.max(...rows.map(r=>r.f1)),max2:Math.max(...rows.map(r=>r.f2))});
 }
 const front=pareto(rows),{best1,best2,balanced}=picks();
 const selected={best1:best1.id,best2:best2.id,balanced:balanced.id};
 for(const id of new Set(Object.values(selected))){const detailed=evaluate(rows[id].x,{details:true});rows[id]=Object.assign(detailed,{id});}
 return {version:'2026-09-19',seed,options:{samples,generations,offspring,polish},elapsedSeconds:(Date.now()-start)/1000,limits:LIMITS,tech:TECH,space:SPACE,baseline,attempted,physicalReject,mappingReject,rejected,history,selected,frontIds:front.map(r=>r.id),rows};
}
module.exports={LIMITS,TECH,SPACE,BASE,EPILOGUE_OPS,physical,mappedPlan,evaluate,dominates,pareto,rng,search};
