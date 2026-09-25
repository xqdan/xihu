# ADR-0014：远端 SRAM 语义

- 旧编号：ADR-006（原 `docs/design/DECISIONS.md`，2026-09-25 迁入独立文件；正文只把 ADR 引用改为新编号）
- 日期：2026-09-20
- 决策：保留 write→visible→commit/ready→consume→ACK→release→epoch reuse。
- 状态：`BASELINE`
