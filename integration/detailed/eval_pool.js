'use strict';
/* A pool of worker threads that each load one module and call one exported function on the items
 * they are given. pool.map(items) resolves to [fn(items[0]), fn(items[1]), ...]: the results come
 * back in the order of the items whatever order the workers finish in, which is what lets a search
 * keep its serial visiting order (ids, rejection counts, ties) while the evaluations run in parallel.
 *
 * Items and results cross the thread boundary by structured clone, so they must be plain data.
 * A pool of one job calls the function in the calling thread and starts no worker; it is the
 * serial reference the parallel path is compared against.
 *
 * Job count: K3_SEARCH_JOBS (a positive integer), otherwise the logical cores less one, capped.
 */
const os = require('os');
const path = require('path');
const {Worker} = require('worker_threads');

const WORKER_FILE = path.join(__dirname, 'eval_worker.js');
// Items per message. Most candidates of a search are rejected in well under a millisecond while a
// feasible one takes tens, so a message must carry few items or one worker ends up with all the slow ones.
const CHUNK = 4;
// Measured on a 20-thread laptop: 4 jobs 21 s, 8 jobs 18 s, 12 jobs 17 s, 19 jobs 19 s for the final search.
const MAX_DEFAULT_JOBS = 8;

function defaultJobs(env = process.env) {
  const configured = env.K3_SEARCH_JOBS;
  if (configured !== undefined && configured !== '') {
    const jobs = Number(configured);
    if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`K3_SEARCH_JOBS must be a positive integer, got ${configured}`);
    return jobs;
  }
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(MAX_DEFAULT_JOBS, cores - 1));
}

// `modulePath` is loaded by path (here and in each worker) because the worker has to load the same
// module on its own; a static import cannot name a module the caller chooses.
function createPool({module: modulePath, fn, jobs = defaultJobs()}) {
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`pool needs a positive integer job count, got ${jobs}`);
  if (jobs === 1) {
    const call = require(modulePath)[fn];
    return {size: 1, map: async items => items.map(item => call(item)), close: async () => {}};
  }

  const workers = [];
  const idle = [];
  const queue = [];
  const inflight = new Map();
  let failure = null;

  const fail = error => {
    if (failure) return;
    failure = error;
    for (const job of [...queue, ...inflight.values()]) job.fail(error);
    queue.length = 0;
    inflight.clear();
    for (const worker of workers) worker.terminate();
  };

  const pump = () => {
    while (!failure && idle.length && queue.length) {
      const worker = idle.pop();
      const job = queue.shift();
      inflight.set(worker, job);
      worker.postMessage({items: job.items});
    }
  };

  for (let i = 0; i < jobs; i++) {
    const worker = new Worker(WORKER_FILE, {workerData: {module: modulePath, fn}});
    worker.on('message', message => {
      if (failure) return;
      const job = inflight.get(worker);
      // A failed item leaves its job in `inflight`, so that fail() rejects it with the rest.
      if (message.error) return fail(new Error(message.error));
      inflight.delete(worker);
      job.done(message.results);
      idle.push(worker);
      pump();
    });
    worker.on('error', fail);
    worker.on('exit', code => { if (!failure && code !== 0) fail(new Error(`evaluation worker exited with code ${code}`)); });
    workers.push(worker);
    idle.push(worker);
  }

  const map = items => {
    if (failure) return Promise.reject(failure);
    const results = new Array(items.length);
    if (!items.length) return Promise.resolve(results);
    return new Promise((resolve, reject) => {
      let remaining = Math.ceil(items.length / CHUNK);
      for (let start = 0; start < items.length; start += CHUNK) {
        queue.push({
          items: items.slice(start, start + CHUNK),
          done: out => {
            for (let i = 0; i < out.length; i++) results[start + i] = out[i];
            if (--remaining === 0) resolve(results);
          },
          fail: reject
        });
      }
      pump();
    });
  };

  const close = async () => {
    failure = failure || new Error('pool closed');
    await Promise.all(workers.map(worker => worker.terminate()));
  };

  return {size: jobs, map, close};
}

module.exports = {createPool, defaultJobs};
