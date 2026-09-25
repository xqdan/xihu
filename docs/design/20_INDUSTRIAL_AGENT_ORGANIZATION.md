# Industrial Agent Organization

版本：2026-09-22
状态：`PROPOSED / INDUSTRIAL TEAM OPERATING MODEL`

## 1. 组织原则

项目按工业界芯片公司的组织方式管理：Hardware、Software、Model 三大专业团队并行产出，Architecture Council 负责跨团队决策，独立 V&V 团队负责验证和 Gate。D/Q 编号保留为流程兼容角色，但不再作为目录的唯一组织方式。

```text
Architecture Council / ARCH
        |
  +-----+------------------+
  |                        |
Hardware Team       Software Team       Model Team
硬件规格与资源       部署与优化            工作负载与测试场景
  |                        |                  |
  +------------ Integration Contracts --------+
                       |
                 V&V / Independent Gate
```

## 2. 团队边界

| Team | 负责 | 不负责 |
|---|---|---|
| Hardware | 单芯片和封装规格、AI Core、SRAM/TMA、MC、NoC、Die-to-Die、PPA/RAS | 不把软件收益写成硬件能力；不定义模型真实性 |
| Software | 模型部署、runtime、compiler、kernel mapping、融合、通信计算 overlap、调度 | 不修改硬件 peak/带宽规格；不替模型团队补齐未知配置 |
| Model | 三模型 manifest、shape/dtype/routing、场景、算子清单、TP/MC 测试矩阵、golden workload | 不声明硬件可实现性；不把 planning estimate 当实测 |
| Architecture Council | 需求、架构方向、trade-off、ADR、D-Gate 决策 | 不替代专业团队实现细节 |
| V&V | schema、单位、守恒、traceability、Gate、回归 | 不修改被测结果以使 Gate 通过 |

## 3. Agent 命名

命名规则：`<TEAM>-<编号>-<职责>`。

- `HW-*`：硬件规格与物理资源
- `SW-*`：部署、编译器、算子和通信优化
- `MODEL-*`：模型配置、场景和测试
- `ARCH-*`：架构委员会与集成
- `VV-*`：独立验证与签核

旧 D1–D7、Q1–Q9 保留为 compatibility aliases，映射关系见 `data/analysis/teams/industrial_agent_organization.json`。

## 4. 交付和评审规则

每个 Agent 必须交付：职责、输入版本、输出 artifact、约束、风险、验收指标、下游消费者和 handoff。

- Team 内部先完成 peer review；
- 跨团队接口进入 Integration Review；
- 架构方向变化必须由 Architecture Council 记录 ADR；
- 模型配置未确认时只能标记为 `UNVERIFIED_PLANNING_MANIFEST`；
- 模型配置缺失时标记为 `BLOCKED_CONFIG`，不出 TPS；
- 合成事件只能标记为 `SYNTHETIC_PLACEHOLDER`，规划 TPS 标记为 `CALIBRATED_PLANNING_TOKEN_TIME`（ADR-0006），均不驱动时序；
- Q-Gate 只能由 V&V 根据独立证据通过；
- 任何团队不能同时生产并签核自己的关键性能结果。

## 5. 高层交互流程

### Phase 0：Requirements / Council

`ARCH-01` 发布目标、7-reticle 约束、1000 TPS/usr、1050 architecture gate、证据等级和版本。

### Phase 1：Model + Hardware Contract

- Model Team 发布模型 manifest、operator DAG、场景和测试矩阵；
- Hardware Team 发布 compute/memory/network/package envelope；
- 双方通过 workload-to-resource contract 对齐 FLOP、byte、shape、dtype 和通信量。

### Phase 2：Software Feasibility

- Software Team 消费已版本化的模型和硬件 contract；
- 输出部署路径、kernel mapping、fusion、communication-computation overlap、runtime overhead 和收益上下界；
- 任何软件收益必须绑定实现前提、适用模型和 rollback 条件。

### Phase 3：Architecture Integration

`ARCH-02` 汇总三团队结果，生成候选架构、粗 Roofline、PPA 和 TPS envelope；`VV-01` 复核单位、候选覆盖和证据等级；Architecture Council 执行 D-Gate。

### Phase 4：Detailed Co-design

Hardware 的 tile/memory/NoC event、Software 的 schedule/kernel/collective event、Model 的 workload trace 并行生成；`ARCH-03` 只允许由三方共享 hash 的输入进入细 TPS 集成。

### Phase 5：Independent Verification

`VV-02` 验证事件守恒、依赖时序、e2e latency、18-slot 矩阵和 P0/P1/MC320/MC640 分离。若证据仍为 synthetic planning evidence，Q-Gate 必须保持 blocked。

## 6. 详细设计文档层次

```text
docs/design/teams/
  hardware/       硬件规格与物理边界
  software/       部署、编译器、kernel、融合、runtime
  model/          manifest、场景、测试矩阵、模型验收
docs/design/architecture/  跨团队架构决策与接口
verification/              独立验证、golden trace、Gate
reports/agents/            Agent 组织可视化
```

团队 README 定义各自的文档 owner、输入、输出、约束、验收指标和交接格式；跨团队接口集中在 `docs/design/architecture/`，避免一份文档被多个团队同时改写。

## 7. 工业界式评审节奏

- 每周 Team Review：团队内部设计、风险和未决输入；
- 每周 Integration Review：模型、软件、硬件接口和指标变化；
- 每个 milestone 进行 Architecture Review Board：候选、PPA、软件收益和模型覆盖；
- 每次 Gate 前由 V&V 生成独立 report；
- 性能不达标时建立 Backflow Issue，不允许直接修改 Gate 状态。

可视化 Agent 文档：[Agent Organization HTML](../../reports/agents/agent_organization.html)
