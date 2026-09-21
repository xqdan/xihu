# 多 Die 扩展与 Scale-out 子系统设计

## 1. 层级

```text
Core -> Die -> Card(8 Dies) -> TP Group(32 Cards)
```

目标是让软件看到 32 个 card rank，而不是 256 个独立 Die rank。卡内 8 Die
先完成局部归约和数据重排，再由 card rank 参加跨卡 collective。

## 2. 当前卡内拓扑冲突

现有资料出现三种描述：

- 4×2 Compute Die mesh；
- 8 Die 双向 ring，二分面只有两条链路；
- 4+4 hierarchical direct reduce。

当前性能代码在带宽上使用“双向 ring 二分面”近似，Final Tuning 又使用
“4+4 hierarchy”的时延缩放，封装文档画的是 4×2 mesh。三者必须统一。

## 3. 推荐基线候选

建议物理上采用 **4×2 mesh + 两个四 Die reduce domain**：

```text
D0 -- D1 -- D2 -- D3
 |     |     |     |
D4 -- D5 -- D6 -- D7

Domain A: D0..D3
Domain B: D4..D7
```

- 普通远端访问按 4×2 mesh 路由；
- collective 先在各四 Die domain 内 reduce；
- 两个 domain 通过至少两条竖向链路交换；
- 结果在 domain 内广播；
- 每 Die 的两颗 MC 保持本地 home；
- 不设置单点 hub。

这能解释“4×2 mesh”和“4+4 hierarchy”，但仍需以 packet-level 模型验证。

## 4. Die 间链路候选

当前搜索参数：

- 128 lanes；
- 64 Gbps/lane；
- 80% 有效系数；
- 单端口约 819.2 GB/s payload；
- 模型二分面约 1.638 TB/s。

该规格远高于本地参考 MC 的 UCIe 1.1 链路，且 lane 组合、PHY 面积和 bump
均未确认。需要区分：

- MC UCIe：面向 320 GB/s/MC；
- Die-to-Die UCIe：面向 mesh/collective；
- Scale-out PHY：板间/机柜内，不应直接用封装内 UCIe 数字替代。

## 5. Scale-out 当前模型

TP32 当前模型：

- 每卡一个 rank；
- 每卡 payload 上限 800 GB/s；
- 每 Die 16 条 112 Gbps RDMA lane；
- 单 Die 模型有效 168 GB/s；
- 8 Die 聚合后由 800 GB/s 卡级上限截断；
- one-sided write 到远端 SRAM；
- 32 rank balanced all-to-all phase；
- 通过 phase fusion 后每 token 510 phases、14352 requests。

这些是协议/性能模型参数，尚未定义可实现的物理拓扑。

## 6. 必须决定的跨卡拓扑

候选方案：

1. 32 卡直接互联/高 radix backplane；
2. 4×8 或 8×4 torus；
3. 两级低时延交换；
4. 8 卡 pod + pod 间第二层；
5. 电互联卡内/机箱内，光互联跨机箱。

选择时必须同时满足：

- 远端 SRAM write 语义是否可保持；
- 最坏 hop；
- 单次小消息 P99；
- 800 GB/s/card 端口和 SerDes 数；
- 无单点故障；
- 布线、连接器、交换芯片和光模块功耗；
- collective route 的可证明无死锁性。

## 7. 运行与故障语义

- TP group 使用 gang scheduling；
- 每 token/层有 collective epoch；
- 慢卡、重放和温降频会阻塞全组；
- 单 Die 故障先尝试卡内降级，若 shard 不完整则整卡退出 group；
- MC 故障按 page remap 降容；
- 链路故障必须切换 escape path；
- 超时不得静默复用旧 epoch slot。

## 8. 冻结交付物

- 卡内 8 Die 最终拓扑和每条链路规格；
- 跨卡物理拓扑、hop 表和布线；
- link/PHY/connector/optics 清单；
- 路由、拥塞、故障和 QoS 模型；
- 32 卡 collective P50/P95/P99；
- 卡级端口、功耗、岸线和冷却预算；
- bring-up 和链路训练流程。
