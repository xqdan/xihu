'use strict';
/* The L1 budget contract, as the domain searches read it (teams/council/docs/23 section 4, L3).
 *
 * Until now every L3 search decided feasibility the same way: "replay K3 at the published
 * point and keep the published TPS/usr within tolerance". That makes the published design
 * its own requirement. A search anchored to it can only ever rediscover the point it
 * started from -- a candidate that reaches the program target more cheaply is rejected for
 * being cheaper, and a candidate that would be admissible under a different budget split
 * is never seen, because the split was never consulted.
 *
 * The contract replaces that anchor. One L1 contract fixes the system target (TPS/usr and
 * the raw latency budget behind it) and splits the remaining room into per-domain entries,
 * each naming its owner:
 *
 *   B-SERIAL-CMP  compute    effective compute scale, >= min
 *   B-SRAM-CAP    sram       shared SRAM window per die, >= min MiB
 *   B-MEM-BW      mc         sustained payload per memory cube, >= min GB/s
 *   B-TAU         comm       one collective, <= max us
 *   B-AREA        physical   die area, <= max mm2, with die and card power limits
 *
 * A domain search is then feasible when it satisfies ITS OWN entry and does not push the
 * system past the contract's target. Nothing else: not the published point, not another
 * domain's entry. The entries of the other domains are the lateral experts' business
 * (section 4's coupling table), and the joint question is L3's `coupling` step -- a search
 * that enforced all five entries at once would be re-deciding the split, which is L1's job.
 *
 * Which contract is in force, in order:
 *   1. K3_CONTRACT_FILE                           an explicit contract file
 *   2. out/budget/L1_budget.json                  the contract design.req.budget landed
 *   3. out/requirements/budget_frontier.json      a frontier split, before anything landed
 * and which split, when it comes from the frontier: K3_CONTRACT_SPLIT, default S-CMP.
 * Step 3 is not a fallback for a missing input; it is where the chain starts, and it is why
 * `npm run budget:frontier` is not one of the regenerated pipelines -- the frontier is an
 * input to the searches, so regenerating it inside them would be a cycle.
 *
 * Every search records which contract it was scored against (`provenance`) and states the
 * clause it applied (`clause`), so a rejected candidate can be traced to the entry that
 * rejected it instead of to a local label. The violation names stay literal -- they say
 * what was measured, which is not always the entry's own quantity: the compute search has
 * no `computeScale` dimension to compare, so it tests B-SERIAL-CMP through the system
 * target the entry was derived from, and says so.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');

const LANDS_TO = 'out/budget/L1_budget.json';
const FRONTIER_FILE = 'out/requirements/budget_frontier.json';
const DEFAULT_SPLIT = 'S-CMP';
const CONTRACT_SCHEMA = 'budget-contract-v0.1';

// The entry each domain owns. One table decides, so a search cannot quietly adopt another
// domain's clause and no two files can disagree about who owns what.
const OWNS = {
  compute: 'B-SERIAL-CMP',
  sram: 'B-SRAM-CAP',
  mc: 'B-MEM-BW',
  comm: 'B-TAU',
  physical: 'B-AREA'
};

const readText = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/^﻿/, '');
const readJson = (file) => JSON.parse(readText(file));
const exists = (file) => fs.existsSync(path.join(root, file));
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function check(contract, where) {
  if (!contract || contract.layer !== 'L1' || contract.schemaVersion !== CONTRACT_SCHEMA) {
    throw new Error(`${where} is ${contract && contract.layer} / ${contract && contract.schemaVersion}; a domain search reads an L1 ${CONTRACT_SCHEMA} only`);
  }
  if (!contract.target || !(contract.target.tpsPerUser > 0) || !(contract.target.rawBudgetUs > 0)) {
    throw new Error(`${where} has no usable target (tpsPerUser / rawBudgetUs); a contract without a target constrains nothing`);
  }
  for (const id of Object.values(OWNS)) {
    if (!(contract.split || []).some((e) => e.id === id)) throw new Error(`${where} has no ${id} entry; it is not a budget contract`);
  }
  return contract;
}

// The contract in force, with the file it was read from -- the second half is not
// decoration: a search artifact has to say which contract produced it.
function load(options = {}) {
  const explicit = options.contractFile || process.env.K3_CONTRACT_FILE;
  if (explicit) {
    return {contract: check(readJson(explicit), explicit), file: explicit, splitId: null, origin: 'explicit', sha256: sha256(readText(explicit))};
  }
  if (exists(LANDS_TO)) {
    return {contract: check(readJson(LANDS_TO), LANDS_TO), file: LANDS_TO, splitId: null, origin: 'landed contract', sha256: sha256(readText(LANDS_TO))};
  }
  if (!exists(FRONTIER_FILE)) {
    throw new Error(`no budget contract on disk (${LANDS_TO} | ${FRONTIER_FILE}); run npm run budget:frontier first`);
  }
  const wanted = options.splitId || process.env.K3_CONTRACT_SPLIT || DEFAULT_SPLIT;
  const frontier = readJson(FRONTIER_FILE);
  const split = (frontier.splits || []).find((s) => s.splitId === wanted);
  if (!split) throw new Error(`${FRONTIER_FILE} has no split ${wanted} (have: ${(frontier.splits || []).map((s) => s.splitId).join(', ') || 'none'})`);
  return {contract: check(split.contract, `${FRONTIER_FILE} split ${split.splitId}`), file: FRONTIER_FILE,
    splitId: split.splitId, origin: 'frontier split', sha256: sha256(readText(FRONTIER_FILE))};
}

function entry(contract, id) {
  const e = (contract.split || []).find((x) => x.id === id);
  if (!e) throw new Error(`the contract has no ${id} entry`);
  return e;
}

// The clause a domain answers for. `owner` is the contract's own field, so a split that
// moves an entry between domains moves the search's feasibility test with it.
function ownedBy(contract, domain) {
  const id = OWNS[domain];
  if (!id) throw new Error(`no contract entry is owned by "${domain}" (domains: ${Object.keys(OWNS).join(', ')})`);
  const e = entry(contract, id);
  if (e.owner && e.owner !== domain) {
    throw new Error(`${id} is owned by "${e.owner}" in this contract but the ${domain} search claims it; the split and the search disagree about who decides this number`);
  }
  return e;
}

// What a search artifact records about the contract it was scored against: enough to
// re-run the same search, not a second copy of the contract.
function provenance(loaded) {
  const {contract} = loaded;
  return {
    path: loaded.file,
    splitId: contract.splitId || loaded.splitId || null,
    origin: loaded.origin,
    sha256: loaded.sha256,
    target: {...contract.target},
    point: {...contract.point}
  };
}

// A domain's own clause as the search reports it, so the artifact states the test that was
// applied rather than leaving the reader to infer it from a violation name.
function clause(loaded, domain) {
  const e = ownedBy(loaded.contract, domain);
  const bound = {};
  if (e.min !== undefined) bound.min = e.min;
  if (e.max !== undefined) bound.max = e.max;
  return {id: e.id, quantity: e.quantity, owner: e.owner, ownerAgent: e.ownerAgent, ...bound,
    source: `${loaded.file}#${e.id}`};
}

// A design space states which entry its search answers for (requirements.contractEntry), so
// a reader of the space alone knows what "feasible" means. The space lives under teams/ and
// cannot read the contract; this is where the statement and the ownership table meet.
function declared(space, domain, where) {
  const said = space && space.requirements && space.requirements.contractEntry;
  if (said !== OWNS[domain]) {
    throw new Error(`${where} declares contractEntry ${said} but the ${domain} search answers for ${OWNS[domain]}; fix the space or the ownership table, not both silently`);
  }
  return said;
}

module.exports = {load, entry, ownedBy, provenance, clause, check, declared,
  OWNS, LANDS_TO, FRONTIER_FILE, DEFAULT_SPLIT, CONTRACT_SCHEMA};
