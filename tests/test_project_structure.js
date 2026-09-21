'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ignoredDirs = new Set(['.git', 'node_modules']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else out.push(file);
  }
  return out;
}

const files = walk(root);
const missingRequires = [];
const brokenLinks = [];

for (const file of files) {
  const ext = path.extname(file);
  if (!['.js', '.html', '.md'].includes(ext)) continue;
  const text = fs.readFileSync(file, 'utf8');

  if (ext === '.js') {
    for (const match of text.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const raw = path.resolve(path.dirname(file), match[1]);
      const candidates = [raw, `${raw}.js`, `${raw}.json`];
      if (!candidates.some(candidate => fs.existsSync(candidate))) {
        missingRequires.push(`${path.relative(root, file)} -> ${match[1]}`);
      }
    }
  }

  if (ext === '.html' || ext === '.md') {
    for (const match of text.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) {
      const link = match[1];
      if (/^(?:#|https?:|mailto:|data:|javascript:)/i.test(link)) continue;
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

for (const required of [
  'src/core', 'src/simulation', 'src/search', 'src/rdma',
  'scripts', 'tests', 'templates', 'data', 'reports',
  'docs', 'docs/design', 'references', '.github/workflows'
]) {
  assert(fs.statSync(path.join(root, required)).isDirectory(), `Missing directory: ${required}`);
}

console.log(`PASS repository structure: ${files.length} files, all local requires and links resolve`);

