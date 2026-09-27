'use strict';
// rebase-editor component — the interactive rebase view (docs/plans/rebase.md §5.6). It replaces the
// graph while store.state.rebaseEditor is set (it shows itself while state.centre is 'rebaseEditor';
// graph-view hides itself then, and takes the focus back when the editor closes); the model is
// window.PLRebase (components/rebase-model.js), changed only through store.actions.editRebase so the
// editor's ⌘Z can undo it. Start / Cancel / Reload run window.PLFlows startInteractiveRebase /
// cancelInteractiveRebase / reloadInteractiveRebase through Components.actions.runFlow.
//
// Layout: header ("Interactive Rebase" · "Rebasing 5 commits of feat onto main (9f3c2e1)"), notes (stale
// plan with Reload, warnings, info), a grid of commits newest first (action select, drag handle,
// avatar, subject with "↳ into …" / ✎ / its error, sha, author, date), the onto row, and a footer
// (summary, "5 commits → 3", Reset, Cancel, Start Rebase).
// Rows are --re-row-h high (rebase-editor.css, read once at mount; ROW_H without styles), positioned in a
// spacer; above VIRTUAL_MIN rows only the visible ones (+ OVERSCAN) exist, keyed by sha and updated in
// place (a focused select survives a re-render); their DOM order follows the list, so Tab order does.
// Keyboard (the grid has focus; nothing while a dialog / menu is open):
//   ↑ ↓ j k Home End PgUp PgDn   move the cursor (Shift extends the selection); Space toggles; ⌘A all
//   p r e s f d                  Pick / Reword / Edit / Squash / Fixup / Drop on the selection
//   ⌥↑ ⌥↓                        move the selection one row (an aria-live note says where)
//   Enter                        edit the message (reword / squash group), else focus the row's select
//   ⌘↵ / Ctrl+Enter              Start Rebase (also from a select)   ⌘Z undo   ⌘⇧Z redo   Esc Cancel (asks when changed)
//   The other global shortcuts (Components.actions.KEYS: ⌘B, ⌘⇧S, ⌘⇧U, ⌘⇧M, ⌘⇧↵ …) are claimed and do
//   nothing while the editor has focus (preventDefault: app.js and details.js skip handled keys), except
//   ⌘L Fetch (it changes no branch) and ⌘O (the folder dialog; PASS_KEYS).
// Mouse: click / Shift-click / ⌘-click select, the select sets the action (for the whole selection
// when the row is in it), ✎ edits the message, dragging ⋮⋮ reorders (pointer events, a drop line,
// auto-scroll while the pointer rests near an edge, Esc cancels the drag).
// All git-derived text goes through textContent (subjects and names through util.displayName).
(function () {
  const { el, util } = window.Components;
  const { displayName: dn, relTime, absTime, initials, plural, short, modKey, inTextField, modalOpen } = util;
  const A = window.Components.actions;
  const R = () => window.PLRebase;

  const ROW_H = 34; // the fallback of --re-row-h (no stylesheet: tests)
  const VIRTUAL_MIN = 200;
  const OVERSCAN = 8;
  const DRAG_START_PX = 4;
  const EDGE_PX = 28;

  /** The row height: rebase-editor.css' --re-row-h on `root` (px), else ROW_H. */
  function rowHeight(root) {
    const css = typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(root).getPropertyValue('--re-row-h')) : NaN;
    return Number.isFinite(css) && css > 0 ? css : ROW_H;
  }

  /** The KEYS entries the editor leaves to their global handlers: ⌘L fetch and main's ⇧⌘O. */
  const PASS_KEYS = new Set(['fetch', 'open']);

  /** Pure: the header subtitle for editor state `ed`. */
  function subtitle(ed) {
    const n = ed.model.rows.length;
    const sha = ed.names && ed.names.ontoSha ? short(ed.names.ontoSha) : '';
    const onto = (ed.names && ed.names.onto) || sha || 'its new base';
    return `Rebasing ${plural(n, 'commit')} of ${(ed.names && ed.names.branch) || 'HEAD'} onto ${onto}${sha && sha !== onto ? ` (${sha})` : ''}`;
  }

  /** Pure: why Start can't run for store state `s` (stale plan, another op, busy), or ''. */
  function startBlocker(s, v) {
    const ed = s.rebaseEditor;
    if (!ed) return 'No rebase plan';
    if (ed.running) return 'Rebasing…';
    const stale = staleText(s);
    if (stale) return stale;
    if (s.busy) return A.BUSY_TITLE;
    if (!v.ok) return v.errors[0].message;
    return '';
  }

  /** Pure: why the plan can't start for store state `s` (PLRebase.planBlocker, shared with the Start flow), or null. */
  function staleOf(s) {
    const ed = s.rebaseEditor;
    return !ed || ed.running ? null : R().planBlocker(ed, s.status);
  }

  /** Pure: the stale-plan text for store state `s`, or ''. */
  const staleText = (s) => { const b = staleOf(s); return b ? b.text : ''; };

  window.Components.register('rebase-editor', {
    mount(root, store) {
      root.classList.add('rebase-editor', 're');
      root.hidden = true;
      const ROW = rowHeight(root);

      const header = el('header', 're-header');
      const title = el('h2', 're-title', 'Interactive Rebase');
      const sub = el('div', 're-subtitle');
      header.append(title, sub);

      const notes = el('div', 're-notes');
      const staleBar = el('div', 're-stale');
      staleBar.setAttribute('role', 'alert');
      const staleMsg = el('span', 're-stale-text');
      const reloadBtn = el('button', 'btn re-reload', 'Reload');
      reloadBtn.type = 'button';
      reloadBtn.title = 'Re-read the commits, keeping the actions you set for the ones still there';
      staleBar.append(staleMsg, reloadBtn);
      const warnList = el('ul', 're-warnings');
      notes.append(staleBar, warnList);

      const grid = el('div', 're-grid');
      grid.tabIndex = 0;
      grid.setAttribute('role', 'grid');
      grid.setAttribute('aria-label', 'Commits to rebase, newest first');
      grid.setAttribute('aria-multiselectable', 'true');
      const spacer = el('div', 're-spacer');
      spacer.setAttribute('role', 'rowgroup');
      const dropLine = el('div', 're-drop-line');
      dropLine.hidden = true;
      spacer.append(dropLine);
      grid.append(spacer);

      const ontoRow = el('div', 're-onto');
      const live = el('div', 're-live');
      live.setAttribute('aria-live', 'polite');
      live.setAttribute('role', 'status');

      const footer = el('footer', 're-footer');
      const summaryEl = el('div', 're-summary');
      const summaryText = el('span', 're-summary-text');
      const countText = el('span', 're-count');
      const errorText = el('span', 're-error');
      summaryEl.append(summaryText, countText, errorText);
      const btns = el('div', 're-buttons');
      const mk = (label, cls, t) => {
        const b = el('button', `btn ${cls}`, label);
        b.type = 'button';
        if (t) b.title = t;
        return b;
      };
      const resetBtn = mk('Reset', 're-reset', 'Back to the plan as loaded: every commit picked, in its original order');
      const cancelBtn = mk('Cancel', 're-cancel', 'Close the editor without rebasing (Esc)');
      const startBtn = mk('Start Rebase', 'btn-primary re-start');
      btns.append(resetBtn, cancelBtn, startBtn);
      footer.append(summaryEl, btns);

      root.replaceChildren(header, notes, grid, ontoRow, live, footer);

      // ---- local UI state (not in the store): cursor, selection, anchor, drag
      let cursor = null; // sha
      let selected = new Set();
      let anchor = null;
      let drag = null; // {shas, startY, active, index}
      let raf = 0;
      let wasOpen = false;
      const rowEls = new Map(); // sha -> row element (rendered rows only)
      let lastModel = null;
      let v = null; // validation of lastModel

      const S = () => store.state;
      const ed = () => S().rebaseEditor;
      const rows = () => (ed() ? ed().model.rows : []);
      const indexOfSha = (sha) => rows().findIndex((r) => r.sha === sha);
      const selection = () => {
        const list = rows().filter((r) => selected.has(r.sha)).map((r) => r.sha);
        if (list.length) return list;
        return cursor ? [cursor] : [];
      };
      const locked = () => !ed() || ed().running;

      function announce(text) {
        live.textContent = '';
        live.textContent = text;
      }

      // ---- rows

      function makeRow(sha) {
        const r = el('div', 're-row');
        r.setAttribute('role', 'row');
        r.id = `re-row-${sha}`;
        r.dataset.sha = sha;
        const cell = (cls) => { const c = el('div', `re-cell ${cls}`); c.setAttribute('role', 'gridcell'); r.append(c); return c; };
        const act = cell('re-c-action');
        const select = el('select', 're-action');
        for (const a of R().ACTIONS) {
          const o = el('option', null, R().LABELS[a]);
          o.value = a;
          select.append(o);
        }
        act.append(select);
        const handle = cell('re-c-handle');
        const grip = el('span', 're-handle', '⋮⋮');
        grip.setAttribute('aria-hidden', 'true');
        grip.title = 'Drag to reorder (or ⌥↑ / ⌥↓)';
        handle.append(grip);
        const av = cell('re-c-avatar');
        av.append(el('span', 're-avatar'));
        const msg = cell('re-c-msg');
        const subject = el('span', 're-subject');
        const into = el('span', 're-into');
        const edit = el('button', 're-edit', '✎');
        edit.type = 'button';
        edit.tabIndex = -1;
        const rowErr = el('span', 're-row-error');
        msg.append(subject, into, edit, rowErr);
        const shaCell = cell('re-c-sha');
        const authorCell = cell('re-c-author');
        const dateCell = cell('re-c-date');
        r._p = { select, subject, into, edit, rowErr, avatar: av.firstChild, sha: shaCell, author: authorCell, date: dateCell };
        select.addEventListener('change', () => {
          const s = r.dataset.sha;
          const action = select.value; // read first: re-rendering the cursor resets the select
          const targets = selected.has(s) ? selection() : [s];
          if (!selected.has(s)) setCursor(s, { only: true });
          setAction(targets, action);
        });
        edit.addEventListener('click', (e) => {
          e.stopPropagation();
          editMessage(r.dataset.sha);
        });
        return r;
      }

      const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

      function fillRow(r, row, i, info) {
        const p = r._p;
        r.style.transform = `translateY(${i * ROW}px)`;
        r.dataset.index = String(i);
        r.setAttribute('aria-rowindex', String(i + 1));
        const cls = [
          're-row', `is-${row.action}`,
          selected.has(row.sha) ? 'is-selected' : '', cursor === row.sha ? 'is-cursor' : '',
          info.err ? 'is-error' : '', row.remoteRefs ? 'is-published' : '',
          drag && drag.active && drag.shas.includes(row.sha) ? 'is-dragged' : '',
        ].filter(Boolean).join(' ');
        if (r.className !== cls) r.className = cls;
        r.setAttribute('aria-selected', String(selected.has(row.sha) || cursor === row.sha));
        if (info.err) r.setAttribute('aria-invalid', 'true');
        else r.removeAttribute('aria-invalid');
        if (p.select.value !== row.action) p.select.value = row.action;
        p.select.disabled = locked();
        p.select.setAttribute('aria-label', `Action for ${dn(row.subject)}`);
        setText(p.subject, dn(row.subject) || short(row.sha));
        p.subject.title = row.message ? dn(row.message.split('\n')[0]) : '';
        setText(p.into, info.into ? `↳ into ${dn(info.into.subject) || short(info.into.sha)}` : '');
        p.into.hidden = !info.into;
        p.edit.hidden = !info.slot;
        let editTitle = '';
        if (info.slot) editTitle = info.slot.kind === 'reword' ? 'Edit the new message (Enter)' : 'Edit the combined message (Enter)';
        p.edit.title = editTitle;
        p.edit.classList.toggle('is-edited', !!(info.slot && info.slot.edited));
        setText(p.rowErr, info.err ? info.err.message : '');
        p.rowErr.hidden = !info.err;
        setText(p.avatar, initials(row.author));
        p.avatar.title = row.author ? dn(row.author) : '';
        setText(p.sha, short(row.sha));
        p.sha.title = row.remoteRefs && row.remoteRefs.length ? `${row.sha}\nAlready on ${row.remoteRefs.map(dn).join(', ')}` : row.sha;
        setText(p.author, dn(row.author));
        setText(p.date, relTime(row.date, { short: true }));
        p.date.title = absTime(row.date);
      }

      /** The rows to render: all of them up to VIRTUAL_MIN, else the visible window. */
      function windowRange(n) {
        if (n <= VIRTUAL_MIN) return [0, n];
        const h = grid.clientHeight || 800;
        const top = grid.scrollTop || 0;
        const first = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
        const last = Math.min(n, Math.ceil((top + h) / ROW) + OVERSCAN);
        return [first, last];
      }

      function renderRows() {
        const e = ed();
        if (!e) return;
        const list = e.model.rows;
        spacer.style.height = `${list.length * ROW}px`;
        const errBySha = new Map();
        for (const x of v.errors) if (x.sha && !errBySha.has(x.sha)) errBySha.set(x.sha, x);
        const [first, last] = windowRange(list.length);
        const keep = new Set();
        for (let i = first; i < last; i++) {
          const row = list[i];
          keep.add(row.sha);
          let r = rowEls.get(row.sha);
          if (!r) {
            r = makeRow(row.sha);
            rowEls.set(row.sha, r);
            spacer.append(r);
          }
          fillRow(r, row, i, { err: errBySha.get(row.sha) || null, into: R().intoOf(e.model, row.sha), slot: row.action === 'drop' ? null : R().messageSlot(e.model, row.sha) });
        }
        for (const [sha, r] of rowEls) {
          if (keep.has(sha)) continue;
          if (r.contains(document.activeElement)) grid.focus({ preventScroll: true });
          r.remove();
          rowEls.delete(sha);
        }
        orderRows(list.slice(first, last).map((row) => rowEls.get(row.sha)));
        if (cursor && rowEls.has(cursor)) grid.setAttribute('aria-activedescendant', `re-row-${cursor}`);
        else grid.removeAttribute('aria-activedescendant');
      }

      /**
       * Put the rendered rows in list order after the drop line (Tab and screen readers follow the DOM,
       * not the transforms). Only misplaced rows move, and focus inside a moved row is put back.
       */
      function orderRows(want) {
        const active = document.activeElement;
        want.forEach((r, k) => {
          const at = spacer.children[k + 1] || null; // [0] is the drop line
          if (at !== r) spacer.insertBefore(r, at);
        });
        if (active && active !== document.activeElement && spacer.contains(active)) active.focus({ preventScroll: true });
      }

      // ---- whole view

      function render() {
        const s = S();
        const e = s.rebaseEditor;
        const open = !!e;
        root.hidden = s.centre !== 'rebaseEditor';
        if (!open) {
          if (wasOpen) closed();
          return;
        }
        if (!wasOpen) opened();
        const m = e.model;
        if (m !== lastModel) {
          lastModel = m;
          v = R().validate(m, e.names);
          // keep the cursor / selection on rows that still exist
          const shas = new Set(m.rows.map((r) => r.sha));
          selected = new Set([...selected].filter((x) => shas.has(x)));
          if (!cursor || !shas.has(cursor)) cursor = m.rows[0] ? m.rows[0].sha : null;
          if (anchor && !shas.has(anchor)) anchor = cursor;
        }
        setText(sub, subtitle(e));
        sub.title = e.plan && e.plan.head ? `HEAD ${e.plan.head}` : '';

        const stale = staleOf(s);
        staleBar.hidden = !stale;
        setText(staleMsg, stale ? stale.text : '');
        // Reload helps only when HEAD moved on the plan's branch (not another branch or an op in progress).
        reloadBtn.disabled = !!(s.busy || e.running || (stale && !stale.reload));

        const notesList = [...v.warnings.map((w) => ({ ...w, level: 'warn' })), ...v.infos.map((x) => ({ ...x, level: 'info' }))];
        const key = notesList.map((n) => `${n.level}:${n.code}:${n.message}`).join('\n');
        if (warnList.dataset.key !== key) {
          warnList.dataset.key = key;
          warnList.replaceChildren(...notesList.map((n) => {
            const li = el('li', `re-note re-note-${n.level}`, `${n.level === 'warn' ? '⚠ ' : ''}${n.message}`);
            li.dataset.code = n.code;
            return li;
          }));
        }
        warnList.hidden = !notesList.length;

        renderRows();

        const ontoSha = e.names && e.names.ontoSha;
        const base = ontoSha && (s.commits || []).find((c) => c.hash === ontoSha);
        setText(ontoRow, `● ${e.names.onto || short(ontoSha)}${ontoSha && short(ontoSha) !== e.names.onto ? `  ${short(ontoSha)}` : ''}${base ? `  "${dn(base.subject)}"` : ''}   (onto — not editable)`);

        const sum = R().summary(m);
        setText(summaryText, sum.text);
        summaryText.title = sum.countsText;
        setText(countText, `${plural(sum.before, 'commit')} → ${sum.after}`);
        const shown = v.errors.find((x) => x.code !== 'nothing');
        const more = v.errors.length > 1 ? ` (+${v.errors.length - 1} more)` : '';
        setText(errorText, shown ? `${shown.message}${more}` : '');
        errorText.hidden = !shown;

        const why = startBlocker(s, v);
        startBtn.disabled = !!why;
        startBtn.title = why || A.withKeyHint('Start the rebase', 'commit');
        setText(startBtn, e.running ? 'Rebasing…' : 'Start Rebase');
        resetBtn.disabled = locked() || !R().changed(m);
        cancelBtn.disabled = !!e.running;
        root.classList.toggle('is-running', !!e.running);
      }

      function opened() {
        wasOpen = true;
        lastModel = null;
        cursor = null;
        selected = new Set();
        anchor = null;
        for (const r of rowEls.values()) r.remove();
        rowEls.clear();
        grid.scrollTop = 0;
        const e = ed();
        cursor = e.model.rows[0] ? e.model.rows[0].sha : null;
        anchor = cursor;
        queueMicrotask(() => { if (ed() && !modalOpen()) grid.focus({ preventScroll: true }); });
      }

      function closed() {
        wasOpen = false;
        lastModel = null;
        endDrag(false);
        const active = document.activeElement;
        // Focus leaves with the editor: the graph takes it back (graph-view, on state.centre 'graph').
        if (active && root.contains(active) && typeof active.blur === 'function') active.blur();
        for (const r of rowEls.values()) r.remove();
        rowEls.clear();
      }

      // ---- editing

      function setAction(shas, action) {
        if (locked() || !shas.length) return;
        if (store.actions.editRebase((m) => R().setAction(m, shas, action))) {
          announce(shas.length === 1 ? `${R().LABELS[action]}: ${subjectOf(shas[0])}` : `${plural(shas.length, 'commit')} set to ${R().LABELS[action]}`);
        }
      }

      const subjectOf = (sha) => { const r = rows().find((x) => x.sha === sha); return r ? dn(r.subject) || short(sha) : short(sha); };

      function moveBy(delta) {
        const shas = selection();
        if (locked() || !shas.length) return;
        if (store.actions.editRebase((m) => R().move(m, shas, delta))) {
          const i = indexOfSha(cursor);
          reveal(cursor);
          announce(`${shas.length === 1 ? subjectOf(shas[0]) : plural(shas.length, 'commit')} moved to position ${i + 1} of ${rows().length}`);
        }
      }

      async function editMessage(sha) {
        const e = ed();
        if (!e || locked()) return;
        const slot = R().messageSlot(e.model, sha);
        if (!slot) {
          const r = rowEls.get(sha);
          if (r) r._p.select.focus();
          return;
        }
        const g = R().groupOf(e.model, sha);
        const n = g ? 1 + g.members.length : 1;
        const title = slot.kind === 'reword' ? `Reword "${subjectOf(slot.rowSha)}"` : `Message for the ${n} squashed commits`;
        const text = await window.Components.dialog.editMessage({
          title, message: slot.message, okLabel: 'Save',
          note: slot.kind === 'squash' ? 'The commits are combined into one with this message.' : '',
        });
        if (text === null || text === undefined) { grid.focus({ preventScroll: true }); return; }
        store.actions.editRebase((m) => R().setMessage(m, sha, text));
        grid.focus({ preventScroll: true });
      }

      const run = (flow) => A.runFlow({ flow, args: [] }, store);

      // ---- cursor and selection

      function reveal(sha) {
        const i = indexOfSha(sha);
        if (i < 0) return;
        const h = grid.clientHeight || 0;
        if (h <= 0) return;
        const top = i * ROW;
        if (top < grid.scrollTop) grid.scrollTop = top;
        else if (top + ROW > grid.scrollTop + h) grid.scrollTop = top + ROW - h;
      }

      function setCursor(sha, { extend = false, toggle = false, only = false } = {}) {
        if (!sha) return;
        if (extend && anchor) {
          const a = indexOfSha(anchor);
          const b = indexOfSha(sha);
          const [lo, hi] = a < b ? [a, b] : [b, a];
          selected = new Set(rows().slice(lo, hi + 1).map((r) => r.sha));
        } else if (toggle) {
          if (selected.size === 0 && cursor) selected.add(cursor);
          if (selected.has(sha)) selected.delete(sha);
          else selected.add(sha);
          anchor = sha;
        } else if (only || !extend) {
          selected = new Set([sha]);
          anchor = sha;
        }
        cursor = sha;
        reveal(sha);
        render();
      }

      function moveCursor(delta, extend) {
        const list = rows();
        if (!list.length) return;
        const i = Math.max(0, indexOfSha(cursor));
        const j = Math.max(0, Math.min(list.length - 1, i + delta));
        setCursor(list[j].sha, { extend });
      }

      // ---- keyboard

      const ACTION_KEYS = () => R().KEY_ACTIONS;

      function ownsKey(e) {
        if (!ed() || root.hidden) return false;
        const t = e.target;
        if (t && t.nodeType === 1 && root.contains(t)) return true;
        const a = document.activeElement;
        return !a || a === document.body || (typeof document.documentElement !== 'undefined' && a === document.documentElement);
      }

      /**
       * A global shortcut pressed in the editor (a Components.actions.KEYS entry): ⌘↵ starts the rebase,
       * ⌘Z / ⌘⇧Z undo / redo the plan; every other write (⌘B, ⌘⇧S, ⌘⇧U, ⌘⇧↵, …) is swallowed so the app
       * and WIP panel handlers, which skip handled keys, don't run it. Held keys act once.
       */
      function claimKey(e, entry) {
        e.preventDefault();
        if (e.repeat) return;
        if (entry.id === 'commit') run('startInteractiveRebase');
        else if (entry.id === 'undo') { if (store.actions.undoRebaseEdit()) announce('Undone'); }
        else if (entry.id === 'redo') { if (store.actions.redoRebaseEdit()) announce('Redone'); }
      }

      function onKey(e) {
        if (e.defaultPrevented || modalOpen() || !ownsKey(e)) return;
        const mod = modKey(e);
        const key = e.key;
        if (drag && key === 'Escape') { e.preventDefault(); endDrag(false); return; }
        const entry = A.matchKey(e);
        if (entry && !PASS_KEYS.has(entry.id)) { claimKey(e, entry); return; }
        if (key === 'Escape' && !mod) {
          e.preventDefault();
          run('cancelInteractiveRebase');
          return;
        }
        const t = e.target;
        const inSelect = t && t.tagName === 'SELECT';
        if (inSelect || (t && t !== grid && t.tagName === 'BUTTON')) return; // native keys
        if (inTextField(e)) return;
        if (e.altKey && !mod && (key === 'ArrowUp' || key === 'ArrowDown')) {
          e.preventDefault();
          moveBy(key === 'ArrowUp' ? -1 : 1);
          return;
        }
        if (mod && String(key).toLowerCase() === 'a' && !e.altKey) {
          e.preventDefault();
          selected = new Set(rows().map((r) => r.sha));
          render();
          return;
        }
        if (mod || e.altKey) return;
        const page = Math.max(1, Math.floor((grid.clientHeight || 0) / ROW) - 1);
        const nav = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1, Home: -Infinity, End: Infinity, PageDown: page, PageUp: -page };
        if (Object.hasOwn(nav, key)) {
          e.preventDefault();
          const d = nav[key];
          moveCursor(Number.isFinite(d) ? d : Math.sign(d) * rows().length, !!e.shiftKey); // Home / End: past either end
          return;
        }
        if (key === ' ') {
          e.preventDefault();
          if (cursor) setCursor(cursor, { toggle: true });
          return;
        }
        if (key === 'Enter') {
          e.preventDefault();
          if (cursor) editMessage(cursor);
          return;
        }
        const action = !e.shiftKey && Object.hasOwn(ACTION_KEYS(), String(key).toLowerCase()) ? ACTION_KEYS()[String(key).toLowerCase()] : null;
        if (action) {
          e.preventDefault();
          if (e.repeat) return;
          setAction(selection(), action);
        }
      }
      document.addEventListener('keydown', onKey);

      // ---- mouse

      function rowOfEvent(e) {
        const r = e.target && e.target.closest ? e.target.closest('.re-row') : null;
        return r && spacer.contains(r) ? r : null;
      }

      grid.addEventListener('click', (e) => {
        const r = rowOfEvent(e);
        if (!r || !ed()) return;
        if (e.target && e.target.closest && e.target.closest('select')) return; // the select keeps its focus
        const sha = r.dataset.sha;
        if (e.shiftKey) setCursor(sha, { extend: true });
        else if (modKey(e)) setCursor(sha, { toggle: true });
        else setCursor(sha, { only: true });
        grid.focus({ preventScroll: true });
      });
      grid.addEventListener('dblclick', (e) => {
        const r = rowOfEvent(e);
        if (r && !(e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON'))) editMessage(r.dataset.sha);
      });

      // Drag to reorder: pointer events on the ⋮⋮ handle; the drop position is computed from the grid's
      // box and scroll offset, so recycled rows need no listeners of their own.
      function dropIndex(clientY) {
        const box = grid.getBoundingClientRect();
        const y = clientY - box.top + (grid.scrollTop || 0);
        return Math.max(0, Math.min(rows().length, Math.round(y / ROW)));
      }

      grid.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const onHandle = e.target && e.target.closest && e.target.closest('.re-c-handle');
        const r = rowOfEvent(e);
        if (!onHandle || !r || locked()) return;
        e.preventDefault();
        const sha = r.dataset.sha;
        if (!selected.has(sha)) setCursor(sha, { only: true });
        else { cursor = sha; render(); }
        drag = { shas: selection(), startY: e.clientY, active: false, index: null, pointerId: e.pointerId };
        if (typeof grid.setPointerCapture === 'function' && e.pointerId !== undefined) {
          try { grid.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
        }
        grid.focus({ preventScroll: true });
      });

      function onPointerMove(e) {
        if (!drag) return;
        if (!drag.active && Math.abs(e.clientY - drag.startY) < DRAG_START_PX) return;
        if (!drag.active) {
          drag.active = true;
          root.classList.add('is-dragging');
          render();
        }
        drag.y = e.clientY;
        showDrop();
        if (!drag.scrollRaf) edgeScroll();
      }

      /** The drop line at the pointer's position. */
      function showDrop() {
        drag.index = dropIndex(drag.y);
        dropLine.hidden = false;
        dropLine.style.transform = `translateY(${drag.index * ROW - 1}px)`;
      }

      /** -1 / 1 while the dragging pointer is near the top / bottom edge, else 0. */
      function edgeOf(y) {
        const box = grid.getBoundingClientRect();
        if (y < box.top + EDGE_PX) return -1;
        return box.bottom && y > box.bottom - EDGE_PX ? 1 : 0;
      }

      /** Auto-scroll: one step per frame while the pointer rests near an edge and the grid can still scroll. */
      function edgeScroll() {
        if (!drag || !drag.active) return;
        drag.scrollRaf = 0;
        const dir = edgeOf(drag.y);
        if (!dir) return;
        const before = grid.scrollTop || 0;
        grid.scrollTop = Math.max(0, before + (dir * ROW) / 2);
        if ((grid.scrollTop || 0) === before) return; // at the end
        showDrop();
        drag.scrollRaf = requestAnimationFrame(edgeScroll);
      }

      function endDrag(commit) {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (d.scrollRaf) cancelAnimationFrame(d.scrollRaf);
        dropLine.hidden = true;
        root.classList.remove('is-dragging');
        if (commit && d.active && d.index !== null && store.actions.editRebase((m) => R().moveTo(m, d.shas, d.index))) {
          const i = indexOfSha(d.shas[0]);
          announce(`${d.shas.length === 1 ? subjectOf(d.shas[0]) : plural(d.shas.length, 'commit')} moved to position ${i + 1} of ${rows().length}`);
        } else if (ed()) render();
      }

      const onPointerUp = () => endDrag(true);
      const onPointerCancel = () => endDrag(false);
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerCancel);

      grid.addEventListener('scroll', () => {
        if (rows().length <= VIRTUAL_MIN || raf) return;
        raf = requestAnimationFrame(() => { raf = 0; renderRows(); });
      });

      // ---- buttons

      startBtn.addEventListener('click', () => run('startInteractiveRebase'));
      cancelBtn.addEventListener('click', () => run('cancelInteractiveRebase'));
      reloadBtn.addEventListener('click', () => run('reloadInteractiveRebase'));
      resetBtn.addEventListener('click', () => {
        if (store.actions.resetRebaseEditor()) announce('Reset: every commit picked, in its original order');
      });

      const unsub = store.subscribe(['rebaseEditor', 'busy', 'status', 'commits', 'centre'], render);
      render();
      return () => {
        unsub();
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerCancel);
        root.replaceChildren();
        root.hidden = true;
        root.classList.remove('rebase-editor', 're', 'is-running', 'is-dragging');
      };
    },
  });

  if (typeof module !== 'undefined') module.exports = { subtitle };
})();
