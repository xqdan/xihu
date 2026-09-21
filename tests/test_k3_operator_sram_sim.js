'use strict';
const assert=require('assert'),{build,simulate,DEFAULT,MiB}=require('../src/simulation/k3_operator_sram_sim.js');
function tiny(two=false){
 const ops=[0,...(two?[1]:[])].map(i=>({id:i,layer:0,name:'compute',unit:'L',duration:two?20:5,flops:0,read:0,write:0,linkBytes:0,inputs:[i],outputs:[],arena:0,router:false,detail:''}));
 const jobs=ops.map(o=>({id:o.id,layer:0,bytes:100,kind:'weight',category:'weight',consumer:o.id,last:o.id}));
 return {c:{...DEFAULT,depth:0,memTBs:.00001,fabricTBs:1,sramReadTBs:1,sramWriteTBs:1},ops,jobs,layers:[{layer:0,kind:'test',first:0,last:ops.length-1}],layerJobs:[jobs.map(j=>j.id)],expertJobs:[[]],scratch:{base:0},scratchReserve:0,minCapacity:100};
}
assert(Math.abs(simulate(tiny(),1).rawUs-15)<1e-9,'100 bytes / 10 bytes/us + 5us compute');
assert(Math.abs(simulate(tiny(true),1).rawUs-50)<1e-9,'second DMA hidden by first compute');
assert(Math.abs(simulate(tiny(true),100/MiB).rawUs-60)<1e-9,'one buffer forces two serial reads');
assert(!simulate(tiny(),99/MiB).feasible);
let cases=0;
for(const batch of [1,8])for(const depth of [0,2])for(const prediction of [0,.8,1]){
 const p=build({batch,depth,prediction});
 assert.equal(p.layers.length,93);assert.equal(p.layers.filter(l=>l.kind==='Softmax MLA').length,24);
 assert.equal(p.layers.filter(l=>l.kind==='Linear attention').length,69);assert.equal(p.layers.filter(l=>l.moe).length,92);
 const routes=p.ops.filter(o=>o.router);assert.equal(routes.length,92);
 assert(p.ops.every(o=>o.inputs.every(id=>p.jobs[id].consumer<=o.id&&p.jobs[id].last>=o.id)));
 for(const S of [32,64,192,288,768]){
  const r=simulate(p,S);assert(r.feasible);
  assert(r.peakReservedMiB<=S+1e-7);assert(r.peakLiveMiB<=r.peakReservedMiB+1e-7);
  assert(Math.abs(r.rawUs-r.computeUs-r.commUs-r.waitUs)<1e-5);
  assert(r.rawUs+1e-6>=(r.readBytes+r.writeBytes)/(p.c.memTBs*1e6));
  assert(r.layerStats.every(l=>l.duration>=-1e-9&&l.start!==null&&l.end!==null));
  if(depth===0)assert.equal(r.predBytes,0);
  if(prediction===1)assert.equal(r.wrongBytes,0);
  if(depth===0&&S===768){
   const read=p.jobs.filter(j=>['weight','expert','kv','state'].includes(j.kind)).reduce((a,j)=>a+j.bytes,0);
   const write=p.jobs.filter(j=>j.kind==='write').reduce((a,j)=>a+j.bytes,0);
   assert(Math.abs(r.readBytes-read)/read<1e-10,'mandatory reads conserved');
   assert(Math.abs(r.writeBytes-write)/write<1e-10,'writes conserved');
  }
  cases++;
 }
}
assert.throws(()=>build({batch:0}));assert.throws(()=>build({tp:24}));
console.log('PASS analytic 1/2-buffer timing tests, topology checks and',cases,'full 93-layer runs');
