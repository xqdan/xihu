'use strict';

/* Generate the model-owned, per-operator planning ledgers.
 * The source module owns all shape arithmetic; this pipeline only adds
 * reproducibility metadata and writes the published artifact. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const O = require('../../teams/model/src/operator_ledger.js');

const root = path.resolve(__dirname, '../..');
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const outFile = 'out/workload/model_operator_ledgers.json';
const out = O.buildAll();
out.generatedBy = 'integration/pipelines/generate_model_operator_ledgers.js';
out.provenance = {
  manifest: O.MANIFEST_FILE,
  manifestSha256: hashFile(O.MANIFEST_FILE),
  operatorLedgerSource: 'teams/model/src/operator_ledger.js',
  operatorLedgerSourceSha256: hashFile('teams/model/src/operator_ledger.js'),
  evidenceClass: O.EVIDENCE,
  status: 'PLANNING_DERIVED'
};

const target = path.join(root, outFile);
fs.mkdirSync(path.dirname(target), {recursive: true});
fs.writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
for (const [modelId, value] of Object.entries(out.models)) {
  const ledgers = value.variants && !Array.isArray(value.variants) ? Object.values(value.variants) : [value];
  console.log(`${modelId}: ${ledgers.map(ledger => `${ledger.modelId || modelId} ${ledger.rows.length} rows`).join(', ')}`);
}
