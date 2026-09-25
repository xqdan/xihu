# External references

本仓库只保留外部资料的来源说明，不默认提交供应商 PDF、受限白皮书或私有材料。

当前设计使用过的参考资料包括：

- Memory Cube brief specification：用于 MC 容量、UCIe 和带宽假设的来源追踪；
- d-Matrix / Tensordyne 等公开资料：用于架构比较和风险分析；
- `k3_1000tps_chip_designs.html`：K3 1000 TPS/usr 规格网格搜索页（内部工程材料，2026-09-23 从工作区 `docs/1000tps/` 入库；`HIGH_LEVEL_ARCHITECTURE.md` 第 2 节和 ADR-011 的 MC/SRAM/算力档位来自此页）。页内脚本引用改为仓库内 `../src/core/`。

如需在本地使用原始文件，请放入 `references/private/`，不要提交到公共 GitHub
仓库。设计文档必须记录版本、来源和允许使用的假设，而不是依赖本机绝对路径。
