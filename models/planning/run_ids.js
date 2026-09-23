'use strict';
/* Run identifiers shared by the Stage A / Stage B runners, tests and the
 * dashboard. Bump RUN_DATE when inputs change so artifacts are not silently
 * regenerated under an older run id. */
const RUN_DATE = '2026-09-23';
const compact = RUN_DATE.replace(/-/g, '');
module.exports = {
  RUN_DATE,
  stageARunId: `stage-a-${compact}-calibrated-workload`,
  stageBRunId: `stage-b-${compact}-formal`,
  stageAReport: `reports/direction/stage_a_blocker_resolution_${compact}.md`,
  stageBReport: `reports/detailed/stage_b_formal_run_${compact}.md`,
  seed: Number(compact)
};
