# Q4 NoC / Collective Event Specification

## Decision question
TP/CP/EP 和 package-local/cross-package 通信如何变成可回放的 packet、flit、VC、credit 和 collective 事件？

## Inputs

- Q1 DAG；
- Q2 collective bytes；
- D4 topology envelope；
- D5 package topology；
- Q3 memory events。

## Outputs

- packet/flit trace；
- route、hop、VC、credit、queue/congestion；
- all-reduce、all-gather、reduce-scatter、all-to-all、dispatch/combine、LSE latency；
- P50/P95/P99 communication result。

## Constraints

- 不得只用 `log2(TP)` 替代真实 topology；
- package-local 与 cross-package 分开；
- expert dispatch/combine 和 LSE `m/l/O` 显式出现；
- deadlock、credit underflow、timeout、replay、stale epoch 必须可验证。

## Exit criteria

packet bytes、hop、credit、ACK 和 collective completion 守恒，并能被 Q6/Q8 消费。
