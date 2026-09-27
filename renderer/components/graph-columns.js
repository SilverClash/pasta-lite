'use strict';
// Column widths of the commit graph (plain script: window.PLColumns, and module.exports
// under node for the tests). No DOM: the column table, the width preference (one per app, not per
// repo, in localStorage through Components.util.storage), the fit to the available width, resizing
// and auto-fit from measured content widths. graph-view.js applies the result as CSS variables on
// its root (--gv-refs-w, --gv-graph-w, --gv-author-w, --gv-date-w, --gv-sha-w), so every row,
// pooled or not, follows one style change.
//
// COMMIT MESSAGE is the flexible column: it takes what the others leave and keeps MSG_MIN. The
// others have a width in px; `null` in the preference means the default (for GRAPH: the automatic
// width, which follows the lanes between AUTO_MIN and AUTO_MAX).
(function () {
  const KEY = 'pl.graph.columns';
  const MSG_MIN = 160;
  const AUTO_MIN = 60; // automatic GRAPH width: laneX(lanes - 1) + LANE_W, clamped to these
  const AUTO_MAX = 300;
  const FIT_SLACK = 2; // px added to a measured width, so sub-pixel text never ellipsizes

  /**
   * The resizable columns, left to right. edge: where the column's drag handle sits. The columns
   * left of COMMIT MESSAGE have it on their right border, the ones right of it on their left border,
   * so the handle always follows the pointer (the message column absorbs the change).
   * hideBelow: the column is dropped when the graph is narrower than this (px; secondary columns).
   */
  const COLUMNS = Object.freeze([
    Object.freeze({ id: 'refs', label: 'Branch / Tag', def: 170, min: 60, max: 480, edge: 'right', hideBelow: 0 }),
    Object.freeze({ id: 'graph', label: 'Graph', def: null, min: 32, max: 600, edge: 'right', hideBelow: 0 }),
    Object.freeze({ id: 'author', label: 'Author', def: 140, min: 50, max: 400, edge: 'left', hideBelow: 900 }),
    Object.freeze({ id: 'date', label: 'Date', def: 118, min: 50, max: 300, edge: 'left', hideBelow: 760 }),
    Object.freeze({ id: 'sha', label: 'SHA', def: 74, min: 50, max: 200, edge: 'left', hideBelow: 640 }),
  ]);
  const byId = new Map(COLUMNS.map((c) => [c.id, c]));
  const column = (id) => byId.get(id) || null;

  const clampTo = (c, w) => Math.round(Math.min(c.max, Math.max(c.min, w)));

  /** A preference value {refs, graph, author, date, sha} from anything (stored JSON): each a clamped px width or null. */
  function sanitize(v) {
    const out = {};
    for (const c of COLUMNS) {
      const w = v && typeof v === 'object' ? v[c.id] : null;
      out[c.id] = typeof w === 'number' && Number.isFinite(w) ? clampTo(c, w) : null;
    }
    return out;
  }

  const isDefault = (widths) => COLUMNS.every((c) => widths[c.id] === null);

  /** The automatic GRAPH width for a lane block `lanesW` px wide. */
  const graphAuto = (lanesW) => Math.max(AUTO_MIN, Math.min(AUTO_MAX, Math.round(lanesW)));

  /**
   * The widths shown for preference `widths` in `avail` px (the scroller's client width; 0 or less:
   * unknown, nothing is hidden or shrunk). graphAuto: the GRAPH width when it has no preference.
   * Columns whose hideBelow exceeds avail are dropped. When the rest leaves the message column less
   * than MSG_MIN, every shown column gives up the same share of its room above its min (never going
   * below it); if even the mins don't fit, the message column is what gets clipped.
   * -> {want, w, hidden, msg (px, null when avail is unknown), compressed}
   */
  function layout(widths, { avail = 0, graphAuto: auto = AUTO_MIN } = {}) {
    const want = {};
    const hidden = {};
    for (const c of COLUMNS) {
      const v = widths && widths[c.id];
      if (typeof v === 'number') want[c.id] = v;
      else want[c.id] = c.id === 'graph' ? auto : c.def;
      hidden[c.id] = avail > 0 && avail < c.hideBelow;
    }
    const shown = COLUMNS.filter((c) => !hidden[c.id]);
    const w = { ...want };
    let compressed = false;
    if (avail > 0) {
      const deficit = MSG_MIN - (avail - shown.reduce((s, c) => s + want[c.id], 0));
      const slack = shown.reduce((s, c) => s + Math.max(0, want[c.id] - c.min), 0);
      if (deficit > 0 && slack > 0) {
        const f = Math.min(1, deficit / slack);
        for (const c of shown) w[c.id] = Math.max(Math.min(c.min, want[c.id]), Math.floor(want[c.id] - Math.max(0, want[c.id] - c.min) * f));
        compressed = true;
      }
    }
    const msg = avail > 0 ? avail - shown.reduce((s, c) => s + w[c.id], 0) : null;
    return { want, w, hidden, msg, compressed };
  }

  /** The largest width column `id` can take in layout `lay` without pushing the message column below MSG_MIN. */
  function maxFor(id, lay) {
    const c = column(id);
    if (!c) return 0;
    const room = lay && lay.msg !== null ? Math.max(0, lay.msg - MSG_MIN) : Infinity;
    return Math.max(c.min, Math.min(c.max, (lay ? lay.w[id] : c.min) + room));
  }

  /**
   * The preference after setting column `id` to `target` px in layout `lay` (clamped to its min and
   * maxFor). What is shown is what is kept: a column the fit shrank keeps its shown width, so the
   * next fit doesn't take the new width back from the others.
   */
  function resizeTo(widths, id, target, lay) {
    const c = column(id);
    if (!c || typeof target !== 'number' || !Number.isFinite(target)) return widths;
    const next = { ...widths, [id]: Math.round(Math.min(maxFor(id, lay), Math.max(c.min, target))) };
    if (lay && lay.compressed) {
      for (const o of COLUMNS) if (o.id !== id && !lay.hidden[o.id] && lay.w[o.id] !== lay.want[o.id]) next[o.id] = lay.w[o.id];
    }
    return next;
  }

  /**
   * Auto-fit width of column `id` for the measured content widths (px, cell padding included), or
   * null for the default: GRAPH always (its automatic width is the fit to the lanes), and any column
   * with nothing measured (no DOM layout, or no row has such content).
   */
  function fitWidth(id, contentWidths) {
    const c = column(id);
    if (!c || id === 'graph') return null;
    const ws = (contentWidths || []).filter((x) => typeof x === 'number' && Number.isFinite(x) && x > 0);
    if (!ws.length) return null;
    return clampTo(c, Math.ceil(Math.max(...ws)) + FIT_SLACK);
  }

  /**
   * The app's width preference: get() -> {refs, graph, author, date, sha}, set(widths) (saved and
   * announced when it changed), reset() (all defaults), subscribe(fn) -> unsubscribe (fn(widths)).
   * Read from storage on first use; storage failures keep the value in memory only.
   */
  function createPrefs(storage) {
    let cur = null;
    const subs = new Set();
    const get = () => {
      if (!cur) cur = sanitize(storage ? storage.get(KEY, null) : null);
      return cur;
    };
    function set(widths) {
      const next = sanitize(widths);
      const prev = get();
      if (COLUMNS.every((c) => next[c.id] === prev[c.id])) return false;
      cur = next;
      if (storage) {
        const saved = {};
        for (const c of COLUMNS) if (next[c.id] !== null) saved[c.id] = next[c.id];
        storage.set(KEY, saved);
      }
      for (const fn of [...subs]) fn(cur);
      return true;
    }
    return {
      get,
      set,
      reset: () => set({}),
      isDefault: () => isDefault(get()),
      subscribe(fn) {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    };
  }

  const C = typeof window !== 'undefined' && window.Components;
  const api = {
    KEY, MSG_MIN, AUTO_MIN, AUTO_MAX, COLUMNS, column, sanitize, isDefault, graphAuto, layout, maxFor, resizeTo, fitWidth, createPrefs,
    /** The app-wide preference (Components.util.storage). */
    prefs: createPrefs(C && C.util ? C.util.storage : null),
  };
  if (typeof window !== 'undefined') window.PLColumns = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
