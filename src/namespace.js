'use strict';
// The names the app owns inside a repository: our refs, our folder in the git dir and the files
// in it, the stash message and the identity of our internal commits. One place, so that what we
// write and what we look for (status, the watcher, the trust of a stash entry) can't drift.
// src/rebase-editor.js runs as git's editor with no dependencies and keeps its own copies of the
// state-folder names and its refusal marker; test/namespace.test.js pins them to these.

/** <git-dir>/<PL_DIR>: our per-worktree folder in the git dir. */
const PL_DIR = 'pasta-lite';
/** <git-dir>/pasta-lite/<REBASE_DIR>: the state of a rebase we started (src/rebase.js). */
const REBASE_DIR = 'rebase';
/** <git-dir>/pasta-lite/<AUTOSTASH_INTENT>: {id, time} of an autostash being pushed. */
const AUTOSTASH_INTENT = 'autostash-intent';
/** rebase-merge/<OURS_MARKER>: the meta.json id of the rebase we started. */
const OURS_MARKER = 'pasta-lite-id';

/** The ref namespaces we write (a per-worktree one and a shared one). */
const REF_NAMESPACES = Object.freeze(['refs/worktree/pasta-lite/', 'refs/pasta-lite/']);
/** Our autostash (src/autostash.js), per worktree. */
const AUTOSTASH_REF = 'refs/worktree/pasta-lite/autostash';
/** Where versions before kept it (shared by every worktree). */
const LEGACY_AUTOSTASH_REF = 'refs/pasta-lite/autostash';
/** refs/pasta-lite/backups/<after>: keeps a discard backup alive (src/undo.js). */
const BACKUP_REF = 'refs/pasta-lite/backups/';

/** The start of every stash message we write ("pasta-lite autostash before rebase of x [id]"). */
const AUTOSTASH_MSG = 'pasta-lite autostash';
/** Subjects of the two commits of a discard backup. */
const BACKUP_BEFORE_SUBJECT = 'pasta-lite: worktree before discard';
const BACKUP_AFTER_SUBJECT = 'pasta-lite: worktree after discard';
/** The fixed identity of our internal commits (works with no user.name configured). */
const BACKUP_IDENT = Object.freeze({
  GIT_AUTHOR_NAME: 'Pasta Lite',
  GIT_AUTHOR_EMAIL: 'pasta-lite@localhost',
  GIT_COMMITTER_NAME: 'Pasta Lite',
  GIT_COMMITTER_EMAIL: 'pasta-lite@localhost',
});
/** Starts of the HEAD reflog entries undo writes for actions git doesn't log (src/undo.js). */
const REFLOG_DISCARD = 'pasta-lite discard';
const REFLOG_DELETE_BRANCH = 'pasta-lite delete-branch';
/** What the rebase editor helper prints when it refuses (src/rebase-editor.js). */
const HELPER_REFUSED = 'pasta-lite rebase helper: refused';

module.exports = {
  PL_DIR, REBASE_DIR, AUTOSTASH_INTENT, OURS_MARKER,
  REF_NAMESPACES, AUTOSTASH_REF, LEGACY_AUTOSTASH_REF, BACKUP_REF,
  AUTOSTASH_MSG, BACKUP_BEFORE_SUBJECT, BACKUP_AFTER_SUBJECT, BACKUP_IDENT, HELPER_REFUSED,
  REFLOG_DISCARD, REFLOG_DELETE_BRANCH,
};
