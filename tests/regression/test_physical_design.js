'use strict';
// Physical / package design search (teams/hardware/docs/09_PACKAGE_POWER_RAS.md
// section 3): the stored artifact is the winner of a fresh search over the HW-09
// design space and holds no alternatives; the winner reproduces the published
// hardware point exactly; area conservation closes on the placement window; the
// held-out options are excluded by the search rather than merely losing; the
// ranking never rewards a more optimistic unverified premise; the candidate set
// is persisted beside the winner with a stable fingerprint; the document quotes
// the design, the sensitivities and the analysis.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const S = require('../../integration/detailed/physical_search.js');
const A = require('../../integration/detailed/k3_architecture_search.js');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');

const stored = JSON.parse(fs.readFileSync('out/detailed/physical_design.json', 'utf8'));
const storedCand = JSON.parse(fs.readFileSync('out/detailed/physical_candidates.json', 'utf8'));
const space = JSON.parse(fs.readFileSync(S.SPACE_FILE, 'utf8'));

// 1. The artifact is a fresh build; the shared module constants (A.TECH, O.OPT,
// the mapped plan) are left exactly as the other domains found them. The search
// mutates TECH to replay a candidate process basis, so a search that leaked the
// mutation would silently move the baseline for every later caller.
const techBefore = JSON.stringify(A.TECH), optBefore = JSON.stringify(O.OPT), mappedPlan = A.mappedPlan;
const result = S.search();
const fresh = JSON.parse(JSON.stringify(S.build(result)));
const alt = S.alternatives(result), an = S.analysis(result);
assert.strictEqual(JSON.stringify(A.TECH), techBefore, 'search must restore A.TECH');
assert.strictEqual(JSON.stringify(O.OPT), optBefore, 'search must not change O.OPT');
assert.strictEqual(A.mappedPlan, mappedPlan, 'search must restore A.mappedPlan');
const close = (a, b, path) => {
  if (typeof a === 'number' && typeof b === 'number') return assert(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${path}: ${a} vs ${b}`);
  if (a && typeof a === 'object') {
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(a)) close(a[k], b[k], `${path}.${k}`);
    return;
  }
  assert.strictEqual(a, b, path);
};
close(stored, fresh, 'physicalDesign');
assert(!/FROZEN/.test(stored.status.replace('not FROZEN', '')), 'the design is a MODEL result, not FROZEN');
assert.strictEqual(stored.designSpace.sha256, crypto.createHash('sha256').update(fs.readFileSync(S.SPACE_FILE)).digest('hex'), 'design space hash');

// 2. out/ holds only the final design.
assert.deepStrictEqual(Object.keys(stored.design), Object.keys(space.dimensions), 'one entry per searched dimension');
for (const [d, v] of Object.entries(stored.design)) assert(v.option in space.dimensions[d].options, `${d}: ${v.option} is not in the design space`);
assert.deepStrictEqual(Object.keys(stored.ruled), Object.keys(space.ruled));
for (const v of Object.values(stored.ruled)) assert(!('alternatives' in v), 'ruled alternatives stay in the design space');
assert(!/"(alternatives|candidates|perOption|sweep)"\s*:\s*[[{]/.test(JSON.stringify(stored)), 'no alternative lists in out/');
assert(stored.designSpace.feasible > 0 && stored.designSpace.feasible <= stored.designSpace.candidates);

// 3. The winner reproduces the published hardware point. This is the test that
// keeps the model and the basis honest: 09 section 0 publishes dieArea 373.71,
// diePower 286.22, card power 2768.47, package 4589.71 and shoreline 24.21/52.95,
// and tpsDesign.hardware is the single hardware spec (ADR-0021 P1). A replay
// that dropped the shared-port charge reproduces 357.565 mm2 / 280.530 W instead
// and would fail here -- which is exactly how that modelling error was caught.
const ev = stored.evaluation, hw = stored.hardware, req = stored.requirements;
const D = result.ctx.space.dimensions;
const tol = v => v * 1e-9 * Math.max(1, Math.abs(v));
for (const [label, got, want] of [
  ['die area', ev.dieAreaMm2, 373.7139860943489],
  ['die power', ev.diePowerW, 286.2191872000001],
  ['card power', ev.cardPowerW, 2768.473497600001],
  ['package area', ev.packageAreaMm2, 4589.711888754791],
  ['shoreline', ev.shorelineMm, 24.21333333333333],
  ['edge budget', ev.edgeBudgetMm, 52.94630302642081]]) {
  assert(Math.abs(got - want) <= tol(want) + 1e-12, `${label}: ${got} does not reproduce the published ${want}`);
}
assert.strictEqual(hw.publishedDieAreaMm2, ev.dieAreaMm2, 'the artifact must carry the published point it claims to reproduce');
assert.strictEqual(an.published.cardPowerW, ev.cardPowerW, 'analysis and evaluation must agree on the published card power');
// The shared-port charge is the term resize() rebuilds away; it must be present
// in the area and power breakdowns, not silently folded into another line.
const portAreaMm2 = ev.area.sharedPorts, portPowerW = ev.power.sharedPorts;
assert(portAreaMm2 > 0 && portPowerW > 0, 'the shared-port charge must be charged in both area and power');
close(ev.dieAreaMm2, Object.values(ev.area).reduce((a, v) => a + v, 0), 'die area adds up');
close(ev.diePowerW, Object.values(ev.power).reduce((a, v) => a + v, 0), 'die power adds up');
close(ev.packageAreaMm2, result.ctx.dies * ev.dieAreaMm2 + result.ctx.cubes * result.ctx.cubeAreaMm2, 'package area is dies plus cubes');
close(ev.cardPowerW, result.ctx.dies * ev.diePowerW + ev.mcPowerW + S.CARD_FIXED_W, 'card power is dies plus MC plus the fixed overhead');
assert(ev.dieAreaMm2 <= req.dieAreaLimitMm2, 'die area within its limit');
assert(ev.diePowerW <= ev.diePowerLimitW, 'die power within its limit');
assert(ev.cardPowerW <= ev.cardPowerLimitW, 'card power within its limit');
assert(ev.shorelineMm <= ev.edgeBudgetMm, 'shoreline within the die edge budget');
assert(ev.k3System.tpsPerUser >= ev.k3System.publishedTpsPerUser * (1 - stored.requirements.tpsTolerance), 'K3 TPS within tolerance');

// 4. Area conservation closes on the placement window, and the reserve is the
// keep-out share, not the usable share. Reading reserveFraction backwards (as a
// usable share) makes the search elect the loosest keep-out, because a smaller
// keep-out leaves more room by construction.
const con = stored.evaluation.areaConservation;
assert.strictEqual(con.windowMm2, req.placementWindowMm2);
close(con.keepOutMm2, con.windowMm2 * stored.design.reserveFraction.reserve, 'keep-out is the reserve fraction of the window');
close(con.placedMm2, ev.packageAreaMm2, 'placed area is the package area');
close(con.overUnderMm2, con.windowMm2 - con.placedMm2 - con.keepOutMm2, 'conservation identity');
assert(con.satisfied && con.overUnderMm2 >= -con.toleranceMm2, 'conservation must be satisfied');
assert.strictEqual(con.toleranceMm2, 0, 'the published point is checked against zero tolerance');
// The published point sits just inside the window; a looser keep-out would leave
// room the published design never observed.
const loosest = Math.min(...Object.values(D.reserveFraction.options).map(o => o.reserve));
assert(loosest < stored.design.reserveFraction.reserve, 'the observed keep-out is not the loosest premise offered');

// 5. Held-out options are excluded, not merely outscored. A dimension option the
// search cannot score must be rejected by violation: if it were left as a normal
// candidate it could win a tie-break while asserting a mechanism no number in
// the replay reflects (air cooling is superseded by ADR-0005; N4-ref is a
// historical sensitivity the node decision already closed).
const heldOut = Object.entries(S.HELD_OUT_OPTIONS).flatMap(([d, o]) => Object.keys(o).map(n => [d, n]));
assert(heldOut.length > 0, 'the search must declare its held-out options');
for (const [d, n] of heldOut) {
  const v = alt[d][n];
  assert(!v.chosen, `${d}=${n} is held out and must not win`);
  assert(v.violations.some(x => x === `optionHeldOut:${d}=${n}`), `${d}=${n} must be excluded by violation, got ${JSON.stringify(v.violations)}`);
}
// Every option of every searched dimension is scored, and the chosen one is the
// design's own option.
for (const [d, opts] of Object.entries(alt)) {
  assert.deepStrictEqual(Object.keys(opts), Object.keys(space.dimensions[d].options), `${d}: every option has a best candidate`);
  for (const [n, v] of Object.entries(opts)) {
    assert.strictEqual(v.chosen, n === stored.design[d].option);
    assert.strictEqual(v.pick[d], n, `${d}.${n}: the row must hold its own option`);
    if (v.chosen) { close(v.dieAreaMm2, ev.dieAreaMm2, `${d}.${n} die area`); close(v.packageAreaMm2, ev.packageAreaMm2, `${d}.${n} placed area`); continue; }
    assert(v.lostOn && v.lostOn !== 'tie', `${d}.${n} must lose on a criterion`);
  }
}

// 6. The ranking never rewards a more optimistic unverified premise. Among
// feasible candidates the keep-out premise is compared before the reserve, so a
// candidate that buys room by assuming the vendor accepts less keep-out cannot
// outrank a candidate that assumes more. The published point loses to the 0.10
// keep-out on reserve alone -- which is why the ordering has to run the other way.
const cand = S.candidates(result);
const cands = cand.candidates;
assert.strictEqual(cands.filter(c => c.chosen).length, 1, 'exactly one candidate is the winner');
assert.deepStrictEqual(cands.find(c => c.chosen).pick, Object.fromEntries(Object.entries(stored.design).map(([d, v]) => [d, v.option])));
const feasible = cands.filter(c => c.feasible);
assert.strictEqual(feasible.length, cand.feasibleCandidates, 'feasible count matches the list');
const maxReserve = feasible.reduce((a, c) => Math.max(a, c.reserveMm2), 0);
const winner = cands.find(c => c.chosen);
assert(winner.reserveMm2 < maxReserve, 'the winner deliberately does not take the largest reserve (that candidate rests on a looser keep-out)');
// Ranking order: feasible first, then keep-out premise, then reserve, then die power margin.
for (let i = 1; i < cands.length; i++) {
  const a = cands[i - 1], b = cands[i];
  assert(a.feasible >= b.feasible, `candidate ${i} ranks a feasible candidate below an infeasible one`);
  if (a.feasible && b.feasible) {
    assert(a.keepOutFraction >= b.keepOutFraction - 1e-12, `candidate ${i} ranks a looser keep-out premise above a more conservative one`);
    if (Math.abs(a.keepOutFraction - b.keepOutFraction) <= 1e-12) {
      assert(a.reserveMm2 >= b.reserveMm2 - 1e-9, `candidate ${i} breaks the reserve ranking within one premise`);
    }
  }
  if (b.feasible) assert(b.tpsPerUser > 0, `candidate ${i} has no replay`);
}

// 7. The candidate set is persisted next to the winner with a reproducible
// fingerprint. The design artifact deliberately holds no candidate list (see
// section 2); this file is where the excluded candidates survive, so that a
// downstream consumer which merges or excludes them can be checked against a
// stored set instead of against a console log.
const candFresh = JSON.parse(JSON.stringify(cand));
close(storedCand, candFresh, 'physicalCandidates');
assert.strictEqual(storedCand.candidates.length, storedCand.totalCandidates, 'every enumerated candidate is listed');
assert.strictEqual(storedCand.feasibleCandidates, storedCand.candidates.filter(c => c.feasible).length, 'feasible count matches the list');
assert.strictEqual(storedCand.designSpace.sha256, stored.designSpace.sha256, 'candidate set comes from the same design space as the winner');
// The fingerprint is over the scored set, not over the file: re-serializing the
// same candidates in another order must not change it.
assert.strictEqual(cand.candidateSetSha256, storedCand.candidateSetSha256, 'fingerprint is not stable across runs');
assert.strictEqual(storedCand.candidateSetSha256, (() => {
  const canon = [...storedCand.candidates].reverse().map(c => ({
    pick: Object.fromEntries(Object.entries(c.pick).sort(([p], [q]) => (p < q ? -1 : 1))),
    feasible: c.feasible, violations: [...c.violations].sort(),
    dieAreaMm2: Number(c.dieAreaMm2.toFixed(9)), diePowerW: Number(c.diePowerW.toFixed(9)),
    cardPowerW: Number(c.cardPowerW.toFixed(9)), packageAreaMm2: Number(c.packageAreaMm2.toFixed(9)),
    reserveMm2: Number(c.reserveMm2.toFixed(9)),
    tpsPerUser: c.tpsPerUser === null ? null : Number(c.tpsPerUser.toFixed(9))
  }));
  canon.sort((a, b) => (JSON.stringify(a.pick) < JSON.stringify(b.pick) ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
})(), 'fingerprint depends on enumeration order');

// 8. The document quotes the design, the sensitivities and the analysis.
// The comparison is normalized on both sides for things that are not claims
// about the search: markdown emphasis (the documents bold the numbers that
// carry the argument), the real minus sign U+2212 the documents use, and the
// trailing digits a fixed-width column adds. What the assertion is for is that
// a number the generator produced appears in section 3 at all.
const norm = s => s.replace(/-/g, '−').replace(/\*\*/g, '');
const doc = (() => {
  const text = fs.readFileSync('teams/hardware/docs/09_PACKAGE_POWER_RAS.md', 'utf8');
  const start = text.indexOf('## 3. 封装/功耗设计空间与搜索');
  const end = text.indexOf('\n## 4. 功耗', start);
  assert(start >= 0 && end > start, '09 section 3 must exist');
  const section = norm(text.slice(start, end));
  return s => section.includes(norm(s));
})();
const f2 = (v, n = 2) => (v === null || v === undefined ? '—' : v.toFixed(n));
const f3 = (v, n = 3) => (v === null || v === undefined ? '—' : v.toFixed(n));
const must = [
  ['candidates', `${stored.designSpace.candidates} 个组合、${stored.designSpace.feasible} 个可行`],
  ...Object.entries(stored.design).map(([d, v]) => [`design ${d}`, `| \`${d}\` | \`${v.option}\` |`]),
  ['die area/power', `${f3(ev.dieAreaMm2)} mm² / ${f3(ev.diePowerW)} W`],
  ['card', `卡 ${f3(ev.cardPowerW)} W`],
  ['package', `裸片 ${f3(ev.packageAreaMm2)} mm²`],
  ['shoreline', `shoreline ${f3(ev.shorelineMm)} / ${f3(ev.edgeBudgetMm)} mm`],
  ['conservation', `\`${f3(con.placedMm2, 3)} + ${f3(con.keepOutMm2, 3)} = ${f2(con.windowMm2, 0)}\``],
  ['die margin', `**${f3(ev.diePowerLimitW - ev.diePowerW)} W**`],
  ['card margin', `**${f3(ev.cardPowerLimitW - ev.cardPowerW)} W**`],
  ['port area', `357.565 + ${f3(portAreaMm2)} = ${f3(ev.dieAreaMm2)} mm²`],
  ['port power', `280.530 + ${f3(portPowerW)} = ${f3(ev.diePowerW)} W`],
  ...an.process.map(r => [`process ${r.process}`, `| \`${r.process}\` | ${f3(r.dieAreaMm2)} | ${f3(r.packageAreaMm2)} | ${f3(r.reserveMm2)} | ${f3(r.cardPowerW)} |`]),
  ...an.cooling.map(r => [`cooling ${r.cooling}`, `| \`${r.cooling}\` | ${f3(r.diePowerW)} / ${r.diePowerLimitW} | ${f3(r.cardPowerW)} / ${r.cardPowerLimitW} | ${f3(r.diePowerMarginW)} |`]),
  ...an.matrix.map(r => [`matrix ${r.matrixTFPerMm2}`, `| \`${r.matrixTFPerMm2}\` | ${f3(r.matrixAreaMm2)} | ${f3(r.dieAreaMm2)} | ${f3(r.reserveMm2)} |`]),
  ...an.reserve.map(r => [`keep-out ${r.reserveFraction}`, `| \`${f2(r.reserveFraction, 4)}\` | ${f3(r.reserveMm2)} |`]),
  ...Object.entries(alt).flatMap(([d, opts]) => Object.entries(opts).map(([n, v]) => [`alt ${d}.${n}`,
    `| \`${d}\` | \`${n}\` | ${v.chosen ? '**选中**' : v.lostOn.startsWith('infeasible') ? `\`${v.lostOn}\`` : v.lostOn} | `
    + `${f3(v.dieAreaMm2)} | ${f3(v.packageAreaMm2)} | ${f3(v.reserveMm2)} | ${f3(v.diePowerW)} | ${f3(v.cardPowerW)} |`]))
];
const missing = must.filter(([, v]) => !doc(v));
assert.deepStrictEqual(missing, [], `09_PACKAGE_POWER_RAS.md section 3 is stale; rerun npm run physical:search and update:\n${missing.map(([k, v]) => `${k}: ${v}`).join('\n')}`);

console.log(`PASS physical design: ${stored.designSpace.feasible} feasible of ${stored.designSpace.candidates} candidates; winner `
  + `${Object.values(stored.design).map(v => v.option).join(' / ')}; die ${f3(ev.dieAreaMm2)} mm2 / ${f3(ev.diePowerW)} W, `
  + `card ${f3(ev.cardPowerW)} W, reserve ${f3(ev.reserveMm2)} mm2; only the winner is in out/`);
