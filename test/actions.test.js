'use strict';
// renderer/actions.js (window.Components.actions): runFlow, menu mapping, busy / missing-flow
// disabling, the availability rules shared by the toolbar and the context menus, and the shared
// context-menu binding (right-click, ContextMenu key / Shift+F10, de-dup) on the harness' fake DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const H = require('./renderer-harness.js');

const ACTIONS = path.join(__dirname, '..', 'renderer', 'actions.js');

/** Fresh renderer window with actions.js loaded; returns {win, A}. */
function loadActions() {
  const win = H.loadRenderer();
  delete require.cache[require.resolve(ACTIONS)];
  const A = require(ACTIONS);
  assert.equal(win.Components.actions, A, 'exposed as window.Components.actions');
  return { win, A };
}

/** Fake PLFlows recording [name, store, ...args]; every flow resolves true. */
function fakeFlows(names = ['checkout', 'createBranch', 'push', 'pull', 'fetch', 'openTerminal', 'cancel']) {
  const calls = [];
  const flows = { calls };
  for (const n of names) flows[n] = async (store, ...args) => { calls.push([n, store, ...args]); return true; };
  return flows;
}

function fakeStore(state = {}) {
  const toasts = [];
  return { toasts, state: { busy: false, ...state }, actions: { toast: (e) => toasts.push(e) } };
}

/** Run fn with console.error captured; returns [result, errors]. */
async function capturingErrors(fn) {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a);
  try {
    return [await fn(), errors];
  } finally {
    console.error = orig;
  }
}

// ------------------------------------------------------------------ state fixtures

const REPO = { root: '/r', name: 'r' };
const baseRefs = (o = {}) => H.refs({
  head: { branch: 'main', oid: 'aaaaaaa1', detached: false },
  local: [{ name: 'main', oid: 'aaaaaaa1', current: true, upstream: 'origin/main' }, { name: 'feat/x', oid: 'b' }],
  remote: [{ name: 'origin/main', remote: 'origin', branch: 'main', oid: 'aaaaaaa1' }],
  ...o,
});
function state(o = {}) {
  return {
    repo: REPO,
    status: { ...H.status({ oid: 'aaaaaaa1' }), upstream: 'origin/main', ahead: 2 },
    refs: baseRefs(),
    stashes: [],
    undo: { undo: null, redo: null, busy: false, undoBlocked: null, redoBlocked: null },
    undoError: null,
    busy: false,
    ...o,
  };
}
const detachedState = () => state({
  status: { ...H.status({ oid: 'cccccccc9' }), branch: null, detached: true },
  refs: baseRefs({ head: { branch: null, oid: 'cccccccc9', detached: true }, local: [{ name: 'main', oid: 'a' }] }),
});
const unbornState = () => state({ status: H.status(), refs: baseRefs({ head: { branch: 'main', oid: null }, local: [], remote: [] }), remotes: ['origin'] });
const KEYS = ['undo', 'redo', 'pull', 'pullMenu', 'fetch', 'push', 'branch', 'stash', 'pop', 'terminal', 'switcher'];

// ------------------------------------------------------------------ constants / flowsOf

test('BUSY_TITLE and flowsOf', () => {
  const { win, A } = loadActions();
  assert.equal(A.BUSY_TITLE, 'Working…');
  assert.equal(A.flowsOf(), undefined);
  const flows = fakeFlows();
  win.PLFlows = flows;
  assert.equal(A.flowsOf(), flows);
});

// ------------------------------------------------------------------ availability (moved from the toolbar)

test('availability: no repo disables everything with a reason', () => {
  const { A } = loadActions();
  const m = A.availability(state({ repo: null }));
  assert.deepEqual(Object.keys(m).sort(), [...KEYS].sort());
  for (const k of KEYS) {
    assert.equal(m[k].disabled, true, k);
    assert.match(m[k].title, /open a repository first/, k);
  }
});

test('availability: busy disables every action with "Working…" except Terminal', () => {
  const { A } = loadActions();
  const m = A.availability(state({
    busy: true, stashes: [{ message: 's' }], undo: { undo: { action: 'commit', description: "Undo commit 'x'" }, redo: null, busy: false },
  }), { dirty: true });
  for (const k of KEYS) {
    if (k === 'terminal') continue;
    assert.equal(m[k].disabled, true, k);
    assert.match(m[k].title, /Working…/, k);
  }
  assert.deepEqual(m.terminal, { disabled: false, title: 'Open a terminal in the repository' }, 'openTerminal runs while busy');
});

test('availability: undo/redo name the action, the blocked reason, or nothing to do', () => {
  const { A: { availability } } = loadActions();
  let m = availability(state({
    undo: { undo: { action: 'commit', description: "Undo commit 'fix \u202ebug'" }, redo: null, busy: false, undoBlocked: null, redoBlocked: 'Files changed since the discard' },
  }));
  assert.deepEqual(m.undo, { disabled: false, title: "Undo commit 'fix \\u{202E}bug'" }); // display-safe
  assert.deepEqual(m.redo, { disabled: true, title: 'Redo unavailable: Files changed since the discard' });

  m = availability(state({ undo: { undo: null, redo: { action: 'checkout', description: 'Redo checkout of main' }, busy: false } }));
  assert.deepEqual(m.undo, { disabled: true, title: 'Nothing to undo' });
  assert.deepEqual(m.redo, { disabled: false, title: 'Redo checkout of main' });

  m = availability(state({ undo: { undo: null, redo: null, busy: true } }));
  assert.equal(m.undo.disabled, true);
  assert.match(m.undo.title, /in progress/);

  m = availability(state({ undo: null, undoError: 'boom' }));
  assert.deepEqual(m.undo, { disabled: true, title: 'Undo unavailable: boom' });
  assert.deepEqual(availability(state({ undo: null })).redo, { disabled: true, title: 'Nothing to redo' });
});

test('availability: pull / pull menu / fetch / push need a remote; the pull label names the tooltip', () => {
  const { A: { availability, hasRemotes } } = loadActions();
  let m = availability(state({ refs: baseRefs({ remote: [] }) }));
  for (const k of ['pull', 'pullMenu', 'fetch', 'push']) {
    assert.equal(m[k].disabled, true, k);
    assert.match(m[k].title, /no remotes configured/, k);
  }
  assert.equal(m.fetch.title, 'Fetch — no remotes configured');
  assert.equal(m.push.title, 'Push — no remotes configured');

  m = availability(state(), { pullMode: 'rebase', pullLabel: 'Pull (rebase)' });
  assert.deepEqual(m.pull, { disabled: false, title: 'Pull (rebase) into main' });
  assert.equal(m.pullMenu.disabled, false);
  assert.deepEqual(m.fetch, { disabled: false, title: 'Fetch all remotes' });
  assert.equal(availability(state(), { pullMode: 'fetch' }).pull.title, 'Fetch All: fetch every remote');
  assert.equal(availability(state()).pull.title, 'Pull into main', 'default label');

  // state.remotes (remote names), once loaded, wins over the remote-branch list
  assert.equal(hasRemotes({ remotes: ['origin'], refs: { remote: [] } }), true);
  assert.equal(hasRemotes({ remotes: [], refs: { remote: [{ name: 'origin/x' }] } }), false);
  assert.equal(hasRemotes({ refs: { remote: [{ name: 'origin/x' }] } }), true);
  assert.equal(hasRemotes({ refs: null }), false);
});

test('availability: detached HEAD disables push and branch pulls, not Fetch All, fetch or the switcher', () => {
  const { A: { availability } } = loadActions();
  const s = detachedState();
  const m = availability(s);
  assert.equal(m.push.disabled, true);
  assert.equal(m.push.title, 'Push — HEAD is detached; check out a branch first');
  assert.equal(m.pull.disabled, true);
  assert.match(m.pull.title, /detached/);
  assert.equal(m.fetch.disabled, false);
  assert.equal(availability(s, { pullMode: 'fetch' }).pull.disabled, false);
  assert.equal(m.switcher.disabled, false);
  assert.match(m.switcher.title, /Detached HEAD at cccccccc9/);
  assert.deepEqual(m.branch, { disabled: false, title: 'Create a branch at ccccccc' });
});

test('availability: push tooltip, unborn branch, stash / pop / terminal', () => {
  const { A: { availability } } = loadActions();
  let m = availability(state());
  assert.deepEqual(m.push, { disabled: false, title: 'Push main to origin/main (2 commits ahead)' });
  assert.deepEqual(m.stash, { disabled: true, title: 'Stash — no changes to stash' });
  assert.deepEqual(m.pop, { disabled: true, title: 'Pop — no stashes' });
  assert.equal(m.terminal.disabled, false);

  m = availability(state({ status: { ...H.status({ oid: 'a' }), upstream: null }, stashes: [{ message: 'WIP on main' }] }), { dirty: true });
  assert.deepEqual(m.push, { disabled: false, title: 'Push main and set its upstream' });
  assert.equal(m.stash.disabled, false);
  assert.deepEqual(m.pop, { disabled: false, title: 'Pop the latest stash: WIP on main' });

  m = availability(unbornState());
  assert.deepEqual(m.push, { disabled: true, title: 'Push — main has no commits yet' });
  assert.deepEqual(m.branch, { disabled: true, title: 'Branch — the repository has no commits yet' });
});

// ------------------------------------------------------------------ finishItems / gateItems

test('finishItems: busy disables with BUSY_TITLE (not the free flows); missing flows are "Not available"; own reasons kept', () => {
  const { A: { finishItems, BUSY_TITLE } } = loadActions();
  const flows = fakeFlows();
  const descs = [
    { label: 'Checkout', flow: 'checkout', args: [] },
    { separator: true },
    { label: 'Mine', flow: 'push', args: [], disabled: true, title: 'my reason' },
    { label: 'Gone', flow: 'nope', args: [] },
    { label: 'Terminal', flow: 'openTerminal', args: [] },
  ];
  const idle = finishItems(descs, { busy: false }, flows);
  assert.deepEqual(idle.map((d) => (d.separator ? '---' : [d.label, !!d.disabled, d.title])), [
    ['Checkout', false, undefined], '---', ['Mine', true, 'my reason'], ['Gone', true, 'Not available'], ['Terminal', false, undefined],
  ]);
  const busy = finishItems(descs, { busy: true }, flows);
  assert.deepEqual(busy.map((d) => (d.separator ? '---' : [d.label, !!d.disabled, d.title])), [
    ['Checkout', true, BUSY_TITLE], '---', ['Mine', true, BUSY_TITLE], ['Gone', true, BUSY_TITLE], ['Terminal', false, undefined],
  ]);
  assert.ok(finishItems(descs, { busy: false }, undefined).filter((d) => !d.separator).every((d) => d.disabled), 'no PLFlows');
  assert.equal(descs[0].disabled, undefined, 'inputs are not mutated');
});

test('gateItems: fetch / push / create branch follow availability() with the same titles', () => {
  const { A: { gateItems, availability } } = loadActions();
  const items = (s) => gateItems([
    { label: 'Fetch origin', flow: 'fetch', args: [{ remote: 'origin' }] },
    { label: 'Push', flow: 'push', args: [{}] },
    { label: 'Push other', flow: 'push', args: [{ branch: 'feat/x' }] },
    { label: 'Create here', flow: 'createBranch', args: [{ start: 'b' }] },
    { label: 'Create', flow: 'createBranch', args: [{}] },
    { separator: true },
    { label: 'Checkout', flow: 'checkout', args: [] },
  ], s);
  const view = (list) => list.map((d) => (d.separator ? '---' : [d.label, !!d.disabled, d.disabled ? d.title : null]));

  assert.deepEqual(view(items(state())), [
    ['Fetch origin', false, null], ['Push', false, null], ['Push other', false, null], ['Create here', false, null], ['Create', false, null], '---', ['Checkout', false, null],
  ]);

  const none = state({ refs: baseRefs({ remote: [] }), remotes: [] });
  assert.deepEqual(view(items(none)).slice(0, 3), [
    ['Fetch origin', true, 'Fetch — no remotes configured'], ['Push', true, 'Push — no remotes configured'], ['Push other', true, 'Push — no remotes configured'],
  ]);
  assert.equal(availability(none).push.title, 'Push — no remotes configured', 'same title as the toolbar');

  const det = view(items(detachedState()));
  assert.deepEqual(det[1], ['Push', true, 'Push — HEAD is detached; check out a branch first']);
  assert.deepEqual(det[2], ['Push other', false, null], 'another branch can be pushed with HEAD detached');

  const unborn = view(items(unbornState()));
  assert.deepEqual(unborn[1], ['Push', true, 'Push — main has no commits yet']);
  assert.deepEqual(unborn[3], ['Create here', true, 'Branch — the repository has no commits yet']);
  assert.deepEqual(unborn[4], ['Create', true, 'Branch — the repository has no commits yet']);

  // an orphan branch in a repo with commits: branches can still start at an existing commit
  const orphan = state({ status: H.status({ branch: 'orphan' }), refs: baseRefs({ head: { branch: 'orphan', oid: null } }) });
  assert.deepEqual(view(items(orphan))[3], ['Create here', false, null]);

  // explicit current-branch push behaves like the plain push
  assert.deepEqual(gateItems([{ label: 'P', flow: 'push', args: [{ branch: 'main' }] }], unbornState())[0].title, 'Push — main has no commits yet');
  // already disabled keeps its reason; no repo: untouched
  assert.equal(gateItems([{ label: 'P', flow: 'push', args: [{}], disabled: true, title: 'mine' }], none)[0].title, 'mine');
  assert.equal(gateItems([{ label: 'P', flow: 'push', args: [{}] }], { refs: null })[0].disabled, undefined);
});

// ------------------------------------------------------------------ runFlow / toMenuItems

test('runFlow: calls PLFlows[flow](store, ...args) and resolves its boolean; refuses while busy, disabled or missing', async () => {
  const { A: { runFlow } } = loadActions();
  const store = fakeStore();
  const flows = fakeFlows();
  assert.equal(await runFlow({ flow: 'checkout', args: [{ target: 'x', kind: 'local' }] }, store, flows), true);
  assert.deepEqual(flows.calls, [['checkout', store, { target: 'x', kind: 'local' }]]);
  flows.calls.length = 0;

  assert.equal(await runFlow({ flow: 'fetch', args: [], disabled: true }, store, flows), false, 'disabled');
  assert.equal(await runFlow({ flow: 'fetch', args: [] }, fakeStore({ busy: true }), flows), false, 'busy');
  assert.equal(await runFlow({ flow: 'fetch', args: [] }, store, {}), false, 'missing flow');
  assert.equal(await runFlow({ flow: 'fetch', args: [] }, store, undefined), false, 'no PLFlows');
  assert.equal(await runFlow(null, store, flows), false);
  assert.equal(await runFlow({ flow: 'fetch' }, null, flows), false, 'no store');
  assert.deepEqual(flows.calls, []);

  // the flows that run while busy
  const busy = fakeStore({ busy: true });
  assert.equal(await runFlow({ flow: 'openTerminal' }, busy, flows), true);
  assert.equal(await runFlow({ flow: 'cancel' }, busy, flows), true);
  assert.deepEqual(flows.calls.map(([n]) => n), ['openTerminal', 'cancel']);

  // only `true` counts as success
  assert.equal(await runFlow({ flow: 'x' }, store, { x: async () => 'yes' }), false);
  assert.equal(await runFlow({ flow: 'x' }, store, { x: () => true }), true, 'sync flows too');
});

test('runFlow: never throws; an error that write() did not toast is logged and toasted', async () => {
  const { A: { runFlow } } = loadActions();
  const store = fakeStore();
  const [r1, e1] = await capturingErrors(() => runFlow({ flow: 'x' }, store, { x: async () => { throw new Error('boom'); } }));
  assert.equal(r1, false);
  assert.equal(e1.length, 1);
  assert.equal(store.toasts.length, 1);
  assert.equal(store.toasts[0].message, 'boom');

  const [r2, e2] = await capturingErrors(() => runFlow({ flow: 'x' }, store, { x: () => { throw { message: 'plain', kind: 'k' }; } }));
  assert.equal(r2, false, 'a synchronous throw of a plain object');
  assert.equal(e2.length, 1);
  assert.ok(store.toasts[1] instanceof Error);
  assert.equal(store.toasts[1].kind, 'k');

  const toasted = Object.assign(new Error('already shown'), { toasted: true });
  const [r3, e3] = await capturingErrors(() => runFlow({ flow: 'x' }, store, { x: async () => { throw toasted; } }));
  assert.equal(r3, false);
  assert.equal(e3.length, 0);
  assert.equal(store.toasts.length, 2, 'not toasted twice');

  // a store whose toast throws still resolves false
  const bad = { state: {}, actions: { toast: () => { throw new Error('no toast'); } } };
  const [r4] = await capturingErrors(() => runFlow({ flow: 'x' }, bad, { x: async () => { throw new Error('boom'); } }));
  assert.equal(r4, false);
});

test('runFlow uses window.PLFlows by default', async () => {
  const { win, A: { runFlow } } = loadActions();
  const flows = fakeFlows();
  win.PLFlows = flows;
  const store = fakeStore();
  assert.equal(await runFlow({ flow: 'pull', args: ['rebase'] }, store), true);
  assert.deepEqual(flows.calls.map(([n, , ...a]) => [n, ...a]), [['pull', 'rebase']]);
});

test('toMenuItems: maps descriptors to menu items whose actions run the flow', async () => {
  const { A: { toMenuItems } } = loadActions();
  const store = fakeStore();
  const flows = fakeFlows();
  const items = toMenuItems([
    { label: 'Checkout', flow: 'checkout', args: [{ target: 'x' }] },
    { separator: true },
    { label: 'Delete', flow: 'push', args: [], danger: true, disabled: true, title: 'why' },
    { label: 'Mode', flow: 'pull', args: ['rebase'], checked: true },
    { label: 'Other', flow: 'pull', args: ['ff-only'], checked: false },
  ], store, flows);
  assert.deepEqual(items.map((it) => Object.fromEntries(Object.entries(it).filter(([k]) => k !== 'action'))), [
    { label: 'Checkout', danger: false, disabled: false, title: undefined },
    { separator: true },
    { label: 'Delete', danger: true, disabled: true, title: 'why' },
    { label: 'Mode', danger: false, disabled: false, title: undefined, checked: true },
    { label: 'Other', danger: false, disabled: false, title: undefined, checked: false },
  ]);
  assert.equal('checked' in items[0], false, 'no checkbox role unless the descriptor has checked');
  for (const it of items) if (!it.separator) assert.equal(it.action(), undefined, 'actions return nothing (fire and forget)');
  await H.flush();
  assert.deepEqual(flows.calls.map(([n, st, ...a]) => [n, st === store, ...a]), [
    ['checkout', true, { target: 'x' }], ['pull', true, 'rebase'], ['pull', true, 'ff-only'],
  ]);
  assert.deepEqual(toMenuItems(null, store, flows), []);
});

// ------------------------------------------------------------------ bindContextMenu (harness fake DOM)

function menuSetup() {
  const { win, A } = loadActions();
  const dom = H.fakeDom().install();
  dom.attach(win);
  const opened = [];
  win.Components.menu = { open: (anchor, items) => opened.push({ anchor, items }), close() {}, isOpen: () => false };
  const host = dom.document.createElement('div');
  dom.document.body.append(host);
  const a = dom.document.createElement('div');
  a.dataset.id = 'a';
  const b = dom.document.createElement('div');
  b.dataset.id = 'b';
  const inner = dom.document.createElement('span');
  b.append(inner);
  host.append(a, b);
  const seen = [];
  const dispose = A.bindContextMenu(host, {
    targetOf: (e) => {
      for (let n = e.target; n && n !== host; n = n.parentNode) if (n.dataset && n.dataset.id) return n.dataset.id;
      return null;
    },
    itemsFor: (t, e) => { seen.push([t, e.type]); return t === 'a' ? [] : [{ label: `item ${t}`, action() {} }]; },
    anchorOf: (t) => (t === 'b' ? b : null),
  });
  return { win, A, dom, opened, host, a, b, inner, seen, dispose };
}

/** Run fn with Date.now pinned to `t`. */
function at(t, fn) {
  const orig = Date.now;
  Date.now = () => t;
  try { return fn(); } finally { Date.now = orig; }
}

test('bindContextMenu: right-click opens at the pointer; pointerless events anchor on the target', () => {
  const t = menuSetup();
  const e = t.dom.dispatch(t.inner, 'contextmenu', { clientX: 30, clientY: 40 });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(t.opened.map((o) => [o.anchor, o.items.map((i) => i.label)]), [[{ x: 30, y: 40 }, ['item b']]]);
  assert.deepEqual(t.seen, [['b', 'contextmenu']]);

  t.dom.dispatch(t.inner, 'contextmenu', { clientX: 0, clientY: 0 });
  assert.equal(t.opened[1].anchor, t.b, 'anchorOf');

  // no target / no items: nothing opens, the native menu is still suppressed
  const none = t.dom.dispatch(t.host, 'contextmenu', { clientX: 5, clientY: 5 });
  assert.equal(none.defaultPrevented, true);
  t.dom.dispatch(t.a, 'contextmenu', { clientX: 5, clientY: 5 });
  assert.equal(t.opened.length, 2);
  t.dispose();
});

test('bindContextMenu: ContextMenu key and Shift+F10 open anchored on the target; plain F10 does not', () => {
  const t = menuSetup();
  const e = t.dom.key('ContextMenu', {}, t.inner);
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.stopped, true, 'the key does not reach other handlers');
  assert.equal(t.opened.length, 1);
  assert.equal(t.opened[0].anchor, t.b);
  assert.deepEqual(t.seen.at(-1), ['b', 'keydown']);

  at(Date.now() + 10000, () => t.dom.key('F10', { shiftKey: true }, t.inner));
  assert.equal(t.opened.length, 2);

  const plain = t.dom.key('F10', {}, t.inner);
  assert.equal(plain.defaultPrevented, false);
  const other = t.dom.key('Enter', {}, t.inner);
  assert.equal(other.defaultPrevented, false);
  assert.equal(t.opened.length, 2);

  // the default anchor is the event target
  const { win, A, dom } = t;
  const host2 = dom.document.createElement('div');
  dom.document.body.append(host2);
  const opened = [];
  A.bindContextMenu(host2, { targetOf: () => 'x', itemsFor: () => [{ label: 'x', action() {} }], menu: { open: (anchor) => opened.push(anchor) } });
  dom.key('ContextMenu', {}, host2);
  assert.deepEqual(opened, [host2], 'explicit menu option; anchored on the event target');
  assert.ok(win.Components.menu);
  t.dispose();
});

test('bindContextMenu: the contextmenu event that follows a keyboard-opened menu is swallowed (keyMenuAt)', () => {
  const t = menuSetup();
  const t0 = 1_000_000;
  at(t0, () => t.dom.key('ContextMenu', {}, t.inner));
  assert.equal(t.opened.length, 1);
  const dup = at(t0 + 100, () => t.dom.dispatch(t.inner, 'contextmenu', { clientX: 0, clientY: 0 }));
  assert.equal(dup.defaultPrevented, true);
  assert.equal(t.opened.length, 1, 'de-duplicated');
  at(t0 + 600, () => t.dom.dispatch(t.inner, 'contextmenu', { clientX: 1, clientY: 1 }));
  assert.equal(t.opened.length, 2, 'a later right-click opens again');

  // a key that opened nothing does not swallow the next right-click
  at(t0 + 5000, () => t.dom.key('ContextMenu', {}, t.a));
  at(t0 + 5050, () => t.dom.dispatch(t.inner, 'contextmenu', { clientX: 1, clientY: 1 }));
  assert.equal(t.opened.length, 3);
  t.dispose();
});

test('bindContextMenu: the disposer removes both listeners; no menu component means no-op', () => {
  const t = menuSetup();
  t.dispose();
  const e = t.dom.dispatch(t.inner, 'contextmenu', { clientX: 3, clientY: 3 });
  t.dom.key('ContextMenu', {}, t.inner);
  assert.equal(e.defaultPrevented, false);
  assert.equal(t.opened.length, 0);
  assert.equal((t.host.__listeners || []).length, 0);

  const u = menuSetup();
  u.win.Components.menu = undefined;
  u.dom.dispatch(u.inner, 'contextmenu', { clientX: 3, clientY: 3 });
  assert.deepEqual(u.seen, [], 'itemsFor not called without a menu');
  u.dispose();
});

// ------------------------------------------------------------------ rebase / merge in progress (docs/plans/rebase.md §5.5)

const opState = (st, o = {}) => state({ status: { ...H.status({ oid: 'aaaaaaa1', branch: null }), upstream: 'origin/main', ...st }, ...o });
const rebasingState = (o) => opState({ state: 'rebasing', rebase: H.rebaseState() }, o);
const mergingState = (o) => opState({ state: 'merging', branch: 'main', merge: { head: 'f', name: 'topic', message: 'm' } }, o);

test('availability while rebasing: only Fetch, Terminal (and a Pull set to Fetch All) stay; the others say why', () => {
  const { A: { availability } } = loadActions();
  const st = rebasingState({
    stashes: [{ index: 0, ref: 'stash@{0}', hash: 'd', message: 'x' }],
    undo: { undo: { description: 'Undo commit' }, redo: null, busy: false, undoBlocked: null, redoBlocked: null },
  });
  const a = availability(st, { dirty: true, pullMode: 'ff-if-possible' });
  const view = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.disabled ? v.title : 'on']));
  assert.deepEqual(view, {
    undo: 'Undo is unavailable while a rebase is in progress',
    redo: 'Nothing to redo',
    pull: 'Pull — a rebase is in progress',
    pullMenu: 'Pull options — a rebase is in progress',
    fetch: 'on',
    push: 'Push — a rebase is in progress',
    branch: 'Branch — finish or abort the rebase first',
    stash: 'Stash — finish or abort the rebase first',
    pop: 'Pop — finish or abort the rebase first',
    terminal: 'on',
    switcher: 'Switch branch — finish or abort the rebase first',
  });
  assert.equal(availability(st, { pullMode: 'fetch', pullLabel: 'Fetch All' }).pull.disabled, false, 'Fetch All only fetches');
  assert.equal(availability(st, { pullMode: 'rebase', pullLabel: 'Pull (rebase)' }).pull.title, 'Pull (rebase) — a rebase is in progress');
});

test('availability while merging or in another operation; busy still wins; a clean state changes nothing', () => {
  const { A: { availability } } = loadActions();
  const m = availability(mergingState(), { dirty: true });
  assert.equal(m.push.title, 'Push — a merge is in progress');
  assert.equal(m.branch.title, 'Branch — finish or abort the merge first');
  assert.equal(m.fetch.disabled, false);
  const cp = availability(opState({ state: 'cherry-picking', branch: 'main' }));
  assert.equal(cp.stash.title, 'Stash — finish or abort the cherry-pick first');
  const busy = availability(rebasingState({ busy: true }));
  assert.equal(busy.fetch.title, 'Fetch — Working…', 'busy first');
  assert.deepEqual(availability(opState({ state: 'clean', branch: 'main', ahead: 2 }), { dirty: true }), availability(state(), { dirty: true }));
});

test('gateItems while rebasing: every start of a conflicting op is disabled with a reason; fetch / setUpstream / stashDrop stay', () => {
  const { A: { gateItems, START_FLOWS } } = loadActions();
  const descs = [
    { label: 'Checkout', flow: 'checkout', args: [{ target: 'feat/x', kind: 'local' }] },
    { label: 'Create branch here…', flow: 'createBranch', args: [{ start: 'b' }] },
    { label: 'Delete', flow: 'deleteBranch', args: ['feat/x'] },
    { label: 'Push', flow: 'push', args: [{ branch: 'feat/x' }] },
    { label: 'Pull', flow: 'pull', args: [] },
    { label: 'Pop', flow: 'stashPop', args: ['d'] },
    { label: 'Apply', flow: 'stashApply', args: ['d'] },
    { label: 'Merge', flow: 'merge', args: [] },
    { label: 'Rebase', flow: 'rebase', args: [] },
    { separator: true },
    { label: 'Fetch origin', flow: 'fetch', args: [{ remote: 'origin' }] },
    { label: 'Set upstream…', flow: 'setUpstream', args: ['feat/x'] },
    { label: 'Drop', flow: 'stashDrop', args: ['d'] },
    { label: 'Already off', flow: 'checkout', disabled: true, title: 'its own reason' },
  ];
  const view = (list) => list.map((d) => (d.separator ? '---' : [d.label, d.disabled ? d.title : 'on']));
  assert.deepEqual(view(gateItems(descs, rebasingState())), [
    ['Checkout', 'Checkout — finish or abort the rebase first'],
    ['Create branch here…', 'Branch — finish or abort the rebase first'],
    ['Delete', 'Delete branch — finish or abort the rebase first'],
    ['Push', 'Push — a rebase is in progress'],
    ['Pull', 'Pull — a rebase is in progress'],
    ['Pop', 'Pop stash — finish or abort the rebase first'],
    ['Apply', 'Apply stash — finish or abort the rebase first'],
    ['Merge', 'Merge — finish or abort the rebase first'],
    ['Rebase', 'Rebase — finish or abort the rebase first'],
    '---',
    ['Fetch origin', 'on'],
    ['Set upstream…', 'on'],
    ['Drop', 'on'],
    ['Already off', 'its own reason'],
  ]);
  assert.equal(gateItems(descs, mergingState())[0].title, 'Checkout — finish or abort the merge first');
  assert.ok(gateItems(descs, state()).every((d) => d.separator || d.label === 'Already off' || !d.disabled), 'clean: unchanged');
  assert.ok(Object.isFrozen(START_FLOWS));
});

test('headView: the branch, the branch being rebased, a detached commit, or nothing yet (status, then refs, then repo)', () => {
  const { A } = loadActions();
  const SHA = 'a'.repeat(40);
  assert.deepEqual(A.headView({ status: H.status({ oid: SHA, branch: 'x‮' }) }),
    { branch: 'x‮', rebasingBranch: null, oid: SHA, detached: false, label: 'x\\u{202E}' });
  assert.deepEqual(A.headView({ status: H.status({ oid: SHA, branch: null, state: 'rebasing', rebase: H.rebaseState({ branch: 'feat' }) }) }),
    { branch: null, rebasingBranch: 'feat', oid: SHA, detached: true, label: 'feat (rebasing)' });
  assert.deepEqual(A.headView({ status: H.status({ oid: SHA, branch: null }) }),
    { branch: null, rebasingBranch: null, oid: SHA, detached: true, label: 'detached HEAD' });
  assert.deepEqual(A.headView({ status: H.status({ oid: null, branch: 'main' }) }),
    { branch: 'main', rebasingBranch: null, oid: null, detached: false, label: 'main' }, 'unborn');
  assert.deepEqual(A.headView({ refs: H.refs({ head: { branch: 'dev', oid: SHA, detached: false } }) }).branch, 'dev', 'no status yet: refs');
  assert.deepEqual(A.headView({ repo: { root: '/r', head: { branch: 'r', sha: SHA } } }), { branch: 'r', rebasingBranch: null, oid: SHA, detached: false, label: 'r' });
  assert.deepEqual(A.headView({}), { branch: null, rebasingBranch: null, oid: null, detached: false, label: null });
});
