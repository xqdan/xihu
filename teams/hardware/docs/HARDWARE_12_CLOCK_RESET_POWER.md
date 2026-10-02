# HARDWARE-12：时钟、复位与电源域

- 所有者：Hardware（时钟/低功耗）；共签：Council（系统复位策略）、RAS（故障降级）
- 状态：域划分 `BASELINE`；**频率规划与 CDC 细节 `OPEN`**（无 RTL、无 PDK）
- 权威来源：[`09_PACKAGE_POWER_RAS.md`](09_PACKAGE_POWER_RAS.md) §5、
  [`HARDWARE_11_FLOORPLAN_AREA.md`](HARDWARE_11_FLOORPLAN_AREA.md)、21 号文档 §1.1

## 0. 本文解决什么

`09_PACKAGE_POWER_RAS.md` §5 已经给出了域划分的草图（主域 / PHY 域 / 管理域）。
本文把它扩成可实现的规格：**每个域的频率来源、CDC 位置、复位顺序、上下电序列**。

其中**只有域划分与固定频率有依据**，其余是决策框架。理由：CDC 与复位顺序的正确性只能由 RTL 与仿真证明，
在 RTL 之前把它写成"规格"会让下游误以为已经验证过。

## 1. 频率与时钟域

| 域 | 频率 | 来源 | 可否 DVFS | 状态 |
| --- | ---: | --- | --- | --- |
| 主域（Tensor / Vector / TMA / NoC / Reduce） | 1.0 GHz | 固定，**不参与搜索** | **否**，只允许热保护降频 | `BASELINE` |
| MC UCIe 域 | 待定（由 UCIe 规范定） | 恢复时钟 / 本地 PLL | 否 | `OPEN` |
| Die 间 UCIe 域 | 待定 | 同上 | 否 | `OPEN` |
| Scale-out SerDes 域 | 待定 | 同上 | 否 | `OPEN` |
| 管理/安全低速域 | 待定（通常 25–100 MHz） | 独立 | 是 | `OPEN` |

**"不得靠降频换算力"的含义**（21 号文档 §1.1）：主域频率是目标的一部分，不是可以交换的旋钮。
热保护降频是**故障路径**，不是性能策略——它触发时整组 TP32 的吞吐下降必须被 telemetry 记录（R-005）。

## 2. 时钟生成与分配

| 项 | 做法 | 状态 |
| --- | --- | --- |
| 主域时钟源 | 片外参考 + 片内 PLL | 决策框架 |
| PLL 数量与位置 | 按 core cluster 划分，避免长距离全局树 | `OPEN`，待 floorplan |
| 时钟树 | 主域 H-tree + cluster 局部树 | `OPEN`，待 P7-c |
| Core cluster gating | 每 cluster 独立 gate | `BASELINE`（09 号文档 §5） |
| SRAM bank gating | 每 bank 独立 gate | `BASELINE` |
| PHY lane power gating | 每 lane 独立 | `BASELINE` |

## 3. 复位架构

复位顺序必须与软件启动流程对齐（`teams/software/docs/COMPILER_RUNTIME_AND_FIRMWARE.md`）。
以下顺序是**要求**，具体实现待 RTL：

```
上电 → 管理域复位释放 → 主域 PLL 锁定 → 主域复位释放
     → NoC/路由表初始化 → 本地 SRAM 清零（如安全要求）
     → PHY 域复位释放 → MC 训练 → UCIe link 训练 → 环拓扑发现
     → scale-out link 建立 → 进入可调度状态
```

| 要求 | 内容 |
| --- | --- |
| R-1 | 每个域必须有独立复位，且复位域边界与时钟域边界一致 |
| R-2 | 复位释放必须异步断言、同步释放（每域两次触发器） |
| R-3 | 跨域复位释放顺序由上表固定，不得由软件随意重排 |
| R-4 | 集合通信的 epoch / mailbox 状态必须在复位时确定性清零，否则会出现跨复位的旧消息残留（O-010） |
| R-5 | 任一域复位不得导致其他域丢失已提交的数据（KV cache 在本地 SRAM 的部分需重新取回） |

## 4. CDC 与跨域接口

跨域接口**每一个**都必须声明：同步方式、位宽、credit 机制、错误注入行为。清单：

| 跨域路径 | 同步方式 | 状态 |
| --- | --- | --- |
| 主域 ↔ MC UCIe | 握手 + credit（`09` 号文档 §5） | `OPEN`，待 RTL |
| 主域 ↔ Die 间 UCIe | 同上 | `OPEN` |
| 主域 ↔ Scale-out SerDes | 同上 | `OPEN` |
| 主域 ↔ 管理域 | CDC FIFO | `OPEN` |
| reduce/collective 计数器 ↔ 管理域 | 双触发器同步 | `OPEN` |

**CDC 是 RTL 阶段最常见的重做来源**，因此本文只列清单、不预先规定实现。
`HARDWARE_15_RTL_VERIFICATION.md` 的第 3 节要求每个 CDC 有对应的断言或形式化检查。

## 5. 电源域与上下电

| 域 | 可独立下电 | 下电影响 | 状态 |
| --- | --- | --- | --- |
| 主域 core cluster | 是（gate） | 该 cluster 停算，调度器需能摘除 | `BASELINE` |
| 本地 SRAM bank | 是（gate，非断电） | 数据保留 | `BASELINE` |
| PHY 域 | 部分（lane 级） | 带宽下降，需重新训练 | `OPEN` |
| MC | 否（Decode 期间） | — | 决策框架 |

**与功耗预算的关系**：`09_PACKAGE_POWER_RAS.md` §4.2 列出卡功耗余量 55.12 W，并明确列出
"尚未可靠计入"的 8 项（SerDes/光模块、ECC、DFT、clock tree、VRM 损耗、BMC/主机接口、SRAM compiler 差异、PVT guardband、老化与漏电）。
本文的 clock tree、gating、CDC 逻辑都落在 clock tree 与 ECC/DFT 这两项里——**它们是余量的消耗方，不是余量的来源**。
卡功耗的逐项分配见 [`HARDWARE_POWER_BUDGET.md`](HARDWARE_POWER_BUDGET.md)。

## 6. 未闭合项

| 项 | 状态 | 责任 | 关闭证据 |
| --- | --- | --- | --- |
| PLL 数量/位置 | `OPEN` | 后端 | P7-b floorplan |
| CDC 实现 | `OPEN` | RTL | 断言 + 形式化（文档 15 §3） |
| PHY 域频率 | `OPEN` | PHY | UCIe/SerDes IP 规格 |
| 上下电时序细节 | `OPEN` | RTL + 固件 | 固件启动流程 |
| 热保护降频策略 | `OPEN` | RAS | `09` 号文档 §6 散热 + telemetry 需求 |
