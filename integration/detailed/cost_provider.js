'use strict';
/* Operator cost provider (ARCH-CH-02, teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md;
 * the measured -> predicted -> analytical fallback borrowed from Charon's fused engine).
 *
 * mappedPlan (k3_architecture_search.js) asks here for every compute op's kernel body time, the
 * `kernel` line of its timing: the matrix/vector/unpack body on the card, before fused softmax
 * hiding and without shared->local staging, flush, reduce, die link or launch. Lookup order:
 *   1. measured: an observation of the same op at the same shape {flops, readBytes, writeBytes}
 *      on the same hardware (HW_KEYS of x);
 *   2. fitted:   two observations of that op and hardware whose shapes bracket the query on a
 *      line (query = a + l (b - a), 0 <= l <= 1); linear interpolation, never extrapolation;
 *   3. analytical: the value mappedPlan computed, i.e. the model as it stands.
 * Every op is tagged with costSource and costEvidence; COMM ops are analytical by construction.
 *
 * The observation table (OBSERVATIONS_FILE) is empty: nothing is measured yet and every op takes
 * branch 3, so no number in the repository moves. Entries need the measurement environment,
 * repeat count and error (docs/architecture/14_TPS_OBSERVATION_METRICS.md §3). External numbers (references/) are
 * not observations of this hardware and may not enter the table.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const OBSERVATIONS_FILE = 'teams/vv/inputs/operator_cost_observations.json';
const FORMAT = 'k3-operator-cost-observations/1';
// Fields of x that decide a kernel body on one core type: core arrays, clock, vector lanes,
// local SRAM and banks, TMA, and the attention tiling. Shared SRAM, MC, NoC, UCIe and RDMA
// are outside the kernel body (they set staging, DMA and collectives, which stay analytical).
const HW_KEYS = ['nL', 'nH', 'lRows', 'lCols', 'lEngines', 'hRows', 'hCols', 'hEngines', 'ghz', 'vectorLanes',
  'lMiB', 'hMiB', 'lBanks', 'hBanks', 'bankBytes', 'tmaEngines', 'tmaBytes', 'kvTile', 'headTile'];
const SHAPE_KEYS = ['flops', 'readBytes', 'writeBytes'];
// Ordered strongest first; a fitted value carries the weaker of its two samples.
const EVIDENCE = ['SILICON_OBSERVED', 'EMULATION_OBSERVED'];
const SOURCES = ['measured', 'fitted', 'analytical'];
const ANALYTICAL = {source: 'analytical', evidence: 'MODEL'};
const REL = 1e-9;

const same = (a, b) => Math.abs(a - b) <= REL * Math.max(1, Math.abs(a), Math.abs(b));
const hwKey = hw => HW_KEYS.map(k => `${k}=${hw[k]}`).join(',');

function validate(list, where) {
  const keys = new Set();
  list.forEach((o, i) => {
    const at = `${where} observations[${i}]`;
    for (const k of ['id', 'op', 'source', 'environment']) if (typeof o[k] !== 'string' || !o[k]) throw new Error(`${at}: ${k} must be a non-empty string`);
    for (const k of SHAPE_KEYS) if (!(o.shape && Number.isFinite(o.shape[k]) && o.shape[k] >= 0)) throw new Error(`${at}: shape.${k} must be a number >= 0`);
    for (const k of HW_KEYS) if (!(o.hardware && Number.isFinite(o.hardware[k]))) throw new Error(`${at}: hardware.${k} is required`);
    if (!(o.kernelUs > 0)) throw new Error(`${at}: kernelUs must be > 0`);
    if (!EVIDENCE.includes(o.evidence)) throw new Error(`${at}: evidence must be one of ${EVIDENCE.join(', ')}`);
    if (!(Number.isInteger(o.repeats) && o.repeats >= 1)) throw new Error(`${at}: repeats must be an integer >= 1`);
    if (!(Number.isFinite(o.errorUs) && o.errorUs >= 0)) throw new Error(`${at}: errorUs must be a number >= 0`);
    const key = `${o.op}|${hwKey(o.hardware)}|${SHAPE_KEYS.map(k => o.shape[k]).join(',')}`;
    if (keys.has(key)) throw new Error(`${at}: duplicate observation of ${o.op} at the same shape and hardware`);
    keys.add(key);
  });
  return list;
}

// op name -> hardware key -> observations
function index(list) {
  const by = new Map();
  for (const o of list) {
    if (!by.has(o.op)) by.set(o.op, new Map());
    const h = by.get(o.op), k = hwKey(o.hardware);
    if (!h.has(k)) h.set(k, []);
    h.get(k).push(o);
  }
  return by;
}

function load() {
  const table = JSON.parse(fs.readFileSync(path.join(root, OBSERVATIONS_FILE), 'utf8'));
  if (table.format !== FORMAT) throw new Error(`${OBSERVATIONS_FILE}: format ${table.format} is not ${FORMAT}`);
  return validate(table.observations, OBSERVATIONS_FILE);
}

let current = index(load());

// Run fn with a different observation list in place of the table (tests and what-if replays).
function withObservations(list, fn) {
  const saved = current;
  current = index(validate(list, 'withObservations'));
  try { return fn(); } finally { current = saved; }
}

const weaker = (a, b) => EVIDENCE[Math.max(EVIDENCE.indexOf(a), EVIDENCE.indexOf(b))];

// Position of q on the segment a -> b, or null if q is off the segment.
function along(q, a, b) {
  const d = SHAPE_KEYS.map(k => b.shape[k] - a.shape[k]);
  const n2 = d.reduce((s, v) => s + v * v, 0);
  if (!(n2 > 0)) return null;
  const l = SHAPE_KEYS.reduce((s, k, i) => s + (q[k] - a.shape[k]) * d[i], 0) / n2;
  if (l < -REL || l > 1 + REL) return null;
  return SHAPE_KEYS.every((k, i) => same(q[k], a.shape[k] + l * d[i])) ? Math.min(1, Math.max(0, l)) : null;
}

// {us, source, evidence, observations?} for one op. `analyticUs` is mappedPlan's own value.
function kernelCost(op, shape, hw, analyticUs) {
  const samples = current.size && current.get(op) && current.get(op).get(hwKey(hw));
  if (!samples) return {us: analyticUs, ...ANALYTICAL};
  const hit = samples.find(o => SHAPE_KEYS.every(k => same(o.shape[k], shape[k])));
  if (hit) return {us: hit.kernelUs, source: 'measured', evidence: hit.evidence, observations: [hit.id]};
  // The tightest bracketing pair, so a denser sample set always wins over a wider one.
  let best = null;
  for (let i = 0; i < samples.length; i++) for (let j = i + 1; j < samples.length; j++) {
    const [a, b] = [samples[i], samples[j]], l = along(shape, a, b);
    if (l === null) continue;
    const span = SHAPE_KEYS.reduce((s, k) => s + Math.abs(b.shape[k] - a.shape[k]), 0);
    if (!best || span < best.span) best = {a, b, l, span};
  }
  if (!best) return {us: analyticUs, ...ANALYTICAL};
  const {a, b, l} = best;
  return {us: a.kernelUs + l * (b.kernelUs - a.kernelUs), source: 'fitted', evidence: weaker(a.evidence, b.evidence), observations: [a.id, b.id]};
}

module.exports = {OBSERVATIONS_FILE, FORMAT, HW_KEYS, SHAPE_KEYS, EVIDENCE, SOURCES, ANALYTICAL, kernelCost, withObservations, validate};
