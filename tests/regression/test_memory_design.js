'use strict';
// Memory Cube design search (teams/hardware/docs/04_MEMORY_SUBSYSTEM_MC.md
// section 5.1): the stored artifact is the winner of a fresh search over the
// HW-04 design space and holds no alternatives; the winner keeps the published
// K3 replay; capacity is a floor that the winner clears without being bound by
// it; the link, not the cube, is the limit; a route the search did not model is
// excluded by violation rather than losing on price; the ranking never rewards a
// more optimistic unverified premise; the candidate set is persisted beside the
// winner with a stable fingerprint; the document quotes the design, the sweeps
// and the analysis.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const S = require('../../integration/detailed/memory_search.js');
const A = require('../../integration/detailed/k3_architecture_search.js');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');

const stored = JSON.parse(fs.readFileSync('out/detailed/memory_design.json', 'utf8'));
const storedCand = JSON.parse(fs.readFileSync('out/detailed/memory_candidates.json', 'utf8'));
const space = JSON.parse(fs.readFileSync(S.SPACE_FILE, 'utf8'));

// 1. The artifact is a fresh build; TECH/OPT/mappedPlan are left untouched.
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
close(stored, fresh, 'memoryDesign');
assert(!/FROZEN/.test(stored.status.replace('not FROZEN', '')), 'the design is a MODEL result, not FROZEN');
assert.strictEqual(stored.designSpace.sha256, crypto.createHash('sha256').update(fs.readFileSync(S.SPACE_FILE)).digest('hex'), 'design space hash');

// 2. out/ holds only the final design.
assert.deepStrictEqual(Object.keys(stored.design), Object.keys(space.dimensions), 'one entry per searched dimension');
for (const [d, v] of Object.entries(stored.design)) assert(v.option in space.dimensions[d].options, `${d}: ${v.option} is not in the design space`);
assert.deepStrictEqual(Object.keys(stored.ruled), Object.keys(space.ruled));
for (const v of Object.values(stored.ruled)) assert(!('alternatives' in v), 'ruled alternatives stay in the design space');
assert(!/"(alternatives|candidates|perOption|sweep)"\s*:\s*[[{]/.test(JSON.stringify(stored)), 'no alternative lists in out/');
assert(stored.designSpace.feasible > 0 && stored.designSpace.feasible <= stored.designSpace.candidates);

// 3. The winner keeps the published K3 replay, and the capacity floor is the one
// the replay reports rather than a number typed into the requirements block.
const ev = stored.evaluation, req = stored.requirements;
assert(ev.k3System.tpsPerUser >= ev.k3System.publishedTpsPerUser * (1 - req.tpsTolerance), 'K3 TPS within tolerance');
assert(ev.k3System.tpsPerUser > 0 && ev.k3System.rawLatencyUs > 0, 'the winner carries a replay');
close(req.capacityFloorGBPerRank, an.capacityFloorGB, 'the floor is the replay backing requirement');
assert.strictEqual(req.capacityFloorGBPerRank, result.ctx.capacityFloorGB, 'the artifact must carry the searched floor');
assert(req.capacityFloorGBPerRank > 49 && req.capacityFloorGBPerRank < 50, 'the K3 per-rank backing floor is about 49.2 GB');
// The die-side bandwidth is what the link delivers, capped by the port.
const dieGBs = result.ctx.cubesPerComputeDie * Math.min(ev.mcGBs * A.TECH.mcUtil, S.evaluate(result.ctx, Object.fromEntries(Object.entries(stored.design).map(([d, v]) => [d, v.option])), req).uciePortGBs);
close(ev.dieGBs, dieGBs, 'die bandwidth is the cube count times the capped per-cube rate');
assert(ev.packageAreaMm2 <= req.placementWindowMm2, 'package within the placement window');
assert(ev.cardPowerW <= req.cardPowerLimitW, 'card power within its limit');
// This domain's card power is 8 x die + MC + the fixed 80 W; it does not charge
// the shared-port term the physical domain adds (45.5141376 W), which is why the
// two domains publish 2722.9593600 and 2768.4734976 W for the same point.
const replayed = result.ctx.replays[ev.mcGBs];
close(ev.cardPowerW, result.ctx.dies * replayed.diePowerW + ev.mcPowerW + 80, 'card power is the compute dies plus the MC term plus the fixed overhead');
assert.strictEqual(Math.round((ev.cardPowerW + 45.5141376) * 1e6) / 1e6, 2768.473498, 'the two domains differ by exactly the shared-port charge');
assert.strictEqual(ev.areaReserveMm2, req.placementWindowMm2 - ev.packageAreaMm2, 'the reserve is what the window has left');

// 4. Capacity is a floor the winner clears without being bound by it. This is
// the claim the document makes in section 3 ("performance is set by bandwidth,
// not by capacity"), and it is only true if the floor needs fewer cubes than the
// winner carries.
assert(an.cubesFloor < stored.design.cubesPerCard.cubes, 'the capacity floor must need fewer cubes than the winner carries');
close(an.cubesFloor, Math.ceil(an.capacityFloorGB / space.dimensions.capacityGBPerCube.options['16'].capacityGB), 'the floor in cubes');
assert(ev.capacityMarginGB > 0, 'the winner clears the floor');
close(ev.capacityGBPerCard, stored.design.cubesPerCard.cubes * stored.design.capacityGBPerCube.capacityGB * (1 - stored.design.eccOverhead.overhead), 'capacity charges the ECC overhead');

// 5. A route the search did not model is excluded by violation, not merely
// outscored. If it were left as an ordinary candidate it could win a tie-break
// while asserting a mechanism no number in the replay reflects.
const heldOut = Object.keys(S.HELD_OUT_ROUTES);
assert(heldOut.length > 0, 'the search must declare its held-out routes');
for (const r of heldOut) {
  const v = alt.route[r];
  assert(!v.chosen, `route ${r} is held out and must not win`);
  assert(v.violations.some(x => x === `routeNotScored:${r}`), `route ${r} must be excluded by violation, got ${JSON.stringify(v.violations)}`);
  assert(an.heldOutRoutes[r] && an.heldOutRoutes[r].scored === false && an.heldOutRoutes[r].needsModelling, `route ${r} must report what it would need to be scored`);
}
// The two routes the dimensions can price are scored, and consistency is a
// constraint rather than a preference: a route that contradicts its own tier or
// cube count is infeasible.
assert(alt.route.mcX.feasible, 'mcX is the scored route the winner takes');
assert(alt.route.moreCubes.violations.includes('routeContradiction:moreCubes-below-the-grid-max'), 'moreCubes below the grid max is a contradiction, not a price');
for (let i = 0; i < 5; i++) {
  const t = Object.keys(space.dimensions.mcGBs.options)[i];
  const e = S.evaluate(result.ctx, {mcGBs: t, route: 'mcX'}, req, result.best.pick);
  if (e.classification === 'REFERENCE') assert(e.violations.includes('routeContradiction:mcX-at-reference-tier'), `${t}: mcX at the reference tier must be a contradiction`);
}
// Every option of every searched dimension is scored, and the chosen one is the
// design's own option.
for (const [d, opts] of Object.entries(alt)) {
  assert.deepStrictEqual(Object.keys(opts), Object.keys(space.dimensions[d].options), `${d}: every option has a best candidate`);
  for (const [n, v] of Object.entries(opts)) {
    assert.strictEqual(v.chosen, n === stored.design[d].option);
    assert.strictEqual(v.pick[d], n, `${d}.${n}: the row must hold its own option`);
    if (v.chosen) { close(v.mcPowerW, ev.mcPowerW, `${d}.${n} MC power`); continue; }
    assert(v.lostOn && v.lostOn !== 'tie', `${d}.${n} must lose on a criterion`);
  }
}
// Holding the other dimensions at the winner is what makes a row's violation
// that option's own doing; a route row varies only the route and therefore can
// only fail on the route.
assert.strictEqual(alt.capacityGBPerCube['8'].pick.capacityGBPerCube, '8', 'the cube capacity row varies only its own dimension');
assert.strictEqual(alt.capacityGBPerCube['8'].pick.mcGBs, stored.design.mcGBs.option, 'the other dimensions stay at the winner');

// 6. The ranking: feasible first, then the manufacturing risk class, then the
// card-level MC power, then the capacity margin. The risk class is what keeps a
// STRETCH_AGGRESSIVE tier from being reported as equivalent to a reference part.
const cand = S.candidates(result), cands = cand.candidates;
assert.strictEqual(cands.filter(c => c.chosen).length, 1, 'exactly one candidate is the winner');
assert.deepStrictEqual(cands.find(c => c.chosen).pick, Object.fromEntries(Object.entries(stored.design).map(([d, v]) => [d, v.option])));
assert.strictEqual(cands.filter(c => c.feasible).length, cand.feasibleCandidates, 'feasible count matches the list');
for (let i = 1; i < cands.length; i++) {
  const a = cands[i - 1], b = cands[i];
  assert(a.feasible >= b.feasible, `candidate ${i} ranks a feasible candidate below an infeasible one`);
  if (a.feasible && b.feasible) {
    assert(a.risk <= b.risk, `candidate ${i} ranks a riskier tier above a safer one`);
    if (a.risk === b.risk) assert(a.mcPowerW <= b.mcPowerW + 1e-9, `candidate ${i} breaks the MC power ranking`);
  }
  if (b.feasible) assert(b.tpsPerUser > 0, `candidate ${i} has no replay`);
}
// The published tier is the aggressive one, so the safer tiers must lose on
// something other than risk alone -- they lose on the replay.
const published = space.dimensions.mcGBs.options[String(stored.hardware.publishedTier)];
assert.strictEqual(stored.design.mcGBs.classification, published.classification, 'the winner is at the published tier');
for (const t of Object.keys(space.dimensions.mcGBs.options)) {
  const o = space.dimensions.mcGBs.options[t];
  if (t === String(stored.hardware.publishedTier)) continue;
  const v = S.evaluate(result.ctx, {mcGBs: t}, req, result.best.pick);
  assert(!v.feasible, `tier ${t} with the winner's other options must be infeasible`);
  assert(v.violations.includes('k3Tps'), `tier ${t} must fail on the replay`);
}

// 7. The candidate set is persisted next to the winner with a reproducible
// fingerprint. The design artifact deliberately holds no candidate list (see
// section 2); this file is where the excluded candidates survive, so that a
// downstream consumer which merges or excludes them can be checked against a
// stored set instead of against a console log.
const candFresh = JSON.parse(JSON.stringify(cand));
close(storedCand, candFresh, 'memoryCandidates');
assert.strictEqual(storedCand.candidates.length, storedCand.totalCandidates, 'every enumerated candidate is listed');
assert.strictEqual(storedCand.designSpace.sha256, stored.designSpace.sha256, 'candidate set comes from the same design space as the winner');
assert.strictEqual(cand.candidateSetSha256, storedCand.candidateSetSha256, 'fingerprint is not stable across runs');
assert.strictEqual(storedCand.candidateSetSha256, (() => {
  const canon = [...storedCand.candidates].reverse().map(c => ({
    pick: Object.fromEntries(Object.entries(c.pick).sort(([p], [q]) => (p < q ? -1 : 1))),
    feasible: c.feasible, violations: [...c.violations].sort(), cubesPerCard: c.cubesPerCard,
    capacityGBPerCard: Number(c.capacityGBPerCard.toFixed(9)), dieGBs: Number(c.dieGBs.toFixed(9)),
    mcPowerW: Number(c.mcPowerW.toFixed(9)), cardPowerW: Number(c.cardPowerW.toFixed(9)),
    tpsPerUser: c.tpsPerUser === null ? null : Number(c.tpsPerUser.toFixed(9))
  }));
  canon.sort((a, b) => (JSON.stringify(a.pick) < JSON.stringify(b.pick) ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
})(), 'fingerprint depends on enumeration order');

// 8. The document quotes the design, the sweeps and the analysis. The
// comparison is normalized on both sides for markdown emphasis and the real
// minus sign, neither of which is a claim about the search.
const norm = s => s.replace(/-/g, '−').replace(/\*\*/g, '');
const doc = (() => {
  const text = fs.readFileSync('teams/hardware/docs/04_MEMORY_SUBSYSTEM_MC.md', 'utf8');
  const start = text.indexOf('### 5.1 MC 设计空间与搜索');
  const end = text.indexOf('\n## 6. MC 控制器功能', start);
  assert(start >= 0 && end > start, '04 section 5.1 must exist');
  const section = norm(text.slice(start, end));
  return s => section.includes(norm(s));
})();
const f1 = (v, n = 1) => (v === null || v === undefined ? '—' : v.toFixed(n));
const f2 = (v, n = 2) => (v === null || v === undefined ? '—' : v.toFixed(n));
const must = [
  ['candidates', `${stored.designSpace.candidates} 个组合、${stored.designSpace.feasible} 个可行`],
  ...Object.entries(stored.design).map(([d, v]) => [`design ${d}`, `| \`${d}\` | \`${v.option}\` |`]),
  ['replay', `K3 回放 ${f2(ev.k3System.tpsPerUser)} TPS/usr（发布值 ${f2(ev.k3System.publishedTpsPerUser)}）`],
  ['raw', `raw ${f2(ev.k3System.rawLatencyUs)} µs`],
  ['die bandwidth', `Die 侧 ${ev.dieGBs} GB/s`],
  ['capacity', `卡级容量 ${ev.capacityGBPerCard} GB（余量 ${f1(ev.capacityMarginGB)} GB）`],
  ['MC power', `MC 功耗 ${f2(ev.mcPowerW)} W`],
  ['card power', `卡功耗 ${f2(ev.cardPowerW)} W`],
  ['floor', `${f1(an.capacityFloorGB, 3)} GB/rank 只需 ${an.cubesFloor} 颗`],
  ...an.sweep.map(r => [`sweep ${r.mcGBs}`, `| ${r.mcGBs} | \`${r.classification}\` | ${r.dieGBs} | ${f2(r.mcPowerW)} | ${f2(r.cardPowerW)} | ${f2(r.tpsPerUser)} |`]),
  ...an.cubesSweep.map(r => [`cubes ${r.cubesPerCard}`, `| ${r.cubesPerCard} | ${r.capacityGBPerCard} | ${f1(r.packageAreaMm2)} | ${f1(r.areaReserveMm2)} |`]),
  ...Object.entries(alt).flatMap(([d, opts]) => Object.entries(opts).map(([n, v]) => [`alt ${d}.${n}`,
    `| \`${d}\` | \`${n}\` | ${v.chosen ? '**选中**' : `\`${v.lostOn}\``} | ${Object.values(v.pick).join(' / ')} | `
    + `${v.dieGBs} | ${v.capacityGBPerCard} | ${f2(v.mcPowerW)} | ${f2(v.tpsPerUser)} |`])),
  ...Object.entries(an.heldOutRoutes).map(([r, v]) => [`held out ${r}`, `| \`${r}\` | ${v.needsModelling.replace(/: /, '；')}`])
];
const missing = must.filter(([, v]) => !doc(v));
assert.deepStrictEqual(missing, [], `04_MEMORY_SUBSYSTEM_MC.md section 5.1 is stale; rerun npm run memory:search and update:\n${missing.map(([k, v]) => `${k}: ${v}`).join('\n')}`);

console.log(`PASS memory design: ${stored.designSpace.feasible} feasible of ${stored.designSpace.candidates} candidates; winner `
  + `${Object.values(stored.design).map(v => v.option).join(' / ')}; die ${ev.dieGBs} GB/s, ${ev.capacityGBPerCard} GB/card `
  + `(margin ${f1(ev.capacityMarginGB)} GB), MC ${f2(ev.mcPowerW)} W, K3 ${f2(ev.k3System.tpsPerUser)} TPS; only the winner is in out/`);
