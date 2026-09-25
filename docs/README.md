# Documentation

仓库级文档入口。团队自有文档放在各自的 `teams/<team>/docs/`；这里只放不属于单个团队的架构规格和概览。

- [`architecture/`](architecture/README.md)：正式架构规格（Council 拥有）
  - `HIGH_LEVEL_ARCHITECTURE.md`：高层架构总纲和详细文档地图；
  - `00_CURRENT_STATE.md`：当前基线、证据等级和阻塞项；
  - `01_SYSTEM_ARCHITECTURE.md` 至 `10_TILE_SIMULATION.md`：分模块设计；
  - `11`–`14`、`21`：计划与交付、7R 单芯片、多模型、TPS 观测指标、TPS/usr 设计基线；
  - `OPEN_ISSUES.md`：需要 owner、证据和关闭日期的问题；
  - [`contracts/`](architecture/contracts/README.md)：跨团队接口 contract。
- [`overview/`](overview/k3_project_overview_deck.html)：项目概览幻灯片。
- 架构决策记录（ADR）：[`teams/council/adr/`](../teams/council/adr/README.md)。
- 运行模型、agent 目录与 Stage B 详细设计规格：[`teams/council/docs/`](../teams/council/docs/)。

新增详细规格时，优先按 `ARCH-xx` 编号放入对应模块，并保持每份文档具有：
范围、需求、接口、预算、正常/错误流程、模型、验证和未决项。
