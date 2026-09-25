'use strict';
/* Run the final tuning search from the repository root (the search reads and writes out/ relative to cwd).
 *
 * Run: node integration/pipelines/run_search.js final
 *   final integration/detailed/k3_rdma_final_tuning_search.js  -> out/rdma/k3_rdma_final_tuning_*
 */
const path = require('path');
const SEARCHES = {
  final: '../detailed/k3_rdma_final_tuning_search.js'
};
const name = process.argv[2];
if (!SEARCHES[name]) throw new Error(`usage: run_search.js <${Object.keys(SEARCHES).join('|')}>`);
process.chdir(path.resolve(__dirname, '../..'));
require(SEARCHES[name]).run();
