'use strict';
// Operator cost provider and evidence coverage (ARCH-CH-02; teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md).
// 1. With the committed (empty) observation table every op is analytical/MODEL and the published point is unchanged.
// 2. Lookup order: an exact observation replaces the kernel line; two observations bracketing the shape interpolate;
//    off the segment, at another shape or on other hardware the op falls back to the analytical value.
// 3. The table schema is enforced (environment, repeats, error; no evidence class outside the observed ones).
// 4. The committed out/detailed/cost_coverage.json is what the generator writes now and is bound to its sources.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const CP = require('../../integration/detailed/cost_provider.js');
const C = require('../../integration/detailed/cost_coverage.js');
const {simulate} = require('../../integration/detailed/k3_operator_sram_sim.js');

const root = path.resolve(__dirname, '../..');
const FILE = 'out/detailed/cost_coverage.json';
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const spec = JSON.parse(fs.readFileSync(path.join(root, C.BASELINE_FILE), 'utf8'));
const x = spec.tpsDesign.hardware.x;
const hardware = Object.fromEntries(CP.HW_KEYS.map(k => [k, x[k]]));
const run = () => { const m = O.mapped(x); return {m, r: simulate(m.plan, m.window)}; };

// 1. Empty table: inert.
const table = JSON.parse(fs.readFileSync(path.join(root, CP.OBSERVATIONS_FILE), 'utf8'));
assert.strictEqual(table.format, CP.FORMAT);
assert.deepStrictEqual(table.observations, [], 'the observation table is empty until something is measured');
const base = run();
near(base.r.rawUs, spec.tpsDesign.point.rawLatencyUs, 1e-6, 'published raw');
for (const o of base.m.plan.ops) {
  assert.strictEqual(o.costSource, 'analytical', `${o.name} cost source`);
  assert.strictEqual(o.costEvidence, 'MODEL', `${o.name} cost evidence`);
  assert(!('costObservations' in o), `${o.name} cites observations`);
}
const qk = base.m.plan.ops.find(o => o.name.startsWith('QK'));
const obs = (id, op, shape, kernelUs, extra = {}) => ({id, op, shape, hardware, kernelUs, evidence: 'EMULATION_OBSERVED',
  source: 'synthetic test row', environment: 'test', repeats: 3, errorUs: 0.01, ...extra});

// An observation equal to the analytical value moves nothing but the tag.
const same = CP.withObservations([obs('qk-equal', qk.name, qk.costShape, qk.timing.kernel)], run);
near(same.r.rawUs, base.r.rawUs, 1e-9, 'equal observation');
const qkSame = same.m.plan.ops.filter(o => o.name === qk.name);
assert(qkSame.every(o => o.costSource === 'measured' && o.costEvidence === 'EMULATION_OBSERVED' && o.costObservations[0] === 'qk-equal'), 'every QK op takes the observation');
assert(same.m.plan.ops.filter(o => o.name !== qk.name).every(o => o.costSource === 'analytical'), 'other ops stay analytical');

// 2a. Measured: twice the analytical kernel on all 24 QK ops.
const slow = CP.withObservations([obs('qk-slow', qk.name, qk.costShape, 2 * qk.timing.kernel)], run);
near(slow.m.services.kernel - base.m.services.kernel, 24 * qk.timing.kernel, 1e-6, 'measured kernel replaces the analytical line');
assert(slow.r.rawUs > base.r.rawUs + 1, 'a slower measured QK costs wall time');
near(slow.r.rawUs, slow.r.computeUs - slow.r.tmaHiddenUs + slow.r.commUs + slow.r.waitUs - slow.r.overlapUs, 1e-5, 'conservation with a measured kernel');
const cov = CP.withObservations([obs('qk-slow', qk.name, qk.costShape, 2 * qk.timing.kernel, {evidence: 'SILICON_OBSERVED'})], () => C.coverage(x));
near(cov.ledger.bySource.measured, 24 * 2 * qk.timing.kernel, 1e-6, 'coverage books the measured kernel');
near(cov.ledger.byEvidence.SILICON_OBSERVED, cov.ledger.bySource.measured, 1e-9, 'coverage by evidence');
near(cov.ledger.bySource.measured + cov.ledger.bySource.fitted + cov.ledger.bySource.analytical + cov.ledger.nonKernelUs, cov.ledger.rawUs, 1e-6, 'coverage sums to raw');
assert(cov.shares.measured > 0.05 && cov.calibrationQueue[0].costSource.measured === 24, 'measured share and queue');

// 2b. Fitted: two samples at 0.5x and 1.5x the shape interpolate to their mean; never extrapolated.
const scaled = f => Object.fromEntries(CP.SHAPE_KEYS.map(k => [k, qk.costShape[k] * f]));
const pair = [obs('qk-lo', qk.name, scaled(0.5), 1), obs('qk-hi', qk.name, scaled(1.5), 3, {evidence: 'SILICON_OBSERVED'})];
const fit = CP.kernelCost(qk.name, qk.costShape, x, 99), fitted = CP.withObservations(pair, () => CP.kernelCost(qk.name, qk.costShape, x, 99));
assert.strictEqual(fit.source, 'analytical');
assert.strictEqual(fitted.source, 'fitted');
near(fitted.us, 2, 1e-12, 'linear interpolation');
assert.strictEqual(fitted.evidence, 'EMULATION_OBSERVED', 'a fit carries the weaker evidence');
assert.deepStrictEqual(fitted.observations, ['qk-lo', 'qk-hi']);
CP.withObservations(pair, () => {
  assert.strictEqual(CP.kernelCost(qk.name, scaled(2), x, 99).source, 'analytical', 'beyond the samples falls back');
  assert.strictEqual(CP.kernelCost(qk.name, {...qk.costShape, flops: qk.costShape.flops * 1.2}, x, 99).source, 'analytical', 'off the segment falls back');
  assert.strictEqual(CP.kernelCost(qk.name, qk.costShape, {...x, ghz: x.ghz * 1.2}, 99).source, 'analytical', 'other hardware falls back');
  assert.strictEqual(CP.kernelCost('PV + rescale accumulation', qk.costShape, x, 99).source, 'analytical', 'other op falls back');
  near(C.coverage(x).ledger.bySource.fitted, 24 * 2, 1e-9, 'coverage books the fitted kernel');
});

// 3. Schema.
const bad = (patch, re) => assert.throws(() => CP.validate([{...obs('b', qk.name, qk.costShape, 1), ...patch}], 't'), re);
bad({evidence: 'MODEL'}, /evidence must be one of/);
bad({evidence: 'PUBLISHED_PAPER'}, /evidence must be one of/);
bad({environment: ''}, /environment/);
bad({repeats: 0}, /repeats/);
bad({errorUs: undefined}, /errorUs/);
bad({kernelUs: 0}, /kernelUs/);
bad({hardware: {...hardware, ghz: undefined}}, /hardware\.ghz/);
assert.throws(() => CP.validate([obs('a', qk.name, qk.costShape, 1), obs('b', qk.name, qk.costShape, 2)], 't'), /duplicate/);

// 4. Committed report.
const text = fs.readFileSync(path.join(root, FILE), 'utf8');
assert.strictEqual(sha256(`${JSON.stringify(C.build(), null, 2)}\n`), sha256(text), `${FILE} is stale: rerun npm run cost:coverage`);
const report = JSON.parse(text);
assert.strictEqual(report.format, C.FORMAT);
assert.strictEqual(report.evidenceClass, 'MODEL');
assert.deepStrictEqual(Object.keys(report.provenance.sources), C.SOURCE_FILES);
for (const [f, h] of Object.entries(report.provenance.sources)) assert.strictEqual(h, sha256(fs.readFileSync(path.join(root, f))), `source hash of ${f}`);
assert.strictEqual(report.provenance.observationsSha256, sha256(fs.readFileSync(path.join(root, CP.OBSERVATIONS_FILE))));
assert.strictEqual(report.shares.observed, 0);
near(report.ledger.byEvidence.MODEL, report.ledger.rawUs, 1e-6, 'all MODEL with an empty table');
near(report.classes.reduce((a, c) => a + c.kernelUs, 0), report.ledger.kernelUs, 1e-6, 'classes cover the kernel line');
assert.strictEqual(report.calibrationQueue.reduce((a, g) => a + g.count, 0), base.m.plan.ops.filter(o => o.unit !== 'COMM').length, 'queue covers every compute op');

console.log(`PASS cost provider: empty table inert (raw ${base.r.rawUs.toFixed(2)} us, kernel ${report.ledger.kernelUs.toFixed(2)} us analytical, ${report.calibrationQueue.length} op names); measured QK x2 +${(slow.r.rawUs - base.r.rawUs).toFixed(2)} us; fit/fallback and schema checked`);
