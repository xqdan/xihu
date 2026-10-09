'use strict';
// SRAM/TMA design search (teams/hardware/docs/03_TMA_AND_SRAM.md section 8): the
// stored artifact is the winner of a fresh search over the HW-03 design space and
// holds no alternatives; the winner satisfies the contract entry the space declares
// (B-SRAM-CAP on the shared window, the contract target on the replay) inside
// B-AREA's envelope; the published point is a result, not the requirement; the
// candidate set is persisted beside the winner with a stable fingerprint; the
// document quotes the design, the sweeps and the per-option comparison.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const S = require('../../integration/detailed/sram_search.js');
const A = require('../../integration/detailed/k3_architecture_search.js');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');

const stored = JSON.parse(fs.readFileSync('out/detailed/sram_design.json', 'utf8'));
const storedCand = JSON.parse(fs.readFileSync('out/detailed/sram_candidates.json', 'utf8'));
const space = JSON.parse(fs.readFileSync(S.SPACE_FILE, 'utf8'));

// 1. The artifact is a fresh build; TECH/OPT are left untouched (the port-scaling
// option patches O.OPT for each replay and must restore it).
const techBefore = JSON.stringify(A.TECH), optBefore = JSON.stringify(O.OPT);
const result = S.search();
const fresh = JSON.parse(JSON.stringify(S.build(result)));
const cand = S.candidates(result);
const alt = S.alternatives(result), an = S.analysis(result);
assert.strictEqual(JSON.stringify(A.TECH), techBefore, 'search must not change A.TECH');
assert.strictEqual(JSON.stringify(O.OPT), optBefore, 'search must restore O.OPT');
const close = (a, b, path) => {
  if (typeof a === 'number' && typeof b === 'number') return assert(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${path}: ${a} vs ${b}`);
  if (a && typeof a === 'object') {
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(a)) close(a[k], b[k], `${path}.${k}`);
    return;
  }
  assert.strictEqual(a, b, path);
};
close(stored, fresh, 'sramDesign');
assert(!/FROZEN/.test(stored.status.replace('not FROZEN', '')), 'the design is a MODEL result, not FROZEN');
assert.strictEqual(stored.designSpace.sha256, crypto.createHash('sha256').update(fs.readFileSync(S.SPACE_FILE)).digest('hex'), 'design space hash');

// 2. out/ holds only the final design.
assert.deepStrictEqual(Object.keys(stored.design), Object.keys(space.dimensions), 'one entry per searched dimension');
for (const [d, v] of Object.entries(stored.design)) assert(v.option in space.dimensions[d].options, `${d}: ${v.option} is not in the design space`);
assert.deepStrictEqual(Object.keys(stored.ruled), Object.keys(space.ruled));
for (const v of Object.values(stored.ruled)) assert(!('alternatives' in v), 'ruled alternatives stay in the design space');
assert(!/"(alternatives|candidates|perOption|sweep|capacitySweep|localSweep)"\s*:\s*[[{]/.test(JSON.stringify(stored)), 'no alternative lists in out/');
assert(stored.designSpace.feasible > 0 && stored.designSpace.feasible <= stored.designSpace.candidates);
// The published value of every searched dimension is an option, so "the search did not
// consider the published point" cannot be the reason it lost.
const pubPick = S.publishedPick(result.ctx);
for (const [d, n] of Object.entries(pubPick)) assert(n in space.dimensions[d].options, `${d}: the published value must be an option`);

// 3. The winner satisfies the clause the space declares, the contract target, and
// B-AREA's envelope -- on the port-charged figures.
const ev = stored.evaluation, req = stored.requirements;
assert.strictEqual(req.contractEntry, 'B-SRAM-CAP', 'the sram domain answers for the shared-window entry');
assert.strictEqual(stored.clause.id, req.contractEntry, 'the clause scored is the one the space declares');
assert.strictEqual(stored.clause.quantity, 'sharedMiBPerDie');
assert(ev.sharedMiB >= stored.clause.min, 'the winning window meets B-SRAM-CAP');
assert.strictEqual(ev.sharedMiB, space.dimensions.sharedMiB.options[stored.design.sharedMiB.option].sharedMiB);
assert(ev.k3System.tpsPerUser >= ev.k3System.contractTargetTpsPerUser - 1e-9, 'K3 TPS reaches the contract target');
assert.strictEqual(ev.k3System.contractTargetTpsPerUser, stored.contract.target.tpsPerUser, 'the target tested is the contract\'s own');
assert(ev.dieAreaMm2 <= req.limits.dieAreaMm2 && ev.diePowerW <= req.limits.diePowerW && ev.cardPowerW <= req.limits.cardPowerW, 'within B-AREA');
// The replay of the stored hardware with the stored OPT patch reproduces the evaluation.
const saved = {...O.OPT};
let again;
Object.assign(O.OPT, stored.hardware.opt);
try { again = O.evaluate(stored.hardware.x); } finally { Object.assign(O.OPT, saved); }
assert(again.feasible, 'the stored hardware replays');
close(again.tps, ev.k3System.tpsPerUser, 'replayed TPS');
close(again.p.dieArea, ev.dieAreaMm2, 'replayed die area includes the port charge');
for (const k of Object.keys(stored.hardware.publishedX)) {
  if (['sharedMiB', 'lBanks', 'hBanks', 'sharedSlices', 'tmaEngines'].includes(k)) continue;
  assert.strictEqual(stored.hardware.x[k], stored.hardware.publishedX[k], `${k}: only this space's dimensions move`);
}

// 4. The published point is not the requirement. Its SRAM combination is feasible
// under the contract, and the winner is strictly cheaper; if the search ever returns
// the published combination, either the contract or the space changed and the
// document's reading (section 8.1) has to be rewritten.
const P = an.published;
assert(P.feasible, 'the published SRAM combination satisfies the contract');
close(P.tpsPerUser, stored.evaluation.k3System.publishedTpsPerUser, 'the published combination replays the published TPS');
assert(P.rank > 1 && P.winnerSavesMm2 > 0, 'the winner is cheaper than the published combination');
assert(ev.k3System.tpsPerUser < ev.k3System.publishedTpsPerUser, 'the winner spends TPS margin the published point carries');

// 5. The clause binds on its own dimension: a window below the floor is infeasible
// for that reason and is not replayed, and the clause sweep shows it is the contract,
// not this replay, that rules there.
for (const [n, o] of Object.entries(space.dimensions.sharedMiB.options)) {
  if (o.sharedMiB >= stored.clause.min) continue;
  const v = alt.sharedMiB[n];
  assert(!v.feasible && v.violations.includes('belowContractCapacity') && !v.replayed, `sharedMiB ${n} is below the clause and must say so without a replay`);
}
for (const r of an.capacitySweep) {
  const h = result.ctx.holdsBySharedMiB.find(e => e.sharedMiB === r.sharedMiB);
  assert.strictEqual(r.contractHolds, h.holds);
  assert.strictEqual(r.aboveFloor, r.sharedMiB >= stored.clause.min);
}
assert(an.capacitySweep.some(r => !r.contractHolds && r.tpsPerUser >= stored.contract.target.tpsPerUser),
  'some below-floor window replays above the target at the published compute; the clause, not the replay, rules it out');

// 6. The ruled local capacity is a number: the published size is the smallest that
// fits, and every larger size is area at the same TPS/usr.
const local = an.localSweep, chosen = local.find(r => r.chosen);
assert(chosen && chosen.feasible && chosen.lMiB === stored.hardware.x.lMiB && chosen.hMiB === stored.hardware.x.hMiB);
for (const r of local) {
  if (r.chosen) continue;
  if (r.feasible) {
    close(r.tpsPerUser, chosen.tpsPerUser, `local L${r.lMiB}/H${r.hMiB}: same TPS`);
    assert(r.dieAreaMm2 > chosen.dieAreaMm2, `local L${r.lMiB}/H${r.hMiB}: larger and more area`);
  } else assert(r.lMiB < chosen.lMiB || r.hMiB < chosen.hMiB, `local L${r.lMiB}/H${r.hMiB}: only a smaller size may fail`);
}

// 7. Every option loses on a stated criterion with the other dimensions at the winner.
for (const [d, opts] of Object.entries(alt)) {
  assert.deepStrictEqual(Object.keys(opts), Object.keys(space.dimensions[d].options), `${d}: every option is scored`);
  for (const [n, v] of Object.entries(opts)) {
    assert.strictEqual(v.chosen, n === stored.design[d].option);
    if (v.chosen) { assert.strictEqual(v.lostOn, null); continue; }
    assert(v.lostOn && v.lostOn !== 'tie', `${d}.${n} must lose on a criterion`);
  }
}

// 8. The candidate set: every enumerated candidate listed, the search's order holds,
// the exclusions are counted by cause, and the fingerprint does not depend on order.
close(storedCand, JSON.parse(JSON.stringify(cand)), 'sramCandidates');
const cands = storedCand.candidates;
assert.strictEqual(cands.length, storedCand.totalCandidates, 'every enumerated candidate is listed');
assert.strictEqual(storedCand.totalCandidates, stored.designSpace.candidates);
assert.strictEqual(storedCand.feasibleCandidates, stored.designSpace.feasible);
assert.strictEqual(storedCand.designSpace.sha256, stored.designSpace.sha256, 'candidate set comes from the same design space as the winner');
assert.strictEqual(cands.filter(c => c.chosen).length, 1);
assert(cands[0].chosen && cands[0].lostOn === null, 'the winner ranks first');
for (let i = 1; i < cands.length; i++) {
  const a = cands[i - 1], b = cands[i];
  assert(a.feasible >= b.feasible, `candidate ${i} ranks a feasible candidate below an infeasible one`);
  if (a.feasible && b.feasible) assert(a.dieAreaMm2 <= b.dieAreaMm2 + 1e-9, `candidate ${i} breaks the die-area ranking`);
}
assert(cands.every(c => c.optionId === Object.entries(c.pick).map(([d, n]) => `${d}=${n}`).join('|')));
assert(cands.every(c => c.replayed || c.violations.includes('belowContractCapacity')), 'only a below-clause window skips the replay');
const causes = {};
for (const c of cands) if (!c.feasible) for (const v of c.violations) causes[v] = (causes[v] || 0) + 1;
assert.deepStrictEqual(storedCand.infeasibleByCause, causes, 'the exclusion histogram covers every infeasible candidate');
assert(causes.belowContractCapacity > 0, 'the contract clause this space is bound by must appear in the histogram');
assert.strictEqual(storedCand.candidateSetSha256, S.fingerprint([...cands].reverse()), 'fingerprint depends on enumeration order');

// 9. The document quotes the design, the sweeps and the comparison.
const norm = s => s.replace(/-/g, '−').replace(/\*\*/g, '');
const doc = (() => {
  const text = fs.readFileSync('teams/hardware/docs/03_TMA_AND_SRAM.md', 'utf8');
  const start = text.indexOf('## 8. SRAM 设计空间与搜索');
  const end = text.indexOf('\n## 9. 冻结交付物', start);
  assert(start >= 0 && end > start, '03 section 8 must exist');
  const section = norm(text.slice(start, end));
  return s => section.includes(norm(s));
})();
const f = (v, n) => (v === null || v === undefined ? '—' : v.toFixed(n));
const f2 = v => f(v, 2), f3 = v => f(v, 3);
const res = v => (v.chosen ? '**选中**' : `\`${v.lostOn}\``);
const by = (d, n) => alt[d][n];
const pubOpt = Object.values(pubPick).join(' / ');
const must = [
  ['space hash', stored.designSpace.sha256.slice(0, 12)],
  ['clause', `≥ ${stored.clause.min} MiB`],
  ['counts', `搜索共 ${cand.totalCandidates} 个组合、${cand.replayedCandidates} 个回放、${cand.feasibleCandidates} 个可行`],
  ...Object.entries(cand.infeasibleByCause).map(([k, n]) => [`cause ${k}`, `| \`${k}\` | ${n} |`]),
  ...Object.entries(stored.design).map(([d, v]) => [`design ${d}`, `| \`${d}\` | \`${v.option}\` |`]),
  ['replay', `K3 回放 ${f2(ev.k3System.tpsPerUser)} TPS/usr（发布值 ${f2(ev.k3System.publishedTpsPerUser)}），raw ${f2(ev.k3System.rawLatencyUs)} µs`],
  ['margins', `高于合同目标 ${an.margins.targetTpsPerUser} 共 ${f2(an.margins.aboveTarget)}，低于架构门 ${an.margins.architectureGate} 共 ${f2(-an.margins.aboveGate)}`],
  ['die', `Die ${f3(ev.dieAreaMm2)} mm² / ${f3(ev.diePowerW)} W，卡 ${f3(ev.cardPowerW)} W`],
  ['port', `计费 ${f3(ev.portAreaMm2)} mm²`],
  ['published', `（\`${pubOpt}\`）在搜索中排第 ${P.rank} 名`],
  ['published delta', `比最终方案多 ${f3(P.winnerSavesMm2)} mm²、${f3(P.winnerSavesW)} W，多换来 ${f2(P.tpsGivenUp)} TPS/usr`],
  ...an.capacitySweep.map(r => [`capacity ${r.sharedMiB}`, `| ${r.sharedMiB} | ${r.contractHolds ? '成立' : '不成立'} | ${f2(r.tpsPerUser)} | ${f3(r.dieAreaMm2)} |`]),
  ...local.map(r => [`local ${r.lMiB}/${r.hMiB}`, `| ${r.lMiB} | ${r.hMiB} | ${f2(r.tpsPerUser)} | ${f3(r.dieAreaMm2)} | `
    + `${r.chosen ? '**选中**' : r.feasible ? '面积' : r.violations.map(v => `\`${v}\``).join(', ')} |`]),
  ...Object.entries(alt).flatMap(([d, opts]) => Object.entries(opts).map(([n, v]) => [`alt ${d}.${n}`,
    `| \`${d}\` | \`${n}\` | ${res(v)} | ${f2(v.tpsPerUser)} | ${f3(v.dieAreaMm2)} | ${f3(v.diePowerW)} | ${f3(v.cardPowerW)} |`])),
];
// The prose deltas of section 8.4 are quoted only while the options they name are not the winner.
const W = result.best.pick;
if (W.sharedPortScaling === 'off') {
  const p = by('sharedPortScaling', 'published');
  must.push(['port delta', `只换来 ${f2(p.tpsPerUser - ev.k3System.tpsPerUser)} TPS/usr，却要 ${f3(p.dieAreaMm2 - ev.dieAreaMm2)} mm²`]);
}
if (W.lBanks === '16') {
  const l = by('lBanks', '32');
  must.push(['lBanks delta', `\`lBanks 32\` 只多 ${f2(l.dieAreaMm2 - ev.dieAreaMm2)} mm² 就多 ${f2(l.tpsPerUser - ev.k3System.tpsPerUser)} TPS/usr`]);
}
const missing = must.filter(([, v]) => !doc(v));
assert.deepStrictEqual(missing, [], `03_TMA_AND_SRAM.md section 8 is stale; rerun npm run sram:search and update:\n${missing.map(([k, v]) => `${k}: ${v}`).join('\n')}`);

console.log(`PASS sram design: ${stored.designSpace.feasible} feasible of ${stored.designSpace.candidates} candidates; winner `
  + `${Object.values(stored.design).map(v => v.option).join(' / ')}; ${f3(ev.dieAreaMm2)} mm2, ${f2(ev.k3System.tpsPerUser)} TPS `
  + `(published ${f3(P.dieAreaMm2)} mm2 ranks ${P.rank}); only the winner is in out/`);
