'use strict';
const fs=require('fs'),assert=require('assert'),O=require('../src/k3_rdma_localport_compete_model.js');
const d=require('../data/k3_rdma_localport_compete_results.json'),b=d.search.best;
assert.equal(d.target,1000);assert(b.feasible);assert.equal(b.tps,Math.max(...d.search.rows.map(r=>r.tps)));assert(b.peakReservedMiB<=b.sramMiB+1e-7);assert(b.services.localTma<292.7);assert(b.services.kernel<402.5);assert(!/NaN|undefined|Infinity/.test(fs.readFileSync('archive/rdma_variants/reports/k3_rdma_localport_compete_report.html','utf8')));const r=O.evaluate(b.x);assert(Math.abs(r.tps-b.tps)<1e-7);console.log('PASS local SRAM contention mitigation',b.tps.toFixed(2),'TPS',b.rawUs.toFixed(2),'us raw');
