# Cross-Team Architecture Contracts

此目录只存放 Hardware、Software、Model 三团队共同维护的接口，不存放单一团队内部实现。

## Required contracts

- `workload_resource_contract.json`：模型 operator → FLOP/byte/shape/dtype → 硬件资源；
- `deployment_hardware_contract.json`：runtime/compiler 对 AI Core、SRAM/TMA、MC、NoC 的使用边界；
- `fusion_legality_contract.md`：融合合法性、精度、alias、workspace、fallback；
- `collective_overlap_contract.md`：通信计算 overlap、资源占用和 critical path；
- `test_acceptance_contract.md`：模型场景、软件实现、硬件 profile 和验收指标。

接口变更必须由三团队 review，并由 Architecture Council 记录 ADR；V&V 必须增加回归测试。
