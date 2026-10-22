'use strict';
// design.coupling's joint replay (doc 23 section 4, integration/detailed/coupling_search.js):
// the stored artifacts are a fresh build and the replay leaves the shared model untouched;
// the composed point (the five domain winners at once) is replayed like any other row and
// is held to every contract entry; the joint point is feasible, on the Pareto set, and
// satisfies all five entries on its own quantities; the composed point carries the compute
// winner's own kernel binding; a row re-replayed from its stored x / opt reproduces its
// numbers; a grid with nothing feasible produces an L1-b backflow instead of a point; and
// search_brief.js verifies a landed joint point under coupling's own file names.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const S = require('../../integration/detailed/coupling_search.js');
const A = require('../../integration/detailed/k3_architecture_search.js');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const {verifyLandedWinner, landedFiles} = require('../../integration/pipelines/search_brief.js');

const stored = JSON.parse(fs.readFileSync('out/detailed/coupling_design.json', 'utf8'));
const storedCand = JSON.parse(fs.readFileSync('out/detailed/coupling_candidates.json', 'utf8'));
const space = JSON.parse(fs.readFileSync(S.SPACE_FILE, 'utf8'));
const mvDesign = JSON.parse(fs.readFileSync('out/detailed/matrix_vector_design.json', 'utf8'));

// 1. The artifacts are a fresh build; the replay patches O.OPT and the model per row and must
// restore both.
const techBefore = JSON.stringify(A.TECH), optBefore = JSON.stringify(O.OPT);
const result = S.search();
const fresh = JSON.parse(JSON.stringify(S.build(result)));
const cand = JSON.parse(JSON.stringify(S.candidates(result)));
assert.strictEqual(JSON.stringify(A.TECH), techBefore, 'the joint replay must not change A.TECH');
assert.strictEqual(JSON.stringify(O.OPT), optBefore, 'the joint replay must restore O.OPT');
const close = (a, b, path) => {
  if (typeof a === 'number' && typeof b === 'number') return assert(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${path}: ${a} vs ${b}`);
  if (a && typeof a === 'object') {
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(a)) close(a[k], b[k], `${path}.${k}`);
    return;
  }
  assert.strictEqual(a, b, path);
};
close(stored, fresh, 'couplingDesign');
close(storedCand, cand, 'couplingCandidates');
assert.strictEqual(storedCand.candidateSetSha256, cand.candidateSetSha256, 'the fingerprint is stable');
assert.strictEqual(stored.designSpace.sha256, crypto.createHash('sha256').update(fs.readFileSync(S.SPACE_FILE)).digest('hex'), 'design space hash');
assert(!/FROZEN/.test(stored.status.replace('not FROZEN', '')), 'the joint point is a MODEL result, not FROZEN');

// 2. Coupling owns no contract entry: it holds every one of them at once.
const contractIds = cand.clauses.map(c => c.id).sort();
assert.deepStrictEqual([...space.requirements.contractEntries].sort(), contractIds, 'coupling declares every contract entry');
assert.deepStrictEqual(Object.keys(stored.winners).sort(), ['comm', 'compute', 'mc', 'physical', 'sram']);
assert.deepStrictEqual(cand.designSpace.dimensions, Object.keys(space.couplings), 'the three couplings are the dimensions');
assert.strictEqual(cand.requirements.tauUs, cand.clauses.find(c => c.id === 'B-TAU').max, 'every row replays at B-TAU max (tau is not a degree of freedom)');
for (const row of cand.candidates) {
  assert.strictEqual(row.opt.tauUs, cand.requirements.tauUs, `${row.optionId}: tau is pinned`);
  for (const [domain, fields] of Object.entries(row.departsFrom)) {
    for (const f of fields) assert.strictEqual(space.fieldOwners[f], domain, `${row.optionId}: ${f} is owned by ${space.fieldOwners[f]}, not ${domain}`);
  }
}

// 3. The composed point is a row like any other, and it is the reference the grid departs from.
const composed = cand.candidates.find(r => r.optionId === 'composed');
assert(composed, 'the composed point is in the candidate set');
assert.deepStrictEqual(composed.departsFrom, {}, 'the composed point departs from nothing');
assert.strictEqual(composed.feasible, stored.composition.composed.feasible);
assert.strictEqual(composed.tpsPerUser, stored.composition.composed.tpsPerUser);
// Before ADR-0026 the five winners together missed the target (992.57 against 1000): each one spent margin
// the others assumed. With the HBM3E point the composition reaches it (1006.85), because the memory winner
// no longer binds. That is a result of this point, not an invariant: what must hold either way is that the
// composed row's verdict follows from its own numbers, and that a miss would be named, not hidden. (It is not
// an invariant that the composition is worse than every winner alone: 1006.85 here is above the sram winner's 1002.35.)
assert.strictEqual(composed.feasible, composed.tpsPerUser >= cand.requirements.targetTpsPerUser && composed.violations.length === 0,
  'the composed point is feasible exactly when it reaches the target and breaks nothing');
if (!composed.feasible) assert(composed.violations.length > 0, 'an infeasible composition names what it breaks');
for (const [d, alone] of Object.entries(stored.composition.domainAlone)) {
  assert(alone.tpsPerUser >= cand.requirements.targetTpsPerUser, `${d} alone reaches the target`);
}
// The composed point holds the compute winner to its own kernel check: same binding kernel, same lane floor.
assert.deepStrictEqual(composed.kernel.binding, mvDesign.binding, 'the composed point carries the compute winner\'s kernel binding');
assert.strictEqual(composed.kernel.hidden, true);

// 4. The joint point: feasible, on the Pareto set, ranked first, and every clause holds.
const best = cand.candidates[0];
assert.strictEqual(best.chosen, true);
assert.strictEqual(best.feasible, true);
assert.strictEqual(best.pareto, true);
assert.strictEqual(stored.jointPoint.optionId, best.optionId);
assert.deepStrictEqual(stored.jointPoint.x, best.x);
assert.deepStrictEqual(stored.jointPoint.opt, best.opt);
assert.strictEqual(stored.backflow, null, 'nothing goes back to L1-b while a joint point is feasible');
assert.deepStrictEqual(Object.keys(best.clauses).sort(), contractIds);
for (const [id, c] of Object.entries(best.clauses)) assert.strictEqual(c.holds, true, `${id} holds at the joint point`);
assert(best.tpsPerUser >= cand.requirements.targetTpsPerUser);
assert(best.clauses['B-SRAM-CAP'].sharedMiB >= best.clauses['B-SRAM-CAP'].min);
assert(best.clauses['B-MEM-BW'].mcGBs >= best.clauses['B-MEM-BW'].min);
assert(best.clauses['B-TAU'].latencyUs <= best.clauses['B-TAU'].max);
assert(best.dieAreaMm2 <= cand.requirements.limits.dieAreaMm2 && best.diePowerW <= cand.requirements.limits.diePowerW && best.cardPowerW <= cand.requirements.limits.cardPowerW);
assert(Math.abs(best.dieAreaMm2 - (best.area.die + best.area.matrixOverhead + best.area.vectorOverhead + best.area.commCore)) < 1e-9, 'die area is the sum of its terms (comm core included)');
assert(best.kernel.hidden, 'the compute winner\'s kernels still hide at the joint point');
// The Pareto set is exactly the feasible rows no other feasible row dominates.
const feasible = cand.candidates.filter(r => r.feasible);
const dominates = (a, b) => a.tpsPerUser >= b.tpsPerUser && a.dieAreaMm2 <= b.dieAreaMm2 && a.cardPowerW <= b.cardPowerW
  && (a.tpsPerUser > b.tpsPerUser || a.dieAreaMm2 < b.dieAreaMm2 || a.cardPowerW < b.cardPowerW);
for (const r of cand.candidates) assert.strictEqual(r.pareto, r.feasible && !feasible.some(o => o !== r && dominates(o, r)), `${r.optionId}: Pareto mark`);
assert.strictEqual(cand.feasibleCandidates, feasible.length);
assert.strictEqual(cand.paretoCandidates, cand.candidates.filter(r => r.pareto).length);
// Rows below a clause are replayed and kept, with the clause named.
// A clause only has rows below it if the grid reaches below its minimum. B-SRAM-CAP's minimum was 16 MiB
// before ADR-0026 (grid {12,16,24} has 12 below it) and is 12 MiB now (nothing in the grid is below it), so the
// requirement is conditional: where the grid goes under a clause, those rows are kept and named.
for (const id of ['B-SRAM-CAP', 'B-MEM-BW']) {
  const min = best.clauses[id].min;
  const field = id === 'B-SRAM-CAP' ? 'sharedMiB' : 'mcGBs';
  const gridBelow = space.couplings.sramDepthMc.fields[field].some(v => v < min);
  if (gridBelow) assert(cand.infeasibleByCause[`clause:${id}`] > 0, `rows below ${id} are kept as rejected combinations`);
  else assert(!cand.infeasibleByCause[`clause:${id}`], `${id}: the grid has nothing below the minimum ${min}, so no row can be rejected on it`);
}
assert(cand.candidates.some(r => r.tauSweep && r.tauSweep.length === space.couplings.tauOverlapCompute.tauSweepUs.length), 'tau rows carry the sweep');

// 5. A row re-replayed from its stored point reproduces its numbers.
const ctx = result.ctx;
for (const row of [best, composed]) {
  const again = S.evaluate(ctx, row.x, row.opt);
  close(again.tpsPerUser, row.tpsPerUser, `${row.optionId}.tpsPerUser`);
  close(again.dieAreaMm2, row.dieAreaMm2, `${row.optionId}.dieAreaMm2`);
  close(again.cardPowerW, row.cardPowerW, `${row.optionId}.cardPowerW`);
  assert.deepStrictEqual(again.violations, row.violations, `${row.optionId}: violations`);
}
assert.strictEqual(JSON.stringify(O.OPT), optBefore, 'a re-replay restores O.OPT');

// 6. Nothing feasible: no joint point, and a backflow to L1-b carrying the shortfall and each
// domain's own best.
const dead = r => ({...r, feasible: false, pareto: false, violations: [...r.violations, 'belowContractTarget'].filter((v, i, a) => a.indexOf(v) === i)});
const all = result.all.map(dead);
const order = result.order.map(r => all[result.all.indexOf(r)]);
const noneFeasible = {...result, all, order, best: order[0], composed: all[result.all.indexOf(result.composed)],
  counts: {...result.counts, feasible: 0, pareto: 0}};
const flow = S.candidates(noneFeasible).backflow;
assert(flow, 'a grid with nothing feasible goes back');
assert.strictEqual(flow.to, 'L1-b');
assert.strictEqual(flow.routeTo, 'design.req.budget');
assert.deepStrictEqual(Object.keys(flow.domainBest).sort(), ['comm', 'compute', 'mc', 'physical', 'sram']);
assert.strictEqual(flow.shortfallTpsPerUser, Math.max(0, cand.requirements.targetTpsPerUser - flow.highestTps.tpsPerUser));
assert.strictEqual(S.build(noneFeasible).jointPoint, null, 'no joint point is invented');

// 7. search_brief.js verifies a landed joint point under coupling's own file names, and the
// joint point's x / opt / model must be the row's own.
assert.deepStrictEqual(landedFiles('coupling'), {winner: 'out/coupling/joint_point.json', record: 'out/coupling/coupling_run_record.json'});
const jointPoint = {optionId: best.optionId, values: JSON.stringify(best), provenance: 'test', x: best.x, opt: best.opt, model: best.model};
const record = {candidateSetSha256: cand.candidateSetSha256, merge: {excluded: [{optionId: 'composed'}]}};
assert.deepStrictEqual(verifyLandedWinner('coupling', jointPoint, record, {artifact: cand}).failures, []);
const moved = verifyLandedWinner('coupling', {...jointPoint, x: {...best.x, lBanks: best.x.lBanks + 1}}, record, {artifact: cand});
assert(moved.failures.some(f => /winner\.x .* differs from the artifact row/.test(f)), moved.failures.join('; '));
const notFeasible = cand.candidates.find(r => !r.feasible);
const infeasible = verifyLandedWinner('coupling', {optionId: notFeasible.optionId, values: JSON.stringify(notFeasible), provenance: 'test'}, record, {artifact: cand});
assert(infeasible.failures.some(f => /not feasible/.test(f)), infeasible.failures.join('; '));

console.log(`PASS coupling design: fresh build of ${cand.totalCandidates} joint rows (${cand.feasibleCandidates} feasible, ${cand.paretoCandidates} Pareto); `
  + `the composed point is held to every contract entry (${composed.tpsPerUser.toFixed(2)} TPS/usr, ${composed.violations.join(', ')}); `
  + `joint point ${best.optionId} holds all five entries at ${best.tpsPerUser.toFixed(2)} TPS/usr, ${best.dieAreaMm2.toFixed(3)} mm2; `
  + 'a dead grid backflows to L1-b, and a landed joint point is verified under its own file names');
