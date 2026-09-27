'use strict';
// The editor helper git runs during our rebases (src/rebase-editor.js, docs/plans/rebase.md §3.3):
// its todo and msg roles, the checks on the file git names and on the prepared files, and a real
// interactive rebase driven through it under hostileConfig (sequence.editor / core.editor = false).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./helpers');
const exec = require('../src/exec');
const rebase = require('../src/rebase');
const rebaseState = require('../src/rebase-state');
const editor = require('../src/rebase-editor');

after(h.cleanup);

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const sink = () => {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
};

/** A fake git dir with rebase-merge/, COMMIT_EDITMSG and our state folder (no git needed). */
function fakeGitDir() {
  const gd = path.join(h.tmpDir(), '.git');
  fs.mkdirSync(path.join(gd, 'rebase-merge'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'rebase-merge', 'git-rebase-todo'), `pick ${A} # original\n`);
  fs.writeFileSync(path.join(gd, 'COMMIT_EDITMSG'), 'git text\n');
  const sd = rebaseState.ensureStateDir(gd);
  return { gd, sd, env: { PL_GIT_DIR: gd, PL_REBASE_DIR: sd }, todo: path.join(gd, 'rebase-merge', 'git-rebase-todo'), msg: path.join(gd, 'COMMIT_EDITMSG') };
}

const run = (argv, env) => {
  const err = sink();
  return { code: editor.main(argv, env, err), stderr: err.text() };
};

describe('validTodo: the allow-list', () => {
  test('accepts the commands the backend writes, with full shas', () => {
    for (const cmd of ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']) assert.ok(editor.validTodo(`${cmd} ${A}\n`), cmd);
    assert.ok(editor.validTodo(`pick ${A}\nsquash ${B}\ndrop ${'c'.repeat(64)}\n`));
    assert.ok(editor.validTodo(`pick ${A}\nupdate-ref refs/heads/stack/a\n`));
  });

  test('refuses everything else', () => {
    const bad = [
      '', '\n', `pick ${A}`, `exec ${A}\n`, 'exec make\n', 'x make\n', 'break\n', `label ${A}\n`, `reset ${A}\n`,
      `merge -C ${A} x\n`, `p ${A}\n`, 'pick abc1234\n', `pick ${A} # subject\n`, `pick ${A}\n\n`, `# pick ${A}\n`,
      `pick  ${A}\n`, `pick ${A}\r\n`, `PICK ${A}\n`, `pick ${A.toUpperCase()}\n`, 'update-ref refs/tags/v1\n',
      'update-ref refs/heads/a b\n', `fixup -C ${A}\n`, `pick ${'a'.repeat(41)}\n`,
    ];
    for (const t of bad) assert.equal(editor.validTodo(t), false, JSON.stringify(t));
  });
});

describe('todo role', () => {
  test('copies the prepared todo over git-rebase-todo', () => {
    const f = fakeGitDir();
    rebaseState.writeStateFile(f.sd, 'todo', `reword ${A}\ndrop ${B}\n`);
    assert.deepEqual(run(['todo', f.todo], f.env), { code: 0, stderr: '' });
    assert.equal(fs.readFileSync(f.todo, 'utf8'), `reword ${A}\ndrop ${B}\n`);
  });

  test('refuses a prepared todo with a line outside the allow-list; the file is untouched', () => {
    const f = fakeGitDir();
    rebaseState.writeStateFile(f.sd, 'todo', `pick ${A}\nexec touch pwned\n`);
    const r = run(['todo', f.todo], f.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /refused/);
    assert.equal(fs.readFileSync(f.todo, 'utf8'), `pick ${A} # original\n`);
  });

  test('refuses files other than <git-dir>/rebase-merge/git-rebase-todo, symlinks and bad env', () => {
    const f = fakeGitDir();
    rebaseState.writeStateFile(f.sd, 'todo', `pick ${A}\n`);
    const elsewhere = path.join(h.tmpDir(), 'git-rebase-todo');
    fs.writeFileSync(elsewhere, 'x\n');
    assert.equal(run(['todo', elsewhere], f.env).code, 1); // outside the git dir
    assert.equal(run(['todo', path.join(f.gd, 'COMMIT_EDITMSG')], f.env).code, 1); // other name
    assert.equal(run(['todo', path.join(f.gd, 'git-rebase-todo')], f.env).code, 1); // not in rebase-merge/
    assert.equal(run(['todo', f.todo], { ...f.env, PL_GIT_DIR: undefined }).code, 1);
    assert.equal(run(['todo', f.todo], { ...f.env, PL_GIT_DIR: 'relative/.git' }).code, 1);
    assert.equal(run(['todo', f.todo], { ...f.env, PL_REBASE_DIR: h.tmpDir() }).code, 1);
    assert.equal(run(['todo'], f.env).code, 1);
    assert.equal(run(['todo', f.todo, 'extra'], f.env).code, 1);
    assert.equal(run(['exec', f.todo], f.env).code, 1);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'x\n');
    // git-rebase-todo is a symlink to a file outside
    fs.rmSync(f.todo);
    fs.symlinkSync(elsewhere, f.todo);
    assert.equal(run(['todo', f.todo], f.env).code, 1);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'x\n');
  });

  test('refuses a symlinked state folder or prepared todo', () => {
    const f = fakeGitDir();
    const outside = h.tmpDir();
    fs.writeFileSync(path.join(outside, 'todo'), `pick ${A}\n`);
    fs.symlinkSync(path.join(outside, 'todo'), path.join(f.sd, 'todo'));
    assert.equal(run(['todo', f.todo], f.env).code, 1);
    // <git-dir>/pasta-lite itself a symlink
    const g2 = fakeGitDir();
    fs.rmSync(path.join(g2.gd, 'pasta-lite'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'rebase'));
    fs.writeFileSync(path.join(outside, 'rebase', 'todo'), `pick ${A}\n`);
    fs.symlinkSync(outside, path.join(g2.gd, 'pasta-lite'));
    assert.equal(run(['todo', g2.todo], g2.env).code, 1);
    assert.equal(fs.readFileSync(g2.todo, 'utf8'), `pick ${A} # original\n`);
    // and the backend refuses to write through it
    assert.throws(() => rebaseState.ensureStateDir(g2.gd), { kind: 'symlink' });
  });

  test('refuses when nothing was prepared', () => {
    const f = fakeGitDir();
    assert.equal(run(['todo', f.todo], f.env).code, 1);
  });
});

describe('msg role', () => {
  test('writes msgs/<sha> of the last done command; leaves git text alone without one', () => {
    const f = fakeGitDir();
    fs.writeFileSync(path.join(f.gd, 'rebase-merge', 'done'), `pick ${B} # b\nreword ${A} # a\n`);
    assert.deepEqual(run(['msg', f.msg], f.env), { code: 0, stderr: '' });
    assert.equal(fs.readFileSync(f.msg, 'utf8'), 'git text\n');
    rebaseState.writeStateFile(path.join(f.sd, 'msgs'), B, 'not this one\n');
    assert.equal(run(['msg', f.msg], f.env).code, 0);
    assert.equal(fs.readFileSync(f.msg, 'utf8'), 'git text\n');
    rebaseState.writeStateFile(path.join(f.sd, 'msgs'), A, 'New subject\n\nbody ü\n');
    assert.equal(run(['msg', f.msg], f.env).code, 0);
    assert.equal(fs.readFileSync(f.msg, 'utf8'), 'New subject\n\nbody ü\n');
  });

  test('a squash group: the message of its last member (the last done line) is written', () => {
    const f = fakeGitDir();
    fs.writeFileSync(path.join(f.gd, 'rebase-merge', 'done'), `pick ${B}\nsquash ${A}\n`);
    rebaseState.writeStateFile(path.join(f.sd, 'msgs'), A, 'Both\n');
    assert.equal(run(['msg', f.msg], f.env).code, 0);
    assert.equal(fs.readFileSync(f.msg, 'utf8'), 'Both\n');
  });

  test('no done file, no state folder: exit 0, text untouched', () => {
    const f = fakeGitDir();
    rebaseState.writeStateFile(path.join(f.sd, 'msgs'), A, 'm\n');
    assert.equal(run(['msg', f.msg], f.env).code, 0);
    fs.rmSync(path.join(f.gd, 'pasta-lite'), { recursive: true });
    fs.writeFileSync(path.join(f.gd, 'rebase-merge', 'done'), `reword ${A}\n`);
    assert.equal(run(['msg', f.msg], f.env).code, 0);
    assert.equal(fs.readFileSync(f.msg, 'utf8'), 'git text\n');
  });

  test('refuses other files and symlinks; skips a symlinked message; refuses a NUL', () => {
    const f = fakeGitDir();
    fs.writeFileSync(path.join(f.gd, 'rebase-merge', 'done'), `reword ${A}\n`);
    const elsewhere = path.join(h.tmpDir(), 'COMMIT_EDITMSG');
    fs.writeFileSync(elsewhere, 'x\n');
    rebaseState.writeStateFile(path.join(f.sd, 'msgs'), A, 'm\n');
    assert.equal(run(['msg', elsewhere], f.env).code, 1);
    assert.equal(run(['msg', path.join(f.gd, 'rebase-merge', 'message')], f.env).code, 1);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'x\n');
    fs.rmSync(f.msg);
    fs.symlinkSync(elsewhere, f.msg);
    assert.equal(run(['msg', f.msg], f.env).code, 1);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'x\n');

    const g2 = fakeGitDir();
    fs.writeFileSync(path.join(g2.gd, 'rebase-merge', 'done'), `reword ${A}\n`);
    const secret = path.join(h.tmpDir(), 'secret');
    fs.writeFileSync(secret, 'secret\n');
    fs.symlinkSync(secret, path.join(g2.sd, 'msgs', A));
    assert.equal(run(['msg', g2.msg], g2.env).code, 0);
    assert.equal(fs.readFileSync(g2.msg, 'utf8'), 'git text\n');
    fs.rmSync(path.join(g2.sd, 'msgs', A));
    fs.writeFileSync(path.join(g2.sd, 'msgs', A), 'a\0b');
    assert.equal(run(['msg', g2.msg], g2.env).code, 1);
  });

  test('writeStateFile refuses a symlink in the way', () => {
    const f = fakeGitDir();
    const outside = path.join(h.tmpDir(), 'target');
    fs.writeFileSync(outside, 'keep\n');
    fs.symlinkSync(outside, path.join(f.sd, 'msgs', A));
    assert.throws(() => rebaseState.writeStateFile(path.join(f.sd, 'msgs'), A, 'm'), { kind: 'symlink' });
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep\n');
    rebaseState.writeStateFile(f.sd, 'meta.json', '{}');
    rebaseState.writeStateFile(f.sd, 'meta.json', '{"a":1}'); // a regular file is replaced
    assert.equal(fs.readFileSync(path.join(f.sd, 'meta.json'), 'utf8'), '{"a":1}');
    assert.equal(fs.statSync(path.join(f.sd, 'meta.json')).mode & 0o777, 0o600);
  });
});

describe('the helper as git runs it', () => {
  test('as a script: exit codes through node', () => {
    const f = fakeGitDir();
    rebaseState.writeStateFile(f.sd, 'todo', `drop ${A}\n`);
    const ok = spawnSync(process.execPath, [rebase.HELPER, 'todo', f.todo], { env: { ...process.env, ...f.env }, encoding: 'utf8' });
    assert.equal(ok.status, 0);
    assert.equal(fs.readFileSync(f.todo, 'utf8'), `drop ${A}\n`);
    const bad = spawnSync(process.execPath, [rebase.HELPER, 'todo', '/etc/passwd'], { env: { ...process.env, ...f.env }, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.doesNotMatch(bad.stderr, /passwd/); // no paths in its output
  });

  /** Repo with base + three commits by the test identity, under hostileConfig. */
  function repo() {
    const dir = h.initRepo();
    h.hostileConfig(dir);
    const base = h.git(dir, 'rev-parse', 'HEAD').trim();
    const c = [1, 2, 3].map((i) => h.commitFile(dir, `f${i}.txt`, `${i}\n`, `c${i}`));
    return { dir, base, c };
  }

  const interactive = async (dir, upstream) => {
    const gd = await exec.gitDir(dir);
    return exec.run(dir, [...rebase.REBASE_CONFIG, ...rebaseState.HASH_COMMENTS, 'rebase', '-i', ...rebase.START_FLAGS.filter((f) => f !== '--merge'), upstream], {
      env: rebase.helperEnv(gd, { todo: true }),
    });
  };

  test('a real interactive rebase: reorder, reword (through msg) and drop, despite sequence.editor=false', async () => {
    const { dir, base, c } = repo();
    const gd = await exec.gitDir(dir);
    const sd = rebaseState.ensureStateDir(gd);
    rebaseState.writeStateFile(sd, 'todo', `pick ${c[2]}\nreword ${c[0]}\ndrop ${c[1]}\n`);
    rebaseState.writeStateFile(path.join(sd, 'msgs'), c[0], 'c1 reworded\n\n# not a comment? it is: stripped\nbody\n');
    await interactive(dir, base);
    assert.equal((await exec.repoState(dir)), 'clean');
    assert.deepEqual(h.git(dir, 'log', '--format=%s', `${base}..HEAD`).trim().split('\n'), ['c1 reworded', 'c3']);
    assert.equal(h.git(dir, 'log', '-1', '--format=%B', 'HEAD'), 'c1 reworded\n\nbody\n\n');
    assert.equal(fs.existsSync(path.join(dir, 'f2.txt')), false);
  });

  test('an exec line in the prepared todo: the helper refuses, git starts nothing', async () => {
    const { dir, base, c } = repo();
    const head = h.git(dir, 'rev-parse', 'HEAD').trim();
    const gd = await exec.gitDir(dir);
    const sd = rebaseState.ensureStateDir(gd);
    const marker = path.join(h.tmpDir(), 'pwned');
    rebaseState.writeStateFile(sd, 'todo', `pick ${c[0]}\nexec touch ${marker}\npick ${c[1]}\npick ${c[2]}\n`);
    await assert.rejects(interactive(dir, base));
    assert.equal(fs.existsSync(marker), false);
    assert.equal(await exec.repoState(dir), 'clean');
    assert.equal(fs.existsSync(path.join(gd, 'rebase-merge')), false);
    assert.equal(h.git(dir, 'rev-parse', 'HEAD').trim(), head);
  });

  test('baseEnv GIT_SEQUENCE_EDITOR=true: a repo sequence.editor never runs', async () => {
    const { dir, base } = repo();
    const marker = path.join(h.tmpDir(), 'ran');
    h.git(dir, 'config', 'sequence.editor', `touch '${marker}'; false`);
    h.git(dir, 'config', 'core.editor', `touch '${marker}'; false`);
    const head = h.git(dir, 'rev-parse', 'HEAD').trim();
    await exec.run(dir, ['rebase', '-i', '--no-autostash', '--no-update-refs', base]);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(h.git(dir, 'rev-parse', 'HEAD').trim(), head); // the todo was kept as is: all picks
  });
});
