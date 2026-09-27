'use strict';
// Argument validation of the ops (src/ops.js, src/ops-rebase.js): everything the renderer sends
// is checked here before any git runs. Each check throws kind 'invalid-args' (or the kind named)
// and returns the value in the form the git layer takes. The async ones ask the repo.
const path = require('node:path');
const { kindError } = require('./exec');
const { OID, isRefspecSafe, fullBranch } = require('./gitref');
const git = require('./git');
const { messageRule } = require('./message-rule');

const invalid = (msg) => kindError('invalid-args', msg);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const opts = (v) => {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw invalid('options must be an object');
  return v;
};

function str(v, what, { optional = false } = {}) {
  if (optional && (v === undefined || v === null)) return undefined;
  if (typeof v !== 'string' || !v || v.includes('\0')) throw invalid(`${what} must be a non-empty string`);
  return v;
}

const bool = (v) => v === true;

// Path segments git (or NTFS) would treat as the .git folder: '.git', '.GIT', '.git.', '.git ',
// 8.3 short names 'GIT~1'. NTFS alternate data streams ('.git::$INDEX_ALLOCATION', 'GIT~1:x')
// name the folder too, so the part before a ':' is checked as well, and '::$' (a stream type) is
// refused anywhere. On macOS / Linux ':' is an ordinary file name character; on Windows it is
// never valid in a file name, so any ':' is refused there.
const GIT_ALIAS = [/^\.git[\s.]*$/i, /^git~\d+$/i];
const isGitAlias = (seg) => GIT_ALIAS.some((re) => re.test(seg) || re.test(seg.split(':')[0]));
const BAD_COLON = process.platform === 'win32' ? /:/ : /::\$/;

/**
 * A root-relative path that stays inside the worktree, spelled the way git lists it ('a/b.txt';
 * no '/x', '..', '.git/...', and no empty or '.' segments: 'a/./b', 'a//b' and 'a/' name the
 * same file as 'a/b' on disk but not in the index, so hunk ops would take it for untracked).
 */
function relPath(p, what = 'path') {
  str(p, what);
  const parts = p.split(/[\\/]/);
  if (path.isAbsolute(p) || BAD_COLON.test(p) // on Windows this also covers drive letters ('C:x')
      || parts.some((s) => s === '' || s === '.' || s === '..' || isGitAlias(s))) {
    throw invalid(`${what} must be a path inside the repository: '${p}'`);
  }
  return p;
}

function pathList(v, what = 'paths') {
  if (!Array.isArray(v) || !v.length) throw invalid(`${what} must be a non-empty array`);
  return v.map((p) => relPath(p, what));
}

/** git.discard's [{path, status}] (status '?' = untracked). */
function fileList(v) {
  if (!Array.isArray(v) || !v.length) throw invalid('files must be a non-empty array');
  return v.map((f) => {
    if (!isObj(f)) throw invalid('files must be [{path, status}]');
    return { path: relPath(f.path), status: typeof f.status === 'string' ? f.status : 'M' };
  });
}

/** hunks selection: [{hunk, lines?}] (deeper checks happen in hunks.js). */
function selection(v) {
  if (!Array.isArray(v) || !v.length) throw invalid('selection must be a non-empty array');
  return v.map((s) => {
    if (!isObj(s) || !Number.isInteger(s.hunk)) throw invalid('selection must be [{hunk, lines?}]');
    if (s.lines == null) return { hunk: s.hunk };
    if (!Array.isArray(s.lines) || !s.lines.every(Number.isInteger)) throw invalid('selection lines must be integers');
    return { hunk: s.hunk, lines: [...s.lines] };
  });
}

/**
 * {fingerprint} of the diff view the selection indexes: required, so a selection is never
 * applied to a diff the user did not see (a view without one, e.g. a typechange, a binary or a
 * rename, offers file-level actions only). Missing: kind 'invalid-args'.
 */
const selOpts = (o) => ({ fingerprint: str(opts(o).fingerprint, 'fingerprint (from the diff view)') });

function sha(v, what = 'sha') {
  if (typeof v !== 'string' || !OID.test(v)) throw invalid(`${what} must be a full object id`);
  return v;
}

function int(v, what, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(v) || v < min || v > max) throw invalid(`${what} must be an integer in ${min}..${max}`);
  return v;
}

/** log's `tips`: absent (undefined / null), a list of object ids, or one id. */
function tipsArg(tips) {
  if (tips === undefined || tips === null) return undefined;
  return Array.isArray(tips) ? tips.map((t) => sha(t, 'tip')) : sha(tips, 'tips');
}

/** Stash reference: index (number) or entry hash. */
const stashRef = (v) => (typeof v === 'number' ? int(v, 'stash index') : sha(v, 'stash'));

// Checks that ask the repo (async). All throw kind 'invalid-args'.

/** A configured remote's name: never a URL or path, so nothing is fetched from / pushed to elsewhere. */
async function remoteName(repo, v, what = 'remote') {
  const s = str(v, what);
  if (!(await git.remotes(repo)).includes(s)) throw invalid(`${what} must be a configured remote: '${s}'`);
  return s;
}

/** A valid branch name by git's rules (check-ref-format --branch). */
const branchName = (repo, v, what = 'branch') => git.validateBranchName(repo, str(v, what), what);

/** A valid name of an existing local branch. */
async function localBranch(repo, v, what = 'branch') {
  const b = await branchName(repo, v, what);
  if (!(await git.refExists(repo, fullBranch(b)))) throw invalid(`${what}: no local branch '${b}'`);
  return b;
}

/** Branch name used inside a push refspec: additionally no '+' (force) or other refspec syntax. */
function refspecSafe(b, what) {
  if (!isRefspecSafe(b)) throw invalid(`${what} must not contain refspec characters: '${b}'`);
  return b;
}

/** Any revision that names a commit, resolved to its full id (so git never sees the raw string). */
async function commitId(repo, v, what) {
  const oid = await git.resolveCommit(repo, str(v, what));
  if (!oid) throw invalid(`${what} is not a commit: '${v}'`);
  return oid;
}

/**
 * commit / commitAll message: messageRule (a non-blank string, else kind 'empty-message'; no NUL,
 * else 'invalid-args') with no size cap (the app's own commits never had one).
 */
const commitMessage = (message) => messageRule(message, { max: Infinity });

module.exports = {
  invalid, isObj, opts, str, bool, relPath, pathList, fileList, selection, selOpts, sha, int, tipsArg, stashRef,
  remoteName, branchName, localBranch, refspecSafe, commitId, commitMessage,
};
