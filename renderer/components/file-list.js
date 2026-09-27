'use strict';
// Keyed, in-place-updated file list of the details panel (plain script; exposes window.PLFileList).
// Path or tree mode; lists over VIRTUAL_MIN rows render only the rows in view. Row buttons live
// inside the keyed row nodes and are handled by delegation, so recycling keeps working.
// All names and paths go through util.displayName and textContent.
(function () {
  const { el, util } = window.Components;
  const { displayName: dn, pathTree, modKey } = util;
  const ROW_H = 26; // .dt-file / .dt-folder height (details.css)
  const VIRTUAL_MIN = 500; // lists with more rows are virtualized
  const OVERSCAN = 12;
  const PAD = 3; // .dt-files vertical padding

  // status letter -> [glyph, css modifier, label]
  const GLYPHS = {
    M: ['✎', 'mod', 'Modified'],
    T: ['✎', 'mod', 'Type changed'],
    A: ['+', 'add', 'Added'],
    D: ['−', 'del', 'Deleted'],
    R: ['→', 'ren', 'Renamed'],
    C: ['→', 'ren', 'Copied'],
    '?': ['+', 'untracked', 'Untracked'],
    U: ['!', 'conflict', 'Conflicted'],
  };
  const glyphFor = (s) => GLYPHS[s] || ['•', 'mod', s || 'Changed'];

  function splitPath(p) {
    const i = p.lastIndexOf('/');
    return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
  }

  /** Code-unit order of two strings (not the locale's). */
  const compare = (x, y) => {
    if (x < y) return -1;
    return x > y ? 1 : 0;
  };
  const byPath = (a, b) => compare(a.path, b.path);
  const byName = (a, b) => compare(a.name, b.name);

  /** Cheap content signature of a file list (skip all work when a refresh changed nothing). */
  const listSig = (entries) => entries.map((e) => `${e.status}\u0000${e.orig || ''}\u0000${e.path}`).join('\u0001');

  function glyph(status) {
    const [g, mod, label] = glyphFor(status);
    const s = el('span', `dt-glyph dt-glyph-${mod}`, g);
    s.title = label;
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  /** The row's small trash-can icon (PLIcons, renderer/icons.js; stroked by details.css .dt-icon). */
  const trashIcon = () => util.load('PLIcons', './icons.js').icon('trash', 13, 'dt-icon');

  /**
   * A keyed, in-place-updated file list (path or tree mode) living inside `scroller`.
   * opts: {key, label, scroller, onOpen(entry), collapsed:Set, isActive(entry)}, and for WIP lists:
   *   isSelected(entry)                    multi-selection membership (drawn as .is-selected)
   *   onGesture(kind, entry, files, from)  kind 'single' | 'toggle' | 'range'; files = visible file
   *                                        order; from = the entry a Shift+arrow moved from
   *   actionsFor(entry) -> [{act, label?, icon?, title, cls?}]   hover buttons in the row's .dt-actions
   *   actionsKey(entry) -> string          what actionsFor depends on besides the entry (a row is
   *                                        rebuilt when it changes, e.g. the "Keep main's version" names)
   *   onAction(act, entry, {keyboard})     a row button (or a key mapped by onKey) was used
   *   onKey(event, entry, files) -> bool   extra row keys (s / u / Delete ...); true = handled
   * Returns {el, update(entries, view), refreshActive(), paint(), redecorate(), focusedIndex(), focusAt(i)}.
   */
  function create({
    key: listKey, label, scroller, onOpen, collapsed, isActive,
    isSelected = () => false, onGesture = null, actionsFor = null, actionsKey = null, onAction = null, onKey = null,
  }) {
    const list = el('div', 'dt-files');
    list.dataset.list = listKey;
    list.setAttribute('aria-label', label);
    if (onGesture) list.setAttribute('aria-multiselectable', 'true');
    let rows = []; // [{key, file?:entry, dir?:node, depth, tree}]
    let index = new Map(); // key -> row index
    const nodes = new Map(); // key -> {node, sig}
    let sig = null;
    let mode = null;
    let virtual = false;
    let tabKey = null; // roving tabindex: the one row that is in the tab order
    let lastEntries = [];

    function build(entries, view) {
      const out = [];
      const sorted = [...entries].sort(byPath);
      if (view === 'path') {
        for (const e of sorted) out.push({ key: `f:${e.path}`, file: e, depth: 0, tree: false });
      } else {
        const walk = (node, depth) => {
          for (const d of [...node.dirs.values()].sort(byName)) {
            const ck = `${listKey}:${d.path}`;
            out.push({ key: `d:${d.path}`, dir: d, depth, collapsed: collapsed.has(ck), ck });
            if (!collapsed.has(ck)) walk(d, depth + 1);
          }
          for (const f of [...node.files].sort(byPath)) out.push({ key: `f:${f.path}`, file: f, depth, tree: true });
        };
        walk(pathTree(sorted, (x) => x.path, { compress: true }), 0);
      }
      return out;
    }

    const rowSig = (r) => {
      if (!r.file) return `d|${r.dir.name}|${r.depth}|${r.collapsed}`;
      const actions = actionsKey ? actionsKey(r.file) : '';
      return `f|${r.file.status}|${r.file.orig || ''}|${r.depth}|${r.tree}|${actions}`;
    };

    function fileNode(r) {
      const entry = r.file;
      const row = el('div', 'dt-file');
      row.dataset.path = entry.path;
      row.dataset.status = entry.status;
      if (r.tree) row.style.paddingLeft = `${10 + r.depth * 14 + 14}px`;
      const lab = el('span', 'dt-file-label');
      const [dir, name] = splitPath(entry.path);
      if (dir && !r.tree) lab.append(el('span', 'dt-file-dir', dn(dir)));
      lab.append(el('span', 'dt-file-name', dn(name)));
      const renamed = entry.orig && entry.orig !== entry.path;
      if (renamed) lab.append(el('span', 'dt-file-orig', `← ${dn(r.tree ? splitPath(entry.orig)[1] : entry.orig)}`));
      row.title = renamed ? `${dn(entry.orig)} → ${dn(entry.path)}` : dn(entry.path);
      // Hover actions (Stage / Discard / Unstage / Mark resolved). Out of the tab order: the row
      // itself is the tab stop, and s / u / Delete do the same from the keyboard.
      const actions = el('span', 'dt-actions dt-file-actions');
      for (const a of (actionsFor ? actionsFor(entry) : [])) {
        const b = el('button', `dt-row-btn${a.cls ? ` ${a.cls}` : ''}`, a.icon ? null : a.label);
        b.type = 'button';
        b.tabIndex = -1;
        b.dataset.act = a.act;
        b.title = a.title;
        b.setAttribute('aria-label', a.title);
        if (a.icon === 'trash') b.append(trashIcon());
        actions.append(b);
      }
      row.append(glyph(entry.status), lab, actions);
      return row;
    }

    function folderNode(r) {
      const row = el('div', `dt-folder${r.collapsed ? ' is-collapsed' : ''}`);
      row.setAttribute('aria-expanded', String(!r.collapsed));
      row.dataset.folder = r.dir.path;
      row.style.paddingLeft = `${10 + r.depth * 14}px`;
      row.title = dn(r.dir.path);
      row.append(el('span', 'dt-chevron'), el('span', 'dt-folder-icon'), el('span', 'dt-folder-name', dn(r.dir.name)));
      return row;
    }

    function nodeFor(r) {
      const s = rowSig(r);
      const have = nodes.get(r.key);
      if (have && have.sig === s) return have.node;
      const node = r.file ? fileNode(r) : folderNode(r);
      node.dataset.key = r.key;
      node.setAttribute('role', mode === 'tree' ? 'treeitem' : 'option');
      if (mode === 'tree') node.setAttribute('aria-level', String(r.depth + 1));
      const wasFocused = have && have.node === document.activeElement;
      if (have) have.node.replaceWith(node);
      nodes.set(r.key, { node, sig: s });
      if (wasFocused) node.focus({ preventScroll: true });
      return node;
    }

    function decorate(node, r, i) {
      const on = !!r.file && isActive(r.file);
      const picked = !!r.file && isSelected(r.file);
      if (node.classList.contains('is-active') !== on) node.classList.toggle('is-active', on);
      if (node.classList.contains('is-selected') !== picked) node.classList.toggle('is-selected', picked);
      if (r.file) {
        const aria = String(on || picked);
        if (node.getAttribute('aria-selected') !== aria) node.setAttribute('aria-selected', aria);
      }
      const ti = r.key === tabKey ? 0 : -1;
      if (node.tabIndex !== ti) node.tabIndex = ti;
      if (virtual) {
        const top = `${PAD + i * ROW_H}px`;
        if (node.style.top !== top) node.style.top = top;
      }
    }

    /** Re-decorate every mounted row in place (selection / active / tab stop changed). */
    function redecorateMounted() {
      for (const r of rows) {
        const v = nodes.get(r.key);
        if (v) decorate(v.node, r, index.get(r.key));
      }
    }

    /** Remove the nodes whose keys are not in `keep`. */
    function sweep(keep) {
      for (const [k, v] of nodes) {
        if (!keep.has(k)) {
          v.node.remove();
          nodes.delete(k);
        }
      }
    }

    function pickTabKey() {
      if (tabKey && index.has(tabKey)) return;
      const act = rows.find((r) => r.file && isActive(r.file));
      if (act) tabKey = act.key;
      else tabKey = rows.length ? rows[0].key : null;
    }

    /** Visible row range of this list inside the scroller (virtual mode). */
    function range() {
      const sr = scroller.getBoundingClientRect();
      const lr = list.getBoundingClientRect();
      const offset = lr.top - sr.top; // list top relative to the scroller viewport
      const h = scroller.clientHeight || 800;
      const a = Math.max(0, Math.floor(-offset / ROW_H) - OVERSCAN);
      const b = Math.min(rows.length, Math.ceil((h - offset) / ROW_H) + OVERSCAN);
      return [a, Math.max(a, b)];
    }

    /** Put the DOM in line with `rows` (reusing nodes), then drop nodes for rows that are gone. */
    function paint() {
      const keep = new Set();
      if (virtual) {
        const want = new Set();
        const [a, b] = range();
        for (let i = a; i < b; i++) want.add(i);
        // Keep the focused / tab-order row mounted so focus survives scrolling and refreshes.
        const ti = tabKey != null ? index.get(tabKey) : undefined;
        if (ti !== undefined) want.add(ti);
        const act = document.activeElement && list.contains(document.activeElement) ? index.get(document.activeElement.dataset.key) : undefined;
        if (act !== undefined) want.add(act);
        const frag = document.createDocumentFragment();
        for (const i of want) {
          const r = rows[i];
          const node = nodeFor(r);
          keep.add(r.key);
          decorate(node, r, i);
          if (node.parentNode !== list) frag.append(node);
        }
        sweep(keep);
        if (frag.childNodes.length) list.append(frag);
        return;
      }
      // Full mode: walk the wanted order, moving/inserting only what differs.
      let cursor = list.firstChild;
      rows.forEach((r, i) => {
        const node = nodeFor(r);
        keep.add(r.key);
        decorate(node, r, i);
        if (node === cursor) cursor = cursor.nextSibling;
        else list.insertBefore(node, cursor);
      });
      sweep(keep);
    }

    function update(entries, view) {
      const s = `${view}\u0002${listSig(entries)}\u0002${[...collapsed].join('\u0001')}${actionsKey ? `\u0002${entries.map(actionsKey).join('\u0001')}` : ''}`;
      if (s === sig) {
        refreshActive();
        return;
      }
      sig = s;
      if (mode !== view) {
        // Role changes with the mode: rebuild every node.
        for (const v of nodes.values()) v.node.remove();
        nodes.clear();
        mode = view;
        list.setAttribute('role', view === 'tree' ? 'tree' : 'listbox');
      }
      rows = build(entries, view);
      index = new Map(rows.map((r, i) => [r.key, i]));
      const wasVirtual = virtual;
      virtual = rows.length > VIRTUAL_MIN;
      list.classList.toggle('is-virtual', virtual);
      list.style.height = virtual ? `${rows.length * ROW_H + 2 * PAD}px` : '';
      if (wasVirtual !== virtual) {
        for (const v of nodes.values()) {
          v.node.remove();
          v.node.style.top = '';
        }
        nodes.clear();
      }
      pickTabKey();
      paint();
    }

    /** Diff opened/closed: move the highlight (and roving tab stop) without rebuilding. */
    function refreshActive() {
      const act = rows.find((r) => r.file && isActive(r.file));
      if (act && !(document.activeElement && list.contains(document.activeElement))) tabKey = act.key;
      if (virtual) paint();
      else redecorateMounted();
    }

    function focusRow(k) {
      const i = index.get(k);
      if (i === undefined) return;
      tabKey = k;
      if (virtual) {
        const listTop = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        const y = listTop + PAD + i * ROW_H;
        if (y < scroller.scrollTop + 34) scroller.scrollTop = y - 34; // below the sticky section head
        else if (y + ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + ROW_H - scroller.clientHeight;
      }
      paint();
      const v = nodes.get(k);
      if (v) v.node.focus({ preventScroll: virtual });
      redecorateMounted();
    }

    function activate(r) {
      if (r.file) onOpen(r.file);
      else {
        if (collapsed.has(r.ck)) collapsed.delete(r.ck);
        else collapsed.add(r.ck);
        update(lastEntries, mode);
      }
    }

    const rowOf = (target) => {
      const n = target.closest && target.closest('[data-key]');
      if (!n || !list.contains(n)) return null;
      const i = index.get(n.dataset.key);
      return i === undefined ? null : rows[i];
    };
    const files = () => rows.filter((r) => r.file).map((r) => r.file);
    // Shift-click must not extend a text selection across the rows.
    list.addEventListener('mousedown', (e) => { if (e.shiftKey && onGesture) e.preventDefault(); });
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.dt-actions button');
      if (btn) {
        const br = rowOf(btn);
        if (br && br.file && onAction && btn.dataset.act) onAction(btn.dataset.act, br.file, { keyboard: false });
        return;
      }
      const r = rowOf(e.target);
      if (!r) return;
      tabKey = r.key;
      if (r.file && onGesture) {
        if (modKey(e) || e.shiftKey) {
          onGesture(e.shiftKey ? 'range' : 'toggle', r.file, files());
          const n = nodes.get(r.key);
          if (n && document.activeElement !== n.node) n.node.focus({ preventScroll: true });
          return;
        }
        onGesture('single', r.file, null);
      }
      activate(r);
    });
    list.addEventListener('focusin', (e) => {
      const r = rowOf(e.target);
      if (r && tabKey !== r.key) {
        const old = tabKey != null && nodes.get(tabKey);
        tabKey = r.key;
        if (old) old.node.tabIndex = -1;
        e.target.closest('[data-key]').tabIndex = 0;
      }
    });
    list.addEventListener('keydown', (e) => {
      if (e.target.closest('.dt-actions')) return;
      const r = rowOf(e.target);
      if (!r) return;
      if (r.file && onKey && onKey(e, r.file, files())) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = index.get(r.key);
      const move = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[e.key];
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (r.file && onGesture) onGesture('single', r.file, null);
        activate(r);
      } else if (move !== undefined) {
        e.preventDefault();
        const j = Math.max(0, Math.min(rows.length - 1, i + move));
        focusRow(rows[j].key);
        // Shift+arrows extend the multi-selection from its anchor (or from the row left behind).
        if (e.shiftKey && onGesture && rows[j].file) onGesture('range', rows[j].file, files(), r.file);
      } else if (r.dir && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if ((e.key === 'ArrowLeft') !== r.collapsed) {
          e.preventDefault();
          activate(r);
        }
      }
    });

    return {
      el: list,
      update(entries, view) {
        lastEntries = entries;
        update(entries, view);
      },
      refreshActive,
      paint: () => { if (virtual) paint(); },
      /** Index (in rows) of the focused row of this list, or -1. */
      focusedIndex() {
        const a = document.activeElement;
        if (!a || !list.contains(a)) return -1;
        const n = a.closest('[data-key]');
        const i = n ? index.get(n.dataset.key) : undefined;
        return i === undefined ? -1 : i;
      },
      /** Focus the row at `i` (clamped); false when the list is empty. */
      focusAt(i) {
        if (!rows.length || !list.isConnected) return false;
        focusRow(rows[Math.max(0, Math.min(rows.length - 1, i))].key);
        return true;
      },
      redecorate: () => (virtual ? paint() : redecorateMounted()),
    };
  }

  window.PLFileList = { create };
})();
