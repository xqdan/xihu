# Q7 PPA / Thermal / RAS Specification

## Decision question
详细事件路径是否满足面积、功耗、热、供电、可靠性和降级运行约束？

## Inputs

- D5 package envelope；
- D2/D3 resource sizing；
- Q3 memory activity；
- Q4 traffic activity；
- Q5 core activity；
- Q6 schedule。

## Outputs

- area/power/thermal budget；
- average/P95/peak activity；
- DVFS/throttle 曲线；
- Die/MC/link failure 和 degraded-mode TPS；
- PPA blocker 或 direction feedback packet。

## Constraints

- Die 功耗与卡功耗上限分开核算；
- peak、average、P95 power 分开；
- 规划数字不得冒充 physical measurement；
- 超预算必须进入 `PPA_DIRECTION_BACKFLOW`。

## Exit criteria

PPA、thermal、RAS 结果与 event trace 的 activity、profile、run_id 一致。
