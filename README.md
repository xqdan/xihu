# K3 Architecture Repository

K3 推理芯片架构设计、性能建模、设计空间搜索和验证的协同开发仓库。

本仓库是一个适合 GitHub 协作的初始版本，目标是让架构师、模型工程师、
RTL/IP 团队和多个 agent 可以在清晰的模块边界内并发工作。

> 当前项目目标是 K3 Decode inference：B=1、Context=1M、TP32、PP=1，目标
> `1000 TPS/usr`。`1050 TPS/usr` 是架构冻结门槛。当前数据和 PPA 仍包含工程
> 假设；特别是 MC 带宽路线和精确 tile 模型尚未完成最终签核。

## Repository layout

```text
src/                         可执行模型和搜索程序
├── core/                    通用设计、存储和 Compute Node 模型
├── simulation/              93 层算子 / SRAM / DMA / Compute 模拟器
├── search/                  架构和 B=1 搜索
└── rdma/                    RDMA-to-SRAM、Collective 和 Final Tuning 模型

scripts/                     报告生成、复算和分析入口
tests/                       自动化回归测试
templates/                  HTML 报告模板
data/                        可复现的 baseline 输入和搜索结果
reports/                     由脚本生成的审阅报告快照
docs/design/                高层架构、当前状态、计划、决策和未决问题
references/                 外部资料来源说明；供应商原始文件不默认入库
.github/                    CI、PR 模板和协作配置

AGENTS.md                    多 agent 协作边界和工作协议
CONTRIBUTING.md              分支、提交、评审和验证要求
```

## Quick start

需要 Node.js 18 或更高版本；不需要第三方 npm 依赖。

```sh
npm test
```

常用命令：

```sh
npm run search:architecture
npm run search:b1
npm run search:rdma
npm run search:final
npm run report:architecture
npm run report:rdma
npm run report:latest
```

生成数据和报告前，请确认当前分支是个人工作分支；不要在共享基线分支上直接
覆盖 baseline 文件。

## Architecture entry points

- [高层架构总纲](docs/design/HIGH_LEVEL_ARCHITECTURE.md)
- [当前设计状态](docs/design/00_CURRENT_STATE.md)
- [芯片设计计划](docs/design/11_PLAN_AND_DELIVERABLES.md)
- [架构决策记录](docs/design/DECISIONS.md)
- [未决问题和阻塞项](docs/design/OPEN_ISSUES.md)
- [设计文档索引](docs/design/README.md)

## Collaboration model

1. 先阅读 `AGENTS.md` 和相关模块的 README。
2. 一个任务尽量只修改一个模块及其测试/文档。
3. 不跨模块修改公共契约；需要修改时先更新接口文档和 ADR。
4. 生成物与源代码分离：源代码在 `src/`，输入/结果在 `data/`，HTML 在
   `reports/`。
5. 提交前运行 `npm test`，并在 PR 中记录测试命令、结果和变更影响。
6. 任何 TPS、带宽、面积或功耗结论都必须注明假设、数据来源和模型版本。

## Current blockers

- 正式 K3 layer manifest、dtype、KV/state layout 尚未完全冻结；
- 320 GB/s/MC 参考规格与 640 GB/s/MC Stretch 结果存在一倍带宽差异；
- Final Tuning 中部分优化仍需要精确 tile/transaction 模型替代经验缩放；
- 卡内 8 Die topology、TP32 scale-out 物理拓扑和 PPA 尚未签核。

仓库中的 `998.81 TPS/usr` 只能作为当前模型结果，不能视为已经实现的产品承诺。
