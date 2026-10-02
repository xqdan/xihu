# Architecture Council

## Mission
负责跨团队集成：需求、跨团队 contract、ADR、候选集成和 D-Gate。Council 同时拥有 `integration/`（跨团队代码）和 `docs/architecture/`（架构规格）。

## Directory

| Path | Content |
|---|---|
| [`adr/`](adr/README.md) | 架构决策记录，四位编号，一条决策一个文件 |
| `docs/` | 两阶段运行模型、协作协议、工业化组织、agent 指标与工作流计划（15–20 号文档）；现行流程以 [22 号文档](docs/22_AGENT_WORKFLOW_REFACTOR_PLAN.md) 为准 |
| `strategies/` | 12 个无状态 agent 策略正文（6 个领域专家 + 6 个固定职能）；由 `integration/orchestration/` 的 workflow 在运行时按 `agentId` 读取，不含路径与输出契约 |
| `docs/detailed/` | Stage B 详细设计控制面与 Q1–Q9 规格 |
| `docs/reviews/` | 多 agent 跨团队评审的运行存档（agent 生成，MODEL 等级，不是 ADR 或 gate 结论），脚本见 `integration/orchestration/` |
| `inputs/` | 运行模型、策略 roster（`agent_roster.json`，含 `consumers` 与 workflow 对账）、团队组织 roster、算术强度 contract 的机器可读版本（由 governance 测试检查） |

## Review and handoff
团队交付物经 Integration Review 进入 `integration/`；Council 以 ADR 记录决策，由 V&V 独立判定 Gate。修改跨团队 contract 须同时更新 `docs/architecture/contracts/`、新增 ADR，并由 V&V 增加测试。
