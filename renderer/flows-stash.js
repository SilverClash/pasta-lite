'use strict';
// PLFlows for stashes (plain script; loads after flows-branch.js and adds its flows to window.PLFlows).
// Contract: flows-kit.js.
//   stashSave(store), stashPop(store, entry?), stashApply(store, entry?), stashDrop(store, entry?)
//                               entry: stash hash, stash index or a state.stashes item; default the newest
// All git-derived text reaches the DOM through the dialogs / toasts (textContent only).
(function () {
  const K = window.PLFlowKit;
  const { settle, report, dialog, dn, short, currentBranch } = K;

  // ---------------------------------------------------------------- stash

  /** {ref, entry} for a stash argument (hash, index, a stashes item, or null = newest), or null. */
  function stashTarget(store, entry) {
    const list = store.state.stashes || [];
    if (entry == null) return list[0] ? { ref: list[0].hash, entry: list[0] } : null;
    if (typeof entry === 'object') {
      if (typeof entry.hash === 'string' && entry.hash) return { ref: entry.hash, entry };
      if (Number.isInteger(entry.index)) entry = entry.index;
      else return null;
    }
    if (typeof entry === 'string') return { ref: entry, entry: list.find((s) => s.hash === entry) || null };
    if (Number.isInteger(entry) && entry >= 0) {
      const found = list.find((s) => s.index === entry);
      return { ref: found ? found.hash : entry, entry: found || null };
    }
    return null;
  }

  const stashLabel = (t) => {
    if (t.entry) return t.entry.message ? `${t.entry.ref}: ${t.entry.message}` : `${t.entry.ref}`;
    return typeof t.ref === 'number' ? `stash@{${t.ref}}` : short(t.ref);
  };

  async function stashSaveFlow(store) {
    if (!store.isDirty()) {
      store.actions.notify('There are no local changes to stash');
      return false;
    }
    const message = await dialog(store).prompt({
      title: 'Stash changes',
      message: 'Stash all local changes, including untracked files.',
      label: 'Message (optional)',
      placeholder: `WIP on ${currentBranch(store) || 'HEAD'}`,
      okLabel: 'Stash',
    });
    if (message === null) return false;
    const res = await store.actions.write('stashPush', message.trim() ? [message.trim()] : []);
    if (!res) {
      store.actions.notify('Nothing was stashed');
      return false;
    }
    store.actions.notify('Stashed your local changes');
    return true;
  }

  function stashApplyFlow(pop) {
    return async (store, entry) => {
      const t = stashTarget(store, entry);
      if (!t) {
        store.actions.notify('There are no stashes');
        return false;
      }
      const op = pop ? 'stashPop' : 'stashApply';
      const { value: res, error } = await settle(store.actions.write(op, [t.ref], { quiet: ['conflicts'] }));
      if (error) {
        if (error.kind !== 'conflicts') { report(store, error); return false; }
        await dialog(store).alert({
          title: 'Stash applied with conflicts',
          message: `${dn(stashLabel(t))} conflicted with your files. Resolve the conflicts in the WIP panel and mark them resolved.${pop ? ' The stash was kept, so drop it once you are done.' : ''}`,
          detail: error.message,
        });
        return false;
      }
      if (res && res.indexRestored === false) store.actions.notify(`${pop ? 'Popped' : 'Applied'} ${dn(stashLabel(t))}; its staged changes could not be restored, so all changes are unstaged`);
      else store.actions.notify(`${pop ? 'Popped' : 'Applied'} ${dn(stashLabel(t))}`);
      return true;
    };
  }

  async function stashDropFlow(store, entry) {
    const t = stashTarget(store, entry);
    if (!t) {
      store.actions.notify('There are no stashes');
      return false;
    }
    const ok = await dialog(store).confirm({
      title: 'Drop stash?',
      message: `Delete ${dn(stashLabel(t))}? Dropping a stash can't be undone.`,
      confirmLabel: 'Drop',
      danger: true,
    });
    if (!ok) return false;
    // stashDrop resolves false (or fails with kind 'no-stash') when the entry is already gone.
    const { value: dropped, error } = await settle(store.actions.write('stashDrop', [t.ref], { quiet: ['no-stash'] }));
    if (error && error.kind !== 'no-stash') { report(store, error); return false; }
    if (error || dropped === false) {
      store.actions.notify(`${dn(stashLabel(t))} was already gone`);
      return false;
    }
    store.actions.notify(`Dropped ${dn(stashLabel(t))}`);
    return true;
  }


  K.register({
    stashSave: stashSaveFlow,
    stashPop: stashApplyFlow(true),
    stashApply: stashApplyFlow(false),
    stashDrop: stashDropFlow,
  });
})();
