'use strict';
const fs=require('fs'),assert=require('assert'),O=require('../src/rdma/k3_rdma_optimized_model.js');
const d=require('../data/rdma/k3_rdma_optimized_results.json'),b=d.search.best;
assert.equal(d.target,1000);assert(b.feasible);assert.equal(b.tps,Math.max(...d.search.rows.map(r=>r.tps)));assert(b.peakReservedMiB<=b.sramMiB+1e-7);assert(b.phases<879);assert(b.services.memoryTransport<344);assert(!/NaN|undefined|Infinity/.test(fs.readFileSync('reports/rdma/k3_rdma_optimized_report.html','utf8')));const r=O.evaluate(b.x);assert(Math.abs(r.tps-b.tps)<1e-7);console.log('PASS optimized refresh',b.tps.toFixed(2),'TPS',b.rawUs.toFixed(2),'us raw');
