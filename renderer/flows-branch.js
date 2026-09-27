'use strict';
// PLFlows for branches (plain script; loads after flows-sync.js and adds its flows to window.PLFlows).
// Contract: flows-kit.js.
//   checkout(store, {target, kind})   kind 'local' (name) | 'remote' ('origin/x') | 'commit' (full sha)
//   createBranch(store, {start?, checkout = true}?)   never checks out in a bare repository
//   deleteBranch(store, name)
//   branchNameError(name, refs) -> string | null   the create-branch validation (pure)
// Kit additions: checkoutInner (flows-rebase.js checks a branch out before rebasing it), syntaxError
// (flows-sync.js' setUpstream validates the remote branch name with it).
// All git-derived text reaches the DOM through the dialogs / toasts (textContent only).
(function () {
  const K = window.PLFlowKit;
  const { settle, report, dialog, dn, short, status, currentBranch, keptStashTitle, keptStashText, stashNote } = K;
  const P = window.PLPolicy;
  const undoKey = () => window.PLKeys.keyHint('undo');

  // ---------------------------------------------------------------- checkout

  /**
   * Explain a failure of a write that auto-stashed local changes (checkout, createBranch with
   * checkout; a plain stash, not the banner's): the changes didn't come back on the new HEAD
   * (kind 'stash-conflict', with its reason), or the op failed with the stash kept. `done`: what did
   * happen ('Checked out'). Resolves false when `e` is neither (the caller reports it).
   */
  async function autostashError(store, e, { where, done, failTitle }) {
    if (e.kind === 'stash-conflict') {
      await dialog(store).alert({
        title: keptStashTitle(done, e.reason),
        message: `Switched to ${where}. ${keptStashText({ sha: e.stash, reason: e.reason, resetFailed: e.resetFailed })}`,
        detail: e.resetFailed && e.resetError ? `The working tree could not be reset: ${e.resetError}` : '',
      });
      return true;
    }
    if (e.stashKept) {
      await dialog(store).alert({ title: failTitle, message: `${e.message}${stashNote(e)}` });
      return true;
    }
    return false;
  }

  async function checkoutInner(store, target, kind) {
    try {
      await store.actions.write('checkout', [target, { kind }], { quiet: ['local-exists', 'stash-conflict'] });
      return true;
    } catch (e) {
      if (e.kind === 'local-exists' && kind === 'remote' && e.branch) {
        const ok = await dialog(store).confirm({
          title: 'Branch already exists',
          message: `A local branch ${dn(e.branch)} already exists and doesn't track ${dn(target)}. Check out the local branch instead?`,
          confirmLabel: 'Check Out Local Branch',
        });
        return ok ? checkoutInner(store, e.branch, 'local') : false;
      }
      const explained = await autostashError(store, e, {
        where: dn(kind === 'commit' ? short(target) : target),
        done: 'Checked out',
        failTitle: 'Checkout failed',
      });
      if (!explained) report(store, e);
      return false;
    }
  }

  async function checkoutFlow(store, o) {
    const { target, kind = 'local' } = o || {};
    if (typeof target !== 'string' || !target) return false;
    if (kind === 'local' && target === currentBranch(store)) return false; // already there
    if (kind === 'commit') {
      const ok = await dialog(store).confirm({
        title: 'Check out commit?',
        message: `Check out ${short(target)} as a detached HEAD? New commits made there won't belong to any branch unless you create one.`,
        confirmLabel: 'Check Out',
      });
      if (!ok) return false;
    }
    return checkoutInner(store, target, kind);
  }

  // ---------------------------------------------------------------- branches

  /** git check-ref-format rules a name can break on its own (the backend re-checks with git). */
  function syntaxError(name) {
    if (/\s/.test(name)) return 'Branch names cannot contain spaces';
    if (name.startsWith('-')) return "Branch names cannot start with '-'";
    if (/[\u0000-\u001f\u007f~^:?*[\\]/.test(name)) return 'Branch names cannot contain ~ ^ : ? * [ \\ or control characters';
    if (name.includes('..') || name.includes('@{') || name === '@' || name === 'HEAD') return `'${name}' is not a valid branch name`;
    if (name.startsWith('/') || name.endsWith('/') || name.includes('//') || name.endsWith('.')) return 'Branch names cannot start or end with / or end with .';
    if (name.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'))) return "Path components cannot start with '.' or end with '.lock'";
    return null;
  }

  /** Error text for a new branch name (trimmed by the caller), or null when it's fine. */
  function branchNameError(name, refs) {
    if (typeof name !== 'string' || !name) return 'Enter a branch name';
    const bad = syntaxError(name);
    if (bad) return bad;
    const local = (refs && refs.local) || [];
    if (local.some((b) => b.name === name)) return `A branch named '${name}' already exists`;
    // git can't store both 'a' and 'a/b' (a ref is a file, a folder holds the refs under it).
    const clash = local.find((b) => b.name.startsWith(`${name}/`) || name.startsWith(`${b.name}/`));
    if (clash) return `'${name}' conflicts with the existing branch '${clash.name}'`;
    return null;
  }

  async function createBranchFlow(store, o) {
    const { start } = o || {};
    // A bare repository has no working tree to check the new branch out into.
    const checkout = !P.isBare(store.state) && (!o || o.checkout === undefined || !!o.checkout);
    const at = start ? short(start) : (currentBranch(store) || short(status(store) && status(store).oid) || 'HEAD');
    const name = await dialog(store).prompt({
      title: 'Create branch',
      message: `The new branch starts at ${dn(at)}${checkout ? ' and is checked out' : ''}.`,
      label: 'Branch name',
      placeholder: 'feature/my-change',
      okLabel: checkout ? 'Create & Check Out' : 'Create',
      validate: (v) => branchNameError(v.trim(), store.state.refs),
    });
    if (name === null) return false;
    const branch = name.trim();
    // With checkout, blocking local changes are auto-stashed by the backend (as for checkout).
    const { error } = await settle(store.actions.write('createBranch', [branch, { ...(start ? { start } : {}), checkout: !!checkout }], { quiet: ['stash-conflict'] }));
    if (!error) return true;
    const explained = await autostashError(store, error, {
      where: `the new branch ${dn(branch)}`,
      done: 'Branch created',
      failTitle: 'Create branch failed',
    });
    if (!explained) report(store, error);
    return false;
  }

  async function deleteBranchFlow(store, name) {
    if (typeof name !== 'string' || !name) return false;
    if (name === currentBranch(store)) {
      await dialog(store).alert({ title: 'Cannot delete the current branch', message: `Check out another branch before deleting ${dn(name)}.` });
      return false;
    }
    const ok = await dialog(store).confirm({
      title: 'Delete branch?',
      message: `Delete the local branch ${dn(name)}? The remote branch (if any) is not touched.\n\nYou can undo this with Undo (${undoKey()}).`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return false;
    const first = await settle(store.actions.write('deleteBranch', [name, {}], { quiet: ['not-merged'] }));
    if (first.error) {
      if (first.error.kind !== 'not-merged') { report(store, first.error); return false; }
      const force = await dialog(store).confirm({
        title: 'Branch not fully merged',
        message: `${dn(name)} has commits that aren't merged into its upstream or the current branch. Delete it anyway?\n\nYou can still undo this with Undo (${undoKey()}).`,
        confirmLabel: 'Force Delete',
        danger: true,
      });
      if (!force) return false;
    }
    const res = first.error ? await store.actions.write('deleteBranch', [name, { force: true }]) : first.value;
    if (res && res.warning) await dialog(store).alert({ title: 'Branch deleted', message: res.warning });
    else store.actions.notify(`Deleted branch ${dn(name)}${res && res.sha ? ` (was ${short(res.sha)})` : ''}`);
    return true;
  }

  Object.assign(K, { checkoutInner, syntaxError });
  window.PLFlows.branchNameError = branchNameError;
  K.register({
    checkout: checkoutFlow,
    createBranch: createBranchFlow,
    deleteBranch: deleteBranchFlow,
  });
})();
