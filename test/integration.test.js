'use strict';
// Cross-module flows: the way the app's operation layer will combine git, hunks, undo and graph.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const git = require('../src/git');
const hunks = require('../src/hunks');
const undo = require('../src/undo');
const { layout } = require('../renderer/graph');

test('delete branch -> record -> undo recreates it -> redo deletes again', async () => {
  const dir = h.initRepo();
  await git.createBranch(dir, 'feat/x');
  const info = await git.deleteBranch(dir, 'feat/x');
  await undo.recordBranchDelete(dir, info);
  assert.equal((await undo.getState(dir)).undo.action, 'delete_branch');
  await undo.undo(dir);
  assert.equal(h.git(dir, 'rev-parse', 'feat/x').trim(), info.sha);
  await undo.redo(dir);
  assert.ok(!(await git.refs(dir)).local.some((b) => b.name === 'feat/x'));
});

test('git.discard wrapped in withDiscardBackup is undoable', async () => {
  const dir = h.initRepo();
  h.write(dir, 'README.md', 'changed\n');
  h.write(dir, 'new file.txt', 'untracked\n');
  const st = await git.status(dir);
  const { backup } = await undo.withDiscardBackup(dir, st.unstaged.map((f) => f.path), () => git.discard(dir, st.unstaged));
  assert.ok(backup);
  assert.equal((await git.status(dir)).unstaged.length, 0);
  await undo.undo(dir);
  assert.equal(h.read(dir, 'README.md'), 'changed\n');
  assert.equal(h.read(dir, 'new file.txt'), 'untracked\n');
});

test('stash round-trip does not block undo of the previous commit', async () => {
  const dir = h.initRepo();
  h.write(dir, 'a.txt', 'a\n');
  await git.stageAll(dir);
  await git.commit(dir, 'add a');
  h.write(dir, 'a.txt', 'dirty\n');
  await git.stashPush(dir, 'wip');
  await git.stashPop(dir, 0);
  const s = await undo.getState(dir);
  assert.equal(s.undo && s.undo.action, 'commit');
  await undo.undo(dir);
  assert.deepEqual((await git.status(dir)).staged.map((f) => f.path), ['a.txt']);
});

test('checkout with autostash is undoable and keeps local changes', async () => {
  const dir = h.initRepo();
  await git.createBranch(dir, 'other');
  h.commitFile(dir, 'README.md', 'main v2\n');
  await git.checkout(dir, 'other');
  h.write(dir, 'scratch.txt', 'keep me\n');
  await git.checkout(dir, 'main');
  assert.equal(h.read(dir, 'scratch.txt'), 'keep me\n');
  const s = await undo.getState(dir);
  assert.equal(s.undo && s.undo.action, 'checkout');
  await undo.undo(dir);
  assert.equal((await git.status(dir)).branch, 'other');
  assert.equal(h.read(dir, 'scratch.txt'), 'keep me\n');
});

test('stage one hunk via hunks, commit via git, undo leaves it staged', async () => {
  const dir = h.initRepo({ commits: false });
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  h.commitFile(dir, 'f.txt', lines.join('\n') + '\n', 'base');
  const edited = [...lines];
  edited[1] = 'CHANGED 1';
  edited[18] = 'CHANGED 18';
  h.write(dir, 'f.txt', edited.join('\n') + '\n');
  const [file] = hunks.parsePatch(await git.diffWorkdir(dir, 'f.txt'));
  assert.equal(file.hunks.length, 2);
  await hunks.stageSelection(dir, 'f.txt', [{ hunk: 0 }]);
  const sha = await git.commit(dir, 'first hunk');
  assert.match(h.git(dir, 'show', sha, '--format='), /CHANGED 1\b/);
  assert.doesNotMatch(h.git(dir, 'show', sha, '--format='), /CHANGED 18/);
  await undo.undo(dir);
  assert.match(h.git(dir, 'diff', '--cached'), /CHANGED 1\b/);
  assert.match(h.git(dir, 'diff'), /CHANGED 18/);
});

test('git.log output feeds graph.layout (branch + merge)', async () => {
  const dir = h.initRepo();
  await git.createBranch(dir, 'side', { checkout: true });
  h.commitFile(dir, 's.txt', 's\n', 'side work');
  await git.checkout(dir, 'main');
  h.commitFile(dir, 'm.txt', 'm\n', 'main work');
  h.git(dir, 'merge', '--no-ff', '-q', '-m', 'merge side', 'side');
  const { commits, hasMore } = await git.log(dir);
  assert.equal(hasMore, false);
  const g = layout(commits);
  assert.equal(g.rows.length, 4);
  assert.equal(g.width, 2);
  assert.ok(g.rows[0].isMerge);
  assert.equal(g.rows.at(-1).column, 0);
});

test('push -> pull round trip between two clones', async () => {
  const { remote, local } = h.repoWithRemote();
  const other = h.tmpDir();
  h.git(other, 'clone', '-q', remote, '.');
  h.commitFile(local, 'x.txt', 'x\n', 'from local');
  await git.push(local);
  const res = await git.pull(other, { mode: 'ff-only' });
  assert.equal(res.fastForward, true);
  assert.equal(h.read(other, 'x.txt'), 'x\n');
  assert.ok(fs.existsSync(path.join(other, 'x.txt')));
});

test('hunk discard via hunks.discardSelection wrapped in withDiscardBackup: undo then redo is exact', async () => {
  const dir = h.initRepo({ commits: false });
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  h.commitFile(dir, 'f.txt', lines.join('\n') + '\n', 'base');
  const edited = [...lines];
  edited[1] = 'CHANGED 1';
  edited[18] = 'CHANGED 18';
  h.write(dir, 'f.txt', edited.join('\n') + '\n');
  const [file] = hunks.parsePatch(await git.diffWorkdir(dir, 'f.txt'), { encoding: 'latin1' });
  const fp = hunks.fingerprint(file);
  await undo.withDiscardBackup(dir, ['f.txt'], () => hunks.discardSelection(dir, 'f.txt', [{ hunk: 1 }], { fingerprint: fp }));
  const afterDiscard = h.read(dir, 'f.txt');
  assert.match(afterDiscard, /CHANGED 1\b/);
  assert.doesNotMatch(afterDiscard, /CHANGED 18/);
  await undo.undo(dir);
  assert.equal(h.read(dir, 'f.txt'), edited.join('\n') + '\n');
  await undo.redo(dir);
  assert.equal(h.read(dir, 'f.txt'), afterDiscard);
});

test('non-UTF-8 file: git.diffWorkdir fingerprint matches hunks, staging keeps bytes', async () => {
  const dir = h.initRepo();
  const base = Buffer.from('caf\xe9 1\nkeep\nx\ny\nz\nw\nv\nu\nend \xff\n', 'latin1');
  fs.writeFileSync(path.join(dir, 'l1.txt'), base);
  h.git(dir, 'add', 'l1.txt');
  h.git(dir, 'commit', '-q', '-m', 'latin1');
  const edited = Buffer.from(base.toString('latin1').replace('caf\xe9 1', 'caf\xe9 2').replace('end \xff', 'end \xfe'), 'latin1');
  fs.writeFileSync(path.join(dir, 'l1.txt'), edited);
  const [file] = hunks.parsePatch(await git.diffWorkdir(dir, 'l1.txt'), { encoding: 'latin1' });
  assert.equal(file.hunks.length, 2);
  await hunks.stageSelection(dir, 'l1.txt', [{ hunk: 0 }], { fingerprint: hunks.fingerprint(file) });
  const staged = require('node:child_process').execFileSync('git', ['show', ':l1.txt'], { cwd: dir });
  assert.ok(staged.includes(Buffer.from('caf\xe9 2', 'latin1')));
  assert.ok(staged.includes(Buffer.from('end \xff', 'latin1')));
});
