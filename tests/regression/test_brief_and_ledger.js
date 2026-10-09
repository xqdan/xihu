'use strict';

// The brief and the ledger: the two things that cross a stage boundary, as code.
// Nothing here may write to the repository -- the ledger is merged in a temp file.
//
// What this pins:
//   * a derived brief satisfies the shipped DesignBrief schema for every covered stage, and
//     carries the stage it was asked for;
//   * every number in it points at the split entry it came from (`<contract>#/split/<id>/<f>`),
//     so there is no second copy of a contract number anywhere;
//   * the card bandwidth is the contract's own per-cube minimum times the package's cubes
//     per die -- not a published baseline point;
//   * profileBinding.mcProfile is hand-authored, never derived from the contract's point:
//     ADR-0021 makes MC640 a stretch tier, and a contract that asks for 640 GB/s per cube
//     must not thereby present MC640 as the manufacturable default;
//   * a contract that is not an L1 budget contract is refused rather than half-read;
//   * the ledger merge keeps what earlier stages established: rejected options and open
//     blockers accumulate, strategy versions merge per agent, re-applying a patch changes
//     nothing, and a patch that re-opens a frozen decision is an error;
//   * a merged ledger that does not satisfy the DesignLedger schema is never written;
//   * the main loop writes the ledger only on a landed run: not on a dry run, not when the
//     files were rejected, and not for a workflow that returns no patch.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MB = require('../../integration/pipelines/make_brief.js');
const LEDGER = require('../../integration/pipelines/design_ledger.js');
const DRIVER = require('../../integration/pipelines/run_workflow.js');

const root = path.resolve(__dirname, '../..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

const stages = MB.coveredStages();
assert.deepStrictEqual(stages, ['direction', 'compute', 'sram', 'mc', 'comm', 'physical', 'coupling'], 'the covered stages are the L1 contract\'s consumers (design.coupling holds all five entries at once)');

// --- the brief is a view of the contract ------------------------------------------------

const baseline = readJson('teams/hardware/inputs/k3_mc_baseline.json');
const frontier = readJson(MB.FRONTIER_FILE);
const split = frontier.splits.find((s) => s.splitId === MB.DEFAULT_SPLIT);
assert(split, `${MB.FRONTIER_FILE} must carry split ${MB.DEFAULT_SPLIT}`);
const contract = split.contract;
const entry = (id) => contract.split.find((e) => e.id === id);

for (const stage of stages) {
  const built = MB.briefFor(stage);
  const brief = built.brief;
  assert.strictEqual(brief.stage, stage, `${stage}: the brief names the stage it was built for`);
  assert.strictEqual(brief.schemaVersion, '1.0', `${stage}: schema version`);
  // briefFor already validates; validating again here is the guard against someone removing
  // that call -- the test must fail on an invalid brief whichever side the check lives on.
  MB.validateBrief(brief);

  // Every derived constraint has to point into the contract file, at a pointer that resolves
  // to the very number the constraint carries. A source that does not resolve is decoration,
  // and one that resolves to something else means the brief holds a second copy of the number.
  for (const c of brief.hardConstraints) {
    assert(c.source && c.source.length, `${stage}: ${c.id} has no source`);
    const [file, pointer] = c.source.split('#');
    if (!pointer) continue;                       // ADR-backed shared constraints
    assert(fs.existsSync(path.join(root, file)), `${stage}: ${c.id} cites ${file}, which does not exist`);
    const resolved = MB.resolvePointer(readJson(file), `#${pointer}`);
    assert.notStrictEqual(resolved, undefined, `${stage}: ${c.id} cites ${c.source}, which resolves to nothing`);
    assert.strictEqual(resolved, c.value, `${stage}: ${c.id} says ${c.value} but ${c.source} holds ${resolved}`);
  }

  // The budget numbers are the entries', not a second copy.
  assert.strictEqual(brief.budget.areaMm2, entry(MB.ENTRY.areaMm2).max, `${stage}: area is B-AREA.max`);
  assert.strictEqual(brief.budget.powerW, entry(MB.ENTRY.areaMm2).limits.diePowerW, `${stage}: die power is B-AREA's die limit`);
  const bw = MB.cardBandwidthGBs(contract, baseline);
  assert.strictEqual(brief.budget.bandwidthGBs, bw.value, `${stage}: card bandwidth`);
  assert.strictEqual(bw.value, baseline.card.memoryCubesPerComputeDie * entry(MB.ENTRY.bandwidthGBs).min,
    `${stage}: the card bandwidth is the contract's per-cube minimum times the package's cubes per die`);

  // ADR-0021: one hardware spec, and MC640 only ever as a stretch tier.
  assert.strictEqual(brief.profileBinding.physicalProfile, 'P1', `${stage}: P1 is the only physical profile`);
  assert.strictEqual(brief.profileBinding.mcProfile, 'MC320',
    `${stage}: the manufacturable binding is hand-authored; deriving it from the contract's point would let a stretch tier present itself as the default (ADR-0021)`);
}

// The contract this brief is actually built from asks for a per-cube bandwidth above the
// manufacturable reference -- which is precisely the case the binding rule exists for. If
// this stops being true the assertion above stops testing anything, so pin it here.
assert(entry(MB.ENTRY.bandwidthGBs).min > 320,
  'the default split asks for more than the MC320 reference; that is what makes the hand-authored binding load-bearing');

// Provenance is kept beside the brief, not inside it: the schema is additionalProperties:false.
const withProvenance = MB.briefFor('compute');
assert(withProvenance.provenance, 'a derived brief carries provenance');
assert.strictEqual(withProvenance.provenance.contract.path, MB.FRONTIER_FILE);
assert.strictEqual(withProvenance.provenance.contract.sha256, MB.sha256(fs.readFileSync(path.join(root, MB.FRONTIER_FILE), 'utf8').replace(/^﻿/, '')));
assert(!Object.hasOwn(withProvenance.brief, 'provenance'), 'provenance is not a brief field');

// A contract that is not an L1 budget contract is refused outright.
assert.throws(() => MB.checkContract({layer: 'L2', schemaVersion: 'budget-contract-v0.1', split: []}, 'test'), /L1/);
assert.throws(() => MB.checkContract({layer: 'L1', schemaVersion: 'budget-contract-v0.1', split: []}, 'test'), /B-AREA|B-MEM-BW/);
assert.throws(() => MB.briefFor('verify'), /no "verify" entry/, 'an uncovered stage is an error, not an empty brief');

// --- the ledger accumulates ---------------------------------------------------------------

const seeded = LEDGER.mergeLedger(LEDGER.emptyLedger(), {
  currentStage: 'req.budget',
  strategyVersions: {'compute-expert': '1.0', architect: '1.0'},
  rejectedOptions: [{stage: 'req.budget', optionId: 'S-TAU', reason: 'unreachable', rejectedBy: 'integrator'}],
  openBlockers: [{id: 'REACH-REQ-BUDGET-01', owner: 'architect', unblockCondition: 'measure tau'}],
  budgetBalance: {areaMm2: {total: 400, committed: null, free: 400}},
});
LEDGER.validateLedger(seeded);

const after = LEDGER.mergeLedger(seeded, {
  currentStage: 'compute',
  strategyVersions: {'memory-expert': '1.0'},
  rejectedOptions: [{stage: 'compute', optionId: 'nativeLowPrecision', reason: 'area', rejectedBy: 'integrator'}],
  openBlockers: [],
});
LEDGER.validateLedger(after);
assert.strictEqual(after.currentStage, 'compute', 'the ledger names the stage that last wrote it');
assert.strictEqual(after.strategyVersions['compute-expert'], '1.0', 'a stage that did not run compute-expert does not erase its version');
assert.strictEqual(after.strategyVersions['memory-expert'], '1.0');
assert.strictEqual(after.rejectedOptions.length, 2, 'rejected options accumulate; a re-run must not reinvent what was ruled out');
assert.strictEqual(after.openBlockers.length, 1, 'an empty openBlockers in a patch does not close a blocker -- silence is not a resolution');
assert.deepStrictEqual(after.budgetBalance, seeded.budgetBalance, 'an untouched budget key survives');

// Re-applying the same patch is a no-op: a stage re-run must not duplicate its own entries.
const twice = LEDGER.mergeLedger(after, {
  currentStage: 'compute',
  rejectedOptions: [{stage: 'compute', optionId: 'nativeLowPrecision', reason: 'area', rejectedBy: 'integrator'}],
});
assert.deepStrictEqual(twice, after, 'merging the same patch twice changes nothing');

// Evidence is allowed to improve; that is why a stage is re-run at all.
const improved = LEDGER.mergeLedger(
  LEDGER.mergeLedger(after, {evidenceIndex: [{claimId: 'C-TAU', evidence: 'UNVERIFIED', level: 'E0'}]}),
  {evidenceIndex: [{claimId: 'C-TAU', evidence: 'out/requirements/budget_frontier.json:1', level: 'E2'}]});
assert.strictEqual(improved.evidenceIndex.length, 1, 'evidence merges by claim, it does not pile up');
assert.strictEqual(improved.evidenceIndex[0].level, 'E2');

// A frozen decision is frozen: re-opening one through a workflow run is an error.
const frozen = LEDGER.mergeLedger(after, {frozenDecisions: [{id: 'ADR-0021', decision: '单一硬件规格', lockedAt: '2026-01-01'}]});
LEDGER.validateLedger(frozen);
assert.deepStrictEqual(LEDGER.mergeLedger(frozen, {frozenDecisions: [{id: 'ADR-0021', decision: '单一硬件规格', lockedAt: '2026-01-01'}]}), frozen,
  'restating a frozen decision unchanged is allowed');
assert.throws(() => LEDGER.mergeLedger(frozen, {frozenDecisions: [{id: 'ADR-0021', decision: '两份规格', lockedAt: '2026-01-01'}]}),
  /re-opening a frozen decision/, 'a run may not change a frozen decision');

// An absent patch leaves the ledger alone; design.explore and design.learn return none.
assert.deepStrictEqual(LEDGER.mergeLedger(after, null), after);
assert.strictEqual(LEDGER.patchOf({verdict: 'OK'}), null, 'a result with no patch does not enter the ledger');
assert.strictEqual(LEDGER.patchOf({ledgerSeed: {currentStage: 'intake'}}).currentStage, 'intake', 'intake seeds the ledger');

// An invalid merge result is never written.
assert.throws(() => LEDGER.validateLedger({...after, strategyVersions: {}}), /does not satisfy/, 'a ledger without strategy versions is not a ledger');
assert.throws(() => LEDGER.validateLedger({...after, openBlockers: [{id: 'X'}]}), /does not satisfy/, 'a blocker without an owner is refused');

// --- writeLedger round-trips through a real file -------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
try {
  const file = path.join(tmp, 'nested', 'design_ledger.json');
  const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const first = LEDGER.writeLedger({patch: seeded, file});
  assert.strictEqual(first.created, true, 'the first write creates the file');
  const second = LEDGER.writeLedger({patch: {currentStage: 'compute', rejectedOptions: after.rejectedOptions}, file});
  assert.strictEqual(second.created, false);
  assert.strictEqual(second.ledger.rejectedOptions.length, 2, 'the second write merged onto what was on disk');
  assert.deepStrictEqual(onDisk(), second.ledger, 'what is on disk is what was returned');
  assert.throws(() => LEDGER.writeLedger({patch: {frozenDecisions: [{id: 'ADR-0021', decision: 'x', lockedAt: 'not-a-date'}]}, file}),
    /does not satisfy/, 'an invalid merge stops the write');
  assert.deepStrictEqual(onDisk(), second.ledger, 'the refused write left the file untouched');
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}

// --- when the main loop writes it ----------------------------------------------------------
// The write condition itself, without touching out/: a dry run decides nothing, a run whose
// files were rejected did not happen, and a workflow outside the ledger's chain writes nothing.

const patch = {currentStage: 'compute', strategyVersions: {integrator: '1.0'}};
const landed = {rejected: []};
assert.strictEqual(DRIVER.ledgerUpdate({land: false, landing: landed, result: {ledgerPatch: patch}}).write, false, 'a dry run does not write the ledger');
assert.strictEqual(DRIVER.ledgerUpdate({land: true, landing: {rejected: ['out/compute/x.json']}, result: {ledgerPatch: patch}}).write, false,
  'a run whose files were rejected must not leave a decision behind');
assert.strictEqual(DRIVER.ledgerUpdate({land: true, landing: landed, result: {verdict: 'OK'}}).write, false, 'design.explore and design.learn do not enter the ledger');
const writes = DRIVER.ledgerUpdate({land: true, landing: landed, result: {ledgerPatch: patch}});
assert.strictEqual(writes.write, true, 'a landed run writes its patch');
assert.deepStrictEqual(writes.patch, patch);
assert.strictEqual(DRIVER.ledgerUpdate({land: true, landing: landed, result: {ledgerSeed: patch}}).patch, patch, 'intake seeds through the same path');

console.log(`PASS brief and ledger: ${stages.length} stages derive a schema-valid brief whose every number points at the split entry it came from, the manufacturable binding is never read off the contract point, and the ledger merge accumulates rejected options, blockers and evidence without re-opening a frozen decision`);
