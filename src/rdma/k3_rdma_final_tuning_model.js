'use strict';
/* K3 RDMA-to-SRAM Final Tuning model (P1 compact executable profile).
 *
 * Every multiplicative factor in GAIN below is an ENGINEERING ASSUMPTION
 * (evidence class ASSUMPTION), not a measured kernel, protocol or RTL result.
 * They are declared once, by name, so reports and tests can enumerate them.
 * Blocker B-003 (docs/design/OPEN_ISSUES.md) tracks replacing each one with an
 * event/resource model. Do not add a new factor without a GAIN entry and note.
 */
const A=require('../search/k3_architecture_search.js'),R=require('./k3_sram_memory_rdma_model');
const {MiB,simulate}=require('../simulation/k3_operator_sram_sim.js');

const OPT={
  // RDMA protocol parameters consumed by k3_sram_memory_rdma_model.collective
  stripeKiB:64,oneWayUs:.05,commitCycles:2,notifyCycles:2,ackCycles:4,outstandingPerNIC:64,epochs:2,
  // Scheduling and fusion switches
  phaseFusionFactor:3,commitBatchSize:16,ackBatchSize:16,overlapDepth:4,
  tilePartialReady:true,partialThresholdAttention:.20,partialThresholdLSE:.25,partialThresholdRouter:.18,partialRelease:true,
  reduceStartThreshold:.2,          // single definition (an earlier duplicate key .25 was silently overridden)
  launchBatching:true,launchScale:.45, // applied exactly once per non-COMM op; duration is reduced by the same amount
  dieDirectReduce:true,groupAck:true,readyCounter:true,dieGroupReduce:true,hierarchicalReduce:true,remoteDirectReduce:true,
  moeTokenPacking:true,attentionFusion:true,wupRouterFusion:true,outputDirectConsumer:true,
  // Resource assumptions
  matrixUtil:.88,vectorUtil:.52,
  // Shared-SRAM port scaling. These raise plan.c.sramWriteTBs / sramReadTBs above
  // what physical() sized. chargeSharedPortCost=true charges the extra bandwidth
  // as bank/port area and port power using the same TECH coefficients as
  // physical(), and re-checks the die/card limits.
  localWriteRatio:1.70,tmaDedicatedPort:true,tmaPortWriteScale:1.55,sharedReadScale:1.18,sharedReadPerWrite:.18,
  chargeSharedPortCost:true
};

// Named empirical factors. Evidence: ASSUMPTION for all entries.
const GAIN={
  // hot collectives (Attention output, Wup all-reduce, Shared output, Routed latent) after phase fusion
  hotPhaseDuration:.55,hotWire:.96,hotReadWrite:.82,hotNoc:.70,hotWorkspace:1.18,
  // hierarchical (4+4 die) reduce
  hierCardLocal:.45,hierTpReduce:.72,hierDuration:.82,
  // remote direct reduce into shared-SRAM staging
  remoteMemoryTransport:.78,remoteDuration:.82,remoteReadWrite:.82,remoteNoc:.72,
  // dieDirectReduce, groupAck, dieGroupReduce
  // (COMM ops carry memoryTransport/tpReduce/cardLocal/portTail only; the
  //  previous "dieLink" scaling on COMM ops multiplied an undefined field
  //  (NaN, masked by the service accumulator) and had no effect on duration,
  //  so it is not carried over.)
  dieDirectCardLocal:.72,dieDirectDuration:.90,
  groupAckDuration:.985,groupAckMemoryTransport:.985,
  dieGroupCardLocal:.86,dieGroupDuration:.985,
  // kernel-side: tile pipeline, partial-ready, fusions and token packing
  kernelAttention:.88,kernelLinear:.91,
  partialReadyAttention:.86,partialReadyLinear:.88,
  attentionFusion:.86,moeTokenPacking:.84,wupRouterFusion:.88
};

const HOT=/Attention output|Wup all-reduce|Shared output|Routed latent/;
const ATTN_OPS=/Online softmax|PV|Attention/;
const LINEAR_OPS=/Linear|Expert|Wup|Wdown/;
const LINEAR_ROUTER_OPS=/Linear|Expert|Wup|Wdown|Router/;
const ATTN_FUSION_OPS=/Attention (RMSNorm|QKV|RoPE|Output)/;
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
  const m=A.mappedPlan(x,1,p0);if(!m.feasible)return m;
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
  pc.batch=1;pc.depth=c.overlapDepth;pc.lUtil=c.matrixUtil;pc.hUtil=c.matrixUtil;pc.vectorUtil=c.vectorUtil;
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
  const o={feasible:true,x:{...x},p:m.p,...stats,services:m.services,localPortModel:m.localPortModel,rdmaReserveMiB:m.rdmaReserveMiB,wireBytes:m.wireBytes,requests:m.requests,phases:m.phases,protocol:m.protocol,
    localL:m.lLocalBytes/MiB,localH:m.hLocalBytes/MiB,backingGB:m.plan.backingBytes/1e9,dmaTBs:m.dmaEffective};
  if(detail){o.layers=layerStats;o.micro=m.plan.ops.filter(a=>a.layer===4).map(a=>({name:a.name,unit:a.unit,duration:a.duration,timing:a.timing,read:a.read,write:a.write}));}
  return o;
}
module.exports={OPT,GAIN,mapped,evaluate,chargeSharedPortCost};
