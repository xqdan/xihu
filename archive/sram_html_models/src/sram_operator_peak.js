/* Conditional SRAM capacity accounting; no latency/throughput prediction.
 * TP=32 is independent of the legacy TP=24 chart and divides 128 query heads.
 * Capacities are usable data bytes, excluding physical ECC/spares.
 */
(function(root){
'use strict';
const MiB=1048576;
function estimate(p,{batch=8,depth=2,context=1048576,tp=32,kvTile=2048,weightTileMiB=8,reserve=.25,routing="worst"}={}){
 if(!Number.isInteger(batch)||batch<1||!Number.isInteger(depth)||depth<0||depth>4||context<1||kvTile<1||weightTileMiB<=0||reserve<0||!Number.isInteger(tp)||tp<1||p.attention.heads%tp) throw Error('Invalid peak estimator inputs');
 const B=batch,H=p.hidden,a=p.attention,m=p.moe,T=Math.min(kvTile,context),heads=a.heads/tp;
 const localKvHeads=a.kind==='mla'?0:Math.max(1,Math.ceil(a.kvHeads/tp));
 // MLA latent cache replicated across TP; GQA at least one KV head per rank.
 const kvDim=a.kind==='mla'?a.kvLatent+a.ropeDim:localKvHeads*(a.qkHeadDim+a.vHeadDim);
 const U=m.totalExperts*(1-Math.pow(1-m.activeExperts/m.totalExperts,B));
 if(!['worst','expected'].includes(routing)) throw Error('Invalid routing mode');
 const predicted=routing==='worst'?Math.min(m.totalExperts,B*m.activeExperts):Math.ceil(U),input=m.expertInput==='latent'?m.latent:H;
 const expertBytes=3*input*m.expertHidden*p.dtype.routed/tp;
 const spec=depth*predicted*expertBytes;
 const residual=2*B*H*2; // old/new residual and norm; no aliasing credited
 const q=B*heads*a.qkHeadDim*2;
 const attentionStats=B*heads*(a.vHeadDim+2)*4;
 const score=2*B*heads*T*4; // distinct score/prob buffers, conservative
 const kv=2*B*T*kvDim*2;
 const kvWrite=B*kvDim*2;
 const route=B*m.totalExperts*4+B*m.activeExperts*16;
 const dispatch=B*m.activeExperts*input*2;
 const hidden=3*B*m.activeExperts*Math.ceil(m.expertHidden/tp)*2;
 const output=B*m.activeExperts*input*4;
 const shared=3*B*Math.ceil(m.expertHidden/tp)*2+B*H*4;
 // Multiple shared experts execute serially and accumulate into one output.
 // Hybrid linear-attention state: stream BF16 state from backing memory,
 // keeping two transfer buffers plus one FP32 current-layer update buffer.
 const la=p.linearAttention||{layers:0,stateDim:0};
 const stateElems=la.layers>0?B*heads*la.stateDim*la.stateDim:0;
 const linearStateIO=2*stateElems*2,linearStateUpdate=stateElems*4;
 const comm=Math.max(2*B*H*4,2*attentionStats);
 const weight=2*weightTileMiB*MiB,meta=MiB;
 const stageDefs=[
 ['投影 / RoPE',{weight,kvWrite,q,residual}],
 ['QK → Softmax → PV',{weight,kv,kvWrite,q,score,attentionStats,residual}],
 ['O projection / Attention 归约',{weight,q,attentionStats,residual,comm}],
 ['Router / Dispatch',{weight,residual,route,dispatch}],
 ['Expert gate/up → SiLU → down',{weight,residual,route,dispatch,hidden,output}],
 ['Shared / Merge / MoE 归约',{weight,residual,route,output,shared,comm}]
 ];
 if(la.layers>0) stageDefs.splice(2,0,['线性 Attention 状态更新',{weight,q,residual,linearStateIO,linearStateUpdate}]);
 const stages=stageDefs.map(([name,parts])=>{parts={...parts,spec,meta};return {name,parts,bytes:Object.values(parts).reduce((x,y)=>x+y,0)};});
 const peak=stages.reduce((x,y)=>x.bytes>=y.bytes?x:y);
 // Static pools cannot reuse SRAM across phases; compare with a unified allocator.
 const keys=[...new Set(stages.flatMap(s=>Object.keys(s.parts)))];
 const staticBytes=keys.reduce((sum,k)=>sum+Math.max(...stages.map(s=>s.parts[k]||0)),0);
 return {name:p.name,batch,depth,tp,T,predicted,U,expertBytes,stages,peak,staticBytes,
  linearStateBackingBytes:la.layers*stateElems*2,
  usableMiB:peak.bytes/MiB,withReserveMiB:peak.bytes/MiB*(1+reserve),
  provisionMiB:Math.ceil(peak.bytes/MiB*(1+reserve)/32)*32,
  staticProvisionMiB:Math.ceil(staticBytes/MiB*(1+reserve)/32)*32};
}
const api={estimate,MiB};if(typeof module==='object'&&module.exports)module.exports=api;else root.SramOperatorPeak=api;
})(typeof window!=='undefined'?window:globalThis);
