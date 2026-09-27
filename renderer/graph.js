/*
 * Pasta Lite - commit graph lane layout.
 *
 * Pure, dependency-free. Works in Node (`require('../renderer/graph.js')`)
 * and in the browser as a plain <script> (exposes `window.Graph`).
 *
 * layout(commits, { pinned }) -> { width, rows }
 *   commits: [{ hash, parents: [sha...] }] in `git rev-list --date-order`
 *            order (children before parents). Parents may be absent from the
 *            list (paging cut-off); their lanes run to the bottom of the last row.
 *   rows[i]: { hash, column, colorIndex, isMerge,
 *              lines: [{ from: [col, 'top'|'mid'], to: [col, 'mid'|'bottom'], colorIndex }] }
 *
 * createLayout({ pinned }) -> resumable layout for paging:
 *   .add(commits) lays out the next commits after the ones added before (the lane state is kept),
 *   so add(a); add(b) gives the same rows as layout(a.concat(b)). Returns { width, rows } over
 *   everything added so far (a new rows array each call).
 *   .canResume is false when `pinned` was given but was not in the commits added so far: a full
 *   layout would have held column 0 from the first row, so the caller must lay out from scratch.
 *   .count is the number of commits added.
 *
 * Lane algorithm (greedy, single pass, lanes never shift sideways):
 *   - A commit takes the lowest column reserved for it by a child; other lanes
 *     awaiting it converge into it at this row (top(c) -> mid(node)) and are freed.
 *     Without a reservation it takes the lowest free column.
 *   - Its first parent is reserved in the commit's own column. If that parent is
 *     already awaited by another lane, both lanes continue and converge at the
 *     parent's row (the lower column wins, the other is freed there).
 *   - Merge parents join the parent's existing (lowest) lane, else get the
 *     lowest free column.
 *
 * Colours: colorIndex = column % COLOR_COUNT. Since lanes never move, a lane keeps its
 * colour for its whole length. A curve between two columns takes the colour of
 * the lane that is not the node's column (the branch being merged / forked).
 *
 * pinned: the first-parent chain of `pinned` is kept in column 0. Column 0 is
 * blocked (not drawn) until the pinned commit is reached; from then on its
 * first-parent chain occupies column 0.
 */
((exports) => {
  'use strict';

  const COLORS = 10;
  const BLOCKED = {}; // sentinel: column held for the pinned chain, not drawn

  const colorOf = (col) => col % COLORS;
  const isFree = (s) => s === null || s === undefined;

  function createLayout(opts = {}) {
    const pinned = opts.pinned || null;
    const rows = [];
    let width = 0;
    // lanes[c] = awaited sha | null (free) | BLOCKED
    const lanes = [];
    // sha -> array of columns awaiting it (ascending not guaranteed)
    const awaiting = new Map();

    // Pinned first-parent chain (only shas present in the list matter). It is extended as pages
    // arrive: `chainTail` is the next chain sha whose commit hasn't been added yet.
    const byHash = pinned ? new Map() : null;
    let chain = null;
    let chainTail = null;

    let late = false; // pinned first seen after rows were laid out: this layout differs from a full one

    function extendChain() {
      if (!chain) {
        if (!byHash.has(pinned)) return;
        chain = new Set([pinned]);
        chainTail = pinned;
        if (rows.length === 0) lanes[0] = BLOCKED;
        else late = true;
      }
      while (chainTail && byHash.has(chainTail)) {
        const cm = byHash.get(chainTail);
        const next = cm.parents && cm.parents.length ? cm.parents[0] : null;
        if (!next || chain.has(next)) {
          chainTail = null;
          break;
        }
        chain.add(next);
        chainTail = next;
      }
    }

    function lowestFree() {
      for (let c = 0; c < lanes.length; c++) if (isFree(lanes[c])) return c;
      lanes.push(null);
      return lanes.length - 1;
    }

    function reserve(col, sha) {
      lanes[col] = sha;
      const list = awaiting.get(sha);
      if (list) list.push(col);
      else awaiting.set(sha, [col]);
    }

    const lowest = (cols) => cols.reduce((m, c) => (c < m ? c : m), cols[0]);

    function place(commit) {
      const hash = commit.hash;
      const rawParents = commit.parents || [];
      const parents = rawParents.length > 1 ? [...new Set(rawParents)] : rawParents; // de-duplicate (defensive)

      const lines = [];
      let maxCol = 0;
      const ends = awaiting.get(hash);
      awaiting.delete(hash);
      let col;
      if (chain !== null && chain.has(hash)) col = 0;
      else if (ends) col = lowest(ends);
      else col = lowestFree();
      if (hash === pinned && lanes[0] === BLOCKED) lanes[0] = null;

      // Pass-through lanes (everything reserved that isn't waiting for us).
      for (let c = 0; c < lanes.length; c++) {
        const s = lanes[c];
        if (isFree(s) || s === BLOCKED || s === hash) continue;
        lines.push({ from: [c, 'top'], to: [c, 'bottom'], colorIndex: colorOf(c) });
        if (c > maxCol) maxCol = c;
      }

      // Lanes ending here (from children above), converging into the node.
      if (ends) {
        for (const ec of ends) {
          lines.push({ from: [ec, 'top'], to: [col, 'mid'], colorIndex: colorOf(ec) });
          lanes[ec] = null;
          if (ec > maxCol) maxCol = ec;
        }
      }
      if (col > maxCol) maxCol = col;
      while (lanes.length <= col) lanes.push(null);
      lanes[col] = null;

      // Edges toward parents.
      parents.forEach((ph, p) => {
        let target;
        if (p === 0) {
          target = col;
          reserve(col, ph);
        } else {
          const existing = awaiting.get(ph);
          if (existing) target = lowest(existing);
          else {
            target = lowestFree();
            reserve(target, ph);
          }
        }
        lines.push({ from: [col, 'mid'], to: [target, 'bottom'], colorIndex: colorOf(target) });
        if (target > maxCol) maxCol = target;
      });

      if (maxCol + 1 > width) width = maxCol + 1;
      rows.push({ hash, column: col, colorIndex: colorOf(col), isMerge: rawParents.length > 1, lines });
    }

    return {
      add(commits = []) {
        if (byHash) {
          for (const c of commits) byHash.set(c.hash, c);
          extendChain();
        }
        for (const c of commits) place(c);
        return { width, rows: rows.slice() };
      },
      get canResume() { return !pinned || rows.length === 0 || (chain !== null && !late); },
      get count() { return rows.length; },
    };
  }

  const layout = (commits, opts) => createLayout(opts || {}).add(commits || []);

  exports.layout = layout;
  exports.createLayout = createLayout;
  exports.COLOR_COUNT = COLORS;
})(typeof module !== 'undefined' ? module.exports : (window.Graph = {})); // NOSONAR(S1121): the CommonJS-or-window export idiom
