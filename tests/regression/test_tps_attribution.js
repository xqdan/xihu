'use strict';
// TPS/usr attribution cards (teams/council/docs/23_DESIGN_QUESTION_WORKFLOW_PROPOSAL.md, L4).
// The cards are rebuilt through the production model and must equal the stored ones; the numbers
// they share with tpsDesign (published point, mechanism ablations, joint pessimistic replays,
// break-evens, tau headroom) must agree with it, so a card can never drift into a second baseline.
// The stored cards are rebuilt at the point design_point.js resolves; the tpsDesign checks run at
// the published point, and a card at the coupling artifact's joint row must replay that row.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const T = require('../../integration/detailed/tps_attribution.js');
const DP = require('../../integration/pipelines/design_point.js');

const text = fs.readFileSync(T.BASELINE_FILE, 'utf8');
const spec = JSON.parse(text);
const td = spec.tpsDesign;
const near = (a, b, what, tol = 1e-9) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const published = DP.resolve({point: 'published', baselineText: text});
const ctx = T.context({text, point: published});
const resolved = DP.resolve({point: 'auto', baselineText: text});
const storedCtx = resolved.kind === 'published' ? ctx : T.context({text, point: resolved});

near(ctx.base.tpsPerUser, td.point.tpsPerUser, 'published TPS');
near(ctx.base.rawUs, td.point.rawLatencyUs, 'published raw');

const cards = {};
for (const dim of T.DEFAULT_DIMENSIONS) {
  const card = T.build(dim, {context: ctx});
  cards[dim] = card;
  const file = `${T.OUT_DIR}/${dim}_card.json`;
  assert(fs.existsSync(file), `${file} is missing; run npm run attribution:cards`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(stored.inputs.baselineSha256, crypto.createHash('sha256').update(text).digest('hex'), `${file} was built from a different baseline; run npm run attribution:cards`);
  assert.strictEqual(stored.inputs.point.sha256, resolved.sha256, `${file} was built at another design point than ${resolved.source}; run npm run attribution:cards`);
  // Round-trip through JSON so the comparison sees what the generator wrote.
  const rebuilt = storedCtx === ctx ? card : T.build(dim, {context: storedCtx});
  assert.deepStrictEqual(stored, JSON.parse(JSON.stringify(rebuilt)), `${file} is stale; run npm run attribution:cards`);
  assert.strictEqual(card.dimension, dim);
  assert(/^MODEL/.test(card.status), `${dim}: card must declare its evidence level`);
  assert(!/\bPASS\b/.test(JSON.stringify(card)), `${dim}: a card may not carry a gate-like literal`);
  for (const p of card.parameters) {
    assert(p.owner && p.evidence && p.measurementNeeded, `${dim}.${p.name}: owner, evidence and measurementNeeded are required`);
    assert(Object.keys(card.classes).includes(p.classification), `${dim}.${p.name}: classification ${p.classification}`);
  }
  // The name lists are a partition of the rows.
  const listed = Object.keys(card.classes).flatMap(c => card[c] || []);
  assert.deepStrictEqual([...listed].sort(), card.parameters.map(p => p.name).sort(), `${dim}: class lists must partition the parameters`);
}

// Mechanism switch-backs are the ablations tpsDesign publishes.
for (const dim of ['sram', 'comm']) {
  for (const p of cards[dim].parameters.filter(q => q.kind === 'mechanism')) {
    const pub = td.software.mechanisms.find(m => m.key === p.name).ablation;
    const mv = p.moves[0];
    assert.strictEqual(mv.feasible, pub.feasible, `${p.name}: feasibility vs tpsDesign`);
    if (pub.feasible) { near(mv.tpsPerUser, pub.tpsPerUser, `${p.name} ablation TPS`); near(mv.rawUs, pub.rawLatencyUs, `${p.name} ablation raw`); }
  }
  // Every hardware / mapping move list contains the published value.
  for (const p of cards[dim].parameters.filter(q => q.kind === 'hardware' || q.kind === 'mapping')) {
    assert.strictEqual(p.published, td.hardware.x[p.name], `${dim}.${p.name}: published value`);
    assert(p.moves.length >= 1, `${dim}.${p.name}: at least one move`);
  }
}

// Assumption sweeps and break-evens agree with tpsDesign.sensitivity.
const layout = cards.sram.parameters.find(p => p.name === 'layoutImbalance');
assert.deepStrictEqual(JSON.parse(JSON.stringify(layout.breakEven)), td.sensitivity.assumptions.layoutImbalance.breakEven, 'layoutImbalance break-even');
for (const mv of layout.moves) {
  const pub = td.sensitivity.assumptions.layoutImbalance.replays[String(mv.to)];
  assert.strictEqual(mv.feasible, pub.feasible, `layoutImbalance ${mv.to} feasibility`);
  if (pub.feasible) near(mv.tpsPerUser, pub.tpsPerUser, `layoutImbalance ${mv.to}`);
}
const tau = cards.comm.parameters.find(p => p.name === 'tauUs');
near(tau.breakEven.analytic.valueAtBudget, td.sensitivity.tauBreakEvenUs, 'analytic tau break-even');
const basis = cards.comm.parameters.find(p => p.name === 'countBasis');
assert.strictEqual(basis.classification, 'basis');
if (td.software.countBasis.ablation.feasible) near(basis.moves[0].tpsPerUser, td.software.countBasis.ablation.tpsPerUser, 'countBasis ablation');
// The critical-path lines of comm reconcile with commUs (the overlap line is the only negative one).
const commLines = cards.comm.criticalPath.lines.filter(l => l.name !== 'commOverlap').reduce((s, l) => s + l.us, 0);
near(commLines, td.ledger.commUs, 'comm critical-path lines = commUs', 1e-6);
near(cards.comm.criticalPath.collectiveCount, td.ledger.collectives.reduce((s, a) => s + a.count, 0), 'collective count');

// The joint card takes apart exactly the published joint pessimistic points.
const joint = cards.joint;
for (const name of ['compute', 'allUnmeasured']) {
  const pub = td.sensitivity.jointPessimistic[name];
  assert.deepStrictEqual(joint.jointPessimistic[name].values, pub.values, `joint ${name} values`);
  if (pub.replay.feasible) near(joint.jointPessimistic[name].tpsPerUser, pub.replay.tpsPerUser, `joint ${name} TPS`);
}
assert.deepStrictEqual(joint.parameters.map(p => p.name).sort(), Object.keys(td.sensitivity.jointPessimistic.allUnmeasured.values).sort(), 'joint rows = stress keys');
for (const p of joint.parameters) {
  const sweep = td.sensitivity.assumptions[p.name];
  if (sweep && sweep.breakEven) assert.deepStrictEqual(JSON.parse(JSON.stringify(p.breakEven)), sweep.breakEven, `joint ${p.name} break-even`);
  assert(T.DIMENSION_OWNER[p.dimension] === p.owner, `joint ${p.name}: owner follows the dimension`);
}
const holds = joint.jointPessimistic.allUnmeasured.withinBudget;
assert.strictEqual(joint.jointPessimistic.routing.routeTo === null, holds, 'routing is set exactly when the joint point misses the budget');

// Local tile occupancy is computed from the replay against the usable share, not written as a number.
const tile = cards.sram.criticalPath.occupancy.localTile;
for (const [core, cap] of [['lCore', ctx.x.lMiB], ['hCore', ctx.x.hMiB]]) {
  near(tile[core].capacityMiB, cap, `${core} capacity`);
  near(tile[core].shareOfUsable, tile[core].usedMiB / (cap * tile.usable), `${core} share of usable`);
  near(tile[core].shareOfCapacity, tile[core].usedMiB / cap, `${core} share of capacity`);
}
for (const dim of T.DEFAULT_DIMENSIONS) for (const p of cards[dim].parameters) assert(!/\d+(?:\.\d+)?\s*%/.test(`${p.evidence} ${p.note || ''}`), `${dim}.${p.name}: evidence and note may not carry a hand-written percentage`);
// sharedPortScaling only acts through the dedicated port, so its published state names the port scale too.
const port = cards.sram.parameters.find(p => p.name === 'sharedPortScaling');
assert(port.published && 'tmaPortWriteScale' in port.published, 'sharedPortScaling.published must include tmaPortWriteScale');

// Couplings: the cells reuse published replays where tpsDesign has them, and the interaction is the
// arithmetic the caveat states.
const couplings = cards.sram.couplings;
assert(couplings.length > 0, 'sram card must carry couplings');
assert.deepStrictEqual(cards.comm.couplings, [], 'comm declares no couplings');
const small = couplings.find(c => c.name === 'kvTile=16384 x kvCache off');
assert(small, 'kvTile=16384 x kvCache off coupling');
assert.strictEqual(small.both.feasible, td.sensitivity.kvTile16384.bf16.feasible, 'kvTile 16384 x bf16 feasibility');
if (small.both.feasible) near(small.both.tpsPerUser, td.sensitivity.kvTile16384.bf16.tpsPerUser, 'kvTile 16384 x bf16 TPS');
if (small.a.feasible) near(small.a.tpsPerUser, td.sensitivity.kvTile16384.fp8.tpsPerUser, 'kvTile 16384 alone TPS');
for (const c of couplings) {
  assert.strictEqual(c.between.length, 2, `${c.name}: two factors`);
  const labels = c.name.split(' @ ')[0].split(' x ');
  ['a', 'b'].forEach((side, i) => {
    const mech = td.software.mechanisms.find(m => labels[i] === `${m.key} off`);
    // An unshifted mechanism-off cell is that mechanism's published ablation.
    if (mech && !c.at) {
      assert.strictEqual(c[side].feasible, mech.ablation.feasible, `${c.name}.${side}: feasibility vs ablation`);
      if (mech.ablation.feasible) near(c[side].tpsPerUser, mech.ablation.tpsPerUser, `${c.name}.${side}: TPS vs ablation`);
    }
  });
  const cells = [c.a, c.b, c.both, ...(c.at ? [c.at] : [])];
  if (cells.every(m => m.feasible)) near(c.interactionTps, c.both.dTps - c.a.dTps - c.b.dTps + (c.at ? c.at.dTps : 0), `${c.name}: interaction`, 1e-6);
  else assert.strictEqual(c.interactionTps, null, `${c.name}: interaction needs every cell feasible`);
  assert.strictEqual(c.breaksOnlyTogether, c.a.withinBudget && c.b.withinBudget && !c.both.withinBudget, `${c.name}: breaksOnlyTogether`);
}
// The kvCache feasibility wall moves with the H tile: on the published point bf16 does not fit,
// but a smaller head tile or a larger H tile makes it fit (TUNING_CONTRACT.md §2 item 4).
const kvOff = cards.sram.parameters.find(p => p.name === 'kvCache');
assert.strictEqual(kvOff.moves[0].feasible, false, 'bf16 KV is infeasible on the published point');
for (const name of ['headTile=48 x kvCache off', 'hMiB=8 x kvCache off']) {
  const c = couplings.find(q => q.name === name);
  assert(c && c.both.feasible, `${name}: bf16 fits once the H tile has room`);
}
assert(cards.sram.parameters.some(p => p.name === 'headTile' && p.kind === 'mapping'), 'headTile is a mapping row');
// A break-even says what it is bounded by: layoutImbalance runs into the H local tile, not the budget.
assert.strictEqual(layout.breakEvenBy.by, 'feasibility', 'layoutImbalance break-even is a feasibility wall');
assert(layout.breakEvenBy.reasons.some(r => /H local tile/.test(r)), 'layoutImbalance wall is the H local tile');
assert.strictEqual(tau.breakEvenBy.by, 'budget', 'tau break-even is the raw budget');
for (const p of joint.parameters) if (p.breakEven && typeof p.breakEven.valueAtBudget === 'number') assert(p.breakEvenBy, `joint ${p.name}: breakEvenBy`);

// At a joint point (design.coupling's landed row, doc 23 §7.3) the card replays that row exactly:
// its x, OPT patch and model patch (compute unpack / softmax, comm control path), and the model
// state is restored afterwards.
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const coupling = JSON.parse(fs.readFileSync('out/detailed/coupling_candidates.json', 'utf8'));
const row = coupling.candidates.find(c => c.feasible && c.pareto) || coupling.candidates.find(c => c.feasible);
const landed = {optionId: row.optionId, values: JSON.stringify(row), provenance: 'test', x: row.x, opt: row.opt, model: row.model};
const record = {candidateSetSha256: coupling.candidateSetSha256};
const jp = DP.resolve({point: 'joint', baselineText: text, jointPoint: landed, runRecord: record, artifact: coupling});
assert.strictEqual(jp.kind, 'joint');
assert.strictEqual(DP.resolve({point: 'auto', baselineText: text, jointPoint: landed, runRecord: record, artifact: coupling}).kind, 'joint', 'auto takes a landed joint point');
assert(jp.departsFromPublished, 'the joint point departs from the published point');
assert(jp.departures.model.some(d => d.key === 'controlUs'), 'the comm control path is not in the published model');
assert.deepStrictEqual(jp.departures.x.map(d => d.key).sort(), Object.keys(row.x).filter(k => row.x[k] !== td.hardware.x[k]).sort(), 'x departures');
const optBefore = JSON.stringify(O.OPT);
const jctx = T.context({text, point: jp});
near(jctx.base.tpsPerUser, row.tpsPerUser, `${row.optionId}: TPS replays the coupling row`, 1e-12);
near(jctx.base.rawUs, row.rawLatencyUs, `${row.optionId}: raw replays the coupling row`, 1e-12);
assert.strictEqual(jctx.inputs.point.sha256, jp.sha256);
assert.strictEqual(jctx.inputs.software.tauUs, row.opt.tauUs, 'software is read at the joint OPT');
const jcard = T.build('joint', {context: jctx});
near(jcard.published.nominal.tpsPerUser, row.tpsPerUser, 'joint card nominal', 1e-12);
assert.strictEqual(JSON.stringify(O.OPT), optBefore, 'the OPT patch is restored after the card');
// A landed joint point that does not verify is refused, never replaced by the published point.
assert.throws(() => DP.resolve({point: 'auto', baselineText: text, jointPoint: {...landed, opt: {...row.opt, tauUs: 1.0}}, runRecord: record, artifact: coupling}), /does not verify/);
assert.throws(() => DP.resolve({point: 'joint', baselineText: text, jointPoint: landed, runRecord: null, artifact: coupling}), /does not verify/);

// Only the Q-Gate reads attribution cards (the converge criteria, doc 23 §4 L5-b); the D-Gate
// decides the direction before any card exists, and no other governance artifact cites one.
for (const f of fs.readdirSync('out/governance')) {
  const text = fs.readFileSync(`out/governance/${f}`, 'utf8');
  if (f !== 'gate_status.json') assert(!text.includes('out/attribution'), `${f}: only the Q-Gate may depend on an attribution card`);
  else assert(!JSON.stringify(JSON.parse(text).directionGate).includes('out/attribution'), 'the D-Gate must not depend on an attribution card');
}

const f1 = v => (typeof v === 'number' ? v.toFixed(1) : String(v));
console.log(`PASS tps attribution: ${T.DEFAULT_DIMENSIONS.map(d => `${d} ${cards[d].parameters.length} rows`).join(', ')}; `
  + `loadBearing sram [${cards.sram.loadBearing.join(', ')}], comm [${cards.comm.loadBearing.join(', ')}]; `
  + `all-unmeasured ${f1(joint.jointPessimistic.allUnmeasured.tpsPerUser)} -> route ${joint.jointPessimistic.routing.routeTo}; `
  + `joint point ${row.optionId} ${f1(jctx.base.tpsPerUser)} TPS/usr, all-unmeasured ${f1(jcard.jointPessimistic.allUnmeasured.tpsPerUser)} -> route ${jcard.jointPessimistic.routing.routeTo}`);
