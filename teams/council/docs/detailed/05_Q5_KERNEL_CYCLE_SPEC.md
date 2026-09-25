# Q5 Kernel Cycle / AI Core Specification

## Decision question
tile 在 L/H/Vector/Indexer/Reduce 上的真实 issue、pipeline、occupancy、stall 和 cycle 是多少？

## Inputs

- Q1 shapes/dtype/layout；
- Q2 Roofline；
- Q3 SRAM/TMA timing；
- Q4 communication stall；
- D3 core profile。

## Outputs

- kernel cycle trace；
- issue、utilization、stall 分类；
- dequant、accumulation、padding、reduction 代价；
- effective peak 和 per-core service time。

## Constraints

- 数学 peak、effective peak、measured/calibrated peak 分开；
- FP8/FP4 dequant 和 accumulation 不得隐藏；
- sparse/padded FLOP 分账；
- utilization 必须能从 trace 重建。

## Exit criteria

每个 kernel cycle 都能映射到 tile、SRAM、TMA、NoC、MC 或 collective 事件。
