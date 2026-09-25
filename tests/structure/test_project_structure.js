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

console.log(`PASS repository structure: ${files.length} files, all local requires and links resolve, no cross-team or archive dependencies`);
