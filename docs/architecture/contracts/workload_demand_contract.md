# Workload Demand Contract

版本：`demand-requirements-v0.1`

`out/requirements/workload_requirements.json` 是 Model 团队给 Architecture Council 的规划需求账本。它把四类量分开：

- `compute`：目标 token rate 下的 FLOP/s；
- `capacityBytes`：权重、KV resident state、运行时 state；
- `bandwidthBytesPerSecond`：weight、expert、KV/state、collective 分层流量；
- `network`：集合通信流量及 P99 放大因子。

每个模型必须覆盖 `batch/context/TP/phase/precision` 场景。未知的 NoC、die-to-die、package、scale-out 分配不能从 aggregate collective 流量臆测，必须由 Hardware/Software 的互联合同补齐；因此 `requiredGBsByClass` 对未建模层保留 `null`。

## 场景单一来源

默认场景唯一来源为 `teams/council/inputs/brief_intents.json#/scenarios`，按 DesignBrief 的 `scenarios` schema 校验。`make_brief.js`、需求内核和 L1 frontier 消费同一目录，不再持有独立默认场景。`scenarioId` 全目录唯一，`model` 精确匹配模型；不允许把一个 K3 场景隐式复制给其他模型。其他模型的精度由各自 planning ledger 的 dtype policy 约束，仍保留模型形状及部署假设，不提升证据等级。

每个场景使用自己的 `targetTpsPerUser × batch` 计算 aggregate token rate。`precision` 当前表示 dense projection + KV policy 的简写，完整 routed/shared/router 精度在 `assumptions.precisionPolicy` 中保留；不同精度不能仅换标签、沿用字节账。尚未派生的 `prefill`、`mixed` 或不匹配的精度场景输出 `BLOCKED_CONFIG`，需求数值为 `null`，不得套用 decode 公式。

`inputs.sourceArtifacts` 包含场景目录、schema 和需求内核的 sha256；`inputs.scenarioCatalogSha256` 钉住实际使用的目录。runner 拒收过期账本、brief 场景不匹配及被阻塞的场景。自定义 brief 可先运行 `npm run workload:requirements -- --brief <file>`，再运行 `req.workload --brief <file>`。L1 合同中的 `demandRequirements.scenarioCatalog` 与对应模型场景必须一致。

场景需求目前是独立规划账本，**不是 L1 budget entries 的多场景联合约束**。L1 条目及 Gate 仍基于原有 TP32 / decode 计算；batch/context 扩展未经过独立详细回放，`baselineSlot` 仅供原始 ledger 时延参照，不能当作该扩展场景的性能预测。

`npm run network:requirements` 生成 `out/requirements/network_requirements.json`。它复用现有 collective protocol 和 topology kernel，按 topology / collective class / directed link 记录 packet bytes、链路容量、利用率和名义路径 P50/P95/P99。K3 的 batch 1、1M context、decode 同时登记 TP32 发布协议和 TP16 的显式协议投影；TP16 只证明 peer 数、分片 payload、消息/链路守恒和拓扑路由，不声明 TP16 的算力、SRAM、容量或端到端 TPS，且 `detailedReplaySupported=false`。其他场景显式 `BLOCKED_CONFIG`。`dieLocal` 是 NoC 平衡代理，`dieToDie` 是 8-die ring cut 下界，`package` 是同一资源的别名，`scaleOut` 是卡外拓扑 link，`collective` 是服务类别而非第五种物理链路，不能相加。

路径分位数是 nominal route distribution 的 nearest-rank 统计，不是运行时排队尾延迟；运行时 P99 保持 `null/UNVERIFIABLE_NO_QUEUEING_TRACE`。带宽 P99 仅使用 workload 的 `1.25` planning multiplier。ACK wire、重传、MTU 分片、背景 DMA、NoC 路由细节和拓扑选择均排除，SerDes/FEC/switch/relay 延迟仍是 `ASSUMPTION`，不能用于 Gate 通过。

## TP16 协议投影边界

`network-requirements-v0.2` 的 `scope.tp=[16,32]` 与 `scope.detailedReplayTp=[32]` 分别声明协议与详细映射范围。每个场景的 `mapping` 记录范围，`endToEndTpsPerUser` 保持 `null`。TP16 沿用 reference-393 的五类 collective 次数和全组逻辑 payload，不把 payload 除以 TP 后再分片；每条 oneShot message 是 pass bytes / TP / active NICs，peer 数是 TP-1。队列上下文与 receive slots 随 TP 重算，物理 message 数不使用 final-tuning 的 fused phase/requests 展示计数。

K3 head 数和 latent 维度只取 `teams/model/src/design_engine.js` preset，LSE 每 rank 为 heads/TP 个完整 head。TP16 的 6 个 head 分别放在前 6 个 NIC die 上，这是未经软件调度回放的规划假设；TP32 保留发布点的 3 个 NIC。Comm Core 控制路径成本在 TP16 暂沿用 TP32 值，不能把其 latency corners 当作 TP16 固件实测。卡内仍为 8-die ring，cut 与 balanced NoC 只覆盖 collective，不覆盖 TP16 新增的计算/KV 访存。

硬件输入 `scaleout_topology_candidates.json#/topologies/*/rankVariants/16` 显式列出 TP16 拓扑：mesh 为 15×4 lanes（不把闲置 lanes 自动加宽），rail 保留 16 lanes/die，leaf-spine 是 4 leaves×4 cards、4 spines，torus 为 4×4，ring 为 16。未定义的 TP 或模型/精度/batch/context 仍阻塞。TP16 的控制路径、NIC 放置、buffer 可行性以及完整算子映射需分别确认后，才能扩大详细 replay 范围。

该账本是 planning 证据，不等同于 sustained silicon measurement。L1 budget contract 只消费满足目标所需的算力、MC 带宽、SRAM、tau 和 PPA 条目，同时原样携带 `demandRequirements` 供 L2/L3 追溯。
