# External references

本仓库只保留外部资料的来源说明，不默认提交供应商 PDF、受限白皮书或私有材料。

当前设计使用过的参考资料包括：

- Memory Cube brief specification：用于 MC 容量、UCIe 和带宽假设的来源追踪；
- d-Matrix / Tensordyne 等公开资料：用于架构比较和风险分析；
- `k3_1000tps_chip_designs.html`：K3 1000 TPS/usr 规格网格搜索页（内部工程材料，2026-09-23 从工作区 `docs/1000tps/` 入库；`HIGH_LEVEL_ARCHITECTURE.md` 第 2 节和 ADR-011 的 MC/SRAM/算力档位来自此页）。页内脚本引用改为仓库内 `../src/core/`。

如需在本地使用原始文件，请放入 `references/private/`，不要提交到公共 GitHub
仓库。设计文档必须记录版本、来源和允许使用的假设，而不是依赖本机绝对路径。

## `sota/`

领域 SOTA/经典方案知识库，由 `integration/orchestration/design.learn.workflow.js`（一次性脚本）生成，供各领域专家实例判断"本项目的假设是否偏离行业常规"。见 [`sota/README.md`](sota/README.md)。

与上面的资料清单不同，`sota/` 的条目**不是证据**：没有仓库内出处，不得作为 claim 的 evidence，也不得用来改写任何基线数字。

## `external/`

按前提临时的外部参照系，由 `design.audit` 的可选阶段（传入 `args.premises` 时）生成，文件名形如 `external_references_<runId>.md`。

它和 `sota/` 的分工：`sota/` 按领域一次性沉淀，回答"这个领域通常怎么做"；`external/` 按前提每轮调研，回答"这个系数偏离常规吗"。

两者都不是证据。`external/` 的条目尤其要注意：它落在 `references/` 下而非 `out/` 下，是刻意的——`design.audit` 与 `design.verify` 的 intake 门只接受 `out/` 下的路径，参照系因此永远进不了下一轮的复核对象，也就没有被当成证据的机会。

