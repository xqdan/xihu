'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const read = p => JSON.parse(fs.readFileSync(path.join(root,p),'utf8').replace(/^\uFEFF/,''));
const sources = ['data/governance/gate_status.json','data/detailed/detailed_architecture_run.json','data/workload/tps_observation_matrix.json','data/direction/sensitivity_sweep.json'];
const [gate,detail,matrix,sweep] = sources.map(read);
const hashes = Object.fromEntries(sources.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')]));
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const blockers = [
 {id:'Q1-Q2',priority:'P0',issue:'Template workload is not derived from verified model shapes',exit:'Verified source + dtype/layer/operator dimensions; FLOP/byte reconciliation for 3 models'},
 {id:'Q3-Q6/Q8',priority:'P0',issue:'Synthetic events do not drive token latency',exit:'Dependency/resource-aware timeline; cycle, byte, packet conservation; 18 timed slots'},
 {id:'Q7/D3',priority:'P0',issue:'P0/P1 share unvalidated core-class capacity assumptions',exit:'Separate per-die/package/core-class resource accounting, area and activity-bound power'},
 {id:'D2-D6',priority:'P1',issue:'Sweep only covers K3/P0/MC320/TP32 and five numerical axes',exit:'Extend model/profile coverage; add physical area/power and collective latency sensitivity'},
 {id:'D7/Q9',priority:'P0',issue:'1000 TPS/user target not established',exit:'Calibrated operator ledger, validated timing and feasible 7-reticle resource envelope'}
];
const feedback={schemaVersion:'architecture-backflow-v0.1',runId:detail.runId,status:'OPEN',evidenceKind:detail.evidenceKind,targetTpsPerUser:matrix.metric.targetTpsPerUser,sourceHashes:hashes,blockers,models:matrix.requiredCoverage.models.map(modelId=>{const rows=matrix.observations.filter(x=>x.modelId===modelId);const best=rows.reduce((a,b)=>a.tpsPerUser>b.tpsPerUser?a:b);return {modelId,bestPlanningBound:best.tpsPerUser,optimisticGapFactor:matrix.metric.targetTpsPerUser/best.tpsPerUser,caseId:best.observationId,note:'Uncalibrated planning bound; gap is not a hardware sizing recommendation.'};})};
fs.writeFileSync(path.join(root,'data/governance/direction_feedback.json'),JSON.stringify(feedback,null,2)+'\n');
const rows = matrix.observations.map(x=>`<tr><td>${esc(x.modelId)}</td><td>${x.tp}</td><td>${esc(x.mcProfile)}</td><td>${esc(x.physicalProfile)}</td><td>${x.tpsPerUser.toFixed(2)}</td><td>${esc(x.status)}</td></tr>`).join('');
const checks = (obj)=>Object.entries(obj).filter(([,v])=>typeof v==='boolean').map(([k,v])=>`<tr><td>${esc(k)}</td><td class="${v?'ok':'bad'}">${v?'PASS':'NOT READY'}</td></tr>`).join('');
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Architecture Global Dashboard</title><style>
*{box-sizing:border-box}body{margin:0;background:#0b1220;color:#e6edf8;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1400px;margin:auto;padding:28px}h1{font-size:30px}h2{font-size:19px}.muted{color:#a2b4cc}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.panel{background:#142139;border:1px solid #2c405d;border-radius:14px;padding:20px;margin:12px 0;overflow:auto}.value{font-size:27px;font-weight:bold}.ok{color:#67e4b2}.bad{color:#ffb578}.notice{border-left:4px solid #ffb578;padding:14px;background:#322821}table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:9px;text-align:left;border-bottom:1px solid #30405b}code{overflow-wrap:anywhere}a{color:#73d6fa}li{margin:8px 0}@media(max-width:850px){.grid{grid-template-columns:1fr}.cards{grid-template-columns:repeat(2,1fr)}main{padding:14px}}@media(max-width:450px){.cards{grid-template-columns:1fr}}
</style></head><body><main><p class="muted">K3 / GLM-5.2 / DeepSeek-V4-Pro</p><h1>芯片架构全局看板</h1><p>机器数据快照 · ${esc(detail.runId)} · Gate 评估 ${esc(gate.evaluatedAt)}</p>
<div class="notice"><b>修正此前的 Q-Gate PASS：</b>当前事件是合成规划数据，并未驱动时序计算，不能称为完整 replay 或 fine TPS。D-Gate PASS 仅代表规划比较，不代表架构冻结。供应商未确认配置不标记 FROZEN。</div>
<section class="cards"><div class="panel">目标<div class="value">1000 TPS/usr</div>架构门槛 1050</div><div class="panel">D-Gate · 规划比较<div class="value">${esc(gate.directionGate.decision)}</div>非性能验收</div><div class="panel">Q-Gate · 详细量化<div class="value bad">${gate.quantificationGate.decision==='PASS'?'PASS':'BLOCKED'}</div>缺少有效事件时序</div><div class="panel">规划槽位 / 有效观测<div class="value">${matrix.currentCoverage.planningEstimated || 0} / ${matrix.currentCoverage.modelObserved}</div>silicon ${matrix.currentCoverage.siliconObserved}</div></section>
<section class="panel"><h2>设计流程与当前状态</h2><p>Stage A → 规划候选 → Stage B 算子估算 → <b class="bad">Q-Gate 阻塞</b> → Stage A 反馈</p><code>${esc(detail.performanceAcceptance.status)}</code><p>算子记录 ${detail.operatorLedger.length} · 合成事件 ${720 === detail.operatorLedger.length*4 ? detail.operatorLedger.length*4 : 'see event artifact'} · sweep ${sweep.sampleCount} 点 / 可行 ${sweep.feasibleCount}。当前 sweep 仅覆盖 K3/P0/MC320/TP32。</p></section>
<section class="grid"><div class="panel"><h2>D-Gate 检查</h2><table>${checks(gate.directionGate)}</table></div><div class="panel"><h2>Q-Gate 检查</h2><table>${checks(gate.quantificationGate)}</table></div></section>
<section class="panel"><h2>18 槽位规划上界 · 不是实测 TPS</h2><p class="muted">取最慢单算子的瓶颈上界，未累计完整依赖链或网络延迟。P0/P1 资源口径尚待校准。与历史 K3 RDMA 基线 546.63 / 998.81 TPS 不是相同 workload，不可直接比较。</p><table><thead><tr><th>模型</th><th>TP</th><th>MC</th><th>Profile</th><th>规划 TPS 上界</th><th>证据状态</th></tr></thead><tbody>${rows}</tbody></table></section>
<section class="panel"><h2>剩余阻塞与责任 Agent</h2><table><tr><th>优先级 / Agent</th><th>阻塞</th><th>验收条件</th></tr>${blockers.map(x=>`<tr><td>${esc(x.priority+' / '+x.id)}</td><td>${esc(x.issue)}</td><td>${esc(x.exit)}</td></tr>`).join('')}</table></section>
<section class="panel"><h2>文档和机器产物</h2><ul>${[...sources,'data/governance/direction_feedback.json','docs/design/decisions/ADR-0003-planning-evidence-boundary.md','reports/detailed/stage_b_formal_run_20260922.md'].map(p=>`<li><a href="../../${esc(p)}">${esc(p)}</a></li>`).join('')}</ul><p>刷新：<code>npm run dashboard</code>；验证：<code>npm test</code>。本页不声明远端 CI 已通过。</p></section>
<script id="dashboard-source-hashes" type="application/json">${JSON.stringify(hashes)}</script></main></body></html>`;
fs.writeFileSync(path.join(root,'reports/dashboard/architecture_global_dashboard.html'),html+'\n');
console.log('Generated dashboard and direction feedback from current artifacts');
