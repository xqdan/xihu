// Regenerate architecture capacity documents from local model assumptions.
// Run: node generate_sram_architecture_capacity.js
const fs=require('fs'),vm=require('vm'),P=require('../src/sram_operator_peak.js'),E=require('../../../teams/model/src/design_engine.js');
const html=fs.readFileSync('docs/sram/sram_frontier_model_assessment.html','utf8');
const match=html.match(/const profiles=([\s\S]*?);\nconst schemes/);
if(!match) throw Error('Local profile block not found');
const profiles=vm.runInNewContext('('+match[1]+')');
profiles.k3=E.MODEL_PRESETS.kimiK3;
const results=Object.values(profiles).map(p=>P.estimate(p));
const labels=['DeepSeek 结构假设','GLM 结构假设','K3 项目口径'];
const descriptions=[
 ['weight','需求权重 A/B','2 × 8 MiB','投影、W_O、Router、专家、共享专家按 tile 流式消费','DMA 填充→MAC 最后读取→释放；A/B 可跨算子复用','固定双缓冲池；8 MiB/tile 是设计选择，不是推导出的带宽最优值'],
 ['spec','未来两层预测专家','D × min(E,BK) × 3IF × (17/32) / TP','当前层以外的两层完整专家集合','预测写→路由确认→消费/淘汰；DMA 未完成不可覆盖','可抢占；只缓存压缩权重，不额外保存整份解码副本'],
 ['kv','Attention KV A/B','2 × B × T × d_KV × 2 bytes','KV tile 双缓冲，不存整个 1M 上下文','当前 tile 的 QK 和 PV 都结束后复用','可与 MoE scratch 跨阶段复用；不保证跨 MC 共享'],
 ['kvWrite','新增 KV 写回','B × d_KV × 2 bytes','新增 token KV 的持久写回源','store ACK 前保留','小型 writeback pool；未计多个未完成 step'],
 ['q','Query','B × h_local × d_Q × 2 bytes','Attention 各 context tile 重复读取 Q','投影产生→最后一个 Attention tile 结束','可在 Attention 完成后归还 scratch'],
 ['score','Score / probability','2 × B × h_local × T × 4 bytes','非原位 FP32 score/probability 双数组','每个 QK→softmax→PV tile 循环','两份都计；融合原位实现可降低'],
 ['attentionStats','O / max / sum','B × h_local × (d_V+2) × 4 bytes','Attention FP32 输出累加和在线 softmax 统计','跨 KV tile 保留→LSE/O projection 消费完','与最终输出布局/重排另行核对'],
 ['residual','Residual / norm','2 × B × H × 2 bytes','两个 BF16 hidden-size 缓冲','保留 skip 输入及 norm/新 residual；add 后交换','假定原位 residual add；非原位实现可能多需一份'],
 ['route','Router / 路由索引','B × E × 4 + BK × 16 bytes','FP32 router logits 和 Top-k 元数据','Router→dispatch→weighted merge 完成','16 byte/assignment 是描述符设计假设'],
 ['dispatch','Dispatch 激活','BK × I × 2 bytes','按专家整理的输入激活','打包→gate/up 最后一次读取','TP 本地打包；不是 EP all-to-all 完整预算'],
 ['hidden','Expert gate/up/hidden','3 × BK × ceil(F/TP) × 2 bytes','gate、up、激活结果三份分片张量','gate/up→SiLU×up→down','串行处理；其他 TP 切分方式需重算'],
 ['output','Expert 输出','BK × I × 4 bytes','每条 token-expert assignment 的 FP32 输出','down→加权 merge 完成','按未分片输出保守计，不与 hidden 默认 alias'],
 ['shared','共享专家 scratch','3B × ceil(F/TP) × 2 + BH × 4 bytes','共享专家三个中间张量和输出','本调度串行执行 shared 分支','与 routed scratch 可复用；并行执行需加算重叠'],
 ['comm','通信 send/recv','max(2BH × 4, 2 × S_AttnStats)','一次 TP reduction 或 LSE 合并的两个缓冲','NIC/DMA completion + 消费者结束再释放','单 outstanding collective；多通道/多请求按并发重算'],
 ['linearStateIO','线性 Attention 状态 A/B','2 × B × h_local × stateDim² × 2 bytes','当前与下一线性层 BF16 状态搬入/写回','读入→更新→store ACK 后复用','仅 K3；状态主体在外部存储，不是 69 层全部常驻'],
 ['linearStateUpdate','线性 Attention FP32 更新','B × h_local × stateDim² × 4 bytes','当前线性层状态更新工作区','当前层状态更新→转 BF16→写回','仅 K3；和 BF16 A/B 独立计数；实际 kernel 需回标'],
 ['meta','控制与元数据','1 MiB 固定预留','DMA 描述符、引用计数、generation、allocator 表等','池级长驻','工程预留，需按队列深度、tile 数和 ECC 状态表回标']
];

const vals=(r,k)=>Math.max(...r.stages.map(s=>s.parts[k]||0))/P.MiB;
const table=descriptions.map(([k,...d])=>[d[0],...results.map(r=>vals(r,k).toFixed(6)),...d.slice(1)]);
const header=['SRAM 对象',...labels.map(n=>n+' MiB/卡'),'容量公式','用途','生命周期 / 复用','架构约束'];
const markdown=(heads,rows)=>'| '+heads.join(' | ')+' |\n| '+heads.map(()=>'---').join(' | ')+' |\n'+rows.map(r=>'| '+r.join(' | ')+' |').join('\n')+'\n';
fs.writeFileSync('archive/sram_html_models/data/sram_architecture_capacity.csv','\ufeff'+[header,...table].map(r=>r.map(c=>'"'+String(c).replaceAll('"','""')+'"').join(',')).join('\n')+'\n');
const envelope=descriptions.reduce((sum,[k])=>sum+Math.max(...results.map(r=>vals(r,k))),0);
let md=`# SRAM 架构容量需求表：DeepSeek / GLM / Kimi K3

版本：2026-09-19。范围：每卡可用数据 SRAM；未含物理 ECC、spare、tag/目录等宏实现开销。

## 1. 决策摘要

- **可重分配池：256 MiB/卡**，一次部署三者中的一种；覆盖本次各模型静态分池加 25% 的预算。不代表三模型同时运行。
- **跨模型固定分区：288 MiB/卡**，按逐对象跨模型上界加 25% 后取整。K3 加入后仍为此档位，但必须增加线性 Attention 状态缓冲。
- K3 按 **线性 Attention 状态在外部存储、SRAM 流式更新**计算；若 69 层状态全部常驻 SRAM，则 256 MiB 预算需要重新评估，见第 5 节。
- 本表是架构容量账，不是实测模型规格或 TPS 保证；未关闭的硬件对象必须量化后重新签核。

## 2. 模型与部署假设

DeepSeek / GLM 沿用 sram_frontier_model_assessment.html 中未确认的结构假设；K3 直接读取 design_engine.js 的 kimiK3 预设（项目计算器口径，非官方规格认定）。

${markdown(['参数',...labels],[
['Hidden H',8192,8192,7168],['Query heads',128,128,96],['TP / 本卡 query heads','32 / 4','32 / 4','32 / 3'],
['专家总数 E / Top-k','512 / 8','256 / 8','896 / 16'],['专家输入 I / 中间 F','4096 / 3072','8192 / 3072','3584 / 3072'],
['共享专家数',1,1,2],['Attention','MLA 假设','GQA 假设','24 层 Softmax MLA + 69 层线性 Attention'],
['本卡 KV 元素/token',576,256,576],['B=8 专家并集上界',64,64,128],['每专家每卡 MiB',...results.map(r=>(r.expertBytes/P.MiB).toFixed(6))]
])}
统一 B=8、TP=32、一个 rank 对应本次每卡口径；Context=1M，KV tile T=2048；当前需求权重 8 MiB × 2；未来层预取 D=2（当前层以外的两层完整预测专家集合）。容量上界取 min(E,B×Top-k)，不是平均并集；预测准确率 p 不缩减容量。激活/KV BF16；专家压缩权重 17/32 byte/参数；累加/score/logits FP32。TP=32 可同时整除 128 和 96 query heads，与旧 TP=24 曲线独立。

GQA 每 rank 至少一个 KV head（允许复制），MLA latent KV 按 TP 复制。不存整段 1M KV；K3 的 24 个 Softmax 层串行，因此不能把单层 KV scratch 乘以 24。

共享专家串行执行并累加到同一输出。K3 的两个共享专家不把 scratch 直接乘二；并行实现必须重算。所有层串行、单 outstanding collective、本地 TP dispatch；多 step overlap / EP 不在本预算内。

## 3. 对象容量详细表

每行是该对象的最大占用，不代表所有行同时存活。零表示该模型未使用此对象。

${markdown(header,table)}
## 4. 容量汇总与峰值时刻

${markdown(['口径',...labels],[
['运行 live 峰值 MiB',...results.map(r=>r.usableMiB.toFixed(3))],
['静态分池合计 MiB',...results.map(r=>(r.staticBytes/P.MiB).toFixed(3))],
['live 峰值加 25% MiB',...results.map(r=>r.withReserveMiB.toFixed(3))],
['静态分池加 25% MiB',...results.map(r=>(r.staticBytes/P.MiB*1.25).toFixed(3))],
['静态分池配置（32 MiB 取整）',...results.map(r=>r.staticProvisionMiB)]
])}
三个模型的运行峰值均在 Softmax Attention 的 QK→softmax→PV 阶段：需求权重 A/B、KV A/B、两层预测专家、Q/score/O 统计、residual、KV 写回及 metadata 同时存活。K3 的线性状态流式工作区与 Softmax scratch 不同时使用。

**逐对象跨模型固定分区上界 = ${envelope.toFixed(3)} MiB**；加 25% = **${(envelope*1.25).toFixed(3)} MiB**；32 MiB 取整 = **${Math.ceil(envelope*1.25/32)*32} MiB/卡**。可重分配预算与固定预算不同，不能把较大 KV、较大专家缓存等分别锁死后仍沿用单模型容量余量。

## 5. K3 线性 Attention 状态的额外选择

沿用引擎 stateDim=128，按本卡 3 heads、B=8：

- 单层 BF16 状态：8×3×128²×2 bytes = **0.75 MiB/卡**。
- BF16 状态 A/B 搬入与写回缓冲：**1.50 MiB**。
- 当前层 FP32 更新工作区：**1.50 MiB**。
- 因此流式更新工作区共 **3.00 MiB**，只在当前线性 Attention 阶段存活。
- 69 层 BF16 状态主体共 **${(results[2].linearStateBackingBytes/P.MiB).toFixed(2)} MiB/卡**，默认在外部存储；不能遗漏其外部容量和读写带宽。

若将 69 层 BF16 状态全部常驻 SRAM，同时仍保留 A/B 和 FP32 更新缓冲（保守、不做 alias 优化）：

- 运行峰值 = ${results[2].usableMiB.toFixed(3)} + 51.750 = **${(results[2].usableMiB+51.75).toFixed(3)} MiB**。
- 静态分池 = ${(results[2].staticBytes/P.MiB).toFixed(3)} + 51.750 = **${(results[2].staticBytes/P.MiB+51.75).toFixed(3)} MiB**。
- 静态分池加 25% 后 **${((results[2].staticBytes/P.MiB+51.75)*1.25).toFixed(3)} MiB**；向上取整为 **${Math.ceil((results[2].staticBytes/P.MiB+51.75)*1.25/32)*32} MiB/卡**（仅 K3 单模型口径）。
- 若状态主体为 FP32，常驻主体变为 103.50 MiB，必须再重算；不能直接沿用 BF16 状态存储预算。

## 6. 288 MiB 固定分池建议（三模型，K3 状态流式）

${markdown(['可用数据池','配置 MiB','组织与约束'],[
['当前需求权重 A/B',16,'8+8；同时读写需独立 bank/端口'],
['未来两层专家预取',160,'80+80；覆盖 GLM 153 MiB，K3 133.875 MiB'],
['KV tile A/B',40,'20+20；覆盖 DS/K3 36 MiB'],
['激活 / 路由 / 通信 / 线性状态 scratch',8,'逐对象跨模型最大值合计约 '+(envelope-16-153-36-1).toFixed(3)+' MiB；含 K3 3 MiB 线性状态工作区'],
['控制 / metadata',2,'初始明确预算 1 MiB；队列规模需回标'],
['未分配 bank / 工程容量预留',62,'与已分配池内余量一起形成工程裕量，不是已确认对象'],
['合计',288,'只说明容量；布局可达性与 SRAM 带宽单独验证']
])}
## 7. 待关闭的实现问题

1. **解量化**：当前需求池与预测池均按存储字节计算。若另存 BF16 解码 tile，追加同时存活参数数×2 bytes；完整解码副本不能默认被 8 MiB tile 或 25% 余量覆盖。
2. **投影/重排 scratch**：MLA latent down/up、RoPE、阵列 partial-sum 与输出布局转换尚未确定；核对哪些落寄存器、哪些落 SRAM。Norm/Residual 假定原位 add。
3. **线性 Attention kernel**：目前状态形状只来自 K3 项目 stateDim；未得到实际 kernel 的门控、卷积状态与临时张量。3 MiB 是显式状态更新预算，不声称包含所有潜在 kernel 对象。
4. **并发**：K3 两共享专家若并行、多个 collective 在途、EP all-to-all、多个 decode step overlap，需增加各自 live 对象。需求补读优先于未来层预测。
5. **物理池**：每卡容量不得简单除以 MC 数判定可行；检查每个 Die/MC 可达池及局部峰值。验证 SRAM 读写端口、bank 冲突及 DMA 与 collective 链路竞争。
6. **ECC/spare/tag**：表内为可用数据容量。示例每 64 数据 bit 配 8 校验 bit 时仅 bit 容量乘 1.125；未指定 ECC 实现，不含外围面积、spare 与目录。
7. **25% 工程余量不是带宽证明**：按算子/tile deadline 检查预取是否完成，不能用整模型 compute 时间隐藏单层 DMA；未量化对象要逐项追加后重算。

## 8. 文档与复算

- sram_architecture_capacity.md：本需求文档。
- sram_architecture_capacity.csv：17 项对象、三模型容量、公式及生命周期；UTF-8 BOM，可用 Excel 打开。
- sram_operator_peak.js：算子阶段容量计算；K3 增加线性 Attention 状态阶段。
- generate_sram_architecture_capacity.js：运行 node generate_sram_architecture_capacity.js 重建本 MD/CSV；DeepSeek/GLM 来自本地页面，K3 来自 design_engine.js。
`;
fs.writeFileSync('archive/sram_html_models/reports/sram_architecture_capacity.md',md);
console.log(JSON.stringify({models:results.map(r=>({name:r.name,liveMiB:r.usableMiB,staticMiB:r.staticBytes/P.MiB,planMiB:r.staticProvisionMiB})),envelopeMiB:envelope},null,2));
