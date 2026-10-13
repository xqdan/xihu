'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const N = require('../../integration/planning/network_requirements');
const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const fileHash = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
const out = read(N.OUT_FILE);
const withoutGeneratedCommit = artifact => {
  const copy = JSON.parse(JSON.stringify(artifact));
  delete copy.provenance.sourceCommit;
  return copy;
};
assert.strictEqual(out.schemaVersion, N.SCHEMA_VERSION);
assert(/^[0-9a-f]{40}$/.test(out.provenance && out.provenance.sourceCommit || ''), 'network artifact has invalid provenance.sourceCommit');
assert.strictEqual(out.scenarios.length, read('teams/council/inputs/brief_intents.json').scenarios.length);
for (const input of out.inputs.sourceArtifacts) assert.strictEqual(input.sha256, fileHash(input.path), `${input.path}: stale network input`);
assert(out.inputs.sourceArtifacts.some(x => x.path === N.KERNEL_FILE));
assert.deepStrictEqual(out.assumptions.bandwidthP99MultipliersByScenario, {
  'decode-b1-c1m-tp32': 1.25,
  'decode-b1-c1m-tp16': 1.25
});
const k3 = out.scenarios.find(s => s.scenarioId === 'decode-b1-c1m-tp32');
assert(k3 && k3.status === 'MODEL_WITH_ASSUMPTIONS');
assert.strictEqual(k3.topologies.length, 5);
for (const topology of k3.topologies) {
  assert(topology.links.length > 0, `${topology.topology}: links`);
  assert(topology.nominalMessagePathLatencyUs.p99 >= topology.nominalMessagePathLatencyUs.p50);
  assert.strictEqual(topology.runtimeLatencyUs.p99, null);
  for (const link of topology.links) {
    assert(link.packetBytesPerToken >= 0 && link.requiredGBs >= 0);
    assert(link.p99PlanningRequiredGBs >= link.requiredGBs);
    assert(link.capacityGBs > 0);
  }
}
const k3tp16 = out.scenarios.find(s => s.scenarioId === 'decode-b1-c1m-tp16');
assert(k3tp16 && k3tp16.status === 'MODEL_WITH_ASSUMPTIONS');
assert.strictEqual(k3tp16.mapping.basis, 'TP16_PROTOCOL_PROJECTION');
assert.strictEqual(k3tp16.mapping.detailedReplaySupported, false);
assert.strictEqual(k3tp16.mapping.peersPerRank, 15);
assert.strictEqual(k3tp16.mapping.lseHeadsPerRank, 6);
assert.strictEqual(k3tp16.topologies.length, 5);
for (const topology of k3tp16.topologies) {
  assert(topology.links.length > 0, `${topology.topology}: TP16 links`);
  assert.strictEqual(topology.runtimeLatencyUs.p99, null);
  for (const link of topology.links) assert(link.capacityGBs > 0 && link.packetBytesPerToken >= 0);
}
for (const scenario of out.scenarios.filter(s => s.scenarioId !== k3.scenarioId)) {
  if (scenario.scenarioId === k3tp16.scenarioId) continue;
  assert.strictEqual(scenario.status, 'BLOCKED_CONFIG');
  assert.strictEqual(scenario.topologies.length, 0);
}
assert.deepStrictEqual(withoutGeneratedCommit(N.build()), withoutGeneratedCommit(out), `${N.OUT_FILE} is stale`);
console.log('PASS network requirements: K3 TP32 link traffic, route quantiles, P99 planning multiplier and blocked coverage are traceable');
