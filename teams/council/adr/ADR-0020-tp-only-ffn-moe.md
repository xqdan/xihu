# ADR-0020：三个模型的 FFN/MoE 均按 TP 部署，不用 EP

- 旧编号：ADR-015（原 `docs/design/DECISIONS.md`，2026-09-25 迁入独立文件；正文只把 ADR 引用改为新编号）
- 日期：2026-09-25
- 决策：
  1. K3、GLM-5.2、DeepSeek-V4-Pro 的 FFN/MoE（dense FFN、shared expert、routed expert）全部 TP-only：每个 expert 按 TP rank 切分，没有 expert parallelism，没有 all-to-all dispatch/combine；
  2. 每层 FFN/MoE 输出只做一次 TP all-reduce，已计入每层集合通信次数；规划工作负载不含 dispatch 行；
  3. GLM-5.2 / DeepSeek-V4-Pro manifest 的 `parallelism` 字段由 `ASSUMPTION` 改为 `DEPLOYMENT_DECISION`；`multi_model_tp_matrix.json` 九个用例的 `expertWeights` 均为 `tensor_parallel`、`expertDispatch = false`，由 `tests/regression/test_multi_model_tp_matrix.js` 检查；
  4. 文档 13 中 EP、token dispatch/combine、expert home、expert all-to-all 的要求改写为 TP-only 或标为不适用。
- 影响：TPS/usr 数值不变（规划模型原本就是 TP-only）。
- 状态：`DEPLOYMENT_DECISION`
