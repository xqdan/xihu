# ADR-0016：卡内拓扑

- 旧编号：ADR-008（原 `docs/design/DECISIONS.md`，2026-09-25 迁入独立文件；正文只把 ADR 引用改为新编号）
- 日期：2026-09-20
- 候选：4×2 mesh + 4+4 hierarchical reduce。
- 状态：`OPEN`
- 关闭条件：packet 模型、封装 floorplan 和 PPA 同时通过。

## 2026-10-02 现状说明（不改变状态）

- 性能模型按 8 Die 双向环计（`dieCutGB = 2 × uciePortGB`，切面 2 条链路）；封装文档 06 采用 4×2 mesh（切面 4 条竖向链路）。两者口径不同，当前模型取环，是保守口径。
- 在本 ADR 关闭之前，所有 TPS/usr 数字都是"环口径"，不得当作 mesh 的结果引用；mesh 额外需要的 UCIe 端口（每 Die 多 1–2 个）要在 09 号文档的 shoreline 里核算。
- 对应阻塞项：B-004（卡内拓扑）。关闭条件不变。
