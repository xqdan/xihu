'use strict';

// The final tuning search runs its candidate evaluations on a worker pool. It has to give the result
// the serial search gave -- row ids, rejection counts, tie order, the random stream -- because
// out/rdma/k3_rdma_final_tuning_results.json is pinned and everything downstream hashes it.
//
// serialSearch below is the search as it was before the pool (commit bf714c3), kept verbatim as the
// reference. It is run on a reduced configuration (eight knobs with two values, the rest fixed, and a
// short schedule) so the test takes seconds, and its whole result is compared with search() at one
// job (evaluating in the calling thread) and at several (worker threads). The configuration is chosen
// so that a seed needs repair, the initial loop and the offspring loops stop part-way through a batch
// (the random stream has to be put back) and polish visits new candidates.
//
// Also pinned here: the xorshift generator copy against A.rng, and the pool's order, error and
// job-count behaviour.

const assert = require('assert');
const A = require('../../integration/detailed/k3_architecture_search.js');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const S = require('../../integration/detailed/k3_rdma_final_tuning_search.js');
const {createPool, defaultJobs} = require('../../integration/detailed/eval_pool.js');

const {pairSteps} = S;
// ---- the serial search of bf714c3, verbatim ----
const serialSearch = function(space,seeds,{initial=120,generations=4,offspring=40,polish=2,seed=20260929}={}){const rand=A.rng(seed),pick=a=>a[Math.floor(rand()*a.length)],keys=Object.keys(space),seen=new Set(),rows=[],rejects={},progress=[];let attempts=0;const test=z=>{const key=keys.map(k=>z[k]).join('|');if(seen.has(key))return;seen.add(key);attempts++;const r=O.evaluate(z);if(!r.feasible){for(const k of r.reasons||[r.reason])rejects[k]=(rejects[k]||0)+1;return;}r.id=rows.length;r.collectiveCount=r.protocol.reduce((s,a)=>s+a.count,0);rows.push(r);};const ord=()=>rows.slice().sort((a,b)=>b.tps-a.tps||a.p.dieArea-b.p.dieArea);const broken=[];for(const z0 of seeds){const z={};for(const k of keys)z[k]=space[k].reduce((a,b)=>Math.abs(a-z0[k])<=Math.abs(b-z0[k])?a:b);const n=rows.length;test(z);if(rows.length===n&&!rows.some(r=>keys.every(k=>r.x[k]===z[k])))broken.push(z);}for(const z of broken){for(const k of keys)for(const v of space[k])if(v!==z[k])test({...z,[k]:v});for(const y of pairSteps(space,z))test(y);}let tries=0;while(rows.length<initial&&tries++<initial*1000)test(Object.fromEntries(keys.map(k=>[k,pick(space[k])] )));for(let g=0;g<generations;g++){const elite=ord().slice(0,16),target=rows.length+offspring;tries=0;while(rows.length<target&&tries++<offspring*1000){const z={...pick(elite).x},other=pick(elite).x;if(rand()<.3)for(const k of keys)if(rand()<.5)z[k]=other[k];for(let i=0,n=1+Math.floor(rand()*5);i<n;i++){const k=pick(keys);z[k]=pick(space[k]);}test(z);}progress.push({phase:'gen '+(g+1),count:rows.length,tps:ord()[0].tps});}for(let pass=0;pass<polish;pass++){for(const r of ord().slice(0,3))for(const k of keys)for(const v of space[k])if(v!==r.x[k])test({...r.x,[k]:v});for(const r of ord().slice(0,2))for(const z of pairSteps(space,r.x))test(z);progress.push({phase:'local '+(pass+1),count:rows.length,tps:ord()[0].tps});}return {space,options:{initial,generations,offspring,polish,seed},attempts,rejects,progress,best:Object.assign(O.evaluate(ord()[0].x,true),{collectiveCount:ord()[0].collectiveCount}),rows};};
// ---- end of the verbatim reference ----

// An await that never settles ends the process quietly with status 0; that must not read as a pass.
let finished = false;
process.on('exit', () => {
  if (!finished) {
    console.error('the test ended before it finished: a promise never settled');
    process.exitCode = 1;
  }
});

(async () => {
  // 1. The copy of the generator draws what A.rng draws, and restore() rewinds it exactly.
  {
    const a = A.rng(20260929), b = S.stateRng(20260929);
    for (let i = 0; i < 2000; i++) assert.strictEqual(b(), a(), `draw ${i} differs from A.rng`);
    const c = S.stateRng(7), d = A.rng(7);
    for (let i = 0; i < 10; i++) c();
    const mark = c.state(), expected = [c(), c(), c()];
    c.restore(mark);
    assert.deepStrictEqual([c(), c(), c()], expected, 'restore() must put the stream back');
    for (let i = 0; i < 10; i++) d();
    assert.deepStrictEqual([d(), d(), d()], expected, 'the restored stream must be the A.rng stream');
  }

  // 2. The pool returns results in item order, reports a failing item, and validates its job count.
  {
    const items = ['/a/one.txt', '/b/two.txt', '/c/three.txt', '/d/four.txt', '/e/five.txt', '/f/six.txt', '/g/seven.txt', '/h/eight.txt', '/i/nine.txt'];
    for (const jobs of [1, 3]) {
      const pool = createPool({module: 'path', fn: 'basename', jobs});
      try {
        assert.deepStrictEqual(await pool.map(items), ['one.txt', 'two.txt', 'three.txt', 'four.txt', 'five.txt', 'six.txt', 'seven.txt', 'eight.txt', 'nine.txt'], `order at ${jobs} jobs`);
        assert.deepStrictEqual(await pool.map([]), []);
        if (jobs === 1) {
          await assert.rejects(pool.map([1]), /must be of type string/);
        } else {
          await assert.rejects(pool.map(['/x/ok.txt', 7, '/y/ok2.txt']), /must be of type string/, 'a failing item must reject the whole map');
          await assert.rejects(pool.map(['/x/ok.txt']), 'a pool that has failed must keep failing');
        }
      } finally {
        await pool.close();
      }
    }
    assert.throws(() => createPool({module: 'path', fn: 'basename', jobs: 0}), /positive integer/);
    assert.strictEqual(defaultJobs({K3_SEARCH_JOBS: '5'}), 5);
    assert.throws(() => defaultJobs({K3_SEARCH_JOBS: 'many'}), /K3_SEARCH_JOBS/);
    assert(defaultJobs({}) >= 1 && defaultJobs({}) <= 8, 'default job count is bounded');
  }

  // 3. The reduced search: serial reference against one job and against worker threads.
  // A.BASE does not survive the SF4 / liquid basis, so it is the seed that has to be repaired.
  const seedsAll = [A.BASE, S.PRIOR_SEEDS[0], S.PUBLISHED_SEEDS[0]];
  const anchor = S.PUBLISHED_SEEDS[0];
  // Eight knobs take two values (the one nearest the anchor in S.EXT and its upper neighbour, or the
  // lower one at the top); the others are fixed at the anchor. Every candidate of a search costs a
  // full model evaluation when it is feasible, and the reference runs them one after another.
  const VARIED = new Set(['nL', 'nH', 'lEngines', 'hEngines', 'hRows', 'sharedMiB', 'kvTile', 'depth']);
  const space = {};
  for (const [k, values] of Object.entries(S.EXT)) {
    const nearest = values.reduce((p, q) => (Math.abs(p - anchor[k]) <= Math.abs(q - anchor[k]) ? p : q));
    const i = values.indexOf(nearest);
    space[k] = !VARIED.has(k) || values.length === 1 ? [nearest] : [values[i], values[i + 1 !== values.length ? i + 1 : i - 1]];
  }
  const options = {initial: 14, generations: 2, offspring: 6, polish: 2, seed: 20260929};

  const baseOnly = serialSearch(space, [A.BASE], {initial: 0, generations: 0, offspring: 0, polish: 0});
  assert(baseOnly.attempts > 1, 'A.BASE must need repair in the reduced space, or the repair path is not tested');

  const reference = serialSearch(space, seedsAll, options);
  assert(reference.rows.length > options.initial, 'the reduced search must produce rows');
  assert(reference.attempts > reference.rows.length, 'the reduced search must also reject candidates');
  const canon = r => JSON.stringify(r);
  const expected = canon(reference);

  for (const jobs of [1, 3, 6]) {
    const got = await S.search(space, seedsAll, {...options, jobs});
    assert.strictEqual(canon(got), expected, `search at ${jobs} job(s) must equal the serial reference`);
  }

  // A schedule whose loops end in the middle of a batch, from another stream.
  const other = {initial: 9, generations: 3, offspring: 5, polish: 1, seed: 424242};
  const referenceOther = canon(serialSearch(space, seedsAll, other));
  assert.strictEqual(canon(await S.search(space, seedsAll, {...other, jobs: 4})), referenceOther, 'a second stream must also match');

  finished = true;
  console.log(`PASS final tuning search: the pooled search (1, 3 and 6 jobs) reproduces the serial search row for row (${reference.rows.length} rows, ${reference.attempts} attempts), the generator copy matches A.rng, and the pool keeps order`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
