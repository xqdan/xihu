# Generated artifacts

Everything in this directory is written by a script in `integration/pipelines/` (or a search in `integration/detailed/`). Do not edit these files by hand; rerun the generator and commit the result together with the change that caused it. Tests bind many of these files to their sources by sha256, so a stale artifact fails `npm test`.

| Directory | Content | Generator |
|---|---|---|
| `workload/` | `planning_operator_workload.json` (planning operator rows, token-time calibration); `tps_observation_matrix.json` (three models × TP8/16/32 × MC320/640 planning estimates on the single hardware spec; `null` means no event-level replay yet) | `generate_planning_operator_workload.js`, `stage_b.js` |
| `direction/` | Stage A envelope, scorecard, sensitivity sweep, workload baseline and the Stage A report | `stage_a.js`, `sync_baseline_spec.js` |
| `detailed/` | Stage B run, synthetic event replay and the Stage B report | `stage_b.js` |
| `governance/` | Gate status, candidate register, manifest binding, direction feedback | `stage_a.js`, `stage_b.js`, `generate_direction_feedback.js` |
| `contracts/` | Model/hardware/software contracts and the integration manifest | `generate_team_contracts.js` |
| `verification/` | Timing evidence status | `generate_team_contracts.js` |
| `dashboard/` | Global dashboard | `generate_global_dashboard.js` |
| `rdma/` | K3 Final Tuning search results and report (the published point) | `run_search.js` |
| `agents/` | Agent organization detail and HTML | `generate_agent_org_*.js` |

One file is only partly generated: `direction/directional_workload_baseline.json` is the Stage A workload baseline of 2026-09-21; `sync_baseline_spec.js` rewrites only its K3 calibration block, the other fields are maintained by hand (explain the change in the PR).

The Stage A/B artifacts embed the git HEAD and the generation time, so regenerating them always produces a diff; compare the numeric fields, not the whole file.
