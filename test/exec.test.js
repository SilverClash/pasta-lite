'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const x = require('../src/exec');

test('inherited GIT_DIR / GIT_INDEX_FILE / pathspec vars do not leak into commands', async (t) => {
  const a = h.initRepo();
  const b = h.initRepo();
  h.write(b, 'only-in-b.txt', 'b\n');
  const saved = { ...process.env };
  t.after(() => {
    for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_GLOB_PATHSPECS']) delete process.env[k];
    Object.assign(process.env, saved);
  });
  process.env.GIT_DIR = path.join(a, '.git');
  process.env.GIT_INDEX_FILE = path.join(a, '.git', 'index');
  process.env.GIT_WORK_TREE = a;
  process.env.GIT_GLOB_PATHSPECS = '1';
  const st = await x.out(b, ['status', '--porcelain']);
  assert.match(st, /only-in-b\.txt/);
  await x.run(b, ['add', '--', 'only-in-b.txt']);
  delete process.env.GIT_DIR;
  delete process.env.GIT_INDEX_FILE;
  delete process.env.GIT_WORK_TREE;
  assert.match(h.git(b, 'diff', '--cached', '--name-only'), /only-in-b\.txt/);
  assert.equal(h.git(a, 'diff', '--cached', '--name-only'), '');
});

test('commands run at the worktree root when given a subdirectory', async () => {
  const dir = h.initRepo();
  h.write(dir, 'sub/deep/f.txt', 'x\n');
  const sub = path.join(dir, 'sub', 'deep');
  assert.equal(await x.resolveRoot(sub), dir);
  await x.run(sub, ['add', '--', 'sub/deep/f.txt']); // root-relative path works from a subdir
  assert.match(h.git(dir, 'diff', '--cached', '--name-only'), /sub\/deep\/f\.txt/);
});

test('resolveRoot leaves non-repositories alone and does not cache them', async () => {
  const d = h.tmpDir();
  assert.equal(await x.resolveRoot(d), d);
  h.git(d, 'init', '-q');
  assert.equal(await x.resolveRoot(d), d);
});

test('timeout kills the git process group and tags the error', async () => {
  const dir = h.initRepo();
  const t0 = Date.now();
  await assert.rejects(
    x.run(dir, ['-c', 'alias.slow=!sleep 5', 'slow'], { timeout: 300 }),
    (e) => e instanceof x.GitError && e.kind === 'timeout',
  );
  assert.ok(Date.now() - t0 < 3000);
});

test('AbortSignal cancels a running command', async () => {
  const dir = h.initRepo();
  const ac = new AbortController();
  const p = x.run(dir, ['-c', 'alias.slow=!sleep 5', 'slow'], { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, (e) => e.kind === 'aborted');
});

test('latin1 and buffer encodings round-trip non-UTF-8 bytes', async () => {
  const dir = h.initRepo();
  const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0xff, 0x00, 0x0a]);
  fs.writeFileSync(path.join(dir, 'l1.txt'), bytes);
  const sha = (await x.out(dir, ['hash-object', '-w', '--', 'l1.txt'])).trim();
  const asBuf = await x.out(dir, ['cat-file', 'blob', sha], { encoding: 'buffer' });
  assert.ok(Buffer.isBuffer(asBuf) && asBuf.equals(bytes));
  const asL1 = await x.out(dir, ['cat-file', 'blob', sha], { encoding: 'latin1' });
  assert.ok(Buffer.from(asL1, 'latin1').equals(bytes));
  const sha2 = (await x.out(dir, ['hash-object', '-w', '--stdin'], { input: Buffer.from(asL1, 'latin1') })).trim();
  assert.equal(sha2, sha);
});

test('GitError carries exitCode, kindError/tagError carry kind', async () => {
  const dir = h.initRepo();
  await assert.rejects(x.run(dir, ['rev-parse', '--verify', 'nope']), (e) => e.exitCode === 128 && e.kind === undefined);
  const e = x.kindError('stale', 'msg', { extra: 1 });
  assert.equal(e.kind, 'stale');
  assert.equal(e.extra, 1);
  assert.equal(x.tagError(new Error('m'), 'auth').kind, 'auth');
});

test('tryOut returns null on git failure', async () => {
  const dir = h.initRepo();
  assert.equal(await x.tryOut(dir, ['rev-parse', '-q', '--verify', 'nope']), null);
});

test('headState: attached, detached, unborn', async () => {
  const dir = h.initRepo();
  const sha = h.git(dir, 'rev-parse', 'HEAD').trim();
  assert.deepEqual(await x.headState(dir), { sha, branch: 'main' });
  h.git(dir, 'checkout', '-q', '--detach');
  assert.deepEqual(await x.headState(dir), { sha, branch: null });
  const empty = h.initRepo({ commits: false });
  assert.deepEqual(await x.headState(empty), { sha: null, branch: 'main' });
});

test('repoState detects merge, cherry-pick, bisect and clean', async () => {
  const dir = h.initRepo();
  assert.equal(await x.repoState(dir), 'clean');
  h.git(dir, 'checkout', '-q', '-b', 'side');
  h.commitFile(dir, 'README.md', 'side\n');
  const sideSha = h.git(dir, 'rev-parse', 'HEAD').trim();
  h.git(dir, 'checkout', '-q', 'main');
  h.commitFile(dir, 'README.md', 'main\n');
  assert.throws(() => h.git(dir, 'merge', 'side'));
  assert.equal(await x.repoState(dir), 'merging');
  h.git(dir, 'merge', '--abort');
  assert.throws(() => h.git(dir, 'cherry-pick', sideSha));
  assert.equal(await x.repoState(dir), 'cherry-picking');
  h.git(dir, 'cherry-pick', '--abort');
  h.git(dir, 'bisect', 'start');
  assert.equal(await x.repoState(dir), 'bisecting');
  h.git(dir, 'bisect', 'reset');
  assert.equal(await x.repoState(dir), 'clean');
});

test('hostile user config does not change -c overridden output', async () => {
  const dir = h.initRepo();
  h.hostileConfig(dir);
  h.write(dir, 'README.md', 'changed\n');
  const diff = await x.out(dir, ['diff', ...x.DIFF_OPTS], { diff: true });
  assert.doesNotMatch(diff, /\x1b\[/);
  assert.match(diff, /^--- a\/README\.md$/m);
});

test('parseNulRecords (src/porcelain.js) and nulList', () => {
  const { parseNulRecords } = require('../src/porcelain');
  assert.deepEqual(parseNulRecords('a\0b\0\nc\0d\0', 2), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseNulRecords('', 2), []);
  assert.equal(x.nulList(['a b', 'c']), 'a b\0c\0');
});

test('withSignal: ambient AbortSignal cancels commands spawned inside it (incl. hooks)', async () => {
  const dir = h.initRepo();
  const ac = new AbortController();
  const p = x.withSignal(ac.signal, () => x.run(dir, ['-c', 'alias.slow=!sleep 5', 'slow']));
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, (e) => e.kind === 'aborted');
  // outside the context nothing is attached
  await x.run(dir, ['status']);
});

test('core.fsmonitor from repo config is never executed', async () => {
  const dir = h.initRepo();
  const marker = path.join(h.tmpDir(), 'ran');
  h.git(dir, 'config', 'core.fsmonitor', `touch ${marker}; false`);
  await x.out(dir, ['status', '--porcelain']);
  assert.equal(fs.existsSync(marker), false);
});

test('an ext:: remote never runs, even when repo config allows the protocol or a url.insteadOf rewrites to it', async () => {
  const dir = h.initRepo();
  const marker = path.join(h.tmpDir(), 'ran');
  h.git(dir, 'config', 'protocol.ext.allow', 'always');
  h.git(dir, 'config', 'protocol.allow', 'always');
  h.git(dir, 'remote', 'add', 'evil', `ext::sh -c touch% ${marker}`);
  h.git(dir, 'config', `url.ext::sh -c touch% ${marker}.insteadOf`, 'https://example.invalid/');
  await assert.rejects(x.run(dir, ['fetch', 'evil']), /transport 'ext' not allowed/);
  await assert.rejects(x.run(dir, ['fetch', 'https://example.invalid/r.git']), /transport 'ext' not allowed/);
  assert.equal(fs.existsSync(marker), false);
  // What the override prevents: a plain git there runs the command.
  if (process.platform !== 'win32') {
    assert.throws(() => h.git(dir, 'fetch', 'evil'), 'the command speaks no git protocol');
    assert.equal(fs.existsSync(marker), true, 'the attack is real');
  }
});

test('setGitBinary switches the executable used for every command', async (t) => {
  const dir = h.initRepo();
  const bin = path.join(h.tmpDir(), 'fake-git');
  fs.writeFileSync(bin, '#!/bin/sh\necho fake\n', { mode: 0o755 });
  t.after(() => x.setGitBinary(null));
  await x.resolveRoot(dir); // cache the real root first; the fake binary can't answer rev-parse
  x.setGitBinary(bin);
  assert.equal((await x.out(dir, ['status'])).trim(), 'fake');
  x.setGitBinary(null);
  assert.match(await x.out(dir, ['--version']), /^git version /);
  assert.throws(() => x.setGitBinary('git'), /absolute/, 'a bare name is refused');
  assert.throws(() => x.setGitBinary('./bin/git'), /absolute/);
});

test('the default git comes from PATH as an absolute path: a git planted in the repo never runs', async (t) => {
  const dir = h.initRepo();
  await x.resolveRoot(dir);
  const marker = path.join(h.tmpDir(), 'planted-ran');
  for (const name of ['git', 'git.exe']) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; x.setGitBinary(null); });
  // Empty and '.' entries mean cwd (the repo) to a plain exec lookup; they are skipped.
  process.env.PATH = `.::${savedPath}`;
  x.setGitBinary(null);
  assert.match(await x.out(dir, ['--version']), /^git version /);
  assert.equal(fs.existsSync(marker), false);
  // No git on PATH at all: ENOENT, never a bare-name spawn.
  process.env.PATH = '.';
  x.setGitBinary(null);
  await assert.rejects(x.run(dir, ['status']), (e) => e.code === 'ENOENT' && /not found on PATH/.test(e.message));
  assert.equal(fs.existsSync(marker), false);
});

test('resolveRoot: a subdirectory that becomes its own repo resolves to itself', async () => {
  const outer = h.initRepo();
  const sub = path.join(outer, 'sub');
  fs.mkdirSync(sub);
  assert.equal(await x.resolveRoot(sub), outer);
  assert.equal(await x.resolveRoot(outer), outer);
  h.git(sub, 'init', '-q');
  assert.equal(await x.resolveRoot(sub), sub);
  assert.equal(await x.resolveRoot(outer), outer);
});

test('resolveRoot keeps a bare repo and a .git folder as they are', async () => {
  const bare = h.initRepo({ bare: true });
  assert.equal(await x.resolveRoot(bare), bare);
  const dir = h.initRepo();
  assert.equal(await x.resolveRoot(path.join(dir, '.git')), path.join(dir, '.git'));
});

test('maxBytes: output beyond the cap kills git and rejects with kind too-large', async () => {
  const dir = h.initRepo();
  h.write(dir, 'big.txt', 'x'.repeat(200000));
  const sha = (await x.out(dir, ['hash-object', '-w', '--', 'big.txt'])).trim();
  await assert.rejects(
    x.run(dir, ['cat-file', 'blob', sha], { maxBytes: 1000 }),
    (e) => e instanceof x.GitError && e.kind === 'too-large' && /exceeded 1000 bytes/.test(e.message),
  );
  // tryOut does not turn it into "git failed" (null).
  await assert.rejects(x.tryOut(dir, ['cat-file', 'blob', sha], { maxBytes: 1000 }), { kind: 'too-large' });
  assert.equal((await x.out(dir, ['cat-file', 'blob', sha])).length, 200000);
  assert.equal(x.MAX_OUTPUT_BYTES, 256 * 1024 * 1024);
});

test('a failure while building the result rejects instead of hanging', async () => {
  const dir = h.initRepo();
  // An unknown encoding makes toString throw inside the close handler (as ERR_STRING_TOO_LONG would).
  await assert.rejects(x.run(dir, ['status'], { encoding: 'no-such-encoding' }), /encoding/i);
});

test('an already aborted signal rejects without spawning git', async (t) => {
  const dir = h.initRepo();
  await x.resolveRoot(dir);
  const bin = path.join(h.tmpDir(), 'marker-git');
  const marker = path.join(h.tmpDir(), 'ran');
  fs.writeFileSync(bin, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  t.after(() => x.setGitBinary(null));
  x.setGitBinary(bin);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(x.run(dir, ['status'], { signal: ac.signal }), (e) => e instanceof x.GitError && e.kind === 'aborted');
  assert.equal(fs.existsSync(marker), false);
});

/** Minimal AbortSignal stand-in that counts its listeners. */
function countingSignal() {
  const s = { aborted: false, listeners: 0 };
  s.addEventListener = () => { s.listeners++; };
  s.removeEventListener = () => { s.listeners--; };
  return s;
}

test('spawn errors: a missing git binary rejects with ENOENT and releases the abort listener', async (t) => {
  const dir = h.initRepo();
  await x.resolveRoot(dir);
  t.after(() => x.setGitBinary(null));
  x.setGitBinary(path.join(h.tmpDir(), 'no-such-git'));
  const signal = countingSignal();
  await assert.rejects(x.run(dir, ['status'], { signal }), (e) => !(e instanceof x.GitError) && e.code === 'ENOENT');
  assert.equal(signal.listeners, 0);
  // tryOut propagates it (git missing is not "git said no").
  await assert.rejects(x.tryOut(dir, ['status']), { code: 'ENOENT' });
});

test('spawn errors: a missing working folder rejects with ENOENT', async () => {
  const gone = path.join(h.tmpDir(), 'gone');
  const signal = countingSignal();
  await assert.rejects(x.run(gone, ['status'], { signal }), (e) => !(e instanceof x.GitError) && e.code === 'ENOENT');
  assert.equal(signal.listeners, 0);
  await assert.rejects(x.headState(gone), { code: 'ENOENT' });
});

test('GIT_TRACE from the environment does not reach git (it would pollute stderr)', async (t) => {
  const dir = h.initRepo();
  t.after(() => { delete process.env.GIT_TRACE; delete process.env.GIT_TRACE_PERFORMANCE; });
  process.env.GIT_TRACE = '1';
  process.env.GIT_TRACE_PERFORMANCE = '2';
  const { stderr } = await x.run(dir, ['status', '--porcelain']);
  assert.equal(stderr, '');
});

test('killChildren: only cancelled commands by default (SIGKILL for one that ignored SIGTERM); all: every one', async () => {
  const dir = h.initRepo();
  const tag = `pl-kill-${process.pid}-${Date.now()}`;
  const alive = () => require('node:child_process').spawnSync('pgrep', ['-f', tag]).status === 0;
  const waitFor = async (want) => {
    const t0 = Date.now();
    while (alive() !== want) {
      assert.ok(Date.now() - t0 < 5000, `sleep never became ${want ? 'alive' : 'gone'}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  // A cancelled command whose process group ignores SIGTERM stays alive until killChildren().
  // The marker is written after `trap`, so the abort can't land before SIGTERM is ignored (the
  // shell is visible to pgrep before it has run the trap, which raced under a loaded machine).
  const marker = path.join(dir, '.git', `${tag}.trapped`);
  const ac = new AbortController();
  const stubborn = x.run(dir, ['-c', `alias.slow=!trap '' TERM; : > '${marker}'; sleep 30; : ${tag}`, 'slow'], { signal: ac.signal });
  await waitFor(true);
  for (const t0 = Date.now(); !fs.existsSync(marker); await new Promise((r) => setTimeout(r, 20))) {
    assert.ok(Date.now() - t0 < 5000, 'the trap was never installed');
  }
  ac.abort();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(), true, 'SIGTERM is ignored');
  assert.equal(x.killChildren(), 1);
  await assert.rejects(stubborn, (e) => e.kind === 'aborted');
  await waitFor(false);
  // A command with no signal (an uncancellable phase) is left alone unless `all`.
  const plain = x.run(dir, ['-c', `alias.slow=!sleep 30; : ${tag}`, 'slow']);
  await waitFor(true);
  assert.equal(x.killChildren(), 0);
  assert.equal(alive(), true);
  assert.equal(x.killChildren({ all: true, signal: 'SIGTERM' }), 1);
  await assert.rejects(plain, (e) => e.kind === 'aborted');
  await waitFor(false);
  assert.equal(x.killChildren({ all: true }), 0); // nothing left
});
