'use strict';
// Help menu and crash UI: the logs and crash-dump folders, Copy Diagnostics, and the
// Reload / Quit prompt when one of our pages dies. The text itself is src/diagnostics.js.
const fs = require('node:fs');
const os = require('node:os');
const { app, clipboard, shell: electronShell } = require('electron');
const { logger } = require('../src/log');
const { listCrashDumps, buildDiagnostics } = require('../src/diagnostics');
const { APP_NAME } = require('./window');

const log = logger.child('main');
const crashLog = logger.child('crash');

/** app.getPath(name), or null when Electron can't tell (never throws). */
function appPath(name) {
  try {
    return app.getPath(name);
  } catch {
    return null;
  }
}
const logsDir = () => logger.dir || appPath('logs');
const crashDir = () => appPath('crashDumps');

/** Help → Show Logs / Show Crash Reports: open the folder in the file manager (created if missing). */
async function showFolder(dir) {
  if (!dir) throw new Error('This folder is not available');
  fs.mkdirSync(dir, { recursive: true });
  const err = await electronShell.openPath(dir); // '' on success
  if (err) throw new Error(err);
}

/**
 * @param {{
 *   ui: {confirm(o: object): Promise<boolean>},
 *   showBox: (o: object) => Promise<{response: number}>,
 *   windowAlive: () => boolean,
 *   quit: () => void,
 *   git: () => {gitVersion: string|null, gitPath: string|null},
 * }} o  quit: the Quit answer of the crash prompt (the quit flow).
 */
function createDiagnosticsUi({ ui, showBox, windowAlive, quit, git }) {
  /**
   * The Copy Diagnostics text (src/diagnostics.js): versions, folders, crash dump names and the last
   * 200 log lines, all redacted. No repository contents: the log never has any.
   */
  async function diagnosticsText() {
    await logger.flush();
    const dumps = listCrashDumps(crashDir(), { limit: 10 });
    const lines = await logger.tail(200);
    const { gitVersion, gitPath } = git();
    return buildDiagnostics({
      app: { name: APP_NAME, version: app.getVersion(), packaged: app.isPackaged },
      versions: process.versions,
      platform: { platform: process.platform, release: os.release(), arch: process.arch },
      git: { version: gitVersion, path: gitPath },
      logDir: logsDir(),
      crashDir: crashDir(),
      dumps,
      lines,
    });
  }

  /** Help → Copy Diagnostics: to the clipboard, then say what was copied. */
  async function copyDiagnostics() {
    const text = await diagnosticsText();
    clipboard.writeText(text);
    log.info('diagnostics copied to the clipboard', { chars: text.length });
    await showBox({
      type: 'info',
      message: 'Diagnostics copied to the clipboard',
      detail: 'App, Electron, OS and git versions, the recent log lines and crash report names. Log lines are redacted (no tokens, passwords or file contents). Paste them into your bug report.',
      buttons: ['OK'],
    });
  }

  let crashPrompt = null; // the Reload / Quit question while it is open (one at a time)

  /**
   * One of our pages died (a tab's or the strip): offer Reload (main's state, the open repos and git
   * ops are intact) or Quit.
   */
  function offerReload(contents, details, what) {
    if (crashPrompt || !windowAlive()) return;
    const opts = {
      type: 'error',
      message: `The ${what} stopped working`,
      detail: `Its renderer process ended (${details.reason}, exit code ${details.exitCode}). Reload to continue: git operations run in the main process and are not affected. See Help → Show Logs for details.`,
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    crashPrompt = ui.confirm(opts)
      .then((reload) => {
        crashLog.info('renderer crash prompt', { choice: reload ? 'reload' : 'quit' });
        if (!reload) quit();
        else if (!contents.isDestroyed()) contents.reload();
      })
      .catch((err) => crashLog.error('renderer crash prompt failed', { err }))
      .finally(() => { crashPrompt = null; });
  }

  return { appPath, logsDir, crashDir, showFolder, diagnosticsText, copyDiagnostics, offerReload };
}

module.exports = { createDiagnosticsUi, appPath, logsDir, crashDir };
