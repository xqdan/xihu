# Agent Collaboration Guide

本文件是所有 agent、同事和自动化任务的协作入口。目标是保持每个改动小、
边界清晰、可回归，并避免多个 agent 同时破坏公共模型契约。

## 1. 模块 ownership

| 模块 | 目录 | 主要责任 |
|---|---|---|
| Workload / KPI | `docs/design/`, `data/` | 模型清单、dtype、KPI、基线假设 |
| Core / memory | `src/core/`, `src/simulation/` | Compute、SRAM、TMA、算子级模型 |
| Architecture search | `src/search/` | 设计空间、约束、Pareto 和搜索回归 |
| RDMA / collective | `src/rdma/` | mailbox、epoch、reduce、scale-out 模型 |
| Reports | `scripts/`, `templates/`, `reports/` | 生成器、模板和可审阅报告 |
| Verification | `tests/` | 回归、结构、物理守恒和 golden checks |
| Architecture docs | `docs/design/` | 系统规格、ADR、open issues、计划 |

## 2. Parallel work rules

- 每个 agent 领取一个明确的模块或 issue，不跨 ownership 随意重构。
- 同一文件默认只允许一个 active owner；需要并发编辑时先拆分章节或复制到
  独立 proposal 文件。
- 先修改契约，再修改实现：Tile IR、数据 schema、接口、路径或状态机变化，
  必须同时更新对应设计文档和测试。
- 不直接编辑由脚本生成的 JSON/HTML，除非任务明确是更新 baseline snapshot。
- 不删除旧结果；需要淘汰时移动到明确的迁移任务中，并记录 ADR。
- 不把供应商未确认的数字标记为 `FROZEN`。

## 3. Task handoff format

每个 agent 完成任务时至少留下：

```text
Scope: 修改了哪些模块
Decision: 做了什么架构/模型决定
Assumptions: 使用了哪些假设
Files: 主要文件
Validation: 运行的命令和结果
Risks: 尚未关闭的风险
Next: 后续 agent 可以接手的任务
```

## 4. Shared contracts

以下内容是跨 agent 公共契约：

- K3 layer manifest 和 dtype manifest；
- Tile IR / descriptor；
- 地址、layout、buffer lifecycle 和 epoch 语义；
- NoC packet、MC transaction、RDMA transaction；
- KPI 和 raw/e2e latency budget；
- PMU event 和 golden trace 格式。

修改这些契约前，必须先更新 `docs/design/DECISIONS.md` 或新增 ADR，
并补充至少一个回归测试。

## 5. Definition of done

任务只有在以下条件满足时才算完成：

- 代码、设计文档和测试保持一致；
- `npm test` 通过，或明确记录已知失败及原因；
- 未引入未说明的全局缩放因子；
- 性能结论包含输入假设、seed、模型版本和单位；
- 不包含秘密、供应商凭证或本机路径；
- PR 可以由不了解上下文的 reviewer 独立复现。
