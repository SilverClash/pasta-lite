'use strict';
// Our persistent autostash (docs/plans/rebase.md §3.8), shared by rebases (src/rebase.js) and
// merges (src/merge.js): local changes are stashed before the operation starts and come back
// when it is finished or aborted, now or after a stop. Split out of rebase.js.
//
// The autostash is a stash entry recorded in AUTOSTASH_REF, a per-worktree ref (git keeps
// refs/worktree/* apart for each worktree), so a rebase stopped in one linked worktree never
// makes another one restore or wait for its changes. Versions before kept it in
// LEGACY_AUTOSTASH_REF, which every worktree shares: that one is taken as this worktree's only
// in a repo with no linked worktrees (worktrees git would prune don't count; then the next write
// op moves it to AUTOSTASH_REF); with linked worktrees it is left alone, and its stash stays in
// the stash list.
//
// <git-dir>/pasta-lite/autostash-intent  {id, time}: written right before our `stash push`,
// removed once the stash is recorded in AUTOSTASH_REF. If the app dies in between, the stash
// whose message ends with "[<id>]" (made after `time`) is this worktree's pending autostash (an
// orphan). The stash list is shared by every worktree, so the random id is what tells ours
// apart. An intent file of an older version (no id) finds no orphan: its stash just stays in the
// stash list.
//
// Everything here builds on the working tree's own state (src/working-state.js) and the stash
// list (src/stash.js): nothing reads a rebase's or merge's state.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, tryOut, kindError, withSignal } = require('./exec');
const { repoDirs, gitDir } = require('./repo-dirs');
const { readSmall, readJson, exists } = require('./gitfiles');
const { oid, plDir, ensurePlDir, writeStateFile, removeFileIn } = require('./rebase-state');
const {
  AUTOSTASH_MSG, KEPT_WHY, stashes, stashIndexOf, stashPush, reapplyStash,
} = require('./stash');
const { workingState, hasChanges } = require('./working-state');
const { logKind } = require('./ipc-errors');
const { AUTOSTASH_REF, LEGACY_AUTOSTASH_REF, AUTOSTASH_INTENT, REF_NAMESPACES } = require('./namespace');
const { logger } = require('./log');

const log = logger.child('autostash');
const warn = (what) => (e) => log.warn(what, { kind: logKind(e) });

const PENDING_AUTOSTASH_MSG = 'Your changes from before the last rebase or merge are still in a stash: restore them or keep them in the stash first';

/**
 * A linked worktree `git worktree prune` would remove: not locked, and the `.git` file its
 * `gitdir` names is gone (the folder was deleted by hand). `adm`: <common-dir>/worktrees/<name>.
 */
function prunable(adm) {
  if (exists(path.join(adm, 'locked'))) return false;
  const gitFile = (readSmall(path.join(adm, 'gitdir')) || '').trim();
  return !!gitFile && !exists(path.resolve(adm, gitFile));
}

/** True when the repo has no linked worktree git would keep (so a shared ref can only belong to this one). */
function singleWorktree({ gitDir: gd, commonDir }) {
  if (path.resolve(gd) !== path.resolve(commonDir)) return false;
  try {
    return fs.readdirSync(path.join(commonDir, 'worktrees')).every((n) => prunable(path.join(commonDir, 'worktrees', n)));
  } catch (e) {
    return e.code === 'ENOENT';
  }
}

const INTENT_ID = /^[0-9a-f]{12}$/;

/**
 * A stash pushed by pushAutostash that never got its ref (the app died between `stash push` and
 * `update-ref`): the entry whose message ends with the intent file's id (see the top of this
 * file), made no earlier than the intent file.
 */
async function orphanAutostash(cwd, gd) {
  const intent = readJson(path.join(plDir(gd), AUTOSTASH_INTENT));
  if (!intent || typeof intent.id !== 'string' || !INTENT_ID.test(intent.id) || !Number.isFinite(intent.time)) return null;
  const tag = ` [${intent.id}]`;
  const entry = (await stashes(cwd)).find((s) => s.message.endsWith(tag) && s.message.includes(`${AUTOSTASH_MSG} before `)
    && s.date * 1000 >= intent.time - 1000); // %ct is in whole seconds
  return entry ? entry.hash : null;
}

/**
 * False only when neither autostash ref can exist, so git.status can skip for-each-ref: the files
 * ref backend (no reftable/), no loose ref file and neither name in packed-refs (a per-worktree
 * ref is never packed, but it is looked for too). Anything unusual answers true.
 */
function mayHaveAutostashRef({ gitDir: gd, commonDir }) {
  if (exists(path.join(commonDir, 'reftable'))) return true;
  if (exists(path.join(gd, AUTOSTASH_REF)) || exists(path.join(commonDir, LEGACY_AUTOSTASH_REF))) return true;
  if (!exists(path.join(commonDir, 'packed-refs'))) return false;
  const packed = readSmall(path.join(commonDir, 'packed-refs'));
  return packed === null || REF_NAMESPACES.some((ns) => packed.includes(` ${ns}`));
}

/**
 * This worktree's autostash, read only (git.status, readRebase): {sha, source} or null. source
 * 'ref' (AUTOSTASH_REF), 'legacy' (LEGACY_AUTOSTASH_REF, single-worktree repos only) or 'orphan'
 * (see orphanAutostash). Whether the stash is still in the stash list is not checked here.
 * `dirs`: repo-dirs.repoDirs.
 */
async function readAutostash(cwd, dirs) {
  const raw = mayHaveAutostashRef(dirs) && await tryOut(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)', AUTOSTASH_REF, LEGACY_AUTOSTASH_REF]);
  const refs = new Map();
  for (const line of (raw || '').split('\n')) {
    const [ref, sha, type] = line.split('\0');
    if (type === 'commit' && oid(sha)) refs.set(ref, sha);
  }
  if (refs.has(AUTOSTASH_REF)) return { sha: refs.get(AUTOSTASH_REF), source: 'ref' };
  if (refs.has(LEGACY_AUTOSTASH_REF) && singleWorktree(dirs)) return { sha: refs.get(LEGACY_AUTOSTASH_REF), source: 'legacy' };
  const orphan = await orphanAutostash(cwd, dirs.gitDir);
  return orphan ? { sha: orphan, source: 'orphan' } : null;
}

/** Delete AUTOSTASH_REF if it still points at `sha` (a concurrent delete is fine). */
async function deleteAutostashRef(cwd, sha) {
  await run(cwd, ['update-ref', '-d', AUTOSTASH_REF, sha]).catch(warn('could not delete the autostash ref'));
}

/**
 * This worktree's autostash for a write op, tidied up first: the sha in AUTOSTASH_REF, or null.
 * A legacy ref is moved to AUTOSTASH_REF, an orphan recorded there, a ref whose stash is gone
 * (dropped by hand) deleted and a stale intent file removed. git.status only reads.
 */
async function claimAutostash(cwd) {
  const dirs = await repoDirs(cwd);
  const found = await readAutostash(cwd, dirs);
  if (found && found.source !== 'ref') {
    await run(cwd, ['update-ref', AUTOSTASH_REF, found.sha, '']);
    if (found.source === 'legacy') await run(cwd, ['update-ref', '-d', LEGACY_AUTOSTASH_REF, found.sha]).catch(warn('could not delete the old autostash ref'));
  }
  removeFileIn(plDir(dirs.gitDir), AUTOSTASH_INTENT);
  if (!found) return null;
  if ((await stashIndexOf(cwd, found.sha)) !== null) return found.sha;
  await deleteAutostashRef(cwd, found.sha);
  return null;
}

/** The refusal of a start while the autostash `sha` of an earlier rebase or merge waits. */
const pendingAutostashError = (sha) => kindError('in-progress', PENDING_AUTOSTASH_MSG, { state: 'autostash', stash: sha });

/** Refuse a new rebase / merge while an earlier autostash waits to be restored (kind 'in-progress'). */
async function refusePendingAutostash(cwd) {
  const sha = await claimAutostash(cwd);
  if (sha) throw pendingAutostashError(sha);
}

/** Error fields of an autostash left in the stash (a `fin` of settleAutostash): {stashKept, stash: sha, resetFailed?}. */
const keptFields = (fin) => ({
  ...(fin && fin.stash ? { stashKept: true, stash: fin.stash.sha } : {}),
  ...(fin && fin.resetFailed ? { resetFailed: true } : {}),
});

/**
 * Stash local changes (staged, unstaged, untracked) before an operation (`what`: 'rebase of
 * main', 'merge of feat into main'; it ends up in the stash message, with the intent file's id),
 * and record the stash in AUTOSTASH_REF (create-only). Returns the stash sha, or null when clean.
 */
async function pushAutostash(cwd, what) {
  if (!hasChanges(await workingState(cwd))) return null;
  const gd = await gitDir(cwd);
  const id = crypto.randomBytes(6).toString('hex');
  writeStateFile(ensurePlDir(gd), AUTOSTASH_INTENT, JSON.stringify({ id, time: Date.now() }));
  try {
    const sha = await stashPush(cwd, `${AUTOSTASH_MSG} before ${what} [${id}]`);
    if (!sha) return null;
    try {
      await run(cwd, ['update-ref', AUTOSTASH_REF, sha, '']);
    } catch (err) {
      const res = await reapplyStash(cwd, sha);
      if (!res.restored && !res.gone) Object.assign(err, keptFields(res), res.error ? { reapplyError: res.error } : {});
      throw err;
    }
    return sha;
  } finally {
    removeFileIn(plDir(gd), AUTOSTASH_INTENT);
  }
}

/**
 * Push our autostash (when `autostash`), then run `fn` (git's start command); never throws:
 * {stash: sha | null, err}. The push can't be cancelled: a cancel between `stash push` and
 * recording the stash would leave the changes in a stash nobody re-applies. A cancel is seen by
 * `fn` right after.
 */
async function runWithAutostash(cwd, what, autostash, fn) {
  let stash = null;
  try {
    if (autostash) stash = await withSignal(undefined, () => pushAutostash(cwd, what));
    await fn();
    return { stash, err: null };
  } catch (err) {
    return { stash, err };
  }
}

/**
 * Re-apply our autostash (stash.reapplyStash: by hash, with the staged/unstaged split, onto a tree
 * without changes to tracked files), then delete its ref. `keep`: delete the ref only (the stash
 * stays in the list). Not cancellable (it runs under no signal). The ref goes only once the
 * stash is restored, gone, or conflicted with the tree (reason 'conflict': the stash stays in the
 * list, and Restore would conflict again). Otherwise the stash and the ref stay, so Restore can
 * be tried again: a tree with changes to tracked files (reason 'dirty'), untracked files in the
 * way ('untracked'), or an apply git gave up on without conflicts ('index', e.g. a leftover
 * index.lock).
 * @returns {Promise<{restored: boolean, indexRestored?: boolean,
 *   stash?: {kept: true, sha, reason?: 'dirty'|'untracked'|'conflict'|'index'}, resetFailed?: true}>}
 */
function restoreAutostash(cwd, { keep = false } = {}) {
  return withSignal(undefined, async () => {
    const sha = await claimAutostash(cwd);
    if (!sha) return { restored: false };
    if (keep) {
      await deleteAutostashRef(cwd, sha);
      return { restored: false, stash: { kept: true, sha } };
    }
    const res = await reapplyStash(cwd, sha);
    if (res.dropError) warn('could not drop the re-applied autostash')(res.dropError);
    if (res.resetError) warn('could not reset the tree after the autostash conflicted')(res.resetError);
    if (res.gone || res.restored || res.stash.reason === 'conflict') await deleteAutostashRef(cwd, sha);
    if (res.restored) return { restored: true, indexRestored: res.indexRestored };
    return { restored: false, ...(res.stash ? { stash: res.stash } : {}), ...(res.resetFailed ? { resetFailed: true } : {}) };
  });
}

/**
 * A rebase or merge is over: re-apply our autostash (if any) and report it the way results
 * carry it: {stash?: {kept: true, sha, reason}, indexRestored?: false, resetFailed?: true}.
 */
async function settleAutostash(cwd) {
  const res = await restoreAutostash(cwd);
  const fields = {};
  if (res.stash) fields.stash = res.stash;
  if (res.restored && res.indexRestored === false) fields.indexRestored = false;
  if (res.resetFailed) fields.resetFailed = true;
  return fields;
}

module.exports = {
  AUTOSTASH_REF, LEGACY_AUTOSTASH_REF, KEPT_WHY,
  readAutostash, claimAutostash, pendingAutostashError, refusePendingAutostash, pushAutostash, runWithAutostash,
  keptFields, restoreAutostash, settleAutostash,
};
