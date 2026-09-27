'use strict';
// details component — the right-hand panel.
//   selection.kind === 'wip'    → working-tree changes (conflicted / unstaged / staged) + commit composer
//   selection.kind === 'commit' → commit header (subject, body, author, date, sha, parents) + changed files;
//                                 a stash commit (sha in state.stashes) gets stash metadata instead
//   no selection                → a muted hint
// WIP (M4): per-file hover actions (Stage / Discard, Unstage, Mark resolved; mid-rebase / merge also
// "Keep main's version" / "Keep a1b2c3d's version", keys 1 / 2, and Mark All Resolved) in each row's
// `.dt-actions` slot, multi-select within a section (click, ⌘/Ctrl-click, Shift-click, Shift+arrows,
// ⌘A) with s / u / Delete keys, section buttons (Stage All Changes, Discard All, Unstage All), global
// ⌘⇧S / ⌘⇧U / ⌘⇧M / ⌘↵ / ⌘⇧↵ (Components.actions.KEYS), and the commit composer (components/composer.js).
// Every write is a working-tree flow (flows-worktree.js: stage, unstage, stageAll, unstageAll, discard with
// its confirm, markResolved; resolveWith) run through Components.actions.runFlow, so it takes the flow
// lock and the bare-repository refusal; the 'changed' event refreshes the store. The buttons are off
// while a flow of this store runs or the repo is busy; `acting` marks our own flow until it settles,
// before the asynchronous 'busy' event arrives.
// All git-derived text goes through textContent, and names/paths/messages through
// util.displayName (bidi and control characters made visible).
//
// Rendering is incremental: the panel skeleton is rebuilt only when the selection (or view mode)
// changes. File lists (components/file-list.js) are keyed by path and updated in place (focus
// and scroll survive refreshes). Pure selection / message rules live in components/wip-model.js.
// A rebase or merge in progress (docs/plans/rebase.md §5.4) adds a "Rebase conflicts detected" /
// "Merge conflicts detected" block above the lists (window.PLOp.conflictHeading), and the composer
// switches to its Continue Rebase / Commit and Merge mode (composer.js).
(function () {
  const { el, util } = window.Components;
  const { displayName: dn, relTime, absTime, initials, storage, plural, modKey, inTextField, modalOpen, short } = util;
  const { withKeyHint, matchKey, repeatBlocked, isBare, keyGlyph, headView, runFlow } = window.Components.actions;
  const W = window.PLWip;
  const FileList = window.PLFileList;
  const VIEW_KEY = 'pl.details.fileView'; // 'path' | 'tree'

  /** Multi-line text (commit bodies): every line made safe, newlines kept. */
  const dnLines = (s) => String(s == null ? '' : s).split('\n').map((line) => dn(line)).join('\n');
  /** The body's data-kind for a view key: 'wip', 'commit' (commit…) or 'none'. */
  function viewKind(key) {
    if (key === 'wip') return 'wip';
    return key.startsWith('commit') ? 'commit' : 'none';
  }

  function hashHue(s) {
    let h = 0;
    for (const c of String(s || '')) h = (h * 31 + c.codePointAt(0)) >>> 0;
    return h % 360;
  }

  // ------------------------------------------------------------ component

  window.Components.register('details', {
    mount(root, store) {
      let view = storage.get(VIEW_KEY, 'path') === 'tree' ? 'tree' : 'path';
      const collapsed = new Set(); // "<list key>:<folder path>" collapsed in tree view

      root.classList.add('dt');
      const body = el('div', 'dt-body');
      root.append(body);

      // The commit composer is built once and kept, so the typed message survives re-renders.
      const composer = window.PLComposer.create(store);

      // The current view: {key, kind, update(state, changed), refreshActive(), syncButtons?()};
      // rebuilt on selection change.
      let cur = null;

      // ------------------------------------------------------------ write actions (WIP)

      // Our own flow is in flight (from before its confirm until it settles): the buttons show it at
      // once. store.state.busy follows only through the asynchronous 'busy' event; a flow of this store
      // (ours or another's, PLFlows.isRunning) holds the one flow lock meanwhile.
      let acting = false;
      const flowRunning = () => { const f = window.PLFlows; return !!f && typeof f.isRunning === 'function' && f.isRunning(store); };
      const isOff = () => acting || !!store.state.busy || flowRunning();
      const syncButtons = () => { if (cur && cur.syncButtons) cur.syncButtons(); };

      /** Run working-tree flow `flow` with `args` (runFlow) unless one is in flight. Resolves true when it ran. */
      async function guarded(flow, ...args) {
        if (isOff()) return false;
        acting = true;
        syncButtons();
        try {
          return await runFlow({ flow, args }, store);
        } finally {
          acting = false;
          syncButtons();
        }
      }

      /** A keyboard action that can't run now says why (silent while busy: the toolbar says so). */
      const explain = (message) => { if (!isOff()) store.actions.notify(message); };

      function stageAllChanges({ keyboard = false } = {}) {
        const st = store.state.status;
        if (!st || !st.unstaged.length) {
          if (keyboard && st) explain('Stage all — no unstaged changes');
          return;
        }
        guarded('stageAll');
      }

      function unstageAllChanges({ keyboard = false } = {}) {
        const st = store.state.status;
        if (!st || !st.staged.length) {
          if (keyboard && st) explain('Unstage all — no staged changes');
          return;
        }
        guarded('unstageAll');
      }

      // Global shortcuts: the Components.actions.KEYS entries with a `wip` action. ⌘⇧S stage
      // all, ⌘⇧U unstage all, ⌘⇧M focus the commit summary (from any focus, text fields included:
      // `inField`), ⌘↵ commit / ⌘⇧↵ stage all and commit while the commit box is shown (inside its
      // fields composer.js handles them; not from another text field). Nothing while a dialog or
      // menu is open; a key repeat is swallowed (repeatBlocked: only ⌘⇧M, which just moves focus, repeats).
      function onGlobalKey(e) {
        const k = matchKey(e);
        const name = k && k.wip;
        if (!name || e.defaultPrevented || !store.state.repo || modalOpen()) return;
        const rv = root.closest('#repo-view');
        if ((rv && rv.hidden) || !root.isConnected) return;
        const commitKey = name === 'commit' || name === 'commitAll';
        if ((commitKey && !composer.el.isConnected) || (!k.inField && inTextField(e))) return;
        e.preventDefault();
        if (repeatBlocked(e, k)) return;
        if (name === 'stageAll') stageAllChanges({ keyboard: true });
        else if (name === 'unstageAll') unstageAllChanges({ keyboard: true });
        else if (commitKey) composer.tryCommit(name === 'commitAll');
        else {
          if (!(store.state.selection && store.state.selection.kind === 'wip')) {
            const hasWip = typeof store.hasWip === 'function' ? store.hasWip(store.state.status) : store.isDirty(store.state.status);
            if (!hasWip) {
              if (isBare(store.state)) explain('Nothing to commit — a bare repository has no working tree');
              else if (store.state.status) explain('Nothing to commit — the working tree is clean');
              return;
            }
            store.actions.select({ kind: 'wip' });
          }
          if (composer.el.isConnected) composer.focus();
        }
      }
      window.addEventListener('keydown', onGlobalKey);

      // ------------------------------------------------------------ shared pieces

      function viewToggle() {
        const wrap = el('div', 'dt-toggle');
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-label', 'File list view');
        for (const [v, label] of [['path', 'Path'], ['tree', 'Tree']]) {
          const b = el('button', `dt-toggle-btn${view === v ? ' is-on' : ''}`, label);
          b.type = 'button';
          b.dataset.view = v;
          b.setAttribute('aria-pressed', String(view === v));
          b.addEventListener('click', () => {
            if (view === v) return;
            view = v;
            storage.set(VIEW_KEY, v);
            for (const t of body.querySelectorAll('.dt-toggle-btn')) {
              const on = t.dataset.view === v;
              t.classList.toggle('is-on', on);
              t.setAttribute('aria-pressed', String(on));
            }
            if (cur) cur.update(store.state, ['view']);
          });
          wrap.append(b);
        }
        return wrap;
      }

      /**
       * Plain text to the clipboard through main (window.api.clipboard; the page's own
       * navigator.clipboard is denied by main's permission handlers). Rejects with an Error.
       */
      async function writeClipboard(text) {
        const api = window.api && window.api.clipboard;
        if (!api || typeof api.writeText !== 'function') throw new Error('The clipboard is not available');
        await Promise.resolve(api.writeText(text)).catch((e) => { throw util.toError(e); });
      }

      function copyButton(text, label) {
        const b = el('button', 'dt-copy', 'Copy');
        b.type = 'button';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.addEventListener('click', async () => {
          try {
            await writeClipboard(text);
            b.textContent = 'Copied';
            b.classList.add('is-done');
            setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('is-done'); }, 1200);
          } catch (e) {
            store.actions.toast(new Error(`Could not copy: ${e.message || e}`));
          }
        });
        return b;
      }

      function shaLink(sha, title) {
        const b = el('button', 'dt-parent', short(sha));
        b.type = 'button';
        b.title = title;
        b.dataset.sha = sha;
        b.addEventListener('click', () => store.actions.select({ kind: 'commit', sha }));
        return b;
      }

      function metaRow(label, ...children) {
        const r = el('div', 'dt-meta-row');
        r.append(el('span', 'dt-meta-label', label), ...children);
        return r;
      }

      function shaRow(label, sha) {
        const full = el('span', 'dt-sha selectable', sha);
        full.title = sha;
        return metaRow(label, full, copyButton(sha, 'Copy full SHA'));
      }

      /**
       * A WIP file-list section: header with count + action buttons, and a keyed list.
       * {key, title, emptyText, isActive(entry), onOpen(entry), listOpts} (listOpts: PLFileList.create options).
       */
      function section(scroller, { key, title, emptyText, isActive, onOpen, listOpts = {} }) {
        const sec = el('section', 'dt-section');
        sec.dataset.section = key;
        const head = el('div', 'dt-section-head');
        const h = el('h3', 'dt-section-title');
        const count = el('span', 'dt-count', '0');
        h.append(document.createTextNode(title), count);
        const actions = el('div', 'dt-actions dt-section-actions');
        head.append(h, actions);
        const list = FileList.create({ key, label: title, scroller, onOpen, collapsed, isActive, ...listOpts });
        const empty = el('div', 'dt-empty-list', emptyText);
        sec.append(head, empty);
        let shown = null; // 'list' | 'empty'
        return {
          sec,
          actions,
          list,
          update(entries) {
            count.textContent = String(entries.length);
            const want = entries.length ? 'list' : 'empty';
            if (want !== shown) {
              (want === 'list' ? empty : list.el).replaceWith(want === 'list' ? list.el : empty);
              shown = want;
            }
            list.update(entries, view);
          },
        };
      }

      /** Scroll area whose virtual lists repaint on scroll/resize. */
      function scrollArea(getLists) {
        const scroll = el('div', 'dt-scroll');
        let raf = 0;
        const paint = () => {
          raf = 0;
          for (const l of getLists()) l.paint();
        };
        const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
        scroll.addEventListener('scroll', schedule, { passive: true });
        const ro = new ResizeObserver(schedule);
        ro.observe(scroll);
        return { scroll, dispose: () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); } };
      }

      // ------------------------------------------------------------ WIP

      /** "N file changes on <branch>" header with the Path/Tree toggle. */
      function wipHeader() {
        const head = el('div', 'dt-wip-head');
        const title = el('div', 'dt-wip-title');
        const countText = document.createTextNode('');
        const pill = el('span', 'dt-branch-pill');
        title.append(countText, pill);
        head.append(title, viewToggle());
        return {
          el: head,
          update(st) {
            countText.textContent = `${plural(W.wipCount(st), 'file change')} on `;
            // Mid-rebase HEAD is detached (status.branch is null): headView names the branch being rebased.
            const head = headView({ status: st });
            const branch = head.label || 'detached HEAD';
            if (pill.textContent !== branch) pill.textContent = branch;
            pill.title = branch;
            pill.classList.toggle('is-detached', !head.branch && !head.rebasingBranch);
          },
        };
      }

      // Conflicted files mid-rebase / merge: "Keep main's version" / "Keep a1b2c3d's version"
      // (PLOp.resolveChoices, run by PLFlows.resolveWith; keys 1 / 2) before Mark resolved.
      const keepChoices = (entry) => (window.PLOp ? window.PLOp.resolveChoices(store.state.status, store.state.refsBySha, entry) : null);
      const conflictActions = (entry) => {
        const keep = keepChoices(entry) || [];
        return [
          ...keep.map((c, i) => ({ act: `keep-${c.side}`, label: c.label, title: `${c.title} (${i + 1})`, cls: 'dt-row-keep' })),
          { act: 'resolve', label: 'Mark resolved', title: 'Mark resolved: stage the file as it is (s)', cls: 'dt-row-resolve' },
        ];
      };

      const ROW_ACTIONS = {
        unstaged: () => [
          { act: 'stage', label: 'Stage', title: 'Stage (s)', cls: 'dt-row-stage' },
          { act: 'discard', icon: 'trash', title: `Discard changes (${keyGlyph('backspace')})`, cls: 'dt-row-discard' },
        ],
        staged: () => [{ act: 'unstage', label: 'Unstage', title: 'Unstage (u)', cls: 'dt-row-unstage' }],
        conflicted: conflictActions,
      };
      // The keep-a-side names change with the stop: the conflicted rows are rebuilt when they do.
      const ROW_ACTIONS_KEY = {
        conflicted: (entry) => (keepChoices(entry) || []).map((c) => c.label).join('|'),
      };
      const ROW_KEYS = { unstaged: { s: 'stage', Delete: 'discard', Backspace: 'discard' }, staged: { u: 'unstage' }, conflicted: { s: 'resolve', 1: 'keep-ours', 2: 'keep-theirs' } };
      // "<section>:<act>" -> (entries) => [flow, ...args] (a staged rename is unstaged by both its paths,
      // so the old path's deletion goes back too; keep a side: PLFlows.resolveWith)
      const RUN = {
        'unstaged:stage': (t) => ['stage', t.map((e) => e.path)],
        'staged:unstage': (t) => ['unstage', W.unstagePaths(t)],
        'unstaged:discard': (t) => ['discard', t, {}],
        'conflicted:resolve': (t) => ['markResolved', t, {}],
        'conflicted:keep-ours': (t) => ['resolveWith', { paths: t.map((e) => e.path), side: 'ours' }],
        'conflicted:keep-theirs': (t) => ['resolveWith', { paths: t.map((e) => e.path), side: 'theirs' }],
      };

      /** The rebase / merge conflict block (PLOp.conflictHeading); hidden otherwise. */
      function opHeading() {
        const box = el('div', 'dt-op-head');
        box.setAttribute('role', 'status');
        const t = el('div', 'dt-op-title');
        const txt = el('div', 'dt-op-text');
        box.append(t, txt);
        box.hidden = true;
        return {
          el: box,
          update(st) {
            const h = window.PLOp ? window.PLOp.conflictHeading(st) : null;
            box.hidden = !h;
            if (!h) return;
            if (t.textContent !== h.title) t.textContent = h.title;
            if (txt.textContent !== h.text) txt.textContent = h.text;
          },
        };
      }

      function wipView() {
        const header = wipHeader();
        const opHead = opHeading();
        const loading = el('div', 'dt-hint', 'Loading changes…');

        const activeFor = (listKey) => (e) => {
          const spec = store.state.diff && store.state.diff.spec;
          return !!spec && spec.kind === 'workdir' && spec.file === e.path && !!spec.staged === (listKey === 'staged');
        };
        // A staged rename's diff needs its old path too (workdirDiffView {staged, orig}).
        const openFor = (staged) => (e) => store.actions.openDiff({
          kind: 'workdir', file: e.path, staged, untracked: !staged && e.status === '?',
          ...(staged && e.orig && e.orig !== e.path ? { orig: e.orig } : {}),
        });

        // Multi-selection: one section at a time (PLWip.nextSelection).
        let sel = W.emptySelection();
        const lists = [];
        const redecorateAll = () => lists.forEach((l) => l.redecorate());
        const entriesOf = (listKey) => {
          const st = store.state.status;
          return (st && st[listKey]) || [];
        };

        // After a keyboard action removes the focused rows, focus moves to the row now at that place.
        let pendingFocus = null; // {list, index, at}
        const sections = {};
        async function runAction(listKey, act, entry, { keyboard }) {
          const run = RUN[`${listKey}:${act}`];
          if (!run || isOff()) return;
          const index = keyboard ? sections[listKey].list.focusedIndex() : -1;
          const t = W.targets(sel, listKey, entry, entriesOf(listKey));
          const done = await guarded(...run(t));
          if (done && index >= 0) pendingFocus = { list: listKey, index, at: Date.now() };
        }
        const keyFor = (listKey) => (e, entry, order) => {
          if (modKey(e) && !e.shiftKey && !e.altKey && (e.key === 'a' || e.key === 'A')) { // select the whole section
            sel = W.selectAll(listKey, order, entry.path);
            redecorateAll();
            return true;
          }
          if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
          const act = ROW_KEYS[listKey][e.key.length === 1 ? e.key.toLowerCase() : e.key];
          if (!act) return false;
          if (!e.repeat) runAction(listKey, act, entry, { keyboard: true });
          return true;
        };
        const listOpts = (listKey) => ({
          isSelected: (e) => sel.list === listKey && sel.paths.has(e.path),
          onGesture: (kind, entry, order, from) => {
            sel = W.nextSelection(sel, listKey, kind, entry.path, order || [], from ? from.path : null);
            redecorateAll();
          },
          actionsFor: ROW_ACTIONS[listKey],
          actionsKey: ROW_ACTIONS_KEY[listKey] || null,
          onAction: (act, entry, how) => runAction(listKey, act, entry, how),
          onKey: keyFor(listKey),
        });

        const area = scrollArea(() => lists);
        const wipSection = (key, title, emptyText, staged) => section(area.scroll, {
          key, title, emptyText, isActive: activeFor(key), onOpen: openFor(staged), listOpts: listOpts(key),
        });
        const conflicted = wipSection('conflicted', 'Conflicted Files', '', false);
        const unstaged = wipSection('unstaged', 'Unstaged Files', 'No unstaged changes', false);
        const staged = wipSection('staged', 'Staged Files', 'No staged changes', true);
        Object.assign(sections, { conflicted, unstaged, staged });
        lists.push(conflicted.list, unstaged.list, staged.list);

        const headBtn = (label, cls, title, onClick) => {
          const b = el('button', `btn btn-small ${cls}`, label);
          b.type = 'button';
          b.title = title;
          b.addEventListener('click', onClick);
          return b;
        };
        const discardAll = headBtn('Discard All', 'dt-discard-all', 'Discard all unstaged changes', () => {
          guarded('discard', entriesOf('unstaged'), { all: true });
        });
        const stageAll = headBtn('Stage All Changes', 'dt-stage-all', withKeyHint('Stage all changes', 'stageAll'), () => stageAllChanges());
        const unstageAll = headBtn('Unstage All', 'dt-unstage-all', withKeyHint('Unstage all changes', 'unstageAll'), () => unstageAllChanges());
        const resolveAll = headBtn('Mark All Resolved', 'dt-resolve-all', 'Mark every conflicted file resolved: stage each one as it is now', () => {
          guarded('markResolved', entriesOf('conflicted'), { all: true });
        });
        conflicted.actions.append(resolveAll);
        unstaged.actions.append(discardAll, stageAll);
        staged.actions.append(unstageAll);
        area.scroll.append(unstaged.sec, staged.sec);

        function renderButtons() {
          const st = store.state.status;
          const off = isOff();
          discardAll.disabled = off || !st || !st.unstaged.length;
          stageAll.disabled = off || !st || !st.unstaged.length;
          unstageAll.disabled = off || !st || !st.staged.length;
          resolveAll.disabled = off || !st || !st.conflicted.length;
          root.classList.toggle('is-busy', off);
        }

        let status = null;
        let shownLoading = null;

        function update(state, changed) {
          const st = state.status;
          const isLoading = !st;
          if (isLoading !== shownLoading) {
            body.replaceChildren(...(isLoading ? [loading] : [header.el, opHead.el, area.scroll, composer.el]));
            shownLoading = isLoading;
          }
          renderButtons();
          composer.render();
          if (!st || (st === status && !changed.includes('view'))) return;
          status = st;
          sel = W.pruneSelection(sel, st);
          header.update(st);
          opHead.update(st);
          if (st.conflicted.length && !conflicted.sec.isConnected) area.scroll.prepend(conflicted.sec);
          else if (!st.conflicted.length && conflicted.sec.isConnected) conflicted.sec.remove();
          if (st.conflicted.length) conflicted.update(st.conflicted);
          unstaged.update(st.unstaged);
          staged.update(st.staged);
          restoreFocus();
        }

        function restoreFocus() {
          const pf = pendingFocus;
          const a = document.activeElement;
          if (!pf || Date.now() - pf.at >= 5000 || (a && a !== document.body && a.isConnected)) return;
          pendingFocus = null;
          if (!sections[pf.list].list.focusAt(pf.index)) {
            for (const l of lists) if (l.focusAt(0)) break;
          }
        }

        return {
          kind: 'wip',
          update,
          syncButtons: renderButtons,
          refreshActive: () => lists.forEach((l) => l.refreshActive()),
          dispose: area.dispose,
          wants: (changed) => changed.some((k) => k === 'status' || k === 'view' || k === 'busy'),
        };
      }

      // ------------------------------------------------------------ commit / stash

      function commitHeader(state, sha, c, stash) {
        const head = el('div', 'dt-commit');
        if (stash) {
          const ref = el('span', 'dt-ref dt-ref-stash', dn(stash.ref));
          head.append(metaRow('stash', ref));
          head.append(shaRow('commit', sha));
          const base = stash.parents && stash.parents[0];
          if (base) head.append(metaRow('base', shaLink(base, `Select base commit ${base}`)));
          const msg = stash.message || '(no message)';
          head.append(el('h2', 'dt-subject selectable', dn(msg)));
          const when = el('div', 'dt-date');
          when.append(document.createTextNode(`stashed ${absTime(stash.date)}`), el('span', 'dt-date-rel', ` · ${relTime(stash.date)}`));
          when.title = new Date(stash.date * 1000).toString();
          head.append(when);
          return head;
        }
        head.append(shaRow('commit', sha));
        if (!c) {
          head.append(el('div', 'dt-hint-inline', 'Commit details are not loaded (outside the loaded history).'));
          return head;
        }
        if (c.parents.length) {
          const plist = el('span', 'dt-parents');
          for (const p of c.parents) plist.append(shaLink(p, `Select parent ${p}`));
          head.append(metaRow(c.parents.length > 1 ? 'parents' : 'parent', plist));
        }
        const refs = state.refsBySha && state.refsBySha.get(sha);
        if (refs && refs.length) {
          const rRow = el('div', 'dt-refs');
          for (const r of refs) {
            const pillEl = el('span', `dt-ref dt-ref-${r.type}`, dn(r.name));
            pillEl.title = dn(r.name);
            rRow.append(pillEl);
          }
          head.append(rRow);
        }
        head.append(el('h2', 'dt-subject selectable', c.subject ? dn(c.subject) : '(no message)'));
        if (c.body) head.append(el('div', 'dt-message selectable', dnLines(c.body)));

        const who = el('div', 'dt-author');
        const av = el('span', 'dt-avatar', initials(dn(c.author)));
        av.style.backgroundColor = `hsl(${hashHue(c.email || c.author)}, 45%, 42%)`;
        av.setAttribute('aria-hidden', 'true');
        const info = el('div', 'dt-author-info');
        const nameLine = el('div', 'dt-author-name selectable');
        nameLine.append(el('span', 'dt-author-display', dn(c.author)), el('span', 'dt-author-email', ` <${dn(c.email)}>`));
        nameLine.title = `${dn(c.author)} <${dn(c.email)}>`;
        const when = el('div', 'dt-date');
        when.append(document.createTextNode(`authored ${absTime(c.date)}`), el('span', 'dt-date-rel', ` · ${relTime(c.date)}`));
        when.title = new Date(c.date * 1000).toString();
        info.append(nameLine, when);
        if (c.committer && c.committer !== c.author) {
          info.append(el('div', 'dt-date', `committed by ${dn(c.committer)} · ${relTime(c.committerDate)}`));
        }
        who.append(av, info);
        head.append(who);
        return head;
      }

      function commitView(sha) {
        const filesHead = el('div', 'dt-files-head');
        const filesTitle = el('span', 'dt-files-title', 'Changed files');
        filesHead.append(filesTitle, viewToggle());
        const note = el('div', 'dt-note');
        const hint = el('div', 'dt-hint-inline');
        const err = el('div', 'dt-error');
        const lists = [];
        const area = scrollArea(() => lists);
        const isActive = (e) => {
          const spec = store.state.diff && store.state.diff.spec;
          return !!spec && spec.kind === 'commit' && spec.sha === sha && spec.file === e.path;
        };
        const open = (e) => store.actions.openDiff({ kind: 'commit', sha, file: e.path, orig: e.orig });
        const list = FileList.create({ key: 'commit', label: 'Changed files', scroller: area.scroll, onOpen: open, collapsed, isActive });
        lists.push(list);
        let header = el('div', 'dt-commit');
        let headerSig = null;
        let shownFiles = null;
        let cfShown;

        const findStash = (state) => (state.stashes || []).find((s) => s.hash === sha) || null;

        function update(state, changed) {
          const stash = findStash(state);
          const c = stash ? null : state.commits.find((x) => x.hash === sha) || null;
          // The header depends on the commit (or stash) object and its refs only.
          const refs = state.refsBySha && state.refsBySha.get(sha);
          const hs = [stash && `${stash.ref}\u0000${stash.message}\u0000${stash.date}`, c && c.hash, refs ? refs.map((r) => `${r.type}:${r.name}`).join(',') : ''].join('|');
          if (hs !== headerSig) {
            headerSig = hs;
            const next = commitHeader(state, sha, c, stash);
            header.replaceWith(next);
            header = next;
          }
          const isMerge = !!(c && c.parents.length > 1);
          let noteText = '';
          if (isMerge) noteText = `Merge commit — changes shown against the first parent (${short(c.parents[0])})`;
          else if (stash) noteText = 'Stash — tracked changes against its base commit';
          note.textContent = noteText;
          note.hidden = !note.textContent;

          const cf = state.commitFiles && state.commitFiles.sha === sha ? state.commitFiles : null;
          if (cf === cfShown && !changed.includes('view')) return;
          cfShown = cf;
          const count = cf && cf.files ? cf.files.length : null;
          filesTitle.textContent = count === null ? 'Changed files' : plural(count, 'changed file');
          let want;
          if (!cf || cf.loading) { hint.textContent = 'Loading files…'; want = hint; }
          else if (cf.error) { err.textContent = cf.error; want = err; }
          else if (!cf.files.length) { hint.textContent = 'No file changes'; want = hint; }
          else want = list.el;
          if (shownFiles !== want) {
            area.scroll.replaceChildren(want);
            shownFiles = want;
          }
          if (want === list.el) list.update(cf.files, view);
        }

        body.replaceChildren(header, filesHead, note, area.scroll);
        return {
          kind: 'commit',
          update,
          refreshActive: () => list.refreshActive(),
          dispose: area.dispose,
          wants: (changed) => changed.some((k) => k === 'commitFiles' || k === 'refsBySha' || k === 'stashes' || k === 'view'),
        };
      }

      // ------------------------------------------------------------ render

      function viewKey(state) {
        const sel = state.selection;
        if (!state.repo) return 'none';
        if (!sel) return 'empty';
        return sel.kind === 'wip' ? 'wip' : `commit:${sel.sha}`;
      }

      function onChange(state, changed) {
        if (changed.includes('repo')) composer.setRepo(state.repo);
        const key = viewKey(state);
        if (!cur || cur.key !== key || changed.includes('repo')) {
          if (cur && cur.dispose) cur.dispose();
          if (key === 'none') {
            cur = { key };
            body.replaceChildren();
          } else if (key === 'empty') {
            cur = { key };
            body.replaceChildren(el('div', 'dt-hint', 'Select a commit or the work-in-progress row to see its details.'));
          } else if (key === 'wip') {
            cur = { key, ...wipView() };
          } else {
            cur = { key, ...commitView(state.selection.sha), hadCommit: state.commits.some((c) => c.hash === state.selection.sha) };
          }
          body.dataset.kind = viewKind(key);
          if (cur.update) cur.update(state, ['view']);
          return;
        }
        if (!cur.update) return;
        if (changed.includes('commits') && cur.kind === 'commit') {
          // Only matters when the selected commit was missing from the loaded history and now is there.
          const sha = state.selection.sha;
          const had = cur.hadCommit;
          cur.hadCommit = state.commits.some((c) => c.hash === sha);
          if (!had && cur.hadCommit) {
            cur.update(state, ['commits']);
            return;
          }
        }
        if (cur.wants(changed)) cur.update(state, changed);
      }

      const unsubs = [
        store.subscribe(['repo', 'selection', 'status', 'commitFiles', 'commits', 'refsBySha', 'stashes', 'busy'], onChange),
        store.subscribe(['diff'], () => { if (cur && cur.refreshActive) cur.refreshActive(); }),
      ];
      onChange(store.state, ['repo']);
      return () => {
        unsubs.forEach((u) => u());
        window.removeEventListener('keydown', onGlobalKey);
        composer.dispose();
        if (cur && cur.dispose) cur.dispose();
        cur = null;
        body.remove(); // a remount starts from an empty region
        root.classList.remove('dt', 'is-busy');
      };
    },
  });
})();
