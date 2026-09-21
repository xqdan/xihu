'use strict';
const fs=require('fs'),assert=require('assert'),crypto=require('crypto');
const R=require('../src/rdma/k3_sram_memory_rdma_model.js');
const d=JSON.parse(fs.readFileSync('data/rdma/k3_b1_1000_rdma_sram_results.json','utf8'));
assert.equal(d.batch,1);assert.equal(d.target,1000);assert.equal(d.tp,32);
const h=crypto.createHash('sha256');for(const f of ['src/rdma/k3_b1_1000_rdma_sram_search.js','src/rdma/k3_sram_memory_rdma_model.js','src/search/k3_architecture_search.js','src/simulation/k3_operator_sram_sim.js','src/core/design_engine.js'])h.update(fs.readFileSync(f));assert.equal(d.inputHash,h.digest('hex'));
const s=d.extended;assert.equal(s.qualified,s.rows.filter(r=>r.tps>=1000).length);assert.equal(s.best.tps,Math.max(...s.rows.map(r=>r.tps)));
for(const r of s.rows){assert(r.feasible);assert(r.peakReservedMiB<=r.sramMiB+1e-7);assert(r.backingGB<=128);assert(r.rdmaReserveMiB>=0);assert(r.rawUs+1e-7>=(r.readBytes+r.writeBytes)/(r.dmaTBs*1e6));}
const replay=R.evaluate(s.best.x);assert(Math.abs(replay.tps-s.best.tps)<1e-7);assert.equal(replay.layers===undefined,true);
let m=new R.Mailbox(2);m.begin(1);m.write(1,0,[1]);m.write(1,1,[2]);m.commit(1,0);m.commit(1,1);assert.deepEqual(m.consume(),[[1],[2]]);m.ack(1,0);m.ack(1,1);m.release();assert.throws(()=>m.begin(1));
const lm=R.lseMerge([{m:0,l:2,o:[1,2]},{m:Math.log(2),l:1,o:[3,4]}]);assert(Math.abs(lm.m-Math.log(2))<1e-12);assert(lm.l>0);assert(lm.o.every(Number.isFinite));
const html=fs.readFileSync('reports/rdma/k3_b1_1000_rdma_sram_report.html','utf8');assert(html.includes('直接读写远端 SRAM'));assert(html.includes('remote SRAM address'));assert(!/NaN|undefined|Infinity/.test(html));assert.equal((html.match(/<svg /g)||[]).length,1);
console.log('PASS RDMA-SRAM search, replay, SRAM capacity, mailbox epoch lifecycle, LSE merge, HTML');
