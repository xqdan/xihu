'use strict';
/* Execution trace of one decode step (integration/detailed/execution_trace.js; ARCH-TR-01, HW-TR-01,
 * ARCH-TR-02 of teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md). Evidence class MODEL.
 *
 * Run:
 *   node integration/pipelines/generate_execution_trace.js            (npm run trace:published)
 *     -> out/trace/k3_published_point.trace.json, Chrome Trace Event JSON of the published point
 *        (open in https://ui.perfetto.dev or chrome://tracing). About a second.
 *   node integration/pipelines/generate_execution_trace.js --diff <mechanism | JSON OPT patch> [--traces]
 *     -> scratch/trace/diff_<label>.json: the published point against the same x with the patch,
 *        aligned operator by operator; --traces also writes both timelines next to it.
 *        <mechanism> is a key of k3_tps_design_baseline.MECHANISMS (its fall-back value), e.g. tmaLane.
 *   node integration/pipelines/generate_execution_trace.js --list    (the mechanism keys)
 * A diff is a working view and goes to scratch/; it lands in out/ only through a pipeline that an
 * ADR or an attribution card cites.
 */
const fs = require('fs');
const path = require('path');
const E = require('../detailed/execution_trace.js');
const T = require('../detailed/k3_tps_design_baseline.js');

const root = path.resolve(__dirname, '../..');
const OUT = 'out/trace/k3_published_point.trace.json';
const SCRATCH = 'scratch/trace';
const args = process.argv.slice(2);
const write = (relativePath, text) => {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), {recursive: true});
  fs.writeFileSync(path.join(root, relativePath), text);
};
const f = v => v.toFixed(2);

function published() {
  const trace = E.buildPublished();
  write(OUT, E.serialize(trace));
  const {ledger, counts, protocol} = trace.k3Trace;
  console.log(`${OUT}: ${counts.traceEvents} trace events (${counts.operators} operators, ${counts.collectives} collectives); evidence ${E.EVIDENCE}`);
  console.log(`raw ${f(ledger.rawUs)} us = compute ${f(ledger.computeUs)} - tmaHidden ${f(ledger.tmaHiddenUs)} + comm ${f(ledger.commUs)} + wait ${f(ledger.waitUs)} - overlap ${f(ledger.overlapUs)}; ${f(ledger.tpsPerUser)} TPS/usr`);
  for (const p of protocol) console.log(`  ${p.collective} (L${p.layer}, op ${p.sampledOperatorId}): RDMA ${p.phaseUs.map(f).join('+')} + reduce ${f(p.tpReduceUs)} + card-local ${f(p.cardLocalUs)} + port tail ${f(p.portTailUs)} + tau floor ${f(p.tauFloorUs)} = ${f(p.durationUs)} us`);
}

function diff(spec, withTraces) {
  let patch = E.mechanismPatch(spec), label = spec;
  if (!patch) {
    try { patch = JSON.parse(spec); } catch { throw new Error(`--diff takes a mechanism key (${T.MECHANISMS.map(m => m.key).join(', ')}) or a JSON OPT patch, not ${spec}`); }
    label = Object.entries(patch).map(([k, v]) => `${k}-${v}`).join('_').replace(/[^\w.-]/g, '');
  }
  const x = JSON.parse(fs.readFileSync(path.join(root, E.BASELINE_FILE), 'utf8')).tpsDesign.hardware.x;
  const {runs, ...d} = E.diff(x, patch, label);
  const file = `${SCRATCH}/diff_${label}.json`;
  write(file, `${JSON.stringify(d, null, 2)}\n`);
  if (d.variant.feasible === false) { console.log(`${label}: variant infeasible (${d.variant.reasons}); ${file}`); return; }
  console.log(`${label} ${JSON.stringify(patch)}: raw ${f(d.base.rawUs)} -> ${f(d.variant.rawUs)} us (${d.delta.rawUs >= 0 ? '+' : ''}${f(d.delta.rawUs)}), TPS/usr ${f(d.base.tpsPerUser)} -> ${f(d.variant.tpsPerUser)}; ${file}`);
  console.log(`  unmatched operators: base ${d.unmatched.base}, variant ${d.unmatched.variant}`);
  console.log('  largest advance deltas by operator:');
  for (const o of d.byOperatorName.slice(0, 8)) console.log(`    ${f(o.advanceDeltaUs).padStart(8)} us  ${o.name}`);
  const layers = [...d.byLayer].sort((p, q) => Math.abs(q.advanceDeltaUs) - Math.abs(p.advanceDeltaUs)).slice(0, 5);
  console.log(`  largest by layer: ${layers.map(l => `L${l.layer} ${f(l.advanceDeltaUs)}`).join(', ')}`);
  if (withTraces) {
    for (const [tag, run] of [['base', runs.a], ['variant', runs.b]]) {
      const {events} = E.chromeTrace(run);
      E.checkReconciliation(E.reconcile(events), E.ledgerOf(run.r));
      const t = {displayTimeUnit: 'ns', otherData: {format: E.FORMAT, evidenceClass: E.EVIDENCE, point: `${tag} of diff ${label}`, unit: 'microseconds'},
        k3Trace: {format: E.FORMAT, evidenceClass: E.EVIDENCE, patch: tag === 'base' ? {} : patch, ledger: E.ledgerOf(run.r)}, traceEvents: events};
      write(`${SCRATCH}/diff_${label}.${tag}.trace.json`, E.serialize(t));
    }
    console.log(`  timelines: ${SCRATCH}/diff_${label}.{base,variant}.trace.json`);
  }
}

if (args.includes('--list')) {
  for (const m of T.MECHANISMS) console.log(`${m.key.padEnd(18)} off ${JSON.stringify(m.patch || m.off)}`);
} else if (args.includes('--diff')) {
  const spec = args[args.indexOf('--diff') + 1];
  if (!spec) throw new Error('--diff needs a mechanism key or a JSON OPT patch');
  diff(spec, args.includes('--traces'));
} else {
  published();
}
