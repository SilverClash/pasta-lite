'use strict';
// Main-process lifecycle of the file watcher. Pure Node, no Electron: main.js passes
// watcher.createWatcher and its send(); tests pass fakes.
//
// At most one watcher, for the open repo's root. It is paused while one of our own writes runs on
// that root (runner 'busy' events; pauses nest, and a watcher created mid-write starts paused as
// many times as writes are running). A watcher that reported 'gone' or 'error' (it closed itself)
// is dropped; retry() recreates it at most once every retryMs, and only when asked (app:getState,
// window focus), never from a timer, so a repo that keeps failing can't loop. 'gone' also calls
// onGone(repo), so main can close a repo whose folder was deleted or moved.
//
// Tabs: main keeps one session per tab. A background tab's session is paused
// (pause()): its watcher keeps collecting changes but emits nothing; resume() (the tab is shown
// again) emits at most one batch with everything collected. This pause is a flag, not a count, and
// stacks with the write pauses; a watcher created while paused starts paused.

const { logger } = require('./log');
const { EVENTS } = require('./ipc-contract');

const RETRY_MS = 30000;
const defaultLog = logger.child('watcher');

/**
 * @param {{
 *   createWatcher: (root: string, o: {onEvent: (e: object) => void}) => {pause(), resume(), close()},
 *   send: (channel: string, payload: object) => void,
 *   onGone?: (repo: string) => void,
 *   now?: () => number, retryMs?: number, log?: (message: string, error: unknown) => void,
 *   info?: (message: string, fields: object) => void,
 * }} o  log: failures (default: the shared logger's 'watcher' scope, warn); info: lifecycle
 *   records (watching / stopped / gone / retry; default the same scope, info).
 * Sends 'watch' {repo, kinds, paths?, error?}: repo is the root given to open() (the string the
 * runner's 'busy' / 'changed' events carry), kinds / paths as the watcher reported them, error the
 * failure's message (kinds ['error'] only). onGone runs after the 'gone' event was sent.
 * @returns {{open(root: string): void, close(): void, busy(e: {repo: string, running: boolean}): void,
 *   retry(): boolean, pause(): void, resume(): void, readonly root: string|null, readonly active: boolean,
 *   readonly paused: boolean}}
 */
function createWatchSession({
  createWatcher, send, onGone = () => {}, now = Date.now, retryMs = RETRY_MS,
  log = (message, err) => defaultLog.warn(message, { err }), info = (message, fields) => defaultLog.info(message, fields),
}) {
  let root = null; // the repo being watched (null: none open)
  let handle = null; // {w} of the live watcher; events from any other (replaced, closed) one are dropped
  let failedAt = null; // when the last watcher for `root` went away or the last retry started
  const running = new Map(); // repo -> our writes running on it (every repo: a write may outlive a switch)
  let paused = false; // a background tab (pause() / resume()); kept across open / close / retry

  const payload = (repo, e) => {
    const p = { repo, kinds: [...(e.kinds || [])] };
    if (Array.isArray(e.paths)) p.paths = [...e.paths];
    if (e.error) p.error = String(e.error.message || e.error);
    return p;
  };

  function onEvent(mine, repo, e) {
    if (mine !== handle) return;
    const kinds = e.kinds || [];
    if (kinds.includes('gone') || kinds.includes('error')) {
      handle = null; // it closed itself
      failedAt = now();
      if (kinds.includes('error')) log(`stopped watching ${repo}:`, e.error);
      else info('watched folder is gone', { repo });
    }
    send(EVENTS.WATCH, payload(repo, e));
    if (kinds.includes('gone')) onGone(repo);
  }

  function start() {
    const repo = root;
    const mine = {};
    try {
      mine.w = createWatcher(repo, { onEvent: (e) => onEvent(mine, repo, e) });
    } catch (err) {
      failedAt = now();
      log(`could not watch ${repo}:`, err);
      send(EVENTS.WATCH, payload(repo, { kinds: ['error'], error: err }));
      return;
    }
    handle = mine;
    info('watching', { repo });
    for (let n = running.get(repo) || 0; n > 0; n--) mine.w.pause();
    if (paused) mine.w.pause();
  }

  function stop() {
    const h = handle;
    handle = null;
    if (h) {
      info('stopped watching', { repo: root });
      try {
        h.w.close();
      } catch (err) {
        log('close failed:', err);
      }
    }
  }

  return {
    /** Watch `repoRoot` (replacing any watcher, and resetting the retry backoff). */
    open(repoRoot) {
      stop();
      root = repoRoot;
      failedAt = null;
      start();
    },
    /** Stop watching (repo closed, window destroyed, quit). Idempotent. */
    close() {
      stop();
      root = null;
      failedAt = null;
    },
    /** Runner 'busy' event: pause the watcher while our own write runs on its repo. */
    busy({ repo, running: on } = {}) {
      const before = running.get(repo) || 0;
      if (!on && before === 0) return; // unbalanced end: nothing was paused for it
      const n = before + (on ? 1 : -1);
      if (n > 0) running.set(repo, n);
      else running.delete(repo);
      if (!handle || repo !== root) return;
      if (on) handle.w.pause();
      else handle.w.resume();
    },
    /**
     * Recreate a watcher that went away ('gone' / 'error'), at most once every retryMs.
     * True when a new one was started.
     */
    retry() {
      if (!root || handle) return false;
      if (failedAt !== null && now() - failedAt < retryMs) return false;
      failedAt = now();
      info('retrying the watcher', { repo: root });
      start();
      return !!handle;
    },
    /** The tab went to the background: hold the watcher's events until resume(). Idempotent. */
    pause() {
      if (paused) return;
      paused = true;
      if (handle) handle.w.pause();
    },
    /** The tab is shown again: the watcher emits what it collected meanwhile (one batch). Idempotent. */
    resume() {
      if (!paused) return;
      paused = false;
      if (handle) handle.w.resume();
    },
    get root() { return root; },
    get active() { return !!handle; },
    get paused() { return paused; },
  };
}

module.exports = { createWatchSession, RETRY_MS };
