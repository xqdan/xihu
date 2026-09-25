# Agent Collaboration Guide

本项目按工业界芯片团队组织：Hardware、Software、Model 三大专业团队并行设计，Architecture Council 负责集成和 ADR，独立 V&V 负责 Gate。

总组织说明：[`teams/council/docs/20_INDUSTRIAL_AGENT_ORGANIZATION.md`](teams/council/docs/20_INDUSTRIAL_AGENT_ORGANIZATION.md)
团队目录：[`teams/README.md`](teams/README.md)
机器可读 roster：`teams/council/inputs/industrial_agent_organization.json`

## 1. Team ownership

| Team | Directory | Ownership |
|---|---|---|
| Hardware | `teams/hardware/`（`inputs/` 硬件基线规格，`src/` resource profiles 与 compute node） | Package/floorplan, AI Core, SRAM/TMA, MC, NoC/Die-to-Die, PPA/RAS |
| Software | `teams/software/` | Deployment/runtime, compiler, kernels, fusion, collective overlap, scheduler, profiler |
| Model | `teams/model/`（`inputs/` manifest/profile，`src/design_engine.js` 为 K3 唯一形状来源，`src/workload_derivation.js`） | Model manifest, workload/operator ledger, scenarios, routing/sparsity, golden traces, model KPI |
| Architecture Council | `teams/council/`（ADR、运行模型文档、agent roster），`integration/`（跨团队代码），`docs/architecture/` | Requirements, contracts, ADR, candidate integration, D-Gate |
| V&V | `teams/vv/`, `tests/` | Independent schema, conservation, traceability, regression, Q-Gate |

目录规则（由 `tests/structure/test_project_structure.js` 强制）：

- `teams/<team>/` 只依赖本团队目录，不 require 其他团队、`integration/` 或 `out/`；跨团队组合一律放在 `integration/`。
- 每个专业团队的对外承诺写在 `teams/<team>/contract.json`，由 `integration/pipelines/generate_team_contracts.js` 合成到 `out/contracts/`。
- `out/` 只放 pipeline 生成物，不手工编辑；`archive/` 只读，不被活代码引用。

D1–D7 and Q1–Q9 remain compatibility aliases for the flow, but new work items must use `HW-*`, `SW-*`, `MODEL-*`, `ARCH-*`, or `VV-*` IDs.

## 2. Parallel work rules

- 每个 agent 领取明确的 Team、职责、输入版本、输出 artifact 和验收指标。
- 团队内部 peer review 后才能进入跨团队 Integration Review。
- 同一文件只有一个 owner；跨团队变更通过 `docs/architecture/contracts/` contract、ADR 和测试。
- 不直接编辑 runner 生成的 JSON/HTML，使用 generator 或明确 baseline snapshot 任务。
- 模型未确认字段标记 `UNVERIFIED_PLANNING_MANIFEST`；K3 的形状只能改 `teams/model/src/design_engine.js` 的 preset，manifest/profile/planning workload 由测试强制一致；软件收益必须带实现前提；硬件 peak 不等于 sustained。
- Gate 决策、候选登记状态和候选选择由 `integration/governance/evaluate_gates.js` 和 runner 中的显式策略计算，任何 runner 不得写入 `PASS`/`D_GATE_PASSED` 字面量。
- 合成事件不能使 Q-Gate 通过；V&V 不能修改被测数据来制造通过。

## 3. Shared contracts

- Model workload/operator contract；
- deployment-to-hardware ABI；
- Tile IR、layout、buffer lifecycle、epoch；
- NoC packet、MC transaction、RDMA transaction；
- fusion legality 和 collective overlap contract；
- KPI、latency budget、PMU event 和 golden trace。

修改公共契约前，必须更新 `docs/architecture/contracts/` 或新增 ADR，并由 V&V 增加回归测试。

## 4. Industrial review cadence

- Team Review：团队内部设计和风险；
- Integration Review：Hardware/Software/Model 接口；
- Architecture Review Board：候选、PPA、软件收益、模型覆盖；
- V&V Gate Review：独立验证 D/Q Gate；
- Performance Backflow Review：性能不达标时回到硬件/软件/模型责任人，不直接修改 Gate。

## 5. Definition of done

- 代码、设计文档、机器数据和测试一致；
- `npm test`、`npm run check:structure` 通过；
- 性能结论包含模型版本、输入假设、seed 和单位；
- 规划估算、validated replay、silicon observation 明确区分；
- PR 可以由不熟悉上下文的 reviewer 独立复现。
