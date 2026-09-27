'use strict';
// Merges (docs/plans/rebase.md §3.10, §8): "Merge <x> into <current>" from the menus (`merge`,
// with our persistent autostash, src/autostash.js), the state of a merge stopped with conflicts
// (ours, Pull's or a terminal's), "Commit and Merge", Abort, and keeping one side of a
// conflicted file (`resolveWith`, also used mid-rebase).
const exec = require('./exec');
const { headState, repoState } = require('./repo-dirs');
const git = require('./git');
const { status } = require('./status');
const { hookRefused, hookOutput } = require('./hooks');
const {
  refusePendingAutostash, runWithAutostash, keptFields, settleAutostash,
} = require('./autostash');
const { isAncestor } = require('./git-reads');
const { commentConfig, HASH_COMMENTS } = require('./rebase-state');
const { mergeState } = require('./gitfiles');
const { OID } = require('./gitref');
const { parseStageEntries } = require('./porcelain');
const gitErrors = require('./git-errors');
const { logKind } = require('./ipc-errors');
const { logger } = require('./log');

const { run, out, withSignal, kindError, nulList, LITERAL_ENV } = exec;
const log = logger.child('merge');

// ---------------------------------------------------------------- starting a merge

/** The fast-forward modes of `merge`, as git flags. */
const FF_FLAGS = Object.freeze({ ff: '--ff', 'no-ff': '--no-ff', 'ff-only': '--ff-only' });
const FF_MODES = Object.freeze(Object.keys(FF_FLAGS));

// Explicit flags, so merge.ff / merge.log / merge.autoStash / merge.verifySignatures and a
// branch.<name>.mergeOptions (which git applies before the command line) can't change what
// happens: always a real commit (never --squash / --no-commit), no shortlog in the message.
const MERGE_FLAGS = Object.freeze(['--no-autostash', '--no-edit', '--commit', '--no-squash', '--no-log', '--no-verify-signatures']);
const MERGE_CONFIG = Object.freeze(['-c', 'advice.mergeConflict=false']);

/**
 * Subject of the merge commit, as git words it:
 * "Merge branch 'feat' into main", "Merge remote-tracking branch 'origin/feat' into main",
 * "Merge tag 'v1' into main", "Merge commit 'abc1234' into main"; without " into …" on a
 * detached HEAD. `target`: {kind: 'local'|'remote'|'tag'|'commit', name} (ops resolves it).
 * It is its own argv element after -m, so no name can become an option.
 */
function mergeMessage(target, branch) {
  const what = { local: 'branch', remote: 'remote-tracking branch', tag: 'tag' }[target.kind] || 'commit';
  return `Merge ${what} '${target.name}'${branch ? ` into ${branch}` : ''}`;
}

/** Hooks `git merge` runs before it commits: a merge left in progress without conflicts stopped in one. */
const MERGE_HOOKS = ['pre-merge-commit', 'prepare-commit-msg', 'commit-msg'];

/** The autostash is over (merge concluded / aborted / failed): re-apply it, never cut short. */
const settle = (cwd) => withSignal(undefined, () => settleAutostash(cwd));

/**
 * "Merge <target> into <current>" (§8). `target`: {sha, kind, name} with `sha` a full commit id
 * (ops resolves and validates it; a branch named like a remote branch can't be confused, since
 * only the sha reaches git). `ff`: 'ff' (fast-forward when possible, the default), 'no-ff'
 * (always a merge commit) or 'ff-only' (ops refuses when a fast-forward isn't possible).
 * `autostash` (default true): local changes go into our persistent autostash
 * (src/autostash.js AUTOSTASH_REF) and come back when the merge is done, concluded or aborted.
 * @returns {Promise<MergeResult>}
 *   {status: 'up-to-date', branch, head}: target already in HEAD's history (git didn't run);
 *   {status: 'done', branch, before, after, fastForward, undoRecorded: false, stash?, indexRestored?};
 *   {status: 'stopped', stop: 'conflict'|'hook'|'other', state: status.merge, conflicted: n,
 *    hookOutput?, stash?: {kept: true, sha}}: the merge is in progress (Commit and Merge / Abort).
 *    'hook': no conflicts, and a hook git runs before committing exists (hookOutput: its output);
 *    'other': no conflicts, and signing failed, or git said why (files in the way), or no such hook.
 * Errors: in-progress (an earlier autostash waits), unrelated-histories, not-fast-forward,
 * dirty (autostash off and git refused the local changes), hook-failed, aborted (cancelled;
 * with `merge` when it left a merge in progress), or git's error; stashKept / stash when the
 * autostash couldn't be re-applied, `result` when the merge itself was done.
 */
async function merge(cwd, target, { ff = 'ff', autostash = true } = {}) {
  if (!target || !OID.test(target.sha || '')) throw kindError('invalid-args', 'target must be a resolved commit');
  if (!Object.hasOwn(FF_FLAGS, ff)) throw kindError('invalid-args', `ff must be one of ${FF_MODES.join(', ')}`);
  const { sha: before, branch } = await headState(cwd);
  if (!before) throw kindError('invalid-args', 'There are no commits to merge into yet');
  if (await isAncestor(cwd, target.sha, before)) return { status: 'up-to-date', branch, head: before };
  await refusePendingAutostash(cwd);
  const args = [...MERGE_CONFIG, 'merge', ...MERGE_FLAGS, FF_FLAGS[ff], '-m', mergeMessage(target, branch), '--end-of-options', target.sha];
  const { stash, err } = await runWithAutostash(cwd, `merge of ${target.name} into ${branch || 'HEAD'}`, autostash, () => run(cwd, args));
  return withSignal(undefined, async () => {
    const st = await status(cwd);
    if (st.state === 'merging') {
      const kept = { stash: stash && { kept: true, sha: stash } };
      if (err && err.kind) throw Object.assign(err, { merge: st.merge }, keptFields(kept));
      const stop = st.conflicted.length ? 'conflict' : await stopOf(cwd, err);
      return {
        status: 'stopped', stop, state: st.merge, conflicted: st.conflicted.length,
        ...(stop === 'hook' && err ? { hookOutput: hookOutput(err.stderr || err.stdout) } : {}), ...(stash ? kept : {}),
      };
    }
    if (st.state !== 'clean') {
      if (err) throw err;
      throw kindError('in-progress', `The merge ended, but the repository is now ${st.state}`, { state: st.state });
    }
    const { sha: after } = await headState(cwd);
    if (err && after === before) {
      const fin = await settle(cwd);
      throw Object.assign(classifyMergeError(err), keptFields(fin));
    }
    const fin = await settle(cwd);
    const result = { status: 'done', branch, before, after, fastForward: after === target.sha, undoRecorded: false, ...fin };
    if (err && err.kind !== 'aborted') throw Object.assign(err, { result });
    return result;
  });
}

/**
 * Why a merge stopped without conflicts: 'hook' when a hook git runs before committing refused it
 * (hooks.hookRefused: git's text names no other reason, such as a signing failure or files in the
 * way, and such a hook exists), else 'other'.
 */
async function stopOf(cwd, err) {
  return (await hookRefused(cwd, err, MERGE_HOOKS)) ? 'hook' : 'other';
}

/** A `git merge` that failed before changing anything, classified. */
function classifyMergeError(err) {
  if (gitErrors.matches(err, 'unrelatedHistories')) {
    return gitErrors.classify(err, ['unrelatedHistories'], { message: 'These histories have no commit in common; they can\'t be merged' });
  }
  return gitErrors.classify(err, ['notFastForward', 'overwritten']);
}

// ---------------------------------------------------------------- a merge in progress

/**
 * Conclude the merge in progress ("Commit and Merge"). Without `message`: `commit --no-edit
 * --cleanup=strip`, so MERGE_MSG is committed minus git's own comment lines ("Conflicts:"),
 * stripped with the comment character git wrote them with, whatever commit.cleanup says
 * (core.commentChar=auto: '#'). With `message` (stdin): `--cleanup=whitespace`, like the app's
 * normal commits ('#' lines kept). Then our autostash (a merge started with one) comes back.
 * Errors: kind conflicts | hook-failed | nothing-to-commit (git.commitError), or git's error.
 * @returns {Promise<{status: 'done', sha, summary, stash?, indexRestored?, resetFailed?}>}
 */
async function mergeCommit(cwd, { message } = {}) {
  const args = [...((await commentConfig(cwd)).auto ? HASH_COMMENTS : []), 'commit', '--quiet', '--no-verbose'];
  try {
    if (message === undefined) await run(cwd, [...args, '--cleanup=strip', '--no-edit']);
    else await run(cwd, [...args, '--cleanup=whitespace', '--file=-'], { input: message });
  } catch (err) {
    throw await git.commitError(cwd, err);
  }
  const { sha } = await headState(cwd);
  const { summary } = await git.commitInfo(cwd, sha);
  return { status: 'done', sha, summary, ...(await settle(cwd)) };
}

/**
 * `git merge --abort`: back to the pre-merge commit and tree, then our autostash (a merge
 * started with one) comes back. Not cancellable (runs under no signal), like rebase --abort. A
 * merge still in progress after git's abort keeps the autostash (a later Abort brings it back)
 * and throws git's error (or kind 'in-progress') with `merge`; a failure git reported after the
 * merge was gone (e.g. a post-checkout hook) is only logged.
 * @returns {Promise<{status: 'aborted', head, stash?, indexRestored?, resetFailed?}>}
 */
function mergeAbort(cwd) {
  return withSignal(undefined, async () => {
    const err = await run(cwd, ['merge', '--abort']).then(() => null, (e) => e);
    if ((await repoState(cwd)) === 'merging') {
      const e = err || kindError('in-progress', 'The merge could not be aborted', { state: 'merging' });
      throw Object.assign(e, { merge: (await status(cwd)).merge });
    }
    if (err) log.warn('merge --abort reported a failure', { kind: logKind(err) });
    const head = (await headState(cwd)).sha;
    return { status: 'aborted', head, ...(await settleAutostash(cwd)) };
  });
}

// ---------------------------------------------------------------- conflicted files

const LITERAL = { env: LITERAL_ENV };

/** The index stages (1 base, 2 ours, 3 theirs) of the unmerged path `file`. */
async function stagesOf(cwd, file) {
  const raw = await out(cwd, ['ls-files', '-u', '-z', '--', file], LITERAL);
  return new Set(parseStageEntries(raw).filter((e) => e.path === file && e.stage > 0).map((e) => e.stage));
}

/**
 * Resolve the conflicted `file` by keeping one side, then mark it resolved (§5.4 "Keep main's
 * version" / "Keep a1b2c3d's version"). `side` uses git's names, which always mean the same
 * index stage:
 * - 'ours' = HEAD's side: in a merge the current branch; **in a rebase the commit being built on
 *   (onto plus the commits already replayed)**;
 * - 'theirs' = the other side: in a merge the branch being merged; **in a rebase the commit being
 *   replayed** (status.rebase.stoppedSha).
 * When the chosen side deleted the file (a modify/delete conflict, "Delete file"), the file is
 * removed (`git rm`); otherwise `checkout --ours|--theirs` + `add` ("Keep file").
 * The caller (ops) checks that `file` is conflicted.
 * @returns {Promise<{path, side, deleted: boolean}>}
 */
async function resolveWith(cwd, file, side) {
  if (side !== 'ours' && side !== 'theirs') throw kindError('invalid-args', "side must be 'ours' or 'theirs'");
  const stages = await stagesOf(cwd, file);
  if (!stages.size) throw kindError('stale', `'${file}' is not conflicted any more. Refresh and try again.`);
  const opt = { input: nulList([file]), ...LITERAL };
  if (stages.has(side === 'ours' ? 2 : 3)) {
    await run(cwd, ['checkout', `--${side}`, '--pathspec-from-file=-', '--pathspec-file-nul'], opt);
    await run(cwd, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], opt);
    return { path: file, side, deleted: false };
  }
  await run(cwd, ['rm', '-q', '-f', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], opt);
  return { path: file, side, deleted: true };
}

/** Mark every conflicted file resolved (`add`, as Mark resolved does per file): {paths, count}. */
async function markAllResolved(cwd) {
  const paths = (await status(cwd)).conflicted.map((f) => f.path);
  if (paths.length) await git.stage(cwd, paths);
  return { paths, count: paths.length };
}

module.exports = {
  FF_MODES, mergeMessage, merge, mergeState, mergeCommit, mergeAbort, resolveWith, markAllResolved,
};
