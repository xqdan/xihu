# Teams

本目录按工业界职责划分。每个团队一个目录，拥有自己的 README、设计文档（`docs/`）、输入数据（`inputs/`）、代码（`src/`），专业团队另有对外承诺 `contract.json`。

- [Model Team](model/README.md)：模型 manifest、workload 推导，K3 唯一形状来源 `model/src/design_engine.js`
- [Hardware Team](hardware/README.md)：唯一硬件规格（P1，8 die + 16 MC 的 7-reticle 封装）与 resource profiles
- [Software Team](software/README.md)：部署、kernel、fusion、collective 策略
- [Architecture Council](council/README.md)：ADR、运行模型、跨团队集成（同时拥有 `integration/` 与 `docs/architecture/`）
- [V&V](vv/README.md)：独立验证（测试在根目录 `tests/`）
- 跨团队接口：[`docs/architecture/contracts/`](../docs/architecture/contracts/README.md)

依赖规则：团队目录只依赖本团队文件，不 require 其他团队、`integration/` 或 `out/`。需要组合多个团队结果的代码放在 `integration/`，其生成物写入 `out/`。`tests/structure/test_project_structure.js` 强制这条规则。

团队文档描述“谁负责什么”；旧 D/Q Agent 描述“设计流程如何运行”，二者通过 `council/inputs/industrial_agent_organization.json` 映射。

可视化 Agent 文档：[Agent Organization HTML](../out/agents/agent_organization.html)
