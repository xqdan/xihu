'use strict';
/* The baseline's own design point, for the modules that replay it.
 *
 * teams/hardware/inputs/k3_mc_baseline.json is synced either from the Final Tuning search best
 * (no designPoint block: tpsDesign.hardware.x at the model's own OPT and model) or, after an ADR,
 * from a landed joint point (a designPoint block carrying the point's OPT patch and model patch;
 * integration/pipelines/sync_baseline_spec.js --point joint). A module that replays
 * tpsDesign.hardware.x under the model's own OPT and model is right only in the first case.
 * publishedX() hands it the x and stops it in the second, naming the point and the ADR, so a joint
 * baseline is never replayed without its patch.
 *
 * No dependencies: the domain searches load this, and the modules that do honour the patch
 * (coupling_search.withPoint) load the domain searches.
 */

const patched = spec => Boolean(spec.designPoint && (spec.designPoint.opt || spec.designPoint.model));

function publishedX(spec, consumer) {
  if (patched(spec)) {
    const p = spec.designPoint;
    throw new Error(`${consumer} replays tpsDesign.hardware.x under the model's own OPT and model, but the baseline is the `
      + `${p.kind} point ${p.optionId} (${p.adr}) with an OPT / model patch; ${consumer} is not wired to a patched baseline yet`);
  }
  return spec.tpsDesign.hardware.x;
}

module.exports = {patched, publishedX};
