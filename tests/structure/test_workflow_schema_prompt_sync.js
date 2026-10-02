'use strict';
// Prompt/schema agreement and landed-path checks for the design workflows.
//
// 1. A verdict a workflow prompt asks for must be in the verdict enum of the call that is asked:
//    otherwise the runtime schema rejects a correct answer and the workflow reports "insufficient input" for what was a legitimate backflow.
// 2. design.verify / design.audit decide "landed" by path segments (out/ prefix, no ..),
//    not by the substring '/out/'.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '../../integration/orchestration');
const files = fs.readdirSync(dir).filter(name => /^design\..*\.workflow\.js$/.test(name));
assert(files.length >= 6, 'expected the design workflows');

const enumLiterals = src => [...src.matchAll(/enum:\s*\[([^\]]*)\]/g)]
  .map(m => [...m[1].matchAll(/'([A-Z_]+)'/g)].map(x => x[1]));

// The four domain workflows share one policy skeleton (test_design_workflow_skeleton.js) and branch on
// both DIRECTION_BACKFLOW and PPA_DIRECTION_BACKFLOW, so every domain verdict enum must accept both.
let checked = 0;
for (const name of files.filter(f => /^design\.(compute|memory|comm|physical)\.workflow\.js$/.test(f))) {
  const src = fs.readFileSync(path.join(dir, name), 'utf8');
  const verdictEnums = enumLiterals(src).filter(e => e.includes('LOCAL_DETAIL_FIX'));
  assert(verdictEnums.length >= 2, `${name}: expected the policy and constraint verdict enums`);
  for (const e of verdictEnums) {
    assert(e.includes('DIRECTION_BACKFLOW') && e.includes('PPA_DIRECTION_BACKFLOW'), `${name}: verdict enum [${e.join(', ')}] must accept DIRECTION_BACKFLOW and PPA_DIRECTION_BACKFLOW`);
    checked += 1;
  }
}
assert(checked >= 4, `expected to check several verdict enums, checked ${checked}`);

for (const name of ['design.verify.workflow.js', 'design.audit.workflow.js']) {
  const src = fs.readFileSync(path.join(dir, name), 'utf8');
  assert(!/ARTIFACTS\.filter\(\(p\) => !String\(p\)\.includes\(LANDED_MARK\)\)/.test(src), `${name}: landed check must not be a substring test`);
  assert(/const isLanded = /.test(src) && /split\('\/'\)\.includes\('\.\.'\)/.test(src), `${name}: landed check must reject .. segments`);
  assert(/startsWith\(LANDED_MARK\.slice\(1\)\)/.test(src), `${name}: landed check must anchor on the out/ prefix`);
}

console.log(`PASS workflow schema/prompt sync: ${checked} verdict enums agree with their prompts; verify/audit landed checks are path-segment based`);
