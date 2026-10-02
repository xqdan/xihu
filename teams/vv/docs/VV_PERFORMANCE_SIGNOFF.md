# 性能签核计划

- 所有者：V&V（判定）；执行：Model + 各团队
- 状态：**计划**——判据已存在（Gate），签核流程尚未按本文执行
- 权威来源：[`VV_PLAN.md`](VV_PLAN.md) §3/§4、`integration/governance/evaluate_gates.js`、
  `docs/architecture/PRODUCT_REQUIREMENTS.md` §3

## 0. 已有判据与缺口

三个判据**已经实现且有测试**，不需要新造：

| 判据 | 位置 | 当前 |
| --- | --- | --- |
| 架构闸门（≥ 1050，可制造 MC 路线，详细 tile 模型） | 21 号文档 §7 | 未通过 |
| D-Gate（8 项方向检查） | `evaluate_gates.js` | 通过 |
| Q-Gate（18 槽位 `MODEL_OBSERVED`/`SILICON_OBSERVED`） | 同上 | 未通过（18/18 `PLANNING_ESTIMATE`） |

缺的不是判据，是**签核流程**：谁在什么时候跑、失败怎么处置、通过后冻结什么。
本文补这一层。

## 1. 签核对象

性能签核的对象**不是**"1101.77 这个数"，而是以下三项：

| # | 对象 | 判据 | 通过后 |
| ---: | --- | --- | --- |
| 1 | 详细模型发布点 | 架构闸门 ≥ 1050，使用可制造 MC 路线 | 发布点成为 `BASELINE` |
| 2 | 联合悲观点 | ≥ 1000（AC-1） | 抗风险结论成立 |
| 3 | 18 槽位可比性 | 全部 `MODEL_OBSERVED` / `SILICON_OBSERVED`（Q-Gate） | 模型间比较可用于决策 |

**为什么必须三项都过**：只有 1 通过 ⇒ 架构可用但余量未知；
只有 1+3 通过 ⇒ 多模型比较可信但 K3 的抗风险能力未知；
只有 2 通过 ⇒ 稳健但没有多模型可比性。

## 2. 流程

```
准备 → 复算 → 判据 → 判定 → 冻结或回退
```

| 阶段 | 动作 | 责任 |
| --- | --- | --- |
| 准备 | `npm run search:final`、`baseline:sync`、`model:planning` 全链重跑 | Model |
| 复算 | `npm test`（unit/regression/governance/structure 四组） | V&V |
| 判据 | `integration/governance/evaluate_gates.js` | V&V |
| 判定 | 读取 `out/governance/gate_status.json` | V&V |
| 冻结/回退 | 见 §4 | Council |

**硬规则**（`VV_PLAN.md` §0 第 4 条）：上游改了但产物没更新 ⇒ `test_integration_freshness.js` 失败；
产物手工改过 ⇒ `inputHash` 不匹配。**不得绕过任何一条。**

## 3. 失败处置

| 失败项 | 含义 | 修复方向 |
| --- | --- | --- |
| 架构闸门 < 1050 | 发布点本身不达标 | 回到搜索空间，或关闭 B-002/B-006 |
| AC-1 < 1000 | 抗风险能力不足 | 三条杠杆（`DESIGN_TARGETS_AND_MARGINS.md` §4），全部需签核 |
| Q-Gate 槽位未满 | 可比性不足 | 逐槽位建 `MODEL_OBSERVED` 点 |
| `threeModelComparable` 失败 | 某模型字段不全 | `BLOCKED_CONFIG`，修模型描述 |
| `areaConservation` 失败 | 面积不守恒 | 修物理单元，见 `DESIGN_EVIDENCE_MATRIX.md` |
| 新鲜度失败 | 产物过期 | 重跑流水线，**不改测试** |

**任何情况下不得修改判据去迁就结果。** 判据的修改是 ADR 级动作，见 §5。

## 4. 冻结的含义

通过后的冻结**不是** `FROZEN`（ADR-0003：模型结论不允许标 `FROZEN`）。
冻结指：

1. 该套输入被记录为**签核版本**（写入 `00_CURRENT_STATE.md`）；
2. 后续任何使发布点变化超过阈值的改动进入变更评审
   （`OPEN_ISSUES.md` "关闭纪律"：>2% TPS、>5% 功耗、>5% 面积）；
3. 下游文档的引用值锁定到该版本，`test_tps_design_baseline.js` 的 95 个文档数字核对照旧生效。

## 5. 判据本身的变更

判据（1050 / 1000 / 18 槽位）的变更必须走 ADR，并同步：
`PRODUCT_REQUIREMENTS.md` §3、`VV_PLAN.md` §3/§4、`evaluate_gates.js`、本文。

**特别规则**：**不得把发布点重新当作判据**（`PRODUCT_REQUIREMENTS.md` §5）。
把 1101.77 写进判据会让芯片在纸面上"已达标"，而联合悲观点是 906.51。

## 6. 未闭合项

| 项 | 状态 |
| --- | --- |
| 架构闸门 | 未通过 |
| AC-1 | 未通过（906.51） |
| Q-Gate | 未通过（18/18 `PLANNING_ESTIMATE`） |
| 本文流程的首次完整执行 | 未做 |
| 签核版本的记录格式 | `OPEN` |
