'use strict';
/* Generate out/detailed/matrix_vector_balance.json: the AI Core matrix:vector
 * balance for K3, GLM-5.2 and DeepSeek-V4-Pro (HW-02 decision input,
 * teams/hardware/docs/02_AI_CORE.md section 2.5). See
 * integration/detailed/matrix_vector_balance.js for the method.
 *
 * Run after npm run baseline:sync: node integration/pipelines/generate_matrix_vector_balance.js
 */
const fs = require('fs');
const path = require('path');
const M = require('../detailed/matrix_vector_balance.js');

const root = path.resolve(__dirname, '../..');
const out = M.build();
fs.writeFileSync(path.join(root, 'out/detailed/matrix_vector_balance.json'), `${JSON.stringify(out, null, 2)}\n`);
const d = out.decision;
console.log(JSON.stringify({
  current: out.hardware.ratio,
  k3Only: {vectorUnpack: d.k3Only.vectorUnpack.dieRatio, nativeLowPrecision: d.k3Only.nativeLowPrecision.dieRatio},
  allModels: {vectorUnpack: d.allModels.vectorUnpack.dieRatio, nativeLowPrecision: d.allModels.nativeLowPrecision.dieRatio}
}, null, 2));
