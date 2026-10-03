'use strict';
// PLFlows for the LINKED worktrees of the sidebar's Worktrees section (plain script; loads after
// flows-worktree.js, which is about the WORKING TREE of the open repository, and adds its flows to
// window.PLFlows). Contract: flows-kit.js.
//   removeWorktree(store, path)   confirm, delete the folder; a dirty one asks again before a force delete
//   pruneWorktrees(store)         previews what git would prune, confirms, prunes
//   lockWorktree(store, path)     asks for an optional reason (one line, 200 characters at most)
//   unlockWorktree(store, path)
//   revealWorktree(store, path)   show the folder in the file manager (main checks the path)    [free]
//   copyWorktreePath(store, path) copy the path to the clipboard                                [free]
// Every path-taking flow re-reads the worktrees first (a stale row is an alert, not a write) and
// applies PLMenus.worktreeRefusal; main re-checks everything. Opening one is openWorktree (flows-kit.js).
// All git-derived text reaches the DOM through the dialogs / toasts (textContent only).
(function () {
  const K = window.PLFlowKit;
  const { C, settle, report, dialog, dn, short } = K;
  const LOCK_REASON_MAX = 200;

  const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');

  /** The entry of the freshly read worktree list whose path is exactly `path`, or null. */
  async function fresh(store, path) {
    const { value } = await settle(store.invoke('worktrees'));
    return (Array.isArray(value) ? value : []).find((w) => w && w.path === path) || null;
  }

  /**
   * The fresh entry for `path`, or null after an alert: not found, or refused for `action`
   * (`verb` completes "Can't <verb> this worktree").
   */
  async function checked(store, path, action, verb) {
    if (typeof path !== 'string' || !path) return null;
    const w = await fresh(store, path);
    if (!w) {
      await dialog(store).alert({ title: 'Worktree not found', message: 'It was removed or moved meanwhile.' });
      return null;
    }
    const refused = C.actions.worktreeRefusal(w, action, store.state);
    if (refused) {
      await dialog(store).alert({ title: `Can't ${verb} this worktree`, message: refused.title });
      return null;
    }
    return w;
  }

  async function removeWorktreeFlow(store, path) {
    const w = await checked(store, path, 'delete', 'delete');
    if (!w) return false;
    const ok = await dialog(store).confirm({
      title: 'Delete worktree?',
      message: `Delete the worktree at ${dn(path)}? Its folder is removed from disk.`
        + (w.branch ? ` The branch ${dn(w.branch)} is kept.` : ` Its HEAD is detached at ${short(w.head)}: commits that no branch or tag points at can be lost.`)
        + '\n\nIf another tab has it open, that tab shows it as deleted.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return false;
    const first = await settle(store.actions.write('removeWorktree', [path, {}], { quiet: ['worktree-dirty'] }));
    if (first.error) {
      const e = first.error;
      if (e.kind !== 'worktree-dirty') { report(store, e); return false; }
      const force = await dialog(store).confirm({
        title: 'Worktree has changes',
        message: `${dn(path)} has modified or untracked files${e.submodules ? ' or submodules' : ''}. Delete it anyway? Those changes are lost; this can't be undone.`,
        confirmLabel: 'Force Delete',
        danger: true,
      });
      if (!force) return false;
      await store.actions.write('removeWorktree', [path, { force: true }]);
    }
    store.actions.notify(`Deleted worktree ${dn(baseName(path))}`);
    return true;
  }

  async function pruneWorktreesFlow(store) {
    const { value: preview, error } = await settle(store.invoke('worktreePrunePreview'));
    if (error) { report(store, error); return false; }
    const entries = (preview && preview.entries) || [];
    if (!entries.length) {
      store.actions.notify('Nothing to prune');
      return false;
    }
    const n = entries.length;
    const ok = await dialog(store).confirm({
      title: 'Prune worktrees?',
      message: `Remove git's records of ${C.util.plural(n, 'worktree')} whose folder is gone? Their branches are kept. Locked worktrees are skipped.`,
      detail: dialog(store).pathListText(entries.map((e) => `${e.id}: ${e.reason}`), n),
      confirmLabel: 'Prune',
    });
    if (!ok) return false;
    await store.actions.write('pruneWorktrees', []);
    store.actions.notify(`Pruned ${C.util.plural(n, 'worktree')}`);
    return true;
  }

  async function lockWorktreeFlow(store, path) {
    const w = await checked(store, path, 'lock', 'lock');
    if (!w) return false;
    const reason = await dialog(store).prompt({
      title: 'Lock worktree',
      message: `Lock ${dn(path)}? Git won't prune, move or delete a locked worktree until it is unlocked (useful when its folder is on a removable or network drive).`,
      label: 'Reason (optional)',
      okLabel: 'Lock',
      validate: (v) => {
        if (/[\r\n]/.test(v)) return 'The reason must be one line';
        return v.trim().length > LOCK_REASON_MAX ? `At most ${LOCK_REASON_MAX} characters` : null;
      },
    });
    if (reason === null) return false;
    const r = reason.trim();
    await store.actions.write('lockWorktree', [path, r ? { reason: r } : {}]);
    store.actions.notify(`Locked worktree ${dn(baseName(path))}`);
    return true;
  }

  async function unlockWorktreeFlow(store, path) {
    const w = await checked(store, path, 'unlock', 'unlock');
    if (!w) return false;
    await store.actions.write('unlockWorktree', [path]);
    store.actions.notify(`Unlocked worktree ${dn(baseName(path))}`);
    return true;
  }

  async function revealWorktreeFlow(store, path) {
    if (typeof path !== 'string' || !path) return false;
    const api = window.api;
    if (!api || !api.app || typeof api.app.revealWorktree !== 'function') throw new Error('Showing a worktree in the file manager is not available');
    try {
      await api.app.revealWorktree(path);
    } catch (e) {
      throw C.util.toError(e);
    }
    return true;
  }

  async function copyWorktreePathFlow(store, path) {
    if (typeof path !== 'string' || !path) return false;
    const api = window.api && window.api.clipboard;
    if (!api || typeof api.writeText !== 'function') throw new Error('The clipboard is not available');
    try {
      await api.writeText(path);
    } catch (e) {
      throw C.util.toError(e);
    }
    store.actions.notify(`Copied ${dn(path)}`);
    return true;
  }

  K.register({
    removeWorktree: removeWorktreeFlow,
    pruneWorktrees: pruneWorktreesFlow,
    lockWorktree: lockWorktreeFlow,
    unlockWorktree: unlockWorktreeFlow,
    revealWorktree: revealWorktreeFlow,
    copyWorktreePath: copyWorktreePathFlow,
  });
})();
