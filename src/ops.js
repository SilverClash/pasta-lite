'use strict';
// Operation layer between the IPC boundary (main.js) and the git modules. Pure Node, no Electron.
//
// OPS[name](repoRoot, ...args) validates the renderer-supplied args, then composes git / hunks /
// undo in the order undo needs (a discard runs inside undo.withDiscardBackup; a branch delete is
// recorded after it succeeds). Arguments are picked explicitly (never spread into git
// options), and every file path must be a plain repo-relative path, so the renderer cannot make
// git (or discardSelection's direct file writes) touch anything outside the repo.
//
// createRunner() (src/runner.js) adds what the app needs on top: write ops for one repo run one at
// a time (reads don't queue), 'busy' / 'changed' events for the watcher, cancellation by op id,
// and the bare-repository gate (src/bare-gate.js). The argument checks are src/op-validators.js,
// the display model of diffs src/diff-view.js, the IPC error shape src/ipc-errors.js.
const git = require('./git');
const hunks = require('./hunks');
const undo = require('./undo');
const merge = require('./merge');
const rebase = require('./rebase');
const { pendingAutostashError, restoreAutostash } = require('./autostash');
const { checks: rebaseChecks, rebasePlan, inProgress, refuseAtPickStop } = require('./ops-rebase');
const exec = require('./exec');
const { openRepo, summary, repoName } = require('./repo-open');
const {
  invalid, isObj, opts, str, bool, relPath, pathList, fileList, selection, selOpts, sha, int, tipsArg, stashRef,
  remoteName, branchName, localBranch, refspecSafe, commitId, commitMessage,
} = require('./op-validators');
const { diffView, refuseTruncated } = require('./diff-view');
const { bareGate } = require('./bare-gate');
const { serializeError } = require('./ipc-errors');
const runner = require('./runner');

const { kindError } = exec;

// ---------------------------------------------------------------- registry

const LOG_MAX = 10000;
const DELETE_BRANCHES_MAX = 1000; // the deleteBranches flow (renderer/flows-branch.js) checks the same cap

/**
 * Record deleted branch `res` ({name, sha, upstream}) for undo; a failed record is reported
 * ({undoRecorded: false, warning}), not thrown. `at`: HEAD's sha when the caller already read it.
 */
async function recorded(repo, res, at) {
  try {
    await undo.recordBranchDelete(repo, res, { at });
  } catch (err) {
    const why = err && err.message ? err.message : String(err);
    return { ...res, undoRecorded: false, warning: `The branch was deleted, but its deletion could not be recorded for undo: ${why}` };
  }
  return res;
}

/** A name deleteBranches accepts before looking it up: a string that can't be read as an option or split a line. */
function branchArg(v) {
  const n = str(v, 'name');
  if (!git.isPlainName(n)) throw invalid(`Invalid name: '${n}'`);
  return n;
}

/**
 * An operation split into `check` (validate the renderer's args, may ask the repo; returns the
 * argument list for act) and `act` (does the work; gets the runner's AbortSignal as an extra last
 * parameter). Called directly it does both. The runner calls them separately, so a call rejected
 * by validation touches nothing and emits no events.
 */
const op = (check, act) => Object.assign(
  async (repo, ...args) => act(repo, ...(await check(repo, ...args))),
  { check, act },
);

// The ops that bareGate refuses by their arguments in a bare repo (the name it refuses them as).
const BARE_ARGS = Object.freeze({
  // pull in any mode but 'fetch' merges or rebases into the working tree.
  pull: (args) => ((isObj(args[0]) ? args[0] : {}).mode !== 'fetch' ? 'pull' : null),
  createBranch: (args) => (isObj(args[1]) && args[1].checkout === true ? 'createBranch with checkout' : null),
});

/**
 * An op's descriptor: {run, check, act, write, bare, mirror}. `run` is what OPS[name] is (an
 * op() or a plain function), `check` / `act` its halves (a plain function: no check, act = run).
 * Bare repositories (src/bare-gate.js): `bare` true works in a bare repo, a function
 * (args) -> name refuses some arguments there (BARE_ARGS), and anything else (the default)
 * needs a working tree, so the gate stays an allow-list: a new op is refused in a bare repo
 * until its descriptor says otherwise. `mirror`: refused in a bare mirror (mirrorRefusal).
 */
const describe = (write) => (run, { bare = false, mirror = false } = {}) => Object.freeze({
  run, check: run.check || null, act: run.act || run, write, bare, mirror,
});
const read = describe(false);
const write = describe(true);

const READ = {
  status: read((repo) => git.status(repo), { bare: true }),
  refs: read((repo) => git.refs(repo), { bare: true }),
  remotes: read((repo) => git.remotes(repo), { bare: true }),
  stashes: read((repo) => git.stashes(repo), { bare: true }),
  /** Paging: log(repo, {limit}) then log(repo, {limit, ...res.next}). */
  log: read((repo, o) => {
    const { limit = 2000, skip = 0, tips } = opts(o);
    return git.log(repo, {
      limit: int(limit, 'limit', { min: 1, max: LOG_MAX }),
      skip: int(skip, 'skip'),
      tips: tipsArg(tips),
    });
  }, { bare: true }),
  commitFiles: read((repo, commit) => git.commitFiles(repo, sha(commit)), { bare: true }),
  diffCommitFile: read((repo, commit, file, orig) => git.diffCommitFile(repo, ...commitFileArgs(commit, file, orig)), { bare: true }),
  // Untracked diffs are refused (kind invalid-args) unless git lists the path as untracked, so a
  // symlinked parent folder can't make `diff --no-index` read outside the worktree (git.diffWorkdir).
  // `orig`: a rename's source path (status entry `orig`), diffed together with `file` (-M).
  diffWorkdir: read((repo, file, o) => git.diffWorkdir(repo, relPath(file), workdirOpts(o))),
  // Display-ready diffs for the renderer (which can't run hunks.js): parsed, decoded, capped.
  // `fingerprint` is what stage/unstage/discardSelection accept to refuse stale selections.
  commitDiffView: read(async (repo, commit, file, orig) => diffView(await git.diffCommitFile(repo, ...commitFileArgs(commit, file, orig))), { bare: true }),
  // workdirDiffView(file, {staged?, untracked?, orig?}). With `orig` (a rename: status entry
  // {status: 'R', path, orig}) both paths are diffed with rename detection, so the view is one
  // section with isRename/oldPath/newPath (plus any content hunks). Its fingerprint is always
  // null: hunks.js stages/unstages by one path only, so a rename offers file-level actions only
  // (unstage it with unstage([orig, path]) so the source's deletion is unstaged too).
  workdirDiffView: read(async (repo, file, o) => {
    const rel = relPath(file);
    const wo = workdirOpts(o);
    return diffView(await git.diffWorkdir(repo, rel, wo), rel, { fingerprint: !wo.orig });
  }),
  /** {message, sha} of HEAD (message as stored, for the Amend checkbox), or null when unborn. */
  lastCommitMessage: read(async (repo) => {
    const c = await git.lastCommit(repo);
    return c ? { message: c.message, sha: c.sha } : null;
  }, { bare: true }),
  undoState: read((repo) => undo.getState(repo), { bare: true }),
  // rebasePlan({upstream, onto?}) (docs/plans/rebase.md §4.2): the commits a rebase of HEAD
  // replays (upstream..HEAD), the published check and more; see rebase.plan. `upstream` / `onto`
  // are targets as for merge / rebase (resolved server-side; refused: invalid-args, ambiguous).
  // `interactive: true` (R3): also refused with the plan's interactiveRefusal kind
  // (merge-commits, root-commit, too-many, nothing), the plan attached as `plan`.
  rebasePlan: read(rebasePlan),
  /** The repository's worktrees (git.worktrees: [{path, head, branch, bare, detached, locked, prunable}]). */
  worktrees: read((repo) => git.worktrees(repo), { bare: true }),
};

/** checkout's [ref, {kind}] from the renderer's (target, kind): an existing branch, remote branch or commit. */
async function checkoutTarget(repo, target, kind) {
  if (kind === 'local') return [await localBranch(repo, target, 'ref'), { kind }];
  if (kind === 'remote') {
    const t = str(target, 'ref');
    if (t.startsWith('-') || !(await git.refExists(repo, `refs/remotes/${t}`))) throw invalid(`ref: no remote branch '${t}'`);
    return [t, { kind }];
  }
  if (kind === 'commit') return [await commitId(repo, sha(target, 'ref'), 'ref'), { kind }];
  throw invalid('kind must be local, remote or commit');
}

/** git.diffCommitFile's (sha, file, orig?) from the renderer's (commit, file, orig). */
const commitFileArgs = (commit, file, orig) => [sha(commit), relPath(file), orig == null ? undefined : relPath(orig, 'orig')];

/** git.diffWorkdir options from the renderer: {staged, untracked, orig?} (orig only when it differs). */
function workdirOpts(o) {
  const { staged, untracked, orig } = opts(o);
  const res = { staged: bool(staged), untracked: bool(untracked) };
  if (orig != null) {
    res.orig = relPath(orig, 'orig');
    if (res.untracked) throw invalid('an untracked file has no rename source (orig)');
  }
  return res;
}

/** stage/unstage/discardSelection options: {fingerprint?} plus the view-truncation guard. */
const selOptsGuarded = (o) => ({ ...selOpts(o), checkPatch: refuseTruncated });

/** {sha, summary} of the commit just made (summary = its subject line). */
async function committed(repo, sha) {
  const { summary } = await git.commitInfo(repo, sha);
  return { sha, summary };
}

/**
 * The status of `repo` when no rebase, merge or other operation is in progress; else kind
 * 'in-progress' (with `state`). Pull (any mode but 'fetch') and, since they would move HEAD or
 * rewrite the tree under a stopped operation (B1), checkout, stashApply / stashPop and
 * createBranch {checkout: true} refuse with it in their check.
 */
async function notInProgress(repo) {
  const st = await git.status(repo);
  if (st.state !== 'clean') throw inProgress(st.state);
  return st;
}

/**
 * withDiscardBackup(fn) where cancelling can never lose changes without an undo entry:
 * - cancelled while the "before" snapshot is taken: that snapshot is killed, nothing is touched;
 * - cancelled while fn discards (or fn fails part way): fn's git process is killed, but the
 *   partial result is still snapshotted and logged like a normal discard (if anything changed),
 *   then the error is rethrown with `backup`;
 * - once fn has settled, recording the backup is not interruptible.
 */
async function guardedDiscard(repo, paths, fn, signal) {
  const snap = new AbortController(); // signal for withDiscardBackup's own git commands
  let phase = 'before';
  const onAbort = () => { if (phase === 'before') snap.abort(); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let fnError = null;
  try {
    const res = await exec.withSignal(snap.signal, () => undo.withDiscardBackup(repo, paths, async () => {
      if (snap.signal.aborted) throw kindError('aborted', 'Operation was cancelled');
      phase = 'discard';
      try {
        return await exec.withSignal(signal, fn);
      } catch (err) {
        fnError = err;
        return undefined;
      } finally {
        phase = 'record';
      }
    }));
    if (fnError) throw Object.assign(fnError, { backup: res.backup });
    return { backup: res.backup };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

const WRITE = {
  stage: write(op((repo, paths) => [pathList(paths)], (repo, p) => git.stage(repo, p))),
  stageAll: write((repo) => git.stageAll(repo)),
  unstage: write(op((repo, paths) => [pathList(paths)], (repo, p) => git.unstage(repo, p))),
  unstageAll: write((repo) => git.unstageAll(repo)),
  stageSelection: write(op(
    (repo, file, sel, o) => [relPath(file), selection(sel), selOptsGuarded(o)],
    (repo, f, s, so) => hunks.stageSelection(repo, f, s, so),
  )),
  unstageSelection: write(op(
    (repo, file, sel, o) => [relPath(file), selection(sel), selOptsGuarded(o)],
    (repo, f, s, so) => hunks.unstageSelection(repo, f, s, so),
  )),
  // discard / discardSelection resolve to {backup} (the undo snapshot's commit id).
  discardSelection: write(op(
    (repo, file, sel, o) => [relPath(file), selection(sel), selOptsGuarded(o)],
    (repo, f, s, so, signal) => guardedDiscard(repo, [f], () => hunks.discardSelection(repo, f, s, so), signal),
  )),
  discard: write(op(
    (repo, files) => [fileList(files)],
    (repo, list, signal) => guardedDiscard(repo, list.map((f) => f.path), () => git.discard(repo, list), signal),
  )),
  // commit / commitAll resolve to {sha, summary}. Errors: empty-message (rejected before
  // anything runs), nothing-to-commit, hook-failed (message = hook output), conflicts (unmerged).
  // {only: true} (message-only amend) requires amend: without it `commit --only` with no paths
  // commits nothing new and would just fail (or, with paths, commit something else).
  // Refused at a rebase's conflict stop (kind 'rebasing'): a commit made there would get the
  // user as author; Continue Rebase commits the resolution with the original author. Allowed at
  // an edit stop, where amending or adding commits is the point.
  commit: write(op(async (repo, message, o) => {
    const { amend, only } = opts(o);
    if (bool(only) && !bool(amend)) throw invalid('only requires amend (a message-only amend)');
    const args = [commitMessage(message), { amend: bool(amend), only: bool(only) }];
    refuseAtPickStop(await git.status(repo));
    return args;
  }, async (repo, message, o) => committed(repo, await git.commit(repo, message, o)))),
  // Stage everything (`add -A`) and commit, as one queued write: no other write can run between.
  // `add -A` would silently mark conflicted files resolved, so any unmerged path refuses it
  // (kind 'conflicts', before anything runs; also mid-merge/rebase). A merge or rebase with no
  // conflicts left is allowed (the commit then concludes the merge, like commit).
  commitAll: write(op(async (repo, message, o) => {
    const args = [commitMessage(message), { amend: bool(opts(o).amend) }];
    const st = await git.status(repo);
    if (st.conflicted.length) {
      throw kindError('conflicts', `Resolve or mark conflicted files first (${st.conflicted.length} conflicted)`, { state: st.state, count: st.conflicted.length });
    }
    refuseAtPickStop(st);
    return args;
  }, async (repo, message, o) => {
    await git.stageAll(repo);
    return committed(repo, await git.commit(repo, message, o));
  })),
  fetch: write(op(async (repo, o) => {
    const { remote } = opts(o);
    return [{ remote: remote == null ? undefined : await remoteName(repo, remote) }];
  }, (repo, o, signal) => git.fetch(repo, { ...o, signal })), { bare: true, mirror: true }),
  // Refused (kind 'in-progress', `state`) while a rebase / merge / ... is in progress, and for
  // mode 'rebase' while the autostash of an earlier rebase waits (state 'autostash').
  pull: write(op(async (repo, o) => {
    const { mode } = opts(o);
    if (mode != null && !git.PULL_MODES.includes(mode)) throw invalid(`mode must be one of ${git.PULL_MODES.join(', ')}`);
    if (mode !== 'fetch') {
      const st = await notInProgress(repo);
      if (mode === 'rebase' && st.pendingAutostash) throw pendingAutostashError(st.pendingAutostash);
    }
    return [{ mode: mode == null ? undefined : mode }];
  }, (repo, o, signal) => git.pull(repo, { ...o, signal })), { bare: BARE_ARGS.pull, mirror: true }),
  push: write(op(async (repo, o) => {
    const { remote, branch, remoteBranch, force } = opts(o);
    if (force !== undefined && force !== false && force !== true && force !== 'lease') throw invalid("force must be false, true or 'lease'");
    return [{
      remote: remote == null ? undefined : await remoteName(repo, remote),
      branch: branch == null ? undefined : refspecSafe(await localBranch(repo, branch, 'branch'), 'branch'),
      remoteBranch: remoteBranch == null ? undefined : refspecSafe(await branchName(repo, remoteBranch, 'remoteBranch'), 'remoteBranch'),
      force: force || false,
    }];
  }, (repo, o, signal) => git.push(repo, { ...o, signal })), { bare: true }),
  setUpstream: write(op(async (repo, local, remote, remoteBranch) => [
    await localBranch(repo, local, 'branch'),
    await remoteName(repo, remote),
    await branchName(repo, remoteBranch, 'remoteBranch'),
  ], (repo, l, r, rb) => git.setUpstream(repo, l, r, rb)), { bare: true }),
  // checkout, stashApply / stashPop and createBranch {checkout: true} are refused (kind
  // 'in-progress', `state`) while a rebase, merge or other operation is in progress, like pull.
  checkout: write(op(async (repo, target, o) => {
    const { kind = 'local' } = opts(o);
    const args = await checkoutTarget(repo, target, kind);
    await notInProgress(repo);
    return args;
  }, (repo, t, o) => git.checkout(repo, t, o))),
  createBranch: write(op(async (repo, name, o) => {
    const { start, checkout } = opts(o);
    const args = [await branchName(repo, name, 'name'), {
      start: start == null ? undefined : await commitId(repo, start, 'start'),
      checkout: bool(checkout),
    }];
    if (args[1].checkout) await notInProgress(repo);
    return args;
  }, (repo, name, o) => git.createBranch(repo, name, o)), { bare: BARE_ARGS.createBranch, mirror: true }),
  // Resolves to {name, sha, upstream}. Refused during validation: kind 'current-branch' (HEAD is
  // on it), 'not-found' (no such local branch). If the branch was deleted but recording it for
  // undo failed, the result adds {undoRecorded: false, warning} (the delete itself did happen).
  deleteBranch: write(op(async (repo, name, o) => {
    const b = await branchName(repo, name, 'name');
    if (await git.isCurrentBranch(repo, b)) throw kindError('current-branch', `Cannot delete the current branch '${b}'`);
    if (!(await git.refExists(repo, `refs/heads/${b}`))) throw kindError('not-found', `Branch '${b}' not found`);
    return [b, { force: bool(opts(o).force) }];
  }, async (repo, name, o) => recorded(repo, await git.deleteBranch(repo, name, o))), { bare: true }),
  // deleteBranches(names, {force?}): several local branches, one after the other, in one write (one
  // 'changed' event). HEAD and the local branches are read once; each branch then costs one
  // `git branch -d` (-D) plus its undo record. A branch that can't be deleted (kinds 'not-merged',
  // 'current-branch', 'not-found', 'checked-out-elsewhere', …) doesn't stop the others; once the op
  // is cancelled, the branches not yet tried fail with kind 'aborted'. Resolves to {deleted:
  // [deleteBranch's result], failed: [{name, kind, message}]}; each delete is recorded for undo on
  // its own (Undo restores them one at a time, newest first).
  deleteBranches: write(op((repo, names, o) => {
    if (!Array.isArray(names) || !names.length) throw invalid('names must be a non-empty array');
    if (names.length > DELETE_BRANCHES_MAX) throw invalid(`names must have at most ${DELETE_BRANCHES_MAX} entries`);
    return [[...new Set(names.map(branchArg))], { force: bool(opts(o).force) }];
  }, async (repo, names, o, signal) => {
    const [head, tips] = await Promise.all([exec.headState(repo), git.branchTips(repo)]);
    const deleted = [];
    const failed = [];
    for (const [i, name] of names.entries()) {
      if (signal && signal.aborted) {
        for (const n of names.slice(i)) failed.push({ name: n, kind: 'aborted', message: 'Not attempted: the delete was cancelled' });
        break;
      }
      try {
        const tip = tips.get(name);
        if (!tip) throw kindError('not-found', `Branch '${name}' not found`);
        if (name === head.branch) throw kindError('current-branch', `Cannot delete the current branch '${name}'`);
        deleted.push(await recorded(repo, await git.removeBranch(repo, { name, ...tip }, o), head.sha || undefined));
      } catch (err) {
        const e = serializeError(err);
        failed.push({ name, kind: e.kind || null, message: e.message });
      }
    }
    return { deleted, failed };
  }), { bare: true }),
  stashPush: write(op((repo, message) => [message ? str(message, 'message') : undefined], (repo, m) => git.stashPush(repo, m))),
  stashApply: write(op(async (repo, entry) => {
    const args = [stashRef(entry)];
    await notInProgress(repo);
    return args;
  }, (repo, e) => git.stashApply(repo, e))),
  stashPop: write(op(async (repo, entry) => {
    const args = [stashRef(entry)];
    await notInProgress(repo);
    return args;
  }, (repo, e) => git.stashPop(repo, e))),
  stashDrop: write(op((repo, entry) => [stashRef(entry)], (repo, e) => git.stashDrop(repo, e))),
  // Resolve to {action, description, upstreamRestored?}. Cancelling works only while the target is
  // being found: the reversal itself always runs to the end (undo.js perform); a discard's
  // reversal that fails part way rejects with `backup`.
  undo: write((repo) => undo.undo(repo), { bare: true }),
  redo: write((repo) => undo.redo(repo), { bare: true }),

  // ---- merge / rebase (docs/plans/rebase.md §4; the checks are in src/ops-rebase.js). Targets
  // (`target`, `onto`, `upstream`): a full ref name, an unambiguous short name, or a commit id.
  // Starts are refused in check: in-progress (with `state`; 'autostash' while an earlier
  // autostash waits), stale (`expectHead`: HEAD's sha; `expectBranch`: the checked-out branch's
  // short name, or null for a detached HEAD), invalid-args / ambiguous (the target), dirty
  // (autostash: false with local changes), not-fast-forward (merge ff-only). A stop is a result
  // ({status: 'stopped'}), not an error.
  // merge(target, {ff = 'ff' | 'no-ff' | 'ff-only', autostash = true, expectHead, expectBranch}) -> MergeResult
  merge: write(op(rebaseChecks.merge, (repo, tg, o) => merge.merge(repo, tg, o))),
  // rebase(onto, {autostash = true, expectHead, expectBranch}) -> RebaseResult (the checked-out
  // branch or a detached HEAD). Rebasing a branch that isn't checked out: the renderer runs
  // checkout first (§3.7); that checkout fails kind 'checked-out-elsewhere' for a branch of
  // another worktree.
  rebase: write(op(rebaseChecks.rebase, (repo, o) => rebase.start(repo, o))),
  // rebaseInteractive({upstream, onto?}, todo, {messages, expectHead, expectBranch, autostash =
  // true, updateRefs = false}) -> RebaseResult (R3, §4.2–4.3). The security boundary: `todo`
  // comes from the renderer and is checked against the plan recomputed here; only the validated
  // {cmd, sha} pairs reach the todo file. Refused in check (nothing runs): the start refusals of
  // `rebase`, invalid-args, invalid-todo, empty-message, merge-commits, root-commit, too-many,
  // nothing. `updateRefs: true` is R5 (refused: invalid-args).
  rebaseInteractive: write(op(rebaseChecks.rebaseInteractive, (repo, o) => rebase.startInteractive(repo, o))),
  // resolveWith(path, 'ours' | 'theirs'): keep one side of a conflicted file and mark it
  // resolved (a side that deleted it removes it). ours = HEAD's side (merge: the current branch;
  // rebase: the commit being built on), theirs = the merged branch / the commit being replayed.
  // Refused: not-conflicted (the path isn't in status.conflicted). -> {path, side, deleted}
  resolveWith: write(op(rebaseChecks.resolveWith, (repo, p, side) => merge.resolveWith(repo, p, side))),
  // Mark every conflicted file resolved (git add). Refused: nothing (no conflicted files). -> {paths, count}
  markAllResolved: write(op(rebaseChecks.markAllResolved, (repo) => merge.markAllResolved(repo))),

  // ---- a rebase / merge in progress. Continue / skip resolve {status: 'done', ...} or
  // {status: 'stopped', state}. Refused in check: not-rebasing / not-merging, conflicts (with
  // `count`), dirty ({paths: the first 20, count}). Cancelling continue / skip kills git softly
  // (SIGTERM): the repo is left in a stopped rebase and the op rejects kind 'aborted' with
  // `rebase` (the RebaseState). Abort, the autostash re-apply and restoreAutostash can't be
  // cancelled.
  // rebaseContinue({message?}): `message` only at a conflict or hook stop of a merge-backend
  // rebase (else invalid-args); dirty: unstaged changes to tracked files.
  rebaseContinue: write(op(rebaseChecks.rebaseContinue, (repo, o) => rebase.continue_(repo, o))),
  // rebaseSkip(): dirty while tracked files have changes besides the conflicted ones and the ones
  // the stopped commit touches (git's skip resets the tree); invalid-args at an edit stop.
  rebaseSkip: write(op(rebaseChecks.rebaseSkip, (repo) => rebase.skip(repo))),
  rebaseAbort: write(op(rebaseChecks.rebaseAbort, (repo) => rebase.abort(repo))),
  // Resolves {restored, indexRestored?, stash?: {kept: true, sha, reason?}, resetFailed?};
  // `keep`: forget the autostash ref only (the stash stays in the list). Refused: in-progress
  // (state not clean), nothing (no pending autostash), dirty (changes to tracked files, staged or
  // not: the re-apply needs a clean tree; untracked files are fine). A tree that changes after
  // this check keeps the stash (reason 'dirty'; src/autostash.js restoreAutostash checks again).
  restoreAutostash: write(op(rebaseChecks.restoreAutostash, (repo, o) => restoreAutostash(repo, o))),
  // Conclude a merge in progress ("Commit and Merge"): {status: 'done', sha, summary, stash?,
  // indexRestored?, resetFailed?}. Refused: not-merging, conflicts, dirty (unstaged changes to
  // tracked files while our autostash waits for the merge to end, status.merge.autostash: its
  // re-apply needs a clean tree).
  mergeCommit: write(op(rebaseChecks.mergeCommit, (repo, o) => merge.mergeCommit(repo, o))),
  mergeAbort: write(op(rebaseChecks.mergeAbort, (repo) => merge.mergeAbort(repo))),
};

/** Every op's descriptor, by name (see describe). */
const DESCRIPTORS = Object.freeze({ ...READ, ...WRITE });
const names = (keep) => Object.keys(DESCRIPTORS).filter((n) => keep(DESCRIPTORS[n]));

/** Every operation the renderer may call, by name. */
const OPS = Object.freeze(Object.fromEntries(Object.entries(DESCRIPTORS).map(([n, d]) => [n, d.run])));
const WRITE_OPS = new Set(names((d) => d.write));

// ---------------------------------------------------------------- bare repositories

// Ops that need a working tree (or its index): refused in a bare repository by the runner, before
// validation or the write queue, so a refusal runs no git and emits no busy / changed events.
// Every op whose descriptor doesn't say `bare` is here, reads included: `diff --cached` in a bare
// repo exits 0 showing every file deleted (there is no index), and a rebase plan is only good for
// a rebase. A test checks every op is in exactly one of the two sets.
const WORKTREE_OPS = Object.freeze(new Set(names((d) => !d.bare)));
// Ops that work in a bare repository: refs and history only, or remotes. `status` resolves the
// synthetic clean status (status.bareStatus); undo / redo / undoState offer only a branch delete
// (src/undo.js). Two of them are refused for some arguments (BARE_ARGS): pull in any mode but
// 'fetch', createBranch with checkout: true. fetch, pull and createBranch are refused in a mirror.
const BARE_OK = Object.freeze(new Set(names((d) => d.bare)));

/**
 * The runner (src/runner.js) for this registry, with the bare-repository gate. `o` overrides
 * for tests: {ops, writeOps, log, now} (an op missing from the registry is gated like a
 * working-tree op).
 */
const createRunner = (o = {}) => runner.createRunner({
  ops: OPS, writeOps: WRITE_OPS, gate: (repo, name, args) => bareGate(repo, name, args, DESCRIPTORS[name]), ...o,
});

module.exports = {
  OPS, WRITE_OPS, WORKTREE_OPS, BARE_OK, DESCRIPTORS, createRunner, serializeError, relPath,
  // src/repo-open.js, part of the facade main.js uses.
  openRepo, summary, repoName,
};
