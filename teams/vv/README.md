# Verification Ownership

V&V 不属于 Hardware、Software 或 Model 任一实现团队，独立维护：

- schema / units / provenance / hash；
- workload、kernel、packet、schedule 的守恒；
- 单一硬件规格（`singleHardwareSpec`），MC320/MC640 和 TP8/16/32 分离；
- planning estimate、validated model replay、silicon observation 的证据边界；
- D-Gate/Q-Gate 和 dashboard freshness。

V&V 可以阻止 Gate，但不能修改被测团队的输入来制造通过结果。

测试代码在根目录 [`tests/`](../../tests/README.md)（unit / regression / governance / structure 四组）；Gate 由 `integration/governance/evaluate_gates.js` 计算，结果在 `out/governance/gate_status.json`。

证据等级、测试分组与守恒检查、D-Gate / Q-Gate 判定流程和待补验证项见 [`docs/VV_PLAN.md`](docs/VV_PLAN.md)。

V&V 文档（`docs/`）：

| 文档 | 负责范围 |
| --- | --- |
| [`VV_PLAN.md`](docs/VV_PLAN.md) | 证据等级、测试分组与守恒、D-Gate / Q-Gate 判定 |
| [`VV_MEASUREMENT_PLAN.md`](docs/VV_MEASUREMENT_PLAN.md) | 14 类未测量参数：怎么测、测到什么算完、验收线 |
| [`VV_PERFORMANCE_SIGNOFF.md`](docs/VV_PERFORMANCE_SIGNOFF.md) | 性能签核对象、流程、失败处置与冻结含义 |
| [`VV_PRECISION_SIGNOFF.md`](docs/VV_PRECISION_SIGNOFF.md) | 精度分层签核路径与失败时的 TPS 代价 |
| [`VV_BRINGUP_AND_POST_SILICON.md`](docs/VV_BRINGUP_AND_POST_SILICON.md) | S0–S6 bring-up 阶段、回标量清单与失败分类 |
