'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '../..');
const doc = fs.readFileSync(path.join(root, 'teams/council/docs/16_ARITHMETIC_INTENSITY_AGENT.md'), 'utf8');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'teams/council/inputs/arithmetic_intensity_contract.json'), 'utf8'));
const profiles = JSON.parse(fs.readFileSync(path.join(root, 'teams/model/inputs/model_profiles.json'), 'utf8'));
const ref = path.join(root, 'references/frontier_moe_arithmetic_intensity.html');

assert(fs.existsSync(ref), 'frontier arithmetic-intensity reference must be vendored');
assert(doc.includes('I_MC = FLOP / memory_bytes'));
assert(doc.includes('required_peak_flops'));
assert.deepStrictEqual(contract.dimensions.models, ['K3', 'GLM-5.2', 'DeepSeek-V4-Pro']);
assert.deepStrictEqual(contract.dimensions.tp, [8, 16, 32]);
assert.deepStrictEqual(contract.dimensions.cp, [1, 8, 16, 32]);
assert.deepStrictEqual(contract.coreClasses, ['L', 'H', 'V', 'INDEXER', 'REDUCE']);
assert.strictEqual(contract.target.targetTimeUsPerToken, 1000);
assert.strictEqual(profiles.profiles.length, 3);
assert(contract.validation.mustTrack.includes('confidence'));
assert(contract.validation.forbid.includes('planning_as_observed'));
console.log('PASS arithmetic intensity agent contract: reference, formulas, dimensions and sign-off guards');
