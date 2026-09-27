'use strict';
// The hooks git runs for us: whether one exists (hasHook: in the folder git uses, executable), whether
// a failed command was a hook's refusal (hookRefused), and the hook output an error carries
// (hookOutput). Used by commit (git.js), rebase starts and stops (rebase.js) and merges (merge.js).
const fs = require('node:fs');
const path = require('node:path');
const { tryOut } = require('./exec');
const { resolveRoot } = require('./repo-dirs');
const gitErrors = require('./git-errors');

/** Max chars of hook output kept in a 'hook-failed' error message (the tail is kept). */
const HOOK_OUTPUT_MAX = 4000;
const COMMIT_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg'];

/** True when any hook `git commit` runs before committing exists and is executable. */
const hasCommitHook = (cwd) => hasHook(cwd, ...COMMIT_HOOKS);

/** True when any of the hooks `names` exists (in the hooks folder git uses) and is executable. */
async function hasHook(cwd, ...names) {
  const raw = await tryOut(cwd, ['rev-parse', ...names.flatMap((h) => ['--git-path', `hooks/${h}`])]);
  const root = await resolveRoot(cwd);
  return (raw || '').split('\n').filter(Boolean).some((p) => {
    try {
      fs.accessSync(path.resolve(root, p), fs.constants.X_OK);
      return fs.statSync(path.resolve(root, p)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * True when the failed command `err` (one that runs `hooks`) was refused by a hook: git's text
 * names no other reason (gitErrors.failureKind: a signing failure, files in the way) and one of
 * the hooks exists and is executable. Hook output has no marker of its own, so this is how every
 * caller (commit, a rebase start, a rebase or merge stop) tells a hook's refusal apart.
 */
const hookRefused = async (cwd, err, hooks) => gitErrors.failureKind(err) === null && hasHook(cwd, ...hooks);

/** Hook output for an error message: trimmed, at most HOOK_OUTPUT_MAX chars (the tail). */
function hookOutput(text) {
  const t = String(text || '').trim();
  if (!t) return 'A commit hook failed (no output)';
  return t.length > HOOK_OUTPUT_MAX ? `…\n${t.slice(-HOOK_OUTPUT_MAX).replace(/^[^\n]*\n/, '')}` : t;
}

module.exports = { HOOK_OUTPUT_MAX, COMMIT_HOOKS, hasHook, hasCommitHook, hookRefused, hookOutput };
