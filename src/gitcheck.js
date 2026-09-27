'use strict';
// Startup check: find a git that is new enough (undo needs `git reflog write`).
// Apps launched from Finder/Dock get launchd's PATH (/usr/bin first → Apple Git, often too old),
// so the user's login-shell PATH and the usual package-manager locations are tried as well.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { findOnPath } = require('./which');

const MIN_VERSION = [2, 51, 0];

/**
 * [major, minor, patch] from `git --version` output or a bare version, or null.
 * Handles "git version 2.51.2", "2.39.3 (Apple Git-145)", "2.51.0.windows.1", "2.52.0-rc1".
 */
function parseVersion(text) {
  const m = /(?:^|\s)(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || '').replace(/^\s*git version/i, ' '));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/** <0, 0 or >0 like a sort comparator. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Evaluate `git --version` output: {ok, version, error}. */
function evaluate(output) {
  const v = parseVersion(output);
  if (!v) return { ok: false, version: null, error: `Could not read the git version from: ${String(output).trim() || '(no output)'}` };
  const version = v.join('.');
  if (compareVersions(v, MIN_VERSION) < 0) {
    return { ok: false, version, error: `Pasta Lite needs git ${MIN_VERSION.join('.')} or newer, but found git ${version}. Please update git.` };
  }
  return { ok: true, version, error: null };
}

/** The first git on PATH as an absolute path (absolute PATH entries only), or null. */
const pathGit = ({ env = process.env, platform = process.platform } = {}) =>
  findOnPath(platform === 'win32' ? 'git.exe' : 'git', { env, platform });

const NOT_FOUND = 'git was not found. Install git 2.51 or newer and make sure it is on your PATH.';

/**
 * Run `git --version` (gitPath overridable for tests; default: the git on PATH) and evaluate it.
 * Only an absolute gitPath is run: a bare name could be found in the current folder on Windows.
 * Never rejects.
 */
function checkGit({ gitPath = pathGit(), timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    if (!gitPath || !path.isAbsolute(gitPath)) {
      resolve({ ok: false, version: null, error: gitPath ? `Refusing to run git from a relative path: ${gitPath}` : NOT_FOUND });
      return;
    }
    execFile(gitPath, ['--version'], { timeout, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      if (err) {
        const missing = err.code === 'ENOENT';
        resolve({
          ok: false,
          version: null,
          error: missing
            ? NOT_FOUND
            : `Running "git --version" failed: ${err.message}`,
        });
      } else {
        resolve(evaluate(stdout));
      }
    });
  });
}

// Finder/Dock launches may lack $SHELL; fall back to the account's login shell.
const defaultShell = () => process.env.SHELL || (() => { try { return os.userInfo().shell; } catch { return null; } })();

/** Absolute path of `git` on the user's login-shell PATH, or null. Never rejects. */
function loginShellGit({ shell = defaultShell(), timeout = 5000 } = {}) {
  if (!shell || process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', 'command -v git'], { timeout, env: process.env }, (err, stdout) => {
      if (err) return resolve(null);
      // rc files may print banners: take the last line that is an absolute path.
      const line = String(stdout).split('\n').map((l) => l.trim()).filter((l) => path.isAbsolute(l)).pop();
      resolve(line || null);
    });
  });
}

const WELL_KNOWN = process.platform === 'win32' ? [] : ['/opt/homebrew/bin/git', '/usr/local/bin/git'];

/**
 * Try candidate git binaries in order and return the first new enough:
 * {ok, version, path, error, tried:[{path, version, error}]}. Default candidates: the login
 * shell's git, the usual package-manager locations, then the git on PATH (pathGit). `path` is
 * always absolute: a relative candidate is never run (checkGit refuses it), so a git.exe planted
 * in a repo can't be picked up. On failure, `error` describes the best (newest) git found, or
 * that none was found. Never rejects.
 */
async function findGit({ candidates } = {}) {
  const list = candidates || [await loginShellGit(), ...WELL_KNOWN, pathGit()].filter(Boolean);
  const seen = new Set();
  const tried = [];
  for (const p of list) {
    const key = path.isAbsolute(p) ? (() => { try { return fs.realpathSync(p); } catch { return p; } })() : p;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await checkGit({ gitPath: p });
    tried.push({ path: p, version: r.version, error: r.error });
    if (r.ok) return { ...r, path: p, tried };
  }
  const found = tried.filter((t) => t.version).sort((a, b) => compareVersions(parseVersion(b.version), parseVersion(a.version)));
  const error = found.length
    ? `Pasta Lite needs git ${MIN_VERSION.join('.')} or newer, but the newest git found is ${found[0].version} (${found[0].path}). Please update git.`
    : 'git was not found. Install git 2.51 or newer (e.g. `brew install git`).';
  return { ok: false, version: found.length ? found[0].version : null, path: null, error, tried };
}

/** Dialog text for a failed findGit() result: the error plus every binary tried. */
function describeGitFailure(res) {
  const tried = (res && Array.isArray(res.tried) ? res.tried : []).map((t) => {
    const what = t.version ? `git ${t.version}` : 'not usable';
    const why = !t.version && t.error ? ` (${t.error})` : '';
    return `  ${t.path}: ${what}${why}`;
  });
  const head = (res && res.error) || 'No usable git was found.';
  return tried.length ? `${head}\n\nTried:\n${tried.join('\n')}` : head;
}

module.exports = { checkGit, findGit, describeGitFailure, loginShellGit, pathGit, parseVersion, compareVersions, evaluate };
