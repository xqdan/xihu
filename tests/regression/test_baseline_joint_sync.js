'use strict';

// Moving the baseline onto a joint point (doc 23 §7.3 item 5): sync_baseline_spec.js --point joint.
//
// Writing the baseline is an ADR decision, so this test does not write it: build() derives
// everything in memory at an injected point and the assertions are on the returned objects.
//
// What this pins:
//   * --point published stays what it was: no designPoint block, the search best, the model's area;
//   * --point joint replays the point's x under the point's OPT and model patch, counts the option
//     overheads and the Comm Core in the die area, and records the point in designPoint;
//   * the ADR has to name the point: an ADR that cites nothing is refused, and --adr is refused
//     with --point published;
//   * design_point.js then finds no departures from a baseline that carries the block, because the
//     baseline's own point IS that point;
//   * baseline_point.publishedX stops a patch-blind consumer on such a baseline, and is the identity
//     on a published one.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../../integration/pipelines/sync_baseline_spec.js');
const DP = require('../../integration/pipelines/design_point.js');
const BP = require('../../integration/detailed/baseline_point.js');
const C = require('../../integration/detailed/coupling_search.js');

const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const spec = read(S.BASELINE_FILE);
const directional = read(S.DIRECTIONAL_FILE);
const results = read(S.RESULTS_FILE);
const coupling = read('out/detailed/coupling_candidates.json');
const row = coupling.candidates.find(c => c.feasible);

const sha = require('crypto').createHash('sha256').update(JSON.stringify({x: row.x, opt: row.opt, model: row.model})).digest('hex');
const point = {kind: 'joint', source: 'out/coupling/joint_point.json', optionId: row.optionId, sha256: sha,
  adr: 'teams/council/adr/ADR-TEST-joint-baseline.md', x: row.x, opt: row.opt, model: row.model};

// ---- published: byte-identical to before the extension ----

const pub = S.build({spec, baseline: directional, results, point: {kind: 'published'}});
assert.strictEqual(pub.spec.designPoint, undefined, 'the published sync writes no designPoint block');
assert.deepStrictEqual(pub.spec.tpsDesign.hardware.x, results.search.best.x, 'the published sync uses the search best');
assert.strictEqual(pub.spec.computeDieCandidate.optionAreaMm2, undefined, 'no option area at the published point');
assert.strictEqual(S.parseArgs([]).point, 'published', 'published is the default');
assert.throws(() => S.parseArgs(['--adr', 'x.md']), /--adr only applies/, '--adr without --point joint is refused');

// ---- joint: replayed at the point, with the patch ----

const joint = S.build({spec, baseline: directional, results, point});
const d = joint.spec.designPoint;
assert(d && d.kind === 'joint', 'the joint sync records the point');
assert.strictEqual(d.optionId, row.optionId);
assert.strictEqual(d.sha256, sha);
assert.strictEqual(d.adr, point.adr);
assert.deepStrictEqual(d.opt, row.opt, 'the block carries the OPT patch');
assert.deepStrictEqual(d.model, row.model, 'the block carries the model patch');

// The replayed numbers are the joint row's, not the published point's: the whole point of the
// two-channel design is that the baseline now states the model as the coupled search saw it.
// `x` carries mcGBs 640, so a plain evaluate(x) would be the stretch point; the MC320 number is
// the reference replay, exactly as fields() derives it.
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const SIM = require('../../integration/detailed/k3_operator_sram_sim.js');
const atPoint = x => C.withPoint({opt: row.opt, model: row.model}, () => O.evaluate(x));
const jointReplay = atPoint({...row.x, mcGBs: 320});
assert.strictEqual(joint.spec.tpsDesign.hardware.x.sharedMiB, row.x.sharedMiB, 'x is the point x');
assert(Math.abs(joint.spec.modelResults.referenceMc320GBs.tpsPerUser - jointReplay.tps) < 1e-9,
  'the K3 MC320 replay is the patched replay');
// Fixture self-check: the row's model patch has to move something the replay reads, otherwise
// "replayed at the point" would be indistinguishable from "replayed at the default".
if (row.model.softmaxOpsPerScore !== SIM.DEFAULT.softmaxOpsPerScore) {
  assert(Math.abs(jointReplay.tps - O.evaluate({...row.x, mcGBs: 320}).tps) > 1e-9,
    'the injected point must actually differ from the model default, or this test proves nothing');
}

const optionArea = joint.spec.computeDieCandidate.optionAreaMm2;
const stretchReplay = C.withPoint({opt: row.opt, model: row.model}, () => O.evaluate({...row.x, mcGBs: 640}));
assert(optionArea, 'the joint sync sizes the option overheads');
assert.strictEqual(optionArea.commCore, row.model.commCoreAreaMm2, 'the Comm Core area is the point model area');
assert.strictEqual(optionArea.matrixOverhead, row.model.matrixAreaOverhead * stretchReplay.p.area.matrix);
assert.strictEqual(optionArea.vectorOverhead, row.model.vectorAreaOverhead * stretchReplay.p.area.vector);

// ---- design_point.js: a baseline carrying the block reports no departures ----

const baselineText = JSON.stringify(joint.spec);
const withBlock = DP.resolve({point: 'joint', baselineText, jointPoint: {optionId: row.optionId, values: JSON.stringify(row),
  provenance: 'test', x: row.x, opt: row.opt, model: row.model},
  runRecord: {candidateSetSha256: coupling.candidateSetSha256}, artifact: coupling});
assert.strictEqual(withBlock.departsFromPublished, false, 'a synced baseline is its own point');
for (const part of ['x', 'opt', 'model']) assert.deepStrictEqual(withBlock.departures[part], [], `${part} departures are empty`);
assert.strictEqual(withBlock.baselineAdr, point.adr, 'the resolved point names the ADR');
assert.strictEqual(withBlock.source, `${S.BASELINE_FILE}#designPoint (${row.optionId}, ${point.adr})`);

// The same point against the unsynced baseline departs: the guard is not vacuous.
const againstPublished = DP.resolve({point: 'joint', baselineText: JSON.stringify(spec), jointPoint: {optionId: row.optionId,
  values: JSON.stringify(row), provenance: 'test', x: row.x, opt: row.opt, model: row.model},
  runRecord: {candidateSetSha256: coupling.candidateSetSha256}, artifact: coupling});
assert.strictEqual(againstPublished.departsFromPublished, true, 'against the published baseline the joint point departs');

// ---- baseline_point.js: the guard on patch-blind consumers ----

assert.strictEqual(BP.patched(spec), false, 'today no baseline carries a designPoint block');
assert.deepStrictEqual(BP.publishedX(spec, 'test'), spec.tpsDesign.hardware.x, 'publishedX is the identity without a block');
assert.strictEqual(BP.patched(joint.spec), true);
assert.throws(() => BP.publishedX(joint.spec, 'generate_sram_design.js'), /not wired to a patched baseline/,
  'a patch-blind consumer stops on a synced baseline');
assert.throws(() => BP.publishedX(joint.spec, 'x.js'), new RegExp(row.optionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  'the error names the point');

// ---- the ADR check ----

const jointPoint = S.jointPoint;
assert.throws(() => S.jointPoint({...point, kind: 'published'}, {file: point.adr, text: sha}), /needs a resolved joint point/);
assert.throws(() => S.jointPoint(point, {file: 'teams/council/docs/notes.md', text: `${row.optionId} ${sha}`}), /needs --adr <file under/,
  'the ADR has to live under the ADR directory');
assert.throws(() => S.jointPoint(point, {file: point.adr, text: 'we moved the baseline'}), /does not name the joint point/,
  'an ADR that does not cite the point is refused');
const accepted = S.jointPoint(point, {file: point.adr, text: `ADR: move the baseline to ${row.optionId} (${sha}).`});
assert.strictEqual(accepted.sha256, sha);

console.log(`PASS joint baseline sync: ${row.optionId} replayed with its OPT / model patch `
  + `(Comm Core ${optionArea.commCore.toFixed(6)} mm²), no departures once synced; published sync unchanged`);
