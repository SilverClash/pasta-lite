'use strict';
// High-level git operations, and the facade of the git layer: reads (refs, history, diffs),
// the index and worktree (stage, discard, commit), branches (checkout, create, delete), plus
// re-exports of the modules below it (status, pull, remote, hooks, git-reads, stash), so main.js
// and ops use one module. Every function takes a path inside the repo as `cwd` first and shells
// out through exec.run/out, which always run at the worktree root: paths passed in and returned
// are root-relative. No parsing or behaviour depends on user config.
const fs = require('node:fs');
const path = require('node:path');
const {
  GitError, kindError, tagError, run, out, tryOut, nulList, argvChunks, LITERAL_ENV,
} = require('./exec');
const { resolveRoot, bareGitDir, isBare, headState } = require('./repo-dirs');
const {
  OID, PREFIX, after, branchOf, shortName, fullBranch, parseTrack, REFSPEC_SAFE,
} = require('./gitref');
const {
  splitN, parseNulRecords, trimTrailingNewlines, parseWorktrees, parseNameStatus,
} = require('./porcelain');
const gitErrors = require('./git-errors');
const reads = require('./git-reads');
const { workdirDiff, commitDiff } = require('./diff-args');
const { messageProblem } = require('./message-rule');
const hooks = require('./hooks');
const remote = require('./remote');
const { status } = require('./status');
const { PULL_MODES, pull } = require('./pull');
const stash = require('./stash');

const { emptyTree, verify, refExists, resolveCommit, remotes, upstreamOf, refFields, isCurrentBranch } = reads;
const { hookRefused, hookOutput, COMMIT_HOOKS } = hooks;
const { withAutostash } = stash;

const LITERAL = { env: LITERAL_ENV };

/** First parent of `sha`, or the empty tree for a root commit. */
async function baseOf(cwd, sha) {
  return (await verify(cwd, `${sha}^1`)) || emptyTree(cwd);
}

// ---------------------------------------------------------------- read ops

/** Worktree root containing `dir`. Throws (GitError) when `dir` is not inside a worktree. */
async function root(dir) {
  return (await out(dir, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
}

// Repo config (local or worktree scope, includes followed) that makes git run a command during
// normal use: filter drivers on `status`/`add`/`checkout`, ssh / credential / proxy programs on
// fetch and push, hooks from another folder, signing programs (and gpg.ssh.defaultKeyCommand, run
// to find the signing key), merge drivers, core.alternateRefsCommand (fetch/push with
// alternates). core.fsmonitor and protocol.ext.allow are not listed: git-process.js always
// overrides them. Matched against git's canonical key (section and name lower-cased, subsection
// as written).
// Programs the app never runs but a terminal git in the same repo would, on everyday commands:
// core.editor / sequence.editor (the app overrides them with GIT_EDITOR / GIT_SEQUENCE_EDITOR,
// git-process.js, src/rebase.js), the pager (core.pager, pager.<cmd>: the app's git has no tty),
// external diff and textconv drivers (the app passes --no-ext-diff --no-textconv), merge/diff
// tools, and trailer commands (`commit --trailer`).
// Not listed: uploadpack.packObjectsHook (git only reads it from global/system config),
// url.*.insteadOf (can only reach ext::, forbidden), remote.*.vcs and alias.* (run installed
// helpers, or only when the user types the repo's own alias name), and mail/browser programs
// (sendemail.*, imap.tunnel, browser.*: only on explicit send-email / help --web).
const RISKY_CONFIG = '^(filter\\..+\\.(clean|smudge|process)'
  + '|core\\.(sshcommand|hookspath|gitproxy|askpass|editor|pager|alternaterefscommand)|pager\\..+'
  + '|sequence\\.editor|credential\\.(.+\\.)?helper|gpg\\.(.+\\.)?program|gpg\\.ssh\\.defaultkeycommand'
  + '|merge\\..+\\.driver|remote\\..+\\.(uploadpack|receivepack)'
  + '|diff\\.external|diff\\..+\\.(command|textconv)|(merge|diff)tool\\..+\\.(cmd|path)|trailer\\..+\\.(cmd|command))$';

// Keys that only run a command with some values: [key regexp, value regexp]. protocol.allow /
// protocol.<name>.allow = always (any case) re-enables ext:: (and file:// for submodules) for a
// terminal git; submodule.<name>.update = !<command> runs it on `git submodule update`.
const RISKY_VALUES = [
  ['^protocol\\.(.+\\.)?allow$', '^[Aa][Ll][Ww][Aa][Yy][Ss]$'],
  ['^submodule\\..+\\.update$', '^!'],
];

/**
 * Keys of the repo's own config (not global/system/-c) that can run a command, sorted and
 * de-duplicated; [] when there are none. A repo from elsewhere (downloaded, unpacked) should only
 * be opened after the user has agreed to these. Values are matched by git, never read here (a
 * credential helper line can hold a token).
 */
async function riskyLocalConfig(cwd) {
  const query = (args) => out(cwd, ['config', '--includes', '--show-scope', '-z', '--name-only', '--get-regexp', ...args], { okCodes: [0, 1] });
  const raws = await Promise.all([query([RISKY_CONFIG]), ...RISKY_VALUES.map((pair) => query(pair))]);
  const keys = new Set();
  for (const raw of raws) {
    const f = raw.split('\0');
    for (let i = 0; i + 1 < f.length; i += 2) {
      if (f[i] === 'local' || f[i] === 'worktree') keys.add(f[i + 1]);
    }
  }
  return [...keys].sort(); // NOSONAR(S2871): config keys are ASCII; code-unit order is the intended, stable order
}

/**
 * The hooks git would run in the repository ('hooks/<name>', sorted; [] when none): the
 * executable files of its hooks folder (`rev-parse --git-path hooks`, so core.hooksPath is
 * followed, and a linked worktree's are the main repo's), except git's `*.sample` files and
 * dot-files. A clone's .git/hooks holds only samples, but a folder from elsewhere can carry
 * hooks: a downloaded or unzipped working tree its .git/hooks (run on commit, checkout, merge),
 * a bare repo a project tracks its hooks folder (a checked-out file keeps its executable bit;
 * run on the first fetch). main asks before opening either. On Windows git runs a hook
 * whatever its mode, so every file counts.
 */
async function riskyHooks(cwd) {
  const dir = (await out(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'])).replace(/\n$/, '');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no hooks folder
  }
  const runs = (file) => {
    const st = fs.statSync(file, { throwIfNoEntry: false }); // a symlink counts as what it points at
    return !!st && st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0);
  };
  return entries
    .filter((e) => !e.name.startsWith('.') && !e.name.endsWith('.sample') && runs(path.join(dir, e.name)))
    .map((e) => `hooks/${e.name}`)
    .sort();
}

/**
 * The repository's worktrees (`git worktree list --porcelain -z`), main one first:
 * [{path, head, branch, bare, detached, locked, prunable}]. `path` absolute as git prints it;
 * `head` the checked-out commit (null for the bare entry or an unborn branch); `branch` the short
 * name (null when detached or bare); locked / prunable: booleans (git's reasons are left out).
 * Works in a bare repo (its own entry is the one with bare: true) and in any worktree.
 */
async function worktrees(cwd) {
  return parseWorktrees(await out(cwd, ['worktree', 'list', '--porcelain', '-z']));
}

/** Split 'origin/feature/x' into remote + branch, preferring the longest known remote name. */
function splitRemoteRef(short, remoteNames) {
  const match = remoteNames
    .filter((r) => short.startsWith(r + '/'))
    .sort((a, b) => b.length - a.length)[0];
  if (match) return { remote: match, branch: short.slice(match.length + 1) };
  const i = short.indexOf('/');
  return { remote: short.slice(0, i), branch: short.slice(i + 1) };
}

async function refs(cwd) {
  const fmt = ['%(refname)', '%(objectname)', '%(*objectname)', '%(upstream)', '%(upstream:track,nobracket)', '%(HEAD)', '%(symref)'].join('%00');
  const [raw, remoteNames, head] = await Promise.all([
    out(cwd, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
    remotes(cwd),
    headState(cwd),
  ]);
  const { branch, sha: oid } = head;
  const res = { head: { branch, oid, detached: branch === null && oid !== null }, local: [], remote: [], tags: [] };
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [ref, obj, peeled, upstream, track, isHead, symref] = line.split('\0');
    const name = branchOf(ref);
    if (name !== null) {
      res.local.push({
        name,
        oid: obj,
        upstream: upstream ? shortName(upstream) : null,
        ...parseTrack(track),
        current: isHead === '*',
      });
    } else if (ref.startsWith(PREFIX.REMOTES)) {
      if (symref || ref.endsWith('/HEAD')) continue;
      const short = after(ref, PREFIX.REMOTES);
      res.remote.push({ name: short, ...splitRemoteRef(short, remoteNames), oid: obj });
    } else {
      res.tags.push({ name: after(ref, PREFIX.TAGS) ?? ref, oid: peeled || obj });
    }
  }
  return res;
}

const LOG_FIELDS = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%s', '%b'];

/** Sorted, de-duplicated commit-ish ids of every branch, remote branch, tag and HEAD. */
async function currentTips(cwd) {
  const [raw, head] = await Promise.all([
    out(cwd, ['for-each-ref', '--format=%(objectname) %(objecttype) %(*objecttype)', 'refs/heads', 'refs/remotes', 'refs/tags']),
    headState(cwd),
  ]);
  const tips = new Set(head.sha ? [head.sha] : []);
  for (const line of raw.split('\n')) {
    const [oid, type, peeledType] = line.split(' ');
    if (oid && (type === 'commit' || (type === 'tag' && peeledType === 'commit'))) tips.add(oid);
  }
  return [...tips].sort(); // NOSONAR(S2871): hex object ids; code-unit order is the intended order
}

/**
 * Commit history across every ref tip, newest first (--date-order).
 *
 * Paging contract: the first call (no `tips`) snapshots the current ref tips and returns them
 * as `tips`, plus `next` = { tips, skip } when `hasMore`. Pass `next` back
 * (`log(cwd, { limit, ...res.next })`) for the following page: the walk starts from the very
 * same tips, so it is identical and pages neither overlap nor miss commits even if refs moved
 * in between (commits reachable only from new ref positions appear after a fresh first call).
 * Commits within a page are unique by hash.
 * @returns {Promise<{commits: object[], hasMore: boolean, tips: string[], next: {tips: string[], skip: number}|null}>}
 */
async function log(cwd, { limit = 2000, skip = 0, tips } = {}) {
  if (tips && !tips.every((t) => OID.test(t))) throw kindError('invalid-args', 'log: tips must be full object ids');
  const walk = tips ? [...tips] : await currentTips(cwd);
  if (!walk.length) return { commits: [], hasMore: false, tips: [], next: null };
  const raw = await out(cwd, [
    'rev-list', '--date-order', '--ignore-missing', `--max-count=${limit + 1}`, `--skip=${skip}`,
    '--no-commit-header', `--format=${LOG_FIELDS.join('%x00')}%x00`, '--stdin',
  ], { input: walk.join('\n') + '\n' });
  // rev-list prints each commit once, so no de-duplication is needed.
  const commits = parseNulRecords(raw, LOG_FIELDS.length)
    .filter(([hash]) => hash)
    .map(([hash, parents, author, email, date, committer, committerDate, subject, body]) => ({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: Number(date),
      committer,
      committerDate: Number(committerDate),
      subject,
      body: trimTrailingNewlines(body),
    }));
  const hasMore = commits.length > limit;
  if (hasMore) commits.length = limit;
  return { commits, hasMore, tips: walk, next: hasMore ? { tips: walk, skip: skip + limit } : null };
}

async function commitFiles(cwd, sha) {
  const base = await baseOf(cwd, sha);
  return parseNameStatus(await out(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', base, sha, '--'], { diff: true }));
}

/**
 * Patch of `file` in commit `sha` vs its first parent (renames detected with -M).
 * Latin-1 encoded (one char per byte): decode for display with hunks.decodeForDisplay.
 */
async function diffCommitFile(cwd, sha, file, orig) {
  const base = await baseOf(cwd, sha);
  const { args, opts } = commitDiff(base, sha, orig && orig !== file ? [orig, file] : [file]);
  return out(cwd, args, opts);
}

/**
 * Patch for one file: index→workdir, HEAD→index (`staged`) or /dev/null→file (`untracked`),
 * with exactly the argument lists hunks.js indexes. Latin-1 encoded (one char per byte) so
 * hunks' byte fingerprints match: decode for display with hunks.decodeForDisplay.
 *
 * `orig` (a rename's source path, from status): diff both paths with rename detection (-M), so
 * a rename shows as one "rename from/to" section instead of a whole new file. Not what hunks.js
 * indexes (it works on `file` alone), so such a patch must never be used for line staging.
 * Refused for untracked files. Without `orig` (or orig === file) the argument lists are the
 * ones above, unchanged.
 */
async function diffWorkdir(cwd, file, { staged = false, untracked = false, orig } = {}) {
  const rename = typeof orig === 'string' && orig !== '' && orig !== file;
  if (untracked && rename) throw kindError('invalid-args', 'An untracked file has no rename source');
  // `diff --no-index` follows symlinked parent folders (lnk -> /elsewhere, g -> .git), so only
  // diff paths git itself lists as untracked (it never lists paths beyond a symlink).
  if (untracked && !(await isUntracked(cwd, file))) {
    throw kindError('invalid-args', `Not an untracked file in the worktree: '${file}'`);
  }
  const { args, opts } = workdirDiff(file, { staged, untracked, orig: rename ? orig : undefined });
  return out(cwd, args, opts);
}

/** True when `file` is exactly a path `git ls-files --others --exclude-standard` lists. */
async function isUntracked(cwd, file) {
  if (typeof file !== 'string' || !file) return false;
  const raw = await out(cwd, ['ls-files', '-z', '--others', '--exclude-standard', '--', file], LITERAL);
  return raw.split('\0').includes(file);
}

/** {sha, message, summary} of commit `sha` (message as stored minus trailing newlines; summary = subject). */
async function commitInfo(cwd, sha) {
  const raw = await out(cwd, ['log', '-1', '--no-walk', '--format=%s%x00%B', sha, '--']);
  const [summary, body = ''] = splitN(raw, '\0', 2);
  return { sha, message: trimTrailingNewlines(body), summary };
}

/** {sha, message, summary} of HEAD, or null in an unborn repo (for the Amend checkbox). */
async function lastCommit(cwd) {
  const { sha } = await headState(cwd);
  return sha ? commitInfo(cwd, sha) : null;
}

// ---------------------------------------------------------------- index / worktree

async function stage(cwd, paths) {
  if (!paths.length) return;
  await run(cwd, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(paths), ...LITERAL });
}

async function stageAll(cwd) {
  await run(cwd, ['add', '-A']);
}

async function unstage(cwd, paths) {
  if (!paths.length) return;
  const args = (await headState(cwd)).sha
    ? ['restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul']
    : ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'];
  await run(cwd, args, { input: nulList(paths), ...LITERAL });
}

async function unstageAll(cwd) {
  if ((await headState(cwd)).sha) await run(cwd, ['reset', '-q']);
  else await run(cwd, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', '.']);
}

/** The subset of `paths` that `git ls-files --others --exclude-standard` lists exactly (files only). */
async function untrackedFiles(cwd, paths) {
  const listed = new Set();
  for (const chunk of argvChunks(paths)) {
    const raw = await out(cwd, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...chunk], LITERAL);
    for (const p of raw.split('\0')) if (p) listed.add(p);
  }
  // 'sub/' = a nested repository: never handed to clean (it is not a file).
  return paths.filter((p) => listed.has(p) && !p.endsWith('/'));
}

/**
 * Throw away working-tree changes of `files` ([{path, status}], status '?' = untracked). Callers
 * must snapshot for undo first. The '?' status is not trusted: only paths git itself lists as
 * untracked files are deleted (never a folder, so a tracked folder's untracked files survive).
 * A '?' path that exists but isn't an untracked file (tracked, ignored, a folder) throws kind
 * 'stale' before anything changes; one that is already gone is skipped.
 */
async function discard(cwd, files) {
  const asked = [...new Set(files.filter((f) => f.status === '?').map((f) => f.path))];
  const tracked = files.filter((f) => f.status !== '?').map((f) => f.path);
  const untracked = asked.length ? await untrackedFiles(cwd, asked) : [];
  if (untracked.length !== asked.length) {
    const ok = new Set(untracked);
    const root = await resolveRoot(cwd);
    const stale = asked.filter((p) => !ok.has(p) && fs.lstatSync(path.join(root, p), { throwIfNoEntry: false }));
    if (stale.length) {
      throw kindError('stale', `Not an untracked file any more: '${stale[0]}'. Refresh and try again.`, { paths: stale });
    }
  }
  if (tracked.length) {
    await run(cwd, ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(tracked), ...LITERAL });
  }
  for (const chunk of argvChunks(untracked)) await run(cwd, ['clean', '-f', '-q', '--', ...chunk], LITERAL);
}

/**
 * Commit the index. The message is stored as typed minus leading/trailing blank lines and
 * trailing whitespace (`--cleanup=whitespace`: '#' lines are kept, since what the user typed is the
 * message, e.g. a '#123' issue number at line start), whatever commit.cleanup / commit.verbose say. Returns the new HEAD sha.
 * Errors (err.kind): 'empty-message' (blank message; git never runs), 'nothing-to-commit'
 * (nothing staged and not amending), 'hook-failed' (pre-commit / prepare-commit-msg /
 * commit-msg exited non-zero; message = the hook's output, at most ~4k chars), 'conflicts'
 * (unmerged paths, like pull / stash), 'aborted' / 'timeout'; anything else is git's GitError as is.
 */
async function commit(cwd, message, { amend = false, only = false } = {}) {
  // messageRule's type and blank checks (a NUL byte is left to git, which refuses it).
  if (['type', 'blank'].includes(messageProblem(message, { max: Infinity }))) throw kindError('empty-message', 'Commit message cannot be empty');
  const args = ['commit', '--file=-', '--quiet', '--cleanup=whitespace', '--no-verbose'];
  if (amend) args.push('--amend');
  if (only) args.push('--only');
  try {
    await run(cwd, args, { input: message });
  } catch (err) {
    throw await commitError(cwd, err);
  }
  return (await headState(cwd)).sha;
}

/** A failed `git commit`'s error, classified: nothing-to-commit | conflicts | hook-failed (or as is). */
async function commitError(cwd, err) {
  if (!gitErrors.unclassified(err)) return err;
  if (gitErrors.matches(err, 'nothingToCommit')) {
    return tagError(err, 'nothing-to-commit', { message: 'Nothing to commit: no changes are staged' });
  }
  if (gitErrors.matches(err, 'unmerged')) return tagError(err, 'conflicts');
  if (err.exitCode === 1 && (await hookRefused(cwd, err, COMMIT_HOOKS))) {
    return tagError(err, 'hook-failed', { message: hookOutput(err.stderr || err.stdout) });
  }
  return err;
}

// ---------------------------------------------------------------- branches

/** Local changes block the switch (they are then autostashed): git.errors' 'overwritten' rule. */
const blockedByChanges = (err) => err instanceof GitError && gitErrors.matches(err, 'overwritten');

async function checkoutArgs(cwd, ref, kind) {
  if (kind === 'commit') return ['checkout', '-q', '--detach', ref];
  if (kind === 'remote') {
    const { branch } = splitRemoteRef(ref, await remotes(cwd));
    await validateBranchName(cwd, branch, 'local branch name');
    if (!(await refExists(cwd, fullBranch(branch)))) {
      return ['checkout', '-q', '-b', branch, '--track', `refs/remotes/${ref}`];
    }
    // Reuse the local branch only when it already tracks this remote branch.
    const up = await upstreamOf(cwd, branch);
    if (!up || up.ref !== `refs/remotes/${ref}`) {
      throw kindError('local-exists', `A local branch '${branch}' already exists and does not track '${ref}'`, { branch });
    }
    return ['checkout', '-q', '--no-guess', branch, '--'];
  }
  // --no-guess: a name with no local branch must fail, not DWIM-create a tracking branch.
  return ['checkout', '-q', '--no-guess', ref, '--'];
}

/** A branch checked out in another worktree can't be checked out here (kind 'checked-out-elsewhere'). */
const elsewhere = (err) => gitErrors.classify(err, ['checkedOutElsewhere']);

async function checkout(cwd, ref, { kind = 'local' } = {}) {
  const args = await checkoutArgs(cwd, ref, kind);
  try {
    await run(cwd, args);
  } catch (err) {
    if (!blockedByChanges(err)) throw elsewhere(err);
    await withAutostash(cwd, () => run(cwd, args).catch((e) => { throw elsewhere(e); }));
  }
  const { branch, sha } = await headState(cwd);
  return { branch, oid: sha };
}

/**
 * Throw kind 'invalid-args' unless `name` is a valid branch name by git's own rules
 * (`check-ref-format --branch`, which also rejects `* : ^ ~ ? [ \`, spaces, '..', '@{', 'HEAD';
 * the output must equal the input, so '@{-1}'-style shorthands never expand) and doesn't start
 * with '-'.
 */
async function validateBranchName(cwd, name, what = 'branch name') {
  const bad = () => kindError('invalid-args', `Invalid ${what}: '${name}'`);
  if (typeof name !== 'string' || !name || name.startsWith('-') || /[\0\n]/.test(name)) throw bad();
  const norm = await tryOut(cwd, ['check-ref-format', '--branch', name]);
  if (norm === null || norm.replace(/\n$/, '') !== name) throw bad();
  return name;
}

/**
 * Create branch `name` at `start`; with checkout, switch to it. Local changes that block the
 * switch are auto-stashed and re-applied as for checkout (withAutostash: kind 'stash-conflict'
 * or err.stashKept; git creates the branch only once the switch succeeds).
 */
async function createBranch(cwd, name, { start = 'HEAD', checkout: doCheckout = false } = {}) {
  await validateBranchName(cwd, name);
  if (doCheckout) {
    const args = ['switch', '-q', '--no-track', '-c', name, start];
    try {
      await run(cwd, args);
    } catch (err) {
      if (!blockedByChanges(err)) throw err;
      await withAutostash(cwd, () => run(cwd, args));
    }
  } else {
    await run(cwd, ['branch', '--no-track', name, start]);
  }
  return { name, sha: (await out(cwd, ['rev-parse', '--verify', fullBranch(name)])).trim() };
}

/** Delete a local branch; returns what was deleted so undo can recreate it. */
async function deleteBranch(cwd, name, { force = false } = {}) {
  if (await isCurrentBranch(cwd, name)) throw kindError('current-branch', `Cannot delete the current branch '${name}'`);
  const row = await refFields(cwd, fullBranch(name), ['%(objectname)', '%(upstream:short)']);
  if (!row) throw kindError('not-found', `Branch '${name}' not found`);
  const [sha, upstream] = row;
  return removeBranch(cwd, { name, sha, upstream: upstream || null }, { force });
}

/**
 * Every local branch in one for-each-ref: Map name -> {sha, upstream (short name) | null}. What
 * several deletes check their names against (instead of a lookup per branch).
 */
async function branchTips(cwd) {
  const raw = await out(cwd, ['for-each-ref', `--format=${['%(refname)', '%(objectname)', '%(upstream:short)'].join('%00')}`, 'refs/heads']);
  const tips = new Map();
  for (const line of raw.split('\n')) {
    const [ref, sha, upstream] = line.split('\0');
    const name = ref ? branchOf(ref) : null;
    if (name !== null) tips.set(name, { sha, upstream: upstream || null });
  }
  return tips;
}

/**
 * `git branch -d` (force: -D) of local branch {name, sha, upstream} the caller already looked up
 * (deleteBranch, or branchTips with HEAD checked); resolves to it. Kinds: 'not-merged',
 * 'checked-out-elsewhere'.
 */
async function removeBranch(cwd, { name, sha, upstream }, { force = false } = {}) {
  try {
    await run(cwd, ['branch', force ? '-D' : '-d', name]);
  } catch (err) {
    // Not fully merged (force deletes it), or "cannot delete branch 'x' used by worktree at
    // '<path>'" (or "checked out at"): a linked worktree has it checked out (from a bare repo or
    // from another worktree); git's message kept.
    throw gitErrors.classify(err, ['notFullyMerged', 'checkedOutElsewhere']);
  }
  return { name, sha, upstream: upstream || null };
}

module.exports = {
  OID, REFSPEC_SAFE, splitN, trimTrailingNewlines,
  validateBranchName, isUntracked,
  root, bareGitDir, isBare, riskyLocalConfig, riskyHooks, worktrees, refs, log,
  commitFiles, diffCommitFile, diffWorkdir,
  stage, stageAll, unstage, unstageAll, discard, argvChunks,
  commit, lastCommit, commitInfo, commitError,
  checkout, createBranch, deleteBranch, branchTips, removeBranch,
  // The modules git.js builds on, re-exported: this is the facade main.js, ops and tests use.
  status, PULL_MODES, pull,
  REMOTE_TIMEOUT_MS: remote.REMOTE_TIMEOUT_MS, mirrorRemotes: remote.mirrorRemotes, writesBranches: remote.writesBranches,
  fetch: remote.fetch, push: remote.push, setUpstream: remote.setUpstream,
  verify, refExists, resolveCommit, remotes, upstreamOf, isCurrentBranch,
  commitPaths: reads.commitPaths,
  hasHook: hooks.hasHook, hasCommitHook: hooks.hasCommitHook, hookOutput, HOOK_OUTPUT_MAX: hooks.HOOK_OUTPUT_MAX,
  stashes: stash.stashes, stashIndexOf: stash.stashIndexOf, stashPush: stash.stashPush, stashApply: stash.stashApply,
  stashDrop: stash.stashDrop, stashPop: stash.stashPop, trackedChanges: stash.trackedChanges,
  reapplyStash: stash.reapplyStash, withAutostash,
};
