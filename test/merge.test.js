'use strict';
// Merge from the menus (docs/plans/rebase.md §8, §9, R2): ff / no-ff / ff-only, conflicts
// concluded or aborted, our persistent autostash across a merge stop, Keep-a-side
// (resolveWith) and Mark all resolved, target resolution (a branch named like a remote branch).
// Every repo runs under helpers.hostileConfig (merge.ff=false, core.commentChar=; ...).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const g = require('../src/git');
const ops = require('../src/ops');
const merge = require('../src/merge');

after(h.cleanup);

const head = (dir) => h.git(dir, 'rev-parse', 'HEAD').trim();
const rev = (dir, r) => h.git(dir, 'rev-parse', r).trim();
const parents = (dir, r = 'HEAD') => h.git(dir, 'log', '-1', '--format=%P', r).trim().split(' ').filter(Boolean);
const body = (dir, r = 'HEAD') => h.git(dir, 'log', '-1', '--format=%B', r);
const stashList = (dir) => h.git(dir, 'stash', 'list', '--format=%H').trim().split('\n').filter(Boolean);
const autostashRef = (dir) => {
  try {
    return h.git(dir, 'rev-parse', '-q', '--verify', 'refs/worktree/pasta-lite/autostash').trim();
  } catch {
    return null;
  }
};
const split = async (dir) => {
  const st = await g.status(dir);
  return { staged: st.staged, unstaged: st.unstaged };
};

/** main and feat diverge from "initial": main adds m.txt, feat adds f.txt (no conflict). */
function diverged({ conflict = false } = {}) {
  const dir = h.initRepo();
  h.hostileConfig(dir);
  h.git(dir, 'branch', 'feat');
  const main = conflict ? h.commitFile(dir, 'README.md', 'main side\n', 'main edit') : h.commitFile(dir, 'm.txt', 'm\n', 'main edit');
  h.git(dir, 'checkout', '-q', 'feat');
  const feat = conflict ? h.commitFile(dir, 'README.md', 'feat side\n', 'feat edit') : h.commitFile(dir, 'f.txt', 'f\n', 'feat edit');
  h.git(dir, 'checkout', '-q', 'main');
  return { dir, main, feat };
}

/** feat is main plus one commit. */
function ahead() {
  const dir = h.initRepo();
  h.hostileConfig(dir);
  const base = head(dir);
  h.git(dir, 'checkout', '-q', '-b', 'feat');
  const feat = h.commitFile(dir, 'f.txt', 'f\n', 'feat edit');
  h.git(dir, 'checkout', '-q', 'main');
  return { dir, base, feat };
}

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

describe('merge: fast-forward modes', () => {
  test("ff (default) fast-forwards despite merge.ff=false; the result names both ends", async () => {
    const { dir, base, feat } = ahead();
    const runner = ops.createRunner();
    const events = [];
    runner.on('changed', (e) => events.push(e.op));
    const res = await runner.run(dir, 'merge', ['feat']);
    assert.deepEqual(res, { status: 'done', branch: 'main', before: base, after: feat, fastForward: true, undoRecorded: false });
    assert.equal(head(dir), feat);
    assert.equal(h.git(dir, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
    assert.deepEqual(events, ['merge']);
  });

  test('no-ff makes a merge commit with a clear message; ff on diverged branches too', async () => {
    const { dir, base, feat } = ahead();
    const res = await ops.OPS.merge(dir, 'feat', { ff: 'no-ff' });
    assert.equal(res.status, 'done');
    assert.equal(res.fastForward, false);
    assert.deepEqual(parents(dir), [base, feat]);
    assert.equal(body(dir), "Merge branch 'feat' into main\n");

    const d = diverged();
    const r2 = await ops.OPS.merge(d.dir, 'feat');
    assert.equal(r2.fastForward, false);
    assert.deepEqual(parents(d.dir), [d.main, d.feat]);
    assert.equal(h.git(d.dir, 'log', '-1', '--format=%s').trim(), "Merge branch 'feat' into main");
    assert.equal(h.read(d.dir, 'f.txt'), 'f\n');
  });

  test('ff-only: refused before anything runs when the branches diverged; fast-forwards otherwise', async () => {
    const { dir, main } = diverged();
    const runner = ops.createRunner();
    const events = [];
    runner.on('busy', (e) => events.push(e));
    await assert.rejects(runner.run(dir, 'merge', ['feat', { ff: 'ff-only' }]), { kind: 'not-fast-forward' });
    assert.deepEqual(events, []);
    assert.equal(head(dir), main);

    const a = ahead();
    const res = await runner.run(a.dir, 'merge', ['refs/heads/feat', { ff: 'ff-only' }]);
    assert.equal(res.fastForward, true);
    assert.equal(head(a.dir), a.feat);
  });

  test('a target already in HEAD: up-to-date, nothing run', async () => {
    const { dir, feat } = ahead();
    h.git(dir, 'checkout', '-q', 'feat');
    const res = await ops.OPS.merge(dir, 'main', { ff: 'no-ff' });
    assert.deepEqual(res, { status: 'up-to-date', branch: 'feat', head: feat });
    assert.equal(head(dir), feat);
  });

  test('merging a commit id or a tag names it in the message; detached HEAD has no "into"', async () => {
    const d = diverged();
    h.git(d.dir, 'tag', '-a', '-m', 'release', 'v1', d.feat);
    await ops.OPS.merge(d.dir, 'v1');
    assert.equal(h.git(d.dir, 'log', '-1', '--format=%s').trim(), "Merge tag 'v1' into main");
    assert.deepEqual(parents(d.dir), [d.main, d.feat]);

    const e = diverged();
    await ops.OPS.merge(e.dir, e.feat);
    assert.equal(h.git(e.dir, 'log', '-1', '--format=%s').trim(), `Merge commit '${e.feat.slice(0, 7)}' into main`);

    const f = diverged();
    h.git(f.dir, 'checkout', '-q', '--detach', 'main');
    const res = await ops.OPS.merge(f.dir, 'feat');
    assert.equal(res.branch, null);
    assert.equal(h.git(f.dir, 'log', '-1', '--format=%s').trim(), "Merge branch 'feat'");
  });
});

describe('merge: conflicts', () => {
  test('stopped with status.merge; Keep theirs; Commit and Merge concludes with the message', async () => {
    const { dir, main, feat } = diverged({ conflict: true });
    const runner = ops.createRunner();
    const events = [];
    runner.on('changed', (e) => events.push(e));
    const res = await runner.run(dir, 'merge', ['feat']);
    assert.deepEqual(res, {
      status: 'stopped', stop: 'conflict', conflicted: 1,
      state: { head: feat, name: 'feat', message: "Merge branch 'feat' into main", autostash: null },
    });
    assert.deepEqual(events, [{ repo: dir, op: 'merge', ok: true }]);
    const st = await g.status(dir);
    assert.equal(st.state, 'merging');
    assert.deepEqual(st.merge, res.state);

    // A second merge / a rebase is refused while this one is in progress.
    await assert.rejects(runner.run(dir, 'merge', ['feat']), { kind: 'in-progress', state: 'merging' });
    await assert.rejects(runner.run(dir, 'rebase', ['feat']), { kind: 'in-progress', state: 'merging' });
    await assert.rejects(runner.run(dir, 'mergeCommit', []), { kind: 'conflicts', count: 1 });

    const kept = await runner.run(dir, 'resolveWith', ['README.md', 'theirs']);
    assert.deepEqual(kept, { path: 'README.md', side: 'theirs', deleted: false });
    assert.equal(h.read(dir, 'README.md'), 'feat side\n');
    await assert.rejects(runner.run(dir, 'resolveWith', ['README.md', 'ours']), { kind: 'not-conflicted' });

    const done = await runner.run(dir, 'mergeCommit', []);
    assert.equal(done.status, 'done');
    assert.equal(done.summary, "Merge branch 'feat' into main");
    assert.deepEqual(parents(dir), [main, feat]);
    assert.doesNotMatch(body(dir), /Conflicts/); // git's comment lines (core.commentChar=;) stripped
  });

  test('abort goes back to where the merge started', async () => {
    const { dir, main } = diverged({ conflict: true });
    const runner = ops.createRunner();
    assert.equal((await runner.run(dir, 'merge', ['feat'])).status, 'stopped');
    const res = await runner.run(dir, 'mergeAbort', []);
    assert.deepEqual(res, { status: 'aborted', head: main });
    assert.equal((await g.status(dir)).state, 'clean');
    assert.equal(h.read(dir, 'README.md'), 'main side\n');
  });

  test('resolveWith ours keeps the current branch; Mark all resolved stages the rest', async () => {
    const { dir } = diverged({ conflict: true });
    // A second conflicted file.
    h.commitFile(dir, 'x.txt', 'main x\n', 'main x');
    h.git(dir, 'checkout', '-q', 'feat');
    h.commitFile(dir, 'x.txt', 'feat x\n', 'feat x');
    h.git(dir, 'checkout', '-q', 'main');
    const runner = ops.createRunner();
    const res = await runner.run(dir, 'merge', ['feat']);
    assert.equal(res.conflicted, 2);
    await runner.run(dir, 'resolveWith', ['README.md', 'ours']);
    assert.equal(h.read(dir, 'README.md'), 'main side\n');
    assert.equal((await g.status(dir)).conflicted.length, 1);
    h.write(dir, 'x.txt', 'both x\n');
    assert.deepEqual(await runner.run(dir, 'markAllResolved', []), { paths: ['x.txt'], count: 1 });
    assert.equal((await g.status(dir)).conflicted.length, 0);
    await assert.rejects(runner.run(dir, 'markAllResolved', []), { kind: 'nothing' });
    await runner.run(dir, 'mergeCommit', []);
    assert.equal(h.git(dir, 'show', 'HEAD:x.txt'), 'both x\n');
  });

  test('a modify/delete conflict: the side that deleted the file removes it', async () => {
    const dir = h.initRepo();
    h.hostileConfig(dir);
    h.commitFile(dir, 'gone.txt', 'v1\n', 'add gone');
    h.git(dir, 'branch', 'feat');
    h.git(dir, 'rm', '-q', 'gone.txt');
    h.git(dir, 'commit', '-q', '-m', 'delete gone');
    h.git(dir, 'checkout', '-q', 'feat');
    h.commitFile(dir, 'gone.txt', 'v2\n', 'edit gone');
    h.git(dir, 'checkout', '-q', 'main');
    const runner = ops.createRunner();
    assert.equal((await runner.run(dir, 'merge', ['feat'])).stop, 'conflict');
    const res = await runner.run(dir, 'resolveWith', ['gone.txt', 'ours']);
    assert.deepEqual(res, { path: 'gone.txt', side: 'ours', deleted: true });
    assert.equal(fs.existsSync(path.join(dir, 'gone.txt')), false);
    assert.equal((await g.status(dir)).conflicted.length, 0);
    await runner.run(dir, 'mergeCommit', []);
    assert.equal(h.git(dir, 'ls-files', 'gone.txt'), '');

    // …and the other way round: keeping the modified file.
    h.git(dir, 'reset', '-q', '--hard', 'HEAD^1');
    assert.equal((await runner.run(dir, 'merge', ['feat'])).stop, 'conflict');
    assert.deepEqual(await runner.run(dir, 'resolveWith', ['gone.txt', 'theirs']), { path: 'gone.txt', side: 'theirs', deleted: false });
    assert.equal(h.read(dir, 'gone.txt'), 'v2\n');
  });

  test('a failing pre-merge-commit hook stops the merge (stop hook, with its output)', async () => {
    const { dir } = diverged();
    const hook = path.join(dir, '.git', 'hooks', 'pre-merge-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "no merges on Friday" >&2\nexit 1\n', { mode: 0o755 });
    const res = await ops.createRunner().run(dir, 'merge', ['feat']);
    assert.equal(res.status, 'stopped');
    assert.equal(res.stop, 'hook');
    assert.equal(res.conflicted, 0);
    assert.match(res.hookOutput, /no merges on Friday/);
    fs.rmSync(hook);
    assert.equal((await ops.createRunner().run(dir, 'mergeCommit', [])).status, 'done');
  });

  test('unrelated histories are refused with a kind; nothing changes', async () => {
    const { dir, main } = diverged();
    h.git(dir, 'checkout', '-q', '--orphan', 'other');
    h.git(dir, 'rm', '-q', '-rf', '.');
    h.commitFile(dir, 'o.txt', 'o\n', 'other root');
    h.git(dir, 'checkout', '-q', 'main');
    await assert.rejects(ops.OPS.merge(dir, 'other'), { kind: 'unrelated-histories' });
    assert.equal(head(dir), main);
    assert.equal((await g.status(dir)).state, 'clean');
  });
});

describe('merge: autostash', () => {
  test('clean merge: the staged / unstaged / untracked split comes back; no stash left', async () => {
    const { dir } = diverged();
    dirty(dir);
    const res = await ops.OPS.merge(dir, 'feat');
    assert.equal(res.status, 'done');
    assert.deepEqual(await split(dir), DIRTY_SPLIT);
    assert.deepEqual(stashList(dir), []);
    assert.equal(autostashRef(dir), null);
  });

  test('a merge conflict keeps the autostash across the stop; abort brings it back', async () => {
    const { dir, main } = diverged({ conflict: true });
    dirty(dir);
    const res = await ops.OPS.merge(dir, 'feat');
    assert.equal(res.status, 'stopped');
    assert.ok(res.stash && res.stash.kept);
    assert.equal(autostashRef(dir), res.stash.sha);
    assert.deepEqual(stashList(dir), [res.stash.sha]);
    assert.match(h.git(dir, 'stash', 'list', '--format=%s'), /pasta-lite autostash before merge of feat into main/);
    assert.equal(fs.existsSync(path.join(dir, 'u.txt')), false);

    const ab = await ops.OPS.mergeAbort(dir);
    assert.deepEqual(ab, { status: 'aborted', head: main });
    assert.deepEqual(await split(dir), DIRTY_SPLIT);
    assert.deepEqual(stashList(dir), []);
    assert.equal(autostashRef(dir), null);
  });

  test('a merge conflict with autostash, resolved and concluded: the stash comes back after Commit and Merge', async () => {
    const { dir } = diverged({ conflict: true });
    dirty(dir);
    const res = await ops.OPS.merge(dir, 'feat');
    assert.equal(res.stop, 'conflict');
    // Stage the resolution only (the autostashed files are not in the tree).
    await ops.OPS.resolveWith(dir, 'README.md', 'theirs');
    const done = await ops.OPS.mergeCommit(dir, {});
    assert.equal(done.status, 'done');
    assert.equal(done.stash, undefined);
    assert.equal(parents(dir).length, 2);
    assert.deepEqual(await split(dir), DIRTY_SPLIT);
    assert.equal(autostashRef(dir), null);
  });

  test("an untracked file the merge result has too: done, nothing applied, the stash and its ref kept (reason 'untracked')", async () => {
    const { dir } = diverged();
    h.write(dir, 'f.txt', 'mine\n'); // untracked here; feat adds f.txt
    const res = await ops.OPS.merge(dir, 'feat');
    assert.equal(res.status, 'done');
    assert.deepEqual(res.stash, { kept: true, sha: stashList(dir)[0], reason: 'untracked' });
    assert.equal(autostashRef(dir), res.stash.sha, 'Restore can be tried again once the file is out of the way');
    assert.equal((await g.status(dir)).pendingAutostash, res.stash.sha);
    assert.equal(h.read(dir, 'f.txt'), 'f\n');
    assert.equal(h.git(dir, 'status', '--porcelain'), '');
  });

  test('autostash: false refuses local changes to tracked files before anything runs', async () => {
    const { dir } = diverged();
    h.write(dir, 'README.md', 'local\n');
    await assert.rejects(ops.OPS.merge(dir, 'feat', { autostash: false }), (e) => e.kind === 'dirty' && e.paths[0] === 'README.md');
    await assert.rejects(ops.OPS.merge(dir, 'feat', { autostash: 'yes' }), { kind: 'invalid-args' });
  });
});

describe('merge: validation', () => {
  test('a branch named like a remote branch never confuses targets', async () => {
    const { local, seed } = h.repoWithRemote();
    h.hostileConfig(local);
    const remoteTip = h.commitFile(seed, 'r.txt', 'r\n', 'remote work');
    h.git(seed, 'push', '-q', 'origin', 'main');
    h.git(local, 'fetch', '-q');
    h.git(local, 'branch', 'origin/main', 'main'); // a local branch called origin/main
    h.git(local, 'checkout', '-q', 'origin/main');
    const localTip = h.commitFile(local, 'l.txt', 'l\n', 'local work');
    h.git(local, 'checkout', '-q', 'main');
    const before = head(local);

    await assert.rejects(ops.OPS.merge(local, 'origin/main'), (e) => e.kind === 'ambiguous'
      && e.refs.join() === 'refs/heads/origin/main,refs/remotes/origin/main');
    assert.deepEqual(ops.serializeError(await ops.OPS.merge(local, 'origin/main').catch((e) => e)).refs, ['refs/heads/origin/main', 'refs/remotes/origin/main']);

    const res = await ops.OPS.merge(local, 'refs/remotes/origin/main', { ff: 'no-ff' });
    assert.equal(res.status, 'done');
    assert.deepEqual(parents(local), [before, remoteTip]);
    assert.equal(h.git(local, 'log', '-1', '--format=%s').trim(), "Merge remote-tracking branch 'origin/main' into main");

    const r2 = await ops.OPS.merge(local, 'refs/heads/origin/main', { ff: 'no-ff' });
    assert.equal(r2.status, 'done');
    assert.equal(parents(local)[1], localTip);
    assert.equal(h.git(local, 'log', '-1', '--format=%s').trim(), "Merge branch 'origin/main' into main");
  });

  test('refusals: bad targets, expectHead, unborn HEAD, bad ff', async () => {
    const { dir, main } = diverged();
    const runner = ops.createRunner();
    const events = [];
    runner.on('busy', (e) => events.push(e));
    for (const t of ['--output=x', 'main..feat', 'feat@{1}', 'nope', 'refs/heads/nope', 'refs/stash', 'HEAD~1', '', 42, 'feat^{tree}']) {
      await assert.rejects(runner.run(dir, 'merge', [t]), { kind: 'invalid-args' }, String(t));
    }
    await assert.rejects(runner.run(dir, 'merge', ['feat', { ff: 'squash' }]), { kind: 'invalid-args' });
    await assert.rejects(runner.run(dir, 'merge', ['feat', { expectHead: 'abc' }]), { kind: 'invalid-args' });
    await assert.rejects(runner.run(dir, 'merge', ['feat', { expectHead: rev(dir, 'feat') }]), (e) => e.kind === 'stale' && e.head === main);
    assert.deepEqual(events, []);
    assert.equal((await runner.run(dir, 'merge', ['feat', { expectHead: main }])).status, 'done');

    const unborn = h.initRepo({ commits: false });
    await assert.rejects(ops.OPS.merge(unborn, 'main'), { kind: 'invalid-args' });
  });

  test('mergeMessage wording', () => {
    assert.equal(merge.mergeMessage({ kind: 'local', name: 'feat' }, 'main'), "Merge branch 'feat' into main");
    assert.equal(merge.mergeMessage({ kind: 'remote', name: 'origin/x' }, 'dev'), "Merge remote-tracking branch 'origin/x' into dev");
    assert.equal(merge.mergeMessage({ kind: 'commit', name: 'abc1234' }, null), "Merge commit 'abc1234'");
  });
});
