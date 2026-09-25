/* K3 per-operator/tile discrete-event SRAM simulator.
 * Local K3 preset is an engineering assumption, not official architecture.
 * Run tests: node test_k3_operator_sram_sim.js
 */
'use strict';
const E=require('../core/design_engine.js');
const MiB=1048576;
const DEFAULT={tp:32,batch:8,context:1048576,depth:2,prediction:.8,union:'worst',
 lTflops:262.144,hTflops:2097.152,vectorTops:69.632,lUtil:.6,hUtil:.6,vectorUtil:.25,
 expertFill:.75,memTBs:3.584,fabricTBs:4.096,sramReadTBs:64,sramWriteTBs:32,
 linkGBs:200,tauUs:1.15,collectiveFactor:2,weightTileMiB:8,kvTile:2048,headTile:8,
 microLaunchUs:.01,unpackTparams:16,margin:1.17,projectionScale:1,layerOrder:'interleaved',
 // Collective counting basis. 'reference-393' matches the reference page's
 // 393-reduction target design; 'repo-510' is the earlier repo basis. This is a
 // counting choice, NOT a physical optimization: under 'reference-393' the
 // Q/new-KV all-gather and the sampling broadcast stay in the DAG as local ops.
 countBasis:'reference-393',
 // Compute/collective overlap. false = the historical serial model: COMM and
 // compute share one running slot. true = COMM runs on its own lane; ops still
 // issue in program order, and a collective overlaps only compute ops marked
 // overlapComm (data-independent of every in-flight collective). Currently
 // only the shared experts are marked: they read the MoE RMSNorm output and
 // nothing on the routed path, so they are issued behind the Wdown + Router
 // all-gather. raw = compute + comm + wait - overlap.
 commOverlap:false,
 // Separate TMA lanes. false = each op's shared->local fill is inside its
 // duration (serial). true = ops carrying o.tma (set by the mapper) have that
 // fill issued on a per-domain (L/H) TMA lane into the domain's free
 // double-buffer half, as soon as the op's shared-SRAM inputs are ready, so it
 // can run under a collective or the previous kernel. The lane shares the
 // shared-SRAM read port and fabric with ops/collectives (DMA takes the rest)
 // and the domain's local write port with the running kernel.
 // raw = compute - tmaHidden + comm + wait - overlap.
 tmaLane:false,
 // KV context-tile prefetch scope. 'layer' = a KV tile becomes a DMA candidate
 // only once its own layer is running (historical). 'window' = KV tiles of the
 // next `depth` layers are candidates like weights; past-token KV has no
 // dependency on the current token, so only shared-SRAM capacity limits it.
 kvPrefetch:'layer',
 // DMA preemption. false = one non-preemptive DMA job at a time (historical).
 // true = DMA is striped, so a fetch the next op needs, or a routed-expert
 // demand fetch released by Top-k, may park an in-flight prefetch at a stripe
 // boundary (the residual stripe is ignored); the parked job keeps its SRAM
 // reservation and resumes in consumer order.
 dmaPreempt:false};
function build(input={}){
 const c={...DEFAULT,...input},m=E.deriveModel(E.MODEL_PRESETS.kimiK3),s=m.spec;
 if(c.tp!==32||!Number.isInteger(c.batch)||c.batch<1||!Number.isInteger(c.depth)||c.depth<0||c.depth>4||c.prediction<0||c.prediction>1||c.context%c.tp||!['worst','expected'].includes(c.union))throw Error('Invalid input / only TP32 mapped');
 for(const k of ['lTflops','hTflops','vectorTops','memTBs','fabricTBs','sramReadTBs','sramWriteTBs','linkGBs','weightTileMiB','kvTile','headTile','lUtil','hUtil','vectorUtil','expertFill','unpackTparams','margin','projectionScale'])if(!Number.isFinite(c[k])||c[k]<=0)throw Error('Invalid '+k);
 if(!['reference-393','repo-510'].includes(c.countBasis))throw Error('Invalid countBasis '+c.countBasis);
 if(typeof c.commOverlap!=='boolean')throw Error('Invalid commOverlap');
 if(typeof c.tmaLane!=='boolean')throw Error('Invalid tmaLane');
 if(!['layer','window'].includes(c.kvPrefetch))throw Error('Invalid kvPrefetch '+c.kvPrefetch);
 if(typeof c.dmaPreempt!=='boolean')throw Error('Invalid dmaPreempt');
 const B=c.batch,H=s.hidden,I=s.moe.latent,F=s.moe.expertHidden,K=s.moe.activeExperts,TP=c.tp;
 const qDim=s.attention.kvLatent+s.attention.ropeDim,vDim=s.attention.kvLatent;
 const nctx=c.context/TP,localHeads=s.attention.heads/TP;
 const U=c.union==='worst'?Math.min(s.moe.totalExperts,B*K):s.moe.totalExperts*(1-(1-K/s.moe.totalExperts)**B);
 const Q=B*s.attention.heads*qDim*2,O=B*s.attention.heads*(vDim+2)*4;
 const residual=2*B*H*2,route=B*s.moe.totalExperts*4+B*K*16;
 const hidden=3*B*K*(F/TP)*2,dispatch=B*K*I*2,out=B*K*I*4;
 const state=B*localHeads*128*128*2,comm=Math.max(2*B*H*4,2*O);
 const scratch={base:residual+MiB,
  soft:residual+Q+O+2*B*Math.min(c.headTile,s.attention.heads)*Math.min(c.kvTile,nctx)*4+MiB,
  linear:residual+Q/TP+2*state+MiB,
  moe:residual+route+hidden+dispatch+out+B*H*4+MiB,
  collective:residual+Q+O+comm+MiB};
 // A dedicated scratch arena is reserved at its maximum for deadlock-free
 // allocation. Live accounting also reports actual per-stage scratch usage.
 // With commOverlap a collective and a marked MoE op can hold their arenas at once.
 const scratchReserve=Math.max(...Object.values(scratch),c.commOverlap?scratch.collective+scratch.moe:0);
 const ops=[],jobs=[],layers=[],layerJobs=Array.from({length:s.layers},()=>[]),expertJobs=Array.from({length:s.layers},()=>[]);
 let layer=0;
 const job=(bytes,kind,category,extra={})=>{
  const j={id:jobs.length,layer,bytes,kind,category,consumer:Infinity,last:Infinity,...extra};
  jobs.push(j);layerJobs[layer].push(j.id);return j.id;
 };
 function op(name,{flops=0,unit='V',read=0,write=0,inputs=[],outputs=[],arena='base',payload=0,router=false,params=0,routed=false,detail='',overlapComm=false}={}){
  let duration,linkBytes=0;
  if(unit==='COMM'){
   linkBytes=c.collectiveFactor*payload;
   duration=Math.max(c.tauUs+linkBytes/(c.linkGBs*1e3),linkBytes/(c.sramReadTBs*1e6),linkBytes/(c.sramWriteTBs*1e6));
   read=write=linkBytes;
  }else{
   const peak=unit==='L'?c.lTflops*c.lUtil*(routed?c.expertFill:1):unit==='H'?c.hTflops*c.hUtil:c.vectorTops*c.vectorUtil;
   duration=Math.max(flops/(peak*1e6),read/(c.sramReadTBs*1e6),write/(c.sramWriteTBs*1e6),params/(c.unpackTparams*1e6))+c.microLaunchUs;
  }
  const o={id:ops.length,layer,name,unit,duration,flops,read,write,linkBytes,inputs,outputs,arena:scratch[arena],router,detail};ops.push(o);
  if(overlapComm)o.overlapComm=true;
  for(const id of inputs){jobs[id].consumer=Math.min(jobs[id].consumer,o.id);jobs[id].last=o.id;}
  for(const id of outputs){jobs[id].producer=o.id;jobs[id].consumer=o.id;jobs[id].last=o.id;}
  return o;
 }
 function matrix(name,totalParams,{routed=false,phase='base',activation=2*B*H*2,flopsParams=totalParams,overlapComm=false}={}){
  const dtype=routed?s.dtype.routed:s.dtype.dense,bytes=totalParams/TP*dtype;
  const count=Math.ceil(bytes/(c.weightTileMiB*MiB));
  for(let t=0;t<count;t++){
   const part=Math.min(c.weightTileMiB*MiB,bytes-t*c.weightTileMiB*MiB);
   const id=job(part,routed?'expert':'weight',name,{params:part/dtype});
   if(routed)expertJobs[layer].push(id);
   op(name,{unit:'L',flops:2*B*flopsParams/TP*(part/bytes),params:part/dtype,routed,
    read:part+activation,write:activation,inputs:[id],arena:phase,detail:`weight tile ${t+1}/${count}`,overlapComm});
  }
 }
 const collective=(name,payload)=>op(name,{unit:'COMM',payload,arena:'collective'});
 // Shared experts are full-hidden FFNs (expertHidden wide), not latent routed
 // experts; their Shared down output is hidden-width partial sums, like Wup's.
 // Their only input is the MoE RMSNorm output.
 const sharedExperts=overlapComm=>{
  for(let e=0;e<s.moe.sharedExperts;e++){
   matrix('Shared gate/up',2*H*F,{phase:'moe',overlapComm});
   op('Shared SiLU x up',{flops:6*B*F/TP,read:2*B*F/TP*2,write:B*F/TP*2,arena:'moe',overlapComm});
   matrix('Shared down',H*F,{phase:'moe',overlapComm});
  }
 };
 // Residual attention parameters are fitted, not official Q/K/V matrix shapes.
 const attnParams=m.params.attn/s.layers*c.projectionScale;
 for(layer=0;layer<s.layers;layer++){
  const soft=c.layerOrder==='frontloaded'?layer<24:layer%4===0;
  const first=ops.length;
  op('Attention RMSNorm',{flops:6*B*H,read:B*H*2,write:B*H*2});
  matrix(soft?'MLA Q/KV projections (fitted)':'Linear projections (fitted)',attnParams*.6);
  if(soft){
   // Counting basis: the reference page (k3_1000tps_chip_designs.html:1720)
   // counts 393 reductions for its target design; its attention sublayer counts
   // only star-1 and the LSE merge, so this all-gather is not in that total.
   // Under the reference basis it stays a local op (same bytes and dependency
   // edges, no network) rather than disappearing, so the DAG shape is unchanged.
   if(c.countBasis==='reference-393')op('Q / new-KV all-gather',{read:Q+B*qDim*2,write:Q+B*qDim*2});
   else collective('Q / new-KV all-gather',Q+B*qDim*2);
   op('RoPE',{flops:6*B*s.attention.heads*s.attention.ropeDim,read:Q,write:Q,arena:'soft'});
   const kvout=job(B*qDim*2,'write','KV append');
   op('KV append source',{read:B*qDim*2,write:B*qDim*2,outputs:[kvout],arena:'soft'});
   for(let pos=0;pos<nctx;pos+=c.kvTile){
    const len=Math.min(c.kvTile,nctx-pos),kid=job(B*len*qDim*2,'kv','KV context tile');
    for(let h=0;h<s.attention.heads;h+=c.headTile){
     const nh=Math.min(c.headTile,s.attention.heads-h),score=B*nh*len*4;
     const info=`context ${pos}..${pos+len-1}; heads ${h}..${h+nh-1}`;
     op('QK (absorbed MLA)',{unit:'H',flops:2*B*nh*len*qDim,read:jobs[kid].bytes+B*nh*qDim*2,write:score,inputs:[kid],arena:'soft',detail:info});
     op('Online softmax',{flops:8*B*nh*len,read:score,write:score,inputs:[kid],arena:'soft',detail:info});
     op('PV + rescale accumulation',{unit:'H',flops:2*B*nh*len*vDim+4*B*nh*vDim,read:jobs[kid].bytes+score,write:B*nh*vDim*4,inputs:[kid],arena:'soft',detail:info});
    }
   }
   collective('LSE merge / output reduce-scatter',O);
  }else{
   const sin=job(state,'state','Linear state read'),sout=job(state,'write','Linear state write');
   op('Linear recurrent state update',{unit:'H',flops:7*B*localHeads*128*128,read:state,write:2*state,inputs:[sin],outputs:[sout],arena:'linear'});
  }
  matrix('Attention output projection (fitted)',attnParams*.4);
  collective('Attention output all-reduce',B*H*2);
  op('Attention residual add',{flops:B*H,read:2*B*H*2,write:B*H*2});
  if(layer>0){
   op('MoE RMSNorm',{flops:6*B*H,read:B*H*2,write:B*H*2});
   matrix('Latent Wdown',H*I,{phase:'moe'});
   matrix('Router logits',H*s.moe.totalExperts,{phase:'moe'});
   collective('Wdown + Router all-gather',B*(I+s.moe.totalExperts)*2);
   // commOverlap: issue the shared experts behind the all-gather they do not need.
   if(c.commOverlap)sharedExperts(true);
   op('Top-k / route resolve',{flops:B*s.moe.totalExperts*8,read:B*s.moe.totalExperts*4,write:B*K*16,arena:'moe',router:true});
   op('Dispatch local pack',{read:B*I*2,write:dispatch,arena:'moe'});
   // All experts are TP32-sharded. Unique weights scale with U, MACs with B*K.
   matrix('Expert gate/up',U*2*I*F,{routed:true,phase:'moe',activation:dispatch+hidden,flopsParams:K*2*I*F});
   op('SiLU x up',{flops:6*B*K*F/TP,read:2*B*K*F/TP*2,write:B*K*F/TP*2,arena:'moe'});
   matrix('Expert down',U*I*F,{routed:true,phase:'moe',activation:hidden+out,flopsParams:K*I*F});
   op('Expert weighted sum',{flops:2*B*K*I,read:out,write:B*I*4,arena:'moe'});
   collective('Routed latent merge',B*I*2);
   matrix('Latent Wup',H*I,{phase:'moe'});
   if(c.countBasis!=='reference-393')collective('Wup all-reduce',B*H*2);
   if(!c.commOverlap)sharedExperts(false);
   // The reference page folds the shared expert output into its star-3 expert
   // merge (SW-05 §1.2): both Latent Wup and Shared down end in hidden-width
   // partial sums, so each rank adds them locally and issues ONE all-reduce.
   // The fold must follow the shared-expert compute; issuing it before would
   // leave the shared partial sums unreduced. Accepted 2026-09-25 (B-007).
   if(c.countBasis==='reference-393')collective('Wup + Shared output all-reduce',B*H*2);
   else collective('Shared output all-reduce',B*H*2);
   // Under the reference basis the shared output arrives already reduced, so
   // the tail is a two-way add rather than three-way.
   op('Shared + routed + residual add',{flops:2*B*H,read:(c.countBasis==='reference-393'?2:3)*B*H*2,write:B*H*2,arena:'moe'});
  }
  layers.push({layer,kind:soft?'Softmax MLA':'Linear attention',moe:layer>0,first,last:ops.length-1});
 }
 layer=s.layers-1;
 op('Final RMSNorm',{flops:6*B*H,read:B*H*2,write:B*H*2});
 matrix('LM head',m.params.lmHead);
 // Counting basis: the reference page does not count this broadcast. Confirmed
 // against references/k3_1000tps_chip_designs.html (no sampling collective).
 if(c.countBasis==='reference-393')op('Distributed sampling candidates',{read:B*TP*16,write:B*TP*16});
 else collective('Distributed sampling candidates',B*TP*16);
 op('Sampling',{flops:B*s.vocab/TP*8,read:B*s.vocab/TP*4,write:B*4});
 layers.at(-1).last=ops.length-1;
 // Explicit speculative objects: each full prediction tile contains p useful
 // bytes and (1-p) wrong bytes. Truth is revealed only at route completion.
 for(let l=1;l<s.layers;l++)for(const id of expertJobs[l]){
  layer=l;const j=jobs[id];j.pred=job(j.bytes,'prediction','Predicted '+j.category,{actual:id,consumer:j.consumer,last:j.last});
 }
 let minTransfer=0;
 for(const o of ops){const bytes=o.inputs.reduce((a,id)=>a+jobs[id].bytes,0)+o.outputs.reduce((a,id)=>a+jobs[id].bytes,0);minTransfer=Math.max(minTransfer,bytes);}
 const weightStore=(m.bytes.routedTotal+m.bytes.attn+m.bytes.wdown+m.bytes.wup+m.bytes.shared+m.bytes.router+m.bytes.lmHead)/TP;
 const stateStore=(m.softmaxLayers*c.context*m.kvPerTokenPerLayer+m.kdaStateStore)*B/TP;
 return {c,model:m,ops,jobs,layers,layerJobs,expertJobs,scratch,scratchReserve,U,minCapacity:scratchReserve+minTransfer,
  backingBytes:weightStore+stateStore,weightStore,stateStore};
}
function simulate(plan,sramMiB,{trace=false}={}){
 const {c,ops,layers,scratchReserve}=plan,S=sramMiB*MiB,pool=S-scratchReserve;
 if(S+1e-6<plan.minCapacity)return {sramMiB,feasible:false,reason:'Fixed tile + scratch does not fit',minMiB:plan.minCapacity/MiB};
 const js=plan.jobs.map(j=>({...j,status:j.kind==='expert'?'blocked':j.kind==='write'?'output':'queued',reserved:0,remaining:0,adopted:false}));
 const routed=Array(93).fill(false);routed[0]=true;
 const lane=c.commOverlap===true,tl=c.tmaLane===true;
 // TMA lanes: fillState[k] is null|'filling'|'done'; holders count the
 // double-buffer halves (two per domain) held by filled tiles until release.
 const fillState=new Array(ops.length).fill(null),fills=[],holders={L:[],H:[]},nextFill={};
 for(const dom of ['L','H']){const a=nextFill[dom]=new Int32Array(ops.length+1);a[ops.length]=ops.length;for(let k=ops.length-1;k>=0;k--)a[k]=ops[k].tma&&ops[k].tma.domain===dom?k:a[k+1];}
 let tmaPre=0,tmaExposed=0,preemptions=0;const parked=[];
 let t=0,index=0,running=null,comm=null,dma=null,used=0,peakReserved=0,peakLive=0,wait=0,compute=0,coll=0,overlap=0,dmaBusy=0;
 let readBytes=0,writeBytes=0,predBytes=0,wrongBytes=0,evictBytes=0,stallCapacityUs=0;
 let iterations=0;const layerStats=layers.map(l=>({...l,start:null,end:null,wait:0,compute:0,comm:0,readBytes:0,writeBytes:0,peak:0,operators:{}}));
 const writes=[],events=[],occupancy=[];let capacityBlocked=false;
 function record(){const live=used+(running||comm?(running?running.arena:0)+(comm?comm.arena:0):plan.scratch.base);peakLive=Math.max(peakLive,live);peakReserved=Math.max(peakReserved,used+scratchReserve);if(index<ops.length)layerStats[ops[index].layer].peak=Math.max(layerStats[ops[index].layer].peak,live);if(trace)occupancy.push({t,allocatedMiB:(used+scratchReserve)/MiB,liveMiB:live/MiB});assertCapacity();}
 function assertCapacity(){if(used<-1e-3||used>pool+1e-3)throw Error('SRAM accounting violation '+used+' pool '+pool);}
 function free(j){used-=j.reserved;j.reserved=0;}
 function required(o){let ids=[...o.inputs];for(const id of o.inputs){const j=js[id];if(j.kind==='expert'&&js[j.pred].adopted)ids.push(j.pred);}return ids;}
 function evictFor(bytes,pinned){
  if(pool-used+1e-6>=bytes)return true;
  const choices=js.filter(j=>j.status==='ready'&&j.reserved>0&&!pinned.has(j.id)&&!j.tmaPin&&j.consumer>index&&j.kind!=='write'&&
   !(j.kind==='prediction'&&j.adopted&&(pinned.has(j.actual)||(js[j.actual].status==='filling'||js[j.actual].status==='paused')))).sort((a,b)=>b.consumer-a.consumer);
  for(const j of choices){
   // Another eviction in this loop may already have freed this paired object.
   if(j.status!=='ready'||j.reserved===0)continue;
   evictBytes+=j.reserved;free(j);
   if(j.kind==='prediction'&&j.adopted){
    const actual=js[j.actual];
    // Reconstruct a full demand read when discarding an adopted hit fragment.
    evictBytes+=actual.reserved;free(actual);actual.bytes=j.bytes;actual.status='queued';
    j.adopted=false;j.status='cancelled';
   }else j.status='queued';
   if(pool-used+1e-6>=bytes)return true;
  }
  return pool-used+1e-6>=bytes;
 }
 function route(l){
  routed[l]=true;
  for(const id of plan.expertJobs[l]){
   const a=js[id],p=js[a.pred];
   if((p.status==='ready'||p.status==='filling'||p.status==='paused')&&c.prediction>0){
    p.adopted=true;a.bytes=(1-c.prediction)*a.bytes;
    if(p.status==='ready'){const wrong=p.reserved*(1-c.prediction);p.reserved-=wrong;used-=wrong;wrongBytes+=wrong;}
   }else{if(p.status==='ready'){wrongBytes+=p.reserved;free(p);}if(p.status!=='filling'&&p.status!=='paused')p.status='cancelled';}
   a.status=a.bytes<1e-8?'ready':'queued';
  }
 }
 function finishDMA(){
  const j=dma;dma=null;j.status='ready';
  if(j.kind==='write'){free(j);j.status='done';}
  else if(j.kind==='prediction'&&routed[j.layer]){
   if(j.adopted){const wrong=j.reserved*(1-c.prediction);used-=wrong;j.reserved-=wrong;wrongBytes+=wrong;}
   else{wrongBytes+=j.reserved;free(j);j.status='cancelled';}
  }
  if(trace)events.push({type:'DMA end',t,job:j.id,layer:j.layer,category:j.category});
 }
 function finishOp(){
  const o=running;running=null;
  for(const id of required(o)){const j=js[id];if(j.last===o.id){free(j);j.status='done';}}
  for(const id of o.outputs){js[id].status='queued';writes.push(id);}
  if(o.router)route(o.layer);
  if(tl)for(const dom of ['L','H'])holders[dom]=holders[dom].filter(h=>h.release!==o.id);
  const stat=layerStats[o.layer];if(o.id===layers[o.layer].last)stat.end=t;
  index++;record();
 }
 function finishComm(){
  const o=comm;comm=null;
  if(trace)events.push({type:'COMM end',t,index:o.id,layer:o.layer,name:o.name});
  record();
 }
 function tryOp(){
  // In-order issue: o's producers precede it, so they have finished once the
  // compute slot is free. Unmarked ops may consume an in-flight collective.
  if(running||index>=ops.length||comm&&!ops[index].overlapComm)return false;
  const o=ops[index],async=lane&&o.unit==='COMM',stat=layerStats[o.layer];if(stat.start===null)stat.start=t;
  const ids=required(o),pinned=new Set(ids);
  if(ids.some(id=>js[id].status!=='ready'))return false;
  const filled=tl&&o.tma;if(filled&&fillState[o.id]!=='done')return false;
  const bytes=o.outputs.reduce((sum,id)=>sum+js[id].bytes,0);
  if(!evictFor(bytes,pinned)){capacityBlocked=true;return false;}
  for(const id of o.outputs){const j=js[id];j.reserved=j.bytes;used+=j.bytes;}
  if(filled){for(const id of ids)js[id].tmaPin=false;tmaPre+=o.tma.us;}
  const body=filled?Math.max(0,o.duration-o.tma.us):o.duration,moved=filled?o.tma.bytes:0;
  if(async){comm={...o,end:t+o.duration};index++;}else running={...o,duration:body,read:o.read-moved,linkBytes:o.linkBytes-moved,end:t+body};
  if(o.unit==='COMM'){coll+=o.duration;stat.comm+=o.duration;}else{compute+=o.duration;stat.compute+=o.duration;}
  const a=stat.operators[o.name]||(stat.operators[o.name]={name:o.name,unit:o.unit,count:0,flops:0,read:0,write:0,service:0,wait:0});a.count++;a.flops+=o.flops;a.read+=o.read;a.write+=o.write;a.service+=o.duration;
  if(trace)events.push({type:'op',layer:o.layer,index:o.id,name:o.name,start:t,end:t+body,detail:o.detail});
  record();return true;
 }
 function startFills(){
  // One fill per domain lane, in program order: only the domain's next filled
  // op, only into a free buffer half, only once its shared-SRAM inputs are ready.
  for(const dom of ['L','H']){
   if(fills.some(f=>f.dom===dom))continue;
   let k=nextFill[dom][Math.min(running?index+1:index,ops.length)];
   while(k<ops.length&&fillState[k]==='done')k=nextFill[dom][k+1];
   if(k>=ops.length)continue;
   const o=ops[k];
   if(holders[dom].reduce((a,h)=>a+h.halves,0)+o.tma.halves>2)continue;
   const ids=required(o);if(ids.some(id=>js[id].status!=='ready'))continue;
   for(const id of ids)js[id].tmaPin=true;
   fillState[k]='filling';holders[dom].push({op:k,release:o.tma.release,halves:o.tma.halves});
   fills.push({op:k,dom,remaining:o.tma.us,rate:o.tma.bytes/o.tma.us,speed:0});
   if(trace)events.push({type:'TMA start',t,index:k,layer:o.layer,name:o.name,domain:dom});
  }
 }
 function fillSpeeds(){
  // Fills get what the running op and the collective leave of the shared-SRAM
  // read port and the fabric, and what a same-domain kernel leaves of the
  // local write port. Nominal speed 1 reproduces the mapper's fill time.
  const act=[running,comm].filter(Boolean);
  const opRead=act.reduce((a,o)=>a+o.read/o.duration,0),link=act.reduce((a,o)=>a+o.linkBytes/o.duration,0);
  const demand=fills.reduce((a,f)=>a+f.rate,0);
  const shared=demand?Math.max(0,Math.min(1,(c.sramReadTBs*1e6-opRead)/demand,(c.fabricTBs*1e6-link)/demand)):1;
  for(const f of fills){
   let local=1;const r=running&&running.mapping;
   if(r&&r.domain===f.dom&&r.localWriteBytes!==undefined){
    const w=(r.localWriteBytes-(running.tma?running.tma.bytes:0))/running.duration;
    local=Math.max(0,Math.min(1,(ops[f.op].tma.localWriteTBs*1e6-w)/f.rate));
   }
   f.speed=Math.min(shared,local);
  }
 }
 function preempt(){
  // Only a prefetch (not needed by the op at the head of the queue, not a write) is parked.
  const o=ops[index];if(!o||dma.kind==='write')return;
  const need=required(o);if(need.includes(dma.id))return;
  let u=need.map(id=>js[id]).find(j=>j.status==='queued');
  if(!u)u=js.filter(j=>j.kind==='expert'&&j.status==='queued'&&j.consumer<dma.consumer).sort((a,b)=>a.consumer-b.consumer)[0];
  if(!u||u.consumer>=dma.consumer||u.bytes>pool-used+1e-6)return;
  const j=dma;j.status='paused';parked.push(j);dma=null;preemptions++;
  if(trace)events.push({type:'DMA park',t,job:j.id,layer:j.layer,category:j.category,remaining:j.remaining});
  startDMA(u);
 }
 function resume(j){
  parked.splice(parked.indexOf(j),1);j.status='filling';dma=j;
  if(trace)events.push({type:'DMA resume',t,job:j.id,layer:j.layer,category:j.category,remaining:j.remaining});record();
 }
 function selectDMA(){
  if(dma){if(c.dmaPreempt)preempt();return;}
  const o=ops[index],need=o?required(o):[],pinned=new Set(need);
  const p0=need.map(id=>js[id]).find(j=>j.status==='paused');if(p0){resume(p0);return;}
  // Pending writebacks own space already; drain first, bounded by one tile.
  let id=writes.find(id=>js[id].status==='queued');
  if(id===undefined)id=need.find(id=>js[id].status==='queued');
  if(id!==undefined){const j=js[id];if(j.kind!=='write'&&!evictFor(j.bytes,pinned)){capacityBlocked=true;return;}startDMA(j);return;}
  if(!o)return;
  const endLayer=Math.min(92,o.layer+c.depth),candidates=[];
  for(let l=o.layer;l<=endLayer;l++)for(const jid of plan.layerJobs[l]){
   const j=js[jid];if(j.status!=='queued'||j.consumer<index||j.kind==='write')continue;
   if(j.kind==='prediction'&&(c.depth===0||routed[l]))continue;
   if(j.kind==='kv'&&l!==o.layer&&c.kvPrefetch==='layer')continue; // KV next tile within current layer only
   if(j.kind==='prediction'&&js[j.actual].status!=='blocked')continue;
   candidates.push(j);
  }
  // Parked prefetches already own their space; they resume in consumer order.
  for(const j of parked)candidates.push(j);
  // Consumer order, not oracle hit order; all prediction bytes include wrong data.
  candidates.sort((a,b)=>a.consumer-b.consumer||a.id-b.id);
  for(const j of candidates){if(j.status==='paused'){resume(j);return;}if(j.bytes<=pool-used+1e-6){startDMA(j);return;}}
  if(candidates.length)capacityBlocked=true;
 }
 function startDMA(j){
  if(j.kind!=='write'){j.reserved=j.bytes;used+=j.bytes;}
  j.status='filling';j.remaining=j.bytes;dma=j;
  if(trace)events.push({type:'DMA start',t,job:j.id,layer:j.layer,category:j.category,bytes:j.bytes});record();
 }
 function dmaRate(){
  if(!dma)return 0;
  const act=[running,comm].filter(Boolean);
  const tma=fills.reduce((a,f)=>a+f.rate*f.speed,0);
  const opRead=act.reduce((a,o)=>a+o.read/o.duration,0)+tma,opWrite=act.reduce((a,o)=>a+o.write/o.duration,0);
  const commFabric=act.reduce((a,o)=>a+o.linkBytes/o.duration,0)+tma;
  const port=dma.kind==='write'?c.sramReadTBs*1e6-opRead:c.sramWriteTBs*1e6-opWrite;
  return Math.max(0,Math.min(c.memTBs*1e6,c.fabricTBs*1e6-commFabric,port));
 }
 while(index<ops.length||comm||dma||parked.length||fills.length||writes.some(id=>js[id].status==='queued')){
  if(++iterations>ops.length*30+js.length*30)throw Error('Event loop bound');
  capacityBlocked=false;while(tryOp());if(tl)startFills();selectDMA();
  if(tl)fillSpeeds();
  const rate=dmaRate(),endOp=running?running.end:Infinity,endComm=comm?comm.end:Infinity,endDma=dma&&rate>1e-9?t+dma.remaining/rate:Infinity;
  const endFill=fills.reduce((a,f)=>f.speed>1e-12?Math.min(a,t+f.remaining/f.speed):a,Infinity);
  const next=Math.min(endOp,endComm,endDma,endFill);
  if(!Number.isFinite(next))throw Error('Deadlock '+JSON.stringify({index,t,used,pool,need:ops[index]&&required(ops[index]).map(id=>[id,js[id].status,js[id].bytes]),dma:dma&&dma.id}));
  const dt=Math.max(0,next-t);
  // An op waiting only on its own in-flight fill occupies the compute slot
  // (exposed TMA), unless it is held back by a collective it depends on.
  const head=!running&&index<ops.length?ops[index]:null;
  const exposed=!!(tl&&head&&head.tma&&fillState[head.id]==='filling'&&!(comm&&!head.overlapComm));
  const busy=!!running||exposed;
  if(exposed)tmaExposed+=dt;
  for(const f of fills)f.remaining-=dt*f.speed;
  if(busy&&comm)overlap+=dt;
  if(!busy&&!comm){wait+=dt;if(index<ops.length){const st=layerStats[ops[index].layer];st.wait+=dt;const op=ops[index],a=st.operators[op.name]||(st.operators[op.name]={name:op.name,unit:op.unit,count:0,flops:0,read:0,write:0,service:0,wait:0});a.wait+=dt;}}
  if(capacityBlocked)stallCapacityUs+=dt;
  if(dma&&rate>0){const transferred=Math.min(dma.remaining,dt*rate);dma.remaining-=transferred;dmaBusy+=dt;
   const st=layerStats[dma.layer];if(dma.kind==='write'){writeBytes+=transferred;st.writeBytes+=transferred;}else{readBytes+=transferred;st.readBytes+=transferred;if(dma.kind==='prediction')predBytes+=transferred;}}
  t=next;
  if(dma&&dma.remaining<1e-3)finishDMA();
  for(let i=fills.length-1;i>=0;i--)if(fills[i].remaining<=1e-9){const f=fills.splice(i,1)[0];fillState[f.op]='done';if(trace)events.push({type:'TMA end',t,index:f.op,domain:f.dom});}
  if(comm&&comm.end<=t+1e-9)finishComm();
  if(running&&running.end<=t+1e-9)finishOp();
 }
 // No background operations may be dropped at the end; all DMA is drained.
 // compute counts each op's full service; a fill that ran while the slot was
 // otherwise occupied (or idle behind a collective) is hidden.
 const tmaHidden=tmaPre-tmaExposed;
 if(Math.abs(t-(compute-tmaHidden+coll+wait-overlap))>1e-5)throw Error('Timeline conservation');
 for(const st of layerStats){st.duration=st.end-st.start;st.peakMiB=st.peak/MiB;delete st.peak;}
 return {sramMiB,feasible:true,rawUs:t,e2eUs:t*c.margin,tps:1e6/(t*c.margin),tokensPerSecond:c.batch*1e6/(t*c.margin),
  computeUs:compute,commUs:coll,waitUs:wait,overlapUs:overlap,tmaFillUs:tmaPre,tmaExposedUs:tmaExposed,tmaHiddenUs:tmaHidden,dmaPreemptions:preemptions,dmaBusyUs:dmaBusy,readBytes,writeBytes,predBytes,wrongBytes,evictBytes,stallCapacityUs,
  peakReservedMiB:peakReserved/MiB,peakLiveMiB:peakLive/MiB,scratchMiB:scratchReserve/MiB,minMiB:plan.minCapacity/MiB,
  layerStats,events,occupancy};
}
module.exports={DEFAULT,MiB,build,simulate};
if(require.main===module){const p=build();console.log('ops',p.ops.length,'jobs',p.jobs.length,'minMiB',p.minCapacity/MiB);for(const S of [24,64,288,768]){const r=simulate(p,S);console.log(S,r.tps,r.waitUs,r.peakReservedMiB,r.reason);}}
