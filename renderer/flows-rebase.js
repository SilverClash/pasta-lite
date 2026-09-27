'use strict';
// PLFlows for starting a rebase (plain script; loads after flows-op.js and adds its flows to
// window.PLFlows). Contract: flows-kit.js.
//   R2  rebase: "Rebase <cur> onto <x>"; with `branch`, "Rebase <b> onto <cur>…" (for R4 drops: no menu
//       offers it, §5.1) — docs/plans/rebase.md §3.7 (checkout first), §4.2 (rebase / rebasePlan),
//       §5.7 (the published warning, the force-push follow-up)
//   R3  interactiveRebase / startInteractiveRebase / reloadInteractiveRebase / cancelInteractiveRebase —
//       §4.2–4.3, §5.6. interactiveRebase reads the plan and opens the editor (store.state.rebaseEditor,
//       components/rebase-editor.js); the editor's Start runs startInteractiveRebase, which confirms and
//       runs the op. The flow lock is not held while the user edits: other flows (fetch, …) keep working,
//       and a HEAD that moves meanwhile makes the plan stale.
// All git-derived text reaches the DOM through the dialogs / toasts (textContent only).
(function () {
  const K = window.PLFlowKit;
  const { C, settle, report, dialog, dn, short, status, currentBranch, localBranches, checkoutInner } = K;
  const Rebase = () => window.PLRebase;

  // ---------------------------------------------------------------- rebase from the menus (R2)

  /**
   * Published commits of `tip`'s own commits over `base` (both shas), from the loaded history:
   * {known, pub: [{sha, remoteRefs}], total}. known: false when a tip or a remote branch isn't loaded
   * (the flow then relies on rebasePlan after the checkout). The remote branches are marked in one
   * walk of the history (window.Store.tipsContaining), however many there are.
   */
  function loadedPublished(store, tip, base) {
    const mine = K.ancestors(store, tip);
    const theirs = base ? K.ancestors(store, base) : null;
    if (!mine || !theirs) return { known: false, pub: [], total: null };
    const own = [...mine].filter((sha) => !theirs.has(sha));
    const remotes = ((store.state.refs && store.state.refs.remote) || []).map((r) => ({ name: r.name, oid: r.oid }));
    const on = window.Store.tipsContaining(store.state.commits, remotes);
    if (!on) return { known: false, pub: [], total: own.length };
    const pub = own.map((sha) => ({ sha, remoteRefs: on(sha) })).filter((p) => p.remoteRefs.length);
    return { known: true, pub, total: own.length };
  }

  /**
   * "Check out b first?" for "Rebase b onto cur…" (§3.7). The published warning is part of it when the
   * loaded history shows b's rewritten commits on a remote (the plan can only be read once b is
   * checked out). Resolves {ok, warned}: warned, the number of published commits it named (0: none).
   */
  async function confirmCheckout(store, branch, t) {
    const pre = loadedPublished(store, branch.oid, t.oid);
    const pubFacts = pre.known && pre.pub.length ? K.publishedFacts(store, pre.pub, branch.name, null) : null;
    const facts = K.needsPublishedConfirm(pubFacts, branch.name) ? pubFacts : null;
    const dirty = store.isDirty() ? '\n\nYour local changes will be stashed and re-applied.' : '';
    const ok = await dialog(store).confirm({
      title: facts ? 'Check out and rewrite pushed commits?' : 'Check out branch?',
      message: `To rebase ${dn(branch.name)} onto ${t.name} it must be checked out first. Check it out now?${dirty}`
        + `${facts ? `\n\n${K.publishedText(store, facts, branch.name, pre.total)}` : ''}`,
      confirmLabel: facts ? 'Check Out and Rebase' : 'Check Out',
      ...(facts ? { defaultCancel: true } : {}),
    });
    return { ok, warned: facts ? facts.count : 0 };
  }

  /** The published check of a rebase onto `onto` (rebasePlan): {plan, facts, error}. */
  async function planFacts(store, onto, who) {
    const { value: plan, error } = await settle(store.invoke('rebasePlan', { upstream: onto }));
    if (error) {
      if (error.kind === 'invalid-args' || error.kind === 'not-found') return { error };
      C.util.log.warn('rebasePlan failed; the published check is skipped', error);
      return { plan: null, facts: K.unknownFacts(store, who) };
    }
    // Nothing is rewritten when onto is already in the branch (up to date): no published commits then.
    const rewritten = plan && plan.isAncestor !== true;
    const pub = rewritten && Array.isArray(plan.published) ? plan.published : [];
    return { plan, facts: K.publishedFacts(store, pub, who, plan) };
  }

  /**
   * rebase(store, {onto, branch?, expectHead?}): "Rebase <branch> onto <onto>". onto: a full refname or
   * sha. branch (a local branch name) other than the current one is checked out first, after a
   * confirm (§3.7); expectHead is then that branch's tip, else HEAD, as the menu saw it. Warns before
   * rewriting commits that are on a remote (warn only), and offers the lease force push after.
   */
  async function rebaseFlow(store, o) {
    const onto = o && o.onto;
    if (typeof onto !== 'string' || !onto) return false;
    const cur = currentBranch(store);
    const other = typeof o.branch === 'string' && o.branch && o.branch !== cur ? o.branch : null;
    const b = other ? localBranches(store).find((x) => x.name === other) || null : null;
    if (other && !b) {
      if (K.needClean(store, 'Rebase')) store.actions.notify(`${dn(other)} no longer exists`);
      return false;
    }
    const head = await K.startGuard(store, o, 'rebase', b ? { expectOf: b.oid } : {});
    if (!head) return false;
    const who = other || cur; // the branch rebased (raw), null: a detached HEAD
    const t = K.targetInfo(store, onto);
    const names = { branch: who ? dn(who) : 'HEAD', onto: t.name };
    const warned = b ? await checkOutFirst(store, b, t) : 0;
    if (warned === false) return false;
    // After a checkout the repo is on b: a stop from here on says so.
    const stopped = (text) => store.actions.notify(b ? `${text}. You're now on ${names.branch}` : text);

    const { plan, facts, error: planError } = await planFacts(store, onto, who);
    if (planError) {
      if (b) await dialog(store).alert({ title: `Checked out ${names.branch}, but the rebase didn't start`, message: String(planError.message || planError) });
      else report(store, planError);
      return false;
    }
    if (plan && plan.isAncestor === true) {
      stopped(`${names.branch} is already up to date with ${names.onto}`);
      return false;
    }
    // Warn unless the checkout confirm already named at least as many published commits.
    if (K.needsPublishedConfirm(facts, who) && (facts.count > warned || (facts.unknown && !warned))) {
      const total = plan && Array.isArray(plan.commits) && !plan.truncated ? plan.commits.length : null;
      if (!(await K.publishedWarning(store, facts, who, total))) {
        if (b) stopped("The rebase didn't start");
        return false;
      }
    }

    // The backend refuses (kind 'stale') when HEAD or the checked-out branch changed meanwhile.
    const expectHead = b ? b.oid : head;
    const { value: res, error } = await settle(store.actions.write('rebase', [onto, { expectHead, expectBranch: who || null }], { quiet: K.START_QUIET, cancellable: true }));
    const done = error ? K.finishedOf(error) : res;
    if (!done) return K.startError(store, error, 'rebase');
    await K.rebaseResult(store, done, names);
    if (error) report(store, error); // it finished, then a later step failed
    await K.offerForcePush(store, done, who);
    return true;
  }

  /** Confirm and check out branch `b` (§3.7): the published count the confirm named (0: none), or false. */
  async function checkOutFirst(store, b, t) {
    const { ok, warned } = await confirmCheckout(store, b, t);
    if (!ok || !(await checkoutInner(store, b.name, 'local'))) return false;
    return warned;
  }

  // ---------------------------------------------------------------- interactive rebase (R3)

  const PLAN_REFUSALS = new Set(['merge-commits', 'root-commit', 'too-many']);
  const IR_QUIET = [...K.START_QUIET, 'invalid-todo', 'nothing', 'empty-message', ...PLAN_REFUSALS];
  const STALE_PLAN = Rebase().STALE_PLAN;

  /** Explain a plan the interactive editor can't take (kind merge-commits / root-commit / too-many; e.plan: the plan). */
  async function planRefusal(store, e, names) {
    const limit = Rebase().limitOf(e.plan);
    let commits = [];
    if (Array.isArray(e.commits)) commits = e.commits;
    else if (e.plan && Array.isArray(e.plan.commits)) commits = e.plan.commits;
    const n = Number.isInteger(e.count) && e.count > 0 ? e.count : commits.filter((c) => c && c.isMerge).length;
    const message = {
      'merge-commits': `The commits between ${names.onto} and ${names.branch} include ${n > 0 ? C.util.plural(n, 'merge commit') : 'merge commits'}. Interactive rebase can't keep merges yet: rebase onto a commit after the last merge, or use a plain rebase.`,
      'root-commit': "The commits to rebase include the repository's first commit (the root), which can't be rebased interactively yet. Pick a later commit to rebase onto.",
      'too-many': `There are more than ${limit} commits between ${names.onto} and ${names.branch}. Interactive rebase is limited to ${limit}: rebase onto a more recent commit.`,
    }[e.kind];
    await dialog(store).alert({ title: "Can't rebase interactively", message });
    return false;
  }

  /**
   * Read rebasePlan({upstream, onto?, interactive: true}) for `args`: {plan}, {empty: true} (no commits
   * in the range: kind 'nothing', or an empty plan) or {refused: true} (already explained). The backend
   * refuses merge-commits / root-commit / too-many itself (err.plan: the plan).
   */
  async function readPlan(store, args, names) {
    const req = { upstream: args.upstream, ...(args.onto ? { onto: args.onto } : {}), interactive: true };
    const { value: plan, error } = await settle(store.invoke('rebasePlan', req));
    if (error) {
      if (error.kind === 'nothing') return { empty: true };
      if (PLAN_REFUSALS.has(error.kind)) await planRefusal(store, error, names);
      else report(store, error);
      return { refused: true };
    }
    if (!plan || !Array.isArray(plan.commits) || !plan.commits.length) return { empty: true };
    return { plan };
  }

  /** "Discard your rebase plan?" when the open editor has changes; true when it may be replaced / closed. */
  async function discardPlan(store) {
    const ed = store.state.rebaseEditor;
    if (!ed) return true;
    if (ed.running) return false;
    if (!Rebase().changed(ed.model)) return true;
    return dialog(store).confirm({
      title: 'Discard your rebase plan?',
      message: 'The actions, messages and order you set are lost.',
      confirmLabel: 'Discard', cancelLabel: 'Keep Editing', defaultCancel: true,
    });
  }

  /**
   * interactiveRebase(store, {upstream, onto?, expectHead?}): "Interactive Rebase <cur> onto <x>" /
   * "Interactive Rebase <n> children of <sha>". upstream / onto: full refnames or shas (the commits
   * upstream..HEAD are edited and replayed onto `onto`, default upstream). Reads the plan and opens the
   * editor; resolves true when it opened.
   */
  async function interactiveRebaseFlow(store, o) {
    const upstream = o && o.upstream;
    if (typeof upstream !== 'string' || !upstream) return false;
    const onto = typeof o.onto === 'string' && o.onto ? o.onto : null;
    if (!(await K.startGuard(store, o, 'rebase', { action: 'Interactive rebase' }))) return false;
    if (!(await discardPlan(store))) return false;
    const cur = currentBranch(store);
    const t = K.targetInfo(store, onto || upstream);
    const names = { branch: cur ? dn(cur) : 'HEAD', onto: t.name };
    const args = { upstream, ...(onto ? { onto } : {}) };
    const { plan, refused, empty } = await readPlan(store, args, names);
    if (refused) return false;
    if (empty) {
      store.actions.notify(`${names.branch} has no commits of its own to rebase onto ${names.onto}`);
      return false;
    }
    if (plan.branch && plan.branch !== cur) names.branch = dn(plan.branch);
    names.ontoSha = typeof plan.onto === 'string' ? plan.onto : t.oid;
    return store.actions.openRebaseEditor({ plan, args, names }) === true;
  }

  /**
   * Re-read the plan of the open editor (after HEAD moved), keeping the actions of commits still there.
   * Not when another branch is checked out now: its commits aren't this plan's (planBlocker says so).
   */
  async function reloadInteractiveRebaseFlow(store) {
    const ed = store.state.rebaseEditor;
    if (!ed || ed.running) return false;
    if (!K.needClean(store, 'Interactive rebase')) return false;
    const blocked = Rebase().planBlocker({ ...ed, stale: null }, status(store));
    if (blocked && !blocked.reload) {
      store.actions.notify(blocked.text);
      return false;
    }
    const { plan, refused, empty } = await readPlan(store, ed.args, ed.names);
    if (refused) return false;
    const now = store.state.rebaseEditor;
    if (!now || now.plan !== ed.plan) return false; // closed or replaced meanwhile
    if (plan && plan.branch !== undefined && ed.plan.branch !== undefined && (plan.branch || null) !== (ed.plan.branch || null)) { // switched while it was read
      store.actions.notify(Rebase().planBlocker({ plan: ed.plan }, { branch: plan.branch || null, oid: plan.head }).text);
      return false;
    }
    if (empty) {
      store.actions.closeRebaseEditor();
      store.actions.notify(`${ed.names.branch} has no commits of its own to rebase onto ${ed.names.onto} any more`);
      return false;
    }
    const model = Rebase().reloadFrom(now.model, plan);
    const gone = now.model.rows.filter((r) => !model.rows.some((x) => x.sha === r.sha)).length;
    store.actions.patchRebaseEditor({ plan, model, past: [], future: [], stale: null, names: { ...now.names, ontoSha: plan.onto || now.names.ontoSha } });
    const isAre = gone === 1 ? 'is' : 'are';
    store.actions.notify(gone ? `Plan reloaded: ${C.util.plural(gone, 'commit')} ${isAre} no longer in the range` : 'Plan reloaded');
    return true;
  }

  /** Close the editor (Cancel / Esc): asks first when the plan was changed. */
  async function cancelInteractiveRebaseFlow(store) {
    const ed = store.state.rebaseEditor;
    if (!ed || ed.running) return false;
    if (!(await discardPlan(store))) return false;
    if (store.state.rebaseEditor === ed || (store.state.rebaseEditor && store.state.rebaseEditor.plan === ed.plan)) store.actions.closeRebaseEditor();
    return true;
  }

  /** Why the open plan can't start now (PLRebase.planBlocker, the editor's check too), or null. */
  function planStale(store, ed) {
    const b = Rebase().planBlocker(ed, status(store));
    return b ? b.text : null;
  }

  /**
   * The range rebaseInteractive gets: the refnames the editor was opened with when they still point at
   * the plan's commits (so the backend records the name and the banner shows it), else the plan's shas.
   */
  function rangeFor(store, ed) {
    const { plan, args } = ed;
    const pick = (arg, sha) => (typeof arg === 'string' && !C.util.OID_RE.test(arg) && K.targetInfo(store, arg).oid === sha ? arg : sha);
    return { upstream: pick(args.upstream, plan.upstream), onto: pick(args.onto || args.upstream, plan.onto) };
  }

  /** The drop confirms (every commit / some): true when the user goes ahead. */
  async function confirmDrops(store, rows, names) {
    const dropped = rows.filter((r) => r.action === 'drop');
    if (!dropped.length) return true;
    if (dropped.length === rows.length) {
      return dialog(store).confirm({
        title: 'Drop every commit?',
        message: `All ${C.util.plural(rows.length, 'commit')} are dropped, so ${names.branch} will be reset to ${names.onto}. Their changes are removed from the branch.`,
        confirmLabel: 'Drop All and Rebase',
        danger: true,
      });
    }
    return dialog(store).confirm({
      title: `Drop ${C.util.plural(dropped.length, 'commit')}?`,
      message: `${dropped.length === 1 ? 'Its changes are' : 'Their changes are'} left out of the rebased ${names.branch}.`,
      detail: dropped.slice(0, 10).map((r) => `${short(r.sha)} ${dn(r.subject)}`).join('\n') + (dropped.length > 10 ? `\nand ${dropped.length - 10} more` : ''),
      confirmLabel: 'Drop and Rebase',
      defaultCancel: true,
    });
  }

  /** Start Rebase: validate, confirm (published, drops, everything dropped), run rebaseInteractive. */
  async function startInteractiveRebaseFlow(store) {
    const ed = store.state.rebaseEditor;
    if (!ed || ed.running) return false;
    const R = Rebase();
    const stale = planStale(store, ed);
    if (stale) {
      store.actions.notify(stale);
      return false;
    }
    const { names, model, plan } = ed;
    const v = R.validate(model, names);
    if (!v.ok) {
      store.actions.notify(v.errors[0].message);
      return false;
    }
    const rows = model.rows;
    // Only the published commits this plan rewrites need the warning (and later the force push).
    const pubRows = R.rewrittenRows(model).filter((r) => r.remoteRefs);
    if (pubRows.length) {
      const facts = K.publishedFacts(store, pubRows.map((r) => ({ sha: r.sha, remoteRefs: r.remoteRefs })), plan.branch || null, plan);
      if (K.needsPublishedConfirm(facts, plan.branch || null) && !(await K.publishedWarning(store, facts, plan.branch || null, rows.length))) return false;
    }
    if (!(await confirmDrops(store, rows, names))) return false;
    // The plan may have moved while a dialog was open.
    if (store.state.rebaseEditor !== ed) return false;
    const staleNow = planStale(store, ed);
    if (staleNow) {
      store.actions.notify(staleNow);
      return false;
    }

    const todo = R.toTodo(model);
    const messages = R.messagesFor(model);
    const after = R.summary(model).after;
    store.actions.patchRebaseEditor({ running: true });
    // expectHead / expectBranch: the backend refuses (kind 'stale') when HEAD or the checked-out branch
    // is no longer the plan's (plan.branch null: a detached HEAD).
    const expectBranch = typeof plan.branch === 'string' && plan.branch ? plan.branch : null;
    const { value: res, error } = await settle(store.actions.write('rebaseInteractive',
      [rangeFor(store, ed), todo, { messages, expectHead: plan.head, expectBranch }], { quiet: IR_QUIET, cancellable: true }));
    const mine = () => store.state.rebaseEditor && store.state.rebaseEditor.plan === plan;
    if (mine()) store.actions.patchRebaseEditor({ running: false });
    const done = error ? K.finishedOf(error) : res;
    if (!done) return interactiveError(store, error, { names, mine });
    if (mine()) store.actions.closeRebaseEditor();
    await K.rebaseResult(store, done, names, `Rebased ${names.branch}: ${C.util.plural(rows.length, 'commit')} → ${after}`);
    if (error) report(store, error); // it finished, then a later step failed
    await K.offerForcePush(store, done, expectBranch);
    return true;
  }

  /**
   * A refused or failed rebaseInteractive: the editor stays open unless the repo is now mid-rebase.
   * The editor's own cases here; the rest (stale's notice, a cancel, the start errors) is startError's.
   */
  async function interactiveError(store, e, { names, mine }) {
    switch (e.kind) {
      case 'stale':
        if (mine()) store.actions.patchRebaseEditor({ stale: STALE_PLAN });
        return K.startError(store, e, 'rebase', { stale: STALE_PLAN });
      case 'nothing':
        store.actions.notify('Nothing to rebase: change an action or the order');
        return false;
      case 'empty-message':
        store.actions.notify(`${String(e.message || 'A message is missing')}: edit it in the plan (Enter on the row)`);
        return false;
      case 'invalid-todo':
        await dialog(store).alert({ title: 'The rebase plan was refused', message: String(e.message || 'git refused the rebase plan.'), detail: '' });
        return false;
      case 'merge-commits':
      case 'root-commit':
      case 'too-many':
        return planRefusal(store, e, names);
      default:
        if (e.rebase && mine()) store.actions.closeRebaseEditor();
        return K.startError(store, e, 'rebase');
    }
  }

  K.register({
    rebase: rebaseFlow,
    interactiveRebase: interactiveRebaseFlow,
    startInteractiveRebase: startInteractiveRebaseFlow,
    reloadInteractiveRebase: reloadInteractiveRebaseFlow,
    cancelInteractiveRebase: cancelInteractiveRebaseFlow, // free (PLPolicy.FREE_FLOWS): also while busy
  });
})();
