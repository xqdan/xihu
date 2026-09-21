'use strict';
const fs=require('fs');
const d=require('../data/rdma/k3_b1_1000_rdma_sram_results.json');
const b=d.extended.best;
const f=v=>Number(v).toLocaleString('zh-CN',{maximumFractionDigits:2});
const esc=s=>String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const base=(title,subtitle,body)=>`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{margin:0;background:#f4f1ea;color:#172033;font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}main{max-width:1250px;margin:auto;padding:30px}h1{font-size:30px;color:#155e75}h2{margin-top:30px;border-top:1px solid #ccd5d8;padding-top:18px}.box{background:#fffdf8;border:1px solid #ccd5d8;border-radius:9px;padding:16px;margin:14px 0}.warn{background:#fff4d8;border-left:4px solid #b45309}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.metric{background:#fffdf8;border:1px solid #ccd5d8;border-radius:8px;padding:12px}.big{font-size:24px;font-weight:700;color:#155e75}table{width:100%;border-collapse:collapse;background:#fffdf8;margin:12px 0}th,td{text-align:left;padding:9px;border-bottom:1px solid #ddd;vertical-align:top}th{background:#eaf2f3}code,.formula{background:#172033;color:#e8eef4;padding:2px 5px;border-radius:4px}.formula{display:block;padding:14px;white-space:pre-wrap}li{margin:5px 0}.tag{display:inline-block;background:#d9ecef;border-radius:99px;padding:2px 9px;margin:2px}@media(max-width:800px){.grid{grid-template-columns:1fr 1fr}}@media(max-width:520px){.grid{grid-template-columns:1fr}}</style></head><body><main><p>2026-09-19 · K3 · TP=32 · B=1 · 93层 · RDMA memory semantics / 远端 SRAM 直接读写</p><h1>${esc(title)}</h1><p>${esc(subtitle)}</p>${body}<hr><p><a href="./k3_b1_1000_rdma_sram_report.html">返回主报告</a> · <a href="./k3_rdma_optimization_index.html">返回优化总览</a></p></main></body></html>`;
const table=(heads,rows)=>'<table><thead><tr>'+heads.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(x=>'<td>'+esc(x)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
const metric=`<div class="grid"><div class="metric">当前 TPS<div class="big">${f(b.tps)}</div></div><div class="metric">当前 raw<div class="big">${f(b.rawUs)} μs</div></div><div class="metric">目标 raw<div class="big">854.70 μs</div></div><div class="metric">需要削减<div class="big">${f(b.rawUs-1000000/1000/1.17)} μs</div></div></div>`;
const files={
 'reports/rdma/k3_opt_01_phase_fusion.html':base('优化一：通信 epoch 融合','优先减少 879 个 phase 和 33,201 个 RDMA request 的固定协议开销。',metric+`<h2>当前问题</h2><p>Attention output all-reduce、Wup all-reduce、Shared output all-reduce、Routed latent merge 分别触发独立的 write/commit/ready/reduce/ACK 流程，协议固定开销大于线速传输本身。</p>`+table(['通信类型','phase','耗时 μs','建议'],b.protocol.map(x=>[x.name,x.phases,f(x.timeUs),x.phases>100?'优先融合':'次优先']))+`<h2>建议方案</h2><ul><li>把同层的 Wup、router latent、shared output partial 合并成一个 group payload。</li><li>一次 group commit 覆盖多个 remote SRAM slot。</li><li>使用 ready bitmap 替代逐 slot notification。</li><li>把多个 ACK 合并为 group ACK。</li><li>搜索参数：<span class="tag">phaseFusionFactor=2/3/4</span><span class="tag">commitBatchSize=4/8/16</span><span class="tag">ackBatchSize=4/8/16</span></li></ul><h2>预期收益</h2><p>这是当前最值得优先验证的方向。理想情况下可减少 100～250 μs，但必须以真实 commit/ACK 并行度和 SRAM 写口约束为基础重新仿真，不能直接把收益当成已实现结果。</p>`),
 'reports/rdma/k3_opt_02_write_combining.html':base('优化二：RDMA write combining 与 stripe 聚合','减少小消息、flag、WQE/CQE 和远端 SRAM 写入固定开销。',metric+`<h2>当前问题</h2><p>当前 wire bytes 约 ${f(b.wireBytes/1048576)} MiB，但 request 数达到 ${f(b.requests)}；B=1 下每个 payload 较小，固定 header、flag、commit 和 ACK 比例较高。</p>`+table(['现状','建议扫描值','影响'],[['stripe','16 KiB','当前基线'],['stripe','32/64 KiB','减少 packet/notification 次数'],['payload','逐 partial 写入','多个 partial 先合并再写'],['commit','逐 phase','按 layer/group 批量 commit'],['ACK','逐 rank/phase','按 group 或 bitmap ACK']])+`<h2>实现注意</h2><ul><li>合并写入不能破坏不同 rank 的 slot 所有权。</li><li>必须保留 epoch、长度、校验和和 ready bitmap。</li><li>不能为了聚合而等待过久，否则会增加计算端 stall。</li></ul><h2>推荐参数</h2><span class="tag">stripeKiB=32</span><span class="tag">stripeKiB=64</span><span class="tag">writeCombineWindow=1～2 μs</span>`),
 'reports/rdma/k3_opt_03_commit_ack_batching.html':base('优化三：commit / notification / ACK 批处理','将 RDMA 内存语义中的可见性和生命周期管理从逐消息变为组级协议。',metric+`<h2>生命周期优化</h2><div class="formula">多个 remote SRAM writes
        ↓
检查所有 slot 写入完成
        ↓
group commit + ready bitmap
        ↓
consumer acquire / reduce
        ↓
group ACK
        ↓
epoch release</div><h2>收益来源</h2>`+table(['协议环节','当前方式','优化方式','风险'],[['commit','每个 phase','group commit','最慢 slot 决定可见时间'],['notification','逐次 ready','bitmap / counter','消费者需正确 acquire'],['ACK','逐个 ACK','group ACK','释放条件必须覆盖全部 rank'],['epoch','逐 payload','按 layer/group epoch','不能出现 ABA']])+`<p>此优化不会减少数学通信量，但会显著减少控制面事件。建议单独加入 WQE/CQE credit 和 group timeout 模型。</p>`),
 'reports/rdma/k3_opt_04_local_sram_ports.html':base('优化四：Local SRAM 端口、bank 与 TMA 重叠','解决 279.2 μs local TMA/SRAM 搬运瓶颈。',metric+`<h2>当前配置</h2>`+table(['资源','当前值','问题'],[['Local SRAM','L/H 4 MiB/core','容量接近窗口上限'],['Local read','约 1.84 TB/s/core','与 TMA/consumer 竞争'],['Local write','约为 read 的 1/2','partial/output 写回受限'],['TMA','4 × 512 B/cycle','共享 local bank/端口']])+`<h2>建议</h2><ul><li>提升 local write/read 比例，从 0.5 扫描到 0.75/1.0。</li><li>增加 TMA 专用写 bank，避免 TMA 与矩阵写回冲突。</li><li>按 weight、activation、KV/partial 分 bank。</li><li>增加 bank conflict penalty，而不是只提高理论带宽。</li><li>将 <code>depth=2</code> 扫描到 3/4，但要求 SRAM 峰值仍可容纳。</li></ul><h2>优先级</h2><p>优先改善端口和 bank 并行度，不建议先单纯扩大容量。当前峰值约 ${f(b.peakReservedMiB)} MiB，配置约 ${f(b.sramMiB)} MiB，余量有限。</p>`),
 'reports/rdma/k3_opt_05_prefetch_overlap.html':base('优化五：计算、通信与后续权重搬移重叠','把下一算子/下一层权重搬移放到当前 kernel、reduce 或 RDMA 通信期间。',metric+`<h2>目标流水</h2><div class="formula">t0: 当前层计算 ───────────────┐
t1: 下一层权重 RDMA/TMA ────────┼─ overlap
t2: 当前层输出 reduce/ACK ──────┘
t3: 下一层计算启动</div><h2>需要新增的约束</h2>`+table(['参数','建议范围','必须检查'],[['overlapDepth','2/3/4','SRAM峰值、NoC拥塞'],['weightPrefetchAhead','1～2 op','权重不能覆盖活跃 KV'],['commComputeOverlap','0～100%','不得隐藏不可重叠资源'],['evictionPolicy','weight/KV/partial','不能错误驱逐']])+`<p>当前模型对 global op 仍偏串行。真实收益取决于下一权重的到达时间是否早于 consumer deadline，不能简单从总带宽相除得到。</p>`),
 'reports/rdma/k3_opt_06_hierarchical_reduce.html':base('优化六：分层 reduce 与卡内先聚合','减少 96.7 μs card-local 合并及 Die 间重复数据搬运。',metric+`<h2>推荐数据路径</h2><div class="formula">L/H core local partial
        ↓
Die 内 Shared SRAM + Reduce
        ↓
卡内 8 Die 分组聚合
        ↓
RDMA 只传 card-level aggregate
        ↓
远端 SRAM mailbox / final reduce</div><h2>适用算子</h2>`+table(['算子','适用性','注意事项'],[['LSE merge','高','必须保持 m/l/O online softmax 语义'],['Attention output','高','先 Die 内合并 partial'],['Routed latent','中高','按 expert/token 分组'],['Wup/Shared output','中','需要确认输出分片和写入所有权']])+`<h2>关键参数</h2><span class="tag">hierarchicalReduce=true</span><span class="tag">dieGroup=2/4/8</span><span class="tag">remoteDirectReduce=true</span><p>分层 reduce 可能减少 wire bytes 和 phase，但会增加卡内 SRAM/NoC 压力，需要同时检查 shared SRAM 端口和 reduce 饱和。</p>`),
 'reports/rdma/k3_opt_07_rdma_direct_reduce.html':base('优化七：RDMA 直接进入 Shared SRAM/Reduce staging','减少 remote SRAM mailbox 到 shared SRAM/reduce 之间的二次搬运。',metric+`<h2>当前路径</h2><div class="formula">RDMA NIC → remote SRAM mailbox → NoC → Shared SRAM → Reduce</div><h2>候选路径</h2><div class="formula">RDMA NIC → addressable Shared SRAM staging window → Reduce</div><h2>必须保留的内存语义</h2><ul><li>远端目标地址检查和 slot ownership；</li><li>write visibility 与 commit 顺序；</li><li>ready/acquire 内存序；</li><li>reduce 完成后的 ACK；</li><li>epoch release 和 ABA 防护。</li></ul><p>该优化潜在收益较大，但需要将 RDMA 写口、shared SRAM 写口和 reduce 读口放入同一资源守恒模型，不能直接把中间拷贝时间设为零。</p>`),
 'reports/rdma/k3_opt_08_matrix_utilization.html':base('优化八：提高 Matrix 利用率与小矩阵填充率','降低 402.3 μs kernel 服务时间。',metric+`<h2>当前假设</h2><p>模型 matrix utilization 采用 65%，最佳候选通过 L/H core 混合覆盖不同算子尺寸。</p>`+table(['方向','做法','预期影响'],[['算子融合','QKV/RoPE/投影融合','减少中间写回和小 kernel'],['shape packing','合并多个小 M/N tile','提高阵列填充率'],['Expert 聚合','按 token regroup','降低小 batch 专家低填充'],['L/H 专用化','L 处理小矩阵，H 处理大矩阵','减少错误映射'],['利用率扫描','65%→75%→80%','需重新计面积/功耗']])+`<p>提高利用率通常比盲目提高 GHz 更稳健，但必须从真实算子 shape trace 校准。</p>`),
 'reports/rdma/k3_opt_09_launch_control.html':base('优化九：命令预提交与控制面降频','减少 35.9 μs launch 和部分同步等待。',metric+`<h2>建议</h2><ul><li>预提交 layer command queue 和 RDMA descriptors。</li><li>预绑定 remote SRAM 地址、epoch 和 slot。</li><li>用 event bitmap 替代逐 op 软件 launch。</li><li>将下一层 command 在当前层 reduce 开始时提交。</li><li>把控制面与 data plane 分离，避免每次通信等待 CPU/host-side 调度。</li></ul><h2>定位</h2><p>单独优化 launch 不能弥补 422 μs 缺口，但与 phase fusion、commit batching、prefetch overlap 结合后可减少关键路径上的气泡。</p>`),
 'reports/rdma/k3_opt_10_optimization_priority.html':base('优化十：综合优先级与下一轮搜索计划','将各优化点纳入可验证的架构设计流程。',metric+table(['优先级','优化点','当前相关瓶颈','建议动作','预期收益区间'],[['P0','通信 epoch 融合','344 μs RDMA transport','先做调度敏感性扫描','100～250 μs'],['P0','local SRAM 端口/bank','279 μs local TMA','扫 write ratio、独立 TMA port','80～150 μs'],['P1','prefetch overlap','kernel/TMA/通信气泡','扫 overlapDepth、ahead','50～150 μs'],['P1','分层 reduce','96.7 μs card-local','Die 内先聚合','30～100 μs'],['P1','Matrix 利用率','402.3 μs kernel','融合和 shape packing','50～100 μs'],['P2','commit/ACK batching','控制面和 phase 固定开销','group commit/bitmap','20～80 μs'],['P2','launch 预提交','35.9 μs launch','descriptor queue','10～30 μs'],['P2','SRAM 容量增加','当前峰值158.7 MiB','只作为端口优化配套','不直接保证收益']])+`<h2>下一轮搜索变量</h2><div class="formula">phaseFusionFactor
commitBatchSize
ackBatchSize
stripeKiB
overlapDepth
localWriteRatio
tmaDedicatedPort
hierarchicalReduce
remoteDirectReduce
matrixUtil
</div><p>推荐先固定 PPA 规格，做调度和协议敏感性扫描；确认能将 raw latency 从 ${f(b.rawUs)} μs 降到约 855 μs 后，再做面积、功耗、SRAM、带宽联合搜索。</p>`)
};
const links=Object.keys(files).map(k=>`<li><a href="./${k.split('/').at(-1)}">${esc(files[k].match(/<h1>(.*?)<\/h1>/)?.[1]||k)}</a></li>`).join('');
files['reports/rdma/k3_rdma_optimization_index.html']=base('K3 RDMA-SRAM 优化点总览','将当前瓶颈拆分为独立 HTML，便于架构评审、参数扫描和后续模型迭代。',metric+`<div class="box warn"><b>说明：</b>下列收益是优化方向和建模目标，不是已经实现的实测结果。所有收益必须加入资源守恒、PPA、SRAM峰值和内存语义约束后重新搜索。</div><h2>独立报告</h2><ul>${links}</ul><h2>当前基线账</h2>`+table(['项目','数值'],[['Kernel',f(b.services.kernel)+' μs'],['Local TMA',f(b.services.localTma)+' μs'],['RDMA memory transport',f(b.services.memoryTransport)+' μs'],['Card-local',f(b.services.cardLocal)+' μs'],['Reduce',f(b.services.reduce)+' μs'],['Launch',f(b.services.launch)+' μs'],['Phases',f(b.phases)],['Requests',f(b.requests)],['Peak SRAM',f(b.peakReservedMiB)+' MiB/Die'],['SRAM window',f(b.sramMiB)+' MiB/Die']]));
for(const [name,html] of Object.entries(files))fs.writeFileSync(name,html);
console.log('wrote',Object.keys(files).length,'html files');
