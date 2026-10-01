'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
// Only the repository layout is checked; local scratch directories (for example
// untracked src/ or scripts/ experiments) are outside it.
const scannedDirs = ['teams', 'integration', 'out', 'docs', 'archive', 'tests', 'references', '.github'];
const rootFiles = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else out.push(file);
  }
  return out;
}

const files = [
  ...rootFiles.map(f => path.join(root, f)),
  ...scannedDirs.flatMap(d => walk(path.join(root, d)))
];
const missingRequires = [];
const brokenLinks = [];
const teamViolations = [];
const archiveViolations = [];
const isArchived = file => path.relative(root, file).split(path.sep)[0] === 'archive';
const teamOf = file => {
  const m = path.relative(root, file).split(path.sep);
  return m[0] === 'teams' && m.length > 2 ? m[1] : null;
};

for (const file of files) {
  const ext = path.extname(file);
  if (!['.js', '.html', '.md'].includes(ext)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const team = teamOf(file);

  if (ext === '.js') {
    for (const match of text.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const raw = path.resolve(path.dirname(file), match[1]);
      const candidates = [raw, `${raw}.js`, `${raw}.json`];
      if (!candidates.some(candidate => fs.existsSync(candidate))) {
        missingRequires.push(`${path.relative(root, file)} -> ${match[1]}`);
      }
      // Team rule: team code depends only on its own team directory; cross-team code lives in integration/.
      if (team && teamOf(raw) !== team) teamViolations.push(`${path.relative(root, file)} requires ${match[1]}`);
      // archive/ is read-only history: nothing outside it may depend on it.
      if (isArchived(raw) && !isArchived(file)) archiveViolations.push(`${path.relative(root, file)} requires ${match[1]}`);
    }
    if (team) {
      for (const match of text.matchAll(/['"`](?:integration|out|teams\/(\w+))\//g)) {
        if (match[1] !== team) teamViolations.push(`${path.relative(root, file)} reads ${match[0].slice(1)}`);
      }
    }
  }

  if (ext === '.html' || ext === '.md') {
    for (const match of text.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) {
      const link = match[1];
      if (/^(?:#|https?:|mailto:|data:|javascript:)/i.test(link) || link.includes('${')) continue;
      const local = link.split('#', 1)[0].split('?', 1)[0];
      if (!local) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), local))) {
        brokenLinks.push(`${path.relative(root, file)} -> ${link}`);
      }
    }
    if (ext === '.md') {
      for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
        const link = match[1];
        if (/^(?:#|https?:|mailto:|data:)/i.test(link)) continue;
        const local = link.split('#', 1)[0].split('?', 1)[0];
        if (local && !fs.existsSync(path.resolve(path.dirname(file), local))) {
          brokenLinks.push(`${path.relative(root, file)} -> ${link}`);
        }
      }
    }
  }
}

assert.deepEqual(missingRequires, [], `Missing require targets:\n${missingRequires.join('\n')}`);
assert.deepEqual(brokenLinks, [], `Broken local links:\n${brokenLinks.join('\n')}`);
assert.deepEqual(archiveViolations, [], `Live code must not require archive/:\n${archiveViolations.join('\n')}`);
assert.deepEqual(teamViolations, [], `Team directories must not depend on other teams, integration/ or out/:\n${teamViolations.join('\n')}`);

for (const required of [
  'teams/model/inputs', 'teams/model/src', 'teams/model/docs/deployment', 'teams/hardware/inputs', 'teams/hardware/src', 'teams/hardware/docs', 'teams/software/docs',
  'teams/council/adr', 'teams/council/docs', 'teams/council/inputs', 'teams/vv',
  'integration/detailed', 'integration/planning', 'integration/governance', 'integration/pipelines',
  'out', 'docs/architecture', 'archive', 'tests/unit', 'tests/regression', 'tests/governance', 'tests/structure',
  'references', '.github/workflows'
]) {
  assert(fs.statSync(path.join(root, required)).isDirectory(), `Missing directory: ${required}`);
}
for (const dir of ['teams/model', 'teams/hardware', 'teams/software', 'teams/council', 'teams/vv', 'teams/council/adr', 'integration', 'integration/pipelines', 'out', 'archive', 'tests']) {
  assert(fs.existsSync(path.join(root, dir, 'README.md')), `Missing ${dir}/README.md`);
}
for (const team of ['model', 'hardware', 'software']) {
  JSON.parse(fs.readFileSync(path.join(root, 'teams', team, 'contract.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// Docs vs flow: the operating-model documents describe stage names, not agents.
//
// The refactor (teams/council/docs/22_*) moved the design process into
// integration/orchestration/ workflows and reduced an "agent" to a stateless
// policy. 17/18/19 predate that and still label their sections D1..D7 / Q1..Q9.
// Those labels are kept as *stage names*; if a future edit turns one of them
// back into a role ("the D3 agent decides..."), the docs and the roster start
// disagreeing and readers go looking for an agent that does not exist.
// ---------------------------------------------------------------------------
const FLOW_DOC = 'teams/council/docs/22_AGENT_WORKFLOW_REFACTOR_PLAN.md';
const STAGE_NAME_DOCS = [
  'teams/council/docs/17_TWO_STAGE_ARCHITECTURE_OPERATING_MODEL.md',
  'teams/council/docs/18_AGENT_CATALOG_AND_INTERACTION_PROTOCOL.md',
  'teams/council/docs/19_DETAILED_ARCHITECTURE_OPERATING_MODEL.md',
];

assert(fs.existsSync(path.join(root, FLOW_DOC)), `Missing flow document: ${FLOW_DOC}`);

// Every doc that uses the old notation must say, in the document itself, that
// the notation is a stage name and must point at the document that supersedes it.
const notSuperseded = [];
for (const doc of STAGE_NAME_DOCS) {
  const text = fs.readFileSync(path.join(root, doc), 'utf8');
  if (!text.includes('阶段名，不是 agent')) notSuperseded.push(`${doc}: 未标注 D*/Q* 是阶段名`);
  if (!text.includes('22_AGENT_WORKFLOW_REFACTOR_PLAN.md')) notSuperseded.push(`${doc}: 未指向 22 号文档`);
  if (!/SUPERSEDED/.test(text)) notSuperseded.push(`${doc}: 状态未标 SUPERSEDED`);
}
assert.deepEqual(notSuperseded, [], `Stage-name / supersession markers:\n${notSuperseded.join('\n')}`);

// AGENTS.md and the two READMEs are the entry points; a reader who lands on any
// of them must not be able to conclude that D*/Q* are agents.
const entryPoints = ['AGENTS.md', 'docs/README.md', 'docs/architecture/README.md'];
const entryProblems = [];
for (const doc of entryPoints) {
  const text = fs.readFileSync(path.join(root, doc), 'utf8');
  if (!text.includes(FLOW_DOC)) entryProblems.push(`${doc}: 未指向 ${FLOW_DOC}`);
  if (!text.includes('阶段名，不是 agent')) entryProblems.push(`${doc}: 未写明 D*/Q* 是阶段名`);
}
assert.deepEqual(entryProblems, [], `Entry-point flow pointers:\n${entryProblems.join('\n')}`);

// The stage-name claim has to stay true: the roster still defines exactly the
// 12 strategies the docs say actually run, and no D*/Q* label leaked into it.
const roster = JSON.parse(fs.readFileSync(path.join(root, 'teams/council/inputs/agent_roster.json'), 'utf8'));
const strategyNames = roster.strategies.map(s => s.agentId);
const leakedStageNames = strategyNames.filter(n => /^[DQ]\d+$/.test(n) || n === 'A0');
assert.deepEqual(leakedStageNames, [], `D*/Q*/A0 are stage names, not roster strategies:\n${leakedStageNames.join('\n')}`);
assert.strictEqual(new Set(strategyNames).size, strategyNames.length, 'agent_roster.json 有重名策略');
assert(strategyNames.length === 12, `agent_roster.json 的策略数应为 12，实为 ${strategyNames.length}；文档里的 D*/Q* 由此才能成立`);

console.log(`PASS repository structure: ${files.length} files, all local requires and links resolve, no cross-team or archive dependencies, and the flow docs mark D*/Q* as stage names`);
