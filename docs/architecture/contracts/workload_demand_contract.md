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

`npm run network:requirements` 生成 `out/requirements/network_requirements.json`。它复用现有 collective protocol 和 topology kernel，按 topology / collective class / directed link 记录 packet bytes、链路容量、利用率和名义路径 P50/P95/P99；当前只对发布点 K3、TP32、batch 1、1M context、decode 建模，其他场景显式 `BLOCKED_CONFIG`。`dieLocal` 是 NoC 平衡代理，`dieToDie` 是 8-die ring cut 下界，`package` 是同一资源的别名，`scaleOut` 是卡外拓扑 link，`collective` 是服务类别而非第五种物理链路，不能相加。

路径分位数是 nominal route distribution 的 nearest-rank 统计，不是运行时排队尾延迟；运行时 P99 保持 `null/UNVERIFIABLE_NO_QUEUEING_TRACE`。带宽 P99 仅使用 workload 的 `1.25` planning multiplier。ACK wire、重传、MTU 分片、背景 DMA、NoC 路由细节和拓扑选择均排除，SerDes/FEC/switch/relay 延迟仍是 `ASSUMPTION`，不能用于 Gate 通过。

该账本是 planning 证据，不等同于 sustained silicon measurement。L1 budget contract 只消费满足目标所需的算力、MC 带宽、SRAM、tau 和 PPA 条目，同时原样携带 `demandRequirements` 供 L2/L3 追溯。
