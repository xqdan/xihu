# Cross-Team Contract Pack

版本：2026-09-22
状态：`CONTRACT_SKELETON / NOT_VALIDATED`

本目录是 Hardware、Software、Model 三团队的集成接口。它定义 schema 和验收边界，不把未知模型配置或合成 trace 标记为已验证。

## Contract lifecycle

```text
DRAFT -> TEAM_REVIEW -> INTEGRATION_REVIEW -> VV_CHECK -> PUBLISHED
                                      \-> BLOCKED / BACKFLOW
```

## Required contract artifacts

- `data/contracts/model_workload_contract.json`：模型 shape/dtype/routing 与 FLOP/byte/通信需求；
- `data/contracts/hardware_resource_contract.json`：P0/P1、AI Core、SRAM/TMA、MC、NoC、PPA 资源；
- `data/contracts/software_execution_contract.json`：kernel、fusion、runtime、collective overlap 和 schedule；
- `data/contracts/integration_manifest.json`：三团队输入 hash 和状态；
- `data/verification/timing_evidence_status.json`：planning / synthetic / validated / silicon 证据状态。

## Gate rule

只有 `VALIDATED_EVENT_TIMING` 且通过 VV-02/VV-03 独立检查，才允许 Q-Gate 进入 PASS。`UNVERIFIED_PLANNING_MANIFEST` 和 `SYNTHETIC_BOTTLENECK_BOUND` 只能用于架构规划和 backflow。
