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

- `out/contracts/model_workload_contract.json`：模型 shape/dtype/routing 与 FLOP/byte/通信需求；
- `out/contracts/hardware_resource_contract.json`：唯一硬件规格（P1）、AI Core、SRAM/TMA、MC、NoC、PPA 资源；
- `out/contracts/software_execution_contract.json`：kernel、fusion、runtime、collective overlap 和 schedule；
- `out/contracts/integration_manifest.json`：三团队输入 hash 和状态；
- `out/verification/timing_evidence_status.json`：planning / synthetic / validated / silicon 证据状态。

## Qualification and regeneration (ARCH-02 / VV-02)

`teams/model/inputs/model_manifest_qualification_matrix.json` is the field-level
qualification backlog. The model contract publishes its path as
`qualificationMatrix`, and copies `status`, `verifiedFieldCount`, and
`requiredFieldCount` into `qualificationStatus`, `verifiedFieldCount`, and
`requiredFieldCount`. These describe evidence completeness only; they do not
promote planning data or close Q-Gate.

After writing all three team contracts, the generator computes SHA-256 over
their exact file bytes. `integration_manifest.contractHashes` must cover exactly
the three declared `inputs`. `generatedAt` uses the qualification snapshot's
`asOf` date so rebuilding the same snapshot remains reproducible.

Run these commands from the repository root in order:

```sh
node integration/pipelines/generate_team_contracts.js
npm run dashboard
npm test
npm run check:structure
```

The dashboard and direction feedback bind the same source hashes, including the
qualification matrix. V&V checks contract completeness, hash coverage, snapshot
freshness, and generator reproducibility in a temporary directory.

## Gate rule

只有 `VALIDATED_EVENT_TIMING` 且通过 VV-02/VV-03 独立检查，才允许 Q-Gate 进入 PASS。`UNVERIFIED_PLANNING_MANIFEST`、`CALIBRATED_PLANNING_TOKEN_TIME`（ADR-0006 的规划 token 时间，取代原 `SYNTHETIC_BOTTLENECK_BOUND`）只能用于架构规划和 backflow；`BLOCKED_CONFIG` 的模型不出 TPS。
