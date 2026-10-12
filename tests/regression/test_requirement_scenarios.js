'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const RW = require('../../integration/planning/requirement_workload');
const RF = require('../../integration/planning/requirement_frontier');
const MB = require('../../integration/pipelines/make_brief');
const DRIVER = require('../../integration/pipelines/run_workflow');
const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const req = read('out/requirements/workload_requirements.json');
assert.strictEqual(req.schemaVersion, 'workload-requirements-v0.1');
const catalog = read(RW.SCENARIO_CATALOG_FILE).scenarios;
assert.deepStrictEqual(req.scenarioCatalog, catalog, 'requirement catalog is the brief catalog, not a second list');
assert.deepStrictEqual(JSON.parse(JSON.stringify(RW.build())), req, 'requirement artifact must be regenerated');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
assert.strictEqual(req.inputs.scenarioCatalogSha256, hash(JSON.stringify(catalog)));
for (const input of req.inputs.sourceArtifacts) {
  assert.strictEqual(input.sha256, hash(fs.readFileSync(path.join(root, input.path))), `${input.path}: stale requirement source`);
}
assert(req.inputs.sourceArtifacts.some(a => a.path === RW.SCENARIO_CATALOG_FILE), 'catalog changes invalidate requirements');
assert.deepStrictEqual(req.blockedScenarios, []);
for (const model of req.models) {
  const expected = catalog.filter(s => s.model === model.model);
  assert(expected.length > 0, `${model.model}: explicitly registered coverage`);
  assert.strictEqual(model.scenarios.length, expected.length, `${model.model}: scenario coverage`);
  for (const scenario of model.scenarios) {
    const source = expected.find(s => s.scenarioId === scenario.scenarioId);
    assert(source, `${model.model}: no invented or cross-model scenario`);
    for (const key of Object.keys(source)) assert.deepStrictEqual(scenario[key], source[key], `${scenario.scenarioId}/${key}`);
    assert.strictEqual(scenario.status, 'MODEL_PLANNING');
    assert(scenario.capacityBytes.totalTracked > scenario.capacityBytes.weightResident);
    assert(scenario.compute.requiredFLOPsPerSecond > 0);
    for (const key of ['weight', 'expert', 'kv_state', 'collective']) {
      assert(Number.isFinite(scenario.bandwidthGBs[key]) && scenario.bandwidthGBs[key] >= 0, `${model.model}/${scenario.scenarioId}/${key}`);
    }
    assert.strictEqual(scenario.network.requiredGBsByClass.collective, scenario.network.requiredGBs);
    assert.strictEqual(scenario.network.requiredGBsByClass.dieLocal, null);
    assert(scenario.network.p99RequiredGBs >= scenario.network.requiredGBs);
  }
}

const frontier = read('out/requirements/budget_frontier.json');
for (const split of frontier.splits) {
  const demand = split.contract.demandRequirements;
  assert(demand && demand.schemaVersion === 'demand-requirements-v0.1', `${split.splitId}: demand contract`);
  assert.deepStrictEqual(demand.networkClasses, ['die-local', 'die-to-die', 'package', 'scale-out', 'collective']);
  assert.deepStrictEqual(demand.scenarioCatalog, catalog);
  for (const m of req.models) assert.deepStrictEqual(demand.models[m.model], m.scenarios, `${split.splitId}/${m.model}: L1 scenario demand equals L1-a`);
}

const seed = catalog[0];
const only = RW.build({scenarios: [seed]});
assert.strictEqual(only.models.find(m => m.model === seed.model).scenarios.length, 1);
assert(only.models.filter(m => m.model !== seed.model).every(m => m.scenarios.length === 0), 'no implicit cross-model scenario expansion');
const normal = only.models.find(m => m.model === seed.model).scenarios[0];
const slower = RW.build({scenarios: [{...seed, targetTpsPerUser: seed.targetTpsPerUser / 2}]}).models.find(m => m.model === seed.model).scenarios[0];
assert.strictEqual(slower.compute.requiredFLOPsPerSecond, normal.compute.requiredFLOPsPerSecond / 2, 'per-scenario target affects compute');
for (const key of Object.keys(normal.bandwidthBytesPerSecond)) {
  assert.strictEqual(slower.bandwidthBytesPerSecond[key], normal.bandwidthBytesPerSecond[key] / 2, `per-scenario target affects ${key}`);
}
assert.deepStrictEqual(slower.capacityBytes, normal.capacityBytes, 'token rate does not change capacity');
for (const change of [{phase: 'prefill'}, {phase: 'mixed'}, {precision: 'INT4'}]) {
  const blocked = RW.build({scenarios: [{...seed, ...change}]}).blockedScenarios;
  assert.strictEqual(blocked.length, 1);
  assert.strictEqual(blocked[0].status, 'BLOCKED_CONFIG');
  for (const field of ['capacityBytes', 'bandwidthBytesPerSecond', 'compute', 'network', 'baselineSlot']) assert.strictEqual(blocked[0][field], null);
}
assert.throws(() => RW.loadScenarioCatalog({scenarios: []}), /invalid scenario catalog/);
assert.throws(() => RW.loadScenarioCatalog({scenarios: [seed, seed]}), /duplicate scenarioId/);
for (const change of [{batch: 0}, {tp: 1.5}, {context: 0}, {precision: ''}, {targetTpsPerUser: 0}, {phase: 'training'}]) {
  assert.throws(() => RW.loadScenarioCatalog({scenarios: [{...seed, ...change}]}), /invalid/);
}
assert.throws(() => RW.build({scenarios: [{...seed, model: 'unknown-model'}]}), /unknown scenario model/);
const customCtx = RF.context({scenarios: [seed]});
assert.deepStrictEqual(customCtx.scenarioCatalog, [seed], 'frontier context consumes explicit scenarios');
assert.deepStrictEqual(MB.briefFor('req.workload').brief.scenarios, catalog);
assert(DRIVER.prepareArgs('req.workload', {}).workloadRequirements, 'default brief and artifact catalogs match');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihu-scenarios-'));
try {
  const file = path.join(temp, 'brief.json');
  const brief = MB.briefFor('req.workload').brief;
  brief.scenarios = [seed];
  fs.writeFileSync(file, JSON.stringify(brief));
  assert.throws(() => DRIVER.prepareArgs('req.workload', {brief: file}), /scenario catalog differs/, 'runner rejects a brief that asks different questions');
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}

const score = read('out/direction/directional_tps_scorecard.json');
assert.strictEqual(score.inputHashes.l1Contract, require('crypto').createHash('sha256').update(fs.readFileSync(path.join(root, 'out/requirements/budget_frontier.json'))).digest('hex'));
assert(score.morphology.paretoCandidates.length > 0);
assert(score.morphology.paretoCandidates.every(id => score.morphology.rows.some(row => row.morphologyId === id)));
console.log('PASS workload scenarios: one validated catalog, per-model coverage, per-scenario target, unsupported configurations blocked, provenance and brief alignment; L1 demand and morphology remain traceable');
