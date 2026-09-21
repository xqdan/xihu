# Data

This directory contains reproducible baseline inputs and generated JSON/CSV outputs. Update a baseline only with the corresponding script, test result and PR explanation.


- workload/model_profiles.json：K3、GLM-5.2、DeepSeek-V4-Pro 的统一workload profile。公开模型资料字段必须标为MODEL，正式配置确认后才能升级为FROZEN。

- `workload/multi_model_tp_matrix.json`：三模型 TP8/TP16/TP32 的9个Decode测试用例和拓扑守恒规则。
