'use strict';
// src/namespace.js holds the names the app owns in a repository; src/rebase-editor.js (git's
// editor process, no dependencies) keeps its own copies on purpose: pinned to the same values.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ns = require('../src/namespace');

test("rebase-editor.js's own copies match namespace.js", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'rebase-editor.js'), 'utf8');
  assert.ok(src.includes(`path.join(gitDir, '${ns.PL_DIR}', '${ns.REBASE_DIR}')`), 'the state folder <git-dir>/pasta-lite/rebase');
  assert.ok(src.includes(`path.join(gitDir, '${ns.PL_DIR}')`), 'the plain-folder check of <git-dir>/pasta-lite');
  assert.ok(src.includes(`${ns.HELPER_REFUSED}: `), 'the refusal marker git-errors.helperRefused reads');
});

test('the refs sit in our namespaces', () => {
  for (const ref of [ns.AUTOSTASH_REF, ns.LEGACY_AUTOSTASH_REF, ns.BACKUP_REF]) {
    assert.ok(ns.REF_NAMESPACES.some((p) => ref.startsWith(p)), ref);
  }
  assert.ok(ns.AUTOSTASH_REF.startsWith('refs/worktree/'), 'per worktree');
});
