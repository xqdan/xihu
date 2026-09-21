/* Single-objective, B=1 only. Existing dual-objective files remain unchanged. */
'use strict';
const fs=require('fs'),crypto=require('crypto');
const A=require('./k3_architecture_search'),{simulate,MiB}=require('../simulation/k3_operator_sram_sim.js');
const TARGET=1000,MARGIN=1.17;
const EXT={...A.SPACE,nL:[4,8,12,16,24,32],nH:[4,8,12,16,24,32],lRows:[1,2,4,8,16],lCols:[64,128,256],lEngines:[1,2,4,8],vectorLanes:[128,256,512,1024,2048],reduceLanes:[128,256,512,1024,2048,4096],kvTile:[4096,8192,16384,32768],headTile:[16,32,48,96]};
function evaluate(x,detail=false){
 const p=A.physical(x);if(!p.feasible)return {feasible:false,reasons:p.reasons};
 const m=A.mappedPlan(x,1,p);if(!m.feasible)return {feasible:false,reasons:m.reasons};
 const r=simulate(m.plan,m.window);if(!r.feasible)return r;
 const {layerStats,events,occupancy,...stats}=r;
 const out={feasible:true,x:{...x},p,...stats,services:m.services,limiters:m.limiters,localL:m.lLocalBytes/MiB,localH:m.hLocalBytes/MiB,backingGB:m.plan.backingBytes/1e9,dmaTBs:m.dmaEffective,ops:m.plan.ops.length};
 if(detail){out.layers=layerStats;out.op4=m.plan.ops.filter(o=>o.layer===4).map(o=>({name:o.name,unit:o.unit,duration:o.duration,flops:o.flops,timing:o.timing,mapping:o.mapping}));}
 return out;
}
function search(space,seeds,{initial,generations,offspring,polish,seed}){
 const rand=A.rng(seed),pick=a=>a[Math.floor(rand()*a.length)],keys=Object.keys(space),seen=new Set(),rows=[],rejects={},progress=[];
 let attempts=0;
 function test(x){const key=keys.map(k=>x[k]).join('|');if(seen.has(key))return;seen.add(key);attempts++;
  const r=evaluate(x);if(!r.feasible){for(const k of r.reasons||[r.reason])rejects[k]=(rejects[k]||0)+1;return;}
  r.id=rows.length;rows.push(r);if(rows.length%100===0)console.log('B1 feasible',rows.length,'best',Math.max(...rows.map(r=>r.tps)).toFixed(2));
 }
 const ordered=()=>rows.slice().sort((a,b)=>b.tps-a.tps||a.p.dieArea-b.p.dieArea||a.p.cardPower-b.p.cardPower);
 // Seed software outside a phase's domain is snapped to its nearest value.
 for(const seedx of seeds){const x={};for(const k of keys)x[k]=space[k].reduce((a,b)=>Math.abs(a-seedx[k])<=Math.abs(b-seedx[k])?a:b);test(x);}
 let tries=0;
 while(rows.length<initial&&tries++<initial*1000)test(Object.fromEntries(keys.map(k=>[k,pick(space[k])])));
 if(!rows.length)throw Error('No feasible design');
 progress.push({phase:'init',count:rows.length,tps:ordered()[0].tps});
 for(let g=0;g<generations;g++){
  const elite=ordered().slice(0,12),target=rows.length+offspring;tries=0;
  while(rows.length<target&&tries++<offspring*1000){const x={...pick(elite).x},other=pick(elite).x;if(rand()<.3)for(const k of keys)if(rand()<.5)x[k]=other[k];for(let i=0,n=1+Math.floor(rand()*5);i<n;i++){const k=pick(keys);x[k]=pick(space[k]);}test(x);}
  progress.push({phase:'gen '+(g+1),count:rows.length,tps:ordered()[0].tps});
 }
 for(let pass=0;pass<polish;pass++){
  const parents=ordered().slice(0,2);
  for(const r of parents)for(const k of keys)for(const v of space[k])if(v!==r.x[k])test({...r.x,[k]:v});
  progress.push({phase:'local '+(pass+1),count:rows.length,tps:ordered()[0].tps});
 }
 const best=ordered()[0],qualified=rows.filter(r=>r.tps>=TARGET).sort((a,b)=>a.p.dieArea-b.p.dieArea||a.p.cardPower-b.p.cardPower);
 return {space,options:{initial,generations,offspring,polish,seed},attempts,rejects,progress,qualified:qualified.length,best:evaluate(best.x,true),targetCandidate:qualified.length?evaluate(qualified[0].x,true):null,rows};
}
function diagnostics(best){
 const m=A.mappedPlan(best.x,1),ops=m.plan.ops,comm=ops.filter(o=>o.unit==='COMM');
 const steps=comm.reduce((s,o)=>s+(o.name.includes('all-gather')?5:10),0);
 // Exact fixed-startup floor of the current serialized model, independent of
 // matrix throughput / memory bandwidth / SRAM capacity and search budget.
 const networkStartup=steps*A.TECH.rdmaStepUs,dieStartup=comm.length*6*A.TECH.ucieHopUs;
 const services=Object.fromEntries(Object.keys(best.services).map(k=>[k,best.services[k]]));
 const opTotals={};for(const l of best.layers)for(const o of Object.values(l.operators)){const a=opTotals[o.name]||(opTotals[o.name]={name:o.name,service:0,wait:0,flops:0,count:0});for(const k of ['service','wait','flops','count'])a[k]+=o[k];}
 // Latency-only what-ifs: hold physical design and all dataflow constant;
 // not a claimed implementation or free hardware improvement.
 const latencySweeps=[];
 for(const stepUs of [.14,.10,.07,.035,.014,0]){
  const plan=A.mappedPlan(best.x,1).plan;
  for(const o of plan.ops)if(o.unit==='COMM'){
   const payload=o.mapping.payload,wire=o.mapping.wire,steps=o.name.includes('all-gather')?5:10;
   const ports=Math.max(wire/(plan.c.sramReadTBs*1e6),wire/(plan.c.sramWriteTBs*1e6));
   o.duration=Math.max(steps*stepUs+wire/(best.p.rdmaCardGB*1000),ports)+o.mapping.dieMerge+o.mapping.localReduce+best.p.meshSide*A.TECH.routerCycles/(best.x.ghz*1000);
  }
  const r=simulate(plan,m.window);latencySweeps.push({stepUs,tps:r.tps,rawUs:r.rawUs,waitUs:r.waitUs});
 }
 return {collectives:comm.length,steps,networkStartup,dieStartup,floorUs:networkStartup+dieStartup,
  tpsCeiling:1e6/((networkStartup+dieStartup)*MARGIN),targetRawUs:1e6/TARGET/MARGIN,
  remainingRawUs:1e6/TARGET/MARGIN-networkStartup-dieStartup,services,opTotals:Object.values(opTotals).sort((a,b)=>b.service-a.service),latencySweeps,
  ceilings:[{name:'实际候选',rawUs:best.rawUs},{name:'消除全部外存等待（服务时间不变）',rawUs:best.computeUs+best.commUs},{name:'通信和外存等待都为零（乐观下界）',rawUs:best.computeUs},{name:'只有固定通信启动（非可实现方案）',rawUs:networkStartup+dieStartup}].map(v=>({...v,tps:1e6/(v.rawUs*MARGIN)}))};
}
function report(d){
 const f=(v,n=2)=>Number(v).toLocaleString('en-US',{minimumFractionDigits:n,maximumFractionDigits:n}),e=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
 const table=(heads,rows)=>'<div class="scroll"><table><thead><tr>'+heads.map(v=>'<th>'+e(v)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(v=>'<td>'+e(v)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
 const b=d.extended.best,x=b.x,p=b.p,diag=d.diagnostics;
 const rect=(X,Y,W,H,c)=>`<rect x="${X}" y="${Y}" width="${W}" height="${H}" rx="8" fill="${c}" stroke="#155e75"/>`;
 const text=(X,Y,s,z=14)=>`<text x="${X}" y="${Y}" text-anchor="middle" font-size="${z}">${e(s)}</text>`;
 let svg='<svg viewBox="0 0 1100 540" role="img" aria-label="B1优选计算Die架构">'+rect(80,15,940,450,'#eef6f7')+text(550,45,`Compute Die：${f(p.dieArea)} mm² / ${f(p.diePower)} W · ${x.ghz}GHz`,19);
 for(const [X,type,count,rows,cols,eng,cap,banks]of [[110,'L',x.nL,x.lRows,x.lCols,x.lEngines,x.lMiB,x.lBanks],[580,'H',x.nH,x.hRows,x.hCols,x.hEngines,x.hMiB,x.hBanks]]){
  svg+=rect(X,70,410,160,'#fffdf8')+text(X+205,97,`${count} × ${type} core；每核均含以下单元`,17)+text(X+205,126,`Matrix：${eng}×${rows}×${cols} MAC/cycle`)+text(X+205,153,`Vector：${x.vectorLanes} lanes；TMA：${x.tmaEngines}×${x.tmaBytes} B/cycle`)+text(X+205,180,`Local SRAM：${cap} MiB / ${banks} banks`)+text(X+205,211,'↓ 本地端口 / TMA ↓');}
 svg+=rect(110,247,880,46,'#dce8ec')+text(550,276,`NoC mesh ${p.meshSide}×${p.meshSide} · ${x.nocBytes} B/cycle ×${x.nocLanes} · ${f(p.nocTB)} TB/s/Die`);
 svg+=rect(200,317,430,73,'#e6f4ea')+text(415,343,`Shared SRAM ${x.sharedMiB} MiB / ${x.sharedSlices} slices`,17)+text(415,370,`read/write ${f(p.sharedRead)}/${f(p.sharedWrite)} TB/s`)+rect(650,317,275,73,'#e6f4ea')+text(787,343,'Shared reduce',17)+text(787,370,`${x.reduceLanes} FP32 lanes / ${f(p.reduceTOP)} TOPS`);
 svg+=text(550,427,`UCIe：2×MC端口 + 2×Die环端口；每端口 ${x.ucieLanes} lanes ×${x.ucieGbps}G`)+text(550,451,`每Die RDMA ${x.rdmaLanes} lanes；每卡网络有效上限 ${f(p.rdmaCardGB)} GB/s`);
 svg+='<path d="M315 230 V247 M785 230 V247 M415 293 V317 M787 293 V317 M630 352 H650 M550 390 V407" stroke="#155e75" stroke-width="2" fill="none"/>';
 svg+=text(550,500,'单卡：8个上述Die，由UCIe双向环互联；各Die直连2个MC；通过RDMA连接其余31卡。')+text(550,525,'local SRAM不并入shared池；示意图不是按比例的floorplan。',12)+'</svg>';
 const chartRows=d.extended.rows;let chart='<svg viewBox="0 0 1100 300" role="img" aria-label="B1 TPS搜索收敛曲线">';const maxY=Math.max(1100,b.tps*1.1);for(let i=0;i<=4;i++){let y=255-i*225/4;chart+=`<line x1="70" x2="1080" y1="${y}" y2="${y}" stroke="#ddd"/>`+text(35,y+4,f(maxY*i/4,0),12);}let best=0;const pts=chartRows.map((r,i)=>{best=Math.max(best,r.tps);return `${70+i/Math.max(1,chartRows.length-1)*1010},${255-best/maxY*225}`;}).join(' ');chart+=`<polyline fill="none" stroke="#155e75" stroke-width="3" points="${pts}"/><line x1="70" x2="1080" y1="${255-1000/maxY*225}" y2="${255-1000/maxY*225}" stroke="#b45309" stroke-dasharray="6 4"/>`+text(950,255-1000/maxY*225-9,'目标1000 TPS/usr',12)+text(550,290,`扩展域可行候选序号 0…${chartRows.length-1}；蓝线=截至当时最佳 TPS`,12)+'</svg>';
 const spec=Object.entries(x).map(([k,v])=>[k,v,Object.prototype.hasOwnProperty.call(EXT,k)?EXT[k].join(', '):'']);
 let h=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>K3 B1 · 1000 TPS/usr 单目标搜索</title><style>*{box-sizing:border-box}body{margin:0;background:#f3f1eb;color:#172033;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}main{max-width:1400px;margin:auto;padding:28px 24px}h1{font-size:29px}h2{border-top:1px solid #d6d8d8;padding-top:18px;margin-top:30px}h3{font-size:17px}.note{padding:14px;background:#e4f2f4;border-left:4px solid #155e75;border-radius:6px}.warn{background:#fff4d8;border-color:#b45309}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.box,.panel{background:#fffdf8;border:1px solid #d6d8d8;border-radius:9px;padding:14px;margin:12px 0}.big{font-size:27px;color:#155e75;font-weight:700}.scroll{overflow:auto;max-height:650px;background:#fffdf8;margin:12px 0}table{width:100%;border-collapse:collapse;font-size:12px}td,th{text-align:left;padding:8px 10px;border-bottom:1px solid #ddd}th{position:sticky;top:0;background:#f7f5ef;white-space:nowrap}svg{width:100%;height:auto;display:block}svg text{font-family:inherit;fill:#172033}.caption{font-size:12px;color:#647083}.formula{white-space:pre-wrap;background:#172033;color:#e8eef4;padding:15px;border-radius:7px}a{color:#155e75}@media(max-width:750px){.grid{grid-template-columns:1fr}}</style></head><body><main>
<p class="caption">2026-09-19 · TP32 / PP1 · Context 1,048,576 · decode · 不再考核 B=32</p><h1>只搜索 B=1：能否达到 1000 TPS/usr？</h1>
<div class="note warn"><b>${d.extended.qualified?'已找到扩展域内的模型达标候选。':'本次有限搜索未找到达标候选；不能把它解释为所有可能架构均不可能。'}</b>不降低context、不增大batch、不把聚合吞吐当单请求TPS、不取消1.17端到端裕量。物理成本和K3结构仍为项目工程假设，不是实测性能或PDK签核。</div>
<div class="grid"><div class="box">保持旧参数搜索域<div class="big">${f(d.original.best.tps)} TPS</div>${d.original.rows.length} 个B1可行方案</div><div class="box">B1专用扩展参数域<div class="big">${f(b.tps)} TPS</div>${d.extended.rows.length} 个B1可行方案 / ${d.extended.qualified} 个达标</div><div class="box">1000 TPS 时间预算<div class="big">1.000 ms/token</div>扣除×1.17裕量后 raw ≤ ${f(diag.targetRawUs)} μs</div></div>
<h2>1. 优化规则与固定条件</h2><p>先以B=1 TPS最大为搜索方向；找到达标方案后，另外挑出已测达标集里面积最小、再按功耗排序的候选。整个过程不运行B=32评估，B32局部tile和容量约束不再参与淘汰。</p>
${table(['条件','数值'],[['TP / PP / Die数','32卡 / 1 / 8 Die每卡'],['context / batch','1,048,576 / 1'],['每Die面积 / 功耗上限','400 mm² / 260 W'],['整卡功耗 / 外存容量','2400 W / 128 GB'],['频率范围','0.8 / 1.0 / 1.2 GHz，未提高上限'],['网络上限','800 GB/s有效/rank；0.14 μs/RDMA step'],['内存/带宽/PPA','沿用上一报告物理公式与成本系数，未人为提升效率'],['B1扩展','L阵列允许1/2行，增加core数/Vector/reduce范围；KV tile增至32768、head tile增至96'],['SRAM语义','各core local与shared分离，各自检查容量与端口']])}
<p>旧域与扩展域分别执行带固定seed的随机初始化、精英交叉/变异和逐坐标邻域搜索；每个可行参数组都跑完整93层。扩展域不等于现成IP已可实现：更大的Vector/reduce与不同阵列形状仍需RTL和物理验证。</p>
<h2>2. 搜索结果、收敛曲线与候选比较</h2><div class="panel">${chart}</div>
${table(['阶段','尝试不同参数组','B1可行数','达标数','最佳TPS','实际ms/token','Die面积mm²','整卡W'],[['旧域',d.original.attempts,d.original.rows.length,d.original.qualified,f(d.original.best.tps),f(1000/d.original.best.tps,3),f(d.original.best.p.dieArea),f(d.original.best.p.cardPower)],['B1扩展',d.extended.attempts,d.extended.rows.length,d.extended.qualified,f(b.tps),f(1000/b.tps,3),f(p.dieArea),f(p.cardPower)]])}
${d.extended.targetCandidate?`<div class="note">已测达标集中按面积优选：${f(d.extended.targetCandidate.tps)} TPS，${f(d.extended.targetCandidate.p.dieArea)} mm²/Die，${f(d.extended.targetCandidate.p.cardPower)} W/card；下方架构图展示最快候选，完整达标候选见JSON。</div>`:''}
<h2>3. 为什么不只是取消B32就能达到1000？</h2>
<div class="note">当前映射每步含 ${diag.collectives} 次collective、${diag.steps} 个网络step。仅RDMA固定启动就需 ${f(diag.networkStartup)} μs，卡内合并固定hop另需 ${f(diag.dieStartup)} μs，合计 ${f(diag.floorUs)} μs；留给所有计算、reduce、实际数据传输和暴露等待的raw预算只剩 <b>${f(diag.remainingRawUs)} μs</b>。</div>
<p>由固定启动得到的 ${f(diag.tpsCeiling)} TPS 是该串行调度模型的<b>乐观上限</b>，不是可达预测，也不是对其他通信融合/并行架构的上限。目标1000低于此上限，因此仅凭这条下界不能证明不可行。</p>
${table(['最快候选时间项','μs（未加1.17裕量）','占raw比例'],Object.entries(b.services).map(([k,v])=>[k,f(v),f(v/b.rawUs*100)+'%']).concat([['外存等待/最终排空',f(b.waitUs),f(b.waitUs/b.rawUs*100)+'%'],['raw合计',f(b.rawUs),'100%'],['最终时间',f(b.e2eUs),'×1.17']]))}
${table(['固定候选的理想化诊断','raw μs','TPS上限/当前值'],diag.ceilings.map(r=>[r.name,f(r.rawUs),f(r.tps)]))}
<h3>网络启动延迟敏感性：单项变化、未重新搜索、未补计实现成本</h3>
${table(['RDMA step μs','TPS','raw μs','等待μs'],diag.latencySweeps.map(r=>[r.stepUs,f(r.tps),f(r.rawUs),f(r.waitUs)]))}
<p class="caption">step=0是理想化诊断，不是假设真实链路零延迟；这张表不能作为一组已完成物理实现的达标方案。更低延迟的PHY/交换网络、collective融合、local reduce减少跨tile重复合并等，需要独立建模和成本验证。</p>
<h2>4. 最快B1候选：单Die架构图与详细参数</h2><div class="panel">${svg}</div>
${table(['资源','规格'],[['L/H矩阵峰值',f(p.lTF)+' / '+f(p.hTF)+' TFLOPS/Die'],['Local / Shared / 总SRAM',p.localMiB+' / '+x.sharedMiB+' / '+p.totalMiB+' MiB/Die'],['L/H最大局部对象',f(b.localL,3)+' / '+f(b.localH,3)+' MiB/core'],['Shared工作窗口 / 峰值',f(b.sramMiB)+' / '+f(b.peakReservedMiB)+' MiB/card'],['权重+KV backing',f(b.backingGB)+' GB/card'],['有效DMA带宽',f(b.dmaTBs)+' TB/s/card'],['UCIe单端口 / 环cut',f(p.uciePortGB)+' / '+f(p.dieCutGB)+' GB/s'],['RDMA有效',f(p.rdmaCardGB)+' GB/s/card'],['面积 / Die功耗 / 卡功耗',f(p.dieArea)+' mm² / '+f(p.diePower)+' W / '+f(p.cardPower)+' W']])}
<details><summary>完整31个变量及B1扩展域</summary>${table(['参数','所选值','扩展搜索范围'],spec)}</details>
<h2>5. 所有层和算子的服务账</h2>${table(['算子','调用数','服务μs','输入等待μs','GFLOP/等效GOP'],diag.opTotals.map(o=>[o.name,o.count,f(o.service),f(o.wait),f(o.flops/1e9,3)]))}
${table(['层','类型','compute μs','comm μs','等待 μs','层时长 μs','读MiB','写MiB'],b.layers.map(l=>[l.layer,l.kind,f(l.compute),f(l.comm),f(l.wait),f(l.duration),f(l.readBytes/MiB),f(l.writeBytes/MiB)]))}
<h2>6. 结论边界与复算</h2><ul><li>这是独立B1搜索，不是从双目标结果里简单挑B1最高的点；原报告及其结果文件不修改。</li><li>继续沿用项目K3预设：93层，24 Softmax / 69 Linear，92 MoE；未知Attention投影按参数预算拟合，仍非官方规格确认。</li><li>相同物理预算并不意味着相同资源配比。扩展域允许更多小矩阵L核、更强Vector/reduce与更大的attention tile，但都通过原面积/功耗公式检查。</li><li>层/算子关键流仍串行，外存DMA重叠；当前逐PV tile合并partial的调度可能不是最低延迟实现。没有把推测性的融合收益直接加到TPS上。</li><li>非抢占预测DMA会使更高带宽/更深预取不一定更快；仅是固定策略效应，不能推导降低物理带宽天然更好。</li><li>未找到1000只表示本次搜索未命中，不是整个架构设计空间不可能。若要继续冲击目标，应先校准collective、partial归约频率、算子融合与真实kernel trace，再决定是否修改面积/功耗预算。</li></ul>
<p><a href="../../src/search/k3_b1_1000_search.js">单目标搜索程序</a> · <a href="../../data/search/k3_b1_1000_results.json">全部参数、结果和93层账 JSON</a></p><div class="formula">B1_SCALE=${d.scale} node src/search/k3_b1_1000_search.js
node tests/test_k3_b1_1000_search.js
# 保持同样硬约束，只增加搜索次数
B1_SCALE=2 node src/search/k3_b1_1000_search.js</div>
<p class="caption">SHA-256：${d.inputHash}；总运行时间 ${f(d.seconds,1)}秒。本报告为离线自包含HTML，不依赖网络。</p></main></body></html>`;
 return h;
}
function run(){
 const t=Date.now(),scale=Number(process.env.B1_SCALE||1);if(!Number.isInteger(scale)||scale<1)throw Error('B1_SCALE must be positive integer');
 const old=JSON.parse(fs.readFileSync('data/search/k3_architecture_search_results.json','utf8'));
 const seeds=[A.BASE,...old.rows.slice().sort((a,b)=>b.f1-a.f1).slice(0,12).map(r=>r.x)];
 console.log('Phase 1: B1 only, original parameter domain');
 const original=search(A.SPACE,seeds,{initial:48*scale,generations:2,offspring:24*scale,polish:2,seed:20260920});
 console.log('Phase 2: B1-specific expanded domain, same physical budgets');
 const extended=search(EXT,[...original.rows.slice().sort((a,b)=>b.tps-a.tps).slice(0,12).map(r=>r.x),...seeds],{initial:96*scale,generations:4,offspring:32*scale,polish:3,seed:20260921});
 const d={version:'2026-09-19',scale,target:TARGET,batch:1,tp:32,context:A.LIMITS.context,margin:MARGIN,limits:A.LIMITS,tech:A.TECH,original,extended,diagnostics:diagnostics(extended.best)};
 d.inputHash=crypto.createHash('sha256');for(const f of ['src/search/k3_b1_1000_search.js','src/search/k3_architecture_search.js','src/simulation/k3_operator_sram_sim.js','src/core/design_engine.js','data/search/k3_architecture_search_results.json'])d.inputHash.update(fs.readFileSync(f));d.inputHash=d.inputHash.digest('hex');d.seconds=(Date.now()-t)/1000;
 fs.writeFileSync('data/search/k3_b1_1000_results.json',JSON.stringify(d,null,2));fs.writeFileSync('reports/search/k3_b1_1000_report.html',report(d));
 console.log(JSON.stringify({original:original.best.tps,expanded:extended.best.tps,qualified:extended.qualified,counts:[original.rows.length,extended.rows.length],seconds:d.seconds,services:extended.best.services,latency:d.diagnostics.latencySweeps},null,2));
}
module.exports={TARGET,EXT,evaluate,search,diagnostics,report};if(require.main===module)run();
