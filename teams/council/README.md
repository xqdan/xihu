# Architecture Council

## Mission
负责跨团队集成：需求、跨团队 contract、ADR、候选集成和 D-Gate。Council 同时拥有 `integration/`（跨团队代码）和 `docs/architecture/`（架构规格）。

## Directory

| Path | Content |
|---|---|
| [`adr/`](adr/README.md) | 架构决策记录，四位编号，一条决策一个文件 |
| `docs/` | 两阶段运行模型、agent 目录与协作协议、工业化组织、agent 指标与工作流计划（15–20 号文档） |
| `docs/detailed/` | Stage B 详细设计控制面与 Q1–Q9 规格 |
| `inputs/` | 运行模型、agent 目录、组织 roster、算术强度 contract 的机器可读版本（由 governance 测试检查） |

## Review and handoff
团队交付物经 Integration Review 进入 `integration/`；Council 以 ADR 记录决策，由 V&V 独立判定 Gate。修改跨团队 contract 须同时更新 `docs/architecture/contracts/`、新增 ADR，并由 V&V 增加测试。
