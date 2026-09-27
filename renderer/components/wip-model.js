'use strict';
// Pure helpers of the WIP panel (plain script; exposes window.PLWip, and module.exports under
// node for the tests). No DOM: status entries, selections, commit-message rules and the WIP
// keybindings (shortcut, from Components.actions.KEYS).
(function () {
  // window.PLOp (op-model.js) loads before this script; node tests that load it alone get it from its file.
  const Op = () => (typeof window !== 'undefined' && window.PLOp) || (typeof require === 'function' ? require('../op-model.js') : null);

  /** The summary length git tools recommend: the composer's and the message editor's counter. */
  const SUMMARY_SOFT_MAX = 72;

  /** "summary\n\ndescription" → {summary, description} (for the amend prefill). */
  function splitMessage(message) {
    const text = String(message || '').replace(/\r\n/g, '\n');
    const nl = text.indexOf('\n');
    if (nl < 0) return { summary: text.trim(), description: '' };
    return { summary: text.slice(0, nl).trim(), description: text.slice(nl + 1).replace(/^\s*\n/, '').trimEnd() };
  }

  /** summary + "\n\n" + description, trailing whitespace trimmed. */
  function joinMessage(summary, description) {
    const d = String(description || '').trimEnd();
    return `${summary || ''}${d.trim() ? `\n\n${d}` : ''}`.trimEnd();
  }

  /**
   * Why committing isn't possible right now ('' = it is).
   * {status, busy, committing, summary, amend, all}: all = stage everything and commit.
   */
  function blocker({ status: st, busy = false, committing = false, summary = '', amend = false, all = false }) {
    if (!st) return 'Loading…';
    if (committing) return 'Committing…';
    if (busy) return 'Another operation is running';
    if (!String(summary).trim()) return 'Enter a commit summary';
    if (amend && !st.oid) return 'There is no commit to amend yet';
    if (all) {
      if (st.conflicted.length) return 'Resolve the conflicts first';
      if (!amend && !st.staged.length && !st.unstaged.length) return 'There are no changes to commit';
    } else if (!amend && !st.staged.length) return 'Stage files to commit';
    return '';
  }

  // ---------------------------------------------------------------- rebase / merge in progress
  // The composer's Continue Rebase / Commit and Merge modes (PLOp.composerMode): the fields start as
  // the stopped commit's message (or MERGE_MSG), and only an edited message is sent.

  /** The fields' message when it differs from `prefill` (both normalized like a commit), else null. */
  function editedMessage(prefill, summary, description) {
    const p = splitMessage(prefill);
    const same = joinMessage(p.summary, p.description) === joinMessage(String(summary || '').trim(), description);
    return same ? null : joinMessage(summary, description);
  }

  const OP_COMMIT_ALL_BLOCKED = 'Stage resolved files one by one: all conflicts must be resolved first';

  /**
   * Why Continue Rebase / Commit and Merge can't run from the composer now ('' = it can): also the
   * unstaged changes ops would refuse (window.PLOp.unstagedBlocker).
   * {status, busy, committing, summary, description, prefill, merge}
   */
  function continueBlocker({ status: st, busy = false, committing = false, summary = '', description = '', prefill = '', merge = false }) {
    if (!st) return 'Loading…';
    if (committing) return merge ? 'Committing…' : 'Continuing…';
    if (busy) return 'Another operation is running';
    if (st.conflicted.length) return Op().RESOLVE_FIRST;
    const unstaged = Op().unstagedBlocker(st);
    if (unstaged) return unstaged;
    if (editedMessage(prefill, summary, description) !== null && !String(summary).trim()) return 'Enter a commit summary';
    return '';
  }

  /**
   * Paths to unstage for one staged entry: a rename also takes its old path (so the deletion goes
   * back too); a copy only its new path (the source was never touched).
   */
  const unstagePathsFor = (entry) => (entry.status === 'R' && entry.orig && entry.orig !== entry.path ? [entry.path, entry.orig] : [entry.path]);

  /** unstagePathsFor over several entries, without duplicates. */
  const unstagePaths = (entries) => [...new Set(entries.flatMap(unstagePathsFor))];

  /**
   * True when every entry is still in the current unstaged list with the same status (a file-level
   * discard carries no fingerprint, so this is checked again after the confirm).
   */
  function stillCurrent(entries, status) {
    if (!status || !entries.length) return false;
    const now = new Map(status.unstaged.map((f) => [f.path, f.status]));
    return entries.every((e) => now.get(e.path) === e.status);
  }

  const FILE_CHANGED = 'The file changed meanwhile — please retry';

  /** How many files the WIP row stands for: distinct paths over the staged, unstaged and conflicted lists. */
  function wipCount(st) {
    if (!st) return 0;
    const paths = new Set();
    for (const list of [st.staged, st.unstaged, st.conflicted]) for (const f of list || []) paths.add(f.path);
    return paths.size;
  }

  // ---------------------------------------------------------------- multi-selection
  // sel: {list: section key | null, paths: Set, anchor: path | null} — one section at a time.

  const emptySelection = () => ({ list: null, paths: new Set(), anchor: null });

  /**
   * The selection after a gesture on `path` in section `list`.
   *   kind 'single' | 'toggle' | 'range' (Shift: anchor … path over `order`, the visible file order)
   *   from: the path the keyboard moved from; a Shift+arrow range starts there when the selection
   *         has no anchor in this section yet.
   */
  function nextSelection(sel, list, kind, path, order = [], from = null) {
    if (kind === 'toggle' && sel.list === list) {
      const paths = new Set(sel.paths);
      if (paths.has(path)) paths.delete(path);
      else paths.add(path);
      return { list, paths, anchor: path };
    }
    if (kind === 'range') {
      const at = (p) => (p == null ? -1 : order.findIndex((f) => f.path === p));
      let anchor = sel.list === list ? sel.anchor : null;
      if (at(anchor) < 0) anchor = from;
      const a = at(anchor);
      const b = at(path);
      if (a >= 0 && b >= 0) return { list, paths: new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1).map((f) => f.path)), anchor };
    }
    return { list, paths: new Set([path]), anchor: path };
  }

  /** Every file of the section (⌘A). */
  const selectAll = (list, order, anchor) => ({ list, paths: new Set(order.map((f) => f.path)), anchor });

  /** Drop selected paths that left the selected section of `status`. Same object when unchanged. */
  function pruneSelection(sel, status) {
    if (!sel.list) return sel;
    const have = new Set((status[sel.list] || []).map((e) => e.path));
    const paths = new Set([...sel.paths].filter((p) => have.has(p)));
    if (paths.size === sel.paths.size) return sel;
    return paths.size ? { ...sel, paths } : emptySelection();
  }

  /** The entries an action on `entry` applies to: the selection when `entry` is part of it. */
  function targets(sel, list, entry, entries) {
    if (sel.list !== list || !sel.paths.has(entry.path) || sel.paths.size < 2) return [entry];
    const picked = entries.filter((e) => sel.paths.has(e.path));
    return picked.length ? picked : [entry];
  }

  /**
   * The WIP-panel shortcut keydown `e` presses, or null: the id of a Components.actions.KEYS entry
   * with a `wip` action ('stageAll' ⌘⇧S, 'unstageAll' ⌘⇧U, 'focusMessage' ⌘⇧M, 'commit' ⌘↵,
   * 'commitAll' ⌘⇧↵; Ctrl instead of ⌘ when !mac), matched by Components.actions.matchKey. A key
   * repeat still matches: the caller swallows it (Components.actions.repeatBlocked). Pure.
   */
  function shortcut(e, mac) {
    const A = typeof window !== 'undefined' && window.Components ? window.Components.actions : null;
    const k = A && typeof A.matchKey === 'function' ? A.matchKey(e, { mac }) : null;
    return k && k.wip ? k.wip : null;
  }

  const api = {
    SUMMARY_SOFT_MAX, splitMessage, joinMessage, blocker, editedMessage, continueBlocker, OP_COMMIT_ALL_BLOCKED, unstagePathsFor, unstagePaths, stillCurrent, FILE_CHANGED, wipCount,
    emptySelection, nextSelection, selectAll, pruneSelection, targets, shortcut,
  };
  if (typeof window !== 'undefined') window.PLWip = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
