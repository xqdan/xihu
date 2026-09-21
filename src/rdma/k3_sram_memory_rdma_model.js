/* SRAM-addressable one-sided RDMA model. All timing constants are design
 * assumptions, NOT properties guaranteed by RDMA memory semantics. */
'use strict';
const A=require('../search/k3_architecture_search.js');
const {simulate,MiB}=require('../simulation/k3_operator_sram_sim.js');
const MEM={oneWayUs:.10,issueCycles:4,rxCycles:24,commitCycles:8,notifyCycles:8,
 ackCycles:16,outstandingPerNIC:32,headerBytes:64,flagBytes:16,packetAlign:64,
 stripeKiB:16,qpContextBytes:256,wqeCqeBytes:128,epochs:2};
function config(overrides={}){const c={...MEM,...overrides};for(const[k,v]of Object.entries(c))if(!Number.isFinite(v)||v<0)throw Error('Invalid RDMA '+k);for(const k of ['issueCycles','outstandingPerNIC','stripeKiB','packetAlign','epochs'])if(c[k]<=0||!Number.isInteger(c[k]))throw Error('Invalid RDMA '+k);return c;}
const align=(n,a)=>Math.ceil(n/a)*a;
// A verification model for epoch-owned SRAM receive slots. WRITE != READY
// until commit, and READY != FREE until the consumer and all ACKs finish.
class Mailbox {
 constructor(ranks=32){this.ranks=ranks;this.active=false;this.epoch=-1;}
 begin(epoch){if(this.active||epoch<=this.epoch)throw Error('epoch reuse/ABA');this.active=true;this.epoch=epoch;this.slots=Array(this.ranks).fill(null);this.committed=new Set();this.acked=new Set();this.consumed=false;}
 write(epoch,rank,data){if(!this.active||epoch!==this.epoch||!Number.isInteger(rank)||rank<0||rank>=this.ranks||this.slots[rank]!==null)throw Error('invalid/overlapping write');this.slots[rank]=Array.from(data);}
 commit(epoch,rank){if(epoch!==this.epoch||!this.active||this.slots[rank]===null)throw Error('commit before write');this.committed.add(rank);}
 ack(epoch,rank){if(epoch!==this.epoch||!this.committed.has(rank))throw Error('ack before visible');this.acked.add(rank);}
 consume(){if(!this.active||this.committed.size!==this.ranks)throw Error('consumer before acquire');this.consumed=true;return this.slots.map(a=>a.slice());}
 release(){if(!this.active||!this.consumed||this.acked.size!==this.ranks)throw Error('free before consume/ACK');this.active=false;}
}
function lseMerge(tuples){
 const M=Math.max(...tuples.map(t=>t.m)),a=tuples.map(t=>Math.exp(t.m-M)*t.l),L=a.reduce((s,v)=>s+v,0);
 if(!(L>0))throw Error('invalid softmax normalizer');
 return {m:M,l:L,o:tuples[0].o.map((_,i)=>tuples.reduce((s,t,j)=>s+a[j]*t.o[i],0)/L)};
}
// One balanced all-to-all phase. Each active NIC issues to 31 peer ranks;
// peer writes target disjoint source-rank slots in the destination SRAM.
// Credit returns only after the write is visible and ACK arrives. Phase end
// conservatively drains ACKs; no hidden dropped in-flight writes.
function phase(bytesPerMessage,activeNICs,p,x,c=MEM,{trace=false}={}){
 const peers=31,issue=c.issueCycles/(x.ghz*1000);
 const packet=align(bytesPerMessage+c.headerBytes+c.flagBytes,c.packetAlign);
 const networkGBs=Math.min(p.rdmaDieGB,A.LIMITS.networkGBs/activeNICs);
 const serialization=Math.max(packet/(networkGBs*1000),bytesPerMessage/(p.sharedRead*1e6),(bytesPerMessage+c.flagBytes)/(p.sharedWrite*1e6),(2*bytesPerMessage+c.flagBytes)/(p.nocTB*1e6));
 const visibleLag=c.oneWayUs+(c.rxCycles+c.commitCycles+c.notifyCycles)/(x.ghz*1000);
 let issueFree=0,wireFree=0,ready=0,drained=0;const outstanding=[],events=[];
 for(let rank=0;rank<peers;rank++){
  let at=issueFree;
  while(outstanding.length>=c.outstandingPerNIC){outstanding.sort((a,b)=>a-b);at=Math.max(at,outstanding.shift());while(outstanding.length&&outstanding[0]<=at)outstanding.shift();}
  const issued=at+issue,start=Math.max(issued,wireFree),end=start+serialization;
  const visible=end+visibleLag,ack=visible+c.oneWayUs+c.ackCycles/(x.ghz*1000);
  outstanding.push(ack);issueFree=issued;wireFree=end;ready=Math.max(ready,visible);drained=Math.max(drained,ack);
  if(trace)events.push({peer:rank,issue:at,sendStart:start,sendEnd:end,visible,ack});
 }
 const requests=peers*activeNICs,logicalBytes=bytesPerMessage*requests,flags=c.flagBytes*requests;
 return {duration:Math.max(ready,drained),ready,drained,requests,logicalBytes,wireBytes:packet*requests,readBytes:logicalBytes,writeBytes:logicalBytes+flags,nocBytes:2*logicalBytes+flags,events};
}
function collective(name,logicalPayload,p,x,c=MEM,trace=false){
 const TP=32,D=8,isLse=name.includes('LSE'),isGather=name.includes('all-gather')||name.includes('sampling');
 const kind=isLse?'LSE reduce-scatter':isGather?'all-gather':'FP32 reduce-scatter + BF16 all-gather';
 const activeNICs=isLse?3:Math.min(D,Math.max(1,Math.ceil(logicalPayload/(c.stripeKiB*1024))));
 const transportBytes=isGather||isLse?logicalPayload:2*logicalPayload;
 const first=phase(transportBytes/TP/activeNICs,activeNICs,p,x,c,{trace});
 const phases=[first];if(!isGather&&!isLse)phases.push(phase(logicalPayload/TP/activeNICs,activeNICs,p,x,c,{trace}));
 let reduceUs=0,vectorUs=0,reduceRead=0,reduceWrite=0;
 if(!isGather){
  reduceRead=transportBytes;reduceWrite=transportBytes/TP;
  let reduceOps=(TP-1)*(transportBytes/4/TP);
  if(isLse){
   // Each rank owns 3 whole heads. Metadata is merged with max/exp/sum;
   // then FP32 O is weighted and normalized, NOT a plain FP32 SUM.
   const heads=3,dims=512;
   const vectorOps=heads*(TP*8+TP*dims+dims);
   const vectorTOP=activeNICs*x.nH*x.vectorLanes*2*x.ghz/1000*A.TECH.vectorUtil;
   vectorUs=vectorOps/(vectorTOP*1e6);
   reduceOps=heads*((TP-1)*dims+(TP-1)*2);
   reduceRead*=2;reduceWrite*=2;
  }
  reduceUs=Math.max(reduceOps/(activeNICs*p.reduceTOP*1e6),reduceRead/(activeNICs*p.sharedRead*1e6),reduceWrite/(activeNICs*p.sharedWrite*1e6));
 }
 // Deliberately retain the previous intra-card merge budget; direct SRAM
 // does not eliminate reduction/redistribution between the eight dies.
 const cardLocal=6*A.TECH.ucieHopUs+logicalPayload*2/(p.dieCutGB*1000)+logicalPayload/4*2/(D*p.reduceTOP*1e6)+p.meshSide*A.TECH.routerCycles/(x.ghz*1000);
 const memoryTransport=phases.reduce((s,a)=>s+a.duration,0);
 const tx=phases.reduce((s,a)=>s+a.wireBytes,0),reads=phases.reduce((s,a)=>s+a.readBytes,0)+reduceRead+logicalPayload*2;
 const writes=phases.reduce((s,a)=>s+a.writeBytes,0)+reduceWrite+logicalPayload*2;
 const noc=phases.reduce((s,a)=>s+a.nocBytes,0)+reduceRead+reduceWrite+logicalPayload*2;
 const raw=memoryTransport+reduceUs+vectorUs+cardLocal;
 const resourceFloor=Math.max(reads/(D*p.sharedRead*1e6),writes/(D*p.sharedWrite*1e6),noc/(D*p.nocTB*1e6));
 const portTail=Math.max(0,resourceFloor-raw);
 const queueBytes=D*(31*c.qpContextBytes+c.outstandingPerNIC*c.wqeCqeBytes);
 // Conservative disjoint TX/input, 32 receive slots, final-output and flags;
 // epoch ping-pong cannot be double-counted as reusable weight SRAM.
 const mailboxBytes=c.epochs*(transportBytes*2+logicalPayload+TP*activeNICs*64);
 return {kind,activeNICs,logicalPayload,transportBytes,phases:phases.length,phaseDetail:trace?phases:undefined,
  wireBytes:tx,readBytes:reads,writeBytes:writes,nocBytes:noc,requests:phases.reduce((s,a)=>s+a.requests,0),
  workspace:queueBytes+mailboxBytes,queueBytes,mailboxBytes,
  timing:{memoryTransport,tpReduce:reduceUs+vectorUs,cardLocal,portTail},duration:raw+portTail};
}
function mapped(x,overrides={}){
 const c=config(overrides),p=A.physical(x);if(!p.feasible)return {feasible:false,reasons:p.reasons};
 const m=A.mappedPlan(x,1,p);if(!m.feasible)return m;
 let reserve=0,wireBytes=0,requests=0,phases=0;const protocol={};
 for(const o of m.plan.ops)if(o.unit==='COMM'){
  const q=collective(o.name,o.mapping.payload,p,x,c);reserve=Math.max(reserve,q.workspace);
  o.duration=q.duration;o.read=q.readBytes;o.write=q.writeBytes;o.linkBytes=q.nocBytes;o.timing=q.timing;o.memory=q;
  wireBytes+=q.wireBytes;requests+=q.requests;phases+=q.phases;
  const a=protocol[o.name]||(protocol[o.name]={name:o.name,kind:q.kind,count:0,phases:0,requests:0,wireBytes:0,timeUs:0,workspace:0});
  a.count++;a.phases+=q.phases;a.requests+=q.requests;a.wireBytes+=q.wireBytes;a.timeUs+=q.duration;a.workspace=Math.max(a.workspace,q.workspace);
 }
 m.plan.scratchReserve+=reserve;
 m.plan.minCapacity+=reserve;
 // Reserve the RDMA receive window once as a dedicated pool.  Do not add it
 // to every operator arena: that would count the same live mailbox once per
 // op and inflate the peak SRAM accounting.
 m.plan.rdmaReserve=reserve;
 if(m.window*MiB<m.plan.minCapacity)return {feasible:false,reasons:['shared window including RDMA epochs'],minMiB:m.plan.minCapacity/MiB};
 const services={};for(const o of m.plan.ops)for(const[k,v]of Object.entries(o.timing))services[k]=(services[k]||0)+v;
 return {...m,p,c,services,rdmaReserveMiB:reserve/MiB,wireBytes,requests,phases,protocol:Object.values(protocol)};
}
function evaluate(x,{detail=false,mem={}}={}){
 const m=mapped(x,mem);if(!m.feasible)return m;
 const r=simulate(m.plan,m.window);if(!r.feasible)return r;
 const {layerStats,events,occupancy,...stats}=r;
 const out={feasible:true,x:{...x},p:m.p,...stats,services:m.services,rdmaReserveMiB:m.rdmaReserveMiB,wireBytes:m.wireBytes,requests:m.requests,phases:m.phases,protocol:m.protocol,
 localL:m.lLocalBytes/MiB,localH:m.hLocalBytes/MiB,backingGB:m.plan.backingBytes/1e9,dmaTBs:m.dmaEffective};
 if(detail){out.layers=layerStats;out.micro=m.plan.ops.filter(o=>o.layer===4).map(o=>({name:o.name,unit:o.unit,duration:o.duration,timing:o.timing,read:o.read,write:o.write}));}
 return out;
}
module.exports={MEM,config,Mailbox,lseMerge,phase,collective,mapped,evaluate};
