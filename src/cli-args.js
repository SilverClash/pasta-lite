'use strict';
// The main process command line: a repo to open, or the --smoke dev harness (never in a packaged
// build). Pure: argv, cwd and the flags come in.
const path = require('node:path');

/**
 * Parse the main process argv: `{repo, smoke}`.
 *
 * Positional args after the executable (and, when run unpackaged as `electron .`, after the app
 * path) are taken; Electron/Chromium flags (anything starting with '-') are ignored.
 * `--smoke [<repo>] <out.png>` enables the smoke test, unless `allowSmoke` is false (packaged
 * builds): then `--smoke` and everything after it is ignored. Relative paths resolve against `cwd`.
 *
 * @param {string[]} argv process.argv (or the argv a second instance forwarded)
 * @param {{cwd?: string, defaultApp?: boolean, allowSmoke?: boolean}} [o] defaultApp =
 *   process.defaultApp (unpackaged); allowSmoke = !app.isPackaged
 */
function parseArgs(argv, { cwd = process.cwd(), defaultApp = false, allowSmoke = true } = {}) {
  const afterExe = argv.slice(1);
  let rest = afterExe;
  if (defaultApp) {
    const i = afterExe.findIndex((a) => !a.startsWith('-')); // the app path ('.')
    rest = i < 0 ? [] : afterExe.slice(i + 1);
  }
  const positional = (list) => list.filter((a) => a && !a.startsWith('-')).map((a) => path.resolve(cwd, a));
  const smokeAt = rest.indexOf('--smoke');
  if (smokeAt >= 0 && !allowSmoke) {
    rest = rest.slice(0, smokeAt);
  } else if (smokeAt >= 0) {
    const p = positional(rest.slice(smokeAt + 1));
    return { repo: null, smoke: p.length >= 2 ? { repo: p[0], out: p[1] } : { repo: null, out: p[0] || null } };
  }
  return { repo: positional(rest)[0] || null, smoke: null };
}

module.exports = { parseArgs };
