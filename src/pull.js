'use strict';
// Pull: never `git pull`. Fetch the upstream's remote, then merge it (ff-if-possible /
// ff-only, around git.withAutostash) or rebase onto it (rebase.pullRebase, with our persistent
// autostash). git.pull re-exports it.
const { kindError, tagError, run } = require('./exec');
const { headState } = require('./repo-dirs');
const { verify, resolveCommit, remotes, upstreamOf } = require('./git-reads');
const { PREFIX, after, branchOf, shortName } = require('./gitref');
const { fetch } = require('./remote');
const { withAutostash } = require('./stash');
const { workingState } = require('./working-state');
const { pullRebase } = require('./rebase');
const gitErrors = require('./git-errors');

// Explicit flags so merge.ff, merge.autoStash, rebase.autoStash, rebase.updateRefs etc. can't
// change the mode (we never run `git pull`, so pull.* is irrelevant). The upstream is always
// passed as its full ref (a local branch named 'origin/main' can't be picked instead), so a
// merge gets an explicit message: git's default would name 'refs/remotes/origin/main'.
// Rebase mode goes through src/rebase.js pullRebase (START_FLAGS, onto's sha).
const PULL_ARGS = Object.freeze({
  'ff-if-possible': (up, branch) => ['merge', '--ff', '--no-edit', '--no-autostash', '-m', pullMergeMessage(up, branch), up.ref],
  'ff-only': (up) => ['merge', '--ff-only', '--no-autostash', up.ref],
});

/**
 * Subject of the merge commit a pull of `branch` from its upstream `up` (upstreamOf) makes, as
 * `git pull` words it, but naming the remote rather than its URL (a URL can carry credentials):
 * "Merge branch 'main' of origin" when the upstream branch has the local branch's name, else
 * "Merge remote-tracking branch 'origin/other'"; a local upstream (remote '.') gives
 * "Merge branch 'other'". It is its own argv element after -m, so no name can become an option.
 */
function pullMergeMessage(up, branch) {
  const remoteBranch = up.remoteRef ? branchOf(up.remoteRef) : null;
  if (up.remote === '.' || branchOf(up.ref) !== null) return `Merge branch '${branchOf(up.ref) ?? up.ref}'`;
  if (up.remote && remoteBranch === branch) return `Merge branch '${branch}' of ${up.remote}`;
  return `Merge remote-tracking branch '${after(up.ref, PREFIX.REMOTES) ?? up.ref}'`;
}
const PULL_MODES = Object.freeze(['fetch', ...Object.keys(PULL_ARGS), 'rebase']);

/**
 * @param {{mode?: 'fetch'|'ff-if-possible'|'ff-only'|'rebase', signal?: AbortSignal}} [opts]
 *   `signal` cancels the fetch step.
 * @returns {Promise<{mode, before, after, fastForward, tagConflicts: string[]}>}
 */
async function pull(cwd, { mode = 'ff-if-possible', signal } = {}) {
  if (!PULL_MODES.includes(mode)) throw kindError('invalid-args', `Unknown pull mode: ${mode}`);
  const { sha: before, branch } = await headState(cwd);
  if (mode === 'fetch') {
    const { tagConflicts } = await fetch(cwd, { signal });
    return { mode, before, after: before, fastForward: false, tagConflicts };
  }
  if (!branch) throw kindError('detached', 'Cannot pull with a detached HEAD');
  const up = await upstreamOf(cwd, branch);
  if (!up) throw kindError('no-upstream', `Branch '${branch}' has no upstream`, { remotes: await remotes(cwd) });
  const { tagConflicts } = up.remote && up.remote !== '.' ? await fetch(cwd, { remote: up.remote, signal }) : { tagConflicts: [] };

  if (mode === 'rebase') {
    // Our persistent autostash (src/autostash.js): a stop with conflicts stays a stopped rebase that
    // Continue / Abort finish, and the stash comes back then.
    const onto = await resolveCommit(cwd, up.ref);
    if (!onto) throw kindError('no-upstream', `The upstream of '${branch}' (${up.ref}) doesn't exist; fetch first`, { remotes: await remotes(cwd) });
    const fin = await pullRebase(cwd, { onto, ontoName: shortName(up.ref), branch, before });
    const after = (await headState(cwd)).sha;
    return { mode, before, after, fastForward: before !== after && after === onto, tagConflicts, ...(fin.indexRestored === false ? { indexRestored: false } : {}) };
  }
  const args = PULL_ARGS[mode](up, branch);
  await withAutostash(cwd, async () => {
    try {
      await run(cwd, args);
    } catch (err) {
      const st = await workingState(cwd).catch(() => null);
      if (st && (st.conflicted.length || st.state !== 'clean')) throw tagError(err, 'conflicts');
      throw gitErrors.classify(err, ['notFastForward']);
    }
  });
  const after = (await headState(cwd)).sha;
  const upstreamOid = await verify(cwd, up.ref);
  return { mode, before, after, fastForward: before !== after && after === upstreamOid, tagConflicts };
}

module.exports = { PULL_MODES, pullMergeMessage, pull };
