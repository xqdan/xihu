# ADR-0007: GLM-5.2 planning workload derived from the public config

Date: 2026-09-25
Status: accepted for repository modeling governance; supersedes ADR-0006 decision 5.
Decision 5 (calibration) and the TPS table under Consequences are superseded
by ADR-0008; the current GLM-5.2 values at TP32/MC640 are 2420.0 (P0) and
2416.8 (P1).

## Context

ADR-0006 set GLM-5.2 to `BLOCKED_CONFIG` because the repository had no shape
source. The config has been public since 2026-09-01:

- `https://huggingface.co/zai-org/GLM-5.2/raw/main/config.json`
- the FP8 checkpoint `zai-org/GLM-5.2-FP8` (`quantization_config`)
- the reference implementation, transformers
  `models/glm_moe_dsa/modeling_glm_moe_dsa.py`

The config gives these fields:

| Field | Value |
|---|---|
| Layers | 78 (3 dense + 75 MoE) |
| Hidden size | 6144 |
| Dense FFN | 12288 |
| Experts | 256 routed + 1 shared, top-8, expert hidden 2048 |
| MLA | 64 heads, q_lora 2048, kv_lora 512, rope 64, qk_nope 192, v_head 256 |
| Indexer | 32 heads × 128, top-k 2048 |
| Vocabulary | 154880, untied |
| MTP | 1 layer |

`indexer_types` marks 21 layers `full` (layers 0, 1, 2, then every 4th layer
from 6 to 74) and 57 layers `shared`.

In the reference implementation:

- A `shared` layer has `indexer = None`. It reuses the previous full layer's
  top-k (`prev_topk_indices`), so it has no indexer weights and no index-key
  cache.
- `index_skip_topk_offset` is not read.

## Decision

1. **Manifest.** `formal_model_manifests.json#/models/1/shape` holds the config
   fields under `config` and the deployment layout under `assumptions`, each
   with a `basis`.
   - The status is `UNVERIFIED_PLANNING_MANIFEST`.
   - `model_profiles.json` layerCount is 78 (previously the assumption 96).

2. **Derivation.** `deriveGlm()` in
   `integration/pipelines/generate_planning_operator_workload.js`; provenance status
   `SHAPE_DERIVED_FROM_CONFIG`.

   | Row | Content |
   |---|---|
   | dense_projection | 78 × MLA + 21 × indexer + 3 × dense FFN + 75 × shared expert in FP8 (1 B); 75 × router + LM head in BF16 (2 B). The embedding is a lookup. |
   | routed_moe | 75 × 8 × 3 × 6144 × 2048 in FP8 |
   | indexer | 21 full layers × context × 32 × 128 × 2 FLOP; 21 × context × 132 B |
   | sparse_attention | 78 layers × top-k 2048 × 656 B; absorbed MLA FLOPs |
   | collective_reduce | 21 × 4 + 57 × 3 = 255 per token |

3. **Check.**
   - Parameters including the MTP layer total 753.33B. The published total is
     753B (ratio 1.0004).
   - Active parameters are 41.25B, or 40.30B without the embedding.
   - `tests/regression/test_k3_manifest_consistency.js` requires the ratio to be within
     0.5%.

4. **ASSUMPTION fields.** These are marked ASSUMPTION:
   - FP8 FlashMLA KV at 656 B (the HF reference caches BF16);
   - index keys at 132 B;
   - TP mapping without expert parallelism (since 2026-09-25 a deployment
     decision, not an ASSUMPTION: FFN/MoE is TP-only for all three models, with
     no all-to-all; see ADR-0020);
   - collectives per layer: 4 on full layers and 3 on shared layers, because
     shared layers have no top-k merge;
   - FP8 block scales ignored;
   - MTP excluded from TPS/usr.

5. **Calibration.** The K3 calibration (kMemory 1.1553, kCompute 1.4139) is
   applied unchanged. As for DeepSeek-V4-Pro, this is a planning ASSUMPTION.

## Consequences

- GLM-5.2 per-token traffic is 41.4 GB of weights, 2.9 GB of index keys and
  0.10 GB of KV.
- The workload is memory-bound on `routed_moe` at every slot except
  TP32/MC640, where the collective lane (255 × 1.15 µs = 293.3 µs) binds.

  | TP | MC320 | MC640 |
  |---:|---:|---:|
  | 8 | 478.0 | 956.0 |
  | 16 | 956.0 | 1911.9 |
  | 32 | 1911.9 | 2603.2 (P0) / 2598.6 (P1) |

- No model is `BLOCKED_CONFIG` any more. Under the existing validator rules the
  D-Gate therefore evaluates to `PASS` (scope
  `PLANNING_COMPARISON_ONLY_NOT_ARCHITECTURE_FREEZE`), with three formal
  candidates in the register:
  - `P0-7R-balanced-MC640-TP32`
  - `P1-compact-MC640-TP32`
  - `P0-7R-balanced-MC320-TP32`
- Stage B runs as `PLANNING_QUANTIFICATION`. The ADR-0006 exploratory sweep is
  inactive.
- The Q-Gate stays blocked: there is no event-timed replay.
- Performance acceptance is still `PERFORMANCE_MISS_REQUIRES_DIRECTION_BACKFLOW`,
  with coverage `COMPLETE`:
  - K3 misses the target at every slot except TP32/MC640.
  - GLM-5.2 and DeepSeek-V4-Pro miss it at TP8 (both MC profiles) and at
    TP16/MC320.
- The `BLOCKED_CONFIG` mechanism of ADR-0006 stays in the code for any future
  model without a config.
