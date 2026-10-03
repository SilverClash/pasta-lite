'use strict';
// Real paths: how the app compares folders. git may print /var/... for what the app opened as
// /private/var/... (macOS) or the other way round, and a symlinked spelling of a repo is the same
// repo. realPathSync is for paths the app holds itself (a tab's root, the recent list), which are
// local and were just used; realPathOf is for paths git lists (a linked worktree may sit on a
// stale network mount): async and bounded by a timeout, so the main process never blocks on one.
// Both use the native realpath, which gives the canonical case on a case-insensitive file system.
const fs = require('node:fs');
const path = require('node:path');

const REALPATH_TIMEOUT_MS = 2000;

/** `p` with every symlink resolved, or path.resolve(p) when it can't be (a missing folder). */
function realPathSync(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * {real, missing} for `p`, without blocking: `real` is `p` with every symlink resolved, or
 * path.resolve(p) when it can't be; `missing` is true only when `p` doesn't exist (ENOENT, or a
 * file where a folder should be: ENOTDIR). An answer that takes longer than `timeout` ms (a hung
 * mount) or fails otherwise is {real: path.resolve(p), missing: false}: unknown is not gone.
 */
async function realPathOf(p, { timeout = REALPATH_TIMEOUT_MS } = {}) {
  const abs = path.resolve(p);
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ real: abs, missing: false }), timeout);
  });
  const look = fs.promises.realpath(abs).then(
    (real) => ({ real, missing: false }),
    (err) => ({ real: abs, missing: err.code === 'ENOENT' || err.code === 'ENOTDIR' }),
  );
  try {
    return await Promise.race([look, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** True when real path `inner` is `outer` or inside it. */
const isAtOrUnder = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);

module.exports = { REALPATH_TIMEOUT_MS, realPathSync, realPathOf, isAtOrUnder };
