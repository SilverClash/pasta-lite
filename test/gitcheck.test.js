'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkGit, parseVersion, compareVersions, evaluate, describeGitFailure } = require('../src/gitcheck');

test('parseVersion handles the common git --version formats', () => {
  assert.deepEqual(parseVersion('git version 2.51.2\n'), [2, 51, 2]);
  assert.deepEqual(parseVersion('git version 2.39.3 (Apple Git-145)'), [2, 39, 3]);
  assert.deepEqual(parseVersion('2.39.3 (Apple Git-145)'), [2, 39, 3]);
  assert.deepEqual(parseVersion('git version 2.51.0.windows.1'), [2, 51, 0]);
  assert.deepEqual(parseVersion('git version 2.52.0-rc1'), [2, 52, 0]);
  assert.deepEqual(parseVersion('git version 3.0'), [3, 0, 0]);
  assert.equal(parseVersion('hello'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(undefined), null);
});

test('compareVersions orders numerically, not lexically', () => {
  assert.ok(compareVersions([2, 51, 0], [2, 51, 0]) === 0);
  assert.ok(compareVersions([2, 51, 2], [2, 51, 0]) > 0);
  assert.ok(compareVersions([2, 9, 0], [2, 51, 0]) < 0);
  assert.ok(compareVersions([2, 100, 0], [2, 51, 0]) > 0);
  assert.ok(compareVersions([3, 0, 0], [2, 99, 99]) > 0);
  assert.ok(compareVersions([2, 50, 9], [2, 51, 0]) < 0);
});

test('evaluate requires git >= 2.51 with a clear message', () => {
  assert.deepEqual(evaluate('git version 2.51.0'), { ok: true, version: '2.51.0', error: null });
  assert.deepEqual(evaluate('git version 2.51.0.windows.1'), { ok: true, version: '2.51.0', error: null });
  const old = evaluate('git version 2.39.3 (Apple Git-145)');
  assert.equal(old.ok, false);
  assert.equal(old.version, '2.39.3');
  assert.match(old.error, /needs git 2\.51\.0 or newer.*2\.39\.3/);
  const junk = evaluate('nonsense');
  assert.equal(junk.ok, false);
  assert.match(junk.error, /Could not read the git version/);
});

test('checkGit runs the installed git (this machine has >= 2.51)', async () => {
  const res = await checkGit();
  assert.equal(res.ok, true, res.error);
  assert.match(res.version, /^\d+\.\d+\.\d+$/);
});

test('checkGit reports a missing git binary', async () => {
  const res = await checkGit({ gitPath: '/nonexistent/bin/git' });
  assert.equal(res.ok, false);
  assert.equal(res.version, null);
  assert.match(res.error, /git was not found/);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findGit, loginShellGit } = require('../src/gitcheck');

function fakeGit(dir, name, version) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\necho "git version ${version}"\n`, { mode: 0o755 });
  return p;
}

test('findGit picks the first candidate that is new enough, skipping old and missing ones', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-gc-'));
  const old = fakeGit(d, 'old', '2.50.1 (Apple Git-155)');
  const good = fakeGit(d, 'good', '2.51.2');
  const r = await findGit({ candidates: [path.join(d, 'missing'), old, good] });
  assert.equal(r.ok, true);
  assert.equal(r.path, good);
  assert.equal(r.version, '2.51.2');
  assert.deepEqual(r.tried.map((t) => t.path), [path.join(d, 'missing'), old, good]);
  fs.rmSync(d, { recursive: true, force: true });
});

test('findGit reports the newest too-old git when none qualifies, and "not found" when none exists', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-gc-'));
  const a = fakeGit(d, 'a', '2.39.3');
  const b = fakeGit(d, 'b', '2.50.1');
  const r = await findGit({ candidates: [a, b] });
  assert.equal(r.ok, false);
  assert.equal(r.version, '2.50.1');
  assert.match(r.error, /2\.50\.1 \(.*b\)/);
  const none = await findGit({ candidates: [path.join(d, 'nope')] });
  assert.equal(none.ok, false);
  assert.match(none.error, /not found/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('findGit de-duplicates candidates that resolve to the same binary', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-gc-'));
  const old = fakeGit(d, 'old', '2.40.0');
  fs.symlinkSync(old, path.join(d, 'link'));
  const r = await findGit({ candidates: [old, path.join(d, 'link')] });
  assert.equal(r.tried.length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('loginShellGit takes the last absolute path line (rc banners ignored)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-gc-'));
  const shell = path.join(d, 'sh');
  fs.writeFileSync(shell, '#!/bin/sh\necho "Welcome!"\necho /opt/x/bin/git\n', { mode: 0o755 });
  assert.equal(await loginShellGit({ shell }), '/opt/x/bin/git');
  assert.equal(await loginShellGit({ shell: path.join(d, 'nope') }), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('checkGit never runs a relative or bare git (a planted git.exe in cwd must not win)', async () => {
  const bare = await checkGit({ gitPath: 'git' });
  assert.equal(bare.ok, false);
  assert.match(bare.error, /relative path: git/);
  assert.equal((await checkGit({ gitPath: './git' })).ok, false);
  assert.equal((await checkGit({ gitPath: null })).ok, false);
});

test('pathGit: the git on PATH as an absolute path, skipping empty / "." / relative entries', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-gc-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.mkdirSync(path.join(d, 'bin'));
  const good = fakeGit(path.join(d, 'bin'), 'git', '2.51.2');
  const { pathGit } = require('../src/gitcheck');
  assert.equal(pathGit({ env: { PATH: `:.:rel:${path.join(d, 'bin')}` }, platform: 'linux' }), good);
  assert.equal(pathGit({ env: { PATH: '.' }, platform: 'linux' }), null);
  const r = await findGit({ candidates: [pathGit({ env: { PATH: path.join(d, 'bin') }, platform: 'linux' })] });
  assert.equal(r.ok, true);
  assert.equal(r.path, good);
  const relative = await findGit({ candidates: ['git'] });
  assert.equal(relative.ok, false, 'a bare candidate is refused, not looked up');
});

test('findGit: every default candidate is absolute', async () => {
  const r = await findGit();
  assert.ok(r.tried.length > 0);
  for (const t of r.tried) assert.ok(path.isAbsolute(t.path), t.path);
  assert.equal(r.ok, true, r.error);
});

// ---------------------------------------------------------------- git failure text

test('describeGitFailure lists every binary tried', () => {
  const text = describeGitFailure({
    ok: false,
    error: 'Pasta Lite needs git 2.51.0 or newer, but the newest git found is 2.50.1 (/usr/bin/git).',
    tried: [
      { path: '/opt/homebrew/bin/git', version: null, error: 'git was not found.' },
      { path: '/usr/bin/git', version: '2.50.1', error: 'too old' },
    ],
  });
  assert.match(text, /newest git found is 2\.50\.1/);
  assert.match(text, /\/opt\/homebrew\/bin\/git: not usable \(git was not found\.\)/);
  assert.match(text, /\/usr\/bin\/git: git 2\.50\.1$/m);
  assert.equal(describeGitFailure({ ok: false, error: 'none', tried: [] }), 'none');
  assert.equal(describeGitFailure(null), 'No usable git was found.');
});
