'use strict';
// Context / dropdown menus (plain script; exposes Components.menu). Labels only via textContent.
//   Components.menu.open(anchor, items, opts?)
//     anchor: {x, y} (client coordinates, e.g. a contextmenu event) or an Element (the menu opens
//             below it, left-aligned, flipped/clamped to stay inside the window)
//     items:  [{label, action: () => void, danger?, disabled?, title?, checked?, pinned?} | {separator: true}]
//     opts.search: {label, placeholder?, empty?} adds a search field above the items (search mode)
//     opts.onClose(): called once when the menu goes away (before a chosen item's action runs)
//   Components.menu.filter(items, query) -> {shown, matched}: pure, what search mode shows
//   Components.menu.close(), Components.menu.isOpen()
//   Components.menu.swallowNextClick(el): drop the next click on el (a press on a popup's own anchor
//   closed it; the click that follows must not reopen it). Also used by the repository picker.
// A disabled item's `title` (its reason) is also shown under its label (.pl-menu-hint, aria-hidden;
// the row's aria-description carries it), so it reads without hovering.
// One menu at a time (opening another closes the first). Keyboard: ArrowUp/ArrowDown (wrapping,
// skipping disabled items and separators), Home/End, Enter/Space runs the item, Esc / Tab close.
// It also closes on an outside mousedown, window blur, scroll (outside the menu) and resize.
// Focus returns to where it was when the menu closes without running an item; the item's action
// runs after the menu is gone (so an action may open a dialog or another menu).
// Search mode (a dialog: a combobox over a listbox, driven by aria-activedescendant): the field takes
// focus and keeps it (a press anywhere else in the popup doesn't move it); typing filters the items
// (a case-insensitive substring of the label; pinned items and the separators between shown items
// always show) and highlights the first enabled match, a pinned one only when nothing else matches;
// ↑ / ↓ / Home / End move the highlight (Shift+Home / Shift+End select in the field), Enter runs it
// (not a held one, not while an IME composes), Esc clears the query (an empty one closes the menu),
// Tab closes. With a query that matches nothing, opts.search.empty ("No matches") shows above the
// items (a status next to the field). Each open starts with an empty query.
(function () {
  const { el } = window.Components;
  let current = null; // {root, close}
  let seq = 0; // search mode: unique option ids (aria-activedescendant)

  /** Index of the next enabled item from `from` in direction `dir` (wrapping), or -1. Pure. */
  function nextIndex(items, from, dir) {
    const n = items.length;
    if (!n) return -1;
    let i = from;
    for (let step = 0; step < n; step++) {
      i = ((i + dir) % n + n) % n;
      const it = items[i];
      if (it && !it.separator && !it.disabled) return i;
    }
    return -1;
  }

  /**
   * What search mode shows for `query`: {shown: indices into items, matched: indices of the items
   * whose label contains the query, pinned ones included}. A case-insensitive substring of the
   * (trimmed) query; pinned items always show; a separator shows only between two shown items.
   * An empty query shows every item and matches none. Pure.
   */
  function filter(items, query) {
    const list = Array.isArray(items) ? items : [];
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { shown: list.map((_, i) => i), matched: [] };
    const hit = (it) => !!it && !it.separator && String(it.label == null ? '' : it.label).toLowerCase().includes(q);
    const matched = [];
    list.forEach((it, i) => { if (hit(it)) matched.push(i); });
    const keep = list.map((it) => hit(it) || (!!it && !it.separator && !!it.pinned));
    const shown = [];
    list.forEach((it, i) => {
      if (keep[i]) shown.push(i);
      else if (it && it.separator && shown.length && !list[shown[shown.length - 1]].separator && keep.slice(i + 1).some(Boolean)) shown.push(i);
    });
    return { shown, matched };
  }

  /** Top-left position for a menu of size w x h at the anchor point, kept inside vw x vh. Pure. */
  function place({ x, y, below = null }, w, h, vw, vh, margin = 4) {
    let left = x;
    let top = y;
    if (left + w > vw - margin) left = Math.max(margin, vw - margin - w);
    if (top + h > vh - margin) {
      // Below an element: flip above it when there is more room there.
      top = below && below.top - h >= margin ? below.top - h : Math.max(margin, vh - margin - h);
    }
    return { left: Math.max(margin, left), top: Math.max(margin, top) };
  }

  /** Stop the next click on `target` (within ~1 s) from reaching the page. */
  function swallowNextClick(target) {
    const onClick = (e) => {
      done();
      if (target.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
    };
    const done = () => { clearTimeout(timer); document.removeEventListener('click', onClick, true); };
    const timer = setTimeout(done, 1000);
    document.addEventListener('click', onClick, true);
  }

  function close() {
    if (current) current.close(null);
  }

  /** Search mode's field: a combobox over the listbox `listId`. */
  function searchField(search, listId) {
    const box = el('label', 'pl-menu-search');
    const input = el('input', 'pl-menu-search-input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = String(search.placeholder || search.label || 'Search');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-label', String(search.label || search.placeholder || 'Search'));
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', listId);
    if (window.PLIcons) box.append(window.PLIcons.icon('search', 14, 'pl-menu-search-icon'));
    box.append(input);
    return { box, input };
  }

  function open(anchor, items, opts = {}) {
    close();
    const list = (Array.isArray(items) ? items : []).filter(Boolean);
    const previous = document.activeElement;
    const search = opts && opts.search ? opts.search : null;
    const id = search ? `pl-menu-${++seq}` : '';
    const root = el('div', search ? 'pl-menu pl-menu-searchable' : 'pl-menu');
    // Search mode: the field, then the items in a listbox of options (the field keeps focus, so
    // neither the popup nor its rows are focusable there).
    const field = search ? searchField(search, `${id}-list`) : null;
    const box = search ? el('div', 'pl-menu-list') : root;
    if (search) {
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', field.input.getAttribute('aria-label'));
      box.id = `${id}-list`;
      box.setAttribute('role', 'listbox');
      box.setAttribute('aria-label', field.input.getAttribute('aria-label'));
    } else {
      root.tabIndex = -1;
      root.setAttribute('role', 'menu');
    }
    const hasCheck = list.some((x) => x.checked !== undefined);
    const rows = list.map((it, i) => {
      if (it.separator) {
        const s = el('div', 'pl-menu-sep');
        s.setAttribute('role', search ? 'presentation' : 'separator'); // a listbox holds options only
        return s;
      }
      const row = el('div', `pl-menu-item${it.danger ? ' pl-menu-danger' : ''}`);
      if (search) {
        row.id = `${id}-${i}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
      } else {
        row.setAttribute('role', hasCheck && it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem');
      }
      if (it.checked !== undefined) row.setAttribute('aria-checked', it.checked ? 'true' : 'false');
      if (!search) row.tabIndex = -1;
      if (it.disabled) row.setAttribute('aria-disabled', 'true');
      if (it.title) row.title = it.title;
      if (hasCheck) row.append(el('span', 'pl-menu-check', it.checked ? '✓' : ''));
      row.append(el('span', 'pl-menu-label', it.label == null ? '' : String(it.label)));
      if (it.disabled && it.title) {
        const hint = el('span', `pl-menu-hint${hasCheck ? ' pl-menu-hint-indent' : ''}`, String(it.title));
        hint.setAttribute('aria-hidden', 'true');
        row.setAttribute('aria-description', String(it.title));
        row.classList.add('pl-menu-has-hint');
        row.append(hint);
      }
      row.addEventListener('mousemove', () => { if (!it.disabled && active !== i) focusAt(i); });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!it.disabled) finish(i);
      });
      return row;
    });
    // Search mode's empty state: a status next to the field (not in the listbox), always in the
    // accessibility tree; its text changes (empty while something matches) so it is announced.
    const empty = search ? el('div', 'pl-menu-empty') : null;
    if (search) {
      empty.setAttribute('role', 'status');
      box.append(...rows);
      root.append(field.box, empty, box);
      // A press in the popup (a disabled row, the empty state, padding) keeps focus in the field.
      root.addEventListener('mousedown', (e) => { if (e.target !== field.input) e.preventDefault(); });
    } else {
      root.append(...rows);
    }

    let active = -1;
    /** Highlight row i (-1: none). opts.scroll brings it into view: keyboard and filtering, not hover. */
    function focusAt(i, { scroll = false } = {}) {
      if (active >= 0 && rows[active]) {
        rows[active].classList.remove('pl-menu-active');
        if (search) rows[active].setAttribute('aria-selected', 'false');
      }
      active = i;
      if (search) {
        // The field keeps focus; the highlighted option is its active descendant.
        if (i >= 0 && rows[i]) {
          rows[i].classList.add('pl-menu-active');
          rows[i].setAttribute('aria-selected', 'true');
          field.input.setAttribute('aria-activedescendant', rows[i].id);
          if (scroll && typeof rows[i].scrollIntoView === 'function') rows[i].scrollIntoView({ block: 'nearest' });
        } else {
          field.input.removeAttribute('aria-activedescendant');
        }
      } else if (i >= 0 && rows[i]) {
        rows[i].classList.add('pl-menu-active');
        rows[i].focus(scroll ? undefined : { preventScroll: true });
      } else {
        root.focus();
      }
    }

    // Search mode: the items the query shows (the others are null here, so nextIndex skips them).
    let view = list;
    function applyFilter() {
      const q = field.input.value;
      const { shown, matched } = filter(list, q);
      const on = new Set(shown);
      view = list.map((it, i) => (on.has(i) ? it : null));
      rows.forEach((row, i) => { row.hidden = !on.has(i); });
      empty.textContent = q.trim() && !matched.length ? String(search.empty || 'No matches') : '';
      let first = -1;
      if (!q.trim()) {
        first = nextIndex(view, -1, 1);
      } else {
        // The first enabled match. Pinned items show for every query, so one is highlighted only
        // when it matches and nothing else enabled does (typing "new" picks New branch…); no
        // enabled match: nothing highlighted, Enter does nothing.
        const enabled = matched.filter((i) => !list[i].disabled);
        const unpinned = enabled.find((i) => !list[i].pinned);
        if (unpinned !== undefined) first = unpinned;
        else if (enabled.length) first = enabled[0];
      }
      focusAt(first, { scroll: true });
    }

    let closed = false;
    function finish(runIndex) {
      if (closed) return;
      closed = true;
      if (current && current.root === root) current = null;
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
      document.removeEventListener('scroll', onScroll, true);
      root.remove();
      if (typeof opts.onClose === 'function') {
        try { opts.onClose(); } catch (e) { window.Components.util.log.error(e); }
      }
      const it = runIndex === null ? null : list[runIndex];
      if (!it && previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
      if (it && typeof it.action === 'function') {
        try {
          it.action();
        } catch (e) {
          window.Components.util.log.error(e);
        }
      }
    }

    const move = (k) => focusAt(nextIndex(view, active === -1 && k === 'ArrowUp' ? 0 : active, k === 'ArrowDown' ? 1 : -1), { scroll: true });
    const edge = (k) => focusAt(k === 'Home' ? nextIndex(view, -1, 1) : nextIndex(view, 0, -1), { scroll: true });
    const runActive = () => { if (active >= 0 && !list[active].disabled) finish(active); };
    /** The plain menu's keys; true when handled. */
    function menuKey(e) {
      const k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') move(k);
      else if (k === 'Home' || k === 'End') edge(k);
      else if (k === 'Enter' || k === ' ') runActive();
      else if (k === 'Escape' || k === 'Tab') finish(null);
      else return false;
      return true;
    }
    /** Search mode's keys (the field has focus); true when handled. The rest (Space too) edit the query. */
    function searchKey(e) {
      const k = e.key;
      if (e.isComposing) return false; // an IME's Enter commits the composition, not the highlighted item
      if (k === 'ArrowDown' || k === 'ArrowUp') move(k);
      else if ((k === 'Home' || k === 'End') && !e.shiftKey) edge(k); // Shift+Home / Shift+End select in the field
      else if (k === 'Enter') { if (!e.repeat) runActive(); } // a held Enter (from before the menu) doesn't run
      else if (k === 'Escape' && field.input.value) { field.input.value = ''; applyFilter(); }
      else if (k === 'Escape' || k === 'Tab') finish(null);
      else return false;
      return true;
    }
    function onKey(e) {
      if (search ? searchKey(e) : menuKey(e)) e.preventDefault();
      e.stopPropagation(); // unhandled keys (j/k, shortcuts) don't reach the page while the menu is up either
    }
    const inside = (t) => t && (t === root || (typeof root.contains === 'function' && root.contains(t)));
    const anchorEl = anchor && typeof anchor.getBoundingClientRect === 'function' ? anchor : null;
    const onDown = (e) => {
      if (inside(e.target)) return;
      // A press on the anchor (e.g. the dropdown's own button) closes the menu and swallows the
      // click that follows, so the button toggles the menu instead of reopening it.
      if (anchorEl && typeof anchorEl.contains === 'function' && anchorEl.contains(e.target)) swallowNextClick(anchorEl);
      finish(null);
    };
    const onBlur = () => finish(null);
    const onScroll = (e) => { if (!inside(e.target)) finish(null); };

    document.body.append(root);
    // Position: measure after insertion, then clamp into the window.
    const r = anchorEl ? anchorEl.getBoundingClientRect() : null;
    const pt = r
      ? { x: r.left, y: r.bottom + 2, below: { top: r.top } }
      : { x: Number(anchor && anchor.x) || 0, y: Number(anchor && anchor.y) || 0 };
    const size = typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : { width: 0, height: 0 };
    const vw = (typeof window.innerWidth === 'number' && window.innerWidth) || 1e6;
    const vh = (typeof window.innerHeight === 'number' && window.innerHeight) || 1e6;
    const pos = place(pt, size.width || 0, size.height || 0, vw, vh);
    root.style.left = `${pos.left}px`;
    root.style.top = `${pos.top}px`;
    // Search mode keeps its opening width while the query narrows the items.
    if (search && size.width) root.style.width = `${size.width}px`;

    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    document.addEventListener('scroll', onScroll, true);
    current = { root, close: finish };
    if (search) {
      field.input.addEventListener('input', applyFilter);
      field.input.focus();
      applyFilter();
    } else {
      focusAt(nextIndex(list, -1, 1), { scroll: true });
    }
    return root;
  }

  window.Components.menu = { open, close, isOpen: () => !!current, place, filter, swallowNextClick };
})();
