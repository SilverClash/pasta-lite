'use strict';
// PLFlows for the working tree: staging, discarding, resolving and committing (plain script; loads
// after flows-stash.js and adds its flows to window.PLFlows). Contract: flows-kit.js. The WIP panel
// (details.js, composer.js) and the diff view (components/diff-staging.js) run them through
// Components.actions.runFlow, so they share the flow lock, the busy guard and the bare-repository
// refusal (PLPolicy.WORKTREE_FLOWS) with every other flow; the components keep only their focus,
// scroll and in-flight display.
//
//   stage(store, paths, ui?), unstage(store, paths, ui?)   paths: [path] (a staged rename: both paths)
//   stageAll(store)             `add -A`, or with conflicts the listed unstaged files only (add -A would
//                               also mark the conflicted files resolved)
//   unstageAll(store)
//   discard(store, entries, {all}?, ui?)   entries [{path, status}] (status '?': untracked, deleted):
//                               the discard confirm (Components.dialog.confirmDiscard), then the entries
//                               are checked against the status again (a file-level discard carries no
//                               fingerprint: PLWip.stillCurrent), then discarded
//   markResolved(store, entries, {all}?)   confirm, then stage the files as they are (all: every
//                               conflicted file, ops markAllResolved)
//   commit(store, {message, amend, all})   commit / commitAll; a hook's refusal gets its own alert
//   stageSelection / unstageSelection / discardSelection(store, {file, selection, fingerprint}, ui?)
//                               hunk / line staging (hunks.js selection [{hunk, lines?}]); the fingerprint
//                               makes ops refuse a file that changed since it was shown (kind 'stale':
//                               the diff is reloaded); discard asks first
// ui (optional, the diff view's in-flight display; every hook optional): begin() before the confirm,
// isCurrent() the diff acted on is still shown after it, sending() just before the write, hold() it
// succeeded (keep the display until the reloaded diff), end() not sent or failed, stale(e), fail(e).
// The sequence is PLDiff.writeFlow's (components/diff-model.js).
// All git-derived text reaches the DOM through the dialogs / toasts (textContent only).
(function () {
  const K = window.PLFlowKit;
  const { C, report, dialog, dn, status } = K;
  // components/wip-model.js and diff-model.js load after this script, before any flow runs; node
  // tests that load the flows without them get them from their files.
  const model = (name, file) => () => window[name] || (typeof module !== 'undefined' && typeof require === 'function' ? require(file) : null);
  const W = model('PLWip', './components/wip-model.js');
  const D = model('PLDiff', './components/diff-model.js');

  const noop = () => {};

  /**
   * One write in PLDiff.writeFlow's order: confirm, the diff still current and nothing else running,
   * `check()` (else the "file changed" toast), then write(). Resolves true when it was sent and succeeded.
   */
  async function sequence(store, write, { confirm = null, check = null, ui } = {}) {
    const u = ui && typeof ui === 'object' ? ui : {};
    const hook = (name) => (typeof u[name] === 'function' ? u[name] : noop);
    const res = await D().writeFlow({
      isOff: () => false, // the flow wrapper already refused while busy or while another flow runs
      begin: hook('begin'),
      confirm: (c) => (typeof c === 'function' ? c() : dialog(store).confirm(c)),
      isCurrent: typeof u.isCurrent === 'function' ? u.isCurrent : () => true,
      isBusy: () => !!store.state.busy,
      write: () => {
        hook('sending')();
        return write();
      },
      hold: hook('hold'),
      end: hook('end'),
      stale: (e) => {
        hook('stale')(e);
        store.actions.reloadDiff();
      },
      fail: (e) => {
        hook('fail')(e);
        report(store, e);
      },
      changed: () => store.actions.toast(new Error(W().FILE_CHANGED)),
    }, { confirm, check });
    return res === 'ok';
  }

  const pathsOk = (paths) => Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p === 'string' && p);
  const write = (store, op, args, opts) => () => store.actions.write(op, args, opts);

  // ---------------------------------------------------------------- stage / unstage

  function stageFlow(store, paths, ui) {
    if (!pathsOk(paths)) return false;
    return sequence(store, write(store, 'stage', [paths]), { ui });
  }

  function unstageFlow(store, paths, ui) {
    if (!pathsOk(paths)) return false;
    return sequence(store, write(store, 'unstage', [paths]), { ui });
  }

  async function stageAllFlow(store) {
    const st = status(store);
    if (!st || !st.unstaged.length) return false;
    // `add -A` would also mark conflicted files resolved: with conflicts, stage the listed files only.
    if (st.conflicted.length) await store.actions.write('stage', [st.unstaged.map((e) => e.path)]);
    else await store.actions.write('stageAll', []);
    return true;
  }

  async function unstageAllFlow(store) {
    const st = status(store);
    if (!st || !st.staged.length) return false;
    await store.actions.write('unstageAll', []);
    return true;
  }

  // ---------------------------------------------------------------- discard / resolve

  async function discardFlow(store, entries, opts, ui) {
    const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e.path === 'string' && e.path) : [];
    if (!list.length) return false;
    const all = !!(opts && opts.all);
    return sequence(store, write(store, 'discard', [list.map((e) => ({ path: e.path, status: e.status }))]), {
      confirm: () => dialog(store).confirmDiscard(list, { all }),
      check: () => W().stillCurrent(list, status(store)),
      ui,
    });
  }

  async function markResolvedFlow(store, entries, opts) {
    const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e.path === 'string' && e.path) : [];
    if (!list.length) return false;
    const ok = await dialog(store).confirm(list.length === 1
      ? {
        title: 'Mark as resolved?',
        message: `Mark ${dn(list[0].path)} as resolved?\n\nThe file is staged as it is now in the working tree.`,
        confirmLabel: 'Mark Resolved',
      }
      : {
        title: `Mark ${list.length} files as resolved?`,
        message: 'The files are staged as they are now in the working tree.',
        detail: dialog(store).pathListText(list.map((e) => e.path)),
        confirmLabel: 'Mark Resolved',
      });
    if (!ok) return false;
    if (opts && opts.all) {
      await store.actions.write('markAllResolved', [], { quiet: ['nothing'] }).catch((e) => { if (e.kind !== 'nothing') throw e; });
    } else {
      await store.actions.write('stage', [list.map((e) => e.path)]);
    }
    return true;
  }

  // ---------------------------------------------------------------- commit

  /** The hook's output is the error message (ops: tail-trimmed to 4k). */
  function hookFailure(store, e) {
    const detail = String(e.message || '').trim();
    return dialog(store).alert({
      title: 'Commit rejected by a hook',
      message: 'A commit hook failed, so nothing was committed. Your message has been kept.',
      detail: detail || '(the hook printed nothing)',
      okLabel: 'OK',
    });
  }

  async function commitFlow(store, o) {
    const message = o && typeof o.message === 'string' ? o.message : '';
    if (!message.trim()) return false;
    try {
      await store.actions.write(o.all ? 'commitAll' : 'commit', [message, { amend: !!o.amend }], { quiet: ['hook-failed'] });
      return true;
    } catch (e) {
      // The message stays in the composer; a hook's output gets its own dialog (other errors were toasted).
      if (e && e.kind === 'hook-failed') await hookFailure(store, e);
      else report(store, e);
      return false;
    }
  }

  // ---------------------------------------------------------------- hunks and lines (the diff view)

  /** The discard confirm of a selection: one hunk, or the picked lines. */
  function selectionConfirm(file, selection) {
    const lines = selection.reduce((n, s) => n + (Array.isArray(s.lines) ? s.lines.length : 0), 0);
    if (!lines) {
      return {
        title: 'Discard hunk?', message: 'The changes of this hunk will be lost. You can bring them back with Undo.',
        detail: dn(file), confirmLabel: 'Discard', danger: true,
      };
    }
    return {
      title: `Discard ${C.util.plural(lines, 'line')}?`, message: 'The selected changes will be lost. You can bring them back with Undo.',
      detail: dn(file), confirmLabel: 'Discard', danger: true,
    };
  }

  /** stageSelection / unstageSelection / discardSelection: {file, selection, fingerprint}; stale is explained by the ui. */
  function selectionFlow(op) {
    return (store, o, ui) => {
      const file = o && o.file;
      const selection = o && Array.isArray(o.selection) ? o.selection : [];
      if (typeof file !== 'string' || !file || !selection.length) return false;
      const run = write(store, op, [file, selection, { fingerprint: o.fingerprint }], { quiet: ['stale'] });
      return sequence(store, run, { confirm: op === 'discardSelection' ? selectionConfirm(file, selection) : null, ui });
    };
  }

  K.register({
    stage: stageFlow,
    stageAll: stageAllFlow,
    unstage: unstageFlow,
    unstageAll: unstageAllFlow,
    discard: discardFlow,
    markResolved: markResolvedFlow,
    commit: commitFlow,
    stageSelection: selectionFlow('stageSelection'),
    unstageSelection: selectionFlow('unstageSelection'),
    discardSelection: selectionFlow('discardSelection'),
  });
})();
