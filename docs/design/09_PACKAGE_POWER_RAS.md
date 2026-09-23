# 封装、I/O、功耗、时钟、散热与 RAS

## 0. 7-reticle 单芯片封装边界

新的主规划采用 7-reticle package：约 82×64 mm 工程 placement window，8 个 20×20 mm Compute Die，16 个约 10×10 mm MC。7R 理论面积按 26×33 mm/reticle 计为 6,006 mm²，工程 placement window 按 5,248 mm²管理。

面积基线：8×400 mm² Compute Die + 16×100 mm² MC = 4,800 mm²；剩余约 448 mm²用于 RDL、die 间距、keep-out、PDN、时钟、热扩散和维修余量。一个 package 对软件表现为一个 TP rank，32 个 package 组成 TP32。
## 1. 当前封装候选

- 8 个约 400 mm² Compute Die；
- 16 个约 100 mm² MC；
- Compute Die 4×2 排布；
- 每 Compute Die 本地连接 2 个 MC；
- 封装内 Die fabric；
- 板间 scale-out 和主机接口从 package 边缘引出。

7R 主候选的裸片面积为：

```text
8 × 400 + 16 × 100 = 4,800 mm²
```

相对 5,248 mm² 工程 placement window 预留约 448 mm²，用于 die 间距、RDL、
keep-out、PDN、时钟、热扩散和维修余量。当前 P1 搜索使用的 Die 面积（见 `00_CURRENT_STATE.md` 第 2 节）
是 compact executable profile，不能覆盖 7R 主候选的 8 L + 8 H / 96 MiB
物理规划；两者需要独立 floorplan 和 PPA budget。

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

- Compute Die：250 W budget ×8（7R physical primary）；P1 compact model 的 Die 功耗 ×8 仅作对照（`spec/k3_mc_baseline.json`）；
- 16 MC：模型约 398.72 W；
- Package 级固定控制/其他：需重新预算，不能沿用 80 W；
- Compute + MC + package overhead 的合计必须按 7R profile 重算；
- Package cooling envelope 初始按 2.8–3.2 kW 规划。

仅剩约 21.64 W 分析余量，且尚未可靠包含：

- 高速 SerDes/光模块真实功耗；
- ECC、DFT、clock tree；
- VRM 损耗；
- BMC、主机接口；
- SRAM compiler 差异；
- PVT guardband；
- 老化和漏电。

因此当前 640 GB/s Stretch 配置在功耗上也不能直接冻结；7R 主候选必须重新进行 package-level power/thermal closure。

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
