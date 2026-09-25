# Archive

Read-only history. Live code (`teams/`, `integration/`, `tests/`) must not require anything here (enforced by `tests/structure/test_project_structure.js`). Relative requires and links inside the archive were rewritten to the 2026-09-25 layout so they still resolve, but these files are not run by `npm test` and are not maintained; their stored results may not reproduce against the current models.

| Directory | Content | Superseded by |
|---|---|---|
| `rdma_variants/` | Six RDMA exploration variants (joint, kernel fusion, local port, local port compete, optimized, tile pipeline): models, searches, results, reports, tests | `integration/detailed/k3_rdma_final_tuning_*` |
| `sram_html_models/` | SRAM capacity and SRAM/TPS analysis scripts, data and reports | `integration/detailed/k3_operator_sram_sim.js` |
| `browser_figures/` | Browser-side KV figure helper | — |
| `reports/` | Earlier Stage A / Stage B run reports (2026-09-21 … 09-23) | `out/direction/`, `out/detailed/` |
| `docs/` | Superseded design notes | `docs/architecture/`, `teams/council/docs/` |

ADR numbers in archived files use the old short form (`ADR-011` …); the mapping is in [`teams/council/adr/README.md`](../teams/council/adr/README.md).
