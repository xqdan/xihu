'use strict';
/* The design point the stages after L3 read (teams/council/docs/23_DESIGN_QUESTION_WORKFLOW_PROPOSAL.md §7.3).
 *
 * Until design.coupling lands a joint point that is the published point: the baseline's
 * tpsDesign.hardware.x at the model's own OPT. Once out/coupling/joint_point.json exists it is the
 * joint point -- a verbatim row of out/detailed/coupling_candidates.json carrying its full x, OPT
 * patch and model patch -- and it is checked against that artifact (search_brief.verifyLandedWinner)
 * before anyone replays it. A landed joint point that does not verify is an error, never a silent
 * fall-back to the published point.
 *
 * resolve() never moves the baseline. `departures` lists every field where the joint point differs
 * from the baseline's own point -- tpsDesign.hardware.x, the model's OPT, and the published
 * replay's model defaults; when the baseline carries a designPoint block (synced by
 * sync_baseline_spec.js --point joint under an ADR) that block is the baseline's point instead, so
 * a synced baseline reports no departures. Stage B and the D group run on the baseline, so while
 * the list is not empty their artifacts describe another point, and design.converge stops on it
 * (args.designPoint). Closing the gap is an ADR plus npm run baseline:sync, not something this
 * module does.
 *
 * Run: node integration/pipelines/design_point.js [auto|joint|published]   (npm run workflow:design-point)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {isDeepStrictEqual} = require('util');
const O = require('../detailed/k3_rdma_final_tuning_model.js');
const SIM = require('../detailed/k3_operator_sram_sim.js');
const {verifyLandedWinner, landedFiles, STAGES} = require('./search_brief.js');

const root = path.resolve(__dirname, '../..');
const BASELINE_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
const {winner: JOINT_FILE, record: RECORD_FILE} = landedFiles('coupling');
const KINDS = ['auto', 'joint', 'published'];

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const readText = file => fs.readFileSync(path.join(root, file), 'utf8');

// What the published replay uses where a joint point carries a model patch: vector unpack, the
// SFU softmax op count of the operator simulator, no option area, no Comm Core control path.
function publishedModel(model) {
  return {native: false, softmaxOpsPerScore: SIM.DEFAULT.softmaxOpsPerScore, matrixAreaOverhead: 0, vectorAreaOverhead: 0,
    commCoreAreaMm2: 0, controlUs: Object.fromEntries(Object.keys(model.controlUs || {}).map(name => [name, 0]))};
}

// The baseline's own point. With no designPoint block that is tpsDesign.hardware.x at the model's
// own OPT and model -- the replay the domain searches and Stage B do. After
// `sync_baseline_spec.js --point joint` the block is the point the whole baseline was replayed at,
// so comparisons are against it rather than against the model defaults.
function baselinePoint(baseline) {
  const x = baseline.tpsDesign.hardware.x;
  const d = baseline.designPoint;
  if (!d || !d.opt) return {source: `${BASELINE_FILE}#tpsDesign.hardware.x`, x, opt: O.OPT, model: null, optionId: null, adr: null};
  const model = {...publishedModel(d.model), ...d.model};
  return {source: `${BASELINE_FILE}#designPoint (${d.optionId}, ${d.adr})`, x, opt: {...O.OPT, ...d.opt}, model,
    optionId: d.optionId, adr: d.adr};
}

// The fields of one part (x, opt, model) where the point differs from the baseline's own. A field
// the point does not carry at all is reported with `to: undefined` rather than skipped: a model
// patch that drops a control path is as much a departure as one that changes it.
const diff = (a = {}, b = {}, keys) => {
  const out = [];
  for (const key of [...new Set(keys)]) if (!isDeepStrictEqual(a[key], b[key])) out.push({key, from: b[key], to: a[key]});
  return out;
};

function departures(point, base) {
  return {
    x: diff(point.x, base.x, [...new Set([...Object.keys(base.x), ...Object.keys(point.x)])]),
    opt: diff(point.opt, base.opt, Object.keys(point.opt)),
    model: diff(point.model, base.model || publishedModel(point.model), Object.keys(point.model))
  };
}

// The identity of a point: its own numbers, not the file that carried them, so a re-landed copy
// with other formatting is the same point and a card built at it stays current.
const pointSha256 = ({x, opt, model}) => sha256(JSON.stringify({x, opt, model}));

// `point`: auto (the joint point when one has landed, the published point otherwise) | joint |
// published. The other options inject what is otherwise read from disk (tests).
function resolve({point = 'auto', baselineText, jointPoint, runRecord, artifact} = {}) {
  if (!KINDS.includes(point)) throw new Error(`unknown design point "${point}"; expected ${KINDS.join(' | ')}`);
  const baseline = JSON.parse(baselineText || readText(BASELINE_FILE));
  const base = baselinePoint(baseline);
  const landed = jointPoint !== undefined || fs.existsSync(path.join(root, JOINT_FILE));
  if (point === 'published' || (point === 'auto' && !landed)) {
    const p = {x: base.x, opt: base.opt, model: base.model};
    return {kind: 'published', source: base.source, optionId: null, ...p, sha256: pointSha256(p),
      baselineAdr: base.adr, departures: null, departsFromPublished: false};
  }
  if (!landed) throw new Error(`${JOINT_FILE} is missing; design.coupling has not landed a joint point`);
  const winner = jointPoint !== undefined ? jointPoint : JSON.parse(readText(JOINT_FILE));
  const record = runRecord !== undefined ? runRecord
    : (fs.existsSync(path.join(root, RECORD_FILE)) ? JSON.parse(readText(RECORD_FILE)) : null);
  const check = verifyLandedWinner('coupling', winner, record, {artifact});
  if (!check.ok) throw new Error(`${JOINT_FILE} does not verify against ${STAGES.coupling.artifact}: ${check.failures.join('; ')}`);
  const p = {x: winner.x, opt: winner.opt, model: winner.model};
  const d = departures(p, base);
  // On a baseline synced onto the joint point the baseline's own point IS this point, and the
  // record of it is the designPoint block the ADR wrote -- that is where a reader should go. On an
  // unsynced baseline the point exists only in the landed artifact.
  if (base.adr && base.optionId !== winner.optionId) {
    throw new Error(`${BASELINE_FILE} is synced onto ${base.optionId} (${base.adr}) but the landed joint point is ${winner.optionId}; the baseline block and ${JOINT_FILE} disagree`);
  }
  return {kind: 'joint', source: base.adr ? base.source : JOINT_FILE, optionId: winner.optionId, ...p, sha256: pointSha256(p),
    baselineAdr: base.adr, departures: d, departsFromPublished: Object.values(d).some(list => list.length > 0)};
}

// The part of a resolved point a consumer records (a card's inputs.point, a run record).
const summary = p => ({kind: p.kind, source: p.source, optionId: p.optionId, sha256: p.sha256, departsFromPublished: p.departsFromPublished});

if (require.main === module) {
  try {
    console.log(JSON.stringify(resolve({point: process.argv[2] || 'auto'}), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {BASELINE_FILE, JOINT_FILE, RECORD_FILE, KINDS, resolve, summary, baselinePoint, departures, publishedModel, pointSha256};
