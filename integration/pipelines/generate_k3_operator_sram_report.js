'use strict';
process.chdir(require('path').resolve(__dirname,'../..')); // paths below are relative to the repository root
const fs=require('fs'),crypto=require('crypto'),{DEFAULT,MiB,build,simulate}=require('../detailed/k3_operator_sram_sim.js');
const sizes=[16,24,32,48,64,96,128,160,192,224,256,288,320,384,512,768,1056];
const batches=[1,8],sweeps={},plans={},details={};
const summary=r=>{const {layerStats,events,occupancy,...rest}=r;return rest;};
for(const batch of batches){
 const p=build({batch});plans[batch]={config:p.c,scratch:p.scratch,scratchMiB:p.scratchReserve/MiB,minMiB:p.minCapacity/MiB,union:p.U,ops:p.ops.length,jobs:p.jobs.length,backingGB:p.backingBytes/1e9,weightGB:p.weightStore/1e9,stateGB:p.stateStore/1e9};
 const raw=sizes.map(S=>summary(simulate(p,S)));let best=null;
 const tuned=raw.map(r=>{if(r.feasible&&(!best||r.rawUs<best.rawUs))best=r;return best?{physicalMiB:r.sramMiB,windowMiB:best.sramMiB,tps:best.tps,rawUs:best.rawUs,computeUs:best.computeUs,commUs:best.commUs,waitUs:best.waitUs}: {physicalMiB:r.sramMiB,feasible:false};});
 sweeps[batch]={raw,tuned};
}
for(const [batch,S] of [[1,96],[8,32],[8,64],[8,192],[8,288],[8,768]]){
 const p=build({batch}),r=simulate(p,S,{trace:true});
 const layerBreaks=new Set([0,1,4,92]);
 details[`${batch}_${S}`]={...summary(r),batch,layerStats:r.layerStats,
  sampleEvents:r.events.filter(e=>layerBreaks.has(e.layer)),
  occupancy:r.occupancy.filter((v,i,a)=>i===0||i===a.length-1||i%Math.max(1,Math.floor(a.length/1000))===0)};
}
const tests=[
 ['参考配置',{}],['预测准确率 p=0.5',{prediction:.5}],['预测准确率 p=1.0',{prediction:1}],
 ['不做专家预测 D=0',{depth:0}],['仅看未来一层 D=1',{depth:1}],['未来四层 D=4',{depth:4}],
 ['期望专家并集（非最坏）',{union:'expected'}],
 ['L/H 利用率 45%',{lUtil:.45,hUtil:.45}],['L/H 利用率 75%',{lUtil:.75,hUtil:.75}],
 ['Attention 投影参数预算 -20%',{projectionScale:.8}],['Attention 投影参数预算 +20%',{projectionScale:1.2}],
 ['KV tile 1024',{kvTile:1024}],['KV tile 4096',{kvTile:4096}],
 ['320 GB/s 已是有效带宽',{memTBs:5.12}],
 ['Softmax 层前置排列',{layerOrder:'frontloaded'}]
];
const sensitivities=tests.map(([name,options])=>{
 const p=build({batch:8,...options}),candidates=sizes.filter(S=>S<=288).map(S=>simulate(p,S)).filter(r=>r.feasible);
 const r=candidates.reduce((a,b)=>a.rawUs<=b.rawUs?a:b);
 return {name,options,windowMiB:r.sramMiB,tps:r.tps,computeUs:r.computeUs,commUs:r.commUs,waitUs:r.waitUs,minMiB:p.minCapacity/MiB};
});
const payload={version:'2026-09-19',inputHash:crypto.createHash('sha256').update(fs.readFileSync('teams/model/src/design_engine.js')).update(fs.readFileSync('integration/detailed/k3_operator_sram_sim.js')).digest('hex'),defaultConfig:DEFAULT,sizes,plans,sweeps,details,sensitivities};
fs.writeFileSync('out/sram/k3_operator_sram_tps_results.json',JSON.stringify(payload,null,2)+'\n');
const template=fs.readFileSync('integration/templates/sram/k3_operator_sram_report_template.html','utf8');
fs.writeFileSync('out/sram/k3_operator_sram_tps_evaluation.html',template.replace('/*__REPORT_DATA__*/',JSON.stringify(payload).replace(/</g,'\\u003c')));
for(const B of batches){const raw=sweeps[B].raw.filter(r=>r.feasible),best=raw.reduce((a,b)=>a.tps>=b.tps?a:b);const knee=raw.find(r=>r.tps>=best.tps*.99);console.log('B',B,'best',best.sramMiB,best.tps,'99%',knee.sramMiB,'+25%',Math.ceil(knee.sramMiB*1.25/32)*32);}
console.log(sensitivities.map(r=>`${r.name}: ${r.tps.toFixed(2)} TPS @ W=${r.windowMiB}`).join('\n'));
