# Q3 Tile / Memory Event Specification

## Decision question
每个 operator 如何切成 tile，并在 Local/Shared SRAM、TMA、MC 和 buffer 生命周期上执行？

## Inputs

- Q1 operator DAG；
- Q2 bytes ledger；
- SRAM/TMA/MC profile；
- package/NUMA mapping。

## Outputs

- Tile IR 到 memory event 的映射；
- SRAM/TMA/MC transaction trace；
- bank conflict、queue wait、occupancy、backpressure；
- issued/served bytes 和 buffer lifetime。

## Constraints

- per-core、per-die、per-package 容量分开；
- 显式表示 bank、port、queue、ECC、scrub 和 poison；
- 每个 event 绑定 `operator_id`、`tile_id`、`manifest_hash`；
- 禁止用总 TB/s 替代 bank-level service。

## Exit criteria

bytes、transaction、buffer state 和 completion 守恒，normal/backpressure/error/reset trace 均可回放。
