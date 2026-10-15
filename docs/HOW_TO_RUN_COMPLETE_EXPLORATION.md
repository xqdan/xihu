# 如何运行完整架构探索

本文档说明如何端到端运行 19 个 workflow 完成一次芯片架构探索。

## 前提条件

1. 所有依赖已安装: `npm install`
2. 测试通过: `npm test`
3. 结构检查通过: `npm run check:structure`
4. 选择后端: `codex` / `claude` / `cursor` / `exchange` / `mock`
   - `mock` 用于流程验证，不产生真实设计
   - 其他后端需要配置相应的 API key 或环境

## 快速开始

### 使用自动化脚本(推荐)

```bash
# 运行完整探索(从头到尾)
npm run exploration:full -- --backend codex --land

# 只跑到某个阶段
npm run exploration:full -- --backend codex --land --stop-at converge

# 从某个阶段继续(跳过已有产物)
npm run exploration:full -- --backend codex --land --start-from coupling

# Dry run(不落盘)
npm run exploration:full -- --backend codex
```

### 手动逐步运行

见下方"分阶段运行"章节。

## 完整流程概览

```
Phase 0: 接口准备(可选)
  └─ contract

Phase A: 立项与需求(B组前三格)
  ├─ intake              需求 → DesignBrief
  ├─ req.workload        每 token 工作量
  └─ req.budget          预算切分

Phase B: 方向探索(B组最后一格)
  └─ arch.direction      形态候选 → ≤3 个方向

Phase C: 域设计(五格可并行)
  ├─ compute             AI Core 设计
  ├─ sram                SRAM 设计
  ├─ mc                  MC 设计
  ├─ comm                通信设计
  └─ physical            物理设计

Phase L3: 联合
  └─ coupling            五域 → 唯一联合点

Phase D: 细化
  └─ integrate           细估 + delta 归因

Phase L4: 归因(可选)
  ├─ attribution:sram
  ├─ attribution:comm
  └─ attribution:joint

Phase L5: 收敛
  └─ converge            冻结/回流/送审

横切(按需)
  ├─ backflow            回流提案
  ├─ verify              独立验证
  └─ audit               证据审计
```

## 分阶段运行

### Phase 0: 接口准备(域间接口变化时才需要)

```bash
node integration/pipelines/run_workflow.js design.contract \
  --backend codex --land
```

**产物**: `out/contracts/contract_interfaces.json`

### Phase A: 立项与需求

#### 1. intake - 需求转换

```bash
node integration/pipelines/run_workflow.js design.intake \
  --backend codex --land \
  --args '{"requirements": "支持 K3/GLM-5.2/DeepSeek-V4-Pro，目标 1000 TPS/usr"}'
```

**产物**: `teams/council/inputs/design_brief.intake.json`

#### 2. req.workload - 工作量分析

```bash
# 先生成工作量汇总
npm run workload:requirements

# 再跑 workflow
node integration/pipelines/run_workflow.js design.req.workload \
  --backend codex --land
```

**产物**: `out/requirements/workload/req_workload.json`

#### 3. req.budget - 预算切分

```bash
# 先生成预算前沿
npm run budget:frontier

# 再跑 workflow
node integration/pipelines/run_workflow.js design.req.budget \
  --backend codex --land
```

**产物**: `out/budget/L1_budget.json`

### Phase B: 方向探索

```bash
# 先生成方向包络和打分卡
node integration/planning/stage_a.js

# 算门控
node integration/governance/evaluate_gates.js

# 跑 workflow
node integration/pipelines/run_workflow.js design.arch.direction \
  --backend codex --land --max 3
```

**产物**: 
- `out/direction/direction_selected.json`
- `out/budget/L2_budget.json`
- `out/governance/arch_direction_evidence_package.json`

### Phase C: 域设计(五个可并行)

每个域都是: 先跑搜索 → 再跑 workflow

#### compute

```bash
npm run compute:search
node integration/pipelines/run_workflow.js design.compute \
  --backend codex --land
```

**产物**: `out/compute/compute_winner.json`

#### sram

```bash
npm run sram:search
node integration/pipelines/run_workflow.js design.sram \
  --backend codex --land
```

**产物**: `out/sram/sram_winner.json`

#### mc

```bash
npm run mc:search
node integration/pipelines/run_workflow.js design.mc \
  --backend codex --land
```

**产物**: `out/mc/mc_winner.json`

#### comm

```bash
npm run comm:search
node integration/pipelines/run_workflow.js design.comm \
  --backend codex --land
```

**产物**: `out/comm/comm_winner.json`

#### physical

```bash
npm run physical:search
node integration/pipelines/run_workflow.js design.physical \
  --backend codex --land
```

**产物**: `out/physical/physical_winner.json`

**并行运行提示**: 如果后端支持并发，可以同时跑五个域的 search 和 workflow，能显著缩短总时间。

### Phase L3: 联合

```bash
# 先生成联合候选
npm run coupling:search

# 跑 workflow
node integration/pipelines/run_workflow.js design.coupling \
  --backend codex --land
```

**产物**: `out/coupling/joint_point.json`

### Phase D: 细化

```bash
# 先跑规划模型
npm run model:planning

# 跑 workflow
node integration/pipelines/run_workflow.js design.integrate \
  --backend codex --land
```

**产物**: `out/detailed/detail_integrate.json`

### Phase L4: 归因(可选，按需跑某个维度)

```bash
# 先生成归因卡
npm run attribution:cards

# 跑三个维度(可并行)
node integration/pipelines/run_workflow.js design.attribution \
  --backend codex --land --dimension sram

node integration/pipelines/run_workflow.js design.attribution \
  --backend codex --land --dimension comm

node integration/pipelines/run_workflow.js design.attribution \
  --backend codex --land --dimension joint
```

**产物**: `out/attribution/reviews/{sram,comm,joint}_review.json`

### Phase L5: 收敛

```bash
# 确保门控状态已计算
node integration/governance/evaluate_gates.js

# 跑 workflow
node integration/pipelines/run_workflow.js design.converge \
  --backend codex --land
```

**产物**: `out/detailed/converge_proposal.json`

**可能结局**:
- `ARCH_FREEZE`: 架构冻结，进入下一阶段
- `DIRECTION_BACKFLOW`: 需要回到方向层，见下方"处理回流"
- `D_GATE_PROPOSAL`: 送评审

## 横切 Workflow(按需)

### backflow - 回流提案

```bash
node integration/pipelines/run_workflow.js design.backflow \
  --backend codex --land
```

**何时跑**: `integrate` 的 delta 归因后，需要判断是否回到方向层。

### verify - 独立验证

```bash
node integration/pipelines/run_workflow.js design.verify \
  --backend codex --land
```

**何时跑**: 任何阶段产物需要外部复核时。

### audit - 证据审计

```bash
node integration/pipelines/run_workflow.js design.audit \
  --backend codex --land
```

**何时跑**: 需要检查证据链和口径一致性时。

### explore - 自由探索

```bash
node integration/pipelines/run_workflow.js design.explore \
  --backend codex \
  --args '{"question": "MoE routing 对 SRAM 的影响", "expert": "memory-expert"}'
```

**产物**: `scratch/explore_<runId>.md` (不进 `out/`，不可作为证据)

### learn - 知识沉淀

```bash
node integration/pipelines/run_workflow.js design.learn \
  --backend codex --land \
  --args '{"units": ["ai-core", "memory-hierarchy"]}'
```

**产物**: `references/sota/*.md`

## 处理回流

当某个 workflow 返回 `DIRECTION_BACKFLOW` 时:

1. **从 C 组回流到 B 组**:
   ```bash
   # 重新跑方向探索
   node integration/planning/stage_a.js
   node integration/pipelines/run_workflow.js design.arch.direction \
     --backend codex --land
   
   # 再重跑受影响的域
   ```

2. **从 D 组回流到 B 组**:
   ```bash
   # 先跑 backflow 生成提案
   node integration/pipelines/run_workflow.js design.backflow \
     --backend codex --land
   
   # 根据提案决定是否重跑方向
   ```

3. **从 req.budget 回流到 intake**:
   ```bash
   # 重新审视需求或目标
   node integration/pipelines/run_workflow.js design.intake \
     --backend codex --land \
     --args '{"requirements": "<调整后的需求>"}'
   ```

## 增量运行与断点续跑

### 使用 --skip-if-landed

跳过已有产物的 workflow:

```bash
node integration/pipelines/run_workflow.js design.compute \
  --backend codex --land --skip-if-landed
```

### 使用编排脚本的 --start-from

```bash
# 从 coupling 开始，跳过前面所有阶段
npm run exploration:full -- --backend codex --land --start-from coupling
```

### 清理产物重跑

```bash
# 清理某个阶段的产物
rm out/compute/compute_winner.json

# 重跑
node integration/pipelines/run_workflow.js design.compute \
  --backend codex --land
```

## 验证与检查

### 每个阶段后检查

```bash
# 检查产物是否生成
ls -lh out/<domain>/

# 验证 JSON 格式
node -e "console.log(JSON.parse(require('fs').readFileSync('out/compute/compute_winner.json')))"

# 跑回归测试
npm test
```

### 运行 verify

```bash
node integration/pipelines/run_workflow.js design.verify \
  --backend codex --land
```

### 检查门控状态

```bash
node integration/governance/evaluate_gates.js
cat out/governance/gate_status.json | jq '.detailGate.status'
```

## 成本与时间估算

基于 doc 22 §9.3 的预算:

| 阶段 | workflow 数 | 实例数(估算) | 预计时间(mock) | 预计时间(真实) |
|---|---|---|---|---|
| Phase A | 3 | ~20 | 5 min | 30-60 min |
| Phase B | 1 | ~15 | 3 min | 20-40 min |
| Phase C | 5 | ~60 | 10 min | 1-2 hr |
| Phase L3 | 1 | ~10 | 2 min | 15-30 min |
| Phase D | 1 | ~15 | 3 min | 20-40 min |
| Phase L4 | 3 | ~30 | 5 min | 30-60 min |
| Phase L5 | 1 | ~10 | 2 min | 15-30 min |
| **总计** | **15** | **~160** | **30 min** | **3-6 hr** |

**优化建议**:
- Phase C 五个域可并行，实际时间可缩短到单域时间
- 使用 `--skip-if-landed` 跳过已完成阶段
- 先用 `mock` 验证流程，再用真实后端

## 常见问题

### Q: workflow 报 BLOCKED_CONFIG 怎么办？

A: 检查 `nextActions` 字段，它会告诉你缺什么输入。常见原因:
- 前置脚本没跑
- 产物过期(基线变了)
- 前一个 workflow 没有成功落盘

### Q: 怎么只跑一个域的设计？

A: 直接跑那个域的 workflow:
```bash
npm run compute:search
node integration/pipelines/run_workflow.js design.compute --backend codex --land
```

### Q: 产物的版本怎么管理？

A: 每个产物都带 `sourceCommit` 和 `runId`，可以用 git 跟踪。`out/` 下的文件应该提交到仓库，作为设计基线。

### Q: 怎么复现某次运行？

A: 产物里的 `runId` + `sourceCommit` + `strategyVersions` 可以定位:
- 代码版本
- 策略版本
- 输入哈希

用相同的三者重跑应该得到相同结果。

### Q: mock 和真实后端的区别？

A: 
- `mock`: 返回符合 schema 的假数据，用于流程验证
- 真实后端: 调用 LLM 产生实际判断，结果不可预测

### Q: 为什么有些 workflow 还没实现？

A: Doc 22 第 4 行明确说"尚未在真实 Workflow runtime 上端到端运行"。目前只有结构测试和 mock 测试通过。建议先跑最短链路验证: `intake` → `compute` → `verify`。

## 参考文档

- [22_AGENT_WORKFLOW_REFACTOR_PLAN.md](../teams/council/docs/22_AGENT_WORKFLOW_REFACTOR_PLAN.md) - 设计方法论
- [WORKFLOWS.md](../integration/orchestration/WORKFLOWS.md) - 每个 workflow 的业务含义
- [AGENTS.md](../AGENTS.md) - 团队组织与规则
- [integration/orchestration/README.md](../integration/orchestration/README.md) - Workflow 脚本 API
