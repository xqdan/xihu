# Model Manifest Qualification Report

- Date: 2026-09-22
- Status: **BLOCKED**
- Scope: K3, GLM-5.2, DeepSeek-V4-Pro; TP8/TP16/TP32; decode batch=1, context=1M.
- Qualification: **0 / 45 fields verified**.

## Evidence boundary

The repository contains reproducible planning manifests, but they are not vendor/config-verified deployment manifests. They may drive planning comparisons only. They must not be marked **FROZEN**, and they cannot close Q-Gate or support silicon TPS claims.

## Required qualification fields

Each model has the same field-level backlog: `modelVersion`, `layerCount`, `hiddenSize`, `attentionShape`, `dtype`, `expertCount`, `activeExperts`, `routingCapacity`, `kvState`, `indexState`, `mtpBehavior`, `operatorShape`, `flopsPerToken`, `bytesPerToken`, `collectiveBytes`. Every row requires a versioned source, shape reconciliation, ledger update, and reviewer sign-off.

## Model status

| Model | Current status | Primary gap |
|---|---|---|
| K3 | UNVERIFIED_PLANNING_MANIFEST | Vendor/config verification and shape-derived workload not supplied. |
| GLM-5.2 | UNVERIFIED_PLANNING_MANIFEST | Vendor/config verification and shape-derived workload not supplied. |
| DeepSeek-V4-Pro | UNVERIFIED_PLANNING_MANIFEST | Vendor/config verification and shape-derived workload not supplied. |

## Downstream impact

- **Hardware Team:** cannot close AI-core sizing, SRAM/MC bandwidth, NoC traffic, or PPA with verified demand.
- **Software Team:** cannot validate kernel legality, fusion shapes, collective schedule, or MTP/rollback behavior.
- **Verification:** cannot produce dependency/resource-aware timing evidence for all 18 planning slots.

## Exit criteria

1. Model source/config is versioned and reviewable.
2. All 15 fields per model are populated and reconciled.
3. FLOP/token, bytes/token, and collective-byte ledgers balance against operator shapes.
4. MODEL-04 publishes a golden workload trace; independent VV review is recorded.
5. Contract hash and integration manifest are regenerated.

Machine-readable backlog: [qualification matrix](../inputs/model_manifest_qualification_matrix.json).
