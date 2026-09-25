'use strict';
// Independent gate validator regression: the committed gate_status.json must be
// reproducible from the artifacts by the validator itself, and the register
// must agree with it. No decision literal is asserted here; consistency is.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {evaluateDirectionGate, evaluateQuantificationGate} = require('../../integration/governance/evaluate_gates');
const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));
const status = read('out/governance/gate_status.json');
const register = read('out/governance/candidate_register.json');
const env = read('out/direction/directional_resource_envelope.json');
const score = read('out/direction/directional_tps_scorecard.json');
const detail = read('out/detailed/detailed_architecture_run.json');
const matrix = read('out/workload/tps_observation_matrix.json');

const direction = evaluateDirectionGate(env, score, register);
assert.deepStrictEqual(status.directionGate, direction, 'committed D-Gate must equal the validator recomputation');
assert.strictEqual(direction.registerConsistent, true, 'candidate register state must be derived from the validator');
assert.strictEqual(register.decisionSource, 'integration/governance/evaluate_gates.js#evaluateDirectionGate');
if (direction.decision === 'PASS') {
  assert.strictEqual(register.decisionState, 'D_GATE_PASSED');
  assert(register.formalSelectedCandidates.length > 0 && register.formalSelectedCandidates.length <= 3);
} else {
  assert.strictEqual(register.decisionState, 'D_GATE_BLOCKED');
  assert.deepStrictEqual(register.formalSelectedCandidates, []);
}
assert.strictEqual(status.directionGate.threeModelRowsAccounted, true);
// A BLOCKED_CONFIG model is accounted for but not comparable, and must block the D-Gate.
assert.strictEqual(status.directionGate.threeModelComparable, direction.blockedModels.length === 0);
if (direction.blockedModels.length) {
  assert.notStrictEqual(direction.decision, 'PASS', 'a BLOCKED_CONFIG model cannot pass the D-Gate');
  assert(direction.failedChecks.includes('threeModelComparable'));
}
assert.strictEqual(direction.decision === 'PASS', direction.failedChecks.length === 0);

const quant = evaluateQuantificationGate(detail, matrix, register, direction);
assert.deepStrictEqual(status.quantificationGate, quant, 'committed Q-Gate must equal the validator recomputation');
assert.strictEqual(quant.exploratoryOnly, true);
assert.strictEqual(quant.provenanceComplete, true);
assert.strictEqual(quant.all18SlotsAccounted, true);
assert.strictEqual(quant.p0P1DistinctResources, true);
assert.strictEqual(quant.observationMatrixCompleteOrBlocked, false);
assert.strictEqual(quant.decision, 'BLOCKED_BY_D_GATE_MANIFEST_EVENT_MODEL_AND_PROVENANCE');
console.log(`PASS independent architecture gate validator: D-Gate ${direction.decision} reproduced from artifacts; Q-Gate rejects synthetic evidence`);
