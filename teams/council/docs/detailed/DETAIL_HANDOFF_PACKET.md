# Detailed Handoff Packet

```json
{
  "schemaVersion": "detailed-handoff-v0.1",
  "runId": "",
  "stage": "quantification",
  "workPackage": "B0|B1|B2|B3|B4|B5",
  "agentId": "Q1|Q2|Q3|Q4|Q5|Q6|Q7|Q8|Q9|A0",
  "candidateId": "",
  "modelId": "",
  "phase": "decode|prefill|both",
  "tp": 0,
  "cp": 0,
  "ep": 0,
  "physicalProfile": "P0|P1",
  "mcProfile": "MC320|MC640",
  "manifestHash": "",
  "inputHashes": {},
  "outputs": [],
  "assumptions": [],
  "constraintsChecked": [],
  "confidence": "E0|E1|E2|E3",
  "status": "",
  "blockers": [],
  "feedback": {
    "type": "NONE|LOCAL_DETAIL_FIX|DIRECTION_BACKFLOW|PPA_DIRECTION_BACKFLOW|BLOCKED_CONFIG|PERFORMANCE_MISS",
    "destination": "",
    "requiresAdr": false
  },
  "nextActions": []
}
```

## Handoff rules

1. 下游 agent 只能消费已提交、已版本化的 packet。
2. 任何算子、tile、packet、cycle 结果必须保留 `operator_id` 和 `manifest_hash`。
3. 发现架构方向变化时，不在当前 work package 内静默修 profile，必须生成 feedback packet 并交给 A0。
4. 生成的 JSON、trace 和报告必须由 runner 重建，不能手工改 snapshot。
