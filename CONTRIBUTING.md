# Contributing

## Branches

建议使用以下分支命名：

```text
arch/<module>-<topic>
model/<module>-<topic>
verify/<test-or-invariant>
docs/<topic>
agent/<short-task>
```

不要直接向 `main` 推送。每个 PR 只解决一个主题，并明确 owner、依赖和验证结果。

## PR checklist

- [ ] 说明目标、范围和非目标。
- [ ] 说明修改了哪个团队目录或 `integration/` 子目录。
- [ ] 如果修改公共契约，已更新设计文档和 ADR。
- [ ] 没有混入生成物、临时文件、私有路径或秘密。
- [ ] 运行 `npm test`（含 `npm run check:structure` 的团队依赖规则）。
- [ ] 性能变化给出基线、seed、单位和原因。
- [ ] 面积/功耗/带宽变化给出假设和余量影响。
- [ ] 对 blocker/open issue 更新 owner、证据或状态。

## Reproducibility

搜索和报告结果应由脚本生成。提交结果时记录：

- Node.js 版本；
- 命令行；
- seed 和搜索规模；
- 输入文件或 manifest 版本；
- 关键输出摘要；
- 是否改变了 `out/` 中的生成物或 `teams/*/inputs/` 中的基线。

## Generated files

`out/` 中的文件都是生成物，由 `integration/pipelines/` 中的脚本写出，不手工编辑（例外见 `out/README.md`）。`teams/*/inputs/` 是输入；其中 `teams/hardware/inputs/k3_mc_baseline.json` 的模型推导字段由 `npm run baseline:sync` 重写。若要更新生成物或 baseline：

1. 在 PR 描述中说明原因；
2. 同时提交生成脚本或输入模型变化；
3. 运行完整测试；
4. 让 reviewer 检查 TPS、时间、字节、容量和物理约束的差异。
