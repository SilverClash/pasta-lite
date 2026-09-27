'use strict';
// Our persistent autostash and the review fixes around it: the dirty-tree guard of every
// re-apply (restoreAutostash, a merge or rebase ending, withAutostash), the per-worktree ref
// with linked worktrees and the move from the old shared ref, an orphan stash left by a crash,
// a failed abort, signing stops, core.commentChar=auto / commentString, sha256 repos, what a
// finished rebase reports after a stop (dropped, skippedCherryPicks, published) and the
// batched published check of rebasePlan.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const h = require('./helpers');
const g = require('../src/git');
const ops = require('../src/ops');
const rebase = require('../src/rebase');
const autostash = require('../src/autostash');

after(h.cleanup);

const ALICE = 'Alice <alice@example.com>';
const head = (dir) => h.git(dir, 'rev-parse', 'HEAD').trim();
const rev = (dir, r) => h.git(dir, 'rev-parse', r).trim();
const subjects = (dir, range) => h.git(dir, 'log', '--format=%s', range).trim().split('\n').filter(Boolean);
const stashList = (dir) => h.git(dir, 'stash', 'list', '--format=%H').trim().split('\n').filter(Boolean);
const refOf = (dir, ref) => {
  try {
    return h.git(dir, 'rev-parse', '-q', '--verify', ref).trim();
  } catch {
    return null;
  }
};
const autostashRef = (dir) => refOf(dir, autostash.AUTOSTASH_REF);
const legacyRef = (dir) => refOf(dir, autostash.LEGACY_AUTOSTASH_REF);
const gitDirOf = (dir) => h.git(dir, 'rev-parse', '--absolute-git-dir').trim();
const split = async (dir) => {
  const st = await g.status(dir);
  return { staged: st.staged, unstaged: st.unstaged };
};

/** git as a terminal user would run it (who accepts every editor: GIT_EDITOR=true). */
function term(dir, args, env = {}) {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_EDITOR: 'true', ...env },
  });
}

function commitAs(dir, file, content, message) {
  h.write(dir, file, content);
  h.git(dir, 'add', '--', file);
  h.git(dir, 'commit', '-q', `--author=${ALICE}`, '-m', message);
  return head(dir);
}

/** A new repo like helpers.initRepo, with `--object-format=sha256` when `sha256`. */
function repo({ sha256 = false } = {}) {
  if (!sha256) return h.initRepo();
  const dir = h.tmpDir();
  h.git(dir, 'init', '-q', '-b', 'main', '--object-format=sha256');
  h.git(dir, 'config', 'commit.gpgSign', 'false');
  h.commitFile(dir, 'README.md', 'hello\n', 'initial');
  return dir;
}

/** feat: one (a.txt), two (README: conflicts with main), three (c.txt); main: "main edit". feat checked out. */
function conflicting(opts) {
  const dir = repo(opts);
  h.hostileConfig(dir);
  h.git(dir, 'checkout', '-q', '-b', 'feat');
  const c1 = commitAs(dir, 'a.txt', 'a\n', 'one');
  const c2 = commitAs(dir, 'README.md', 'feat side\n', 'two');
  const c3 = commitAs(dir, 'c.txt', 'c\n', 'three');
  h.git(dir, 'checkout', '-q', 'main');
  const main = h.commitFile(dir, 'README.md', 'main side\n', 'main edit');
  h.git(dir, 'checkout', '-q', 'feat');
  return { dir, main, c1, c2, c3 };
}

/** Staged, staged + unstaged, unstaged and untracked changes (none touching README / a / c). */
function dirty(dir) {
  h.write(dir, 'staged.txt', 'st\n');
  h.write(dir, 'both.txt', 'v1\n');
  h.git(dir, 'add', 'staged.txt', 'both.txt');
  h.write(dir, 'both.txt', 'v2\n');
  h.write(dir, 'u.txt', 'untracked\n');
}
const DIRTY_SPLIT = {
  staged: [{ path: 'both.txt', status: 'A' }, { path: 'staged.txt', status: 'A' }],
  unstaged: [{ path: 'both.txt', status: 'M' }, { path: 'u.txt', status: '?' }],
};

/** Our rebase of feat onto main, stopped at "two" with the dirty changes in the autostash. */
async function stoppedWithAutostash(opts) {
  const s = conflicting(opts);
  dirty(s.dir);
  const res = await ops.OPS.rebase(s.dir, 'main');
  assert.equal(res.status, 'stopped');
  assert.equal(res.state.stop, 'conflict');
  const stash = autostashRef(s.dir);
  assert.ok(stash);
  return { ...s, stash };
}

describe('the dirty-tree guard (a re-apply never resets work made meanwhile)', () => {
  test('a terminal abort, then new work: restoreAutostash is refused dirty; the direct call keeps the stash and the ref', async () => {
    const { dir, stash } = await stoppedWithAutostash();
    term(dir, ['rebase', '--abort']);
    assert.equal((await g.status(dir)).pendingAutostash, stash);
    h.write(dir, 'a.txt', 'IMPORTANT NEW WORK\n'); // tracked, unstaged
    h.write(dir, 'new.txt', 'untracked is fine\n');
    const runner = ops.createRunner();
    await assert.rejects(runner.run(dir, 'restoreAutostash', []), (e) => e.kind === 'dirty' && e.count === 1 && e.paths[0] === 'a.txt');
    await ops.OPS.restoreAutostash.check(dir, { keep: true }); // {keep} doesn't touch the tree: allowed
    const res = await autostash.restoreAutostash(dir);
    assert.deepEqual(res, { restored: false, stash: { kept: true, sha: stash, reason: 'dirty' } });
    assert.equal(h.read(dir, 'a.txt'), 'IMPORTANT NEW WORK\n');
    assert.equal(h.read(dir, 'new.txt'), 'untracked is fine\n');
    assert.equal(autostashRef(dir), stash, 'Restore can be tried again');
    assert.deepEqual(stashList(dir), [stash]);

    h.git(dir, 'add', 'a.txt'); // staged changes count too
    await assert.rejects(runner.run(dir, 'restoreAutostash', []), (e) => e.kind === 'dirty' && e.paths[0] === 'a.txt');
    h.git(dir, 'commit', '-q', '-m', 'new work');
    fs.rmSync(path.join(dir, 'new.txt'));
    assert.deepEqual(await runner.run(dir, 'restoreAutostash', []), { restored: true, indexRestored: true });
    assert.deepEqual(await split(dir), DIRTY_SPLIT);
    assert.equal(autostashRef(dir), null);
    assert.deepEqual(stashList(dir), []);
  });

  test('the tree changes between the check and the re-apply: nothing applied, nothing reset', async () => {
    const { dir, stash } = await stoppedWithAutostash();
    term(dir, ['rebase', '--abort']);
    const args = await ops.OPS.restoreAutostash.check(dir, {});
    h.write(dir, 'README.md', 'typed just now\n');
    const res = await ops.OPS.restoreAutostash.act(dir, ...args);
    assert.deepEqual(res, { restored: false, stash: { kept: true, sha: stash, reason: 'dirty' } });
    assert.equal(h.read(dir, 'README.md'), 'typed just now\n');
    assert.equal(autostashRef(dir), stash);
  });

  test('a merge with autostash stops; a dirty README refuses Commit and Merge; the race keeps the work', async () => {
    const dir = repo();
    h.hostileConfig(dir);
    h.git(dir, 'branch', 'feat');
    h.commitFile(dir, 'b.txt', 'main\n', 'b main');
    h.git(dir, 'checkout', '-q', 'feat');
    h.commitFile(dir, 'b.txt', 'feat\n', 'b feat');
    h.git(dir, 'checkout', '-q', 'main');
    dirty(dir);
    const res = await ops.OPS.merge(dir, 'feat');
    assert.equal(res.stop, 'conflict');
    h.write(dir, 'b.txt', 'resolved\n');
    h.git(dir, 'add', 'b.txt');
    h.write(dir, 'README.md', 'unstaged work during the merge\n');
    const runner = ops.createRunner();
    await assert.rejects(runner.run(dir, 'mergeCommit', []), (e) => e.kind === 'dirty' && e.paths[0] === 'README.md' && e.count === 1);
    assert.equal((await g.status(dir)).state, 'merging');

    // The same change made after the check: the merge is committed, the stash waits (reason dirty).
    h.git(dir, 'checkout', '-q', '--', 'README.md');
    const args = await ops.OPS.mergeCommit.check(dir, {});
    h.write(dir, 'README.md', 'unstaged work during the merge\n');
    const done = await ops.OPS.mergeCommit.act(dir, ...args);
    assert.equal(done.status, 'done');
    assert.deepEqual(done.stash, { kept: true, sha: res.stash.sha, reason: 'dirty' });
    assert.equal(h.read(dir, 'README.md'), 'unstaged work during the merge\n');
    const st = await g.status(dir);
    assert.equal(st.pendingAutostash, res.stash.sha);
    h.git(dir, 'checkout', '-q', '--', 'README.md');
    assert.deepEqual(await runner.run(dir, 'restoreAutostash', []), { restored: true, indexRestored: true });
    assert.deepEqual(await split(dir), DIRTY_SPLIT);
  });

  test('without an autostash, Commit and Merge allows unstaged changes (git keeps them)', async () => {
    const dir = repo();
    h.git(dir, 'branch', 'feat');
    h.commitFile(dir, 'b.txt', 'main\n', 'b main');
    h.git(dir, 'checkout', '-q', 'feat');
    h.commitFile(dir, 'b.txt', 'feat\n', 'b feat');
    h.git(dir, 'checkout', '-q', 'main');
    assert.throws(() => term(dir, ['merge', 'feat']));
    h.write(dir, 'b.txt', 'resolved\n');
    h.git(dir, 'add', 'b.txt');
    h.write(dir, 'README.md', 'mine\n');
    const done = await ops.createRunner().run(dir, 'mergeCommit', []);
    assert.equal(done.status, 'done');
    assert.equal(h.read(dir, 'README.md'), 'mine\n');
  });

  test('withAutostash: a tree changed again before the re-apply keeps the stash (stash-conflict, reason dirty)', async () => {
    const dir = repo();
    h.commitFile(dir, 'f.txt', 'main\n', 'f');
    h.git(dir, 'branch', 'other');
    h.commitFile(dir, 'f.txt', 'main 2\n', 'f again');
    h.write(dir, 'f.txt', 'local\n'); // blocks the checkout: withAutostash runs
    // A post-checkout hook that edits a tracked file (a formatter, a generator).
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\necho hook >> README.md\n', { mode: 0o755 });
    await assert.rejects(g.checkout(dir, 'other'), (e) => {
      assert.equal(e.kind, 'stash-conflict');
      assert.equal(e.reason, 'dirty');
      assert.equal(e.stashKept, true);
      assert.deepEqual(stashList(dir), [e.stash]);
      return true;
    });
    assert.equal(h.read(dir, 'README.md'), 'hello\nhook\n');
    assert.equal(h.read(dir, 'f.txt'), 'main\n');
  });
});

describe('linked worktrees: the autostash is per worktree', () => {
  test('a rebase stopped in B leaves the main worktree alone; B finishes with its changes', async () => {
    const { dir } = conflicting();
    h.git(dir, 'checkout', '-q', 'main');
    h.git(dir, 'branch', 'side', 'main~1');
    h.git(dir, 'checkout', '-q', 'side');
    const side = h.commitFile(dir, 's.txt', 's\n', 'side');
    h.git(dir, 'checkout', '-q', 'main');
    const wt = h.tmpDir('pl-wt-');
    h.git(dir, 'worktree', 'add', '-q', wt, 'feat');
    dirty(wt);
    const res = await ops.OPS.rebase(wt, 'main');
    assert.equal(res.status, 'stopped');
    const stash = autostashRef(wt);
    assert.ok(stash);
    assert.equal(res.state.autostash, stash);
    assert.equal(autostashRef(dir), null);
    assert.equal(legacyRef(dir), null);

    const stMain = await g.status(dir);
    assert.equal(stMain.state, 'clean');
    assert.equal(stMain.pendingAutostash, null);
    await assert.rejects(ops.createRunner().run(dir, 'restoreAutostash', []), { kind: 'nothing' });
    const other = await ops.OPS.rebase(dir, 'side'); // not refused: B's autostash isn't this worktree's
    assert.equal(other.status, 'done');
    assert.equal(rev(dir, 'main~1'), side);

    h.write(wt, 'README.md', 'resolved\n');
    h.git(wt, 'add', 'README.md');
    const done = await ops.createRunner().run(wt, 'rebaseContinue', []);
    assert.equal(done.status, 'done');
    assert.equal(done.stash, undefined);
    assert.deepEqual(await split(wt), DIRTY_SPLIT);
    assert.equal(autostashRef(wt), null);
    assert.deepEqual(stashList(dir), []);
    assert.deepEqual((await split(dir)), { staged: [], unstaged: [] });
  });

  test('an interactive rebase with autostash inside a linked worktree (the helper in its own git dir)', async () => {
    const dir = repo();
    h.hostileConfig(dir);
    const base = head(dir);
    h.git(dir, 'checkout', '-q', '-b', 'feat');
    const c1 = commitAs(dir, 'a.txt', 'a\n', 'one');
    const c2 = commitAs(dir, 'b.txt', 'b\n', 'two');
    const c3 = commitAs(dir, 'c.txt', 'c\n', 'three');
    h.git(dir, 'checkout', '-q', 'main');
    const wt = h.tmpDir('pl-wt-');
    h.git(dir, 'worktree', 'add', '-q', wt, 'feat');
    dirty(wt);
    const todo = [{ action: 'reword', sha: c1 }, { action: 'pick', sha: c2 }, { action: 'squash', sha: c3 }];
    const res = await ops.OPS.rebaseInteractive(wt, { upstream: base }, todo, { messages: { [c1]: 'one, reworded', [c3]: 'two and three' } });
    assert.equal(res.status, 'done');
    assert.deepEqual(subjects(wt, `${base}..HEAD`), ['two and three', 'one, reworded']);
    assert.deepEqual(await split(wt), DIRTY_SPLIT);
    assert.equal(fs.existsSync(path.join(gitDirOf(wt), 'pasta-lite', 'rebase')), false);
    assert.equal(fs.existsSync(path.join(dir, '.git', 'pasta-lite', 'rebase')), false);
    assert.equal(autostashRef(wt), null);
  });
});

describe('the ref of older versions and an orphan stash', () => {
  test('a legacy ref in a single-worktree repo is pending here; restore moves and clears it', async () => {
    const { dir, stash } = await stoppedWithAutostash();
    term(dir, ['rebase', '--abort']);
    h.git(dir, 'update-ref', autostash.LEGACY_AUTOSTASH_REF, stash);
    h.git(dir, 'update-ref', '-d', autostash.AUTOSTASH_REF);
    assert.equal((await g.status(dir)).pendingAutostash, stash);
    assert.equal(legacyRef(dir), stash, 'status only reads');
    await assert.rejects(ops.OPS.rebase(dir, 'main'), (e) => e.kind === 'in-progress' && e.state === 'autostash' && e.stash === stash);
    assert.equal(legacyRef(dir), stash, 'refused in check: nothing written');
    await assert.rejects(rebase.start(dir, { onto: rev(dir, 'main') }), (e) => e.kind === 'in-progress' && e.stash === stash);
    assert.equal(legacyRef(dir), null, 'moved by the write op');
    assert.equal(autostashRef(dir), stash);
    assert.deepEqual(await ops.createRunner().run(dir, 'restoreAutostash', []), { restored: true, indexRestored: true });
    assert.deepEqual(await split(dir), DIRTY_SPLIT);
    assert.equal(autostashRef(dir), null);
  });

  test('a rebase stopped by an older version (legacy ref) finishes with its autostash', async () => {
    const { dir, stash } = await stoppedWithAutostash();
    h.git(dir, 'update-ref', autostash.LEGACY_AUTOSTASH_REF, stash);
    h.git(dir, 'update-ref', '-d', autostash.AUTOSTASH_REF);
    assert.equal((await g.status(dir)).rebase.autostash, stash);
    const res = await ops.createRunner().run(dir, 'rebaseAbort', []);
    assert.equal(res.status, 'aborted');
    assert.deepEqual(await split(dir), DIRTY_SPLIT);
    assert.equal(legacyRef(dir), null);
    assert.equal(autostashRef(dir), null);
  });

  test('with linked worktrees a legacy ref belongs to nobody: left alone, nothing refused', async () => {
    const { dir, stash } = await stoppedWithAutostash();
    term(dir, ['rebase', '--abort']);
    h.git(dir, 'update-ref', autostash.LEGACY_AUTOSTASH_REF, stash);
    h.git(dir, 'update-ref', '-d', autostash.AUTOSTASH_REF);
    const wt = h.tmpDir('pl-wt-');
    h.git(dir, 'worktree', 'add', '-q', '--detach', wt, 'main~1');
    for (const d of [dir, wt]) assert.equal((await g.status(d)).pendingAutostash, null);
    assert.equal((await ops.OPS.rebase(wt, 'feat')).status, 'done'); // a fast-forward
    assert.equal(head(wt), rev(dir, 'feat'));
    assert.equal(legacyRef(dir), stash);
    assert.deepEqual(stashList(dir), [stash]);
  });

  test('a crash between `stash push` and recording the stash: the orphan is found, refused on, restored', async () => {
    const { dir } = conflicting();
    h.write(dir, 'a.txt', 'older stash\n');
    h.git(dir, 'stash', 'push', '-q', '-m', 'mine');
    const mine = rev(dir, 'refs/stash');
    dirty(dir);
    // What pushAutostash leaves when the app dies right after `git stash push`.
    const pl = path.join(gitDirOf(dir), 'pasta-lite');
    fs.mkdirSync(pl, { recursive: true });
    fs.writeFileSync(path.join(pl, 'autostash-intent'), JSON.stringify({ id: '0123456789ab', time: Date.now() }));
    h.git(dir, 'stash', 'push', '-q', '--include-untracked', '-m', 'pasta-lite autostash before rebase of feat [0123456789ab]');
    const orphan = rev(dir, 'refs/stash');

    const st = await g.status(dir);
    assert.equal(st.pendingAutostash, orphan);
    assert.equal(autostashRef(dir), null, 'status only reads');
    await assert.rejects(ops.OPS.rebase(dir, 'main'), (e) => e.kind === 'in-progress' && e.stash === orphan);
    await assert.rejects(rebase.start(dir, { onto: rev(dir, 'main') }), (e) => e.kind === 'in-progress' && e.stash === orphan);
    assert.equal(autostashRef(dir), orphan, 'recorded by the write op');
    assert.equal(fs.existsSync(path.join(pl, 'autostash-intent')), false);
    assert.deepEqual(await ops.createRunner().run(dir, 'restoreAutostash', []), { restored: true, indexRestored: true });
    assert.deepEqual(await split(dir), DIRTY_SPLIT);
    assert.deepEqual(stashList(dir), [mine]);
  });

  test('an intent file with no orphan (the crash came before the push) is ignored, then removed', async () => {
    const { dir } = conflicting();
    const pl = path.join(gitDirOf(dir), 'pasta-lite');
    fs.mkdirSync(pl, { recursive: true });
    fs.writeFileSync(path.join(pl, 'autostash-intent'), JSON.stringify({ id: '0123456789ab', time: Date.now() }));
    h.write(dir, 'x.txt', 'x\n');
    h.git(dir, 'stash', 'push', '-q', '-u', '-m', 'mine, not ours');
    assert.equal((await g.status(dir)).pendingAutostash, null);
    assert.equal((await ops.OPS.rebase(dir, 'main')).status, 'stopped');
    assert.equal(fs.existsSync(path.join(pl, 'autostash-intent')), false);
  });
});

describe('abort, ours, signing', () => {
  test('an abort git fails keeps the rebase, the state folder and the autostash; a later abort restores', async () => {
    const { dir, stash, c3 } = await stoppedWithAutostash();
    const lock = path.join(dir, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    const runner = ops.createRunner();
    await assert.rejects(runner.run(dir, 'rebaseAbort', []), (e) => e.rebase && e.rebase.stop === 'conflict');
    assert.equal((await g.status(dir)).state, 'rebasing');
    assert.equal(autostashRef(dir), stash);
    assert.ok(fs.existsSync(path.join(dir, '.git', 'pasta-lite', 'rebase', 'meta.json')));
    fs.rmSync(lock);
    const res = await runner.run(dir, 'rebaseAbort', []);
    assert.equal(res.status, 'aborted');
    assert.equal(head(dir), c3);
    assert.deepEqual(await split(dir), DIRTY_SPLIT);
  });

  test("a stale meta.json never makes a terminal's rebase of the same commit ours", async () => {
    const { dir } = conflicting();
    const res = await ops.OPS.rebase(dir, 'main');
    assert.equal(res.state.ours, true);
    term(dir, ['rebase', '--abort']); // meta.json stays behind
    assert.ok(fs.existsSync(path.join(dir, '.git', 'pasta-lite', 'rebase', 'meta.json')));
    assert.throws(() => term(dir, ['-c', 'rebase.backend=merge', 'rebase', 'main']));
    const r = (await g.status(dir)).rebase;
    assert.equal(r.ours, false);
    assert.equal(r.ontoName, null);
    assert.equal(r.todoEditable, false);
  });

  /** A signing program that fails until `<flag>` exists (gpg: SIG_CREATED on the status fd; ssh: <file>.sig). */
  function signer(dir, format) {
    const flag = path.join(h.tmpDir(), 'signing-works');
    const prog = path.join(h.tmpDir(), 'sign.sh');
    const ok = format === 'ssh'
      ? 'for a; do last=$a; done\nprintf -- "-----BEGIN SSH SIGNATURE-----\\nZmFrZQ==\\n-----END SSH SIGNATURE-----\\n" > "$last.sig"\n'
      : 'cat >/dev/null\necho >&2\necho "[GNUPG:] SIG_CREATED D 1 8 00 1 X" >&2\nprintf -- "-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n"\n';
    fs.writeFileSync(prog, `#!/bin/sh\n[ -f '${flag}' ] || { echo "signing failed: no key" >&2; exit 1; }\n${ok}`, { mode: 0o755 });
    if (format === 'ssh') {
      const key = path.join(h.tmpDir(), 'key.pub');
      fs.writeFileSync(key, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFake test\n');
      h.git(dir, 'config', 'gpg.format', 'ssh');
      h.git(dir, 'config', 'gpg.ssh.program', prog);
      h.git(dir, 'config', 'user.signingKey', key);
    } else {
      h.git(dir, 'config', 'gpg.program', prog);
    }
    h.git(dir, 'config', 'commit.gpgSign', 'true');
    return { fix: () => fs.writeFileSync(flag, '') };
  }

  for (const format of ['openpgp', 'ssh']) {
    test(`a reword stopped by a signing failure (${format}) keeps its new message when continued`, async () => {
      const dir = repo();
      const base = head(dir);
      const c1 = h.commitFile(dir, 'b.txt', 'b\n', 'old subject');
      const c2 = h.commitFile(dir, 'c.txt', 'c\n', 'second');
      const sign = signer(dir, format);
      const todo = [{ action: 'reword', sha: c1 }, { action: 'pick', sha: c2 }];
      const res = await ops.OPS.rebaseInteractive(dir, { upstream: base }, todo, { messages: { [c1]: 'NEW SUBJECT' } });
      assert.equal(res.status, 'stopped');
      assert.equal(res.state.stop, 'other');
      assert.equal(res.state.signingFailed, true);
      assert.equal(res.hookOutput, undefined);
      // Still failing: stopped again, the message still waiting.
      const again = await ops.createRunner().run(dir, 'rebaseContinue', []);
      assert.equal(again.status, 'stopped');
      assert.equal(again.state.signingFailed, true);
      sign.fix();
      const done = await ops.createRunner().run(dir, 'rebaseContinue', []);
      assert.equal(done.status, 'done');
      assert.deepEqual(subjects(dir, `${base}..HEAD`), ['second', 'NEW SUBJECT']);
      assert.match(h.git(dir, 'cat-file', 'commit', 'HEAD~1'), /^gpgsig /m);
    });
  }

  test('a squash stopped by a signing failure gets its message when continued', async () => {
    const dir = repo();
    const base = head(dir);
    const c1 = h.commitFile(dir, 'b.txt', 'b\n', 'one');
    const c2 = h.commitFile(dir, 'c.txt', 'c\n', 'two');
    const sign = signer(dir, 'openpgp');
    const res = await ops.OPS.rebaseInteractive(dir, { upstream: base }, [{ action: 'pick', sha: c1 }, { action: 'squash', sha: c2 }], { messages: { [c2]: 'SQUASHED' } });
    assert.equal(res.status, 'stopped');
    assert.equal(res.state.signingFailed, true);
    sign.fix();
    const done = await ops.createRunner().run(dir, 'rebaseContinue', []);
    assert.equal(done.status, 'done');
    // git (2.51, a terminal too) commits the squash as a commit of its own after such a stop.
    assert.equal(subjects(dir, `${base}..HEAD`)[0], 'SQUASHED');
  });

  test("a merge left in progress by a signing failure (no hook ran): stop 'other', no hookOutput", async () => {
    const dir = repo();
    h.git(dir, 'branch', 'feat');
    h.commitFile(dir, 'm.txt', 'm\n', 'main');
    h.git(dir, 'checkout', '-q', 'feat');
    h.commitFile(dir, 'f.txt', 'f\n', 'feat');
    h.git(dir, 'checkout', '-q', 'main');
    const sign = signer(dir, 'openpgp');
    const res = await ops.OPS.merge(dir, 'feat', { ff: 'no-ff' });
    if (res.status === 'stopped') {
      assert.equal(res.stop, 'other');
      assert.equal(res.hookOutput, undefined);
      sign.fix();
      assert.equal((await ops.OPS.mergeCommit(dir, {})).status, 'done');
    } else {
      // git refused before leaving MERGE_HEAD: a plain error, nothing in progress.
      assert.fail(`unexpected ${res.status}`);
    }
  });
});

describe('core.commentChar=auto and core.commentString', () => {
  test("auto: an external rebase's and merge's comment lines (written with #) never reach the commit", async () => {
    const dir = repo();
    h.git(dir, 'config', 'core.commentChar', 'auto');
    h.git(dir, 'checkout', '-q', '-b', 'feat');
    const c1 = commitAs(dir, 'README.md', 'feat\n', 'feat change');
    h.git(dir, 'checkout', '-q', 'main');
    h.commitFile(dir, 'README.md', 'main\n', 'main change');
    h.git(dir, 'checkout', '-q', 'feat');
    assert.throws(() => term(dir, ['-c', 'rebase.backend=merge', 'rebase', 'main']));
    const r = (await g.status(dir)).rebase;
    assert.equal(r.ours, false);
    assert.equal(r.stopMessage, 'feat change');
    assert.equal(r.current.sha, c1);
    h.write(dir, 'README.md', 'resolved\n');
    h.git(dir, 'add', 'README.md');
    const res = await ops.createRunner().run(dir, 'rebaseContinue', [{ message: 'feat change, resolved\n\n# a note\n' }]);
    assert.equal(res.status, 'done');
    assert.equal(h.git(dir, 'log', '-1', '--format=%B'), 'feat change, resolved\n\n');

    h.git(dir, 'checkout', '-q', 'main');
    h.commitFile(dir, 'README.md', 'main again\n', 'main again');
    assert.throws(() => term(dir, ['merge', 'feat']));
    assert.equal((await g.status(dir)).merge.message, "Merge branch 'feat'");
    h.write(dir, 'README.md', 'both\n');
    h.git(dir, 'add', 'README.md');
    await ops.createRunner().run(dir, 'mergeCommit', []);
    assert.equal(h.git(dir, 'log', '-1', '--format=%B'), "Merge branch 'feat'\n\n");
  });

  test('commentString of more than one character strips the stop message', async () => {
    const dir = repo();
    h.git(dir, 'config', 'core.commentString', '//');
    h.git(dir, 'checkout', '-q', '-b', 'feat');
    commitAs(dir, 'README.md', 'feat\n', 'feat change');
    h.git(dir, 'checkout', '-q', 'main');
    h.commitFile(dir, 'README.md', 'main\n', 'main change');
    assert.throws(() => term(dir, ['merge', 'feat']));
    assert.match(h.read(dir, '.git/MERGE_MSG'), /^\/\/ Conflicts:/m);
    assert.equal((await g.status(dir)).merge.message, "Merge branch 'feat'");
  });
});

describe('sha256 repositories', () => {
  test('rebase with a conflict stop and continue; conflicted entries carry xy', async () => {
    const { dir, c2 } = await stoppedWithAutostash({ sha256: true });
    assert.equal(c2.length, 64);
    const st = await g.status(dir);
    assert.deepEqual(st.conflicted, [{ path: 'README.md', status: 'U', xy: 'UU' }]);
    assert.equal(st.rebase.stoppedSha, c2);
    h.write(dir, 'README.md', 'resolved\n');
    h.git(dir, 'add', 'README.md');
    const res = await ops.createRunner().run(dir, 'rebaseContinue', [{ message: 'two, resolved' }]);
    assert.equal(res.status, 'done');
    assert.deepEqual(subjects(dir, 'main..feat'), ['three', 'two, resolved', 'one']);
    assert.deepEqual(await split(dir), DIRTY_SPLIT);
  });

  test('interactive: reword, squash, drop', async () => {
    const dir = repo({ sha256: true });
    h.hostileConfig(dir);
    const base = head(dir);
    const c = ['a', 'b', 'c', 'd'].map((n) => commitAs(dir, `${n}.txt`, `${n}\n`, `commit ${n}`));
    dirty(dir);
    const todo = [{ action: 'reword', sha: c[0] }, { action: 'pick', sha: c[1] }, { action: 'squash', sha: c[2] }, { action: 'drop', sha: c[3] }];
    const res = await ops.OPS.rebaseInteractive(dir, { upstream: base }, todo, { messages: { [c[0]]: 'A', [c[2]]: 'B and C' } });
    assert.equal(res.status, 'done');
    assert.deepEqual(subjects(dir, `${base}..HEAD`), ['B and C', 'A']);
    assert.equal(fs.existsSync(path.join(dir, 'd.txt')), false);
    assert.deepEqual(await split(dir), DIRTY_SPLIT);
  });

  test('merge with autostash: conflict, keep theirs, Commit and Merge', async () => {
    const dir = repo({ sha256: true });
    h.hostileConfig(dir);
    h.git(dir, 'branch', 'feat');
    h.commitFile(dir, 'README.md', 'main side\n', 'main edit');
    h.git(dir, 'checkout', '-q', 'feat');
    const feat = h.commitFile(dir, 'README.md', 'feat side\n', 'feat edit');
    h.git(dir, 'checkout', '-q', 'main');
    dirty(dir);
    const res = await ops.OPS.merge(dir, 'feat');
    assert.equal(res.stop, 'conflict');
    assert.equal(res.state.head, feat);
    await ops.OPS.resolveWith(dir, 'README.md', 'theirs');
    const done = await ops.OPS.mergeCommit(dir, {});
    assert.equal(done.sha.length, 64);
    assert.equal(h.read(dir, 'README.md'), 'feat side\n');
    assert.deepEqual(await split(dir), DIRTY_SPLIT);
  });
});

describe('what a rebase finished after a stop reports', () => {
  test('plain: skippedCherryPicks and dropped survive the stop', async () => {
    const { dir, c1, c3 } = conflicting();
    h.git(dir, 'checkout', '-q', 'main');
    h.git(dir, 'cherry-pick', c1); // "one" is skipped
    h.write(dir, 'c.txt', 'c\n'); // "three" becomes empty (not the same patch): dropped
    h.write(dir, 'other.txt', 'o\n');
    h.git(dir, 'add', 'c.txt', 'other.txt');
    h.git(dir, 'commit', '-q', '-m', 'c and more');
    h.git(dir, 'checkout', '-q', 'feat');
    const res = await ops.OPS.rebase(dir, 'main');
    assert.equal(res.status, 'stopped');
    h.write(dir, 'README.md', 'resolved\n');
    h.git(dir, 'add', 'README.md');
    const done = await ops.createRunner().run(dir, 'rebaseContinue', []);
    assert.equal(done.status, 'done');
    assert.equal(done.skippedCherryPicks, 1);
    assert.deepEqual(done.dropped, [c3]);
    assert.equal(done.fastForward, false);
    assert.deepEqual(subjects(dir, 'main..feat'), ['two']);
  });

  test('interactive: a commit emptied after an edit stop is reported dropped', async () => {
    const dir = repo();
    const base = head(dir);
    const c1 = commitAs(dir, 'a.txt', 'a\n', 'one');
    const c2 = commitAs(dir, 'b.txt', 'b\n', 'two');
    const res = await ops.OPS.rebaseInteractive(dir, { upstream: base }, [{ action: 'edit', sha: c1 }, { action: 'pick', sha: c2 }], {});
    assert.equal(res.state.stop, 'edit');
    h.write(dir, 'b.txt', 'b\n'); // "one" takes "two"'s change: "two" becomes empty
    h.git(dir, 'add', 'b.txt');
    await ops.createRunner().run(dir, 'commit', ['one and two', { amend: true }]);
    const done = await ops.createRunner().run(dir, 'rebaseContinue', []);
    assert.equal(done.status, 'done');
    assert.deepEqual(done.dropped, [c2]);
    assert.deepEqual(subjects(dir, `${base}..HEAD`), ['one and two']);
  });
});

describe('published commits', () => {
  function published() {
    const { local, seed } = h.repoWithRemote();
    h.git(local, 'checkout', '-q', '-b', 'feat');
    const p1 = commitAs(local, 'a.txt', 'a\n', 'pushed one');
    h.git(local, 'push', '-q', 'origin', 'feat:part');
    const p2 = commitAs(local, 'b.txt', 'b\n', 'pushed two');
    h.git(local, 'push', '-q', '-u', 'origin', 'feat');
    const u1 = commitAs(local, 'c.txt', 'c\n', 'local only');
    h.commitFile(seed, 'README.md', 'upstream\n', 'upstream work');
    h.git(seed, 'push', '-q', 'origin', 'main');
    h.git(local, 'fetch', '-q');
    return { local, p1, p2, u1 };
  }

  test('rebasePlan: every remote ref that has a commit, in ref order', async () => {
    const { local, p1, p2 } = published();
    const plan = await ops.OPS.rebasePlan(local, { upstream: 'refs/remotes/origin/main' });
    assert.deepEqual(plan.published, [{ sha: p1, remoteRefs: ['origin/feat', 'origin/part'] }, { sha: p2, remoteRefs: ['origin/feat'] }]);
    assert.deepEqual(plan.publishedRefs, ['origin/feat', 'origin/part']);
  });

  test('published counts only the commits that got a new sha', async () => {
    const { local, u1 } = published();
    const base = rev(local, 'main');
    const plan = await ops.OPS.rebasePlan(local, { upstream: base });
    const todo = plan.commits.map((c) => ({ action: c.sha === u1 ? 'reword' : 'pick', sha: c.sha }));
    const res = await ops.OPS.rebaseInteractive(local, { upstream: base }, todo, { messages: { [u1]: 'local only, reworded' } });
    assert.equal(res.status, 'done');
    assert.equal(res.published, 0); // the pushed commits kept their shas
    const all = await ops.OPS.rebase(local, 'refs/remotes/origin/main');
    assert.equal(all.published, 2);
  });
});
