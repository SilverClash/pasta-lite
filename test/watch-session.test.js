'use strict';
// Main-side watcher lifecycle (src/watch-session.js) over a fake createWatcher.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createWatchSession, RETRY_MS } = require('../src/watch-session');

function setup({ throwFor = null, onGone } = {}) {
  const made = []; // every fake watcher: {root, onEvent, pauses, resumes, closed}
  const sent = [];
  const logged = [];
  const gone = [];
  let now = 1000;
  const createWatcher = (root, { onEvent }) => {
    if (throwFor && throwFor(root)) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    const w = {
      root, onEvent, pauses: 0, resumes: 0, closed: false,
      pause() { w.pauses++; },
      resume() { w.resumes++; },
      close() { w.closed = true; },
    };
    made.push(w);
    return w;
  };
  const session = createWatchSession({
    createWatcher,
    send: (channel, payload) => sent.push({ channel, payload }),
    onGone: onGone || ((repo) => gone.push(repo)),
    now: () => now,
    log: (...a) => logged.push(a),
  });
  return { session, made, sent, logged, gone, tick: (ms) => { now += ms; }, last: () => made[made.length - 1] };
}

describe('open / close', () => {
  test('open creates a watcher for the root; events are sent as watch with the root stamped in', () => {
    const { session, made, sent, last } = setup();
    session.open('/r');
    assert.equal(made.length, 1);
    assert.equal(last().root, '/r');
    assert.equal(session.root, '/r');
    assert.equal(session.active, true);
    last().onEvent({ kinds: ['status'], paths: ['a.txt'] });
    last().onEvent({ kinds: ['full'] });
    assert.deepEqual(sent, [
      { channel: 'watch', payload: { repo: '/r', kinds: ['status'], paths: ['a.txt'] } },
      { channel: 'watch', payload: { repo: '/r', kinds: ['full'] } },
    ]);
  });

  test('opening another repo closes the old watcher; its late events are dropped', () => {
    const { session, made, sent } = setup();
    session.open('/a');
    session.open('/b');
    assert.equal(made.length, 2);
    assert.equal(made[0].closed, true);
    assert.equal(made[1].closed, false);
    made[0].onEvent({ kinds: ['status'] });
    made[0].onEvent({ kinds: ['gone'] });
    assert.deepEqual(sent, []);
    assert.equal(session.active, true, 'a stale gone does not drop the new watcher');
    made[1].onEvent({ kinds: ['refs'] });
    assert.deepEqual(sent.map((s) => s.payload.repo), ['/b']);
  });

  test('reopening the same root replaces the watcher', () => {
    const { session, made } = setup();
    session.open('/r');
    session.open('/r');
    assert.equal(made.length, 2);
    assert.equal(made[0].closed, true);
  });

  test('close stops the watcher, is idempotent, and later events are dropped', () => {
    const { session, made, sent } = setup();
    session.open('/r');
    session.close();
    session.close();
    assert.equal(made[0].closed, true);
    assert.equal(session.root, null);
    assert.equal(session.active, false);
    made[0].onEvent({ kinds: ['status'] });
    assert.deepEqual(sent, []);
    assert.equal(session.retry(), false, 'nothing to retry without a repo');
    assert.equal(made.length, 1);
  });
});

describe('pause around our own writes', () => {
  test('busy for the watched root pauses and resumes, nested', () => {
    const { session, last } = setup();
    session.open('/r');
    const w = last();
    session.busy({ repo: '/r', running: true });
    session.busy({ repo: '/r', running: true });
    assert.equal(w.pauses, 2);
    session.busy({ repo: '/r', running: false });
    session.busy({ repo: '/r', running: false });
    assert.equal(w.resumes, 2);
  });

  test('busy for another repo leaves the watcher alone; an unbalanced end is ignored', () => {
    const { session, last } = setup();
    session.open('/r');
    session.busy({ repo: '/other', running: true });
    session.busy({ repo: '/other', running: false });
    session.busy({ repo: '/r', running: false });
    assert.equal(last().pauses, 0);
    assert.equal(last().resumes, 0);
  });

  test('a watcher created while writes run on its root starts paused that many times', () => {
    const { session, made, last } = setup();
    session.busy({ repo: '/r', running: true }); // e.g. a write still running on /r
    session.open('/a');
    session.busy({ repo: '/r', running: true });
    assert.equal(made[0].pauses, 0);
    session.open('/r'); // switched back while both run
    assert.equal(last().pauses, 2);
    session.busy({ repo: '/r', running: false });
    session.busy({ repo: '/r', running: false });
    assert.equal(last().resumes, 2);
  });

  test('a write that ends after its watcher was replaced does not resume the new one', () => {
    const { session, made } = setup();
    session.open('/r');
    session.busy({ repo: '/r', running: true });
    session.open('/b');
    session.busy({ repo: '/r', running: false });
    assert.equal(made[1].resumes, 0);
    assert.equal(made[1].pauses, 0);
  });
});

describe('gone / error and retry backoff', () => {
  test('gone drops the watcher and is forwarded; retry waits 30 s, then recreates once', () => {
    const { session, made, sent, tick } = setup();
    session.open('/r');
    made[0].onEvent({ kinds: ['gone'] });
    assert.equal(session.active, false);
    assert.equal(session.root, '/r', 'the repo stays open (the renderer keeps its last state)');
    assert.deepEqual(sent.at(-1).payload, { repo: '/r', kinds: ['gone'] });
    assert.equal(session.retry(), false);
    tick(RETRY_MS - 1);
    assert.equal(session.retry(), false, 'not before 30 s');
    tick(1);
    assert.equal(session.retry(), true);
    assert.equal(made.length, 2);
    assert.equal(session.retry(), false, 'already watching');
    assert.equal(made.length, 2);
  });

  test('gone calls onGone after sending the event; error and stale watchers do not', () => {
    const order = [];
    const { session, made, sent } = setup({ onGone: (repo) => order.push(['onGone', repo, sent.length]) });
    session.open('/a');
    session.open('/r');
    made[0].onEvent({ kinds: ['gone'] }); // replaced watcher: dropped
    made[1].onEvent({ kinds: ['error'], error: new Error('EMFILE') });
    assert.deepEqual(order, []);
    session.open('/r');
    made[2].onEvent({ kinds: ['gone'] });
    assert.deepEqual(order, [['onGone', '/r', 2]], 'after the watch event was sent');
    assert.deepEqual(sent.at(-1).payload, { repo: '/r', kinds: ['gone'] });
  });

  test('onGone may close the session (main clears its current repo)', () => {
    const box = {};
    const { session, made } = setup({ onGone: () => box.session.close() });
    box.session = session;
    session.open('/r');
    made[0].onEvent({ kinds: ['gone'] });
    assert.equal(session.root, null);
    assert.equal(session.active, false);
    assert.equal(session.retry(), false);
    assert.equal(made.length, 1);
  });

  test('error carries the message, is logged, and backs off like gone', () => {
    const { session, made, sent, logged, tick } = setup();
    session.open('/r');
    made[0].onEvent({ kinds: ['error'], error: Object.assign(new Error('ENOSPC: watcher limit'), { code: 'ENOSPC' }) });
    assert.deepEqual(sent.at(-1).payload, { repo: '/r', kinds: ['error'], error: 'ENOSPC: watcher limit' });
    assert.equal(logged.length, 1);
    tick(RETRY_MS);
    assert.equal(session.retry(), true);
    // Fails again right away: the next retry is again 30 s out (never a loop).
    made[1].onEvent({ kinds: ['error'], error: new Error('ENOSPC') });
    tick(RETRY_MS / 2);
    assert.equal(session.retry(), false);
    tick(RETRY_MS / 2);
    assert.equal(session.retry(), true);
    assert.equal(made.length, 3);
  });

  test('createWatcher throwing is reported as error and retried with the same backoff', () => {
    let fail = true;
    const { session, made, sent, tick } = setup({ throwFor: () => fail });
    session.open('/r');
    assert.equal(session.active, false);
    assert.deepEqual(sent.at(-1).payload, { repo: '/r', kinds: ['error'], error: 'EMFILE: too many open files' });
    tick(RETRY_MS - 1);
    assert.equal(session.retry(), false);
    tick(1);
    assert.equal(session.retry(), false, 'the retry ran and failed again');
    assert.equal(sent.filter((s) => s.payload.kinds[0] === 'error').length, 2);
    fail = false;
    tick(RETRY_MS);
    assert.equal(session.retry(), true);
    assert.equal(made.length, 1);
  });

  test('a recreated watcher is paused for writes still running', () => {
    const { session, made, tick } = setup();
    session.open('/r');
    made[0].onEvent({ kinds: ['gone'] });
    session.busy({ repo: '/r', running: true });
    tick(RETRY_MS);
    session.retry();
    assert.equal(made[1].pauses, 1);
  });

  test('open resets the backoff', () => {
    const { session, made } = setup();
    session.open('/r');
    made[0].onEvent({ kinds: ['gone'] });
    session.open('/r');
    assert.equal(session.active, true);
    assert.equal(made.length, 2);
  });
});
