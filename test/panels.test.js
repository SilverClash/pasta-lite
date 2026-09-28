'use strict';
// Resizable side panels: the pure PLPanels model (renderer/components/panels.js: clamping, the fit
// to the available width, resizing, the preference and its storage), and the mounted 'panels'
// component on H.componentDom (CSS variables on .repo-main, separators, pointer drags, keyboard,
// double-click reset, a restart, cleanup).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const PANELS = require.resolve('../renderer/components/panels.js');

/** A fresh PLPanels without the DOM part (module cache cleared, no window). */
function freshPanels() {
  delete require.cache[PANELS];
  return require(PANELS);
}

const DEFAULTS = { sidebar: 260, details: 380 };

// ------------------------------------------------------------------ pure model

test('PLPanels.sanitize: numbers are rounded and clamped to each panel, anything else is the default (null)', () => {
  const K = freshPanels();
  assert.deepEqual(K.sanitize(null), { sidebar: null, details: null });
  assert.deepEqual(K.sanitize('junk'), K.sanitize(null));
  assert.deepEqual(K.sanitize({ sidebar: 5, details: 10000 }), { sidebar: 160, details: 720 });
  assert.deepEqual(K.sanitize({ sidebar: 300.6, details: '400' }), { sidebar: 301, details: null });
  assert.equal(K.sanitize({ sidebar: Number.NaN }).sidebar, null);
  for (const p of K.PANELS) assert.ok(p.min < p.max && p.def >= p.min && p.def <= p.max, p.id);
});

test('PLPanels.layout: defaults from CSS, preferences, and the center keeps CENTER_MIN', () => {
  const K = freshPanels();
  const none = K.sanitize(null);
  assert.deepEqual(K.layout(none, { avail: 1600, defaults: DEFAULTS }).w, DEFAULTS);
  assert.deepEqual(K.layout(none, { avail: 1600, defaults: { sidebar: 200, details: 280 } }).w, { sidebar: 200, details: 280 });
  assert.deepEqual(K.layout(none, { avail: 1600 }).w, { sidebar: 260, details: 380 }, 'fallback defaults');
  assert.deepEqual(K.layout({ sidebar: 400, details: 500 }, { avail: 1600, defaults: DEFAULTS }).w, { sidebar: 400, details: 500 });
  // unknown width: nothing shrunk
  assert.equal(K.layout({ sidebar: 520, details: 720 }, { avail: 0 }).compressed, false);
  // narrow: both give up the same share of their room above the min
  const lay = K.layout({ sidebar: 520, details: 720 }, { avail: 1000, defaults: DEFAULTS });
  assert.equal(lay.compressed, true);
  assert.ok(1000 - lay.w.sidebar - lay.w.details >= K.CENTER_MIN);
  const share = (id) => (lay.want[id] - lay.w[id]) / (lay.want[id] - K.panel(id).min);
  assert.ok(Math.abs(share('sidebar') - share('details')) < 0.01);
  // even the mins don't fit: both at their min, the center is clipped
  assert.deepEqual(K.layout({ sidebar: 520, details: 720 }, { avail: 500 }).w, { sidebar: 160, details: 260 });
});

test('PLPanels.maxFor / resizeTo: clamped to the min, the max and the room the center can give', () => {
  const K = freshPanels();
  const none = K.sanitize(null);
  const lay = K.layout(none, { avail: 1200, defaults: DEFAULTS });
  assert.equal(K.maxFor('sidebar', lay), 1200 - K.CENTER_MIN - 380);
  assert.equal(K.maxFor('details', K.layout(none, { avail: 3000, defaults: DEFAULTS })), 720);
  assert.equal(K.maxFor('sidebar', null), 520);
  assert.equal(K.maxFor('nope', lay), 0);
  assert.deepEqual(K.resizeTo(none, 'sidebar', 10, lay), { sidebar: 160, details: null });
  assert.deepEqual(K.resizeTo(none, 'sidebar', 5000, lay), { sidebar: 460, details: null });
  assert.deepEqual(K.resizeTo(none, 'details', 300.4, lay), { sidebar: null, details: 300 });
  assert.equal(K.resizeTo(none, 'details', Number.NaN, lay), none);
  // a compressed layout: the other panel keeps what is shown
  const tight = K.layout({ sidebar: 520, details: 720 }, { avail: 1000, defaults: DEFAULTS });
  const next = K.resizeTo(tight.want, 'sidebar', 200, tight);
  assert.equal(next.sidebar, 200);
  assert.equal(next.details, tight.w.details);
});

test('PLPanels.createPrefs: reads storage once, saves only non-defaults, announces changes', () => {
  const K = freshPanels();
  const saved = new Map([[K.KEY, { sidebar: 300, details: 'x' }]]);
  const storage = { get: (k, fb) => (saved.has(k) ? saved.get(k) : fb), set: (k, v) => saved.set(k, v) };
  const prefs = K.createPrefs(storage);
  assert.deepEqual(prefs.get(), { sidebar: 300, details: null });
  const seen = [];
  const unsub = prefs.subscribe((w) => seen.push(w));
  assert.equal(prefs.set({ sidebar: 300, details: null }), false, 'unchanged');
  assert.equal(prefs.set({ sidebar: 300, details: 450 }), true);
  assert.deepEqual(saved.get(K.KEY), { sidebar: 300, details: 450 });
  assert.equal(prefs.reset(), true);
  assert.deepEqual(saved.get(K.KEY), {});
  assert.equal(prefs.isDefault(), true);
  unsub();
  prefs.set({ sidebar: 200 });
  assert.equal(seen.length, 2);
  // no storage: in memory only
  const mem = K.createPrefs(null);
  mem.set({ sidebar: 222 });
  assert.equal(mem.get().sidebar, 222);
});

// ------------------------------------------------------------------ mounted component

function mountPanels(tc, { storage = H.memoryStorage(), width = 1600 } = {}) {
  const win = H.loadRenderer();
  const dom = H.componentDom();
  Object.defineProperty(globalThis, 'document', { value: dom.doc, configurable: true, writable: true });
  H.setLocalStorage(storage);
  const observers = [];
  globalThis.ResizeObserver = class { constructor(cb) { observers.push(cb); } observe() {} disconnect() { observers.length = 0; } };
  delete require.cache[PANELS];
  require(PANELS);
  const root = dom.doc.createElement('div');
  root.className = 'repo-main';
  root.dataset.component = 'panels';
  const sidebar = dom.doc.createElement('aside');
  sidebar.className = 'sidebar';
  const center = dom.doc.createElement('main');
  center.className = 'center';
  const details = dom.doc.createElement('aside');
  details.className = 'details';
  root.append(sidebar, center, details);
  dom.doc.body.append(root);
  root.clientWidth = width;
  const unmount = win.Components.mountAll({ querySelectorAll: () => [root], contains: (n) => n === root }, null);
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; unmount(); } };
  tc.after(() => { dispose(); delete globalThis.ResizeObserver; });
  const resize = (w) => { root.clientWidth = w; for (const cb of [...observers]) cb([]); };
  const handle = (id) => root.querySelectorAll('.pn-resize').find((r) => r.dataset.panel === id);
  const px = (id) => root.style.getPropertyValue(`--${id}-w`);
  const saved = () => JSON.parse(storage.getItem('pl.panels') || 'null');
  const drag = (id, from, to) => {
    const r = handle(id);
    dom.dispatch(r, 'pointerdown', { pointerId: 1, clientX: from });
    dom.dispatch(r, 'pointermove', { pointerId: 1, clientX: to });
    dom.dispatch(r, 'pointerup', { pointerId: 1, clientX: to });
  };
  return { win, dom, root, resize, handle, px, saved, drag, dispose, storage, observers };
}

test('mounted panels: separators on the inner edges, widths as CSS variables, ARIA values', (tc) => {
  const t = mountPanels(tc);
  assert.deepEqual(t.root.children.map((c) => c.className), ['sidebar', 'pn-resize pn-resize-sidebar', 'center', 'pn-resize pn-resize-details', 'details']);
  assert.equal(t.px('sidebar'), '260px');
  assert.equal(t.px('details'), '380px');
  const r = t.handle('sidebar');
  assert.equal(r.getAttribute('role'), 'separator');
  assert.equal(r.getAttribute('aria-orientation'), 'vertical');
  assert.equal(r.getAttribute('aria-valuenow'), '260');
  assert.equal(r.getAttribute('aria-valuemax'), '520', 'its own max');
  t.resize(1000);
  assert.equal(r.getAttribute('aria-valuemax'), String(1000 - 360 - 380), 'the room the center can give');
});

test('mounted panels: dragging resizes live, saves on release, follows the pointer on both sides', (tc) => {
  const t = mountPanels(tc);
  const r = t.handle('sidebar');
  t.dom.dispatch(r, 'pointerdown', { pointerId: 1, clientX: 260 });
  assert.ok(t.dom.doc.body.classList.contains('pn-resizing'), 'no text selection / col-resize cursor while dragging');
  t.dom.dispatch(r, 'pointermove', { pointerId: 1, clientX: 320 });
  assert.equal(t.px('sidebar'), '320px');
  assert.equal(t.saved(), null, 'not saved mid-drag');
  t.dom.dispatch(r, 'pointerup', { pointerId: 1, clientX: 320 });
  assert.ok(!t.dom.doc.body.classList.contains('pn-resizing'));
  assert.deepEqual(t.saved(), { sidebar: 320 });
  // the details separator is on its left edge: moving left widens it
  t.drag('details', 1000, 900);
  assert.equal(t.px('details'), '480px');
  assert.deepEqual(t.saved(), { sidebar: 320, details: 480 });
  // clamped to its max, and so the center keeps CENTER_MIN
  t.drag('details', 900, 0);
  assert.equal(t.px('details'), '720px');
  t.resize(1200); // compressed: both give up some width
  t.drag('details', 900, 0);
  const side = parseInt(t.px('sidebar'), 10);
  assert.ok(side < 320, `sidebar ${side}`);
  assert.equal(t.px('details'), `${1200 - 360 - side}px`);
  assert.deepEqual(t.saved(), { sidebar: side, details: 1200 - 360 - side }, 'what is shown is what is kept');
});

test('mounted panels: double-click and Enter reset to the default, keys move the separator', (tc) => {
  const t = mountPanels(tc);
  t.drag('sidebar', 0, 100);
  assert.equal(t.px('sidebar'), '360px');
  t.dom.dispatch(t.handle('sidebar'), 'dblclick');
  assert.equal(t.px('sidebar'), '260px');
  assert.deepEqual(t.saved(), {});
  t.dom.key('ArrowRight', {}, t.handle('sidebar'));
  assert.equal(t.px('sidebar'), '270px');
  t.dom.key('ArrowRight', {}, t.handle('details'));
  assert.equal(t.px('details'), '370px', 'Right narrows the details panel (its edge moves right)');
  t.dom.key('Home', {}, t.handle('details'));
  assert.equal(t.px('details'), '260px');
  t.dom.key('Enter', {}, t.handle('details'));
  assert.equal(t.px('details'), '380px');
});

test('mounted panels: a restart reads the saved widths; a narrow window shrinks them without losing them', (tc) => {
  const storage = H.memoryStorage();
  storage.setItem('pl.panels', JSON.stringify({ sidebar: 400, details: 600 }));
  const t = mountPanels(tc, { storage });
  assert.equal(t.px('sidebar'), '400px');
  assert.equal(t.px('details'), '600px');
  t.resize(900);
  const s = parseInt(t.px('sidebar'), 10);
  const d = parseInt(t.px('details'), 10);
  assert.ok(900 - s - d >= 360, `${s} + ${d}`);
  assert.deepEqual(t.saved(), { sidebar: 400, details: 600 }, 'the preference is kept');
  t.resize(1600);
  assert.equal(t.px('sidebar'), '400px');
});

test('mounted panels: unmount removes the separators, the variables and the listeners', (tc) => {
  const t = mountPanels(tc);
  const r = t.handle('sidebar');
  t.dom.dispatch(r, 'pointerdown', { pointerId: 1, clientX: 0 });
  t.dispose();
  assert.equal(t.root.querySelectorAll('.pn-resize').length, 0);
  assert.equal(t.px('sidebar'), '');
  assert.equal(t.root.__l.length, 0);
  assert.equal(t.observers.length, 0);
  assert.ok(!t.dom.doc.body.classList.contains('pn-resizing'), 'a drag in progress is ended');
});
