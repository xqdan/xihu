# K3 / GLM-5.2 / DeepSeek-V4-Pro Architecture Repository

K3、GLM-5.2、DeepSeek-V4-Pro 多模型推理芯片架构设计、性能建模、设计空间搜索和验证的协同开发仓库。

本仓库是一个适合 GitHub 协作的初始版本，目标是让架构师、模型工程师、
RTL/IP 团队和多个 agent 可以在清晰的模块边界内并发工作。

> 当前项目目标是统一支持 K3、GLM-5.2、DeepSeek-V4-Pro 的 Decode inference：B=1、Context=1M、TP32、PP=1，目标
> `1000 TPS/usr`。`1050 TPS/usr` 是架构冻结门槛。当前数据和 PPA 仍包含工程
> 假设；特别是 MC 带宽路线和精确 tile 模型尚未完成最终签核。

## Repository layout

仓库按“团队 → 集成 → 生成物”组织：团队目录只放本团队拥有的输入、代码和文档；组合多个团队的代码放 `integration/`；所有脚本生成物写入 `out/`。

```text
teams/                       团队拥有的输入、代码、文档和对外 contract
├── model/                   manifest、profile；K3 唯一形状来源 src/design_engine.js；workload 推导；模型部署方案（docs/deployment/）
├── hardware/                7R 封装与 P1 基线规格（inputs/）、resource profiles（src/）、硬件单元设计文档（docs/）
├── software/                编译器 / runtime / 固件设计，kernel、fusion、collective 策略文档
├── council/                 Architecture Council：ADR（adr/）、运行模型文档、agent roster
└── vv/                      独立验证职责说明（测试在 tests/）

integration/                 跨团队代码（Council 拥有）
├── detailed/                93 层算子 / SRAM 模拟器、架构与 B=1 搜索、RDMA 与 Final Tuning 模型
├── planning/                规划 token 时间、Stage A 资源 envelope
├── governance/              D-Gate / Q-Gate 计算
├── pipelines/               所有生成入口（Stage A/B、contracts、看板、报告、搜索）
└── templates/               HTML 报告模板

out/                         生成物（JSON / HTML / 运行报告），不手工编辑
docs/                        系统级架构文档（architecture/，含跨团队 contracts/）与项目概览（overview/）
tests/                       unit / regression / governance / structure 四组测试
archive/                     只读历史：RDMA 变体、SRAM HTML 模型、旧运行报告
references/                  外部资料来源说明；供应商原始文件不默认入库
.github/                     CI、PR 模板和协作配置

AGENTS.md                    团队所有权、目录规则和多 agent 协作协议
CONTRIBUTING.md              分支、提交、评审和验证要求
```

依赖规则：`teams/<team>/` 不 require 其他团队、`integration/` 或 `out/`；由 `npm run check:structure` 强制。

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
npm run workload:planning
npm run model:planning
npm run report:architecture
npm run report:rdma
npm run report:latest
```

`model:planning` 依次生成 K3 形状推导的规划 workload、Stage A 方向比较（D-Gate 由独立校验器计算）、Stage B 规划量化、三团队 contract、方向反馈和全局看板。各入口说明见 [`integration/pipelines/README.md`](integration/pipelines/README.md)。

生成数据和报告前，请确认当前分支是个人工作分支；不要在共享基线分支上直接
覆盖 baseline 文件。

## Architecture entry points

- [高层架构总纲](docs/architecture/HIGH_LEVEL_ARCHITECTURE.md)
- [当前设计状态](docs/architecture/00_CURRENT_STATE.md)
- [芯片设计计划](docs/architecture/11_PLAN_AND_DELIVERABLES.md)
- [架构决策记录](teams/council/adr/README.md)
- [未决问题和阻塞项](docs/architecture/OPEN_ISSUES.md)
- [设计文档索引](docs/architecture/README.md)
- [多模型架构调整](docs/architecture/13_MULTI_MODEL_ARCHITECTURE.md)
- [多模型Workload Profile](teams/model/inputs/model_profiles.json)
- [TPS观测指标矩阵](out/workload/tps_observation_matrix.json)

## Collaboration model

1. 先阅读 `AGENTS.md` 和相关团队目录的 README。
2. 一个任务尽量只修改一个团队目录（或 `integration/` 的一个子目录）及其测试/文档。
3. 不跨模块修改公共契约；需要修改时先更新接口文档和 ADR。
4. 生成物与源代码分离：输入和代码在 `teams/` 与 `integration/`，生成的 JSON/HTML 在 `out/`，由 `integration/pipelines/` 中的脚本重算。
5. 提交前运行 `npm test`，并在 PR 中记录测试命令、结果和变更影响。
6. 任何 TPS、带宽、面积或功耗结论都必须注明假设、数据来源和模型版本。

## Current blockers

- K3 的形状唯一来源是 `teams/model/src/design_engine.js#MODEL_PRESETS.kimiK3`（工程 preset，未经模型提供方签核）；正式 manifest、profile 和规划 workload 由 `tests/regression/test_k3_manifest_consistency.js` 强制与其一致；
- GLM-5.2 的正式部署配置、dtype、expert/index cache参数尚未冻结；
- DeepSeek-V4-Pro 的授权配置、权重格式、专家路由和部署参数尚未冻结；
- 三模型的 index cache、expert dispatch、MTP 和 FP8/FP4 路径尚未进入事件级回放。

- MC 带宽档位未选定：320 GB/s/MC 参考、480 默认搜索上限、560/640 激进（ADR-0019）；P1 最佳搜索点使用 640 GB/s；
- Final Tuning 中的优化仍是命名的经验缩放因子（模型文件 `GAIN` 表），需要精确 tile/transaction 模型替代；
- 卡内 8 Die topology、TP32 scale-out 物理拓扑和 PPA 尚未签核。

仓库中的 P1 Final Tuning TPS 数字（`teams/hardware/inputs/k3_mc_baseline.json#modelResults`）只能作为当前模型结果，不能视为已经实现的产品承诺。
