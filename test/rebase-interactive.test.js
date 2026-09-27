'use strict';
// Interactive rebase (docs/plans/rebase.md §3.3, §4.2–4.3, §9.2, §9.5, R3): rebaseInteractive
// through the ops runner with each action alone and mixed, squash / fixup groups, drop-all,
// conflicts after a reorder (continue / skip / abort), edit stops (amend, continue), a
// commit-msg hook refusing a reword, every validation refusal (proving nothing ran), a todo git
// refuses (aborted), rebasePlan's interactive refusals, and the property tests (seeded). Every
// repo runs under helpers.hostileConfig (rebase.missingCommitsCheck=ignore,
// rebase.abbreviateCommands=true, sequence.editor=false, core.editor=false, commit.cleanup=verbatim,
// core.commentChar=; ...).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const h = require('./helpers');
const g = require('../src/git');
const ops = require('../src/ops');
const rebase = require('../src/rebase');

after(h.cleanup);

const ALICE = 'Alice <alice@example.com>';
const BOB = 'Bob <bob@example.com>';
const head = (dir) => h.git(dir, 'rev-parse', 'HEAD').trim();
const rev = (dir, r) => h.git(dir, 'rev-parse', r).trim();
const tree = (dir, r = 'HEAD') => rev(dir, `${r}^{tree}`);
const subjects = (dir, range) => h.git(dir, 'log', '--format=%s', range).trim().split('\n').filter(Boolean);
const authors = (dir, range) => h.git(dir, 'log', '--format=%an <%ae>', range).trim().split('\n').filter(Boolean);
const body = (dir, r = 'HEAD') => h.git(dir, 'log', '-1', '--format=%B', r);
const exists = (dir, f) => fs.existsSync(path.join(dir, f));
const T = (...pairs) => pairs.map(([action, sha]) => ({ action, sha }));

let clock = 1700000000;
/** Commit `file` as `who` with its own author date (so rebased copies can be told apart). */
function commitAs(dir, file, content, message, who = ALICE) {
  h.write(dir, file, content);
  h.git(dir, 'add', '--', file);
  clock += 60;
  execFileSync('git', ['commit', '-q', `--author=${who}`, '-m', message], {
    cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: `@${clock} +0000`, GIT_COMMITTER_DATE: `@${clock} +0000` },
  });
  return head(dir);
}

/**
 * main: "initial" (README) + "base" (x.txt = 1). feat (checked out) has `n` commits c1..cn,
 * each adding its own file f<i>.txt, alternating authors Alice / Bob.
 */
function setup(n = 4) {
  const dir = h.initRepo();
  h.hostileConfig(dir);
  const base = h.commitFile(dir, 'x.txt', '1\n', 'base');
  h.git(dir, 'checkout', '-q', '-b', 'feat');
  const c = [];
  for (let i = 1; i <= n; i++) c.push(commitAs(dir, `f${i}.txt`, `${i}\n`, `c${i}`, i % 2 ? ALICE : BOB));
  return { dir, base, c, tip: c[c.length - 1] };
}

/** Run rebaseInteractive onto main through a runner; returns {res, events}. */
async function ri(dir, todo, o = {}, range = { upstream: 'main' }) {
  const runner = ops.createRunner();
  const events = [];
  runner.on('changed', (e) => events.push(e.op));
  const res = await runner.run(dir, 'rebaseInteractive', [range, todo, o]);
  return { res, events, runner };
}

function assertDone(res, dir, before) {
  assert.equal(res.status, 'done');
  assert.equal(res.branch, 'feat');
  assert.equal(res.before, before);
  assert.equal(res.after, head(dir));
  assert.equal(res.fastForward, false);
  assert.equal(res.undoRecorded, false);
  assert.equal(h.git(dir, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/feat');
  assert.equal(exists(dir, '.git/rebase-merge'), false);
  assert.equal(exists(dir, '.git/pasta-lite/rebase'), false);
}

describe('each action, alone and mixed', () => {
  test('reorder (pick only): same tree, new order, authors kept, the expectHead guard passes', async () => {
    const { dir, base, c, tip } = setup(3);
    const before = tree(dir);
    const { res, events } = await ri(dir, T(['pick', c[2]], ['pick', c[0]], ['pick', c[1]]), { expectHead: tip });
    assertDone(res, dir, tip);
    assert.deepEqual(events, ['rebaseInteractive']);
    assert.deepEqual(res.dropped, []);
    assert.equal(res.skippedCherryPicks, 0);
    assert.equal(res.published, 0);
    assert.equal(tree(dir), before);
    assert.deepEqual(subjects(dir, 'main..feat'), ['c2', 'c1', 'c3']);
    assert.deepEqual(authors(dir, 'main..feat'), [BOB, ALICE, ALICE]);
    assert.equal(rev(dir, 'feat~3'), base);
    // rebase.updateRefs=true, rebase.autoSquash=true in the config changed nothing else.
    assert.equal(rev(dir, 'main'), base);
  });

  test('reword: the message given (# lines stripped), author kept, earlier commits untouched', async () => {
    const { dir, c, tip } = setup(3);
    const msg = 'c2 reworded\n\n# stripped: a comment line\nbody line\n';
    const { res } = await ri(dir, T(['pick', c[0]], ['reword', c[1]], ['pick', c[2]]), { messages: { [c[1]]: msg } });
    assertDone(res, dir, tip);
    assert.deepEqual(subjects(dir, 'main..feat'), ['c3', 'c2 reworded', 'c1']);
    assert.equal(body(dir, 'feat~1'), 'c2 reworded\n\nbody line\n\n');
    assert.deepEqual(authors(dir, 'main..feat'), [ALICE, BOB, ALICE]);
    assert.equal(rev(dir, 'feat~2'), c[0]); // unchanged picks keep their sha
    assert.deepEqual(res.dropped, []);
  });

  test('drop: the commit and its file gone, the others kept', async () => {
    const { dir, c, tip } = setup(3);
    const { res } = await ri(dir, T(['pick', c[0]], ['drop', c[1]], ['pick', c[2]]));
    assertDone(res, dir, tip);
    assert.deepEqual(subjects(dir, 'main..feat'), ['c3', 'c1']);
    assert.equal(exists(dir, 'f2.txt'), false);
    assert.equal(exists(dir, 'f3.txt'), true);
    assert.deepEqual(res.dropped, []); // dropped by the plan, not emptied by git
  });

  test('squash group of 3: one commit, the combined message as given, author of the first', async () => {
    const { dir, base, c, tip } = setup(4);
    const msg = 'all three\n\nfrom c1, c2 and c3\n';
    const { res } = await ri(dir, T(['pick', c[0]], ['squash', c[1]], ['squash', c[2]], ['pick', c[3]]), { messages: { [c[2]]: msg } });
    assertDone(res, dir, tip);
    assert.deepEqual(subjects(dir, 'main..feat'), ['c4', 'all three']);
    assert.equal(body(dir, 'feat~1'), 'all three\n\nfrom c1, c2 and c3\n\n');
    assert.deepEqual(authors(dir, 'main..feat'), [BOB, ALICE]);
    assert.equal(tree(dir), tree(dir, tip));
    assert.equal(rev(dir, 'feat~2'), base);
    assert.deepEqual(res.dropped, []);
  });

  test('fixup group: the target message kept, no message needed', async () => {
    const { dir, c, tip } = setup(3);
    const { res } = await ri(dir, T(['pick', c[0]], ['fixup', c[1]], ['fixup', c[2]]));
    assertDone(res, dir, tip);
    assert.deepEqual(subjects(dir, 'main..feat'), ['c1']);
    assert.equal(body(dir), 'c1\n\n');
    assert.equal(tree(dir), tree(dir, tip));
  });

  test('a squash then a fixup in one group: the message given is used (keyed by the fixup, the last member)', async () => {
    const { dir, c } = setup(3);
    const { res } = await ri(dir, T(['pick', c[0]], ['squash', c[1]], ['fixup', c[2]]), { messages: { [c[2]]: 'squashed with fixup' } });
    assert.equal(res.status, 'done');
    assert.deepEqual(subjects(dir, 'main..feat'), ['squashed with fixup']);
  });

  test('mixed: reorder + reword + squash (across a drop) + drop + fixup', async () => {
    const { dir, c, tip } = setup(6);
    const todo = T(['pick', c[5]], ['reword', c[0]], ['drop', c[1]], ['squash', c[2]], ['pick', c[3]], ['fixup', c[4]]);
    const { res } = await ri(dir, todo, { messages: { [c[0]]: 'one, reworded', [c[2]]: 'one and three' } });
    assertDone(res, dir, tip);
    assert.deepEqual(subjects(dir, 'main..feat'), ['c4', 'one and three', 'c6']);
    for (const f of ['f1.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'f6.txt']) assert.ok(exists(dir, f), f);
    assert.equal(exists(dir, 'f2.txt'), false);
    assert.deepEqual(res.dropped, []);
  });

  test('drop everything: the branch ends at onto (allowed)', async () => {
    const { dir, base, c, tip } = setup(3);
    const { res } = await ri(dir, T(['drop', c[0]], ['drop', c[1]], ['drop', c[2]]));
    assertDone(res, dir, tip);
    assert.equal(rev(dir, 'feat'), base);
    assert.equal(res.after, base);
    assert.equal(exists(dir, 'f1.txt'), false);
  });

  test('onto differs from upstream ("children of" another base), and a commit git empties is reported dropped', async () => {
    const { dir, base, c, tip } = setup(3);
    // main gets c2's change too, so c2 becomes empty on main (--empty=drop).
    h.git(dir, 'checkout', '-q', 'main');
    const main = commitAs(dir, 'f2.txt', '2\n', 'c2 on main', BOB);
    h.git(dir, 'checkout', '-q', 'feat');
    const { res } = await ri(dir, T(['pick', c[0]], ['pick', c[2]], ['pick', c[1]]), {}, { upstream: base, onto: 'main' });
    assertDone(res, dir, tip);
    assert.deepEqual(subjects(dir, `${main}..feat`), ['c3', 'c1']);
    assert.deepEqual(res.dropped, [c[1]]);
  });

  test('autostash: local changes (staged, unstaged, untracked) survive with the split', async () => {
    const { dir, c } = setup(2);
    h.write(dir, 'st.txt', 's\n');
    h.git(dir, 'add', 'st.txt');
    h.write(dir, 'x.txt', '1\ndirty\n');
    h.write(dir, 'u.txt', 'u\n');
    const want = await g.status(dir);
    const { res } = await ri(dir, T(['pick', c[1]], ['pick', c[0]]));
    assert.equal(res.status, 'done');
    assert.equal(res.stash, undefined);
    const st = await g.status(dir);
    assert.deepEqual({ staged: st.staged, unstaged: st.unstaged }, { staged: want.staged, unstaged: want.unstaged });
    assert.equal(h.git(dir, 'stash', 'list').trim(), '');
  });
});

describe('stops: conflicts, edit, hooks', () => {
  /** feat: c1 (own file), c2 (x.txt 1 -> 2), c3 (x.txt 2 -> 3). Reordering c3 before c2 conflicts. */
  function conflictSetup() {
    const dir = h.initRepo();
    h.hostileConfig(dir);
    const base = h.commitFile(dir, 'x.txt', '1\n', 'base');
    h.git(dir, 'checkout', '-q', '-b', 'feat');
    const c1 = commitAs(dir, 'a.txt', 'a\n', 'c1');
    const c2 = commitAs(dir, 'x.txt', '2\n', 'c2');
    const c3 = commitAs(dir, 'x.txt', '3\n', 'c3');
    return { dir, base, c1, c2, c3 };
  }
  const reorder = ({ c1, c2, c3 }) => T(['pick', c1], ['pick', c3], ['pick', c2]);

  test('a conflict at step 2 after a reorder: stopped, then continue (resolving each step) finishes', async () => {
    const s = conflictSetup();
    const { dir, c3 } = s;
    const { res } = await ri(dir, reorder(s));
    assert.equal(res.status, 'stopped');
    const r = res.state;
    assert.equal(r.stop, 'conflict');
    assert.equal(r.ours, true);
    assert.equal(r.interactive, true);
    assert.equal(r.branch, 'feat');
    assert.equal(r.ontoName, 'main');
    assert.deepEqual(r.step, { done: 2, total: 3 });
    assert.deepEqual(r.current, { cmd: 'pick', sha: c3, subject: 'c3' });
    assert.equal(r.todoEditable, true);
    const runner = ops.createRunner();
    h.write(dir, 'x.txt', '3\n');
    h.git(dir, 'add', 'x.txt');
    const next = await runner.run(dir, 'rebaseContinue', []);
    assert.equal(next.status, 'stopped'); // c2 (1 -> 2) now conflicts with 3
    assert.deepEqual(next.state.step, { done: 3, total: 3 });
    h.write(dir, 'x.txt', '2\n');
    h.git(dir, 'add', 'x.txt');
    const fin = await runner.run(dir, 'rebaseContinue', []);
    assert.equal(fin.status, 'done');
    assert.deepEqual(subjects(dir, 'main..feat'), ['c2', 'c3', 'c1']);
    assert.equal(exists(dir, '.git/pasta-lite/rebase'), false);
  });

  test('a conflict, then skip: the skipped commit is left out, the rest applied', async () => {
    const s = conflictSetup();
    const { dir } = s;
    await ri(dir, reorder(s));
    const res = await ops.createRunner().run(dir, 'rebaseSkip', []);
    assert.equal(res.status, 'done');
    assert.deepEqual(subjects(dir, 'main..feat'), ['c2', 'c1']);
    assert.equal(h.read(dir, 'x.txt'), '2\n');
  });

  test('a conflict, then abort: branch, tree and state folder back as before', async () => {
    const s = conflictSetup();
    const { dir, c3 } = s;
    const before = tree(dir);
    await ri(dir, reorder(s));
    const res = await ops.createRunner().run(dir, 'rebaseAbort', []);
    assert.equal(res.status, 'aborted');
    assert.equal(rev(dir, 'feat'), c3);
    assert.equal(tree(dir), before);
    assert.equal((await g.status(dir)).state, 'clean');
    assert.equal(exists(dir, '.git/rebase-merge'), false);
    assert.equal(exists(dir, '.git/pasta-lite/rebase'), false);
  });

  test('a conflict at a reworded commit: continue commits the resolution with the prepared message', async () => {
    const s = conflictSetup();
    const { dir, c1, c2, c3 } = s;
    const { res } = await ri(dir, T(['pick', c1], ['reword', c3], ['pick', c2]), { messages: { [c3]: 'three, reworded' } });
    assert.equal(res.status, 'stopped');
    assert.equal(res.state.current.cmd, 'reword');
    h.write(dir, 'x.txt', '3\n');
    h.git(dir, 'add', 'x.txt');
    const runner = ops.createRunner();
    await runner.run(dir, 'rebaseContinue', []);
    h.write(dir, 'x.txt', '2\n');
    h.git(dir, 'add', 'x.txt');
    assert.equal((await runner.run(dir, 'rebaseContinue', [])).status, 'done');
    assert.deepEqual(subjects(dir, 'main..feat'), ['c2', 'three, reworded', 'c1']);
  });

  test('edit stop: stopped with stop edit, commit and amend allowed, continue finishes', async () => {
    const { dir, c, tip } = setup(3);
    const { res } = await ri(dir, T(['pick', c[0]], ['edit', c[1]], ['pick', c[2]]));
    assert.equal(res.status, 'stopped');
    assert.equal(res.state.stop, 'edit');
    assert.deepEqual(res.state.current, { cmd: 'edit', sha: c[1], subject: 'c2' });
    assert.equal((await g.status(dir)).rebase.stop, 'edit');
    const runner = ops.createRunner();
    // Amend the stopped commit (a change and a new message), then add a commit after it.
    h.write(dir, 'f2.txt', '2 amended\n');
    h.git(dir, 'add', 'f2.txt');
    const amended = await runner.run(dir, 'commit', ['c2 amended', { amend: true }]);
    assert.equal(amended.summary, 'c2 amended');
    h.write(dir, 'extra.txt', 'e\n');
    h.git(dir, 'add', 'extra.txt');
    await runner.run(dir, 'commit', ['extra']);
    const fin = await runner.run(dir, 'rebaseContinue', []);
    assert.equal(fin.status, 'done');
    assert.equal(fin.before, tip);
    assert.deepEqual(subjects(dir, 'main..feat'), ['c3', 'extra', 'c2 amended', 'c1']);
    assert.deepEqual(authors(dir, 'feat~2^!'), [BOB]); // the amend kept the author
    assert.equal(h.read(dir, 'f2.txt'), '2 amended\n');
  });

  test('edit stop, continue with staged changes: they are amended into the stopped commit', async () => {
    const { dir, c } = setup(2);
    await ri(dir, T(['edit', c[0]], ['pick', c[1]]));
    h.write(dir, 'f1.txt', '1 more\n');
    h.git(dir, 'add', 'f1.txt');
    const fin = await ops.createRunner().run(dir, 'rebaseContinue', []);
    assert.equal(fin.status, 'done');
    assert.deepEqual(subjects(dir, 'main..feat'), ['c2', 'c1']);
    assert.equal(h.git(dir, 'show', 'feat~1:f1.txt'), '1 more\n');
  });

  test('a commit-msg hook rejects the reworded message: stopped (hook), fixed, continue finishes', async () => {
    const { dir, c } = setup(3);
    const hook = path.join(dir, '.git', 'hooks', 'commit-msg');
    const flag = path.join(dir, '.git', 'reject-messages');
    fs.writeFileSync(flag, '');
    fs.writeFileSync(hook, `#!/bin/sh\nif [ -e '${flag}' ]; then echo "commit-msg says no" >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 });
    const { res } = await ri(dir, T(['pick', c[0]], ['reword', c[1]], ['pick', c[2]]), { messages: { [c[1]]: 'c2 reworded' } });
    assert.equal(res.status, 'stopped');
    assert.equal(res.state.stop, 'hook');
    assert.match(res.hookOutput, /commit-msg says no/);
    assert.match(res.state.hookOutput, /commit-msg says no/);
    fs.rmSync(flag);
    const fin = await ops.createRunner().run(dir, 'rebaseContinue', []);
    assert.equal(fin.status, 'done');
    assert.deepEqual(subjects(dir, 'main..feat'), ['c3', 'c2 reworded', 'c1']);
  });

  test('the hook still refusing at continue: a new hook stop; then abort restores', async () => {
    const { dir, c, tip } = setup(2);
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "still no" >&2\nexit 1\n', { mode: 0o755 });
    const { res } = await ri(dir, T(['reword', c[0]], ['pick', c[1]]), { messages: { [c[0]]: 'c1 reworded' } });
    assert.equal(res.state.stop, 'hook');
    const runner = ops.createRunner();
    const again = await runner.run(dir, 'rebaseContinue', []);
    assert.equal(again.status, 'stopped');
    assert.equal(again.state.stop, 'hook');
    assert.match(again.hookOutput, /still no/);
    assert.equal((await runner.run(dir, 'rebaseAbort', [])).status, 'aborted');
    assert.equal(head(dir), tip);
  });

  test('git runs no commit-msg hook for a squash group\'s message (unlike a reword): the message is used', async () => {
    const { dir, c } = setup(3);
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "no squashes" >&2\nexit 1\n', { mode: 0o755 });
    const { res } = await ri(dir, T(['pick', c[0]], ['squash', c[1]], ['pick', c[2]]), { messages: { [c[1]]: 'one and two' } });
    assert.equal(res.status, 'done');
    assert.deepEqual(subjects(dir, 'main..feat'), ['c3', 'one and two']);
  });

  test('a pre-rebase hook refusing: hook-failed, nothing changed, the autostash back', async () => {
    const { dir, c, tip } = setup(2);
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-rebase'), '#!/bin/sh\necho "not today" >&2\nexit 1\n', { mode: 0o755 });
    h.write(dir, 'x.txt', 'dirty\n');
    await assert.rejects(ri(dir, T(['pick', c[1]], ['pick', c[0]])), (e) => e.kind === 'hook-failed' && /not today/.test(e.message));
    assert.equal(head(dir), tip);
    assert.equal(h.read(dir, 'x.txt'), 'dirty\n');
    assert.equal(h.git(dir, 'stash', 'list').trim(), '');
    assert.equal(exists(dir, '.git/rebase-merge'), false);
    assert.equal(exists(dir, '.git/pasta-lite/rebase'), false);
  });
});

describe('validation refusals: nothing runs', () => {
  /** Expect `rebaseInteractive(args)` refused with `kind` (message `re`), no events, nothing touched. */
  async function refused(dir, args, kind, re) {
    const runner = ops.createRunner();
    const events = [];
    runner.on('busy', (e) => events.push(e));
    const before = head(dir);
    await assert.rejects(runner.run(dir, 'rebaseInteractive', args), (e) => {
      assert.equal(e.kind, kind, `${e.kind}: ${e.message}`);
      if (re) assert.match(e.message, re);
      return true;
    });
    assert.deepEqual(events, []);
    assert.equal(head(dir), before);
    assert.equal(exists(dir, '.git/rebase-merge'), false);
    assert.equal(exists(dir, '.git/pasta-lite'), false);
  }

  const shared = setup(3);
  const { dir, c } = shared;
  const up = { upstream: 'main' };
  const okTodo = () => T(['pick', c[1]], ['pick', c[0]], ['pick', c[2]]);

  test('forbidden and unknown commands: exec, break, label, reset, merge, update-ref, abbreviations, odd strings', async () => {
    for (const action of ['exec', 'break', 'label', 'reset', 'merge', 'update-ref', 'x', 'b', 'p', 'noop', 'Pick', 'pick ', 'pick\nexec', 'fixup -C', '', 7, null]) {
      const todo = okTodo();
      todo[1] = { action, sha: c[0] };
      await refused(dir, [up, todo], 'invalid-args', /Unsupported rebase command|entry/);
    }
    const todo = okTodo();
    todo[1] = { action: 'exec', sha: c[0] };
    await refused(dir, [up, todo], 'invalid-args', /Unsupported rebase command 'exec'/);
  });

  test('injection attempts through the sha or extra fields', async () => {
    const marker = path.join(h.tmpDir(), 'pwned');
    const bad = [
      { action: 'pick', sha: `${c[0]}\nexec touch ${marker}` },
      { action: 'pick', sha: `${c[0]} # x` },
      { action: 'pick', sha: `exec touch ${marker}` },
      { action: 'pick', sha: c[0], cmd: 'exec' },
      { action: 'pick', sha: c[0], ref: 'refs/heads/x' },
      { action: 'pick', sha: c[0], __proto__: { exec: 1 } },
      Object.assign(Object.create({ action: 'exec' }), { sha: c[0] }),
      'exec touch x',
      [c[0]],
      null,
    ];
    for (const entry of bad) {
      const todo = okTodo();
      todo[1] = entry;
      await refused(dir, [up, todo], 'invalid-args');
    }
    const proto = JSON.parse(`{"action":"pick","sha":"${c[0]}","__proto__":{"action":"exec"}}`);
    const todo = okTodo();
    todo[1] = proto;
    await refused(dir, [up, todo], 'invalid-args');
    assert.equal(fs.existsSync(marker), false);
  });

  test('shas: short, outside the range, duplicate, missing, non-hex; list shapes', async () => {
    await refused(dir, [up, T(['pick', c[1].slice(0, 7)], ['pick', c[0]], ['pick', c[2]])], 'invalid-args', /full object id/);
    await refused(dir, [up, T(['pick', c[1].toUpperCase()], ['pick', c[0]], ['pick', c[2]])], 'invalid-args');
    await refused(dir, [up, T(['pick', shared.base], ['pick', c[0]], ['pick', c[2]])], 'invalid-todo', /not one of the commits/);
    await refused(dir, [up, T(['pick', 'f'.repeat(40)], ['pick', c[0]], ['pick', c[2]])], 'invalid-todo', /not one of the commits/);
    await refused(dir, [up, T(['pick', c[1]], ['pick', c[1]], ['pick', c[0]], ['pick', c[2]])], 'invalid-todo', /more than once/);
    await refused(dir, [up, T(['pick', c[1]], ['drop', c[1]], ['pick', c[0]], ['pick', c[2]])], 'invalid-todo', /more than once/);
    await refused(dir, [up, T(['pick', c[1]], ['pick', c[0]])], 'invalid-todo', /leaves out 1 commit/);
    await refused(dir, [up, []], 'invalid-args');
    await refused(dir, [up, 'pick x'], 'invalid-args');
    await refused(dir, [up, { 0: { action: 'pick', sha: c[0] }, length: 1 }], 'invalid-args');
    await refused(dir, [up, Array.from({ length: 501 }, () => ({ action: 'pick', sha: c[0] }))], 'invalid-args', /at most 500/);
  });

  test('squash / fixup first (also after drops), and nothing to change', async () => {
    await refused(dir, [up, T(['squash', c[0]], ['pick', c[1]], ['pick', c[2]]), { messages: { [c[0]]: 'm' } }], 'invalid-todo', /oldest commit can't be squashed/);
    await refused(dir, [up, T(['fixup', c[0]], ['pick', c[1]], ['pick', c[2]])], 'invalid-todo', /oldest commit/);
    await refused(dir, [up, T(['drop', c[0]], ['fixup', c[1]], ['pick', c[2]])], 'invalid-todo', /oldest commit/);
    await refused(dir, [up, T(['pick', c[0]], ['pick', c[1]], ['pick', c[2]])], 'nothing', /Nothing to change/);
  });

  test('messages: missing, blank, NUL, 64KB+, wrong keys, not an object', async () => {
    const reword = T(['pick', c[0]], ['reword', c[1]], ['pick', c[2]]);
    const squash = T(['pick', c[0]], ['squash', c[1]], ['pick', c[2]]);
    await refused(dir, [up, reword], 'empty-message', /needs a message/);
    await refused(dir, [up, reword, { messages: {} }], 'empty-message');
    await refused(dir, [up, squash, { messages: {} }], 'empty-message');
    await refused(dir, [up, squash, { messages: { [c[0]]: 'on the head' } }], 'invalid-args', /neither reworded nor the last commit of a squash/);
    await refused(dir, [up, reword, { messages: { [c[1]]: '  \n\t' } }], 'empty-message');
    await refused(dir, [up, reword, { messages: { [c[1]]: 'a\0b' } }], 'invalid-args', /NUL/);
    await refused(dir, [up, reword, { messages: { [c[1]]: 'x'.repeat(64 * 1024 + 1) } }], 'invalid-args', /65536 bytes/);
    await refused(dir, [up, reword, { messages: { [c[1]]: 'é'.repeat(32 * 1024 + 1) } }], 'invalid-args'); // bytes, not chars
    await refused(dir, [up, reword, { messages: { [c[1]]: 42 } }], 'invalid-args');
    await refused(dir, [up, reword, { messages: { [c[1].slice(0, 7)]: 'short key' } }], 'invalid-args');
    await refused(dir, [up, reword, { messages: { [c[1]]: 'ok', [c[2]]: 'a pick' } }], 'invalid-args');
    await refused(dir, [up, reword, { messages: JSON.parse(`{"${c[1]}":"ok","__proto__":{"x":1}}`) }], 'invalid-args');
    await refused(dir, [up, reword, { messages: [c[1]] }], 'invalid-args');
    await refused(dir, [up, reword, { messages: 'text' }], 'invalid-args');
    // A fixup-only group takes no message.
    await refused(dir, [up, T(['pick', c[0]], ['fixup', c[1]], ['pick', c[2]]), { messages: { [c[1]]: 'x' } }], 'invalid-args');
  });

  test('range and options: bad targets, stale expectHead, updateRefs, autostash off with changes', async () => {
    await refused(dir, [{}, okTodo()], 'invalid-args');
    await refused(dir, [{ upstream: 'main..feat' }, okTodo()], 'invalid-args');
    await refused(dir, [{ upstream: '--exec=touch x' }, okTodo()], 'invalid-args');
    await refused(dir, [{ upstream: 'main', onto: 'nope' }, okTodo()], 'invalid-args');
    await refused(dir, ['main', okTodo()], 'invalid-args');
    await refused(dir, [up, okTodo(), { expectHead: shared.base }], 'stale', /moved/);
    await refused(dir, [up, okTodo(), { expectHead: 'HEAD' }], 'invalid-args');
    await refused(dir, [up, okTodo(), { updateRefs: true }], 'invalid-args', /not yet supported/);
    await refused(dir, [up, okTodo(), { updateRefs: 'yes' }], 'invalid-args');
    await refused(dir, [up, okTodo(), { autostash: 'no' }], 'invalid-args');
    await refused(dir, [up, okTodo(), 'opts'], 'invalid-args');
    h.write(dir, 'x.txt', 'dirty\n');
    await refused(dir, [up, okTodo(), { autostash: false }], 'dirty');
    h.git(dir, 'checkout', '--', 'x.txt');
  });

  test('a range with a merge commit or the root commit; too many commits; an empty range', async () => {
    const m = setup(2);
    h.git(m.dir, 'checkout', '-q', '-b', 'side', m.c[0]);
    const s = commitAs(m.dir, 's.txt', 's\n', 'side');
    h.git(m.dir, 'checkout', '-q', 'feat');
    h.git(m.dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    const mplan = await ops.OPS.rebasePlan(m.dir, { upstream: 'main' });
    assert.equal(mplan.interactiveRefusal.kind, 'merge-commits');
    const todo = mplan.commits.map((x) => ({ action: 'pick', sha: x.sha })).reverse();
    await refused(m.dir, [up, todo], 'merge-commits');
    await assert.rejects(ops.OPS.rebasePlan(m.dir, { upstream: 'main', interactive: true }), (e) => {
      assert.equal(e.kind, 'merge-commits');
      assert.equal(e.plan.commits.length, 4); // still returned for the message
      assert.deepEqual(ops.serializeError(e).plan.commits.map((x) => x.sha), mplan.commits.map((x) => x.sha));
      return true;
    });
    assert.ok(mplan.commits.some((x) => x.sha === s));

    // The root: rebasing onto an unrelated history includes this branch's first commit.
    const r = setup(1);
    h.git(r.dir, 'checkout', '-q', '--orphan', 'other');
    h.git(r.dir, 'rm', '-rfq', '.');
    commitAs(r.dir, 'o.txt', 'o\n', 'other root');
    h.git(r.dir, 'checkout', '-q', 'feat');
    const rplan = await ops.OPS.rebasePlan(r.dir, { upstream: 'other' });
    assert.equal(rplan.interactiveRefusal.kind, 'root-commit');
    await refused(r.dir, [{ upstream: 'other' }, rplan.commits.map((x) => ({ action: 'drop', sha: x.sha }))], 'root-commit');
    await assert.rejects(ops.OPS.rebasePlan(r.dir, { upstream: 'other', interactive: true }), { kind: 'root-commit' });

    // Nothing in the range (HEAD is main's commit).
    const e = setup(1);
    await refused(e.dir, [{ upstream: 'feat' }, T(['pick', e.c[0]])], 'nothing', /no commits to rebase/);
    await assert.rejects(ops.OPS.rebasePlan(e.dir, { upstream: 'feat', interactive: true }), { kind: 'nothing' });
    // A plain (non-interactive) plan is never refused.
    assert.equal((await ops.OPS.rebasePlan(m.dir, { upstream: 'main' })).hasMerges, true);
  });

  test('too many commits (> 500): too-many for the interactive plan, a plain plan is fine', async () => {
    const t = h.initRepo();
    h.hostileConfig(t);
    h.git(t, 'checkout', '-q', '-b', 'feat');
    let script = '';
    for (let i = 1; i <= 501; i++) {
      script += `commit refs/heads/feat\ncommitter T <t@x> ${1700000000 + i} +0000\ndata 3\nc${String(i % 10)}\n`;
      script += i === 1 ? 'from refs/heads/main\n' : '';
      script += `M 100644 inline n${i}.txt\ndata 2\n${i % 10}\n\n`;
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: t, input: script, stdio: ['pipe', 'pipe', 'pipe'] });
    h.git(t, 'reset', '-q', '--hard', 'feat');
    const p = await ops.OPS.rebasePlan(t, { upstream: 'main' });
    assert.equal(p.truncated, true);
    assert.equal(p.commits.length, 500);
    assert.equal(p.interactiveRefusal.kind, 'too-many');
    await assert.rejects(ops.OPS.rebasePlan(t, { upstream: 'main', interactive: true }), { kind: 'too-many' });
    await refused(t, [{ upstream: 'main' }, p.commits.map((x) => ({ action: 'pick', sha: x.sha })).reverse()], 'too-many');
  });

  test('in-progress: a rebase already stopped refuses a new start', async () => {
    const x = setup(2);
    await ri(x.dir, T(['edit', x.c[0]], ['pick', x.c[1]]));
    await assert.rejects(ri(x.dir, T(['pick', x.c[1]], ['pick', x.c[0]])), (e) => e.kind === 'in-progress' && e.state === 'rebasing');
    await ops.createRunner().run(x.dir, 'rebaseAbort', []);
  });

  test('a symlinked .git/pasta-lite: refused (kind symlink), nothing ran', async () => {
    const x = setup(2);
    const elsewhere = h.tmpDir();
    fs.symlinkSync(elsewhere, path.join(x.dir, '.git', 'pasta-lite'));
    await assert.rejects(ri(x.dir, T(['pick', x.c[1]], ['pick', x.c[0]])), { kind: 'symlink' });
    assert.equal(head(x.dir), x.tip);
    assert.equal(exists(x.dir, '.git/rebase-merge'), false);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  test('validator fuzz (seeded): random todos never start anything', async () => {
    const rnd = rng(0xC0FFEE);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const actions = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop', 'exec', 'break', 'label', 'reset', 'merge', 'update-ref', 'x', '\0', 'pické', '__proto__'];
    const shas = [...c, shared.base, c[0].slice(0, 12), `${c[0]}\n`, 'HEAD', '', null, 3, '0'.repeat(64)];
    for (let i = 0; i < 40; i++) {
      const n = 1 + Math.floor(rnd() * 5);
      const todo = Array.from({ length: n }, () => (rnd() < 0.1 ? pick(['x', 1, null, [], { action: 'pick' }]) : { action: pick(actions), sha: pick(shas) }));
      // Only a todo that happens to be valid may run; skip those (the other tests cover them).
      const valid = todo.length === 3 && new Set(todo.map((e) => e && e.sha)).size === 3
        && todo.every((e) => e && rebase.TODO_ACTIONS.includes(e.action) && c.includes(e.sha));
      if (valid) continue;
      const runner = ops.createRunner();
      let started = false;
      runner.on('busy', () => { started = true; });
      await assert.rejects(runner.run(dir, 'rebaseInteractive', [up, todo, { messages: rnd() < 0.5 ? { [pick(c)]: pick(['m', '', 'a\0']) } : undefined }]), (e) => (
        ['invalid-args', 'invalid-todo', 'empty-message', 'nothing'].includes(e.kind)
      ));
      assert.equal(started, false);
    }
    assert.equal(exists(dir, '.git/rebase-merge'), false);
  });
});

describe('the todo git (or the helper) refuses', () => {
  test('a sha git can\'t find (a stale plan): the half-started rebase is aborted, invalid-todo, autostash back', async () => {
    const { dir, base, c, tip } = setup(2);
    h.write(dir, 'x.txt', 'dirty\n');
    const ghost = 'e'.repeat(40);
    await assert.rejects(rebase.startInteractive(dir, { upstream: base, todo: [{ cmd: 'pick', sha: ghost }, { cmd: 'pick', sha: c[1] }, { cmd: 'pick', sha: c[0] }] }), (e) => {
      assert.equal(e.kind, 'invalid-todo');
      return true;
    });
    assert.equal(head(dir), tip);
    assert.equal((await g.status(dir)).state, 'clean');
    assert.equal(exists(dir, '.git/rebase-merge'), false);
    assert.equal(exists(dir, '.git/pasta-lite/rebase'), false);
    assert.equal(h.read(dir, 'x.txt'), 'dirty\n');
    assert.equal(h.git(dir, 'stash', 'list').trim(), '');
  });

  test('a todo missing a commit is refused by git too (missingCommitsCheck=error despite the config)', async () => {
    const { dir, base, c, tip } = setup(3);
    await assert.rejects(rebase.startInteractive(dir, { upstream: base, todo: [{ cmd: 'pick', sha: c[1] }, { cmd: 'pick', sha: c[0] }] }), { kind: 'invalid-todo' });
    assert.equal(head(dir), tip);
    assert.equal(exists(dir, '.git/rebase-merge'), false);
  });

  test('startInteractive re-checks its input (exec never written) and the head', async () => {
    const { dir, base, c } = setup(2);
    await assert.rejects(rebase.startInteractive(dir, { upstream: base, todo: [{ cmd: 'exec', sha: c[0] }] }), { kind: 'invalid-args' });
    await assert.rejects(rebase.startInteractive(dir, { upstream: base, todo: [{ cmd: 'pick', sha: 'abc' }] }), { kind: 'invalid-args' });
    await assert.rejects(rebase.startInteractive(dir, { upstream: base, todo: [{ cmd: 'pick', sha: c[0] }], messages: { [c[0]]: 'a\0' } }), { kind: 'invalid-args' });
    await assert.rejects(rebase.startInteractive(dir, { upstream: base, todo: [{ cmd: 'drop', sha: c[0] }, { cmd: 'drop', sha: c[1] }], head: base }), { kind: 'stale' });
    assert.equal(exists(dir, '.git/pasta-lite/rebase'), false);
  });
});

// ---------------------------------------------------------------- property tests (§9.5)

/** mulberry32: a small seeded PRNG in [0, 1). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(a, rnd) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

const patchIds = (dir, range) => {
  const log = h.git(dir, 'log', '--reverse', '-p', '--format=commit %H', range);
  if (!log.trim()) return [];
  return execFileSync('git', ['patch-id', '--stable'], { cwd: dir, input: log, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map((l) => l.split(' ')[0]);
};

describe('property tests (seeded)', () => {
  const SEED = 20260925;
  const ITERATIONS = 12;

  test(`todo vs cherry-pick: a random pick/drop/reorder equals cherry-picking in that order (seed ${SEED}, ${ITERATIONS} runs)`, async () => {
    const rnd = rng(SEED);
    const { dir, base, c, tip } = setup(8);
    let ran = 0;
    for (let it = 0; it < ITERATIONS; it++) {
      const n = 5 + Math.floor(rnd() * 4); // rebase the newest n of the 8 commits
      const range = c.slice(c.length - n);
      const upstream = rev(dir, `${tip}~${n}`);
      const todo = shuffle(range, rnd).map((sha) => ({ action: rnd() < 0.25 ? 'drop' : 'pick', sha }));
      const unchanged = todo.every((e, i) => e.action === 'pick' && e.sha === range[i]);
      if (unchanged) todo[0].action = 'drop';
      const kept = todo.filter((e) => e.action === 'pick').map((e) => e.sha);
      try {
        const { res } = await ri(dir, todo, {}, { upstream });
        assert.equal(res.status, 'done');
        const got = { subjects: subjects(dir, `${upstream}..feat`), ids: patchIds(dir, `${upstream}..feat`), tree: tree(dir) };
        // The same commits cherry-picked in order onto the base.
        h.git(dir, 'checkout', '-q', '--detach', upstream);
        if (kept.length) h.git(dir, 'cherry-pick', '--allow-empty', ...kept);
        const want = { subjects: subjects(dir, `${upstream}..HEAD`), ids: patchIds(dir, `${upstream}..HEAD`), tree: tree(dir) };
        assert.deepEqual(got, want);
        assert.equal(got.subjects.length, kept.length);
        ran++;
      } catch (err) {
        err.message = `seed ${SEED}, iteration ${it}: ${err.message}`;
        throw err;
      } finally {
        h.git(dir, 'checkout', '-q', '-f', 'feat');
        h.git(dir, 'reset', '-q', '--hard', tip);
      }
    }
    assert.equal(ran, ITERATIONS);
    assert.equal(rev(dir, 'main'), base);
  });

  test(`squash algebra: random squash / fixup groups keep the tree, one commit per group, the messages given (seed ${SEED})`, async () => {
    const rnd = rng(SEED + 1);
    const { dir, base, c, tip } = setup(6);
    const want = tree(dir, tip);
    for (let it = 0; it < 6; it++) {
      const order = shuffle(c, rnd);
      const todo = order.map((sha, i) => ({ action: i === 0 ? 'pick' : pick3(rnd), sha }));
      if (todo.every((e) => e.action === 'pick')) todo[1].action = 'squash';
      const groups = rebase.todoGroups(todo.map((e) => ({ cmd: e.action, sha: e.sha })));
      const messages = {};
      for (const gr of groups) if (gr.squash) messages[gr.members[gr.members.length - 1]] = `group of ${gr.head.slice(0, 7)}\n\nsquashed ${gr.members.length}`;
      try {
        const { res } = await ri(dir, todo, { messages });
        assert.equal(res.status, 'done');
        assert.equal(tree(dir), want);
        const got = h.git(dir, 'log', '--reverse', '--format=%B%x00', `${base}..feat`).split('\0\n').map((m) => m.replace(/\n+$/, '')).filter(Boolean);
        const expected = groups.map((gr) => (gr.squash ? messages[gr.members[gr.members.length - 1]] : `c${c.indexOf(gr.head) + 1}`));
        assert.deepEqual(got, expected);
      } catch (err) {
        err.message = `seed ${SEED + 1}, iteration ${it}: ${err.message}`;
        throw err;
      } finally {
        h.git(dir, 'reset', '-q', '--hard', tip);
      }
    }
  });
});

function pick3(rnd) {
  const x = rnd();
  return x < 0.4 ? 'pick' : x < 0.7 ? 'squash' : 'fixup';
}
