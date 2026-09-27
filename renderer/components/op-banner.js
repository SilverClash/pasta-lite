'use strict';
// Operation banner (docs/plans/rebase.md §5.3): between the toolbar and the main area, shown while a
// rebase, merge or other git operation is in progress, or while a rebase's autostash waits to be
// restored; in a bare repository it says so and offers its worktrees (openWorktree). Text and buttons come from the pure window.PLOp.bannerModel(state); the buttons run
// window.PLFlows (rebaseContinue / rebaseSkip / rebaseAbort, mergeCommit / mergeAbort,
// restoreAutostash) through Components.actions.runFlow, and are disabled while busy
// (Components.actions.finishItems). A disabled button is aria-disabled, stays in the Tab order and
// keeps its reason as the tooltip (as in the toolbar). The text is a polite live region (role=status).
// All git-derived text reaches the DOM through textContent (PLOp names are display-safe).
(function () {
  const { el } = window.Components;
  const A = window.Components.actions;

  /** Model + busy gating: the buttons as finished Components.actions descriptors. */
  function viewModel(state) {
    const m = window.PLOp ? window.PLOp.bannerModel(state) : null;
    if (!m) return null;
    return { ...m, buttons: A.finishItems(m.buttons, state) };
  }

  window.Components.register('op-banner', {
    mount(root, store) {
      root.classList.add('op-banner');
      const text = el('div', 'ob-text');
      text.setAttribute('role', 'status');
      text.setAttribute('aria-live', 'polite');
      const titleEl = el('strong', 'ob-title');
      const lines = el('div', 'ob-lines');
      text.append(titleEl, lines);
      const detailWrap = el('div', 'ob-detail-wrap');
      const detailLabel = el('div', 'ob-detail-label');
      const detail = el('pre', 'ob-detail');
      detailWrap.append(detailLabel, detail);
      const main = el('div', 'ob-main');
      main.append(text, detailWrap);
      const actions = el('div', 'ob-actions');
      root.replaceChildren(main, actions);

      let shown = null; // buttons keyed by id (rebuilt only when the set of ids changes, so focus stays)
      let descs = new Map();

      function button(d) {
        const b = el('button', `btn ob-btn${d.primary ? ' ob-primary' : ''}${d.danger ? ' ob-danger' : ''}`, d.label);
        b.type = 'button';
        b.dataset.action = d.id;
        b.addEventListener('click', () => {
          const cur = descs.get(d.id);
          if (!cur || cur.disabled) return;
          A.runFlow(cur, store);
        });
        return b;
      }

      function render(state) {
        const m = viewModel(state);
        root.hidden = !m;
        root.dataset.kind = m ? m.kind : '';
        if (!m) {
          descs = new Map();
          return;
        }
        if (titleEl.textContent !== m.title) titleEl.textContent = m.title;
        const lineText = m.lines.join(' · ');
        if (lines.textContent !== lineText) lines.textContent = lineText;
        detailWrap.hidden = !m.detail;
        detailLabel.textContent = m.detail ? (m.detailLabel || '') : '';
        detail.textContent = m.detail || '';

        const ids = m.buttons.map((d) => d.id).join('|');
        if (shown === null || shown.ids !== ids) {
          const els = new Map(m.buttons.map((d) => [d.id, button(d)]));
          actions.replaceChildren(...els.values());
          shown = { ids, els };
        }
        descs = new Map(m.buttons.map((d) => [d.id, d]));
        for (const d of m.buttons) {
          const b = shown.els.get(d.id);
          if (b.textContent !== d.label) b.textContent = d.label;
          if (d.disabled) b.setAttribute('aria-disabled', 'true');
          else b.removeAttribute('aria-disabled');
          b.title = d.title || '';
        }
      }

      render(store.state);
      const off = store.subscribe(['repo', 'status', 'refsBySha', 'busy', 'worktrees'], render);
      return () => {
        off();
        root.replaceChildren();
        root.hidden = true;
        root.classList.remove('op-banner');
      };
    },
  });

})();
