# ADR-0023：回收共享 SRAM 的 local 写端口放大（`localWriteRatio` 1.70 → 1）

- 日期：2026-10-02
- 状态：`PROPOSED`（模型、基线和文档已按本提议更新；`MODEL` 等级，待 Hardware owner 用综合或 bank 争用数据复核）
- 变更控制：按 ADR-0005 第 5 条，已重跑 `npm run search:final`、`npm run baseline:sync`、`npm run model:planning` 和四个设计搜索

## 背景

ADR-0005 记录过共享 SRAM 端口放大每 Die 占 16.15 mm²、5.69 W，每卡 45.51 W，只换来 0.06 TPS，并写明"可以由后续决策回收"。

HW-02 的 matrix:vector 搜索把封装窗口（8 个 Die + 16 个 memory cube ≤ 5248 × (1 − 0.1254)）和端口放大都算进候选面积以后，结果是：

- 发布点 373.71 mm² 只给封装留下 0.189 mm²；
- 52 个候选一个可行的都没有。三个模型的 H Core kernel 都要掩盖，至少需要每 Core 690.9 lane（取网格上的 704），而 704 lane 的方案每 Die 比发布点多 6.03 mm²，封装缺口 48.08 mm²；
- 0.1254 是发布点的观测 keep-out，不是核实过的下限，不能靠放宽它来取得可行解。

## 决策

1. `OPT.localWriteRatio` 从 1.70 改为 1。其余三项（`tmaDedicatedPort` ×1.55、`sharedReadScale` 1.18、`sharedReadPerWrite` 0.18）不动。
2. 其余设计点不变：计算阵列（`hRows`、`hEngines` 等）、lane 数、TMA 专用端口都保持发布值。

## 为什么选这一项

模型内扫描（发布点其余不变，704 / vectorUnpack / sfu，K3 TPS/usr 都是 1101.77）：

| 端口方案 | 端口面积 mm²/Die | 封装余量 mm² | 可行候选数 |
| --- | ---: | ---: | ---: |
| 现状 | 16.15 | −48.1 | 0 |
| 去掉 TMA 专用端口 | 8.93 | +9.6 | 1 |
| **`localWriteRatio` = 1** | 7.78 | **+18.9** | 3 |
| 两项都去掉 | 3.53 | +52.9 | 11 |
| 全部端口放大都撤掉 | 0 | +81.1 | 16 |

- 去掉 `localWriteRatio` 单项就能出可行解，且保留 TMA 专用端口，改动面最小；
- 砍 H 核算力（`hRows` 48 → 44）也能得到可行解（余量 +17.3 mm²，TPS 1101.5），但它改变计算配置，影响面更大，作为后备，不在本 ADR 内。

## 后果

- 发布点：Die 365.34 mm²（原 373.71）、283.27 W（原 286.22）、卡 2744.88 W（原 2768.47）、裸片 4522.73 mm²（原 4589.71）；K3 TPS/usr 不变，仍为 1101.77。
- 端口放大现在每 Die 7.78 mm²、2.74 W，每卡 21.92 W；封装在观测 keep-out 下还剩 67.17 mm²（原 0.189 mm²）。
- HW-02 搜索得到 704 / vectorUnpack / sfu：Die 371.37 mm²，封装余量 18.91 mm²（每 Die 2.36 mm²，很薄）。`localWriteRatio` 回到 1.70 时同一搜索 0 个可行。
- 两个域的卡功耗口径差值从 45.5141376 W 变为 21.915648 W（memory 域不计共享端口项，physical 域计它）。
- 21 号文档、02/03/04/09 号硬件文档、`k3_mc_baseline.json`、`out/` 下的产物和相关回归测试已同步。

## 未验证的部分

- `localWriteRatio` 在模型里几乎不影响 TPS，是因为 `localPortModel` 把 bank 分区和争用缓解写成了前提（`bankPartition: true, contentionMitigation: true`），不是仿真出来的。撤掉写带宽放大后会不会出现真实的 bank 争用，需要硬件团队用综合或 bank 级仿真确认。如果确认不成立，要么恢复 1.70、同时接受封装缺口，要么改走 `hRows` 路线。
- 余量 18.91 mm² 对 keep-out（0.1254）和 cube 面积（100 mm²）都很敏感：keep-out 每增加 0.01，窗口少 52.5 mm²；cube 每多 1 mm²，少 16 mm²。
