# Documentation

仓库级文档入口。团队自有文档放在各自的 `teams/<team>/docs/`；这里只放不属于单个团队的架构规格。

- [`architecture/`](architecture/README.md)：正式架构规格（Council 拥有）
  - `HIGH_LEVEL_ARCHITECTURE.md`：高层架构总纲和详细文档地图；
  - `00_CURRENT_STATE.md`：当前基线、证据等级和阻塞项；
  - `01_SYSTEM_ARCHITECTURE.md`、`10_TILE_SIMULATION.md`：系统架构与 tile 模拟；
  - `11`、`13`、`14`、`21`：计划与交付、多模型、TPS 观测指标、TPS/usr 设计基线；
  - `OPEN_ISSUES.md`：需要 owner、证据和关闭日期的问题；
  - [`contracts/`](architecture/contracts/README.md)：跨团队接口 contract。
- 团队设计文档（按签核团队存放）：硬件单元设计 [`teams/hardware/docs/`](../teams/hardware/docs/)，软件设计 [`teams/software/docs/`](../teams/software/docs/)，模型部署方案 [`teams/model/docs/deployment/`](../teams/model/docs/deployment/README.md)。
- 架构决策记录（ADR）：[`teams/council/adr/`](../teams/council/adr/README.md)。
- 运行模型、agent 目录与 Stage B 详细设计规格：[`teams/council/docs/`](../teams/council/docs/)。

新增详细规格时，优先按 `ARCH-xx` 编号放入对应模块，并保持每份文档具有：
范围、需求、接口、预算、正常/错误流程、模型、验证和未决项。
