'use strict';
// Renderer → main logging: main's app:log validation and rate limit (src/renderer-log.js), and the
// renderer side (Components.util.log / logToast, window error handlers) over the harness.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRendererLogSink, validate, MAX_BYTES } = require('../src/renderer-log');
const H = require('./renderer-harness');

function fakeLogger() {
  const records = [];
  return { records, log: (level, msg, fields) => records.push({ level, msg, fields }) };
}

// ---------------------------------------------------------------- main: validation

test('validate: level allow-list, string message, plain-object fields only', () => {
  assert.deepEqual(validate('error', 'boom', { a: 1 }), { level: 'error', msg: 'boom', fields: { a: 1 } });
  for (const lvl of ['debug', 'info', 'warn', 'error']) assert.ok(validate(lvl, 'x'));
  for (const lvl of ['fatal', 'ERROR', '', null, 3, { toString: () => 'error' }]) assert.equal(validate(lvl, 'x'), null, String(lvl));
  assert.equal(validate('info', 42), null, 'msg must be a string');
  assert.equal(validate('info', { message: 'x' }), null);
  assert.equal(validate('info', 'x', [1, 2]).fields, undefined, 'arrays dropped');
  assert.equal(validate('info', 'x', 'str').fields, undefined);
  class Evil { constructor() { this.a = 1; } }
  assert.equal(validate('info', 'x', new Evil()).fields, undefined, 'class instances dropped');
  assert.deepEqual({ ...validate('info', 'x', Object.assign(Object.create(null), { a: 1 })).fields }, { a: 1 }, 'null-prototype objects are plain');
});

test('validate: payloads over the cap keep a cut message and replace the fields by their size', () => {
  const r = validate('error', 'short', { blob: 'x'.repeat(MAX_BYTES) });
  assert.equal(r.msg, 'short');
  assert.ok(r.fields.truncated > MAX_BYTES);
  assert.equal(Object.keys(r.fields).length, 1);
  const m = validate('error', 'y'.repeat(MAX_BYTES * 2));
  assert.ok(Buffer.byteLength(m.msg) <= MAX_BYTES / 2 + 3);
  assert.ok(m.msg.endsWith('…'));
  // Just under the cap: untouched.
  const ok = validate('info', 'm', { s: 'z'.repeat(MAX_BYTES - 100) });
  assert.equal(ok.fields.s.length, MAX_BYTES - 100);
});

// ---------------------------------------------------------------- main: rate limit

test('rate limit: 50 per 10 s per sender, then one "dropped N" record when the next window opens', () => {
  let t = 0;
  const logger = fakeLogger();
  const sinkLog = createRendererLogSink({ logger, now: () => t });
  for (let i = 0; i < 80; i++) sinkLog.accept(1, 'error', `e${i}`);
  assert.equal(logger.records.length, 50);
  assert.equal(logger.records[49].msg, 'e49');
  // Another window (sender) has its own budget.
  assert.equal(sinkLog.accept(2, 'info', 'other window'), true);
  t = 9999;
  assert.equal(sinkLog.accept(1, 'info', 'still limited'), false);
  t = 10000;
  assert.equal(sinkLog.accept(1, 'info', 'next window'), true);
  const tail = logger.records.slice(-2);
  assert.equal(tail[0].level, 'warn');
  assert.equal(tail[0].msg, 'dropped 31 renderer log records (rate limit 50 per 10 s)');
  assert.deepEqual(tail[0].fields, { sender: 1 });
  assert.equal(tail[1].msg, 'next window');
  // No drops in the new window: no second report.
  t = 20000;
  sinkLog.accept(1, 'info', 'x');
  assert.equal(logger.records.filter((r) => /dropped/.test(r.msg)).length, 1);
});

test('invalid records do not use up the budget; forget() reports drops and resets', () => {
  let t = 0;
  const logger = fakeLogger();
  const s = createRendererLogSink({ logger, now: () => t, max: 2 });
  assert.equal(s.accept(1, 'nope', 'x'), false);
  assert.equal(s.accept(1, 'info', 'a'), true);
  assert.equal(s.accept(1, 'info', 'b'), true);
  assert.equal(s.accept(1, 'info', 'c'), false);
  s.forget(1);
  assert.equal(logger.records[2].msg, 'dropped 1 renderer log records (rate limit 2 per 10 s)');
  s.forget(1); // nothing left: no record
  assert.equal(logger.records.length, 3);
  assert.equal(s.accept(1, 'info', 'fresh'), true, 'budget reset after forget');
});

test('end to end through a real logger: renderer records are redacted again', async () => {
  const { createLogger } = require('../src/log');
  const lines = [];
  const fsStub = {
    mkdirSync() {}, accessSync() {}, statSync() { throw Object.assign(new Error('x'), { code: 'ENOENT' }); },
    appendFile(_p, d, cb) { lines.push(...d.trim().split('\n')); cb(null); },
  };
  const logger = createLogger({ fs: fsStub, env: {}, schedule: (fn) => setImmediate(fn), stderr: { write() {} } });
  logger.configure({ dir: '/l' });
  const s = createRendererLogSink({ logger: logger.child('renderer') });
  s.accept(7, 'error', `uncaught error: fetch https://ada:${'ghp' + '_1234567890abcdefghijABCDEFGHIJ'}@github.com/o/r`, {
    err: { name: 'Error', message: 'token=abc', stack: 'Error\n    at x' }, env: { NPM_TOKEN: 'n' },
  });
  await logger.flush();
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.scope, 'renderer');
  assert.equal(rec.msg, 'uncaught error: fetch https://***@github.com/o/r');
  assert.equal(rec.err.message, 'token=***');
  assert.equal(rec.env.NPM_TOKEN, '***');
});

// ---------------------------------------------------------------- renderer side

/** Fresh renderer scripts with a recording window.api.log; returns {win, sent}. */
function rendererWithApi() {
  const win = H.loadRenderer();
  const sent = [];
  win.api = { log: (level, msg, fields) => sent.push({ level, msg, fields }) };
  return { win, sent };
}

/** Run fn with console.error / console.warn captured. */
function capture(fn) {
  const out = { error: [], warn: [] };
  const saved = { error: console.error, warn: console.warn };
  console.error = (...a) => out.error.push(a);
  console.warn = (...a) => out.warn.push(a);
  try {
    fn();
  } finally {
    Object.assign(console, saved);
  }
  return out;
}

test('util.log: writes to the console exactly as before and forwards one record', () => {
  const { win, sent } = rendererWithApi();
  const { log } = win.Components.util;
  const err = Object.assign(new Error('fatal: bad config'), { kind: 'git', exitCode: 128 });
  const c = capture(() => {
    log.error('[store] could not read the remotes:', err);
    log.warn('no component registered for x');
  });
  assert.deepEqual(c.error, [['[store] could not read the remotes:', err]]);
  assert.deepEqual(c.warn, [['no component registered for x']]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].level, 'error');
  assert.equal(sent[0].msg, '[store] could not read the remotes:');
  assert.equal(sent[0].fields.err.message, 'fatal: bad config');
  assert.equal(sent[0].fields.err.kind, 'git');
  assert.equal(sent[0].fields.err.exitCode, 128);
  assert.match(sent[0].fields.err.stack, /^Error: fatal: bad config/);
  assert.equal(err.logged, true, 'marked, so its toast is not logged twice');
  assert.deepEqual(sent[1], { level: 'warn', msg: 'no component registered for x', fields: {} });
});

test('util.log with an Error first; without window.api it only writes to the console', () => {
  const { win, sent } = rendererWithApi();
  const c = capture(() => win.Components.util.log.error(new TypeError('x is undefined')));
  assert.equal(c.error.length, 1);
  assert.equal(sent[0].msg, 'x is undefined');
  assert.equal(sent[0].fields.err.name, 'TypeError');
  delete win.api;
  const c2 = capture(() => win.Components.util.log.error('no api'));
  assert.equal(c2.error.length, 1);
  win.api = { log: () => { throw new Error('bridge gone'); } };
  capture(() => win.Components.util.log.error('api throws: still fine'));
});

test('logToast: unexpected errors at error level, expected kinds at info, quiet kinds and notices not at all', () => {
  const { win, sent } = rendererWithApi();
  const { logToast, isUnexpectedError, toError } = win.Components.util;
  assert.equal(logToast(toError({ message: 'could not lock config file', kind: null })), 'error');
  assert.equal(logToast(toError({ message: 'Forbidden', kind: 'forbidden' })), 'error', 'a kind the app never explains');
  assert.equal(logToast(new TypeError('boom')), 'error');
  assert.equal(logToast(toError({ message: 'rejected', kind: 'rejected-behind' })), 'info');
  assert.equal(logToast(toError({ message: 'auth failed', kind: 'auth' })), 'info');
  assert.equal(logToast(toError({ message: 'changed', kind: 'stale' })), null);
  assert.equal(logToast(toError({ message: 'cancelled', kind: 'aborted' })), null);
  assert.equal(logToast({ message: 'Pushed', level: 'info' }), null, 'a notice');
  const once = new Error('logged already');
  capture(() => win.Components.util.log.error(once));
  assert.equal(logToast(once), null, 'util.log recorded it');
  const e = new Error('twice?');
  logToast(e);
  assert.equal(logToast(e), null, 'a toast of the same error again is not re-logged');
  assert.deepEqual(sent.filter((s) => s.msg.startsWith('toast:')).map((s) => [s.level, s.msg]), [
    ['error', 'toast: could not lock config file'],
    ['error', 'toast: Forbidden'],
    ['error', 'toast: boom'],
    ['info', 'toast: rejected'],
    ['info', 'toast: auth failed'],
    ['error', 'toast: twice?'],
  ]);
  assert.equal(isUnexpectedError({ message: 'x', kind: 'not-found' }), false);
  assert.equal(isUnexpectedError({ message: 'x' }), true);
  assert.equal(isUnexpectedError({ message: 'n', level: 'info' }), false);
});

test('the store logs through util.log: a remotes failure reaches main.log', async () => {
  const win = H.loadRenderer();
  const sent = [];
  win.api = { log: (level, msg, fields) => sent.push({ level, msg, fields }) };
  const api = H.makeApi();
  const store = win.Store.create(api);
  const saved = console.error;
  console.error = () => {};
  try {
    const p = store.actions.loadRepo({ root: '/r', name: 'r' });
    await H.flush(1);
    await H.answerRefresh(api, H.repoData({ commits: H.chain(['a']) }));
    await p;
    api.take('remotes').reject({ message: 'fatal: bad config line 3', kind: null });
    await H.flush();
  } finally {
    console.error = saved;
  }
  const rec = sent.find((s) => /could not read the remotes/.test(s.msg));
  assert.ok(rec, 'forwarded');
  assert.equal(rec.level, 'error');
  assert.equal(rec.fields.err.message, 'fatal: bad config line 3');
});

test('window error and unhandledrejection events are forwarded (components.js installs the handlers)', () => {
  const R = (f) => path.join(__dirname, '..', 'renderer', f);
  delete require.cache[require.resolve(R('components.js'))];
  const listeners = {};
  const sent = [];
  globalThis.window = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    api: { log: (level, msg, fields) => sent.push({ level, msg, fields }) },
  };
  require(R('components.js'));
  assert.equal(listeners.error.length, 1);
  assert.equal(listeners.unhandledrejection.length, 1);
  const err = new Error('kaboom');
  listeners.error[0]({ message: 'Uncaught Error: kaboom', filename: 'file:///app/renderer/app.js', lineno: 3, colno: 9, error: err });
  listeners.unhandledrejection[0]({ reason: Object.assign(new Error('nope'), { kind: 'weird' }) });
  listeners.unhandledrejection[0]({ reason: 'a string' });
  listeners.error[0]({ message: 'Script error.' }); // cross-origin style: no error object
  assert.deepEqual(sent.map((s) => [s.level, s.msg]), [
    ['error', 'uncaught error: Uncaught Error: kaboom'],
    ['error', 'unhandled rejection: nope'],
    ['error', 'unhandled rejection: a string'],
    ['error', 'uncaught error: Script error.'],
  ]);
  assert.equal(sent[0].fields.where, 'file:///app/renderer/app.js:3:9');
  assert.equal(sent[0].fields.err.message, 'kaboom');
  assert.equal(sent[1].fields.err.kind, 'weird');
  assert.equal(sent[3].fields.err, undefined);
});
