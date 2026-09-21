// Read and run local curve code without changing its files or numerical model.
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const html=fs.readFileSync('docs/sram/k3_sram_tps_model.html','utf8');
function load(doubled=false){
 const nodes={};for(const m of html.matchAll(/\bid="([^"]+)"/g))nodes[m[1]]={value:'',innerHTML:'',textContent:'',addEventListener(){}};
 for(const m of html.matchAll(/<input\b[^>]*id="([^"]+)"[^>]*value="([^"]+)"/g))nodes[m[1]].value=m[2];
 for(const m of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){const options=[...m[2].matchAll(/<option value="([^"]+)"([^>]*)>/g)];nodes[m[1]].value=(options.find(x=>x[2].includes('selected'))||options[0])[1];}
 let code=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
 if(doubled){assert(code.includes('const LIN = 131.072, ATTN = 1048.576;'));code=code.replace('const LIN = 131.072, ATTN = 1048.576;','const LIN = 262.144, ATTN = 2097.152;');}
 assert(code.includes('  render();\n})();'));code=code.replace('  render();\n})();','  window.audit = {readOpts,evalBase,compose,SCHEMES,baseCache};\n})();');
 const c={window:{DesignEngine:require('../src/core/design_engine.js')},document:{getElementById:id=>nodes[id]},console};vm.createContext(c);vm.runInContext(code,c);return c.window.audit;
}
const raw=load(),full=load(true),sizes=[128,256,288,384,512,768,1056];
const records=[];
function sweep(t,label,sch,B,scenario){
 t.baseCache.clear();const o={...t.readOpts(),cardMode:'same',cards:32,context:1048576,batch:B,scenario};
 const base=t.evalBase(sch,o,o.context,o.tau);
 for(const S of sizes){const r=t.compose(sch,base,o,B,S);assert(Number.isFinite(r.tps));records.push({case:label,scheme:sch.id,B,scenario,S,tps:r.tps,feasible:r.feasible,buffer:r.Sbuf,stage:r.stageMs,compute:r.computeMs,coll:r.collectiveStageMs,miss:r.misfetchMs,wall:r.bottleneck,belowBusy:r.stageMs+1e-8<r.busyMs});}
}
for(const sch of raw.SCHEMES)for(const B of [1,8])for(const scenario of ['baseline','optimized'])sweep(raw,'curve-original',sch,B,scenario);
for(const B of [1,8])for(const scenario of ['baseline','optimized']){
 sweep(full,'double-compute-only',full.SCHEMES[0],B,scenario);
 const mc={...full.SCHEMES[0],id:'mc16x320',mcCount:16,mcBandwidthGBs:320,mcCapacityGB:8,mcEfficiency:.7};
 sweep(full,'8die-16mc-320',mc,B,scenario);
}
fs.writeFileSync('data/sram/sram_tps_architecture_analysis.json',JSON.stringify({source:'docs/sram/k3_sram_tps_model.html',context:1048576,tp:32,note:'Raw local-model sensitivity outputs; not validated operator-timed predictions.',records},null,2)+'\n');
for(const c of ['curve-original','double-compute-only','8die-16mc-320'])for(const B of [1,8])for(const sch of [...new Set(records.filter(r=>r.case===c).map(r=>r.scheme))]){
 const rr=records.filter(r=>r.case===c&&r.B===B&&r.scheme===sch&&r.scenario==='optimized');
 console.log(c,sch,'B'+B,'buf',rr[0].buffer.toFixed(2),rr.map(r=>r.S+':'+r.tps.toFixed(1)).join(' '),'belowBusy',rr.some(r=>r.belowBusy));
}
