'use strict';
// Commit composer of the WIP panel (plain script; exposes window.PLComposer). Summary with a
// 72-char counter, description, Amend (prefilled with HEAD's message, the draft restored when
// unchecked), ⌘↵ commit, ⌘⇧↵ stage all and commit, per-repo drafts, and a dialog for hook output.
// The fields are locked while a commit runs. The commit is the working-tree flow PLFlows.commit
// (flows-worktree.js, through Components.actions.runFlow: the flow lock, the busy guard, the bare
// refusal and the hook-failure dialog are the flow's); Continue Rebase / Commit and Merge are
// PLFlows.rebaseContinue / mergeCommit.
// ⌘↵ / ⌘⇧↵ in the fields are handled here; details.js runs the same keys (tryCommit) from outside
// them. A blocked commit (no summary, nothing staged, …) is explained with a notice.
//
// Modes (window.PLOp.composerMode(status), docs/plans/rebase.md §5.4):
//   commit    the normal commit box
//   continue  a rebase stopped with conflicts, or at a hook stop (a hook refused the message): the fields
//             hold the stopped commit's message and the button (and ⌘↵) is Continue Rebase
//             (PLFlows.rebaseContinue); Amend is hidden, ⌘⇧↵ is refused. Only an edited message is sent.
//             The draft is kept per stop (its commit sha). Only with git's merge backend (PLOp.composerMode).
//   merge     the same for a merge: MERGE_MSG and Commit and Merge (PLFlows.mergeCommit)
//   rebase    another rebase stop (edit, empty, break, …): the normal commit box plus a Continue Rebase
//             button; Commit, Amend and Commit All are off where the backend refuses them (a stop on a
//             replayed commit: the button, the checkbox and ⌘↵ / ⌘⇧↵ carry its reason, PLOp COMMIT_REFUSED)
// Continue Rebase / Commit and Merge are off with the reason while ops would refuse them (conflicts,
// unstaged changes: PLOp.unstagedBlocker).
// The edited message is published as state.continueDraft {key, message}, so the banner's Continue
// Rebase / Commit and Merge send it too.
(function () {
  const { el, util } = window.Components;
  const { storage, repoKey, plural, report } = util;
  /** A flow of `store` holds the one flow lock (PLFlows.isRunning): the commit box waits too. */
  const flowRunning = (store) => { const f = window.PLFlows; return !!f && typeof f.isRunning === 'function' && f.isRunning(store); };
  const W = window.PLWip;
  const { withKeyHint, repeatBlocked, runFlow } = window.Components.actions;
  const Op = () => window.PLOp;
  const DRAFT_KEY = (root) => `pl.details.draft.${repoKey(root)}`; // {summary, description}
  const OP_DRAFT_KEY = (root) => `pl.details.opDraft.${repoKey(root)}`; // {key, summary, description}: one stop at a time
  const COMMIT_MODE = Object.freeze({ mode: 'commit', key: 'commit', stop: null });
  /** The composer's title per mode (mode.mode); 'Commit' for the others. */
  const MODE_TITLES = Object.freeze({ continue: 'Rebase commit', merge: 'Merge commit' });
  const { SUMMARY_SOFT_MAX } = W;
  const DRAFT_DEBOUNCE_MS = 400;

  /** Remove a stored key (storage.set(key, null) would store the string "null"). */
  function removeKey(key) {
    if (typeof storage.remove === 'function') {
      storage.remove(key);
      return;
    }
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }

  /**
   * create(store) -> {el, render(), setRepo(repo), focus(), tryCommit(all), dispose()}. Built once per details
   * mount and kept, so the typed message survives re-renders.
   */
  function create(store) {
    const box = el('div', 'dt-composer');
    const head = el('div', 'dt-composer-head');
    const amendLabel = el('label', 'dt-amend');
    const amendBox = el('input');
    amendBox.type = 'checkbox';
    amendBox.className = 'dt-amend-input';
    amendLabel.append(amendBox, document.createTextNode('Amend previous commit'));
    const title = el('span', 'dt-composer-title', 'Commit');
    title.title = withKeyHint('Focus the commit message', 'focusMessage');
    head.append(title, amendLabel);
    const summaryWrap = el('div', 'dt-summary-wrap');
    const summary = el('input', 'dt-summary');
    summary.type = 'text';
    summary.placeholder = 'Summary';
    summary.setAttribute('aria-label', 'Commit summary');
    summary.spellcheck = true;
    const counter = el('span', 'dt-summary-count', String(SUMMARY_SOFT_MAX));
    counter.setAttribute('aria-hidden', 'true');
    summaryWrap.append(summary, counter);
    const desc = el('textarea', 'dt-description');
    desc.placeholder = 'Description';
    desc.setAttribute('aria-label', 'Commit description');
    desc.rows = 4;
    const btn = el('button', 'btn dt-commit-btn');
    btn.type = 'button';
    const spinner = el('span', 'dt-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    const btnLabel = el('span', 'dt-commit-label', 'Commit');
    btn.append(spinner, btnLabel);
    const actions = el('div', 'dt-composer-actions');
    actions.append(btn);
    // Mode 'rebase' (an edit or other stop): Continue Rebase under the commit button.
    const contBtn = el('button', 'btn dt-continue-btn', 'Continue Rebase');
    contBtn.type = 'button';
    contBtn.hidden = true;
    // An edit stop says what it stopped for (PLOp.editStopText): "Stopped to edit a1b2c3d: amend or continue".
    const stopNote = el('p', 'dt-stop-note');
    stopNote.setAttribute('role', 'status');
    stopNote.hidden = true;
    box.append(head, stopNote, summaryWrap, desc, actions, contBtn);

    let repoRoot = null; // repo root the fields belong to (drafts are per repo)
    let amend = false;
    let preAmend = null; // {summary, description} typed before Amend was checked
    let committing = false;
    let amendSeq = 0; // guards the async lastCommitMessage prefill
    let draftTimer = 0;
    let mode = COMMIT_MODE; // PLOp.composerMode() the fields belong to
    let doneKey = null; // an op mode whose Continue / Commit and Merge succeeded: its text isn't saved

    const fields = () => ({ summary: summary.value, description: desc.value });
    const setFields = ({ summary: s = '', description: d = '' } = {}) => {
      summary.value = s;
      desc.value = d;
    };
    const message = () => W.joinMessage(summary.value, desc.value);
    const opMode = () => mode.mode === 'continue' || mode.mode === 'merge';
    /** The fields' message when edited from the op's prefill (null: unchanged; never in commit mode). */
    const edited = () => (opMode() ? W.editedMessage(mode.message, summary.value, desc.value) : null);

    // ---- drafts (only the user's own text: not while Amend shows the previous message; in an op
    // mode only an edited message, keyed by its stop)
    function saveDraft() {
      clearTimeout(draftTimer);
      draftTimer = 0;
      if (!repoRoot) return;
      if (opMode()) {
        if (mode.key === doneKey) return;
        if (edited() !== null) storage.set(OP_DRAFT_KEY(repoRoot), { key: mode.key, ...fields() });
        else { // unedited: forget this stop's draft only (the slot may hold another stop's)
          const d = storage.get(OP_DRAFT_KEY(repoRoot), null);
          if (d && d.key === mode.key) removeKey(OP_DRAFT_KEY(repoRoot));
        }
        return;
      }
      if (amend) return;
      const f = fields();
      if (f.summary || f.description) storage.set(DRAFT_KEY(repoRoot), f);
      else removeKey(DRAFT_KEY(repoRoot));
    }

    /** state.continueDraft: the edited op message, for the banner's buttons (set only when it changed). */
    function publishDraft() {
      const msg = edited();
      const next = msg === null ? null : { key: mode.key, message: msg };
      const cur = store.state.continueDraft;
      const same = cur === next || (!!cur && !!next && cur.key === next.key && cur.message === next.message);
      if (!same && typeof store.actions.setContinueDraft === 'function') store.actions.setContinueDraft(next);
    }

    /** The fields for mode `m`: its stored draft (same stop), else its prefill; the commit draft in commit modes. */
    function loadFields(m) {
      if (m.mode === 'continue' || m.mode === 'merge') {
        const d = repoRoot ? storage.get(OP_DRAFT_KEY(repoRoot), null) : null;
        if (d && typeof d === 'object' && d.key === m.key) setFields({ summary: String(d.summary || ''), description: String(d.description || '') });
        else setFields(W.splitMessage(m.message));
        return;
      }
      const d = repoRoot ? storage.get(DRAFT_KEY(repoRoot), null) : null;
      setFields(d && typeof d === 'object' ? { summary: String(d.summary || ''), description: String(d.description || '') } : {});
    }

    /** Switch the fields to mode `m` when its draft slot differs: the old text is saved first. */
    function syncMode(m) {
      if (m.key === mode.key && m.mode === mode.mode) {
        mode = m; // same slot: newer prefill / stop details
        return;
      }
      if (amend) { // leave Amend with the user's own text back in the fields
        amendSeq++;
        amend = false;
        amendBox.checked = false;
        if (preAmend) setFields(preAmend);
        preAmend = null;
      }
      const sameFields = !opMode() && !(m.mode === 'continue' || m.mode === 'merge');
      saveDraft();
      mode = m;
      doneKey = null;
      if (!sameFields) loadFields(m); // commit <-> rebase keep the same (commit) fields
      publishDraft();
    }
    const scheduleDraft = () => {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(saveDraft, DRAFT_DEBOUNCE_MS);
    };
    const clearDraft = () => {
      clearTimeout(draftTimer);
      draftTimer = 0;
      if (repoRoot) removeKey(DRAFT_KEY(repoRoot));
    };
    window.addEventListener('pagehide', saveDraft);
    window.addEventListener('beforeunload', saveDraft);

    /** A repo was opened: flush the old repo's draft, restore the new one's. */
    function setRepo(repo) {
      const next = repo ? repo.root : null;
      if (next === repoRoot) return;
      if (draftTimer) saveDraft();
      repoRoot = next;
      amend = false;
      preAmend = null;
      amendSeq++;
      amendBox.checked = false;
      mode = COMMIT_MODE; // render() switches to the new repo's op mode once its status is known
      doneKey = null;
      loadFields(mode);
      render();
    }

    // ---- amend
    async function setAmend(on) {
      if (on === amend || (on && opMode())) return;
      amend = on;
      amendBox.checked = on;
      const seq = ++amendSeq;
      if (on) {
        saveDraft(); // the draft keeps the user's text; the prefill is never saved as a draft
        preAmend = fields();
        render();
        if (summary.value.trim() || desc.value.trim()) return;
        const msg = await lastMessage();
        // Unchecked, repo switched, or the user started typing meanwhile: keep what is there.
        if (seq !== amendSeq || !amend || summary.value || desc.value || msg == null) return;
        setFields(W.splitMessage(msg));
      } else {
        if (preAmend) setFields(preAmend);
        preAmend = null;
        scheduleDraft();
      }
      render();
    }

    /** HEAD's message (lastCommitMessage op), or null. */
    async function lastMessage() {
      try {
        const res = await store.invoke('lastCommitMessage');
        return res && typeof res.message === 'string' ? res.message : null;
      } catch (e) {
        report(store, e);
        return null;
      }
    }

    // ---- commit
    const unborn = () => { const st = store.state.status; return !!st && !st.oid; };
    const busy = () => !!store.state.busy || (!committing && flowRunning(store));
    const blocker = (all) => {
      if (mode.commitRefused) return mode.commitRefused; // a rebase stop other than edit: Continue Rebase commits
      if (!opMode()) return W.blocker({ status: store.state.status, busy: busy(), committing, summary: summary.value, amend, all });
      if (all) return W.OP_COMMIT_ALL_BLOCKED;
      return W.continueBlocker({
        status: store.state.status, busy: busy(), committing, summary: summary.value, description: desc.value,
        prefill: mode.message, merge: mode.mode === 'merge',
      });
    };
    /** Why the 'rebase' mode's Continue Rebase can't run ('' = it can): PLWip.continueBlocker without a message. */
    const contBlocker = () => W.continueBlocker({ status: store.state.status, busy: busy(), committing });

    function render() {
      const st = store.state.status;
      if (Op()) syncMode(Op().composerMode(st));
      const n = st ? st.staged.length : 0;
      const left = SUMMARY_SOFT_MAX - summary.value.length;
      counter.textContent = String(left);
      counter.classList.toggle('is-over', left < 0);
      counter.title = left < 0 ? `${-left} characters over the recommended ${SUMMARY_SOFT_MAX}` : `${left} characters left of the recommended ${SUMMARY_SOFT_MAX}`;
      if (amend && unborn()) setAmend(false);
      // Locked while committing: the message on screen is the one being committed.
      amendBox.disabled = committing || (!amend && (unborn() || !!mode.commitRefused));
      summary.readOnly = committing;
      desc.readOnly = committing;
      box.classList.toggle('is-committing', committing);
      let amendTitle = 'Replace the last commit with the staged changes and this message';
      if (!amend && mode.commitRefused) amendTitle = mode.commitRefused;
      else if (!amend && unborn()) amendTitle = 'There is no commit to amend yet';
      amendLabel.title = amendTitle;
      amendLabel.hidden = opMode(); // a conflict stop / merge commits through git, never with --amend
      const titleText = MODE_TITLES[mode.mode] || 'Commit';
      if (title.textContent !== titleText) title.textContent = titleText;
      box.dataset.mode = mode.mode;
      let label;
      if (opMode()) label = mode.label;
      else label = amend ? 'Amend Previous Commit' : `Commit changes to ${plural(n, 'file')}`;
      if (btnLabel.textContent !== label) btnLabel.textContent = label;
      const why = blocker(false);
      btn.disabled = !!why;
      btn.classList.toggle('is-running', committing);
      btn.classList.toggle('is-amend', amend);
      btn.classList.toggle('is-continue', opMode());
      btn.setAttribute('aria-busy', String(committing));
      if (opMode()) {
        let sends = 'with this message';
        if (edited() === null) sends = mode.mode === 'merge' ? 'with the prepared merge message' : 'with the original message';
        btn.title = why || withKeyHint(`${label} ${sends}`, 'commit');
      } else {
        btn.title = why || `${withKeyHint(label, 'commit')} · ${withKeyHint('Stage all and commit', 'commitAll')}`;
      }
      const note = mode.mode === 'rebase' && mode.stop === 'edit' && Op() ? Op().editStopText(Op().rebaseStateOf(st)) : '';
      stopNote.hidden = !note;
      if (stopNote.textContent !== note) stopNote.textContent = note;
      contBtn.hidden = mode.mode !== 'rebase';
      if (!contBtn.hidden) {
        const cwhy = contBlocker();
        contBtn.disabled = !!cwhy;
        contBtn.title = cwhy || (mode.stop === 'edit'
          ? 'Continue the rebase: staged changes are amended into the stopped commit'
          : 'Continue the rebase with the next commit');
      }
    }

    /** Continue Rebase / Commit and Merge from the composer (op modes): the edited message, if any. */
    async function runOp() {
      if (blocker(false)) return;
      const key = mode.key;
      const msg = edited();
      committing = true;
      render();
      try {
        const ok = await runFlow({ flow: mode.flow, args: [{ message: msg }] }, store);
        if (ok) { // the fields go with the stop; its draft is dropped
          doneKey = key;
          if (repoRoot) removeKey(OP_DRAFT_KEY(repoRoot));
        }
      } finally {
        committing = false;
        render();
      }
    }

    /** The 'rebase' mode's Continue Rebase (an edit / other stop: no message). */
    async function runContinue() {
      if (contBlocker()) return;
      committing = true;
      render();
      try {
        await runFlow({ flow: 'rebaseContinue', args: [{}] }, store);
      } finally {
        committing = false;
        render();
      }
    }

    async function commit(all) {
      if (opMode()) {
        if (!all) await runOp();
        return;
      }
      if (blocker(all)) return;
      const msg = message();
      const wasAmend = amend;
      committing = true;
      render();
      try {
        // A failure keeps the message (PLFlows.commit shows a hook's output in its own dialog).
        const ok = await runFlow({ flow: 'commit', args: [{ message: msg, amend: wasAmend, all }] }, store);
        // Success: clear the composer (the fields were locked, so this is the committed message).
        if (ok && message() === msg) {
          amendSeq++;
          amend = false;
          preAmend = null;
          amendBox.checked = false;
          setFields({});
          clearDraft();
        }
      } finally {
        committing = false;
        render();
      }
    }

    /** The keyboard's commit (⌘↵, all: ⌘⇧↵): commits, or says why not (silent while busy / committing). */
    function tryCommit(all) {
      const why = blocker(all);
      if (!why) commit(all);
      else if (!committing && !busy()) store.actions.notify(why);
    }

    // ---- wiring
    const onInput = () => {
      if (!amend) scheduleDraft();
      publishDraft();
      render();
    };
    summary.addEventListener('input', onInput);
    desc.addEventListener('input', onInput);
    amendBox.addEventListener('change', () => setAmend(amendBox.checked));
    btn.addEventListener('click', () => commit(false));
    contBtn.addEventListener('click', () => runContinue());
    const onKey = (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const key = W.shortcut(e);
      if (key === 'commit' || key === 'commitAll') {
        e.preventDefault();
        e.stopPropagation();
        if (!repeatBlocked(e)) tryCommit(key === 'commitAll'); // a held key commits once
      } else if (e.target === summary && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault(); // Enter in the one-line summary moves on to the description
        desc.focus();
      }
    };
    summary.addEventListener('keydown', onKey);
    desc.addEventListener('keydown', onKey);
    render();

    return {
      el: box,
      render,
      setRepo,
      tryCommit,
      /** The current mode (PLOp.composerMode result the fields belong to). */
      mode: () => mode,
      focus() {
        summary.focus();
        summary.select();
      },
      dispose() {
        saveDraft();
        window.removeEventListener('pagehide', saveDraft);
        window.removeEventListener('beforeunload', saveDraft);
      },
    };
  }

  window.PLComposer = { create };
})();
