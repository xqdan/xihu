# ADR-0025：允许离线 Python 生成器进入 `tools/`，产物以 JSON 入库、由 Node 侧对账

- 日期：2026-10-10
- 状态：`ACCEPTED`（仓库约定变更；用户批准 24 号计划的决策点 D2）
- 变更控制：不改任何基线数字，不改 `npm test` 的运行时依赖

## 背景

仓库约定是 Node.js 18+、零第三方依赖，`npm test` 在干净环境里就能跑完。

24 号计划的 MODEL-CH-01 要给 GLM-5.2、DeepSeek-V4-Pro 建立与 K3 同级的算子账本：在 HF 模型定义上用 `torch.fx` 或 meta device 追踪一个 decoder block，导出算子、shape、dtype、FLOP、字节。这一步只有 Python 生态能做，Node 侧没有等价物。

## 决策

1. 离线 Python 工具可以入库，放在 `tools/` 下。它们是**生成器**，不是运行时依赖：
   - 不进 `npm test`，也不进 `test_regeneration_reproducible.js` 的 `REGENERATE_SCRIPTS`；
   - 依赖（torch、transformers 等）及版本写在脚本头部注释里；仓库不增加任何 Python 安装步骤。
2. 产物是 JSON，按归属入库：模型账本放 `teams/model/inputs/`，外部资料类放 `references/`。每份产物必须带 provenance：
   - 生成工具路径和它的 sha256；
   - 输入来源（HF 仓库名 + revision，或 `config.json` 的 sha256）；
   - Python、torch、transformers 版本；
   - 证据等级。追踪结果是对公开模型定义的机械导出，等级与它所依据的 manifest 相同，不高于 `UNVERIFIED_PLANNING_MANIFEST`。
3. 对账在 Node 侧：测试只读入库的 JSON，与 `design_engine.js` 和规划行逐项比对。没有装 Python 的环境照常跑全部测试。
4. 产物不手改。要更新就重跑工具，provenance 随之变化。

## 后果

- `npm test` 仍然零第三方依赖；README 的"没有第三方依赖"限定为运行和测试路径。
- 入库 JSON 的再生成无法在 CI 里校验，只能校验 provenance 字段齐全、Node 侧对账通过。工具 sha256 与入库记录不一致时，对账测试应报"产物过期"。
- 这条通道只用于"Node 侧没有等价物"的离线导出。能用 Node 实现的生成器仍走 `integration/pipelines/` 和 `out/`。
