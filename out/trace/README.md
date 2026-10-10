# Execution trace

`k3_published_point.trace.json` is the detailed simulator's schedule of one Batch=1 decode step at the published point (one rank of TP32), as Chrome Trace Event JSON. Open it in <https://ui.perfetto.dev> or `chrome://tracing`.

- Generator: `npm run trace:published` (`integration/pipelines/generate_execution_trace.js`, built by `integration/detailed/execution_trace.js`). Do not edit by hand.
- Contract: [`docs/architecture/contracts/EXECUTION_TRACE.md`](../../docs/architecture/contracts/EXECUTION_TRACE.md) — tracks, event types, required args, units (microseconds) and the conservation checks.
- Evidence class **MODEL**. It is a view of the model, not an observed timeline: it is not `VALIDATED_EVENT_TIMING` and changes no gate and no baseline number.
- The tracks reconcile with the simulator's time ledger to within 1e-6 µs (`k3Trace.reconciliation`); the generator refuses to write a trace that does not. `tests/regression/test_execution_trace.js` checks the committed file against a rebuild, and `tests/governance/test_regeneration_reproducible.js` reruns the generator.
- Provenance is the sha256 of the baseline and of the simulator sources (`k3Trace.provenance`), not a commit, so the file changes only when one of them does.

Mechanism-rollback diffs (`npm run trace:published -- --diff <mechanism> [--traces]`) go to `scratch/trace/`, not here.
