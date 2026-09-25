# Collective 与 RDMA-to-SRAM 子系统设计

> 当前发布点的集合通信口径（reference-393、τ = 1.15 µs 下限）、协议参数和计算通信重叠见
> [`21_TPS_DESIGN_BASELINE.md`](21_TPS_DESIGN_BASELINE.md) 第 2.2、4.2、4.3 节。

## 1. 目标

为 Decode 中大量小型同步点提供低软件开销、可验证的远端 SRAM 语义：

```text
producer partial
 -> one-sided remote write
 -> data visible
 -> commit/ready counter
 -> partial-ready consumer/reduce
 -> group ACK
 -> release
 -> epoch reuse
```

RDMA write 完成不等于 consumer ready；数据、commit、ACK 和 slot generation
都必须在硬件状态机中显式表达。

## 2. 支持的 collective

- BF16/FP32 reduce-scatter；
- BF16 all-gather；
- all-reduce；
- small-vector all-gather；
- multicast/broadcast；
- LSE m/l/O merge；
- distributed sampling candidate gather；
- card-local hierarchical reduce。

LSE 不是普通 sum。每个 rank 提供 `(m, l, O)`，合并需要 max、exp、加权和
和归一化。

## 3. 当前 Final Tuning 协议参数

| 参数 | 值 | 状态 |
| --- | ---: | --- |
| stripe | 64 KiB | `MODEL` |
| one-way | 0.05 μs | `MODEL` |
| commit/notify/ACK | 2/2/4 cycles | `MODEL` |
| outstanding/NIC | 64 | `MODEL` |
| epochs | 2 | `BASELINE` |
| phase fusion | 3 | `MODEL` |
| commit/ACK batch | 16/16 | `MODEL` |
| overlap depth | 4 | `MODEL` |
| partial-ready | Attention 20%、LSE 25%、Router 18% | `MODEL` |
| group ACK/ready counter | enabled | `BASELINE` |

优化后模型每 token 的 phase 数、peer request 数、wire bytes、RDMA workspace 峰值
和 collective 串行时间以 `data/rdma/k3_rdma_final_tuning_results.json#/search/best`
（`phases`、`requests`、`wireBytes`、`rdmaReserveMiB`、`commUs`）为准；本文不再手抄数值。

## 4. Mailbox 单元

每 mailbox slot 至少包含：

- epoch/generation；
- source rank bitmap；
- committed rank bitmap/counter；
- ACK bitmap/counter；
- payload address/length；
- reduce opcode/dtype；
- ready watermark；
- poison/error；
- timeout/retry state；
- consumer completion。

状态机：

```text
FREE -> RESERVED -> RECEIVING -> PARTIAL_READY
 -> READY -> CONSUMING -> ACK_WAIT -> RELEASED -> FREE(next epoch)
```

任何 generation 不匹配的包都必须丢弃并上报，避免 ABA。

## 5. Partial-ready 约束

Partial-ready 只有在以下条件同时成立时才可启动：

- 输入顺序和归约操作满足结合律/交换律要求；
- 尚未到达的数据有独立 slot；
- consumer 不会读取未提交范围；
- late packet 不覆盖已释放范围；
- LSE 的 m/l/O 分块语义保持正确；
- 错误/重试不会产生重复累加。

当前 20/25/18% 阈值只是经验参数。详细模型必须按到达 bitmap、tile stripe
和 consumer wavefront 推演。

## 6. 流控和可靠性

- credit 在数据可见并具备接收空间后返回；
- ACK 和数据使用不会相互死锁的 VC；
- 支持 CRC、sequence、replay；
- reduce 操作必须处理 replay 去重；
- ECC 错误产生 poison，不得继续静默累加；
- timeout 后冻结 slot，软件决定重试或终止 TP step；
- epoch wrap 需要足够位宽或全局 quiesce。

## 7. 性能签核

分别测量：

- 7.2 KB latent、14.3 KB hidden、约 197 KB FP32 LSE；
- 1、2、4、8 个 active NIC；
- 8/16/32 ranks；
- 无拥塞、Prefill 并发、故障重放；
- P50/P95/P99 和最大时延；
- SRAM bank conflict；
- request/phase fusion 实际收益；
- card-local 与 scale-out 的重叠程度。

## 8. 冻结交付物

- packet/transaction 格式；
- mailbox 和 reduce 单元框图；
- epoch/commit/ACK 状态机；
- LSE 数值规范；
- credit、replay、timeout 和错误语义；
- RTL 级 transaction model；
- 形式验证属性；
- 与 NoC、SRAM、scale-out 的完整接口。
