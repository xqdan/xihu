# 单 Die NoC 子系统设计

## 1. 当前抽象基线

当前搜索模型对单 Die 使用：

- 8 个 Core endpoint；
- 8 个 Shared SRAM slice endpoint；
- 约 3 个 I/O/collective gateway endpoint；
- 共 19 个活动 endpoint；
- 抽象为 5×5 2D mesh；
- 单数据面、每方向 512 B/cycle；
- 1.2 GHz；
- 分析利用率 65%；
- 估算有效截面约 3.99 TB/s/Die。

512 B/cycle 等于 4096 bit/cycle，属于非常宽的物理链路。该参数目前只通过
带宽模型，没有完成 floorplan、线长、repeater、功耗或 timing 证明。

## 2. 推荐逻辑拓扑

保留 5×5 mesh 作为第一版拓扑候选：

```text
5 × 5 routers
  8  Core endpoints
  8  Shared SRAM slice endpoints
  2  MC gateways
  1  Die-fabric/scale-out/collective gateway group
  6  spare/bridge/router-only positions
```

实际 floorplan 可把 router-only 位置用于跨区域中继、时钟边界和故障绕行。
是否需要两个数据平面，应由物理布线和死锁证明决定，而不是沿用旧文档。

## 3. 网络分层

建议至少分成：

1. **Data NoC**：weight、activation、KV、partial、writeback；
2. **Control NoC**：descriptor、completion、barrier、fault、PMU；
3. **Collective fast path**：小向量 reduce/multicast，可为旁路树或专用端口。

当前性能模型只显式建模 Data NoC 和 reduce 资源，Control NoC 尚未进入时延
模型。初始候选为 256-bit control flit，但在流量分析前保持 `OPEN`。

## 4. 数据面参数候选

| 项目 | 当前候选 | 状态 |
| --- | ---: | --- |
| Topology | 5×5 2D mesh | `MODEL` |
| Link width | 4096 bit/方向 | `MODEL` |
| Frequency | 1.2 GHz | `MODEL` |
| Flit | 512 B 或拆成多个 128 B phit | `OPEN` |
| Routing | XY escape + minimal adaptive | `BASELINE` |
| Flow control | Credit based | `BASELINE` |
| Data VC | 至少 request/response/writeback/collective 四类 | `OPEN` |
| QoS | Decode latency、Prefill bulk、maintenance | `BASELINE` |

若 4096-bit 不能收敛，优先比较：

- 2×2048-bit 双平面；
- 4×1024-bit 多平面；
- 2048-bit 主 mesh + collective/reduce 旁路；
- 降宽并提高局部 multicast/数据复用。

不能直接降宽而继续沿用 3.99 TB/s 的模型结果。

## 5. 包和事务

数据包至少包含：

- destination/source endpoint；
- traffic class/VC；
- operation：read、write、atomic-reduce、multicast、ACK；
- address/tile ID；
- byte mask、dtype/accumulation mode；
- epoch/generation；
- poison/ECC status；
- ordering tag；
- payload。

大 TMA tile 使用长包或 wormhole stream；小 completion/flag 走 Control NoC，
避免被 weight stream 阻塞。

## 6. 死锁与顺序

- 请求、响应、writeback、collective 必须有无环依赖；
- 提供 deterministic escape VC；
- mailbox commit 不能等待被同一 VC 阻塞的 ACK；
- TMA 写 Shared SRAM 后，ready flag 只能在数据可见后发出；
- fault/poison 包不得被普通流量永久饿死。

## 7. 验证流量

至少覆盖：

- 8 个 Core 同时 refill；
- Attention KV multicast；
- TMA fill 与 Tensor writeback 同 bank；
- 8 Die collective gateway 注入；
- MC0/MC1 不均衡；
- Decode 小消息与 Prefill 大包并发；
- 单链路/单 router 故障绕行；
- P99 credit stall；
- 热点 Shared slice。

## 8. 冻结交付物

- 物理 endpoint 到 router 的映射；
- link/phit/flit/VC 明细；
- routing 和死锁证明；
- router buffer 深度；
- QoS/仲裁和 backpressure；
- cycle/packet-level NoC 模型；
- post-synthesis/router PPA；
- floorplan 线长和拥塞报告；
- 与 tile 仿真的流量接口。
