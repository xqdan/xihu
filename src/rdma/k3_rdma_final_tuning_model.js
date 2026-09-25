'use strict';
/* K3 RDMA-to-SRAM Final Tuning model (P1 compact executable profile).
 *
 * Every multiplicative factor in GAIN below was an ENGINEERING ASSUMPTION
 * (evidence class ASSUMPTION), not a measured kernel, protocol or RTL result.
 * Decision 2026-09-25: all GAIN factors are neutral (1). A factor may leave 1
 * only with evidence from an event/resource model (B-003). They stay declared
 * by name so reports and tests can enumerate them.
 *
 * Collective cost basis (ADR-0004, decision 2026-09-25): every collective costs
 * at least OPT.tauUs = 1.15 us, the spec per-collective latency. The RDMA
 * protocol model still sets the duration of any collective that exceeds it.
 */
const A=require('../search/k3_architecture_search.js'),R=require('./k3_sram_memory_rdma_model');
const {MiB,simulate}=require('../simulation/k3_operator_sram_sim.js');

const OPT={
  // RDMA protocol parameters consumed by k3_sram_memory_rdma_model.collective
  stripeKiB:64,oneWayUs:.05,commitCycles:2,notifyCycles:2,ackCycles:4,outstandingPerNIC:64,epochs:2,
  // Per-collective latency floor (spec basis, ADR-0004); applied after all other COMM scaling.
  tauUs:1.15,
  // Scheduling and fusion switches
  // Prefetch lookahead is the searched x.depth (layers). The earlier fixed
  // overlapDepth 4 is gone -- a fixed deep lookahead over-prefetched and
  // thrashed shared SRAM once the bytes per layer shrank.
  phaseFusionFactor:3,commitBatchSize:16,ackBatchSize:16,
  tilePartialReady:true,partialThresholdAttention:.20,partialThresholdLSE:.25,partialThresholdRouter:.18,partialRelease:true,
  reduceStartThreshold:.2,          // single definition (an earlier duplicate key .25 was silently overridden)
  launchBatching:true,launchScale:.45, // applied exactly once per non-COMM op; duration is reduced by the same amount
  dieDirectReduce:true,groupAck:true,readyCounter:true,dieGroupReduce:true,hierarchicalReduce:true,remoteDirectReduce:true,
  moeTokenPacking:true,attentionFusion:true,wupRouterFusion:true,outputDirectConsumer:true,
  // Matrix/vector utilization is NOT an OPT knob: op durations are fixed by
  // mappedPlan() from A.TECH.matrixUtil/vectorUtil before mapped() runs, and the
  // simulator never re-reads plan.c.lUtil/hUtil/vectorUtil.
  // Shared-SRAM port scaling. These raise plan.c.sramWriteTBs / sramReadTBs above
  // what physical() sized. chargeSharedPortCost=true charges the extra bandwidth
  // as bank/port area and port power using the same TECH coefficients as
  // physical(), and re-checks the die/card limits.
  localWriteRatio:1.70,tmaDedicatedPort:true,tmaPortWriteScale:1.55,sharedReadScale:1.18,sharedReadPerWrite:.18,
  chargeSharedPortCost:true,
  // Collective counting basis, forwarded to the simulator. 'reference-393'
  // matches the reference page's target design (93 layers, 92 MoE):
  //   92 (Wup + shared, folded) + 93 (attention output) + 92 (Wdown+router)
  // + 92 (routed latent merge) + 24 (LSE) = 393
  // 'repo-510' is the earlier repo basis. Counting only -- see OPEN_ISSUES
  // B-007 for whether the shared-expert fold is physically legal.
  countBasis:'reference-393',
  // Compute/collective overlap (decision 2026-09-25), forwarded to the simulator.
  // Only data-independent compute (the shared experts) runs under a collective;
  // the gain is booked as services.commOverlap (negative).
  commOverlap:true,
  // Separate TMA lanes (2026-09-25), forwarded to the simulator. The DMA-sourced
  // shared->local fill of each op (booked as services.tmaFill) is issued ahead
  // of the op on a per-domain lane into the free double-buffer half; the part
  // that runs under a collective or another kernel is booked as
  // services.tmaHidden (negative).
  tmaLane:true,
  // Cross-layer KV prefetch (2026-09-25), forwarded to the simulator. KV
  // context tiles of the next x.depth layers may be fetched ahead, bounded
  // by shared-SRAM capacity.
  kvPrefetch:'window',
  // DMA preemption (2026-09-25), forwarded to the simulator. With DMA striped
  // at stripeKiB, the Top-k-released routed-expert demand fetch (and any fetch
  // the next op needs) parks an in-flight prefetch instead of queueing behind it.
  dmaPreempt:true,
  // Attention and small-op mapping (2026-09-25), consumed by A.mappedPlan.
  // pvMerge 'layer' merges the PV partials once per layer (local m/l/O carried
  // across context tiles) with a cross-die ring reduce-scatter by heads.
  // softmaxFusion pipelines the online softmax on the H-core vector lanes under
  // the QK matrix time. epilogueFusion folds elementwise ops into the adjacent
  // kernel (no separate stage, flush or launch; vector time and bytes kept).
  pvMerge:'layer',softmaxFusion:true,epilogueFusion:true,
  // KV cache format (2026-09-25), forwarded to the simulator. 'fp8' stores the
  // MLA latent in the FlashMLA FP8 layout (656 B/token/layer instead of 1152);
  // QK/PV stay BF16 and dequantize in-kernel on the H-core vector lanes.
  kvCache:'fp8'
};

// Named empirical factors, all neutral since 2026-09-25 (previous ASSUMPTION
// values are in git history before that date). A value other than 1 needs an
// evidence class better than ASSUMPTION and a note here.
const GAIN={
  // hot collectives (Attention output, Wup all-reduce, Shared output, Routed latent) after phase fusion
  hotPhaseDuration:1,hotWire:1,hotReadWrite:1,hotNoc:1,hotWorkspace:1,
  // hierarchical (4+4 die) reduce
  hierCardLocal:1,hierTpReduce:1,hierDuration:1,
  // remote direct reduce into shared-SRAM staging
  remoteMemoryTransport:1,remoteDuration:1,remoteReadWrite:1,remoteNoc:1,
  // dieDirectReduce, groupAck, dieGroupReduce
  // (COMM ops carry memoryTransport/tpReduce/cardLocal/portTail only; the
  //  previous "dieLink" scaling on COMM ops multiplied an undefined field
  //  (NaN, masked by the service accumulator) and had no effect on duration,
  //  so it is not carried over.)
  dieDirectCardLocal:1,dieDirectDuration:1,
  groupAckDuration:1,groupAckMemoryTransport:1,
  dieGroupCardLocal:1,dieGroupDuration:1,
  // kernel-side: tile pipeline, partial-ready, fusions and token packing
  kernelAttention:1,kernelLinear:1,
  partialReadyAttention:1,partialReadyLinear:1,
  attentionFusion:1,moeTokenPacking:1,wupRouterFusion:1
};

const HOT=/Attention output|Wup all-reduce|Shared output|Routed latent/;
const ATTN_OPS=/Online softmax|PV|Attention/;
const LINEAR_OPS=/Linear|Expert|Wup|Wdown/;
const LINEAR_ROUTER_OPS=/Linear|Expert|Wup|Wdown|Router/;
// Only the attention RMSNorm op is fused. The earlier pattern also listed
// QKV/RoPE/Output, but no op carries those names ("MLA Q/KV projections",
// "RoPE", "Attention output projection"), so it only ever matched RMSNorm.
const ATTN_FUSION_OPS=/^Attention RMSNorm$/;
const MOE_OPS=/Router|Expert|Routed/;
const WUP_OPS=/Wup|Wdown/;

function collective(name,payload,p,x,c=OPT){
  const q=R.collective(name,payload,p,x,{...R.MEM,...c});
  if(HOT.test(name)){
    q.phases=Math.max(1,Math.ceil(q.phases/c.phaseFusionFactor));
    q.requests=Math.max(1,Math.ceil(q.requests/c.phaseFusionFactor));
    q.duration*=GAIN.hotPhaseDuration;q.wireBytes*=GAIN.hotWire;
    q.readBytes*=GAIN.hotReadWrite;q.writeBytes*=GAIN.hotReadWrite;q.nocBytes*=GAIN.hotNoc;q.workspace*=GAIN.hotWorkspace;
  }
  if(c.hierarchicalReduce){q.timing.cardLocal*=GAIN.hierCardLocal;q.timing.tpReduce*=GAIN.hierTpReduce;q.duration*=GAIN.hierDuration;}
  if(c.remoteDirectReduce){
    q.timing.memoryTransport*=GAIN.remoteMemoryTransport;q.duration*=GAIN.remoteDuration;
    q.readBytes*=GAIN.remoteReadWrite;q.writeBytes*=GAIN.remoteReadWrite;q.nocBytes*=GAIN.remoteNoc;
  }
  return q;
}

// Charge extra shared-SRAM port bandwidth (card-level TB/s beyond what
// physical() sized) as bank/port area and port power, then re-check limits.
function chargeSharedPortCost(p,x,extraCardTBs){
  const D=A.LIMITS.dies,T=A.TECH;
  const perDie=Math.max(0,extraCardTBs)/D;
  const sliceTBs=512*x.ghz/1000*T.bankUtil;          // read bandwidth of one shared slice
  const area=perDie/sliceTBs*32*T.bankArea;           // ports cost the bank area that would deliver them
  const power=perDie*T.sharedPortWPerTB;
  const dieArea=p.dieArea+area,diePower=p.diePower+power,cardPower=p.cardPower+D*power,packageArea=p.packageArea+D*area;
  const reasons=[];
  if(dieArea>A.LIMITS.dieArea)reasons.push('die area after shared-port scaling');
  if(diePower>A.LIMITS.diePower)reasons.push('die power after shared-port scaling');
  if(cardPower>A.LIMITS.cardPower)reasons.push('card power after shared-port scaling');
  if(packageArea>A.LIMITS.packageArea*A.LIMITS.packageUtil)reasons.push('package area after shared-port scaling');
  return {...p,area:{...p.area,sharedPorts:area},power:{...p.power,sharedPorts:power},dieArea,diePower,cardPower,packageArea,
    sharedPortCost:{extraTBsPerDie:perDie,areaMm2PerDie:area,powerWPerDie:power,cardPowerW:D*power},feasible:!reasons.length,reasons};
}

function mapped(x){
  const c=OPT,p0=A.physical(x);if(!p0.feasible)return {feasible:false,reasons:p0.reasons};
  const m=A.mappedPlan(x,1,p0,{countBasis:c.countBasis,commOverlap:c.commOverlap,tmaLane:c.tmaLane,kvPrefetch:c.kvPrefetch,dmaPreempt:c.dmaPreempt,pvMerge:c.pvMerge,softmaxFusion:c.softmaxFusion,epilogueFusion:c.epilogueFusion,kvCache:c.kvCache});if(!m.feasible)return m;
  let reserve=0,wire=0,req=0,ph=0;const protocol={};
  for(const o of m.plan.ops)if(o.unit==='COMM'){
    const q=collective(o.name,o.mapping.payload,p0,x,c);reserve=Math.max(reserve,q.workspace);
    o.duration=q.duration;o.read=q.readBytes;o.write=q.writeBytes;o.linkBytes=q.nocBytes;o.timing=q.timing;o.memory=q;
    wire+=q.wireBytes;req+=q.requests;ph+=q.phases;
    const a=protocol[o.name]||(protocol[o.name]={name:o.name,count:0,phases:0,requests:0,wireBytes:0,timeUs:0,workspace:0});
    a.count++;a.phases+=q.phases;a.requests+=q.requests;a.wireBytes+=q.wireBytes;a.timeUs+=q.duration;a.workspace=Math.max(a.workspace,q.workspace);
  }
  m.plan.scratchReserve+=reserve;m.plan.minCapacity+=reserve;m.plan.rdmaReserve=reserve;
  const pc=m.plan.c;
  pc.batch=1;pc.depth=x.depth;
  // Shared-SRAM port scaling (card-level TB/s in plan.c)
  const baseRead=pc.sramReadTBs,baseWrite=pc.sramWriteTBs;
  pc.sramWriteTBs*=c.localWriteRatio;
  if(c.tmaDedicatedPort)pc.sramWriteTBs*=c.tmaPortWriteScale;
  pc.sramReadTBs*=c.sharedReadScale;
  pc.sramReadTBs+=pc.sramWriteTBs*c.sharedReadPerWrite;
  const extraCardTBs=(pc.sramReadTBs-baseRead)+(pc.sramWriteTBs-baseWrite);
  const p=c.chargeSharedPortCost?chargeSharedPortCost(p0,x,extraCardTBs):p0;
  if(!p.feasible)return {feasible:false,reasons:p.reasons,sharedPortCost:p.sharedPortCost};
  // Kernel-side gains
  for(const o of m.plan.ops){
    if(o.unit==='COMM'){
      if(c.dieDirectReduce){o.timing.cardLocal*=GAIN.dieDirectCardLocal;o.duration*=GAIN.dieDirectDuration;}
      if(c.groupAck){o.duration*=GAIN.groupAckDuration;o.timing.memoryTransport*=GAIN.groupAckMemoryTransport;}
      if(c.dieGroupReduce){o.timing.cardLocal*=GAIN.dieGroupCardLocal;o.duration*=GAIN.dieGroupDuration;}
      // tau floor: the difference is booked as its own service line.
      o.timing.tauFloor=Math.max(0,c.tauUs-o.duration);o.duration+=o.timing.tauFloor;
      continue;
    }
    // launch batching: applied once. The launch saving is removed from duration
    // BEFORE the multiplicative gains (conservative: the gains then act on a
    // smaller base, so the total saving is (1-launchScale)*launch*product(gains)).
    if(c.launchBatching){const saved=o.timing.launch*(1-c.launchScale);o.timing.launch-=saved;o.duration-=saved;}
    if(ATTN_OPS.test(o.name))o.duration*=GAIN.kernelAttention;else if(LINEAR_OPS.test(o.name))o.duration*=GAIN.kernelLinear;
    if(c.tilePartialReady){if(ATTN_OPS.test(o.name))o.duration*=GAIN.partialReadyAttention;else if(LINEAR_ROUTER_OPS.test(o.name))o.duration*=GAIN.partialReadyLinear;}
    if(c.attentionFusion&&ATTN_FUSION_OPS.test(o.name))o.duration*=GAIN.attentionFusion;
    if(c.moeTokenPacking&&MOE_OPS.test(o.name))o.duration*=GAIN.moeTokenPacking;
    if(c.wupRouterFusion&&WUP_OPS.test(o.name))o.duration*=GAIN.wupRouterFusion;
  }
  // GAIN scales o.duration, while the per-field timing scalings above only move
  // attribution between fields. Book the net difference as its own service line
  // so services + wait reconciles with raw and the assumed saving stays visible.
  for(const o of m.plan.ops){
    const booked=Object.values(o.timing).reduce((a,b)=>a+b,0);
    o.timing.assumedGain=o.duration-booked;
  }
  if(m.window*MiB<m.plan.minCapacity)return {feasible:false,reasons:['SRAM window after joint optimization'],minMiB:m.plan.minCapacity/MiB};
  const services={};for(const o of m.plan.ops)for(const[k,v]of Object.entries(o.timing))services[k]=(services[k]||0)+v;
  return {...m,p,c,services,
    localPortModel:{writeRatio:c.localWriteRatio,tmaDedicatedPort:c.tmaDedicatedPort,readScale:c.sharedReadScale,tmaScale:c.tmaPortWriteScale,readPerWrite:c.sharedReadPerWrite,bankPartition:true,contentionMitigation:true,chargedCost:p.sharedPortCost||null},
    rdmaReserveMiB:reserve/MiB,wireBytes:wire,requests:req,phases:ph,protocol:Object.values(protocol)};
}

function evaluate(x,{detail=false}={}){
  const m=mapped(x);if(!m.feasible)return m;
  const r=simulate(m.plan,m.window);if(!r.feasible)return r;
  const {layerStats,events,occupancy,...stats}=r;
  // Overlap and hidden TMA are known only after scheduling; book them so services + wait = raw.
  const services={...m.services,commOverlap:-stats.overlapUs,tmaHidden:-stats.tmaHiddenUs};
  const o={feasible:true,x:{...x},p:m.p,...stats,services,localPortModel:m.localPortModel,rdmaReserveMiB:m.rdmaReserveMiB,wireBytes:m.wireBytes,requests:m.requests,phases:m.phases,protocol:m.protocol,
    localL:m.lLocalBytes/MiB,localH:m.hLocalBytes/MiB,backingGB:m.plan.backingBytes/1e9,dmaTBs:m.dmaEffective};
  if(detail){o.layers=layerStats;o.micro=m.plan.ops.filter(a=>a.layer===4).map(a=>({name:a.name,unit:a.unit,duration:a.duration,timing:a.timing,read:a.read,write:a.write}));}
  return o;
}
module.exports={OPT,GAIN,mapped,evaluate,chargeSharedPortCost};
