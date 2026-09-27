'use strict';
// PLFlows.merge (R2, docs/plans/rebase.md §8): "Merge <target> into <current>" from the menus (plain
// script; loads after flows-op.js and adds its flow to window.PLFlows). Contract: flows-kit.js.
// All git-derived text reaches the DOM through the dialogs / toasts (textContent only).
(function () {
  const K = window.PLFlowKit;
  const { settle, report, dialog, dn, currentBranch } = K;
  const FF_MODES = ['ff', 'no-ff', 'ff-only'];

  /**
   * merge(store, {target, ff?, expectHead?}): "Merge <target> into <current>". target: a full refname
   * or sha; ff: 'ff' (default: fast-forward when possible) | 'no-ff' | 'ff-only'. When a fast-forward
   * is possible (and no ff was given) the confirm offers Fast-forward or Create Merge Commit.
   */
  async function mergeFlow(store, o) {
    const target = o && o.target;
    if (typeof target !== 'string' || !target) return false;
    const head = await K.startGuard(store, o, 'merge');
    if (!head) return false;
    const into = currentBranch(store) ? dn(currentBranch(store)) : 'HEAD';
    const t = K.targetInfo(store, target);
    const mine = K.ancestors(store, head);
    if (t.oid && (t.oid === head || (mine && mine.has(t.oid)))) {
      store.actions.notify(`${into} already contains ${t.name}`);
      return false;
    }
    const theirs = K.ancestors(store, t.oid);
    const ff = await chooseFF(store, o, { canFF: !!(theirs && theirs.has(head)), name: t.name, into });
    if (!ff) return false;
    const { value, error } = await settle(store.actions.write('merge', [target, { ff, expectHead: head }], { quiet: K.START_QUIET }));
    // An error can carry the finished merge (its result and kept stash): report both.
    const res = error ? K.finishedOf(error) : value;
    if (!res) return K.startError(store, error, 'merge');
    if (error) report(store, error);
    if (res && res.status === 'stopped') {
      if (res.stop === 'hook') {
        // No conflicts, but a hook refused the merge commit: the merge stays in progress (banner).
        await dialog(store).alert({
          title: 'A hook refused the merge commit',
          message: `The merge of ${t.name} is in progress, but a commit hook refused its commit. Fix the problem, then Commit and Merge in the banner, or abort the merge.`,
          detail: String(res.hookOutput || '').trim() || '(the hook printed nothing)',
        });
      } else store.actions.notify(K.mergeStoppedNotice(res, store));
      store.actions.select({ kind: 'wip' });
      return true;
    }
    if (res && res.status === 'up-to-date') {
      store.actions.notify(`${into} is already up to date with ${t.name}`);
      return true;
    }
    await K.reportOutcome(store, res, { done: 'Merged', notice: res && res.fastForward ? `Fast-forwarded ${into} to ${t.name}` : `Merged ${t.name} into ${into}` });
    return true;
  }

  /** The ff mode after the confirm: the given one, or the user's choice when a fast-forward is possible; null: cancelled. */
  async function chooseFF(store, o, { canFF, name, into }) {
    const given = FF_MODES.includes(o.ff) ? o.ff : null;
    const stashLine = store.isDirty() ? '\n\nYour local changes are stashed first and re-applied after the merge.' : '';
    if (!given && canFF) {
      return dialog(store).choose({
        title: `Merge ${name} into ${into}?`,
        message: `${into} has no commits of its own since ${name}, so it can simply be fast-forwarded to ${name}. Or create a merge commit to record the merge.${stashLine}`,
        choices: [{ value: 'no-ff', label: 'Create Merge Commit' }, { value: 'ff', label: 'Fast-forward', primary: true }],
      });
    }
    const ok = await dialog(store).confirm({
      title: `Merge ${name} into ${into}?`,
      message: `The changes of ${name} are merged into ${into}${given === 'no-ff' ? ' with a merge commit' : ''}. If they conflict, the merge stops so you can resolve the files, then Commit and Merge (or abort).${stashLine}`,
      confirmLabel: 'Merge',
    });
    return ok ? given || 'ff' : null;
  }

  K.register({ merge: mergeFlow });
})();
