'use strict';
/* Run identifiers shared by the Stage A / Stage B runners, tests and the
 * dashboard. Bump RUN_DATE when inputs change so artifacts are not silently
 * regenerated under an older run id. */
const RUN_DATE = '2026-09-25';
const compact = RUN_DATE.replace(/-/g, '');
module.exports = {
  RUN_DATE,
  stageARunId: `stage-a-${compact}-token-time`,
  stageBRunId: `stage-b-${compact}-planning`,
  stageAReport: `out/direction/stage_a_blocker_resolution_${compact}.md`,
  stageBReport: `out/detailed/stage_b_planning_run_${compact}.md`,
  seed: Number(compact)
};
