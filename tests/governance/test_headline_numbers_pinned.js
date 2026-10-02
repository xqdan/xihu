'use strict';
// Headline numbers quoted in README.md and docs/architecture/00_CURRENT_STATE.md must equal the
// machine artifacts. Docs are hand-written; without this check a regenerated artifact (or a typo)
// leaves the front page stating a number that no file produces.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const text = p => fs.readFileSync(path.join(root, p), 'utf8');
const json = p => JSON.parse(text(p));

const readme = text('README.md');
const current = text('docs/architecture/00_CURRENT_STATE.md');
const matrix = json('out/workload/tps_observation_matrix.json');
const finalTuning = json('out/rdma/k3_rdma_final_tuning_results.json');
const workload = json('out/workload/planning_operator_workload.json');
const baseline = json('teams/hardware/inputs/k3_mc_baseline.json');

const slot = (modelId, tp, mc) => {
  const found = matrix.observations.find(o => o.modelId === modelId && o.tp === tp && o.mcProfile === mc);
  assert(found, `${modelId} TP${tp} ${mc} missing from the observation matrix`);
  return found.tpsPerUser;
};
const need = (doc, name, needle) => assert(doc.includes(needle), `${name} must state ${needle} (current artifact value)`);

// Three-model planning row (TP32 / MC640), one decimal.
const k3 = slot('K3', 32, 'MC640').toFixed(1);
const glm = slot('GLM-5.2', 32, 'MC640').toFixed(1);
const ds = slot('DeepSeek-V4-Pro', 32, 'MC640').toFixed(1);
for (const [name, doc] of [['README.md', readme], ['00_CURRENT_STATE.md', current]]) {
  need(doc, name, k3);
  need(doc, name, glm);
  need(doc, name, ds);
}

// K3 published point: detailed model TPS and the MC320 held-out value, two decimals.
const published = finalTuning.search.best.tps.toFixed(2);
const mc320 = workload.calibration.validation.detailedTpsPerUser.toFixed(2);
for (const [name, doc] of [['README.md', readme], ['00_CURRENT_STATE.md', current]]) {
  need(doc, name, published);
  need(doc, name, mc320);
}

// Die area of the hardware spec.
need(readme, 'README.md', baseline.computeDieCandidate.estimatedAreaMm2.toFixed(2));
need(current, '00_CURRENT_STATE.md', baseline.computeDieCandidate.estimatedAreaMm2.toFixed(2));

// Collective counts per token.
for (const [model, count] of Object.entries(workload.collectivesPerToken)) {
  const re = model === 'K3' ? null : new RegExp(`${count}\\s*(×|x|次)`);
  if (re) assert(re.test(current), `00_CURRENT_STATE.md must state the ${count} collectives/token of ${model}`);
}

// The front page must not present the planning number without its basis: the published point is
// counted on the reference-393 basis and MC640 is a Stretch point (ADR-0004, ADR-0017).
assert(/reference-393/.test(readme) && /repo-510/.test(readme), 'README.md must name the collective count basis next to the headline TPS');
assert(/Stretch/.test(readme), 'README.md must mark MC640 as Stretch next to the headline TPS');

console.log(`PASS headline numbers pinned: K3 ${k3}, GLM-5.2 ${glm}, DeepSeek-V4-Pro ${ds}, published ${published}, MC320 ${mc320}`);
