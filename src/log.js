'use strict';
// Structured, local-only logger. Pure Node, no dependencies, no Electron: main.js
// configures the shared instance with app.getPath('logs'); tests build their own with an
// injected fs / clock / scheduler / dir.
//
// - JSON lines {t, level, scope, msg, ...fields}; every record goes through redact() first.
// - Levels debug < info < warn < error; default info, PL_LOG_LEVEL overrides.
// - Writes are buffered and asynchronous (fs.appendFile), never block the caller and never throw.
//   A failed write (unwritable folder, disk full) switches the logger to stderr for good; it
//   never logs its own failures through itself, so it cannot loop.
// - Size-based rotation: main.log -> main.1.log -> ... main.<maxFiles-1>.log (the oldest dropped).
// - Before configure() (no folder yet) records wait in memory (bounded) and are written once a
//   folder is set; a logger that is never configured (unit tests of other modules) only keeps
//   the last few hundred in memory.
// - flush() (async) / flushSync() (quit, fatal errors) write out whatever is queued.
// Nothing here talks to the network.
const nodeFs = require('node:fs');
const path = require('node:path');
const { redact, redactString } = require('./redact');

/** A record's extra fields, redacted: an object as it is, another value as {value}, none as {}. */
function redactFields(f) {
  if (f && typeof f === 'object') return redact(f);
  return f === undefined ? {} : { value: redact(f) };
}

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const DEFAULT_LEVEL = 'info';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;
const FLUSH_MS = 200;
const MAX_QUEUE = 5000; // records waiting for the disk; older ones are dropped beyond it
const MAX_UNCONFIGURED = 500; // records kept before a folder is known
const MAX_LINE = 16 * 1024;
const RESERVED = new Set(['t', 'level', 'scope', 'msg']);

/** A level name ('WARN', ' debug ') -> 'warn' / 'debug'; anything else -> fallback. */
function parseLevel(v, fallback = DEFAULT_LEVEL) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return Object.hasOwn(LEVELS, s) ? s : fallback;
}

/** File name of rotation slot i: main.log, main.1.log, main.2.log ... */
const slotName = (base, i) => (i === 0 ? base : base.replace(/(\.[^.]*)?$/, (ext) => `.${i}${ext || ''}`));

const defaultSchedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
};

/**
 * @param {{dir?: string|null, file?: string, level?: string, mirror?: boolean,
 *   fs?: object, now?: () => number, schedule?: (fn, ms) => any, cancel?: (t) => void,
 *   stderr?: {write(s: string): any}, maxBytes?: number, maxFiles?: number, flushMs?: number,
 *   maxQueue?: number, env?: object}} [o]
 *   dir: the folder (null: not known yet, see configure). level: the threshold (default
 *   env.PL_LOG_LEVEL, else 'info'). mirror: also print each record to stderr as a readable line
 *   (dev and smoke runs).
 */
function createLogger(o = {}) {
  const fs = o.fs || nodeFs;
  const now = o.now || Date.now;
  const schedule = o.schedule || defaultSchedule;
  const cancel = o.cancel || clearTimeout;
  const stderr = o.stderr || process.stderr;
  const env = o.env || process.env;
  const maxBytes = o.maxBytes || MAX_BYTES;
  const maxFiles = Math.max(1, o.maxFiles || MAX_FILES);
  const flushMs = o.flushMs === undefined ? FLUSH_MS : o.flushMs;
  const maxQueue = o.maxQueue || MAX_QUEUE;
  const base = o.file || 'main.log';

  let threshold = parseLevel(o.level || env.PL_LOG_LEVEL);
  let mirror = !!o.mirror;
  let dir = null;
  let file = null;
  let size = 0;
  let failed = null; // why the file can't be written (then: stderr only)
  let configured = false;
  let queue = []; // lines (with '\n') not written yet
  let dropped = 0; // records dropped because the queue was full
  let timer = null;
  let writing = false;
  let waiters = [];

  const safeStderr = (s) => {
    try {
      stderr.write(s);
    } catch {
      /* nowhere left to write */
    }
  };

  function fail(why) {
    if (failed) return;
    failed = why;
    safeStderr(`[Pasta Lite] cannot write logs to ${file || dir}: ${why}; logging to stderr only\n`);
  }

  /** Point the logger at `newDir` (created if needed). Returns true when the file is writable. */
  function configure({ dir: newDir, level, mirror: m } = {}) {
    if (level !== undefined) threshold = parseLevel(level, threshold);
    if (m !== undefined) mirror = !!m;
    configured = true;
    failed = null;
    dir = newDir || null;
    file = dir ? path.join(dir, base) : null;
    size = 0;
    if (!dir) {
      fail('no log folder');
    } else {
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (typeof fs.accessSync === 'function') fs.accessSync(dir, nodeFs.constants.W_OK);
        try {
          size = fs.statSync(file).size;
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
      } catch (e) {
        fail(e.code || e.message);
      }
    }
    if (failed) {
      // Unwritable: what waited in memory goes to stderr now (a mirror already printed it).
      if (!mirror) for (const line of queue) safeStderr(line);
      queue = [];
    }
    kick();
    return !failed;
  }

  const enabled = (level) => LEVELS[level] >= LEVELS[threshold];

  function humanLine(rec) {
    const { level, scope, msg } = rec;
    // The fields past the fixed ones; the time is left out (stderr lines are read live).
    const rest = Object.fromEntries(Object.entries(rec).filter(([k]) => !RESERVED.has(k)));
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    return `[Pasta Lite] ${level} ${scope}: ${msg}${extra}\n`;
  }

  /** Build, redact and queue one record. Never throws. */
  function write(level, scope, msg, fields) {
    try {
      if (!Object.hasOwn(LEVELS, level) || !enabled(level)) return;
      const f = fields instanceof Error ? { err: fields } : fields;
      const safe = redactFields(f);
      const rec = { t: new Date(now()).toISOString(), level, scope: String(scope || 'app'), msg: redactString(msg == null ? '' : msg, 1000) };
      if (safe && typeof safe === 'object' && !Array.isArray(safe)) {
        for (const [k, v] of Object.entries(safe)) rec[RESERVED.has(k) ? `_${k}` : k] = v;
      }
      let line = JSON.stringify(rec);
      if (line.length > MAX_LINE) {
        line = JSON.stringify({ t: rec.t, level, scope: rec.scope, msg: rec.msg, truncated: line.length });
      }
      if (mirror) safeStderr(humanLine(rec));
      enqueue(`${line}\n`);
    } catch {
      /* a record that can't be built is dropped, never thrown at the caller */
    }
  }

  function enqueue(line) {
    if (configured && failed) {
      if (!mirror) safeStderr(line);
      return;
    }
    queue.push(line);
    const cap = configured ? maxQueue : MAX_UNCONFIGURED;
    if (queue.length > cap) {
      const n = queue.length - cap;
      queue.splice(0, n);
      dropped += n;
    }
    kick();
  }

  /** Schedule a write of the queue, or release flush() waiters when there is nothing (left) to do. */
  function kick() {
    if (writing || timer) return;
    if (!queue.length || !configured || failed || !file) {
      settleWaiters();
      return;
    }
    timer = schedule(() => {
      timer = null;
      drain();
    }, flushMs);
  }

  const call = (fn, ...args) => new Promise((resolve) => {
    try {
      fn.call(fs, ...args, (err) => resolve(err || null));
    } catch (e) {
      resolve(e);
    }
  });

  async function rotate() {
    for (let i = maxFiles - 1; i >= 1; i--) {
      const err = await call(fs.rename, path.join(dir, slotName(base, i - 1)), path.join(dir, slotName(base, i)));
      if (err && err.code !== 'ENOENT') return err;
    }
    if (maxFiles === 1) {
      const err = await call(fs.unlink, file);
      if (err && err.code !== 'ENOENT') return err;
    }
    size = 0;
    return null;
  }

  function takeChunk() {
    if (dropped) {
      const n = dropped;
      dropped = 0;
      queue.unshift(`${JSON.stringify({ t: new Date(now()).toISOString(), level: 'warn', scope: 'log', msg: `dropped ${n} log records (queue full)` })}\n`);
    }
    const chunk = queue.join('');
    queue = [];
    return chunk;
  }

  async function drain() {
    if (writing || failed || !file || !queue.length) {
      kick();
      return;
    }
    writing = true;
    const chunk = takeChunk();
    const bytes = Buffer.byteLength(chunk);
    try {
      if (size > 0 && size + bytes > maxBytes) {
        const err = await rotate();
        if (err) throw err;
      }
      const err = await call(fs.appendFile, file, chunk);
      if (err) throw err;
      size += bytes;
    } catch (e) {
      fail((e && (e.code || e.message)) || String(e));
      if (!mirror) safeStderr(chunk);
    } finally {
      writing = false;
      if (queue.length && !failed) drain();
      else kick();
    }
  }

  function settleWaiters() {
    const w = waiters;
    waiters = [];
    for (const r of w) r();
  }

  /** Resolves once everything queued so far is written (or given up on). Never rejects. */
  function flush() {
    if (timer) {
      cancel(timer);
      timer = null;
    }
    return new Promise((resolve) => {
      waiters.push(resolve);
      if (!writing) drain();
    });
  }

  /** Write the queue synchronously (quit, fatal error). May append after an async write still in flight. */
  function flushSync() {
    if (timer) {
      cancel(timer);
      timer = null;
    }
    if (!queue.length && !dropped) return;
    const chunk = takeChunk();
    if (!configured) return; // nowhere to write yet: dropped (nothing is lost that had a home)
    if (!failed && file) {
      try {
        fs.appendFileSync(file, chunk);
        size += Buffer.byteLength(chunk);
        return;
      } catch (e) {
        fail(e.code || e.message);
      }
    }
    if (!mirror) safeStderr(chunk);
  }

  /** The newest `n` lines across the rotated files (for Copy Diagnostics). Never rejects. */
  async function tail(n = 200) {
    if (!dir) return [];
    const lines = [];
    for (let i = 0; i < maxFiles && lines.length < n; i++) {
      const text = await new Promise((resolve) => {
        try {
          fs.readFile(path.join(dir, slotName(base, i)), 'utf8', (err, data) => resolve(err ? '' : data));
        } catch {
          resolve('');
        }
      });
      const got = text.split('\n').filter(Boolean);
      lines.unshift(...got.slice(Math.max(0, got.length - (n - lines.length))));
    }
    return lines.slice(-n);
  }

  function child(scope) {
    const s = String(scope || 'app');
    return {
      scope: s,
      debug: (msg, fields) => write('debug', s, msg, fields),
      info: (msg, fields) => write('info', s, msg, fields),
      warn: (msg, fields) => write('warn', s, msg, fields),
      error: (msg, fields) => write('error', s, msg, fields),
      log: (level, msg, fields) => write(level, s, msg, fields),
      enabled,
      child: (sub) => child(`${s}.${sub}`),
    };
  }

  const root = child('app');
  return {
    ...root,
    write,
    child,
    configure,
    flush,
    flushSync,
    tail,
    enabled,
    get level() { return threshold; },
    set level(v) { threshold = parseLevel(v, threshold); },
    get dir() { return dir; },
    get file() { return file; },
    get failed() { return failed; },
    /** Paths of the current file and its rotations (existing or not), newest first. */
    files: () => (dir ? Array.from({ length: maxFiles }, (_, i) => path.join(dir, slotName(base, i))) : []),
  };
}

/** The process-wide logger: main.js configures it; src/ modules take child scopes of it. */
const logger = createLogger();

module.exports = { createLogger, logger, parseLevel, slotName, LEVELS };
