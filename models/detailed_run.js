'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relativePath => JSON.parse(
  fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^\uFEFF/, '')
);

const score = read('data/direction/directional_tps_scorecard.json');
const profiles = read('data/workload/model_profiles.json');

const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const reportDate = timestamp.slice(0, 8);
const runId = `stage-b-${timestamp}`;
const selected = [
  'P0-7R-balanced-MC320-TP8',
  'P0-7R-balanced-MC320-TP16',
  'P0-7R-balanced-MC320-TP32'
];

const candidateById = new Map(score.candidates.map(candidate => [
  `${candidate.candidateId}:${candidate.modelId}`,
  candidate
]));

const opTemplates = {
  K3: [
    ['dense_projection', 'L', 4.0e12, 1.07e12, 'weight'],
    ['routed_moe', 'L', 18.0e12, 4.79e12, 'expert'],
    ['attention', 'H', 6.0e12, 1.90e12, 'kv_state'],
    ['kda_state', 'V', 0.8e12, 0.35e12, 'kv_state'],
    ['collective_reduce', 'REDUCE', 0.2e12, 0.08e12, 'collective']
  ],
  'GLM-5.2': [
    ['dense_projection', 'L', 4.5e12, 1.20e12, 'weight'],
    ['routed_moe', 'L', 22.0e12, 5.86e12, 'expert'],
    ['indexer', 'INDEXER', 2.0e12, 0.60e12, 'index'],
    ['sparse_attention', 'H', 5.0e12, 1.65e12, 'kv_state'],
    ['collective_dispatch', 'REDUCE', 0.3e12, 0.12e12, 'collective']
  ],
  'DeepSeek-V4-Pro': [
    ['dense_projection', 'L', 5.2e12, 1.39e12, 'weight'],
    ['routed_moe', 'L', 25.0e12, 6.83e12, 'expert'],
    ['indexer', 'INDEXER', 3.0e12, 0.85e12, 'index'],
    ['sparse_attention', 'H', 7.0e12, 2.30e12, 'kv_state'],
    ['expert_dispatch', 'REDUCE', 0.5e12, 0.20e12, 'collective']
  ]
};

const available = {
  L: 176.9472e12,
  H: 176.9472e12,
  V: 9.8304e12,
  INDEXER: 9.8304e12,
  REDUCE: 9.8304e12
};

const rows = [];
const blocked = [];

for (const model of profiles.profiles) {
  for (const tp of [8, 16, 32]) {
    const candidateId = `P0-7R-balanced-MC320-TP${tp}`;
    const base = candidateById.get(`${candidateId}:${model.id}`);
    const formal = model.id === 'K3';

    if (!formal) {
      blocked.push({
        runId,
        stage: 'quantification',
        agentId: 'Q1',
        candidateId,
        modelId: model.id,
        tp,
        physicalProfile: 'P0',
        mcProfile: 'MC320',
        status: 'BLOCKED_CONFIG',
        confidence: 'E0',
        reason: 'formal layer/dtype/expert manifest is not frozen'
      });
      continue;
    }

    for (const [operatorId, core, flops, bytes, byteClass] of opTemplates[model.id]) {
      const shardFlops = flops / tp;
      const shardBytes = bytes / tp;
      const intensity = shardFlops / shardBytes;
      const bw = byteClass === 'collective' ? 0.8e12 : 3.584e12;
      const ridge = available[core] / bw;
      const roof = Math.min(available[core], intensity * bw);
      const required = shardFlops * 1000;
      const requiredPeak = required / (0.6 * 0.85);

      rows.push({
        runId,
        stage: 'quantification',
        agentId: 'Q2',
        sourceDirectionalCandidateStatus: base ? base.status : 'MISSING_DIRECTIONAL_CANDIDATE',
        candidateId,
        modelId: model.id,
        phase: 'decode',
        tp,
        cp: 1,
        ep: 1,
        physicalProfile: 'P0',
        mcProfile: 'MC320',
        operatorId,
        operatorClass: operatorId,
        coreClass: core,
        flops: shardFlops,
        bytes: {[byteClass]: shardBytes, total: shardBytes},
        arithmeticIntensity: intensity,
        networkIntensity: byteClass === 'collective' ? shardFlops / (shardBytes * 1.25) : intensity,
        ridgePoint: ridge,
        rooflineBound: roof < intensity * bw ? 'compute' : 'bandwidth',
        rooflinePerformance: roof,
        requiredEffectiveFlops: required,
        requiredPeakFlops: requiredPeak,
        availablePeakFlops: available[core],
        requiredToAvailableRatio: requiredPeak / available[core],
        confidence: 'E1',
        status: 'PLANNING_ESTIMATE',
        assumptions: [
          'K3 operator figures are directional planning values pending formal layer manifest',
          'MC320 sustained bandwidth is a directional baseline assumption',
          'utilization=0.6 and duty_cycle=0.85 are explicit sizing assumptions'
        ]
      });
    }
  }
}

const byModel = {};
for (const row of rows) (byModel[row.modelId] ??= []).push(row);

const summary = Object.entries(byModel).map(([modelId, modelRows]) => {
  const max = modelRows.reduce(
    (worst, row) => row.requiredToAvailableRatio > worst.requiredToAvailableRatio ? row : worst,
    modelRows[0]
  );
  return {
    modelId,
    operatorCount: modelRows.length,
    maxRequiredToAvailableRatio: max.requiredToAvailableRatio,
    worstOperator: max.operatorId,
    worstCore: max.coreClass,
    status: 'PLANNING_ESTIMATE',
    confidence: 'E1'
  };
});

const out = {
  schemaVersion: 'detailed-architecture-run-v0.1',
  runId,
  stage: 'quantification',
  agentId: 'Q1-Q9',
  sourceDirectionalRunId: score.runId,
  selectedCandidates: selected,
  manifestStatus: {
    K3: 'PLANNING_MANIFEST',
    'GLM-5.2': 'BLOCKED_CONFIG',
    'DeepSeek-V4-Pro': 'BLOCKED_CONFIG'
  },
  operatorLedger: rows,
  blockedCases: blocked,
  summary,
  sizing: {
    availablePeakFlops: available,
    utilizationAssumption: 0.6,
    dutyCycleAssumption: 0.85,
    targetTpsPerUser: 1000
  },
  qGate: {
    manifestCompleteOrBlocked: true,
    tp8Tp16Tp32Executable: true,
    sharedManifestAcrossRooflineAndReplay: false,
    p0P1Separated: true,
    mc320Mc640Separated: true,
    provenanceComplete: true,
    decision: 'BLOCKED_BY_MANIFEST_AND_EVENT_MODEL'
  },
  assumptions: [
    'This is the first detailed-stage dry run, not final silicon performance.',
    'K3 uses a planning operator ledger because its formal layer/dtype manifest is not frozen.',
    'GLM-5.2 and DeepSeek-V4-Pro remain blocked.',
    'Q3-Q7 event models are not yet implemented; Q8 fine TPS is not emitted.'
  ],
  nextActions: [
    'Q1 freeze formal manifests',
    'Q3 generate tile/memory events',
    'Q4 generate packet/collective events',
    'Q5 generate kernel cycles',
    'Q6 generate schedule events',
    'Q7 generate PPA',
    'Q8 only after Q1-Q7'
  ]
};

function fmt(value, digits = 2) {
  return Number(value).toFixed(digits);
}

function tf(value, digits = 1) {
  return fmt(value / 1e12, digits);
}

function buildReport(result) {
  const k3Rows = result.operatorLedger.filter(row => row.modelId === 'K3');
  const summaryRows = result.summary.map(item =>
    `| ${item.modelId} | ${item.operatorCount} | ${fmt(item.maxRequiredToAvailableRatio, 2)} | ${item.worstOperator} | ${item.worstCore} | ${item.status} | ${item.confidence} |`
  ).join('\n');
  const ledgerRows = k3Rows.map(row =>
    `| TP${row.tp} | ${row.operatorId} | ${row.coreClass} | ${fmt(row.arithmeticIntensity, 2)} | ${fmt(row.ridgePoint, 2)} | ${row.rooflineBound} | ${tf(row.requiredPeakFlops)} | ${tf(row.availablePeakFlops)} | ${fmt(row.requiredToAvailableRatio, 2)} | ${row.status} |`
  ).join('\n');
  const blockedRows = result.blockedCases.map(item =>
    `| ${item.modelId} | TP${item.tp} | ${item.physicalProfile} | ${item.mcProfile} | ${item.status} | ${item.confidence} | ${item.reason} |`
  ).join('\n');

  return `# Stage B Detailed Architecture Dry Run Report\n\nRun date: 2026-09-21  \\\nRun ID: \`${result.runId}\`  \\\nSource Stage A Run ID: \`${result.sourceDirectionalRunId}\`  \\\nStatus: \`QUANTIFICATION_DRY_RUN / Q-GATE BLOCKED\`\n\n## 1. Flow executed in this run\n\n\`\`\`text\nQ1 manifest status check\n  -> Q2 operator arithmetic ledger / Roofline / sizing\n  -> Q3 tile + memory event model placeholder check\n  -> Q4 packet + collective event model placeholder check\n  -> Q5 kernel cycle model placeholder check\n  -> Q6 schedule and overlap placeholder check\n  -> Q7 PPA placeholder check\n  -> Q8 fine TPS gate check\n  -> Q9 Q-Gate review\n\`\`\`\n\nThis run completes only the executable Q1/Q2 dry-run path. Q3-Q7 event-level models are not implemented yet, so Q8 does not emit a signed-off fine TPS result.\n\n## 2. Inputs and candidate scope\n\nMachine-readable inputs:\n\n\`\`\`text\ndata/direction/directional_tps_scorecard.json\ndata/workload/model_profiles.json\n\`\`\`\n\nSelected Stage A candidates for P0 + MC320 TP sweep:\n\n\`\`\`text\n${result.selectedCandidates.join('\n')}\n\`\`\`\n\nScope constraints:\n\n| Dimension | Setting | Meaning |\n|---|---|---|\n| Physical profile | P0 | 7-reticle balanced baseline; do not extrapolate from P1 compact |\n| Memory profile | MC320 | Manufacturing baseline; do not use MC640 stretch as default |\n| TP | 8 / 16 / 32 | Compare TP scaling under the same P0/MC320 envelope |\n| Target TPS/usr | ${result.sizing.targetTpsPerUser} | Q2 required peak sizing target |\n| Utilization | ${result.sizing.utilizationAssumption} | Planning assumption |\n| Duty cycle | ${result.sizing.dutyCycleAssumption} | Planning assumption |\n\n## 3. Manifest status\n\n| Model | Current status | Handling in this run |\n|---|---|---|\n| K3 | ${result.manifestStatus.K3} | Generate a planning operator ledger; do not treat it as a frozen manifest |\n| GLM-5.2 | ${result.manifestStatus['GLM-5.2']} | Keep blocked; do not emit fake operator-level conclusions |\n| DeepSeek-V4-Pro | ${result.manifestStatus['DeepSeek-V4-Pro']} | Keep blocked; do not emit fake operator-level conclusions |\n\n## 4. K3 Q2 arithmetic intensity, Roofline and compute sizing\n\n| TP | Operator | Core | AI FLOP/B | Ridge FLOP/B | Roofline bound | Required peak TFLOP/s | Available peak TFLOP/s | Req/Avail | Status |\n|---|---|---|---:|---:|---|---:|---:|---:|---|\n${ledgerRows}\n\n### Key observation\n\n| Model | Operator count | Max Req/Avail | Worst operator | Worst core | Status | Confidence |\n|---|---:|---:|---|---|---|---|\n${summaryRows}\n\nThe current K3 planning ledger has max required-to-available ratio \`${fmt(result.summary[0].maxRequiredToAvailableRatio, 2)}\`. The worst operator is \`${result.summary[0].worstOperator}\` on core class \`${result.summary[0].worstCore}\`. This indicates a sizing risk between the directional K3 routed-MoE workload constants and the P0 L-Core envelope. It is a planning risk signal, not a final silicon sign-off conclusion.\n\n## 5. GLM-5.2 / DeepSeek-V4-Pro blocked cases\n\n| Model | TP | Physical | MC | Status | Confidence | Reason |\n|---|---|---|---|---|---|---|\n${blockedRows}\n\nBlocking rule: without a formal layer/dtype/expert manifest, the flow does not invent an operator ledger and does not emit fine-grained TPS.\n\n## 6. P0/P1 and MC320/MC640 isolation status\n\n| Check | Status | Note |\n|---|---|---|\n| P0/P1 separated | ${result.qGate.p0P1Separated ? 'PASS' : 'FAIL'} | This run uses P0 only and does not extrapolate P1 compact results to P0 |\n| MC320/MC640 separated | ${result.qGate.mc320Mc640Separated ? 'PASS' : 'FAIL'} | This run uses MC320 baseline only and does not treat MC640 stretch as default |\n| TP8/TP16/TP32 executable | ${result.qGate.tp8Tp16Tp32Executable ? 'PASS' : 'FAIL'} | K3 emits Q2 ledgers for TP8, TP16 and TP32 |\n| Shared manifest for Roofline/replay | ${result.qGate.sharedManifestAcrossRooflineAndReplay ? 'PASS' : 'BLOCKED'} | Q3-Q7 do not yet share one event manifest |\n\n## 7. Q-Gate conclusion\n\nCurrent Q-Gate decision:\n\n\`\`\`text\n${result.qGate.decision}\n\`\`\`\n\nPassed checks:\n\n- P0/P1 and MC320/MC640 dimensions are explicitly isolated.\n- K3 TP8/TP16/TP32 Q2 planning ledgers are executable.\n- GLM-5.2 and DeepSeek-V4-Pro unfrozen configs are explicitly blocked.\n\nBlocking checks:\n\n- K3 formal manifest is still not frozen.\n- GLM-5.2 and DeepSeek-V4-Pro lack formal layer/dtype/expert manifests.\n- Q3 tile/memory events, Q4 collective packet events, Q5 kernel cycles, Q6 scheduler/overlap and Q7 PPA are not implemented.\n- Q8 fine TPS must not be emitted yet.\n\n## 8. Next detailed-design agent work\n\n| Agent | Next output | Unlocks |\n|---|---|---|\n| Q1 Manifest Agent | Three-model formal manifest | Full three-model Q2 ledger |\n| Q3 Memory/Event Agent | Tile, SRAM and HBM/MC event stream | Memory replay and SRAM-hit analysis |\n| Q4 Network Agent | Packet, VC, credit and collective event stream | TP/EP communication latency and overlap |\n| Q5 Kernel Agent | Per-kernel cycle model | Operator latency |\n| Q6 Scheduler Agent | Stream schedule, fusion and overlap policy | End-to-end token latency |\n| Q7 PPA Agent | Area/power/timing budget reconciliation | Implementability check |\n| Q8 TPS Agent | Fine TPS/usr scorecard | Only after Q1-Q7 provenance closure |\n| Q9 Review Agent | Q-Gate decision | Detailed sign-off or blocked state |\n\n## 9. Run artifacts\n\n\`\`\`text\nmodels/detailed_run.js\ndata/detailed/detailed_architecture_run.json\nreports/detailed/stage_b_detailed_run_${reportDate}.md\n\`\`\`\n`;
}

fs.mkdirSync(path.join(root, 'data/detailed'), {recursive: true});
fs.writeFileSync(
  path.join(root, 'data/detailed/detailed_architecture_run.json'),
  `${JSON.stringify(out, null, 2)}\n`
);

fs.mkdirSync(path.join(root, 'reports/detailed'), {recursive: true});
fs.writeFileSync(
  path.join(root, 'reports/detailed', `stage_b_detailed_run_${reportDate}.md`),
  buildReport(out)
);

console.log(JSON.stringify({
  runId,
  rows: rows.length,
  blocked: blocked.length,
  report: `reports/detailed/stage_b_detailed_run_${reportDate}.md`,
  summary,
  qGate: out.qGate
}, null, 2));
