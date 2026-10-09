'use strict';

/* The layer brief, derived rather than typed (L1-b's downstream consumer).
 *
 * Until now exactly one brief was committed (teams/council/inputs/design_brief.m2.json, a
 * hand-written compute brief) and every other stage needed `--brief <file>`. That made the
 * architect the transcription step for numbers the L1 contract had already decided: the
 * area / power / bandwidth budget a downstream stage may spend, and the hard constraints
 * that follow from them, all live in out/budget/L1_budget.json. A brief typed by hand next
 * to that file is a second source for the same numbers, and the two drift.
 *
 * This module removes the transcription. It composes one stage's DesignBrief from:
 *
 *   prose   teams/council/inputs/brief_intents.json -- the objective, the shape intent, the
 *           stage's own `forbidden` / `exitCriteria`, the allowed design space, and the
 *           profile binding. What question this stage answers, what it may not do, which
 *           hardware profile it designs against: judgement, so hand-authored and left alone.
 *   numbers a budget contract -- areaMm2 / powerW / bandwidthGBs and every hard constraint
 *           that follows from a split entry, each carrying a source of the form
 *           `<contract>#/split/<id>/<field>`. Derived, so the number points at the entry it
 *           came from rather than at a second copy of itself.
 *
 * The brief is therefore a view of the contract, not a retyping of it, and it is built per
 * run -- never stored in the repository. Build a contract that says something else and the
 * next brief says it too; there is no stale copy to forget.
 *
 * The contract comes from the first of these that exists:
 *   1. --contract <file>                          an explicit contract file
 *   2. out/budget/L1_budget.json                  the contract design.req.budget landed
 *   3. out/requirements/budget_frontier.json      a frontier split, before anything landed
 *   4. teams/council/inputs/design_brief.m2.json  stage `compute` only: the last hand-written brief
 * Step 3 exists because the chain starts there: design.req.budget has to run before it can land
 * a contract, and the stages need a brief to run at all. Step 4 keeps one stage runnable in a
 * clone where neither has been produced -- compute alone, since that is the one stage whose
 * brief predates the contract.
 *
 * Usage:
 *   node integration/pipelines/make_brief.js <stage> [--contract f] [--split S-CMP] [--run-id id] [--provenance]
 *   node integration/pipelines/make_brief.js --list
 *   stage: req.workload | arch.direction | compute | sram | mc | comm | physical | coupling   (the L1 contract's consumers)
 * Exit codes: 0 the brief was built, 1 no contract and no committed brief, or the built brief
 * does not satisfy teams/council/inputs/design_brief.schema.json, 2 usage.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {validate} = require('../orchestration/runtime/schema');

const root = path.resolve(__dirname, '../..');

const LANDS_TO = 'out/budget/L1_budget.json';
const FRONTIER_FILE = 'out/requirements/budget_frontier.json';
const INTENTS_FILE = 'teams/council/inputs/brief_intents.json';
const BRIEF_SCHEMA = 'teams/council/inputs/design_brief.schema.json';
// Step 4 of the fallback chain. A clone with no budget run still has one runnable stage.
const COMMITTED_BRIEFS = {compute: 'teams/council/inputs/design_brief.m2.json'};
const DEFAULT_SPLIT = 'S-CMP';
const CONTRACT_SCHEMA = 'budget-contract-v0.1';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const readText = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/^﻿/, '');
const readJson = (file) => JSON.parse(readText(file));
const exists = (file) => fs.existsSync(path.join(root, file));

// Which split entry each derived number comes from. One place decides, so the citation strings
// in the brief and the reading code below cannot disagree.
const ENTRY = {
  areaMm2: 'B-AREA',
  powerW: 'B-AREA',
  bandwidthGBs: 'B-MEM-BW',
  tauUs: 'B-TAU',
  computeScale: 'B-SERIAL-CMP',
  sharedMiBPerDie: 'B-SRAM-CAP'
};

function sourceCommit() {
  if (process.env.K3_SOURCE_COMMIT) return process.env.K3_SOURCE_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  } catch (_) {
    return 'WORKTREE';
  }
}

const byId = (contract, id) => (contract.split || []).find((e) => e.id === id);

// A constraint's `source` has to resolve, or it is decoration. `split` is an array, so an
// id-shaped path (#/split/B-AREA/max) reads well and resolves to nothing; and when the
// contract came from the frontier it does not even sit at the root of the file it names.
// Both are handled here: the pointer is a real RFC 6901 pointer into the file that was read.
function pointerTo(contract, base, id, field) {
  const index = (contract.split || []).findIndex((e) => e.id === id);
  if (index < 0) throw new Error(`${id} is not an entry of this contract`);
  return `${base}/split/${index}/${field}`;
}

function resolvePointer(doc, pointer) {
  if (!pointer || pointer === '#') return doc;
  return pointer.replace(/^#/, '').split('/').slice(1)
    .reduce((node, token) => (node === undefined || node === null ? undefined : node[token.replace(/~1/g, '/').replace(/~0/g, '~')]), doc);
}

function checkContract(contract, where) {
  if (!contract || contract.layer !== 'L1' || contract.schemaVersion !== CONTRACT_SCHEMA) {
    throw new Error(`${where} is ${contract && contract.layer} / ${contract && contract.schemaVersion}; a layer brief derives from an L1 ${CONTRACT_SCHEMA} only`);
  }
  for (const id of Object.values(ENTRY)) {
    if (!byId(contract, id)) throw new Error(`${where} has no ${id} entry; it is not a budget contract`);
  }
  return contract;
}

// The contract to build from, and where it came from -- the second half is not decoration:
// every citation in the brief has to name the file it was actually read from.
function resolveContract(explicit) {
  if (explicit) return {contract: checkContract(readJson(explicit), explicit), file: explicit, origin: 'explicit'};
  if (exists(LANDS_TO)) return {contract: checkContract(readJson(LANDS_TO), LANDS_TO), file: LANDS_TO, origin: 'landed contract'};
  if (exists(FRONTIER_FILE)) {
    const frontier = readJson(FRONTIER_FILE);
    return {frontier, file: FRONTIER_FILE, origin: 'frontier split'};
  }
  return null;
}

// A frontier split, picked the same way design.req.budget picks one. The brief is a view of
// whichever split is in force, so an unlanded contract is a choice of split, not a missing input.
function frontierSplit(frontier, splitId, file) {
  const index = (frontier.splits || []).findIndex((s) => s.splitId === (splitId || DEFAULT_SPLIT));
  if (index < 0) throw new Error(`${file} has no split ${splitId || DEFAULT_SPLIT} (have: ${(frontier.splits || []).map((s) => s.splitId).join(', ') || 'none'})`);
  const split = frontier.splits[index];
  // The contract is nested in the frontier, so every pointer into it has to say where.
  return {contract: checkContract(split.contract, `${file} split ${split.splitId}`), file, splitId: split.splitId, base: `#/splits/${index}/contract`, origin: 'frontier split'};
}

// The card's payload bandwidth: what one compute die may draw from its memory cubes.
// memoryCubesPerComputeDie is the package basis -- the contract prices one cube, the package
// decides how many a die gets, so the product needs both and neither is a typed constant here.
function cardBandwidthGBs(contract, baseline) {
  const perDie = baseline.card.memoryCubesPerComputeDie;
  const perCube = byId(contract, ENTRY.bandwidthGBs).min;
  return {value: perDie * perCube, perDie, perCube};
}

// Every derived constraint carries the split entry it came from as a JSON pointer into the
// contract file, so the number points at its origin rather than restating it.
function derivedConstraints(contract, file, baseline, base = '#') {
  const at = (id, field) => `${file}${pointerTo(contract, base, id, field)}`;
  const area = byId(contract, ENTRY.areaMm2);
  const bw = byId(contract, ENTRY.bandwidthGBs);
  const tau = byId(contract, ENTRY.tauUs);
  const scale = byId(contract, ENTRY.computeScale);
  const sram = byId(contract, ENTRY.sharedMiBPerDie);
  const card = cardBandwidthGBs(contract, baseline);
  return [
    {id: 'C-AREA-DIE', text: `单颗 compute die 面积不超过 ${area.max} mm2`, source: at(ENTRY.areaMm2, 'max'), value: area.max},
    {id: 'C-POWER-DIE', text: `单颗 compute die 功耗不超过 ${area.limits.diePowerW} W`, source: at(ENTRY.areaMm2, 'limits/diePowerW'), value: area.limits.diePowerW},
    {id: 'C-POWER-CARD', text: `整卡功耗不超过 ${area.limits.cardPowerW} W`, source: at(ENTRY.areaMm2, 'limits/cardPowerW'), value: area.limits.cardPowerW},
    {
      id: 'C-BW-MC',
      text: `每个 memory cube 的持续 payload 至少 ${bw.min} GB/s；整卡可用 ${card.value} GB/s = ${card.perDie} cube/die x ${card.perCube} GB/s（持续，不与档位 peak 混用）`,
      source: at(ENTRY.bandwidthGBs, 'min'),
      value: bw.min
    },
    {id: 'C-TAU', text: `单次集合通信 τ 不超过 ${tau.max} us（本 contract 固定，不得当作可放宽的旋钮）`, source: at(ENTRY.tauUs, 'max'), value: tau.max},
    {id: 'C-COMPUTE-SCALE', text: `有效算力 scale 不低于 ${scale.min}（P1 引擎峰值乘达成率口径）`, source: at(ENTRY.computeScale, 'min'), value: scale.min},
    {id: 'C-SRAM-CAP', text: `每 die 共享 SRAM 窗口不低于 ${sram.min} MiB（detailed K3 TP32 口径，其他模型 UNCORROBORATED）`, source: at(ENTRY.sharedMiBPerDie, 'min'), value: sram.min}
  ];
}

// The words a kernel cannot compute: the question, the wanted shape, the bans, the exit
// conditions, the profile, and the stage's own extra constraints.
function proseBrief(stage, intents) {
  const intent = intents.stages[stage];
  if (!intent) {
    throw new Error(`${INTENTS_FILE} has no "${stage}" entry; covered stages: ${Object.keys(intents.stages).join(', ')}`);
  }
  return intent;
}

function buildBrief(stage, {contract, file, base, runId, commit, intents, baseline} = {}) {
  const C = contract;
  const where = file || LANDS_TO;
  const I = intents || readJson(INTENTS_FILE);
  const B = baseline || readJson('teams/hardware/inputs/k3_mc_baseline.json');
  checkContract(C, where);
  const intent = proseBrief(stage, I);
  const card = cardBandwidthGBs(C, B);
  const binding = intent.profileBinding || {};
  return {
    schemaVersion: '1.0',
    stage,
    runId: runId || `${stage}-${C.splitId}`,
    sourceCommit: commit || sourceCommit(),
    objective: intent.objective,
    hardConstraints: [...derivedConstraints(C, where, B, base || '#'), ...(I.sharedConstraints || []), ...(intent.extraConstraints || [])],
    budget: {
      areaMm2: byId(C, ENTRY.areaMm2).max,
      powerW: byId(C, ENTRY.areaMm2).limits.diePowerW,
      bandwidthGBs: card.value
    },
    shapeIntent: intent.shapeIntent,
    allowedDesignSpace: intent.allowedDesignSpace,
    forbidden: intent.forbidden,
    exitCriteria: intent.exitCriteria,
    evidenceLevelFloor: intent.evidenceLevelFloor || 'E1',
    // The manufacturable profile this stage designs against -- NOT the contract's point. The
    // contract's B-MEM-BW.min is what the target requires and may be a stretch tier (ADR-0019
    // MC640), while ADR-0021 makes MC320 the sole manufacturable default and MC640 stretch only.
    // Deriving the binding from the contract would let a stretch tier present itself as default.
    profileBinding: {physicalProfile: binding.physicalProfile || (C.scope && C.scope.physicalProfile) || 'P1', mcProfile: binding.mcProfile || 'MC320'}
  };
}

// Provenance is not a brief field (the schema is additionalProperties:false) and not a gate
// input. It is the run record's answer to "which contract produced this brief", kept beside
// the brief rather than inside it.
function briefProvenance(stage, {contract, file, intents, baseline} = {}) {
  const text = readText(file || LANDS_TO);
  return {
    stage,
    generatedBy: 'integration/pipelines/make_brief.js',
    contract: {path: file || LANDS_TO, splitId: contract.splitId, sha256: sha256(text)},
    contractPoint: contract.point,
    intents: {path: INTENTS_FILE, sha256: sha256(readText(INTENTS_FILE))},
    baseline: {path: 'teams/hardware/inputs/k3_mc_baseline.json', memoryCubesPerComputeDie: baseline.card.memoryCubesPerComputeDie}
  };
}

// A brief that does not satisfy the shipped schema is a bug in this file, not in the caller:
// refuse to hand it on rather than let a downstream stage discover the field that is missing.
function validateBrief(brief) {
  const errors = validate(readJson(BRIEF_SCHEMA), brief);
  if (errors.length) throw new Error(`the built brief does not satisfy ${BRIEF_SCHEMA}:\n  ${errors.join('\n  ')}`);
  return brief;
}

const coveredStages = (intents = readJson(INTENTS_FILE)) => Object.keys(intents.stages);

// A brief is built, not stored: read the contract, derive, validate, hand it over. Stage
// `compute` falls back to the committed hand-written brief when nothing has been generated yet.
function briefFor(stage, options = {}) {
  const intents = options.intents || readJson(INTENTS_FILE);
  const baseline = options.baseline || readJson('teams/hardware/inputs/k3_mc_baseline.json');
  const resolved = options.contract
    ? {contract: options.contract, file: options.file || LANDS_TO}
    : resolveContract(options.contractFile);
  if (!resolved) {
    const committed = COMMITTED_BRIEFS[stage];
    if (!committed) {
      throw new Error(`no budget contract on disk (${LANDS_TO} | ${FRONTIER_FILE}) and stage "${stage}" has no committed brief; run npm run budget:frontier then the design.req.budget workflow`);
    }
    return {brief: readJson(committed), origin: `committed brief ${committed}`, provenance: null};
  }
  const fromFrontier = resolved.frontier ? frontierSplit(resolved.frontier, options.splitId, resolved.file) : resolved;
  const brief = validateBrief(buildBrief(stage, {contract: fromFrontier.contract, file: fromFrontier.file, base: fromFrontier.base, runId: options.runId, commit: options.commit, intents, baseline}));
  return {
    brief,
    origin: `${fromFrontier.origin} ${fromFrontier.file}${fromFrontier.splitId ? ` (${fromFrontier.splitId})` : ''}`,
    provenance: briefProvenance(stage, {contract: fromFrontier.contract, file: fromFrontier.file, intents, baseline})
  };
}

function flagValue(flags, name) {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : null;
}

function main(argv) {
  const [stage, ...flags] = argv;
  if (!stage || stage === '--help') {
    console.error('usage: make_brief.js <req.workload|arch.direction|compute|sram|mc|comm|physical|coupling> [--contract f] [--split S-CMP] [--run-id id] [--provenance]');
    return 2;
  }
  try {
    if (stage === '--list') {
      console.log(coveredStages().join('\n'));
      return 0;
    }
    const built = briefFor(stage, {
      contractFile: flagValue(flags, '--contract'),
      splitId: flagValue(flags, '--split'),
      runId: flagValue(flags, '--run-id')
    });
    const payload = flags.includes('--provenance') ? {brief: built.brief, provenance: built.provenance, origin: built.origin} : built.brief;
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

module.exports = {
  briefFor, buildBrief, briefProvenance, validateBrief, coveredStages,
  derivedConstraints, cardBandwidthGBs, resolveContract, frontierSplit, checkContract, resolvePointer,
  LANDS_TO, FRONTIER_FILE, INTENTS_FILE, BRIEF_SCHEMA, COMMITTED_BRIEFS, ENTRY, DEFAULT_SPLIT, sha256
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
