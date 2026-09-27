'use strict';
// Repo-trust policy: may a repository whose own config or hooks run commands be
// opened? A folder from elsewhere could otherwise run a filter driver on the first `status`, a
// hook on the first commit or checkout (a bare one on the first fetch). Free of Electron: the git checks, the
// trust store and the dialog are passed in.
const path = require('node:path');
const { kindError } = require('./exec');

/**
 * Warning dialog text before opening `root`, whose own config can run commands (`keys` from
 * git.riskyLocalConfig) or whose hooks folder has hooks git runs ('hooks/<name>' from
 * git.riskyHooks): {message, detail}.
 */
function describeRiskyConfig(root, keys) {
  const hooks = keys.filter((k) => k.startsWith('hooks/'));
  const config = keys.filter((k) => !k.startsWith('hooks/'));
  return {
    message: `"${path.basename(root)}" has settings that run commands`,
    detail: [
      ...(config.length ? [`The repository's own git config (${root}) sets:`, '', ...config.map((k) => `  ${k}`), ''] : []),
      ...(hooks.length ? [`The repository (${root}) has hooks that git runs:`, '', ...hooks.map((k) => `  ${k}`), ''] : []),
      'Git runs these programs while Pasta Lite shows or changes the repository (for example on',
      'status, fetch or commit). Only open it if you trust where this folder came from.',
    ].join('\n'),
  };
}

/** The Trust and Open question: a destructive choice, so Cancel is the default (Enter / Esc). */
const trustDialog = (root, keys) => ({
  type: 'warning', ...describeRiskyConfig(root, keys), buttons: ['Trust and Open', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
});

/**
 * @param {{
 *   git: {riskyLocalConfig(root: string): Promise<string[]>, riskyHooks(root: string): Promise<string[]>},
 *   store: () => {isTrusted(root: string, keys: string[]): boolean, trust(root: string, keys: string[]): void},
 *   ui: {interactive: boolean, confirm(options: object): Promise<boolean>},
 *   log: {info(msg: string, fields?: object): void, warn(msg: string, fields?: object): void},
 * }} o  store: the trust store (trusted.json), read when asked (main creates it at start).
 *   ui.confirm: the native dialog, true for its first button.
 * @returns {{confirm(root: string): Promise<boolean>}}
 *   confirm: true when `root` may be opened: its own config runs no commands and its hooks
 *   folder has no hook git would run (bare or not), the user already trusted it for those keys,
 *   or agrees now ("Trust and Open"; remembered, best effort). False when the user declined.
 *   Not interactive (smoke runs): never asks, rejects with kind 'untrusted'.
 */
function createRepoTrust({ git, store, ui, log }) {
  async function confirm(root) {
    const [config, hooks] = await Promise.all([git.riskyLocalConfig(root), git.riskyHooks(root)]);
    const keys = [...config, ...hooks];
    if (!keys.length) return true;
    // Config key names only ('risky'), never their values (a credential helper line can hold a token).
    if (store().isTrusted(root, keys)) {
      log.info('repo config runs commands: trusted earlier', { repo: root, risky: keys });
      return true;
    }
    if (!ui.interactive) {
      log.warn('repo config runs commands: refused (smoke)', { repo: root, risky: keys });
      throw kindError('untrusted', `Refusing to open ${root}: its config runs commands (${keys.join(', ')})`);
    }
    const yes = await ui.confirm(trustDialog(root, keys));
    log.info(`repo config runs commands: ${yes ? 'trusted by the user' : 'declined'}`, { repo: root, risky: keys });
    if (!yes) return false;
    try {
      store().trust(root, keys);
    } catch (err) {
      log.warn('could not save the trusted repositories', { err }); // opens this time only
    }
    return true;
  }
  return { confirm };
}

module.exports = { createRepoTrust, describeRiskyConfig };
