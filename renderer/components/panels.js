'use strict';
// Resizable side panels of the repository view (plain script: window.PLPanels, and module.exports
// under node for the tests). The pure part is the panel table, the width preference (one per app,
// not per repo, in localStorage through Components.util.storage), the fit to the available width
// and resizing. The 'panels' component (mounted on .repo-main) adds a separator on the inner edge
// of each side panel and applies the widths as --sidebar-w / --details-w on .repo-main, so they
// override the responsive defaults of :root (style.css) for the panels below it.
//
// The center (graph / diff / rebase editor) is the flexible part: it takes what the panels leave
// and keeps CENTER_MIN. `null` in the preference means the default: the CSS width for the current
// window size (the :root variable, which the narrow-window media queries shrink).
(function () {
  const KEY = 'pl.panels';
  const CENTER_MIN = 360;

  /**
   * The resizable panels, left to right. edge: where the separator sits (the inner edge, next to
   * the center). def: the fallback default (px) when the CSS variable can't be read.
   */
  const PANELS = Object.freeze([
    Object.freeze({ id: 'sidebar', label: 'sidebar', cssVar: '--sidebar-w', def: 260, min: 160, max: 520, edge: 'right' }),
    Object.freeze({ id: 'details', label: 'details panel', cssVar: '--details-w', def: 380, min: 260, max: 720, edge: 'left' }),
  ]);
  const byId = new Map(PANELS.map((p) => [p.id, p]));
  const panel = (id) => byId.get(id) || null;

  const clampTo = (p, w) => Math.round(Math.min(p.max, Math.max(p.min, w)));

  /** A preference value {sidebar, details} from anything (stored JSON): each a clamped px width or null. */
  function sanitize(v) {
    const out = {};
    for (const p of PANELS) {
      const w = v && typeof v === 'object' ? v[p.id] : null;
      out[p.id] = typeof w === 'number' && Number.isFinite(w) ? clampTo(p, w) : null;
    }
    return out;
  }

  const isDefault = (widths) => PANELS.every((p) => widths[p.id] === null);

  /**
   * The widths shown for preference `widths` in `avail` px (.repo-main's width; 0 or less: unknown,
   * nothing is shrunk). defaults: {sidebar, details} px for a null preference (the CSS widths).
   * When the panels leave the center less than CENTER_MIN, each gives up the same share of its room
   * above its min (never going below it); if even the mins don't fit, the center is what gets clipped.
   * -> {want, w, avail, compressed}
   */
  function layout(widths, { avail = 0, defaults = {} } = {}) {
    const want = {};
    for (const p of PANELS) {
      const v = widths && widths[p.id];
      const d = defaults[p.id];
      if (typeof v === 'number') want[p.id] = v;
      else want[p.id] = typeof d === 'number' && Number.isFinite(d) && d > 0 ? Math.round(d) : p.def;
    }
    const w = { ...want };
    let compressed = false;
    if (avail > 0) {
      const deficit = PANELS.reduce((s, p) => s + want[p.id], 0) + CENTER_MIN - avail;
      const slack = PANELS.reduce((s, p) => s + Math.max(0, want[p.id] - p.min), 0);
      if (deficit > 0 && slack > 0) {
        const f = Math.min(1, deficit / slack);
        for (const p of PANELS) w[p.id] = Math.max(Math.min(p.min, want[p.id]), Math.floor(want[p.id] - Math.max(0, want[p.id] - p.min) * f));
        compressed = true;
      }
    }
    return { want, w, avail: avail > 0 ? avail : 0, compressed };
  }

  /** The largest width panel `id` can take in layout `lay` without pushing the center below CENTER_MIN. */
  function maxFor(id, lay) {
    const p = panel(id);
    if (!p) return 0;
    if (!lay || !lay.avail) return p.max;
    const others = PANELS.reduce((s, o) => (o.id === id ? s : s + lay.w[o.id]), 0);
    return Math.max(p.min, Math.min(p.max, lay.avail - CENTER_MIN - others));
  }

  /**
   * The preference after setting panel `id` to `target` px in layout `lay` (clamped to its min and
   * maxFor). What is shown is what is kept: a panel the fit shrank keeps its shown width, so the
   * next fit doesn't take the new width back from it.
   */
  function resizeTo(widths, id, target, lay) {
    const p = panel(id);
    if (!p || typeof target !== 'number' || !Number.isFinite(target)) return widths;
    const next = { ...widths, [id]: Math.round(Math.min(maxFor(id, lay), Math.max(p.min, target))) };
    if (lay && lay.compressed) {
      for (const o of PANELS) if (o.id !== id && lay.w[o.id] !== lay.want[o.id]) next[o.id] = lay.w[o.id];
    }
    return next;
  }

  /**
   * The app's panel-width preference: get() -> {sidebar, details}, set(widths) (saved and announced
   * when it changed; returns whether it did), reset() (all defaults), subscribe(fn) -> unsubscribe.
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
      if (PANELS.every((p) => next[p.id] === prev[p.id])) return false;
      cur = next;
      if (storage) {
        const saved = {};
        for (const p of PANELS) if (next[p.id] !== null) saved[p.id] = next[p.id];
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
  const prefs = createPrefs(C && C.util ? C.util.storage : null);
  const api = { KEY, CENTER_MIN, PANELS, panel, sanitize, isDefault, layout, maxFor, resizeTo, createPrefs, prefs };
  if (typeof window !== 'undefined') window.PLPanels = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (!C || typeof C.register !== 'function' || typeof document === 'undefined') return;

  const KEY_STEP = 10;
  const KEY_STEP_BIG = 50;

  // Separators (role="separator") on the inner edge of each panel. Dragging one (pointer capture,
  // so the pointer can't be lost to the graph or leave the window mid-drag) resizes a draft of the
  // widths, applied live and saved on release; while dragging, the body gets .pn-resizing (col-resize
  // cursor everywhere, no text selection). dir is +1 for the sidebar (right edge), -1 for the details
  // panel (left edge), so the separator follows the pointer. Double-click (or Enter) resets the panel
  // to its default width; Left / Right move it by KEY_STEP (Shift: KEY_STEP_BIG), Home / End give it
  // its min / max.
  C.register('panels', {
    mount(root) {
      const { el } = C;
      let lay = null;
      let drag = null; // {id, handle, pointerId, x, w0, dir, widths} while a separator is dragged
      const current = () => (drag ? drag.widths : prefs.get());
      const dirOf = (id) => (panel(id).edge === 'right' ? 1 : -1);

      const handles = new Map();
      for (const p of PANELS) {
        const node = root.querySelector(`.${p.id}`);
        if (!node) continue;
        const r = el('div', `pn-resize pn-resize-${p.id}`);
        r.tabIndex = 0;
        r.dataset.panel = p.id;
        r.setAttribute('role', 'separator');
        r.setAttribute('aria-orientation', 'vertical');
        r.setAttribute('aria-label', `Resize the ${p.label}`);
        r.title = 'Drag to resize, double-click to reset';
        root.insertBefore(r, p.edge === 'right' ? node.nextSibling : node);
        handles.set(p.id, r);
      }

      /** The CSS default widths for the current window size (the :root variables). */
      function defaults() {
        const out = {};
        let cs = null;
        try { cs = getComputedStyle(document.documentElement); } catch { /* no layout */ }
        for (const p of PANELS) {
          const v = cs ? parseFloat(cs.getPropertyValue(p.cssVar)) : NaN;
          out[p.id] = Number.isFinite(v) ? v : p.def;
        }
        return out;
      }

      function apply() {
        lay = layout(current(), { avail: root.clientWidth || 0, defaults: defaults() });
        for (const p of PANELS) {
          root.style.setProperty(p.cssVar, `${lay.w[p.id]}px`);
          const r = handles.get(p.id);
          if (!r) continue;
          r.setAttribute('aria-valuenow', String(lay.w[p.id]));
          r.setAttribute('aria-valuemin', String(p.min));
          r.setAttribute('aria-valuemax', String(maxFor(p.id, lay)));
        }
      }
      const unsub = prefs.subscribe(() => apply());
      const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => apply()) : null;
      if (ro) ro.observe(root);
      apply();

      const handleOf = (e) => (e.target && e.target.closest ? e.target.closest('.pn-resize') : null);
      const resize = (id, target) => prefs.set(resizeTo(prefs.get(), id, target, lay));
      const reset = (id) => prefs.set({ ...prefs.get(), [id]: null });

      function onPointerDown(e) {
        const r = handleOf(e);
        if (!r || e.button !== 0 || !lay) return;
        e.preventDefault(); // no text selection, no native drag
        const id = r.dataset.panel;
        drag = { id, handle: r, pointerId: e.pointerId, x: e.clientX, w0: lay.w[id], dir: dirOf(id), widths: prefs.get() };
        try { r.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
        r.classList.add('is-active');
        document.body.classList.add('pn-resizing');
      }
      function onPointerMove(e) {
        if (!drag || e.pointerId !== drag.pointerId) return;
        drag.widths = resizeTo(drag.widths, drag.id, drag.w0 + drag.dir * (e.clientX - drag.x), lay);
        apply();
      }
      function endDrag(e, save = true) {
        if (!drag || (e && e.pointerId !== drag.pointerId)) return;
        const d = drag;
        drag = null;
        d.handle.classList.remove('is-active');
        document.body.classList.remove('pn-resizing');
        try { d.handle.releasePointerCapture(d.pointerId); } catch { /* already released */ }
        if (!save || !prefs.set(d.widths)) apply(); // unchanged: show the saved widths again
      }
      function onKey(e) {
        const r = handleOf(e);
        if (!r || !lay || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
        const id = r.dataset.panel;
        const step = (e.shiftKey ? KEY_STEP_BIG : KEY_STEP) * dirOf(id);
        const w = lay.w[id];
        const targets = { ArrowRight: w + step, ArrowLeft: w - step, Home: panel(id).min, End: maxFor(id, lay) };
        if (e.key === 'Enter') {
          e.preventDefault();
          reset(id);
        } else if (Object.hasOwn(targets, e.key)) {
          e.preventDefault();
          resize(id, targets[e.key]);
        }
      }
      function onDblClick(e) {
        const r = handleOf(e);
        if (r) reset(r.dataset.panel);
      }
      const listeners = [
        ['pointerdown', onPointerDown], ['pointermove', onPointerMove], ['pointerup', endDrag],
        ['pointercancel', endDrag], ['lostpointercapture', endDrag], ['keydown', onKey], ['dblclick', onDblClick],
      ];
      for (const [type, fn] of listeners) root.addEventListener(type, fn);

      return () => {
        endDrag(null, false);
        for (const [type, fn] of listeners) root.removeEventListener(type, fn);
        if (ro) ro.disconnect();
        unsub();
        for (const r of handles.values()) r.remove();
        for (const p of PANELS) root.style.removeProperty(p.cssVar);
      };
    },
  });
})();
