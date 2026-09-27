'use strict';
// The error-kind catalogue (src/error-kinds.js) against the kinds src/ and main really set: a kind set
// anywhere must be catalogued, and a catalogued kind must still be set somewhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { KINDS, MEANING, isKind } = require('../src/error-kinds');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
// rebase-editor.js runs as git's editor and sets no kinds; error-kinds.js is the catalogue itself.
const SKIP = new Set(['error-kinds.js', 'rebase-editor.js']);
const listJs = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js') && !SKIP.has(f))
  .map((f) => ({ file: dir === 'src' ? f : `${dir}/${f}`, text: fs.readFileSync(path.join(ROOT, dir, f), 'utf8') }));
// src/ plus the main process (main.js, main/: the IPC sender check sets 'forbidden', 'no-repo').
const sources = [...listJs('src'), ...listJs('main'), { file: 'main.js', text: fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8') }];

// Kinds set without a literal next to kindError / tagError: exec's kill reasons (killedBy), the
// interactive-rebase refusals (rebase.interactiveRefusal returns {kind, message}), push
// rejections (git-errors.classifyPush).
const DYNAMIC = ['timeout', 'too-large', 'aborted', 'too-many', 'merge-commits', 'root-commit', 'nothing',
  'rejected', 'rejected-behind', 'rejected-hook', 'rejected-stale'];

function kindsSet() {
  const found = new Map(); // kind -> first file
  const add = (k, file) => { if (!found.has(k)) found.set(k, file); };
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/\bkindError\(\s*'([a-z][a-z-]*)'/g)) add(m[1], file);
    // tagError(<the error>, 'kind'...): the first string literal after the first top-level comma.
    for (const m of text.matchAll(/\btagError\(([^'\n]*?),\s*'([a-z][a-z-]*)'/g)) add(m[2], file);
    if (file === 'git-errors.js') for (const m of text.matchAll(/\bkind: '([a-z][a-z-]*)'/g)) add(m[1], file);
  }
  for (const k of DYNAMIC) {
    if (sources.some(({ text }) => text.includes(`'${k}'`))) add(k, '(dynamic)');
  }
  return found;
}

test('every kind src/ and main set is in the catalogue', () => {
  const missing = [...kindsSet()].filter(([k]) => !isKind(k)).map(([k, f]) => `${k} (${f})`);
  assert.deepEqual(missing, [], 'add these to src/error-kinds.js');
});

test('every catalogued kind is still set somewhere in src/ or main', () => {
  const set = kindsSet();
  assert.deepEqual(Object.keys(MEANING).filter((k) => !set.has(k)), [], 'remove these from src/error-kinds.js (or list them in DYNAMIC)');
});

test('the catalogue: frozen, KINDS names each kind once, every meaning is one line', () => {
  assert.equal(Object.isFrozen(KINDS), true);
  assert.equal(Object.isFrozen(MEANING), true);
  assert.deepEqual(Object.values(KINDS).sort(), Object.keys(MEANING).sort()); // NOSONAR(S2871): ASCII names
  assert.equal(KINDS.CHECKED_OUT_ELSEWHERE, 'checked-out-elsewhere');
  assert.equal(KINDS.INVALID_ARGS, 'invalid-args');
  for (const [k, v] of Object.entries(MEANING)) {
    assert.match(k, /^[a-z]+(-[a-z]+)*$/);
    assert.equal(typeof v, 'string');
    assert.ok(v && !v.includes('\n'), k);
  }
  assert.equal(isKind('stale'), true);
  assert.equal(isKind('toString'), false);
});

test('the UMD file works as a plain browser script (window.PLErrorKinds)', () => {
  const vm = require('node:vm');
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(SRC, 'error-kinds.js'), 'utf8'), { window });
  assert.equal(window.PLErrorKinds.KINDS.STALE, 'stale');
  assert.equal(window.PLErrorKinds.isKind('bare-repo'), true);
});
