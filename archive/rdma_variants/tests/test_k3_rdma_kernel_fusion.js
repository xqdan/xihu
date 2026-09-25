'use strict';
const fs=require('fs'),assert=require('assert'),O=require('../src/k3_rdma_kernel_fusion_model.js');
const d=require('../data/k3_rdma_kernel_fusion_results.json'),b=d.search.best;
assert.equal(d.target,1000);assert(b.feasible);assert.equal(b.tps,Math.max(...d.search.rows.map(r=>r.tps)));assert(b.peakReservedMiB<=b.sramMiB+1e-7);assert(b.tps>853.5);assert(!/NaN|undefined|Infinity/.test(fs.readFileSync('archive/rdma_variants/reports/k3_rdma_kernel_fusion_report.html','utf8')));const r=O.evaluate(b.x);assert(Math.abs(r.tps-b.tps)<1e-7);console.log('PASS kernel fusion',b.tps.toFixed(2),'TPS',b.rawUs.toFixed(2),'us raw');
