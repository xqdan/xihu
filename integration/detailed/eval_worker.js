'use strict';
// Worker thread of eval_pool.js: loads the module named in workerData and answers each message
// {items} with {results} (fn applied to every item, in order) or {error}.
const {parentPort, workerData} = require('worker_threads');

const call = require(workerData.module)[workerData.fn];

parentPort.on('message', ({items}) => {
  try {
    parentPort.postMessage({results: items.map(item => call(item))});
  } catch (error) {
    parentPort.postMessage({error: String((error && error.stack) || error)});
  }
});
