# ADR-0002: Formal planning manifest and sensitivity closure

- 日期：2026-09-22
- 状态：Accepted for architecture planning
- 范围：K3、GLM-5.2、DeepSeek-V4-Pro；P0/P1；MC320/MC640；TP8/TP16/TP32

## 背景

D-Gate 被两个问题阻塞：三模型没有共同的可消费 manifest，以及 D2-D6 sensitivity sweep 没有机器可读结果。继续用 `BLOCKED_CONFIG` 会阻止候选排序和正式 Stage B 绑定。

## 决策

1. 建立 `teams/model/inputs/formal_model_manifests.json`，显式记录层数、dtype、MoE、KV/index state、MTP 和 operator inventory。
2. 该 manifest 是**架构规划冻结**，不是模型厂商配置或 silicon sign-off；GLM-5.2 和 DeepSeek-V4-Pro 的外部确认仍保留为 qualification risk。
3. 运行 `integration/pipelines/stage_a.js` 生成 manifest hash、敏感性扫描、候选登记和 D-Gate 输入。
4. 保留 P0/P1、MC320/MC640 和 TP8/TP16/TP32 的独立维度，不把 stretch profile 当成 baseline。
5. D-Gate 通过后，Stage B 才能切换到 `FORMAL_QUANTIFICATION`；Q-Gate 仍需 Q3-Q8 event replay、fine TPS 和 provenance closure。

## 验收证据

- `out/governance/formal_manifest_binding.json`
- `out/direction/sensitivity_sweep.json`
- `archive/reports/stage_a_blocker_resolution_20260922.md`
- `out/governance/candidate_register.json`
