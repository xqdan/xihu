# Q8 Fine TPS Integration Specification

## Decision question
将 Q1-Q7 的证据合并后，三模型、TP8/16/32、MC320/640 的细粒度 TPS/usr 是多少？

## Inputs

- manifest/operator DAG；
- Roofline、tile、packet、kernel、schedule、PPA/RAS traces；
- TPS observation matrix。

## Outputs

- 18-slot fine TPS matrix；
- critical path、latency breakdown、P50/P95/P99；
- Stage A vs Stage B delta attribution；
- model/TP/MC/profile bottleneck。

## Constraints

- 不得静默覆盖 Stage A；
- 每个 slot 必须有 observed result 或 terminal blocker；
- `TPS = 1e6 / e2e_latency_us_per_token`；
- MC640 结果不能标成 MC320 或可制造默认结论。

## Exit criteria

所有结果可回溯到同一 manifest hash、event trace、source commit 和 deterministic replay。
