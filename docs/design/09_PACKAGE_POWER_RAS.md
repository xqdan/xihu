# 封装、I/O、功耗、时钟、散热与 RAS

## 1. 当前封装候选

- 8 个 Compute Die；
- 16 个约 102 mm² MC；
- Compute Die 2×4 排布；
- 每 Compute Die 本地连接 2 个 MC；
- 封装内 Die fabric；
- 板间 scale-out 和主机接口从封装边缘引出。

旧封装文档按 20×20 mm、400 mm² Compute Die 设计。最新候选面积为
259.57 mm²，若近似正方形边长约 16.1 mm，必须重新做 floorplan，不能继续
直接使用旧的 82×64 mm 摆放结论。

按面积粗算：

```text
8 × 259.57 + 16 × 102 ≈ 3708.6 mm² bare-die area
```

相对 5248 mm² 中介层概念面积有约 29% 平面余量，但真实可行性还取决于
keep-out、stitch、TSV、PDN、PHY 岸线和 die 间距。

## 2. I/O 岸线

当前搜索候选每 Compute Die：

- 4 个抽象 UCIe controller group；
- 每组 128 lanes×64 Gbps 的模型参数；
- 16 条 112 Gbps scale-out/RDMA lane；
- MC、Die fabric、scale-out 的 PHY 类型尚未拆分。

这套数字不能直接进入 bump map。需先完成端口表：

| 端口类 | 对端 | 端口数 | payload | PHY/协议 | 状态 |
| --- | --- | ---: | ---: | --- | --- |
| MC local | 2 MC | 2 | 320 GB/s/MC 起 | UCIe 1.1 类 | `BASELINE` |
| Die fabric | 邻 Die | 待定 | 待定 | UCIe/自定义短距 | `OPEN` |
| Scale-out | 其他卡/交换 | 待定 | 800 GB/s/card | 电/光 SerDes | `OPEN` |
| Host | CPU/root complex | 待定 | 非 Decode 关键路径 | PCIe/CXL | `OPEN` |
| Management | BMC/JTAG/I3C | 若干 | 低速 | 标准接口 | `OPEN` |

## 3. 功耗

当前分析结果：

- Compute Die：237.46 W×8；
- 16 MC：模型约 398.72 W；
- 卡级固定控制/其他：80 W；
- 合计：2378.36 W；
- 卡级上限：2400 W。

仅剩约 21.64 W 分析余量，且尚未可靠包含：

- 高速 SerDes/光模块真实功耗；
- ECC、DFT、clock tree；
- VRM 损耗；
- BMC、主机接口；
- SRAM compiler 差异；
- PVT guardband；
- 老化和漏电。

因此当前 640 GB/s Stretch 配置在功耗上也不能直接冻结。

## 4. 时钟与电源域

初始建议：

- Tensor/Vector/TMA/NoC 主域 1.2 GHz；
- MC PHY、Die PHY、scale-out PHY 各自时钟域；
- 管理/安全低速域；
- 每 Die 独立 DVFS；
- Core cluster clock gating；
- SRAM bank gating；
- PHY lane power gating；
- reduce/collective 独立功率计数器。

跨域接口必须定义 CDC、reset sequencing、credit 恢复和错误注入行为。

## 5. 散热

2.4 kW 级卡必须按液冷规划。验证包括：

- Compute Die 和 MC 共面/热阻；
- 8 Die 热不均匀；
- MC 堆叠热热点；
- scale-out PHY 边缘热点；
- VRM 和连接器；
- 冷板流量、压差、入口温度；
- 单泵/单回路故障；
- 温降频对 TP32 最慢 rank 的影响。

## 6. RAS

- SRAM SECDED、scrub、spare；
- NoC/router parity/ECC；
- MC/UCIe CRC、retry、lane repair；
- RDMA sequence/replay/poison；
- watchdog 和 collective timeout；
- 每 Die/MC/link 独立隔离；
- page remap；
- 降频、降 lane、降容量运行；
- secure boot、firmware authentication、debug lock；
- 错误日志可关联 tile/epoch/rank。

## 7. 冻结交付物

- 新版封装 floorplan；
- PHY beachfront 和 bump map；
- interposer/RDL/PCB 拓扑；
- PDN/IR-drop/SSN；
- clock/reset/power-domain；
- 热仿真与冷板需求；
- RAS 故障矩阵；
- 卡级功耗清单和降额策略；
- 封装厂、PHY/IP、MC 供应商确认。
