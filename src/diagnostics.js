'use strict';
// Crash-report options and the Help → Copy Diagnostics text. Pure Node, no Electron.
//
// Local only: crash dumps stay in app.getPath('crashDumps') and nothing is uploaded. A remote
// uploader would plug in at crashReporterOptions(): it must stay behind an explicit user opt-in
// (a setting that defaults to off, asked for in the UI), and would add submitURL /
// uploadToServer: true only then. None exists today.
const nodeFs = require('node:fs');
const path = require('node:path');
const { redactString } = require('./redact');

/** Options for crashReporter.start. `optIn` is reserved for a future, user-approved uploader. */
function crashReporterOptions({ optIn = false } = {}) {
  void optIn; // NOSONAR(S3735): marks the reserved option as read; no uploader exists, dumps stay on disk only
  return { uploadToServer: false, compress: true };
}

/**
 * Crash dump files under `dir` (Crashpad keeps them in completed/, pending/, new/ ...), newest
 * first: [{name, rel, mtime}]. Never throws; at most `limit`.
 */
function listCrashDumps(dir, { fs = nodeFs, limit = 20 } = {}) {
  const found = [];
  const walk = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(p, depth + 1);
      } else if (/\.dmp$/i.test(e.name)) {
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch { /* gone meanwhile */ }
        found.push({ name: e.name, rel: path.relative(dir, p), mtime });
      }
    }
  };
  if (dir) walk(dir, 0);
  return found.toSorted((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/**
 * The clipboard text for Copy Diagnostics: versions, folders, recent crash dump names and the
 * last log lines (already redacted when written; redacted again here). No repository contents.
 * @param {{app: {name, version, packaged}, versions: object, platform: object, git: {version, path},
 *   logDir, crashDir, dumps: {rel, mtime}[], lines: string[]}} d
 */
function buildDiagnostics(d) {
  const v = d.versions || {};
  const p = d.platform || {};
  const out = [
    `${d.app.name} ${d.app.version}${d.app.packaged ? '' : ' (unpackaged)'}`,
    `Electron ${v.electron || '?'} · Chrome ${v.chrome || '?'} · Node ${v.node || '?'} · V8 ${v.v8 || '?'}`,
    `OS: ${p.platform || '?'} ${p.release || ''} (${p.arch || '?'})`,
    `git: ${d.git && d.git.version ? d.git.version : 'not found'}${d.git && d.git.path ? ` (${d.git.path})` : ''}`,
    `Logs: ${d.logDir || '(none)'}`,
    `Crash reports: ${d.crashDir || '(none)'}`,
    '',
    `Recent crash dumps (${(d.dumps || []).length}):`,
    ...((d.dumps || []).length ? d.dumps.map((x) => `  ${x.rel}  ${x.mtime ? new Date(x.mtime).toISOString() : ''}`) : ['  (none)']),
    '',
    `Last ${(d.lines || []).length} log lines:`,
    ...(d.lines || []),
  ];
  return out.map((l) => redactString(l, 20000)).join('\n');
}

module.exports = { crashReporterOptions, listCrashDumps, buildDiagnostics };
