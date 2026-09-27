'use strict';
// The runner's gate for bare repositories: which op (with which args) is refused
// before validation and before the write queue starts it, so a refusal runs no git of its own
// and a write emits no busy / changed events. The op registry (ops.js) says per op whether it
// works in a bare repo; this module decides for one call.
const { kindError } = require('./exec');
const { isBare } = require('./repo-dirs');
const git = require('./git');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The refusal of `name` in a bare repository (kind 'bare-repo'). */
const bareRefusal = (name) => kindError('bare-repo', `${name} needs a working tree: this is a bare repository`);

/**
 * The refusal of fetch / pull / createBranch in a bare repo whose fetch writes local branches
 * (git.mirrorRemotes: a `git clone --mirror`), kind 'mirror-repo', or null. A fetch there
 * force-updates every branch to the remote's and deletes the ones the remote lacks (--prune), so
 * a branch made here, and commits on it, would be gone without an undo. Fetch of another remote
 * is still allowed. The mirror is left to git in a terminal (`git remote update`), where that is
 * what the user asked for.
 */
async function mirrorRefusal(repo, name, args) {
  let mirrors = await git.mirrorRemotes(repo);
  const only = name === 'fetch' && isObj(args[0]) && typeof args[0].remote === 'string' ? args[0].remote : null;
  if (only !== null) mirrors = mirrors.filter((m) => m.remote === only);
  if (!mirrors.length) return null;
  const { remote, why } = mirrors[0];
  const what = name === 'createBranch'
    ? `A branch made here would be overwritten or deleted by the next fetch of '${remote}'`
    : `Fetching '${remote}' would overwrite local branches and delete the ones it lacks`;
  return kindError('mirror-repo', `This is a mirror repository (${why}). ${what}: update the mirror with git in a terminal.`, { remotes: mirrors.map((m) => m.remote) });
}

/**
 * Why the runner refuses `name` (with `args`) in `repo` before anything runs, or null.
 * `desc` is the op's gate descriptor {bare, mirror} (ops.js): `bare` true (works in a bare repo),
 * false (needs a working tree) or a function (args) -> the name to refuse for these args, or null;
 * `mirror` true: refused in a mirror. No descriptor counts as bare: false (an allow-list).
 * Only a bare repo refuses anything: an op that needs a working tree (kind 'bare-repo'), one
 * refused by its arguments, and a mirror-guarded op in a mirror. repo-dirs.isBare is cached, so a
 * normal repo pays one lstat once; the ops that work in a bare repo and can't be refused never ask.
 */
async function bareGate(repo, name, args, desc) {
  if (!desc || !desc.bare) return (await isBare(repo)) ? bareRefusal(name) : null;
  const byArgs = typeof desc.bare === 'function' ? desc.bare(args) : null;
  if (!byArgs && !desc.mirror) return null;
  if (!(await isBare(repo))) return null;
  if (byArgs) return bareRefusal(byArgs);
  return mirrorRefusal(repo, name, args);
}

module.exports = { bareRefusal, mirrorRefusal, bareGate };
