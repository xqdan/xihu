'use strict';
/* Run one detailed search from the repository root (the searches read and write out/ relative to cwd).
 *
 * Run: node integration/pipelines/run_search.js <b1|rdma|final>
 *   b1    integration/detailed/k3_b1_1000_search.js            -> out/search/k3_b1_1000_*
 *   rdma  integration/detailed/k3_b1_1000_rdma_sram_search.js  -> out/rdma/k3_b1_1000_rdma_sram_*
 *   final integration/detailed/k3_rdma_final_tuning_search.js  -> out/rdma/k3_rdma_final_tuning_*
 */
const path = require('path');
const SEARCHES = {
  b1: '../detailed/k3_b1_1000_search.js',
  rdma: '../detailed/k3_b1_1000_rdma_sram_search.js',
  final: '../detailed/k3_rdma_final_tuning_search.js'
};
const name = process.argv[2];
if (!SEARCHES[name]) throw new Error(`usage: run_search.js <${Object.keys(SEARCHES).join('|')}>`);
process.chdir(path.resolve(__dirname, '../..'));
require(SEARCHES[name]).run();
