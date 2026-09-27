'use strict';
// PLFlows for talking to remotes (plain script; loads after flows-kit.js and adds its flows to
// window.PLFlows). Contract: flows-kit.js.
//   fetch(store, {remote}?)     default: every remote
//   pull(store, mode?)          mode: 'fetch' | 'ff-if-possible' | 'ff-only' | 'rebase'; default pullMode(store);
//                               kept stashes and partial restores are explained by reportOutcome / keptStashText
//   pullMode(store) -> string   the per-repo default (sync; initially 'ff-if-possible'; always 'fetch' in a bare
//                               repository: PLPolicy.effectivePullMode)
//   setPullMode(store, mode) -> boolean   stores it (and state.pullMode); false for an unknown mode
//   PULL_MODES                  PLPolicy's
//   push(store, {branch?}?)     default: the current branch; asks to set an upstream when it has none
//   setUpstream(store, branch)  asks for the remote branch to track
// Kit additions: forcePush (flows-op.js offers it after a rebase).
// All git-derived text reaches the DOM through the dialogs / toasts (textContent only).
(function () {
  const K = window.PLFlowKit;
  const { C, settle, report, dialog, dn, short, status, currentBranch, upstreamOf, keptStashTitle, keptStashText, stashNote, reportOutcome, authAlert, tagConflictsAlert } = K;
  const P = window.PLPolicy;
  const { PULL_MODES, DEFAULT_PULL_MODE } = P;
  const PULL_MODE_KEY = (root) => `pl.pullMode.${C.util.repoKey(root)}`;
  const DETACHED_PULL = 'HEAD is detached. Check out a branch to pull into it.';
  const DETACHED_PUSH = 'HEAD is detached. Create or check out a branch to push.';

  async function fetchInner(store, o) {
    const remote = o && typeof o.remote === 'string' && o.remote ? o.remote : null;
    try {
      const res = await store.actions.write('fetch', [remote ? { remote } : {}], { quiet: ['aborted', 'auth'], cancellable: true });
      await tagConflictsAlert(store, res);
      return true;
    } catch (e) {
      if (e.kind === 'aborted') store.actions.notify('Fetch cancelled');
      else if (e.kind === 'auth') await authAlert(store, e);
      else report(store, e);
      return false;
    }
  }

  function pullMode(store) {
    const root = store && store.state && store.state.repo && store.state.repo.root;
    if (!root) return DEFAULT_PULL_MODE;
    return P.effectivePullMode(store.state, C.util.storage.get(PULL_MODE_KEY(root), DEFAULT_PULL_MODE));
  }

  function setPullMode(store, mode) {
    if (!PULL_MODES.includes(mode)) return false;
    const root = store && store.state && store.state.repo && store.state.repo.root;
    if (!root) return false;
    C.util.storage.set(PULL_MODE_KEY(root), mode);
    store.actions.setPullMode(mode);
    return true;
  }

  /** The notice of a finished pull (`branch`, `up`: display-safe names). */
  function pullNotice(res, mode, branch, up) {
    if (res.before === res.after) return `${branch} is already up to date with ${up}`;
    if (res.fastForward) return `Fast-forwarded ${branch} to ${up}`;
    return mode === 'rebase' ? `Rebased ${branch} onto ${up}` : `Merged ${up} into ${branch}`;
  }

  const PULL_QUIET = ['aborted', 'auth', 'no-upstream', 'detached', 'conflicts', 'not-fast-forward', 'stash-conflict'];

  async function pullInner(store, mode) {
    const branch = currentBranch(store);
    if (mode !== 'fetch' && !branch) {
      await dialog(store).alert({ title: 'Cannot pull', message: DETACHED_PULL });
      return false;
    }
    const { value: res, error } = await settle(store.actions.write('pull', [{ mode }], { quiet: PULL_QUIET, cancellable: true }));
    if (error) {
      await pullError(store, error, branch, mode);
      return false;
    }
    await tagConflictsAlert(store, res);
    const st = status(store);
    const up = (st && st.upstream) || 'its upstream';
    if (res && res.status === 'stopped') {
      // A Pull (rebase) that stopped: continued from the banner (docs/plans/rebase.md §3.8.5).
      await pullStoppedAlert(store, branch, res.state || null, null);
      return false;
    }
    if (mode !== 'fetch' && res) {
      const notice = pullNotice(res, mode, dn(branch), dn(up));
      await reportOutcome(store, res, { done: 'Pulled', notice, banner: mode === 'rebase', left: 'as pulled' });
    }
    return true;
  }

  async function pullError(store, e, branch, mode) {
    const a = dialog(store).alert;
    // Pull (rebase) stashes with our recorded autostash (the banner's Restore); the other modes with a plain stash.
    const banner = mode === 'rebase';
    switch (e.kind) {
      case 'aborted':
        store.actions.notify('Pull cancelled');
        return;
      case 'auth':
        await authAlert(store, e);
        return;
      case 'no-upstream':
        await a({
          title: 'No upstream branch',
          message: `${dn(branch)} doesn't track a remote branch yet, so there is nothing to pull. Push it first to set its upstream.`,
        });
        return;
      case 'detached':
        await a({ title: 'Cannot pull', message: DETACHED_PULL });
        return;
      case 'conflicts':
        if (mode === 'rebase') {
          await pullStoppedAlert(store, branch, e.rebase || null, e);
          return;
        }
        await a({
          title: 'Merge conflicts',
          message: `Pulling into ${dn(branch)} stopped with conflicts. Resolve them in the WIP panel, mark the files resolved, then click Commit and Merge in the banner.${stashNote(e, { banner })}`,
          detail: e.message,
        });
        store.actions.select({ kind: 'wip' });
        return;
      case 'not-fast-forward':
        await a({
          title: 'Cannot fast-forward',
          message: `${dn(branch)} and its upstream have diverged, so a fast-forward-only pull isn't possible. Pull with "Fast-forward if possible" (merge) or "Rebase" instead.${stashNote(e, { banner })}`,
        });
        return;
      case 'stash-conflict':
        await a({
          title: keptStashTitle('Pulled', e.reason),
          message: `The pull succeeded. ${keptStashText({ sha: e.stash, reason: e.reason, resetFailed: e.resetFailed, banner, left: 'as pulled' })}`,
          detail: e.resetFailed && e.resetError ? `The working tree could not be reset: ${e.resetError}` : '',
        });
        return;
      default:
        if (e.stashKept) {
          await a({ title: 'Pull failed', message: `${e.message}${stashNote(e, { banner })}` });
          return;
        }
        report(store, e);
    }
  }

  async function pullStoppedAlert(store, branch, rb, e) {
    const stashed = (rb && rb.autostash) || (e && e.stash) || null;
    await dialog(store).alert({
      title: 'Rebase stopped with conflicts',
      message: `Pulling into ${dn(branch)} stopped with conflicts. Resolve them in the WIP panel, then click Continue Rebase in the banner.`
        + `${stashed ? `\n\nYour local changes are safe in a stash (${short(stashed)}) and come back when the rebase finishes or is aborted.` : ''}`,
      detail: e ? e.message : '',
    });
    store.actions.select({ kind: 'wip' });
  }

  // ---------------------------------------------------------------- remotes / upstream

  /**
   * The remote to push a new branch to: the only one, else 'origin', else the user's choice
   * (null when cancelled or there is none). Re-reads the remote list first; when that fails and
   * no earlier list is known, says so (instead of "no remotes").
   */
  async function pickRemote(store, { title = 'Choose a remote', message } = {}) {
    const list = await store.actions.loadRemotes();
    const remotes = Array.isArray(list) ? list : [];
    if (!remotes.length) {
      const failed = store.state.remotesError;
      await dialog(store).alert(failed
        ? { title: "Couldn't read remotes", message: `Couldn't read remotes: ${failed}` }
        : { title: 'No remotes', message: 'This repository has no remotes. Add one from a terminal (git remote add origin <url>).' });
      return null;
    }
    if (remotes.length === 1) return remotes[0];
    if (remotes.includes('origin')) return 'origin';
    return dialog(store).choose({
      title,
      message: message || 'Which remote should be used?',
      choices: remotes.map((r, i) => ({ value: r, label: dn(r), primary: i === 0 })),
    });
  }


  async function setUpstreamFlow(store, branch) {
    if (typeof branch !== 'string' || !branch) return false;
    const remote = await pickRemote(store, { message: `Which remote should ${dn(branch)} track?` });
    if (!remote) return false;
    const remoteBranch = await dialog(store).prompt({
      title: 'Set upstream',
      message: `Track a branch on ${dn(remote)} with ${dn(branch)}.`,
      label: `Remote branch on ${dn(remote)}`,
      value: branch,
      okLabel: 'Set Upstream',
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'Enter a branch name';
        return K.syntaxError(t); // flows-branch.js (loaded by the time a dialog runs)
      },
    });
    if (remoteBranch === null) return false;
    await store.actions.write('setUpstream', [branch, remote, remoteBranch.trim()]);
    store.actions.notify(`${dn(branch)} now tracks ${dn(`${remote}/${remoteBranch.trim()}`)}`);
    return true;
  }

  // ---------------------------------------------------------------- push

  const PUSH_QUIET = ['aborted', 'auth', 'rejected-behind', 'rejected-stale', 'rejected-hook', 'no-upstream', 'detached'];

  async function pushFlow(store, o) {
    const branch = (o && typeof o.branch === 'string' && o.branch) || currentBranch(store);
    if (!branch) {
      await dialog(store).alert({ title: 'Cannot push', message: DETACHED_PUSH });
      return false;
    }
    if (!upstreamOf(store, branch)) return pushNew(store, branch);
    const res = await pushOnce(store, { branch }, { retry: true, target: upstreamOf(store, branch) });
    if (res === NO_UPSTREAM) return pushNew(store, branch);
    return !!res;
  }

  const NO_UPSTREAM = Symbol('no-upstream');

  /** Push a branch without an upstream to a remote branch of the same name, then track it. */
  async function pushNew(store, branch) {
    const remote = await pickRemote(store, { message: `Which remote should ${dn(branch)} be pushed to?` });
    if (!remote) return false;
    const target = `${remote}/${branch}`;
    const ok = await dialog(store).confirm({
      title: 'Push and set upstream?',
      message: `${dn(branch)} has no upstream. Push and set upstream to ${dn(target)}?`,
      confirmLabel: 'Push',
    });
    if (!ok) return false;
    const res = await pushOnce(store, { remote, branch }, { retry: true, target });
    if (!res || res === NO_UPSTREAM) return false;
    try {
      await store.actions.write('setUpstream', [branch, remote, res.remoteBranch || branch]);
    } catch {
      // toasted by write; the push itself went through
    }
    return true;
  }

  /**
   * One push, with the follow-ups for a rejection. Resolves with push's result, NO_UPSTREAM (the
   * branch turned out to have no upstream) or null (failed / cancelled; already shown).
   */
  async function pushOnce(store, args, { retry, target }) {
    const { value: res, error } = await settle(store.actions.write('push', [args], { quiet: PUSH_QUIET, cancellable: true }));
    if (error) return pushError(store, error, args, { retry, target });
    const where = res && res.remote && res.remoteBranch ? `${res.remote}/${res.remoteBranch}` : target;
    store.actions.notify(`${res && res.forced ? 'Force pushed' : 'Pushed'} ${dn(args.branch)} to ${dn(where)}`);
    return res || {};
  }

  async function pushError(store, e, args, { retry, target }) {
    const { branch } = args;
    const a = dialog(store).alert;
    if (e.kind === 'aborted') { store.actions.notify('Push cancelled'); return null; }
    if (e.kind === 'auth') { await authAlert(store, e); return null; }
    if (e.kind === 'no-upstream') return NO_UPSTREAM;
    if (e.kind === 'detached') {
      await a({ title: 'Cannot push', message: DETACHED_PUSH });
      return null;
    }
    if (e.kind === 'rejected-hook') {
      await a({
        title: 'Push rejected by the remote',
        message: `The remote refused ${dn(branch)}${target ? ` (${dn(target)})` : ''}. Its message:`,
        detail: e.remoteMessage || e.reason || e.message,
      });
      return null;
    }
    if (e.kind === 'rejected-behind' && retry) {
      const canPull = branch === currentBranch(store);
      const choice = await dialog(store).choose({
        title: 'Push rejected',
        message: `${dn(target || 'The remote branch')} has commits that ${dn(branch)} doesn't have.`
          + `${canPull ? ' Pull them first, or force push to replace the remote branch with yours.' : ' Check out the branch and pull first, or force push to replace the remote branch with yours.'}`,
        choices: [
          { value: 'force', label: 'Force Push…', danger: true },
          ...(canPull ? [{ value: 'pull', label: 'Pull & Push', primary: true }] : []),
        ],
      });
      if (choice === 'pull') {
        if (!(await pullInner(store, 'ff-if-possible'))) return null;
        return pushOnce(store, args, { retry: false, target });
      }
      if (choice === 'force') return forcePush(store, args, target);
      return null;
    }
    if (e.kind === 'rejected-stale' && retry) {
      // "fetch first": the remote has commits this repo has never seen; "stale info": the lease
      // failed, the remote moved since the last fetch. Either way only Fetch is offered: a force
      // push would replace commits nobody has looked at yet.
      const why = e.reason === 'fetch first'
        ? "has commits you haven't fetched yet, so the push was refused"
        : 'changed since you last fetched, so the force push was refused';
      const choice = await dialog(store).choose({
        title: 'Push rejected',
        message: `${dn(target || 'The remote branch')} ${why}. Fetch, review the new commits, then push again.`,
        choices: [{ value: 'fetch', label: 'Fetch', primary: true }],
      });
      if (choice === 'fetch') await fetchInner(store);
      return null;
    }
    report(store, e);
    return null;
  }

  async function forcePush(store, args, target) {
    const ok = await dialog(store).confirm({
      title: 'Force push?',
      message: `Replace ${dn(target || 'the remote branch')} with your ${dn(args.branch)}? Commits that are only on the remote will be removed from it.\n\n`
        + 'This is a force push "with lease": it is refused if the remote branch moved since your last fetch.',
      confirmLabel: 'Force Push',
      danger: true,
    });
    if (!ok) return null;
    return pushOnce(store, { ...args, force: 'lease' }, { retry: true, target });
  }

  K.forcePush = forcePush;
  Object.assign(window.PLFlows, { pullMode, setPullMode, PULL_MODES });
  K.register({
    fetch: fetchInner,
    pull: (store, mode) => pullInner(store, PULL_MODES.includes(mode) ? mode : pullMode(store)),
    push: pushFlow,
    setUpstream: setUpstreamFlow,
  });
})();
