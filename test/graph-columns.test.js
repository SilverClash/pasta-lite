'use strict';
// Resizable columns of the commit graph: the pure PLColumns model (renderer/components/
// graph-columns.js: clamping, the fit to the available width, resizing, auto-fit, the preference and
// its storage), and the mounted graph-view on H.componentDom (CSS variables, separators, keyboard,
// pointer drags, double-click auto-fit, the header's Reset menu, narrow windows, a restart).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const COLS = require.resolve('../renderer/components/graph-columns.js');
const ACTIONS = require.resolve('../renderer/actions.js');
const GRAPH = require.resolve('../renderer/components/graph-view.js');

/** A fresh PLColumns (module cache cleared). */
function freshCols() {
  delete require.cache[COLS];
  return require(COLS);
}

const SHA = (c) => c.repeat(40);
const LONG = 'feature/my-very-long-branch-name-that-truncates';

// ------------------------------------------------------------------ pure model

test('PLColumns.sanitize: numbers are rounded and clamped to each column, anything else is the default (null)', () => {
  const K = freshCols();
  assert.deepEqual(K.sanitize(null), { refs: null, graph: null, author: null, date: null, sha: null });
  assert.deepEqual(K.sanitize('junk'), K.sanitize(null));
  assert.deepEqual(
    K.sanitize({ refs: 5, graph: 10000, author: 150.6, date: '120', sha: Number.NaN, other: 3 }),
    { refs: 60, graph: 600, author: 151, date: null, sha: null },
  );
  assert.deepEqual(K.sanitize({ refs: Infinity }).refs, null);
  for (const c of K.COLUMNS) assert.ok(c.min < c.max && (c.def === null || (c.def >= c.min && c.def <= c.max)), c.id);
});

test('PLColumns.layout: defaults, the automatic GRAPH width, hidden secondary columns and the message column', () => {
  const K = freshCols();
  const none = K.sanitize(null);
  const wide = K.layout(none, { avail: 1400, graphAuto: 104 });
  assert.deepEqual(wide.w, { refs: 170, graph: 104, author: 140, date: 118, sha: 74 });
  assert.deepEqual(wide.hidden, { refs: false, graph: false, author: false, date: false, sha: false });
  assert.equal(wide.msg, 1400 - (170 + 104 + 140 + 118 + 74));
  assert.equal(wide.compressed, false);
  // unknown width (not laid out yet): nothing hidden or shrunk
  assert.equal(K.layout(none, { avail: 0 }).msg, null);
  assert.equal(K.layout(none, { avail: 0 }).hidden.author, false);
  // the old container-query breakpoints: AUTHOR < 900, DATE < 760, SHA < 640
  assert.deepEqual(K.layout(none, { avail: 899 }).hidden, { refs: false, graph: false, author: true, date: false, sha: false });
  assert.deepEqual(K.layout(none, { avail: 700 }).hidden, { refs: false, graph: false, author: true, date: true, sha: false });
  assert.deepEqual(K.layout(none, { avail: 600 }).hidden, { refs: false, graph: false, author: true, date: true, sha: true });
  assert.equal(K.graphAuto(10), K.AUTO_MIN);
  assert.equal(K.graphAuto(1000), K.AUTO_MAX);
  assert.equal(K.graphAuto(126), 126);
});

test('PLColumns.layout: a narrow width shrinks the shown columns toward their mins so the message keeps MSG_MIN', () => {
  const K = freshCols();
  const big = K.sanitize({ refs: 480, graph: 600, author: 400, date: 300, sha: 200 });
  const lay = K.layout(big, { avail: 1000 });
  assert.equal(lay.compressed, true);
  assert.deepEqual(lay.want, big);
  assert.ok(lay.msg >= K.MSG_MIN, `msg ${lay.msg}`);
  for (const c of K.COLUMNS) {
    if (lay.hidden[c.id]) continue;
    assert.ok(lay.w[c.id] >= c.min && lay.w[c.id] <= big[c.id], `${c.id} ${lay.w[c.id]}`);
  }
  // the same share of each column's room above its min
  const share = (id) => (big[id] - lay.w[id]) / (big[id] - K.column(id).min);
  assert.ok(Math.abs(share('refs') - share('graph')) < 0.01);
  // even the mins don't fit: every column at its min, the message column is what is clipped
  const tiny = K.layout(big, { avail: 200 });
  for (const id of ['refs', 'graph']) assert.equal(tiny.w[id], K.column(id).min);
  assert.equal(tiny.msg, 200 - 60 - 32);
});

test('PLColumns.maxFor / resizeTo: clamped to the min, the max and the room the message column can give', () => {
  const K = freshCols();
  const none = K.sanitize(null);
  const lay = K.layout(none, { avail: 1400, graphAuto: 60 });
  assert.equal(K.maxFor('refs', lay), 480, 'plenty of room: the column max');
  assert.equal(K.resizeTo(none, 'refs', 10, lay).refs, 60);
  assert.equal(K.resizeTo(none, 'refs', 250.4, lay).refs, 250);
  assert.equal(K.resizeTo(none, 'refs', 9999, lay).refs, 480);
  assert.equal(K.resizeTo(none, 'refs', Number.NaN, lay), none, 'not a number: unchanged');
  const tight = K.layout(none, { avail: 1000, graphAuto: 60 });
  const room = tight.msg - K.MSG_MIN;
  assert.equal(K.maxFor('refs', tight), 170 + room);
  assert.equal(K.maxFor('author', tight), 400, 'never above the column max');
  assert.equal(K.resizeTo(none, 'refs', 9999, tight).refs, 170 + room);
  const after = K.layout(K.resizeTo(none, 'refs', 9999, tight), { avail: 1000, graphAuto: 60 });
  assert.equal(after.msg, K.MSG_MIN, 'grown to exactly the message minimum');
  // compressed: what is shown is kept for the other columns
  const big = K.sanitize({ refs: 480, graph: 600 });
  const squeezed = K.layout(big, { avail: 1000, graphAuto: 60 });
  const next = K.resizeTo(big, 'sha', 60, squeezed);
  assert.equal(next.sha, 60);
  assert.equal(next.refs, squeezed.w.refs);
  assert.equal(next.graph, squeezed.w.graph);
  assert.equal(next.author, squeezed.w.author, 'a shrunk default column too');
  const atMin = K.sanitize({ refs: 480, graph: 600, author: 50 });
  assert.equal(K.resizeTo(atMin, 'sha', 60, K.layout(atMin, { avail: 1000, graphAuto: 60 })).author, 50, 'unchanged: at its min');
  assert.deepEqual(K.resizeTo(none, 'sha', 60, lay), { ...none, sha: 60 }, 'not compressed: only the resized column');
});

test('PLColumns.fitWidth: the widest measured value plus slack, clamped; GRAPH and nothing measured -> the default', () => {
  const K = freshCols();
  assert.equal(K.fitWidth('author', [40, 97.2, 12]), 100);
  assert.equal(K.fitWidth('author', [1]), 50, 'at least the min');
  assert.equal(K.fitWidth('author', [5000]), 400, 'at most the max');
  assert.equal(K.fitWidth('author', []), null);
  assert.equal(K.fitWidth('author', [Number.NaN, 0]), null);
  assert.equal(K.fitWidth('graph', [200]), null, 'GRAPH fits its lanes automatically');
  assert.equal(K.fitWidth('nope', [200]), null);
});

test('PLColumns prefs: saved (defaults left out), read back by a fresh instance, announced; storage failures stay in memory', () => {
  const ls = H.memoryStorage();
  H.setLocalStorage(ls);
  const win = H.loadRenderer();
  const K = freshCols();
  const prefs = K.createPrefs(win.Components.util.storage);
  const seen = [];
  const off = prefs.subscribe((w) => seen.push(w));
  assert.equal(prefs.isDefault(), true);
  assert.equal(prefs.set({ refs: 300, sha: 1 }), true);
  assert.deepEqual(JSON.parse(ls.getItem(K.KEY)), { refs: 300, sha: 50 });
  assert.equal(prefs.set({ refs: 300, sha: 50 }), false, 'unchanged: not saved again');
  assert.equal(seen.length, 1);
  const again = K.createPrefs(win.Components.util.storage);
  assert.deepEqual(again.get(), { refs: 300, graph: null, author: null, date: null, sha: 50 });
  again.reset();
  assert.deepEqual(JSON.parse(ls.getItem(K.KEY)), {});
  assert.equal(again.isDefault(), true);
  off();
  prefs.set({ refs: 200 });
  assert.equal(seen.length, 1, 'unsubscribed');
  // corrupt JSON and throwing storage: defaults, no throw
  ls.setItem(K.KEY, '{nope');
  assert.equal(K.createPrefs(win.Components.util.storage).isDefault(), true);
  H.setLocalStorage(H.throwingStorage());
  const mem = K.createPrefs(win.Components.util.storage);
  assert.equal(mem.set({ date: 99 }), true);
  assert.equal(mem.get().date, 99);
  H.setLocalStorage(H.memoryStorage());
});

// ------------------------------------------------------------------ mounted graph-view

function graphData() {
  const refs = H.refs({
    head: { branch: 'main', oid: SHA('a'), detached: false },
    local: [
      { name: 'main', oid: SHA('a'), upstream: null, ahead: 0, behind: 0, gone: false, current: true },
      { name: LONG, oid: SHA('b'), upstream: null, ahead: 0, behind: 0, gone: false, current: false },
    ],
  });
  const commits = H.chain([SHA('a'), SHA('b'), SHA('c')]);
  commits[1] = { ...commits[1], author: 'Bartholomew Wolfeschlegelstein' };
  return H.repoData({ commits, status: H.status({ oid: SHA('a') }), refs });
}

/**
 * The graph mounted on H.componentDom with `storage`, its scroller `width` px wide. Elements get an
 * offsetWidth of 7px per character (the auto-fit probe reads it). resize(w) fires the ResizeObserver.
 */
async function mountGraph(tc, { storage = H.memoryStorage(), width = 1400, data = graphData() } = {}) {
  const { win, api, store } = await H.loadedStore(data);
  const dom = H.componentDom();
  Object.defineProperty(globalThis, 'document', { value: dom.doc, configurable: true, writable: true });
  Object.defineProperty(dom.El.prototype, 'offsetWidth', { configurable: true, get() { return this.textContent.length * 7; } });
  H.setLocalStorage(storage);
  win.addEventListener = dom.win.addEventListener;
  win.removeEventListener = dom.win.removeEventListener;
  const observers = [];
  globalThis.ResizeObserver = class { constructor(cb) { observers.push(cb); } observe() {} disconnect() {} };
  dom.doc.body.dataset.view = 'repo';
  for (const p of [ACTIONS, COLS, GRAPH]) delete require.cache[p];
  require(ACTIONS);
  require(COLS);
  require(GRAPH);
  win.PLFlows = {};
  const opened = [];
  win.Components.menu = { open: (anchor, items) => opened.push({ anchor, items }), close() {}, isOpen: () => false };
  const root = dom.doc.createElement('section');
  root.dataset.component = 'graph-view';
  dom.doc.body.append(root);
  const unmount = win.Components.mountAll({ querySelectorAll: () => [root], contains: (n) => n === root }, store);
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; unmount(); } };
  tc.after(dispose);
  const scroller = root.querySelector('.gv-scroll');
  const resize = (w) => { scroller.clientWidth = w; for (const cb of observers) cb([]); };
  resize(width);
  const handle = (id) => root.querySelector('.gv-header').querySelectorAll('.gv-resize').find((r) => r.dataset.col === id);
  const px = (id) => root.style.getPropertyValue(`--gv-${id}-w`);
  const saved = () => JSON.parse(storage.getItem('pl.graph.columns') || 'null');
  return { win, api, store, dom, root, scroller, resize, handle, px, saved, opened, storage, dispose, K: win.PLColumns };
}

test('mounted graph: the widths are CSS variables on the root and every separator is an ARIA separator', async (tc) => {
  const t = await mountGraph(tc);
  assert.deepEqual(['refs', 'graph', 'author', 'date', 'sha'].map(t.px), ['170px', '60px', '140px', '118px', '74px']);
  const hs = t.root.querySelectorAll('.gv-resize');
  assert.deepEqual(hs.map((h) => h.dataset.col), ['refs', 'graph', 'author', 'date', 'sha'], 'none on COMMIT MESSAGE');
  const r = t.handle('refs');
  assert.equal(r.getAttribute('role'), 'separator');
  assert.equal(r.getAttribute('aria-orientation'), 'vertical');
  assert.equal(r.getAttribute('aria-label'), 'Resize Branch / Tag column');
  assert.equal(r.tabIndex, 0);
  assert.deepEqual(['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].map((a) => r.getAttribute(a)), ['170', '60', '480']);
  assert.equal(t.handle('sha').getAttribute('aria-label'), 'Resize SHA column');
  assert.ok(t.handle('refs').classList.contains('gv-resize-right'));
  assert.ok(t.handle('author').classList.contains('gv-resize-left'));
  // the separators sit in their column headers; the header cells keep their role
  assert.equal(r.parentNode.getAttribute('role'), 'columnheader');
  assert.equal(t.saved(), null, 'nothing saved until the user resizes');
  t.dispose();
  assert.equal(t.px('refs'), '', 'variables removed on unmount');
});

test('mounted graph: arrows move a separator by 10px (Shift: 50px), Home / End give the min / max; the graph keeps its selection', async (tc) => {
  const t = await mountGraph(tc);
  const sel = t.store.state.selection;
  const r = t.handle('refs');
  r.focus();
  const e1 = t.dom.key('ArrowRight');
  assert.equal(e1.defaultPrevented, true);
  assert.equal(t.px('refs'), '180px');
  t.dom.key('ArrowRight', { shiftKey: true });
  assert.equal(t.px('refs'), '230px');
  t.dom.key('ArrowLeft');
  assert.equal(t.px('refs'), '220px');
  assert.equal(r.getAttribute('aria-valuenow'), '220');
  assert.deepEqual(t.saved(), { refs: 220 });
  t.dom.key('Home');
  assert.equal(t.px('refs'), '60px');
  t.dom.key('End');
  assert.equal(t.px('refs'), '480px');
  assert.deepEqual(t.store.state.selection, sel, 'Home / End / arrows did not move through the commits');
  // a left-border separator: Left widens its column
  const a = t.handle('author');
  a.focus();
  t.dom.key('ArrowLeft');
  assert.equal(t.px('author'), '150px');
  t.dom.key('ArrowRight', { shiftKey: true });
  assert.equal(t.px('author'), '100px');
  // modified keys belong to the app's shortcuts
  const m = t.dom.key('ArrowRight', { metaKey: true });
  assert.equal(m.defaultPrevented, false);
  assert.equal(t.px('author'), '100px');
  assert.deepEqual(t.saved(), { refs: 480, author: 100 });
});

test('mounted graph: End stops where the message column would drop below its minimum', async (tc) => {
  const t = await mountGraph(tc, { width: 1000 });
  const msg = 1000 - (170 + 60 + 140 + 118 + 74);
  const r = t.handle('refs');
  assert.equal(r.getAttribute('aria-valuemax'), String(170 + msg - t.K.MSG_MIN));
  r.focus();
  t.dom.key('End');
  assert.equal(t.px('refs'), `${170 + msg - t.K.MSG_MIN}px`);
  assert.equal(r.getAttribute('aria-valuemax'), r.getAttribute('aria-valuenow'));
});

test('mounted graph: dragging a separator resizes live with pointer capture and saves on release', async (tc) => {
  const t = await mountGraph(tc);
  const g = t.handle('graph');
  const captured = [];
  g.setPointerCapture = (id) => captured.push(['set', id]);
  g.releasePointerCapture = (id) => captured.push(['release', id]);
  const down = t.dom.dispatch(g, 'pointerdown', { pointerId: 7, clientX: 300, button: 0 });
  assert.equal(down.defaultPrevented, true);
  assert.ok(g.classList.contains('is-active'));
  assert.ok(t.root.classList.contains('gv-resizing'));
  t.dom.dispatch(g, 'pointermove', { pointerId: 7, clientX: 400 });
  assert.equal(t.px('graph'), '160px');
  t.dom.dispatch(g, 'pointermove', { pointerId: 8, clientX: 900 }); // another pointer: ignored
  assert.equal(t.px('graph'), '160px');
  t.dom.dispatch(g, 'pointermove', { pointerId: 7, clientX: 380 });
  assert.equal(t.px('graph'), '140px');
  assert.equal(t.saved(), null, 'not saved while dragging');
  t.dom.dispatch(g, 'pointerup', { pointerId: 7, clientX: 380 });
  assert.deepEqual(t.saved(), { graph: 140 });
  assert.deepEqual(captured, [['set', 7], ['release', 7]]);
  assert.ok(!g.classList.contains('is-active'));
  assert.ok(!t.root.classList.contains('gv-resizing'));
  t.dom.dispatch(g, 'pointermove', { pointerId: 7, clientX: 600 });
  assert.equal(t.px('graph'), '140px', 'released');
  // a left-border separator follows the pointer too: dragging left widens SHA; clamped to its min
  const s = t.handle('sha');
  t.dom.dispatch(s, 'pointerdown', { pointerId: 9, clientX: 1000, button: 0 });
  t.dom.dispatch(s, 'pointermove', { pointerId: 9, clientX: 970 });
  assert.equal(t.px('sha'), '104px');
  t.dom.dispatch(s, 'pointermove', { pointerId: 9, clientX: 1200 });
  assert.equal(t.px('sha'), '50px');
  t.dom.dispatch(s, 'pointercancel', { pointerId: 9 });
  assert.deepEqual(t.saved(), { graph: 140, sha: 50 });
  // the lanes need 38px: a GRAPH narrower than that is marked clipped
  t.handle('graph').focus();
  t.dom.key('Home');
  assert.equal(t.px('graph'), '32px');
  assert.ok(t.root.classList.contains('gv-graph-clipped'));
  // right button: no drag
  t.dom.dispatch(g, 'pointerdown', { pointerId: 3, clientX: 10, button: 2 });
  assert.ok(!t.root.classList.contains('gv-resizing'));
});

test('mounted graph: double-click or Enter fits a column to its loaded rows; GRAPH goes back to its automatic width', async (tc) => {
  const t = await mountGraph(tc);
  // BRANCH / TAG: the widest first pill (fake metric: 7px per character) + the 44px reserve + slack
  t.dom.dispatch(t.handle('refs'), 'dblclick');
  assert.equal(t.px('refs'), `${LONG.length * 7 + 44 + 2}px`);
  // AUTHOR: the longest author name
  t.handle('author').focus();
  t.dom.key('Enter');
  assert.equal(t.px('author'), `${'Bartholomew Wolfeschlegelstein'.length * 7 + 2}px`);
  // SHA: 7 characters, but never narrower than its min
  t.dom.dispatch(t.handle('sha'), 'dblclick');
  assert.equal(t.px('sha'), `${Math.max(50, 7 * 7 + 2)}px`);
  // DATE: the header label is measured too (a short value can't hide the title)
  t.dom.dispatch(t.handle('date'), 'dblclick');
  assert.ok(parseInt(t.px('date'), 10) >= 'Date'.length * 7);
  assert.equal(t.root.querySelectorAll('.gv-measure').length, 0, 'the probe is removed');
  // GRAPH: back to the lane-based width
  t.handle('graph').focus();
  t.dom.key('ArrowRight', { shiftKey: true });
  assert.equal(t.px('graph'), '110px');
  t.dom.dispatch(t.handle('graph'), 'dblclick');
  assert.equal(t.px('graph'), '60px');
  assert.equal(t.saved().graph, undefined, 'saved as the default');
});

test('mounted graph: the header menu (right-click, or the menu key on a separator) resets every width; so does the app menu command', async (tc) => {
  const t = await mountGraph(tc);
  const label = t.root.querySelector('.gv-header').querySelectorAll('.gv-h-label')[4];
  t.dom.dispatch(label, 'contextmenu', { clientX: 5, clientY: 6 });
  assert.equal(t.opened.length, 1);
  assert.deepEqual(t.opened[0].items.map((i) => [i.label, !!i.disabled]), [['Reset column widths', true]], 'nothing to reset yet');
  t.handle('refs').focus();
  t.dom.key('ArrowRight');
  t.handle('date').focus();
  t.dom.key('ArrowLeft');
  assert.deepEqual(t.saved(), { refs: 180, date: 128 });
  t.dom.key('F10', { shiftKey: true });
  assert.equal(t.opened.length, 2);
  assert.equal(t.opened[1].anchor, t.handle('date'), 'anchored on the separator');
  const [reset] = t.opened[1].items;
  assert.equal(reset.disabled, false);
  reset.action();
  assert.deepEqual(t.saved(), {});
  assert.equal(t.px('refs'), '170px');
  assert.equal(t.px('date'), '118px');
  // View > Reset Column Widths (app.js calls PLColumns.prefs.reset on the menu command)
  t.dom.key('ArrowLeft');
  assert.equal(t.px('date'), '128px');
  t.K.prefs.reset();
  assert.equal(t.px('date'), '118px');
});

test('mounted graph: a narrow window drops secondary columns and shrinks the rest; the saved widths stay', async (tc) => {
  const storage = H.memoryStorage();
  storage.setItem('pl.graph.columns', JSON.stringify({ refs: 400, graph: 300, author: 200 }));
  const t = await mountGraph(tc, { storage, width: 1600 });
  assert.deepEqual(['refs', 'graph', 'author'].map(t.px), ['400px', '300px', '200px']);
  t.resize(1000);
  const shown = ['refs', 'graph', 'author', 'date', 'sha'].map((id) => parseInt(t.px(id), 10));
  assert.ok(1000 - shown.reduce((a, b) => a + b, 0) >= t.K.MSG_MIN, `message column ${1000 - shown.reduce((a, b) => a + b, 0)}`);
  assert.ok(shown[0] < 400 && shown[1] < 300, 'shrunk');
  t.resize(700);
  assert.ok(t.root.classList.contains('gv-hide-author'));
  assert.ok(t.root.classList.contains('gv-hide-date'));
  assert.ok(!t.root.classList.contains('gv-hide-sha'));
  const visible = parseInt(t.px('refs'), 10) + parseInt(t.px('graph'), 10) + parseInt(t.px('sha'), 10);
  assert.ok(700 - visible >= t.K.MSG_MIN);
  assert.deepEqual(t.saved(), { refs: 400, graph: 300, author: 200 }, 'the preference is not rewritten by a resize');
  t.resize(1600);
  assert.deepEqual(['refs', 'graph', 'author'].map(t.px), ['400px', '300px', '200px'], 'wide again: the saved widths');
  assert.ok(!t.root.classList.contains('gv-hide-author'));
});

test('mounted graph: widths persist across a restart (a fresh mount on the same storage)', async (tc) => {
  const storage = H.memoryStorage();
  const t1 = await mountGraph(tc, { storage });
  t1.handle('refs').focus();
  t1.dom.key('ArrowRight', { shiftKey: true });
  t1.dom.key('ArrowRight', { shiftKey: true });
  t1.handle('sha').focus();
  t1.dom.key('ArrowLeft');
  t1.dispose();
  const t2 = await mountGraph(tc, { storage });
  assert.equal(t2.px('refs'), '270px');
  assert.equal(t2.px('sha'), '84px');
  assert.equal(t2.handle('refs').getAttribute('aria-valuenow'), '270');
});

// ------------------------------------------------------------------ paging look-ahead

test('graph-view asks for the next page within PAGE_AHEAD_PX of the bottom, not before', async (tc) => {
  const hs = Array.from({ length: 300 }, (_, i) => `c${299 - i}`);
  const data = H.repoData({ commits: H.chain(hs), status: H.status({ oid: hs[0] }), hasMore: true, next: { tips: [hs[0]], skip: 300 } });
  const g = await mountGraph(tc, { data });
  const { PAGE_AHEAD_PX, ROW_H } = require(GRAPH);
  const isMore = (c) => !!(c.args[0] && c.args[0].tips);
  const more = () => g.api.pending('log', isMore).length;
  // Mounted with no layout yet (scrollHeight 0), the graph asked for a page at once: let it land
  // into a scroller at the top of a tall history.
  g.scroller.clientHeight = 800;
  g.scroller.scrollHeight = 302 * ROW_H;
  g.api.take('log', isMore).resolve({ commits: H.chain(['p1', 'p0']), hasMore: true, next: { tips: [hs[0]], skip: 302 } });
  await H.flush();
  assert.equal(more(), 0);
  const scrollTo = (remaining) => {
    g.scroller.scrollTop = g.scroller.scrollHeight - g.scroller.clientHeight - remaining;
    g.dom.dispatch(g.scroller, 'scroll');
  };
  scrollTo(PAGE_AHEAD_PX);
  await H.flush(1);
  assert.equal(more(), 0, 'exactly PAGE_AHEAD_PX left: not yet');
  scrollTo(PAGE_AHEAD_PX - 1);
  await H.flush(1);
  assert.equal(more(), 1, 'closer: one loadMore');
  // More than a screen of look-ahead, and less than the page it asks for (store.js PAGE_MORE).
  assert.ok(PAGE_AHEAD_PX > g.scroller.clientHeight);
  assert.ok(PAGE_AHEAD_PX < g.win.Store.PAGE_MORE * ROW_H);
  assert.ok(g.win.Store.PAGE_FIRST <= g.win.Store.LOG_MAX);
});
