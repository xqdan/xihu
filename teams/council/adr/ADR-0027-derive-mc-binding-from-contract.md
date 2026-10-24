# ADR-0027：简报的内存档位绑定由合同推导，HBM3E 槽位成为设计绑定档；纠正对 ADR-0021 的误引

- 日期：2026-10-23
- 状态：`ACCEPTED`（决策）；**其中 1152 GB/s 这个数值仍是 `ASSUMPTION`，B-002 仍为 `OPEN`**
- 修订：ADR-0019 第 3 条的**适用范围**（制造口径不变，只是不再用它决定简报绑定哪个档）；ADR-0026 的状态由 `PROPOSED` 转 `ACCEPTED`
- 纠正：下游文件把"MC320 是唯一可制造默认、MC640 只能是 stretch"引为 ADR-0021 的内容，但 ADR-0021 没有这句话（见「规则的真实出处」）
- 关闭：`design.arch.direction` 的 `INVARIANT_VIOLATED` 结构性根因

## 背景

ADR-0026 落地后 `design.arch.direction` 仍判 `INVARIANT_VIOLATED`。ADR-0026 把它记为「未解决」，理由是「简报绑定 MC320，而达标只有 stretch 槽位」这个矛盾**没有被消除，只是 stretch 槽位的数值变了**。

这一轮把根因追到了具体字段。

### 根因：简报自相矛盾，任务书无解

`make_brief.js` 生成的任务书同时含两个数：

| 字段 | 值 | 来源 |
|---|---:|---|
| `budget.bandwidthGBs` | **2304** | `B-MEM-BW.min` 1152 × `memoryCubesPerComputeDie` 2 |
| `profileBinding.mcProfile` | `MC320` | 手写常量（第 214 行） |

`MC320` 每颗 320 GB/s，每 Die 2 颗 = **640 GB/s**。任务书要求设计一个 2304 GB/s 的内存系统，同时指定内存部件只有 640 GB/s。**这个任务书在任何搜索下都不可完成**——`INVARIANT_VIOLATED` 不是搜索失败，而是任务书自身的矛盾。

### 这不是"默认 split 选得不好"

把合同前沿的四个 split 逐个代入（每 Die 2 颗）：

| split | `B-MEM-BW.min` | 每 cube 需求 | 网格上最低满足档 | MC320 是否满足 |
|---|---:|---:|---:|---|
| S-TAU | 1152 | 576.000 | 1152 | 否 |
| S-CMP（默认） | 1152 | 576.000 | 1152 | 否 |
| S-BW | 755.009 | 377.505 | 400 | 否 |
| S-BAL | 935.120 | 467.560 | 480 | 否 |

**四个 split 全部超出 MC320 的能力。** 换任何一个 split 都不解决，所以修法不能是"换默认 split"。

### 代价已经可以量化

当前打分卡（`out/direction/directional_tps_scorecard.json`，目标 1000 TPS/usr）：

| 档位 | 达标行 / 总行 | K3 TP32 | 说明 |
|---|---:|---:|---|
| MC320 | 2 / 9 | 423.84 | 达标的两行是 GLM-5.2 / DeepSeek-V4-Pro TP32，且都是 `UNCORROBORATED` 外推；K3 全档不达标 |
| MC640（1152） | 7 / 9 | 1157.69 | 未达标的两行是 K3 TP8 / TP16 |

详细模型在 MC320 上是 579.53 TPS/usr（架构门 1050 的 55.2%）。**在所有档位上，只有 1152 这一档让 K3 达标**。

## 规则的真实出处

"MC320 是唯一可制造默认、MC640 只能是 stretch"这条规则一直被引作 ADR-0021 的内容（`brief_intents.json` 的 `C-SPEC-SINGLE`、`make_brief.js` 的注释、`23` 号提案、两份 README）。核对 ADR-0021 全文：

- 它**没有**这句话；
- 它第 2 条写的是"正式候选为 `P1-compact-MC640-TP32`，MC320 参考为 `P1-compact-MC320-TP32`"——**MC640 本来就是正式候选**；
- 能找到的最接近的依据是 ADR-0019 第 3 条："560 与 640 只能标为 STRETCH/AGGRESSIVE，供应商证据闭合前不得作为制造默认值"。它约束的是**制造口径**，没有说简报该绑定哪个档。

所以这条规则是引用链把"制造口径"放大成了"绑定规则"。本 ADR 不是推翻 ADR-0021 的某个条款，而是纠正这次放大，并让简报的绑定重新与 ADR-0021 第 2 条一致。

## 决策

1. **简报的内存绑定由合同推导，不再手写常量。**
   `profileBinding.mcProfile` 取 `B-MEM-BW.min / memoryCubesPerComputeDie` 之后、`bandwidthTiers` 网格上**最低的、能满足它的档位**所对应的 profile。
2. **推导结果无法被任何 profile 满足时，生成简报失败并报错。** 不允许静默回落到某个默认档——那正是本 ADR 要消除的失效方式。
3. **`MC320` 不再是默认绑定。** 它保留在矩阵里作为参考档（18 行观测矩阵、敏感度扫描、ADR-0019 的 `REFERENCE` 定位都不变），但不再是可以被默认绑定的档位。
4. **`MC640` 槽位成为设计绑定档。** 它在 `resource_profiles.js` 里的 `classification` 由 `stretch_not_manufacturing_default` 改为 `binding_tier_assumption`；`MC320` 由 `baseline_reference` 改为 `reference_tier`。
5. **绑定不等于可制造承诺。** `AC-2` 原文不变：判据所用的 MC 带宽必须是可制造规格，不得使用 MC640 槽位的搜索假设（1152 GB/s）。因此：
   - `B-002` 仍为 `OPEN`；
   - 1152 GB/s 仍是 `ASSUMPTION`（9.0 Gb/s × 1024 bit ÷ 8，引脚速率换算，未对照供应商规格）；
   - 活文档里"MC640 是 stretch / 不能冒充可制造默认"这类句子要**改写口径**，而不是删掉。
6. **ADR-0026 由 `PROPOSED` 转 `ACCEPTED`。** HBM3E 的 16 栈 / 1152 GB/s / 3200 W 三项随本 ADR 一并采纳；其第 9 条（`mcPjPerBit`、`mcBaseW` 仍是 MC 时代假设）继续有效。

## 为什么是"推导"而不是"把默认值改成 MC640"

两者都能消掉当前的 `INVARIANT_VIOLATED`。选推导的理由：

- 手写常量与合同是两个数源，**它们会再次漂移**。那条规则的出发点（"合同可能要求 stretch 档，不能让 stretch 档自称可制造"）本身是对的，错的是应对方式——用"永远绑参考档"来回避，结果任务书变成无解。该担心由 `AC-2` 和 B-002 承担，不该由绑定哪个档来承担。
- 推导把"绑定档必须满足合同"变成一条**不变量**，任何未来的 split 变化都自动被它检查，而不是靠人记得同步两个数。

## 已知代价：profile 枚举的粒度不够

`bandwidthTiers` 有 5 个档（320 / 400 / 480 / 560 / 1152），但 `mcProfile` 枚举只有 2 个值（`MC320` / `MC640`）。于是：

| split | 合同每 cube 需求 | 推导应得档 | 实际绑定档 | 超配 |
|---|---:|---:|---:|---:|
| S-BW | 377.505 | 400 | 1152 | **3.05×** |
| S-BAL | 467.560 | 480 | 1152 | **2.40×** |
| S-TAU / S-CMP | 576.000 | 1152 | 1152 | 1.00× |

对 S-BW / S-BAL，推导会把需求粗化到 1152。这不是推导逻辑的错误，是枚举表达力的缺口：400 和 480 两档在网格里存在（`GRID` / `DEFAULT_SEARCH_CAP`），却无法作为 profile 被绑定。

超配的代价是真实的：ADR-0026 记录 MC 从 640 → 1152 换来 +2.1% 名义 TPS、付出卡功耗 +287 W。**所以本 ADR 没有让 S-BW / S-BAL 的绑定变得"正确"，只是让它不再自相矛盾。** 补齐枚举粒度是独立的变更（见「未解决」）。

## 后果

### 改动的字段

| 位置 | 改前 | 改后 |
|---|---|---|
| `integration/pipelines/make_brief.js` | `mcProfile: binding.mcProfile \|\| 'MC320'` | 由 `B-MEM-BW.min` 推导；不可满足则抛错 |
| `integration/orchestration/design.intake.workflow.js` | `MC_PROFILE = args.mcProfile \|\| 'MC320'` | 同一推导（缺参数时） |
| `teams/council/inputs/design_brief.schema.json` | 枚举 `MC320` / `MC640` | **不变**（见「未解决」） |
| `teams/council/inputs/design_brief.m2.json` | `"mcProfile": "MC320"` | `"MC640"`（手写快照，与合同一致） |
| `teams/hardware/src/resource_profiles.js` | 两个 `classification` 字符串 | `reference_tier` / `binding_tier_assumption` |
| `integration/planning/directional_envelope.js` | 硬编码同样两个字符串 | 从 `mcProfiles` 读取，不再各写一份 |
| `teams/council/inputs/brief_intents.json` | `C-SPEC-SINGLE` 与四条禁语禁止"用 MC640 数字冒充可制造默认" | 改为禁止"绑定档超出合同需求"与"把绑定档写成可制造承诺" |

### 不变的东西

- 发布点 1138.48 TPS/usr、raw 750.74 µs、Die 361.68 mm² / 292.48 W **全部不变**。本 ADR 只改"绑定哪个档位"的规则，不改发布点。
- 18 行观测矩阵仍是 MC320 / MC640 两档，`UNCORROBORATED` 槽位仍然是外推。
- `B-002` 仍为 `OPEN`；`AC-1`（联合悲观点 ≥ 1000）仍未通过（926.52）。
- 详细模型的乐观程度没有变：K3 在 1152 上的 1138.48 仍依赖 `matrixUtil` 等未测量参数，最薄的一项仍是矩阵利用率。

### 测试

- `test_brief_and_ledger.js`：断言绑定是 `'MC320'` 改为断言"绑定档满足合同、且不是从合同 point 硬抄"。原断言的前提（参考档一定够用）已被证伪。
- `test_workflow_driver.js`：同上。
- 新增：任一 split 下推导出的绑定档都必须满足 `payloadGBsPerCube × cubesPerDie ≥ B-MEM-BW.min`。

## 端到端验证（2026-10-23）

用仓库自己的 driver 跑了一次真实的 `design.arch.direction`（`node integration/pipelines/run_workflow.js arch.direction --backend claude`，16 个 agent 调用，约 3 小时，dry-run 未落盘），这是本 ADR 写完后唯一能回答"`INVARIANT_VIOLATED` 还在不在"的证据。

**结果：仍然是 `INVARIANT_VIOLATED`，但 10 条违规里没有一条是本 ADR 要解决的那个矛盾。**

- 简报现在绑定 `MC640`、预算 2304 GB/s，两者一致；"绑定 320 GB/s 部件、要求 2304 GB/s 系统"的自相矛盾不再出现。
- 新暴露的 10 条属于另一批问题。逐条人工复核后分成三类：

| 类别 | 条目 | 核实结论 |
|---|---|---|
| 真缺陷，已登记 | 6-Die 形态行与"8 Die/package"冲突 | O-021（改动前即存在） |
| 真缺陷，已登记 | `directional_resource_envelope.json` 缺 provenance 块 | O-022（改动前即存在） |
| 真缺陷，已登记 | `payloadTBs` 实为 raw 值、`mcStretchGBsPerCube` 命名过时 | O-023 |
| **误判** | memory lane 未乘 sustained 0.7 | 错。实测 `laneTimes` 用 12.9024 TB/s 有效带宽，4.810 GB ÷ 12.9024 TB/s = 372.83 µs，与产物一致 |
| **误判** | `L4H4S16` 的 id 与 axes 互斥 | 错。该 id 编码的是 L/H local MiB 与 shared MiB，不是 core 数；全表 10 行都守此约定 |
| 模型简化，非矛盾 | 两行面积相同而 SRAM 划分不同 | 两者 `totalSramMiBPerDie` 都是 56，面积模型只吃总量 |
| 本 ADR 引入，已修 | 产物 `sourceCommit` 记为 `ddf8599` 而内容只在 `3c322ac` 成立 | 重算前先提交造成的；已在 `3c322ac` 上重算，pin 随产物自动跟到 `3c322ac` |

**这次验证本身也有一个教训**：invariant-checker 是 LLM，它给出的违规必须逐条复核再采信——10 条里至少 2 条是误判，而且误判的方式（把 raw 字段名当成计算口径）正是 O-023 登记的那个命名缺陷诱导出来的。引用它的结论而不复核，会把"命名歧义"升级成"模型算错"。

## 未解决

1. **profile 枚举粒度。** 只有 2 个 profile 而网格有 5 档，导致 S-BW / S-BAL 粗化到 1152（超配 3.05× / 2.40×）。补齐需要把 `MC400` / `MC480` 加进枚举，连带 18 行观测矩阵、`stage_a`/`stage_b` 的档位循环、schema 和若干测试。这是独立的变更，本 ADR 不做。
2. **`B-002` 仍是 blocker。** 1152 GB/s 没有供应商数据；本 ADR 采纳的是"设计绑定档"，不是"可制造规格"。`AC-2` 的关闭条件没有变。
3. **超配的功耗代价没有被重新评估。** 若未来某 split 只需 400 GB/s，绑定 1152 会多付约 229 W（ADR-0026 的同一公式），而当前没有任何检查阻止这件事。
4. **推导只保证"不小于"，不保证"够用"。** 合同给出的是最低需求；绑定档满足它不等于该档在这一 split 上能达到 1000 TPS/usr（K3 TP8 在 1152 上仍是 381.46）。
