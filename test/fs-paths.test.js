'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const { realPathSync, realPathOf, isAtOrUnder, REALPATH_TIMEOUT_MS } = require('../src/fs-paths');

/** A real folder, a symlink to it and a file, under one temp folder. */
function layout() {
  const base = fs.realpathSync.native(tmpDir());
  const dir = path.join(base, 'dir');
  fs.mkdirSync(dir);
  const link = path.join(base, 'link');
  fs.symlinkSync(dir, link);
  const file = path.join(base, 'file');
  fs.writeFileSync(file, 'x');
  return { base, dir, link, file };
}

test('realPathSync: symlinks resolved; a missing path is path.resolve', () => {
  const { base, dir, link } = layout();
  assert.equal(realPathSync(link), dir);
  assert.equal(realPathSync(dir), dir);
  assert.equal(realPathSync(path.join(link, 'missing', '..', 'x')), path.join(link, 'x'), 'missing: resolved, not followed');
  assert.equal(realPathSync(path.relative(process.cwd(), path.join(base, 'nope'))), path.join(base, 'nope'));
});

test('realPathOf: {real, missing}; missing only when the path is not there', async () => {
  const { base, dir, link, file } = layout();
  assert.deepEqual(await realPathOf(link), { real: dir, missing: false });
  assert.deepEqual(await realPathOf(dir), { real: dir, missing: false });
  assert.deepEqual(await realPathOf(path.join(base, 'gone')), { real: path.join(base, 'gone'), missing: true }, 'ENOENT');
  assert.deepEqual(await realPathOf(path.join(file, 'sub')), { real: path.join(file, 'sub'), missing: true }, 'ENOTDIR');
  fs.symlinkSync(path.join(base, 'gone'), path.join(base, 'dangling'));
  assert.deepEqual(await realPathOf(path.join(base, 'dangling')), { real: path.join(base, 'dangling'), missing: true }, 'a dangling link');
  assert.equal(REALPATH_TIMEOUT_MS > 0, true);
});

test('realPathOf: an answer past the timeout (a hung mount) is the resolved path, not missing; other errors too', async (t) => {
  const { dir } = layout();
  const saved = fs.promises.realpath;
  t.after(() => { fs.promises.realpath = saved; });
  fs.promises.realpath = () => new Promise(() => {}); // never answers
  const t0 = Date.now();
  assert.deepEqual(await realPathOf(dir, { timeout: 50 }), { real: dir, missing: false });
  assert.ok(Date.now() - t0 < 2000, 'bounded by the timeout');
  fs.promises.realpath = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  assert.deepEqual(await realPathOf(dir), { real: dir, missing: false }, 'unknown is not gone');
});

test('isAtOrUnder: the folder itself or a path inside it, never a sibling with the same prefix', () => {
  assert.equal(isAtOrUnder('/w/a', '/w/a'), true);
  assert.equal(isAtOrUnder('/w/a/sub/x', '/w/a'), true);
  assert.equal(isAtOrUnder('/w/ab', '/w/a'), false);
  assert.equal(isAtOrUnder('/w', '/w/a'), false);
  assert.equal(isAtOrUnder('/w/a', '/'), true, 'the root folder');
});
