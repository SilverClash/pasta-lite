'use strict';
// The status aggregate every read of the UI starts from: the working tree's own state
// (src/working-state.js) plus what is in progress on top of it, a rebase (rebase-state.readRebase),
// a merge (gitfiles.mergeState) and our autostash (src/autostash.js), or the synthetic clean
// status of a bare repository. Read only: nothing here changes the repo. git.status re-exports it.
const { isBare, headState, repoDirs } = require('./repo-dirs');
const { workingState } = require('./working-state');
const { readRebase, commentChar } = require('./rebase-state');
const { readAutostash } = require('./autostash');
const { stashIndexOf } = require('./stash');
const { refFields } = require('./git-reads');
const { mergeState } = require('./gitfiles');
const { fullBranch, parseTrack } = require('./gitref');

/**
 * Working tree status: {branch, oid, upstream, ahead, behind, staged, unstaged, conflicted,
 * state, rebase, merge, pendingAutostash}. Read only: it never changes the repo.
 * - `conflicted`: [{path, status: 'U', xy}], `xy` the porcelain v2 XY of the unmerged entry
 *   ('UU' both modified, 'AA' both added, 'UD' / 'DU' deleted by them / us, 'AU', 'UA', 'DD').
 * - `state`: repo-dirs.repoState ('clean', 'rebasing', 'merging', ...).
 * - `rebase`: the RebaseState of a rebase in progress (src/rebase-state.js readRebase), else null.
 *   `branch` is null mid-rebase (HEAD is detached): rebase.branch names the branch.
 * - `merge`: {head, name, message, autostash} of a merge in progress (gitfiles.mergeState),
 *   else null. `autostash` (like rebase.autostash): the stash sha of the autostash recorded for
 *   this worktree while that stash is in the stash list, else null.
 * - `pendingAutostash`: the stash sha of this worktree's autostash (src/autostash.js
 *   readAutostash) from a rebase or merge that was finished or aborted outside the app (state
 *   clean), while that stash is still in the stash list; else null.
 * In a bare repository (no working tree): the synthetic clean status of bareStatus, with `bare: true`.
 */
async function status(cwd) {
  if (await isBare(cwd)) return bareStatus(cwd);
  const [ws, [dirs, autostash]] = await Promise.all([
    workingState(cwd),
    repoDirs(cwd).then(async (d) => [d, await readAutostash(cwd, d)]),
  ]);
  const { state } = ws;
  const res = { ...ws, rebase: null, merge: null, pendingAutostash: null };
  const gd = dirs.gitDir;
  // The autostash counts only while its stash is in the stash list (one dropped by hand is gone);
  // mid-operation only a recorded one (not an orphan: a crash before the op ran).
  const live = autostash && (await stashIndexOf(cwd, autostash.sha)) !== null ? autostash : null;
  const recorded = live && live.source !== 'orphan' ? live.sha : null;
  if (state === 'rebasing') res.rebase = await readRebase(cwd, res, gd, recorded);
  else if (state === 'merging') res.merge = { ...mergeState(gd, await commentChar(cwd)), autostash: recorded };
  else if (state === 'clean' && live) res.pendingAutostash = live.sha;
  return res;
}

/**
 * status() of a bare repository: there is no working tree or index (`git status`
 * fails 128), so it is the clean status every field of status() has with nothing changed, plus
 * `bare: true`. branch / oid are HEAD's (the branch HEAD names, even unborn: oid null), upstream
 * and ahead / behind that branch's, from for-each-ref (what `status --branch` would print).
 * Operation state is always clean: a merge or rebase needs a worktree, and a linked worktree
 * keeps its own in its own git dir.
 */
async function bareStatus(cwd) {
  const { branch, sha } = await headState(cwd);
  const res = {
    branch, oid: sha, upstream: null, ahead: 0, behind: 0,
    staged: [], unstaged: [], conflicted: [], state: 'clean',
    rebase: null, merge: null, pendingAutostash: null, bare: true,
  };
  const row = branch && (await refFields(cwd, fullBranch(branch), ['%(upstream:short)', '%(upstream:track,nobracket)']));
  if (row && row[0]) {
    const [upstream, track] = row;
    const { ahead, behind } = parseTrack(track);
    Object.assign(res, { upstream, ahead, behind });
  }
  return res;
}

module.exports = { status, bareStatus };
