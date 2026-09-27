'use strict';
// The editor git runs during our rebases (docs/plans/rebase.md §3.3). src/rebase.js sets
//   GIT_SEQUENCE_EDITOR='"$PL_NODE" "$PL_REBASE_HELPER" todo'
//   GIT_EDITOR='"$PL_NODE" "$PL_REBASE_HELPER" msg'
// so git runs `sh -c '<that> "$@"' <that> <file>`. The command strings are constants: every path
// reaches this helper through the environment only (PL_GIT_DIR: the absolute git dir,
// PL_REBASE_DIR: <git-dir>/pasta-lite/rebase), never through a command string.
//
//   todo <file>  <file> must be <git-dir>/rebase-merge/git-rebase-todo. It is replaced by
//                $PL_REBASE_DIR/todo, which the backend wrote from validated {cmd, sha} pairs; the
//                helper checks every line against the same allow-list again (no exec, break,
//                label, reset, merge, ever). Exit 1 (git then starts nothing) on any doubt.
//   msg <file>   <file> must be <git-dir>/COMMIT_EDITMSG (also for a squash group's final message:
//                git runs `commit -F rebase-merge/message-squash -e`, which edits COMMIT_EDITMSG;
//                verified with git 2.51). The command git is completing is the
//                last line of <git-dir>/rebase-merge/done ("reword <sha>", a squash group's last
//                "squash"/"fixup", the conflicted "pick"); if $PL_REBASE_DIR/msgs/<sha> exists it
//                is written to <file>, otherwise git's text is left alone (exit 0).
//
// No dependencies, never spawns anything, writes only the one file git named, refuses symlinks.
// It prints no paths or messages (git copies its stderr into errors the app may log).
const fs = require('node:fs');
const path = require('node:path');

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Commands the backend may put in a todo (plus `update-ref refs/heads/<b>`, R5's opt-in). */
const TODO_CMDS = new Set(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']);
const UPDATE_REF = /^update-ref refs\/heads\/[^\s\0\\:?*[~^]+$/;
const MAX_TODO_LINES = 10000;
const MAX_BYTES = 1024 * 1024;
const WIN = process.platform === 'win32';
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0; // not on Windows (lstat checks still apply)

const samePath = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** True when `p` is a real directory (not a symlink to one). */
const isRealDir = (p) => {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  return !!st && st.isDirectory() && !st.isSymbolicLink();
};

/**
 * The absolute path of `file` when it is a regular file (not a symlink) named `base` directly
 * inside the real directory `dir`; otherwise null.
 */
function target(file, dir, base) {
  if (typeof file !== 'string' || !file || !dir) return null;
  const abs = path.resolve(file);
  if (path.basename(abs) !== base) return null;
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null; // lstat: a symlink is never isFile()
  const parent = realpath(path.dirname(abs));
  return parent && samePath(parent, dir) ? abs : null;
}

/** Contents of the regular file `p` (no symlink, at most MAX_BYTES), or null. */
function readSource(p) {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st || !st.isFile() || st.size > MAX_BYTES) return null;
  const fd = fs.openSync(p, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < buf.length) {
      const r = fs.readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
    }
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Overwrite the file git named (already checked by target()), never following a symlink. */
function writeTarget(abs, data) {
  const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_TRUNC | NOFOLLOW);
  try {
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

/** True when `text` is a todo the backend could have written: allow-listed lines only. */
function validTodo(text) {
  if (!text.endsWith('\n')) return false;
  const lines = text.slice(0, -1).split('\n');
  if (!lines.length || lines.length > MAX_TODO_LINES) return false;
  return lines.every((l) => {
    const m = /^([a-z-]+) (\S+)$/.exec(l);
    if (!m) return false;
    if (TODO_CMDS.has(m[1])) return OID.test(m[2]);
    return UPDATE_REF.test(l);
  });
}

/** Paths from the environment, checked: {gitDir, stateDir} (real paths) or null. */
function environment(env) {
  const gitDir = typeof env.PL_GIT_DIR === 'string' && path.isAbsolute(env.PL_GIT_DIR) ? realpath(env.PL_GIT_DIR) : null;
  if (!gitDir) return null;
  const stateDir = typeof env.PL_REBASE_DIR === 'string' ? env.PL_REBASE_DIR : '';
  // PL_REBASE_DIR must be exactly <git-dir>/pasta-lite/rebase, with no symlink on the way.
  const expected = path.join(gitDir, 'pasta-lite', 'rebase');
  if (!stateDir || !samePath(path.resolve(stateDir), expected)) return { gitDir, stateDir: null };
  const ok = isRealDir(path.join(gitDir, 'pasta-lite')) && isRealDir(expected);
  return { gitDir, stateDir: ok ? expected : null };
}

function todoRole(file, env) {
  const paths = environment(env);
  if (!paths) return 'no git dir';
  const todoDir = path.join(paths.gitDir, 'rebase-merge');
  const abs = isRealDir(todoDir) ? target(file, todoDir, 'git-rebase-todo') : null;
  if (!abs) return 'not the rebase todo file';
  if (!paths.stateDir) return 'no rebase state folder';
  const src = readSource(path.join(paths.stateDir, 'todo'));
  if (!src) return 'no todo was prepared';
  const text = src.toString('utf8');
  if (!validTodo(text)) return 'the prepared todo has an unsupported line';
  writeTarget(abs, text);
  return null;
}

/** Full sha of the command git is completing: the last line of rebase-merge/done, or null. */
function currentSha(gitDir) {
  const done = readSource(path.join(gitDir, 'rebase-merge', 'done'));
  if (!done) return null;
  const lines = done.toString('utf8').split('\n').filter((l) => l.trim() && !/^\s*#/.test(l));
  const m = lines.length ? /^\s*\S+\s+([0-9a-f]+)(\s|$)/.exec(lines[lines.length - 1]) : null;
  return m && OID.test(m[1]) ? m[1] : null;
}

function msgRole(file, env) {
  const paths = environment(env);
  if (!paths) return 'no git dir';
  const abs = target(file, paths.gitDir, 'COMMIT_EDITMSG');
  if (!abs) return 'not the commit message file';
  if (!paths.stateDir || !isRealDir(path.join(paths.stateDir, 'msgs'))) return null; // nothing prepared: keep git's text
  const sha = currentSha(paths.gitDir);
  if (!sha) return null;
  const msg = readSource(path.join(paths.stateDir, 'msgs', sha));
  if (!msg) return null;
  if (msg.includes(0)) return 'the prepared message has a NUL byte';
  writeTarget(abs, msg);
  return null;
}

/** Run one role; returns the exit code (0 = git goes on). */
function main(argv, env = process.env, stderr = process.stderr) {
  const [role, file] = argv;
  let why;
  try {
    if (argv.length !== 2) why = 'usage: todo|msg <file>';
    else if (role === 'todo') why = todoRole(file, env);
    else if (role === 'msg') why = msgRole(file, env);
    else why = 'unknown role';
  } catch (err) {
    why = `failed (${err && err.code ? err.code : 'error'})`;
  }
  if (!why) return 0;
  stderr.write(`pasta-lite rebase helper: refused: ${why}\n`);
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, validTodo };
