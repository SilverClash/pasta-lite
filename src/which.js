'use strict';
// Finding programs on PATH without ever picking one from the current folder (the repo). Pure
// Node: used by exec.js (the git to spawn), gitcheck.js and shell.js (terminals).
const fs = require('node:fs');
const path = require('node:path');

/** True when `p` is a regular file this process may run (on Windows: any regular file). */
function isRunnable(p, platform = process.platform) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The PATH value of `env` (Windows spells the key 'Path'; keys are case-insensitive there). */
function pathValue(env, platform) {
  if (platform !== 'win32') return env.PATH || '';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key ? env[key] || '' : '';
}

/**
 * Absolute path of the first `name` (e.g. 'git', 'git.exe') on env's PATH, or null. Only absolute
 * PATH entries count: empty entries and '.' (which mean the current folder) and relative ones are
 * skipped, so a program planted in the repo folder is never picked. Callers spawn the result
 * instead of the bare name, because Windows' own lookup searches the child's cwd (the repo) first.
 * @param {{env?: object, platform?: string, isFile?: (p: string) => boolean}} [o]
 */
function findOnPath(name, { env = process.env, platform = process.platform, isFile = (p) => isRunnable(p, platform) } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  for (const dir of pathValue(env || {}, platform).split(platform === 'win32' ? ';' : ':')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1'); // Windows allows quoted entries
    if (!d || d === '.' || !P.isAbsolute(d)) continue;
    const full = P.join(d, name);
    if (isFile(full)) return full;
  }
  return null;
}

module.exports = { findOnPath, isRunnable };
