# 19 个 workflow 的业务含义

本文回答一个问题：**每个 workflow 在芯片架构设计这件事里，对应哪一个业务环节？**
它不重复实现细节（见各脚本的 `meta` 与 [`README.md`](README.md)），也不重复方法论（见
[`22_AGENT_WORKFLOW_REFACTOR_PLAN.md`](../../teams/council/docs/22_AGENT_WORKFLOW_REFACTOR_PLAN.md)）。

读法：workflow 不是"一个 agent 做一件事"，而是"设计流程的一格"——它拿到一份由主循环注入的输入，
调起若干策略实例做**判断**，由脚本做**计算**，最后把产物交给主循环落到 `out/`。
任何一格都不能宣布门控通过；门控只由 [`evaluate_gates.js`](../governance/evaluate_gates.js) 算。

## 1. 一张图：设计流程怎么走

```mermaid
flowchart TB
  IN["intake<br/>需求 → 可下发的 brief"] --> CT["contract<br/>四域/五专家对外接口"]
  IN --> WL["req.workload<br/>每 token 的工作量与算术强度"]
  WL --> RB["req.budget<br/>算力 / 带宽 / τ 的预算切分 → L1 合同"]
  RB -->|"L1 预算合同"| DIR
  RB -->|"所有切分都不可达"| IN
  CT --> DIR["arch.direction<br/>走哪条架构路线，并凑齐能否进细化的证据（不判门）"]
  DIR --> C["compute / sram / mc / comm / physical<br/>五个硬件域各选出具体设计点"]
  C --> CP["coupling<br/>五域合成唯一联合点"]
  CP --> D0["integrate<br/>细化：冻结、事件、执行/PPA、粗细估对账（一格四块）"]
  D0 --> CV["converge<br/>架构定型 / 回流 / 送评审"]
  AT["attribution（sram / comm / joint）<br/>每个参数怎么影响 TPS/usr、谁承重"] -.->|"灵敏度卡 + 承重项（经 Q-Gate 三条判据）"| CV
  CV -->|"DIRECTION_BACKFLOW"| BF["backflow<br/>把 delta 归因变成方向级回流"]
  BF --> DIR
  VF["verify（产物能否站住）<br/>audit（依据是否自洽）"] -.->|"只读已落盘产物"| C
  VF -.-> D0
  EX["explore（自由探索，scratch/）"] ~~~ LN["learn（一次性沉淀 SOTA 知识卡）"]
```

按业务阶段归类：

| 业务阶段 | workflow | 一句话 |
|---|---|---|
| 立项与接口 | `intake`、`contract` | 把需求变成可计算输入；各域对外承诺什么接口 |
| 工作量（L1-a） | `req.workload` | 每 token 做多少 FLOP、搬多少字节、通信多少次，谁吃算力谁吃带宽 |
| 需求预算（L1-b） | `req.budget` | 达到目标 TPS/usr，算力、带宽、τ 各给多少，切成一份可下发的预算合同 |
| 方向级探索（Stage A） | `arch.direction` | 在资源包络内比较架构路线，并凑齐"能否进细化"的证据 |
| 域内设计 | `compute`、`sram`、`mc`、`comm`、`physical` | 方向定了之后，每个硬件域在设计空间里选出一个具体设计点 |
| 参数级细化（Stage B） | `integrate` | 冻结 → 事件与守恒 → 执行账本 → delta 归因，逐块把粗估变细估，并对账 |
| 维度归因 | `attribution` | 每个设计维度的参数动一步，TPS/usr 变多少、代价多少、哪些承重 |
| 收敛 | `converge` | 这一轮到此为止、回流重来，还是送评审 |
| 回流与复核 | `backflow`、`verify`、`audit` | 不达标往回退；独立复核产物和依据 |
| 例外与准备 | `explore`、`learn` | 受控的自由探索；一次性学习外部方案 |

## 2. 逐个说明

每一格都写五件事：**要回答的业务问题 / 什么时候跑 / 产出 / 可能的结局 / 它不负责决定什么**。
"输入"都由主循环经 `args` 注入，脚本自己不读文件。

### 立项与接口

#### `design.intake` — 需求能否变成可计算输入
- **业务问题**：一段自然语言需求，加上预算，能不能变成各域都能接着干活的约束、预算和形态意图？
- **什么时候跑**：整个设计流程的第一格，需求或预算变了就重跑。
- **做法**：6 个领域专家各自提出本域硬约束 → `architect` 合并、分配预算、给出形态意图 → `framing-critic` 审查框架是否完整、口径是否一致、设计空间有没有被写窄；不通过就带缺口清单重写，**最多 2 轮**。
- **产出**：`teams/council/inputs/design_brief.intake.json`（DesignBrief + ledger 种子）。
- **不负责**：不做任何性能判断；它只决定"问题是怎么问的"。

#### `design.contract` — 接口长什么样
- **业务问题**：compute / memory / comm / physical / software 五个域，各自对外承诺什么接口、单位和守恒量？冲突和未决项登记在哪？
- **什么时候跑**：域间接口发生变化，或新增域之前。
- **做法**：5 个专家各申报接口 → `architect` 收敛成一份契约 → `verifier` **只读已落盘契约**做独立验证 → `invariant-checker` 检点。
- **产出**：`out/contracts/contract_interfaces.json`。契约文件本身由 `generate_team_contracts.js` 生成，本格只审查。
- **不负责**：不生成契约、不改 `teams/*/contract.json`。

### 工作量（L1-a）

#### `design.req.workload` — 每 token 的工作量是多少，谁吃算力谁吃带宽
- **业务问题**：一个 token 在每类算子上做多少 FLOP、搬多少字节、做多少次集合通信？算术强度落在 Roofline 的哪一侧？需求侧的算力 / 带宽 / 网络三条比各差多少？哪些算子是瓶颈、哪些还没配置？
- **什么时候跑**：`npm run workload:requirements` 生成工作量汇总之后，排在 `design.intake` 之后、`design.req.budget` 之前——**工作量是预算切分的输入**：先定每 token 要干多少活，再分算力、带宽和 τ 的预算，而不是等五域设计完了再回头算工作量。基线或规划算子账变了汇总即过期，`run_workflow.js` 拒收过期汇总。
- **做法**：数全部来自内核（`integration/planning/requirement_workload.js`：按模型 × TP 给出按 core class 拆分的 FLOP/字节、算术强度直方、集合通信次数与字节、三条需求侧比值）→ `model-expert` 定算子 manifest 与算子 DAG（未知配置一律 `BLOCKED_CONFIG`，不静默补齐）→ `compute-expert` ∥ `memory-expert` ∥ `comm-expert` 各自认领由本域资源决定的算子，给出算术强度、Roofline 侧与出处；**算术强度、Roofline 判定与三条比都由脚本算好绑在产物里，三位申报人只读、只解释，逐字转抄，不得重算** → `integrator` 合并成算子账本（每个算子五个登记字段 + 三条比 + owner）→ 脚本对账（算子字段、三条比、状态取值域）→ `invariant-checker` 检点。
- **产出**：`out/requirements/workload/req_workload.json` 与 run record。汇总本身是生成物（`out/requirements/workload_requirements.json`），本格不能落到它旁边。
- **结局**：检点通过则落盘算子账本；某域专家缺席 `BLOCKED_CONFIG` 并在 `absentLateral` 里点名（缺席的一侧不能当作"没有意见"）；申报人判方向级问题 `DIRECTION_BACKFLOW`，回 `design.arch.direction`；合并出现无法解释的 delta `DELTA_UNEXPLAINED`。
- **不负责**：不算任何数（内核里没有的数不得出现）、不改内核产物、不输出 TPS/usr、不判门控。集合通信在本格是**并列的一域**（`comm-expert`），次数与字节按 `reference-393` / `repo-510` 两口径并列陈述（ADR-0004）。

### 需求预算（L1-b）

#### `design.req.budget` — 算力、带宽、τ 各给多少
- **业务问题**：要达到 1000 TPS/usr（raw 预算约 854.7 µs），持续带宽最少多少、有效算力最少多少、τ 最多多大；这几项之间怎么换；切成哪一份预算合同交给下游。
- **什么时候跑**：`npm run budget:frontier` 生成预算前沿之后。基线或规划算子账变了前沿即过期，`run_workflow.js` 拒收过期前沿。
- **做法**：数全部来自前沿（`integration/planning/requirement_frontier.js`：规划 token time 给每个模型 × TP 的带宽下限与"算力 ↔ τ"等 TPS 直线，K3 TP32 详细模型给单轴余量与 SRAM 下限，再枚举 4 份候选切分 `S-TAU` / `S-CMP` / `S-BW` / `S-BAL`，每份都在两个模型上复算过守得住预算）→ 每条预算条目的 owner 专家（compute / memory / comm / physical）判本域的数**物理上**是否可达（`reachable` / `unreachable` / `unknown`，附可信区间与出处）→ 有条目不可达的切分被否，记入 `ledgerPatch.rejectedOptions` → `architect` 只在剩下的切分里挑一份（只选 id，不填数）→ `framing-critic` 审预算是否把设计空间写窄 → `invariant-checker` 检点（漏审条目、选了被否切分、卡外数字由脚本机械比对）。
- **产出**：`out/budget/L1_budget.json`（所选切分的合同原样 + `selection` 记录）与 `L1_run_record.json`。落盘前主循环核对合同与前沿里那份切分逐字段一致、`selection.frontierSha256` 是读入的那份前沿，不符退出码 5；专家 `plausibleRange` 里的前沿外数字不在其 `rangeEvidence` 所引行上，退出码 7。
- **结局**：检点通过则落盘合同；所有切分都有条目不可达 → `DIRECTION_BACKFLOW`，回 `intake` 由人决定目标或场景；`physical-expert` 或 `architect` 判方向级问题 → 回 `arch.direction`；专家缺席或输入不足 `BLOCKED_CONFIG`。
- **不负责**：不算任何数、不编新切分、不判门控。合同目前还没有下游格消费（`make_brief.js` 是下一步，见 23 号文档 §7）；前沿只覆盖 K3 的详细模型，GLM-5.2、DeepSeek-V4-Pro 只受规划模型约束。

### 方向级探索（Stage A · B 组唯一一格）

#### `design.arch.direction` — 走哪条路线，以及它能不能进细化
- **业务问题**：两个问题合成一格。在 7-reticle 面积等资源包络内，**形态宏参数**（L/H 算力配比、片上 SRAM 总量与 local/shared 切分、MC 档位、die 数、TP）的候选里哪些站得住、瓶颈是什么、最后留下哪 ≤3 个进入 Stage B？D-Gate 的 8 条门槛（面积守恒、预算齐全、三模型都有粗估、每个候选有瓶颈、至少一个候选达标或有替代方案、证据等级标注、top-10 敏感性、候选 ≤3）各自的证据又齐不齐、缺什么？
- **什么时候跑**：`stage_a.js` 生成方向包络、打分卡与 L2 预算骨架之后，`evaluate_gates.js` 算出门控结论之后。候选由 `run_workflow.js` 从打分卡的 `morphology.rows` 注入（满足全部 L1 条目的排前），也可用 `--args` 显式给。
- **做法**：每个候选交给一个 `architect` 实例独立评估（互相看不见；候选是**形态宏参数**，面积/功耗由 `k3_architecture_search.js#physical(x, dies)` 算、按 `k3_physical_basis.js#resize()` 归到 SF4/liquid 基准，TPS 由 token time 算，对照 L1 合同逐条"满足 / 差多少"） → `integrator` 合并并登记冲突与排除依据 → `framing-critic` 对抗式审查框架（约束完整吗、口径对吗、形态空间是不是被写窄了） → **一个** `gate-keeper` 一次核完 8 条门槛的证据、**逐条**给 status / evidenceLevel / evidence / blocker → `architect` 汇总证据包（门控结论照抄脚本产物） → `invariant-checker` 检点（专门核验转抄是否逐字一致、有没有混进自行判定的结论）。
- **产出**：`out/direction/direction_selected.json`、`out/budget/L2_budget.json`（把 L1 合同的 `B-SRAM-CAP` 细化成本地/共享两半，其余条目原样继承）、`out/governance/arch_direction_evidence_package.json` 与 run record。
- **不负责**：不跑搜索（枚举与打分由 `integration/planning/morphology.js` + `stage_a.js` 在主循环侧跑完）、不给 TPS、**不判门控**。结论由 `evaluate_gates.js` 给出，本格对一个实例逐条核证据、对结论原样转述；它是最容易写歪的一格。

**为什么与 `design.dgate` 合并**：拆两格曾经的理由是"路线选择"与"门控放行"是两件事，但两格读的是同一份打分卡、同一份包络，第二格除了把第一格刚核过的门槛再核一遍之外没有新输入——于是"两格"只是把同一批证据分两次走一遍，还要靠 brief 的 `stage` 字段把它们接起来。**为什么门槛核验只开一个实例**：8 条门槛读的是同一份打分卡与同一份包络，彼此之间没有信息屏障要维护（候选评估要互相看不见，是因为看得见就会对齐措辞；门槛核验没有这个问题）。开 8 个实例换来的不是独立性，是同一份产物被读 8 遍，以及"8 条之间的交叉引用没人负责"这个缺口。收成一个实例后交叉引用落在同一个实例里，而每条仍必须各自给 status / evidenceLevel / evidence / blocker，宽松不会从一条传染到另一条。

### 域内设计（C 组，五格同构）

五格共用一套骨架：**专家提搜索策略 → 确定性脚本枚举打分 → 旁证专家对候选提侧向约束 → integrator 合并 → invariant-checker 检点后落盘**。
区别只在主策略、设计空间和旁证专家。候选数值由 `search_brief.js` 读取并核验后注入，agent 不转写数字；落盘后再用 `search_brief.js verify` 核对 winner 是产物里的一行。

| workflow | 业务问题 | 设计空间 | 旁证专家 | 产出 |
|---|---|---|---|---|
| `design.compute` | AI Core 里 L/H/Vector/Indexer/Reduce 怎么配比、算力落在 roofline 哪一侧 | matrix:vector 设计搜索（HW-02） | memory、physical | `out/compute/compute_winner.json` |
| `design.sram` | shared SRAM 容量、L/H bank、shared slice、TMA 引擎与端口扩展怎么定，满足 B-SRAM-CAP | SRAM 设计搜索（`sram_design_space.json`） | compute、mc、software | `out/sram/sram_winner.json` |
| `design.mc` | MC、HBM、TMA 的带宽怎么定，满足 B-MEM-BW | MC 设计搜索（`memory_design_space.json`） | sram、comm、physical | `out/mc/mc_winner.json` |
| `design.comm` | NoC、集合通信、Comm Core 怎么定 | Comm Core 设计搜索（HW-07） | mc、compute、physical | `out/comm/comm_winner.json` |
| `design.physical` | 封装、面积、功耗、热能不能放下前四者的选择 | 物理设计搜索 | compute、sram、mc、comm | `out/physical/physical_winner.json` |

- **什么时候跑**：方向确定后，对应的 `*:search` 已经生成候选。
- **结局**：检点通过则落盘 winner；搜索产物缺失、旁证专家缺席或检点不通过时返回 `BLOCKED_CONFIG`，**不写 winner**。
- **不负责**：不枚举候选、不算分、不给全局 TPS；一个域的 winner 不等于全局最优，要等 `design.coupling` 把五个 winner 放在一起回放。

### 跨域联合（L3 `design.coupling`）

#### `design.coupling` — 五个域的 winner 放在一起，合同还成立吗；沿耦合维度有没有更好的组合

- **什么时候跑**：五个 C 组域都已有 winner，`npm run coupling:search` 已生成 `out/detailed/coupling_candidates.json`。
- **谁参与**：耦合两侧的域专家五席并行审行（`compute-expert`、`memory-expert/sram`、`memory-expert/mc`、`comm-expert`、`physical-expert`，与 `coupling_design_space.json` 的 `couplings.*.seats` 一致）→ `integrator` 在可行的 Pareto 行里取联合点 → 脚本机械核对它是产物原行 → `invariant-checker`。
- **设计空间**：三组耦合的小网格，全部回放，没有搜索策略一步：SRAM 窗口 × 预取深度 × MC 带宽；向量 lanes × commOverlap（τ 按 `B-TAU` 上限，扫描只作灵敏度）；SRAM ↔ 矩阵 ↔ Reduce/TMA/RDMA 的面积再分配。
- **结局**：通过则落盘 `out/coupling/joint_point.json`（唯一全局设计点，带 `x` / `opt` / `model`）与 run record；之后 `design_point.js` 解析出的设计点就是它——L4 的卡在它上面生成，`converge` 在它与基线不一致时拦下。没有可行行时返回 `DIRECTION_BACKFLOW`、回流 `design.req.budget`，原样转交产物的缺口与各域最好点，不调用任何 agent。
- **不负责**：不回放、不改五个域的 winner、不放宽任何合同条目来凑出联合点。

### 参数级细化（Stage B，D 组一格四块）

#### `design.integrate` — 细估能不能站住，粗细估差在哪、归谁
- **业务问题**：这一轮细化到底在算什么（能否复现）？事件与五条守恒是否成立？执行账本是什么？18 个观测位上粗估与细估差多少、差在哪、归谁？
- **什么时候跑**：L3 五个域与 `design.coupling` 之后、`design.converge` 之前；`npm run model:planning`（`stage_b.js`）已生成候选寄存器、详细运行记录、事件回放与观测矩阵。
- **做法**：原 D 组四格（`detail.freeze` / `events` / `execute` / `integrate`）合成一格，四块按序走，任一块不成立就在那一块收场、不进下一块：

| 块 | 业务问题 | 谁参与 |
|---|---|---|
| B0 冻结 | 候选、模型、profile、seed、输入哈希能否复现 | model ∥ memory 专家；冻结清单由脚本逐字转抄 |
| B2 事件与守恒 | tile / 内存事务 / NoC 包 / kernel cycle 事件是什么，五条守恒（字节、FLOP、事务、buffer lifetime、credit）是否成立 | memory ∥ comm ∥ compute，脚本对账，integrator 跨域对账 |
| B3 执行账本 | 调度、软件开销与 PPA / 热 / RAS 合起来是什么 | software ∥ physical → integrator |
| B4 delta 归因 | 18 个观测位上粗估与细估差多少、差在哪、归谁 | integrator → architect（只裁决归不了因的 delta） |

  四块之后 `verifier` 独立验证拟落盘产物，末尾一次 `invariant-checker` 检点整份产物（原来每格一次的中间检点收成这一次，块间对账由脚本做）。块内参与的领域专家是 compute / memory / comm / software / physical / model，固定职能是 integrator / architect / verifier / invariant-checker。
- **产出**：只落一份 `out/detailed/detail_integrate.json`（冻结清单、事件流、执行账本与 18 位合并）与 run record。
- **结局**：检点通过则落盘；缺输入一律 `BLOCKED_CONFIG` + `nextActions`，不静默补全；`LOCAL_DETAIL_FIX` 是本域局部调整即可；`DIRECTION_BACKFLOW` 是问题在方向层；`PPA_DIRECTION_BACKFLOW` 是 PPA 层面的方向问题，走专属回流；`DELTA_UNEXPLAINED` 是粗细估差异无法归因。
- **不负责**：不跑 `stage_b.js`，也不改既有产物；这一格审的是"账是否站得住"，TPS 数字来自脚本。

原来的 B1 `design.detail.workload`（逐层算子账、算术强度、Roofline、sizing 三条比）已按 doc 23 §4 前移为 L1-a 的 `design.req.workload`——它的问题要排在预算切分之前。

### 维度归因（L4，按维度参数化）

#### `design.attribution` — 这个维度的每个参数怎么影响 TPS/usr，谁承重
- **业务问题**：在当前设计点上（`design.coupling` 落盘联合点之后是联合点，之前是已发布设计点；`design_point.js` 解析），片上 SRAM（容量、bank、slice、TMA、KV tile、预取深度、端口扩展）、集合通信（τ、计数口径、RDMA/UCIe/NoC/Reduce、commOverlap、pvMerge）各自动一步，TPS/usr 变多少、面积功耗变多少、盈亏点在哪；未测参数一起取悲观端时缺口落在哪一维（`joint`）。
- **什么时候跑**：`npm run attribution:cards` 生成灵敏度卡之后，每个维度跑一次（`--dimension sram | comm | joint`，互相独立，可并行）。基线变了、或设计点变了（联合点落盘），卡即过期，`run_workflow.js` 拒收过期卡。
- **做法**：数全部来自卡（`integration/detailed/tps_attribution.js` 在详细模型上逐项重放，分类是机械的）→ 每行的 owner 专家（compute / memory / comm / software）只审自己的行：同不同意分类、该参数物理上可信的区间与出处、盈亏点是否落在区间内、先测什么；`software-expert` 另判哪些承重结论依赖软件机制 → `integrator` 合并承重项、富余项、回标计划与冲突 → `invariant-checker` 检点（漏审行、漏列承重行、承重行缺回标计划由脚本机械比对，检点者不能解释掉）。
- **产出**：`out/attribution/reviews/<dimension>_review.json` 与 run record。卡本身是生成物，本格不能落到卡旁边。返回值里任何 `文件:行号` 指向没有文字的行（空行、表格边框、代码围栏）或越界，或专家 `plausibleRange` 里的卡外数字不在其 `rangeEvidence` 所引的行上，主循环不落盘（退出码 7）。审读与合并里的卡外数字由 workflow 脚本比对，修正一次仍不合规即 `INVARIANT_VIOLATED`。
- **结局**：检点通过则落盘审读；专家缺席或输入不足 `BLOCKED_CONFIG`；承重参数的可信区间整体落在预算外时 `DIRECTION_BACKFLOW`。
- **不负责**：不算任何数（卡里没有的数不得出现）、不改卡、不提设计改动（那是域设计格的事）、不判门控。目前只覆盖 K3 / TP32 的详细模型，其他模型无归因。

#### `design.converge` — 这一轮怎么收场
- **业务问题**：细化链走完后，架构是冻结、回到方向层重定，还是证据已够、送评审？
- **前置守卫**：主循环注入 `args.designPoint`（`design_point.js`）。D 组产物是 `stage_b.js` 在基线上算的；设计点是与基线不同的联合点时，D 组审的不是这个点，本格不召集 agent，直接 `BLOCKED_CONFIG`，`nextActions` 指向 ADR + `baseline:sync` 与重跑 Stage B / D 组。
- **收敛判据（L5-b）**：主循环从 `out/governance/gate_status.json#quantificationGate` 原样注入 `args.convergeCriteria`——联合悲观 TPS/usr 是否达标（`attribution` 的 joint 卡）、承重参数是否每行都有 owner / 证据 / 回标计划、观测矩阵是否完整或已登记阻塞。三条由 `evaluate_gates.js` 算，agent 只引用不重判；任一条不成立而 `architect` 仍判 `ARCH_FREEZE`，脚本按自相矛盾拦下（`BLOCKED_CONFIG`，不落盘）。缺 `gate_status.json` 时先跑 `npm run model:planning`。
- **做法**：相关专家（1–3 个，互不可见）回报本域残余缺口 → `framing-critic` 审查"收敛问的是不是该问的" → `gate-keeper` 汇总证据完备性 → `architect` 在 `ARCH_FREEZE` / `DIRECTION_BACKFLOW` / `D_GATE_PROPOSAL` 里裁决 → `invariant-checker` 检点。
- **产出**：`out/detailed/converge_proposal.json`——是**提案**，不是门控结论。
- **不负责**：不改候选寄存器、不写既有产物，门控由脚本算。

### 回流与复核（横切）

#### `design.backflow` — 不达标，退给谁
- **业务问题**：`integrate` 的 delta 归因里，哪些条目其实是方向级问题？该由哪个专家认领？要不要真的动方向？
- **做法**：`integrator` 把归因归纳成可追责条目 → 被归因专家（≤3）只认属于自己的 → `architect` 判该不该动方向，动方向必须给方向级理由 → `framing-critic` 检回流框定，可整体否决。
- **产出**：`out/governance/backflow_proposal.json`。没有归因就没有回流，直接返回 `DIRECTION_BACKFLOW_NOOP` 和 `nextActions`，不假装跑一轮。
- **不负责**：它给回流提案，不直接修改 Gate，也不改方向。

#### `design.verify` — 这份产物能不能独立站住
- **业务问题**：只看**已落盘**的产物，它能不能被一个没参与设计的人复现和接受？
- **做法**：7 类检查各一个互不可见的 `verifier` 实例（`V-SCHEMA` 单位、`V-CONSERVATION` 七类守恒、`V-PROVENANCE`、`V-PROFILE` MC320/MC640 与 peak/sustained 分离、`V-MATRIX` 回归矩阵、`V-REPLAY` 可回放、`V-SYNTHETIC` 合成数据不得签核）→ `gate-keeper` 核证据完备性 → `architect` 签署送审或回流意见。
- **产出**：`out/verification/verify_report.json`。
- **不负责**：不接收设计过程的申报、候选或草稿——读了它们就不再独立。

#### `design.audit` — 支撑它的证据链和口径是否自洽
- **业务问题**：结论的出处是否真能推出结论？同一个量在别处是否用了另一个口径？算术、覆盖度有没有漏？
- **做法**：4 个视角（证据链 / 依据一致性 / 算术 / 覆盖度）各一个 `verifier` 实例 → 1 个实例汇总，汇总不产生新结论。可选地给 `args.premises` 找一份公开资料参照系（非证据，不进 `out/` 的检查结论）。
- **产出**：`out/verification/audit_report.json`；参照系写 `references/external/`。
- **与 `verify` 的分工**：`verify` 查**个体**（这份产物对不对），`audit` 查**关系**（它和它的依据、和别处的口径对不对）。

### 例外与准备

#### `design.explore` — 受控的自由探索
- **业务问题**：走一遍正规 workflow 不值得，但确实想自由问一次"这个域通常怎么做"。
- **规则**：单实例、无并行、无检点、无门控；**只写 `scratch/explore_<runId>.md`**，不得写 `out/`、不得进 ledger、不得作为任何结论的证据。这是例外通道，不是捷径。

#### `design.learn` — 一次性沉淀外部方案
- **业务问题**：各领域的 SOTA 与经典方案是什么，让后续专家有参照系？
- **规则**：按学习单元联网调研，产出 `references/sota/` 知识卡，剔除无来源条目；知识不是证据，不进 ledger，只在领域专家实例的 prompt 里作参照。不参与常规阶段链，刷新用 `args.units`。

## 3. 容易混淆的几对

| 对比 | 区别 |
|---|---|
| `arch.direction` 的"选"与"凑证据" | 同一格的前后两段：先**选**（比较候选、留下 ≤3 个），再**凑证据**（一个 `gate-keeper` 把 8 条门槛逐条核对齐不齐）；两段都不判门，D-Gate 由 `evaluate_gates.js` 算 |
| `contract` vs `converge` | `contract` 管**接口**（各域对外承诺）；`converge` 管**这一轮的结局**（冻结 / 回流 / 送评审） |
| `verify` vs `audit` | `verify` 查产物个体；`audit` 查依据与口径的关系；两者都只读已落盘产物 |
| `backflow` vs 各格的 `DIRECTION_BACKFLOW` 裁决 | 裁决是某一格里专家或架构师说"这是方向问题"；`backflow` 是把 delta 归因整体转成方向级回流提案的独立一格 |
| C 组 winner vs D 组细化 | C 组在**设计空间**里选点（确定性搜索）；D 组对选定的点做**逐算子、逐事件**的细估与对账 |
| `intake` vs `explore` | `intake` 产出会被下游引用的 brief，必须过 `framing-critic`；`explore` 的产物没有人可以引用 |

## 4. 怎么选：我该跑哪一格

| 我想知道 / 想做 | 跑这一格 |
|---|---|
| 需求或预算变了，要重新下发约束 | `intake` |
| 想知道每 token 要干多少活、谁吃算力谁吃带宽 | `npm run workload:requirements`，再 `req.workload` |
| 达到目标要多少带宽、多少算力、τ 最多多大，选一份预算切分 | `npm run budget:frontier`，再 `req.budget` |
| 域间接口要改 | `contract` |
| 要重新比较架构路线 | `arch.direction` |
| 想看某个硬件域的设计点怎么选 | 对应的 `compute` / `sram` / `mc` / `comm` / `physical` |
| SRAM、集合通信等某个维度怎么影响 TPS/usr，哪些参数承重 | `npm run attribution:cards`，再 `attribution --dimension sram`（或 `comm` / `joint`） |
| 方向已定，想验证细估能不能站住 | `npm run model:planning`，再 `integrate`，再 `converge` |
| 细估和粗估对不上 | 先 `integrate` 的 delta 归因，再 `backflow` |
| 想让外人复核结论 | `verify`，再 `audit` |
| 只是想自己问一下 | `explore` |

## 5. 在哪里运行、现状

在 Claude Code 里原生运行；在 Cursor 或终端里用 `npm run workflow:run -- <workflow> --backend claude|cursor|mock`（默认 dry run，加 `--land` 才落盘），
详见 [`README.md`](README.md) 的“在哪里运行”。

这 19 个 workflow 目前经过结构测试、C 组与 `design.coupling` 的 mock runtime 行为测试，以及运行时与驱动器的单元/回归测试（后端用假 CLI、假 SDK）；
**尚未用真实模型端到端运行过**。产出路径以脚本里的 `path:` 为准；本文与脚本冲突时以脚本为准。
