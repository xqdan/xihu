# ADR-0022：每 Die 一个 Comm Core，集合通信控制路径硬件化

- 日期：2026-09-29
- 状态：`PROPOSED`（不改发布点、不改 `k3_mc_baseline.json`）

## 背景

发布点每 token 393 次集合通信，共 451.95 µs，占 raw 的 53%。每次集合通信按 spec τ = 1.15 µs 计，τ 没有物理推导（B-008）。

现有文档里没有单元负责触发集合通信、写 RDMA WQE 和数入站 commit：

- 07 号文档的 mailbox slot 由"软件/调度器"预留；
- 08 号文档的 Die Dispatcher 分配 mailbox；
- 02 号文档的 Vector 把 partial 推给 Collective endpoint；
- 模型只收 NIC 每 peer 4 cycle 的发射，控制路径（producer 完成 → 触发 → WQE → doorbell → 完成通知）无人收费。

Meta MTIA 300 用 Message Engine（RISC-V 展开预编译 collective graph、直写 NIC doorbell、device-triggered collective、预投递 receive）解决同一问题。它的实测开销来自固件路径：CPU-C 派发 2.9 µs，PE 直写 doorbell 约 450 ns。本项目 decode 每次集合通信在 spec τ 下只余 0.172 µs。

`out/detailed/comm_core_budget.json` 把三种控制方案加到每次集合通信上回放详细模型：

| 方案 | 控制路径/次 | 自底向上 TPS | 结论 |
|---|---:|---:|---|
| 固件逐次派发 | 2.936 µs | 459.54 | 不达标 |
| AI Core 直写 doorbell | 0.474 µs | 1098.42 | 勉强达标；LSE merge 超过 spec τ；producer Core 每 token 花 176.85 µs 发 WQE |
| 硬件触发 + WQE 模板 | 0.042 µs | 1104.78 | 用 raw 预算内控制上限（0.670 µs）的 6% |

## 决策

1. **每 Die 增加一个 Comm Core（HW-07 负责）**，放在 NoC spare 位 (3,2)，规格见 `teams/hardware/docs/10_COMM_CORE.md`：管理 RISC-V、模板 SRAM、硬件 Trigger 单元、CC-TX、CC-RX。
2. **每次集合通信的控制路径全部在硬件里。**
   - 触发靠 producer 完成计数比较；
   - WQE 由预编译模板加补丁生成；
   - doorbell 由 Comm Core 直写；
   - 入站 commit/notify 和 group ACK 由硬件计数。
   - 固件只负责装载 graph、推进 epoch 和处理异常。
3. **AI Core 不发 WQE。** Collective endpoint 语义改为写 Shared SRAM 并置完成计数。
4. **Die Dispatcher 不再分配 mailbox。** 它只装载 collective graph 与推进 epoch；mailbox 预留由 CC-RX 按 epoch 预投递。
5. **对外是内存语义，不是消息语义。**
   - 操作集为 PUT、PUT_SIGNAL、GET、ATOMIC_ADD / FETCH_ADD / CAS、WAIT_VALUE、SET_VALUE；
   - 地址是对称布局的全局地址，经 Comm Core 的翻译表做 protection key 与 generation 检查；
   - 集合通信的 commit 用 PUT_SIGNAL：信号在数据包尾部，收齐后对远端计数原子加，带 release 语义。它就是协议模型发布时的假设。
     两种替代做法的 TPS 相同，但余量更小，所以不选：
     - 单独发信号 WQE：WQE 翻倍，wire bytes 多 16%；
     - 写被确认后再发信号：最慢一类只剩 0.026 µs 的 spec τ 余量。
   - AI Core 只开放 posted store / atomic 与 FENCE，不开放远端 load：一次至少 0.124 µs，Core 只能空等。
   - GET 只用于预取和调试，集合通信一律推送。
6. **不改发布点。**
   - Comm Core 路径下最慢一类集合通信为 1.02 µs，低于 spec τ，所以发布点 1101.77 TPS/usr 不变；
   - 控制路径 cycle 数在回标前是 ASSUMPTION（O-018）。

## 后果

- 07/08/05/02 号硬件文档与系统架构 01 号文档改为引用 Comm Core；agent 组织新增 HW-07 Comm-Core。
- 硬件合同 `teams/hardware/contract.json` 的 ownerAgents 与 `generate_team_contracts.js` 的 requiredAgents 暂不加入 HW-07；本 ADR 转为 `BASELINE` 时再改，并重新生成合同。
- τ 的物理推导（B-008）多了控制路径一项；O-018 回标后，若最慢一类加控制路径超过 1.15 µs，须按 ADR-0005 流程修改 `OPT.tauUs`。
- 面积/功耗尚未进入 `physical()`：模板 SRAM 约 0.029 mm²，RISC-V 与状态机未估。
- 回归测试 `tests/regression/test_comm_core_budget.js` 绑定预算产物与 10 号文档，包括第 6.4 节的信号方式对比。
- 选用的 NIC 必须支持"收齐后原子加"，或者数据与 flag 同包；否则按"写被确认后再发信号"计，spec τ 余量只剩 0.026 µs。
- 内存序（10 号文档第 6.3 节）进入形式验证范围，与 SW-05 共签。
