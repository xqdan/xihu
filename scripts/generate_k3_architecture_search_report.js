'use strict';
const fs=require('fs'),crypto=require('crypto');
const {search,evaluate,pareto,SPACE}=require('../src/search/k3_architecture_search.js');
const opt={samples:Number(process.env.SAMPLES||192),generations:Number(process.env.GENERATIONS||4),offspring:Number(process.env.OFFSPRING||48),polish:Number(process.env.POLISH||2),seed:20260919};
const renderOnly=process.argv.includes('--render-only');
const result=renderOnly?JSON.parse(fs.readFileSync('data/search/k3_architecture_search_results.json','utf8')):search(opt);
const hash=crypto.createHash('sha256').update(fs.readFileSync('src/search/k3_architecture_search.js')).update(fs.readFileSync('src/simulation/k3_operator_sram_sim.js')).update(fs.readFileSync('src/core/design_engine.js')).digest('hex');
if(renderOnly&&result.inputHash!==hash)throw Error('Simulation input hash changed; run a fresh search rather than render stale results.');
result.inputHash=hash;
const x=result.rows.find(r=>r.id===result.selected.balanced).x;
const perturbations=[
 ['L core数量减半',{nL:Math.max(4,x.nL/2)}],
 ['H core数量减半',{nH:Math.max(4,x.nH/2)}],
 ['L矩阵rows翻倍',{lRows:x.lRows*2}],
 ['H矩阵rows翻倍',{hRows:x.hRows*2}],
 ['L local SRAM减半',{lMiB:x.lMiB/2}],
 ['H local SRAM减半',{hMiB:x.hMiB/2}],
 ['Shared SRAM减半',{sharedMiB:x.sharedMiB/2}],
 ['Vector lanes减半',{vectorLanes:x.vectorLanes/2}],
 ['TMA engines减半',{tmaEngines:Math.max(1,x.tmaEngines/2)}],
 ['NoC link width减半',{nocBytes:x.nocBytes/2}],
 ['Shared reduce lanes减半',{reduceLanes:x.reduceLanes/2}],
 ['UCIe lane rate减半',{ucieGbps:x.ucieGbps/2}],
 ['MC名义带宽减半',{mcGBs:x.mcGBs/2}],
 ['RDMA lanes翻倍',{rdmaLanes:x.rdmaLanes*2}],
 ['关闭未来专家预取',{depth:0}],
 ['Shared工作窗口减为75%',{windowFraction:.75}]
];
if(!renderOnly||!result.sensitivities)result.sensitivities=perturbations.map(([name,change])=>{
 const r=evaluate({...x,...change});
 return {name,change,feasible:r.feasible,...(r.feasible?{f1:r.f1,f2:r.f2,dieArea:r.p.dieArea,cardPower:r.p.cardPower}:{reasons:r.reasons||[r.reason]})};
});
// Admit feasible, in-domain sensitivity results to the candidate archive.
// Do not publish a Pareto frontier that ignores an already-known improvement.
if(!result.auditComplete){
 result.sensitivityCenter=result.selected.balanced;
 result.searchAttempted=result.attempted;
 result.auditEvaluations=0;result.auditAccepted=0;
 const key=x=>Object.keys(SPACE).map(k=>x[k]).join('|');
 const known=new Set(result.rows.map(r=>key(r.x)));
 for(const s of result.sensitivities){
  const candidate={...x,...s.change};
  if(!s.feasible||Object.keys(SPACE).some(k=>!SPACE[k].includes(candidate[k]))||known.has(key(candidate)))continue;
  const r=evaluate(candidate);result.auditEvaluations++;
  if(!r.feasible)throw Error('Sensitivity recomputation mismatch');
  r.id=result.rows.length;result.rows.push(r);known.add(key(candidate));
  result.auditAccepted++;result.attempted++;
 }
 const choose=(a,b,score)=>score(a)!==score(b)?(score(a)>score(b)?a:b):(a.p.dieArea!==b.p.dieArea?(a.p.dieArea<b.p.dieArea?a:b):(a.p.cardPower<=b.p.cardPower?a:b));
 const best1=result.rows.reduce((a,b)=>choose(a,b,r=>r.f1));
 const best2=result.rows.reduce((a,b)=>choose(a,b,r=>r.f2));
 const front=pareto(result.rows);
 const balanced=front.reduce((a,b)=>choose(a,b,r=>Math.min(r.f1/best1.f1,r.f2/best2.f2)));
 result.selected={best1:best1.id,best2:best2.id,balanced:balanced.id};
 result.frontIds=front.map(r=>r.id);
 for(const id of new Set(Object.values(result.selected))){
  const r=result.rows[id];if(!r.runs[1].layers)result.rows[id]={...evaluate(r.x,{details:true}),id};
 }
 result.history.push({generation:'sensitivity audit',evaluated:result.rows.length,front:front.length,max1:best1.f1,max2:best2.f2});
 result.auditComplete=true;
}
fs.writeFileSync('data/search/k3_architecture_search_results.json',JSON.stringify(result,null,2)+'\n');
const t=fs.readFileSync('templates/search/k3_architecture_search_report_template.html','utf8');
fs.writeFileSync('reports/search/k3_architecture_search_report.html',t.replace('/*__REPORT_DATA__*/',JSON.stringify(result).replace(/</g,'\\u003c')));
console.log('wrote k3_architecture_search_report.html and k3_architecture_search_results.json');
