# ADR-0010：主存储路线

- 旧编号：ADR-002（原 `docs/design/DECISIONS.md`，2026-09-25 迁入独立文件；正文只把 ADR 引用改为新编号）
- 日期：2026-09-20
- 决策：本轮以外置 Memory Cube 为主线，MC 不承担 Tensor/GEMM。
- 状态：`BASELINE`
- 影响：近存计算 MC 文档保留为备选，不与主线性能数字混用。
