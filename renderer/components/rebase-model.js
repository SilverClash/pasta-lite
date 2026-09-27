'use strict';
// The interactive rebase plan as the editor edits it (plain script; exposes window.PLRebase, and
// module.exports under node for the tests). Pure and immutable: every change returns a new model
// (the same object when nothing changed), so the store can keep an undo stack of models.
// docs/plans/rebase.md §4.2 (rebasePlan / rebaseInteractive shapes), §5.6 (the editor).
//
// Rows are NEWEST FIRST (the order the editor shows, like the graph); the todo git gets is oldest
// first (toTodo reverses). A squash / fixup row folds into the nearest kept row BELOW it (older).
//
//   ACTIONS                         ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']
//   KEY_ACTIONS                     {p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop'}
//   MAX_ROWS                        500: the fallback of limitOf (the backend's PLAN_LIMIT; the menus use it
//                                   before a plan is read)
//   limitOf(plan?) -> number        the plan's `limit` (rebasePlan: the backend's PLAN_LIMIT), else MAX_ROWS
//   HASH_NOTE                       'Lines starting with # are removed in rebased messages' (validate's
//                                   'hash-lines' warning; the message editor, dialog.js, shows it too)
//   planBlocker(editor, status) -> null | {text, reload}   why the open editor's plan can't start now: its
//                                   `stale` text, a rebase / merge / … in progress, a pending autostash, another
//                                   branch (or a detached HEAD) checked out, or HEAD moved. reload: Reload can
//                                   help (HEAD moved on the same branch)
//   fromPlan(plan) -> model         model = {plan, base: [Row], rows: [Row], messages: {[slotKey]: text},
//                                   lost: {[slotId]: {kind, rowSha, message}}}
//                                   lost: typed messages whose slot went away (a squash group that lost
//                                   its squash or its target, a reword set back to pick); restored when
//                                   the slot comes back (slotId 'g:<target>' / 'r:<sha>'), noted by validate
//                                   Row = {sha, action, subject, message, author, email, date, parents,
//                                   isMerge, remoteRefs: string[] | null (published)}
//   setAction(model, shas, action) -> model        shas: a sha or an array (the multi-selection)
//   move(model, shas, delta) -> model              the selected rows move by delta rows as a block
//                                                  (negative: up / newer); nothing moves past an edge
//   moveTo(model, shas, index) -> model            drag and drop: insert before the row now at `index`
//                                                  (rows.length: at the bottom), selection order kept
//   reset(model) -> model                          the plan as loaded: all pick, original order
//   reloadFrom(model, plan) -> model               a re-read plan keeping the actions and edited
//                                                  messages of the commits that still exist
//   groups(model) -> [{target: Row, members: [Row] (oldest first), squash: boolean, last: sha|null}]
//   groupOf(model, sha) -> group | null            the group the row is the target or a member of
//   intoOf(model, sha) -> Row | null               what a squash / fixup row folds into
//   messageSlot(model, sha) -> null | {kind: 'reword'|'squash', key, sha (the helper's key), rowSha,
//                                   prefill, message (current), edited}   the message Enter / ✎ edits
//   setMessage(model, sha, text) -> model          the slot's message (== prefill once normalized like a
//                                                  commit message: back to unedited)
//   squashPrefill(model, group) -> string          target's message + each squashed commit's message
//   messagesFor(model) -> {[sha]: string}          what rebaseInteractive gets (every reword, every
//                                                  squash group keyed by its last member)
//   toTodo(model) -> [{action, sha}]               oldest first
//   changed(model) -> boolean                      differs from the plan (order, actions, messages, lost messages)
//   noOp(model) -> boolean                         unchanged and already on the target (error 'nothing');
//                                                  unchanged onto a new base is a plain rebase (allowed)
//   validate(model, names?) -> {ok, errors, warnings, infos}  each [{code, message, sha?}]
//                                   errors: squash-first, empty-message, nothing; warnings: all-dropped,
//                                   published (only rewritten published rows), hash-lines; infos: rewrites,
//                                   message-reset (a lost message). names {branch, onto} display-safe
//   rewrittenRows(model) -> [Row]                  the rows git re-creates or removes: from the oldest
//                                                  changed position up (all of them onto a new base)
//   rewritten(model) -> number                     how many commits are re-created (drops excluded)
//   summary(model) -> {counts, reordered, before, after, text, countsText}
// Every returned text is display-safe (subjects through util.displayName); the DOM gets it via textContent.
(function () {
  const util = () => (typeof window !== 'undefined' && window.Components ? window.Components.util : null);
  const dn = (s) => {
    const u = util();
    if (u) return u.displayName(s);
    return s == null ? '' : String(s);
  };
  // Components.util (components.js loads first, in index.html and in the tests).
  const plural = (...a) => util().plural(...a);
  const short = (sha) => util().short(sha);
  const Op = () => (typeof window !== 'undefined' ? window.PLOp : null);

  const ACTIONS = Object.freeze(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']);
  const KEY_ACTIONS = Object.freeze({ p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' });
  const LABELS = Object.freeze({ pick: 'Pick', reword: 'Reword', edit: 'Edit', squash: 'Squash', fixup: 'Fixup', drop: 'Drop' });
  const MAX_ROWS = 500;
  const FOLDS = new Set(['squash', 'fixup']);

  /** The plan's commit limit (rebasePlan `limit`, the backend's PLAN_LIMIT), else MAX_ROWS. */
  const limitOf = (plan) => (plan && Number.isInteger(plan.limit) && plan.limit > 0 ? plan.limit : MAX_ROWS);

  const shaSet = (shas) => new Set((Array.isArray(shas) ? shas : [shas]).filter((s) => typeof s === 'string' && s));
  const str = (v) => (typeof v === 'string' ? v : '');

  /** Rows (newest first) from a rebasePlan result (commits oldest first). */
  function rowsOf(plan) {
    const commits = plan && Array.isArray(plan.commits) ? plan.commits : [];
    const published = new Map();
    for (const p of (plan && Array.isArray(plan.published) ? plan.published : [])) {
      if (p && typeof p.sha === 'string') published.set(p.sha, Array.isArray(p.remoteRefs) ? p.remoteRefs.filter((r) => typeof r === 'string') : []);
    }
    const seen = new Set();
    const rows = [];
    for (const c of commits) {
      if (!c || typeof c.sha !== 'string' || !c.sha || seen.has(c.sha)) continue;
      seen.add(c.sha);
      const parents = Array.isArray(c.parents) ? c.parents.filter((p) => typeof p === 'string') : [];
      const message = str(c.message) || str(c.subject);
      rows.push(Object.freeze({
        sha: c.sha, action: 'pick', subject: str(c.subject) || message.split('\n')[0], message,
        author: str(c.author), email: str(c.email), date: Number(c.date) || 0, parents,
        isMerge: c.isMerge === true || parents.length > 1, remoteRefs: published.has(c.sha) ? published.get(c.sha) : null,
      }));
    }
    // Keep the newest limitOf(plan) (rebasePlan lists at most that many; the flow refuses a longer range).
    return rows.slice(-limitOf(plan)).reverse();
  }

  /** The plan facts the model keeps (not the commits, which are the rows). */
  function planInfo(plan) {
    const p = plan || {};
    const s = (v) => (typeof v === 'string' ? v : null);
    const commits = Array.isArray(p.commits) ? p.commits : [];
    const oldest = commits.find((c) => c && typeof c.sha === 'string');
    const parent = oldest && Array.isArray(oldest.parents) ? oldest.parents[0] : undefined;
    return Object.freeze({
      head: s(p.head), branch: s(p.branch), upstream: s(p.upstream), onto: s(p.onto),
      // the commits already sit on `onto`: all picks in the original order change nothing (else it is a plain rebase)
      sameBase: !s(p.onto) || !parent || parent === p.onto,
    });
  }

  const freeze = (m) => Object.freeze({ ...m, rows: Object.freeze(m.rows), messages: Object.freeze(m.messages), lost: Object.freeze(m.lost || {}) });

  function fromPlan(plan) {
    const base = Object.freeze(rowsOf(plan));
    return freeze({ plan: planInfo(plan), base, rows: base, messages: {}, lost: {} });
  }

  const withRows = (model, rows) => freeze({ ...model, rows, ...keepMessages(model, rows) });

  /** 'g:<target sha>' / 'r:<sha>': the slot a message key belongs to, whatever the group's members. */
  const slotIdOf = (key) => key.split(':').slice(0, 2).join(':');

  /**
   * The messages for new `rows`: {messages, lost}. A squash group whose key changed (its members did)
   * keeps its typed message while its target is the same row; a message whose slot is gone moves to
   * `lost` (with the row it was for), and a lost one comes back when its slot does.
   */
  function keepMessages(model, rows) {
    const slots = slotsOf({ ...model, rows, messages: {} });
    const byId = new Map(slots.map((sl) => [slotIdOf(sl.key), sl]));
    const messages = {};
    const lost = { ...(model.lost || {}) };
    for (const [k, v] of Object.entries(model.messages)) {
      const sl = byId.get(slotIdOf(k));
      if (sl && !Object.hasOwn(messages, sl.key)) messages[sl.key] = v;
      else lost[slotIdOf(k)] = { kind: k.startsWith('r:') ? 'reword' : 'squash', rowSha: k.split(':')[1], message: v };
    }
    for (const [id, l] of Object.entries(lost)) {
      const sl = byId.get(id);
      if (sl && !Object.hasOwn(messages, sl.key)) messages[sl.key] = l.message;
      if (sl || !rows.some((r) => r.sha === l.rowSha)) delete lost[id]; // restored, or its commit is gone
    }
    return { messages, lost };
  }

  function setAction(model, shas, action) {
    if (!ACTIONS.includes(action)) return model;
    const set = shaSet(shas);
    const hit = (r) => set.has(r.sha) && r.action !== action;
    if (!model.rows.some(hit)) return model;
    return withRows(model, model.rows.map((r) => (hit(r) ? Object.freeze({ ...r, action }) : r)));
  }

  function move(model, shas, delta) {
    const set = shaSet(shas);
    const steps = Math.trunc(Number(delta) || 0);
    if (!set.size || !steps) return model;
    const rows = [...model.rows];
    const idx = rows.map((r, i) => (set.has(r.sha) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return model;
    const up = steps < 0;
    const room = up ? idx[0] : rows.length - 1 - idx[idx.length - 1];
    const n = Math.min(Math.abs(steps), room);
    if (!n) return model;
    for (let k = 0; k < n; k++) {
      if (up) {
        for (let i = 1; i < rows.length; i++) {
          if (set.has(rows[i].sha) && !set.has(rows[i - 1].sha)) [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
        }
      } else {
        for (let i = rows.length - 2; i >= 0; i--) {
          if (set.has(rows[i].sha) && !set.has(rows[i + 1].sha)) [rows[i], rows[i + 1]] = [rows[i + 1], rows[i]];
        }
      }
    }
    return withRows(model, rows);
  }

  function moveTo(model, shas, index) {
    const set = shaSet(shas);
    const picked = model.rows.filter((r) => set.has(r.sha));
    if (!picked.length || !Number.isFinite(Number(index))) return model;
    const at = Math.max(0, Math.min(model.rows.length, Math.trunc(Number(index))));
    const before = model.rows.slice(0, at).filter((r) => set.has(r.sha)).length;
    const rest = model.rows.filter((r) => !set.has(r.sha));
    const pos = at - before;
    const rows = [...rest.slice(0, pos), ...picked, ...rest.slice(pos)];
    return rows.every((r, i) => r === model.rows[i]) ? model : withRows(model, rows);
  }

  const reset = (model) => (model.rows === model.base && !Object.keys(model.messages).length && !Object.keys(model.lost).length
    ? model : freeze({ ...model, rows: model.base, messages: {}, lost: {} }));

  function reloadFrom(model, plan) {
    const fresh = fromPlan(plan);
    const old = new Map(model.rows.map((r) => [r.sha, r.action]));
    const rows = fresh.rows.map((r) => (old.has(r.sha) && old.get(r.sha) !== r.action ? Object.freeze({ ...r, action: old.get(r.sha) }) : r));
    return freeze({ ...fresh, rows, ...keepMessages({ ...fresh, messages: model.messages, lost: model.lost }, rows) });
  }

  // ---------------------------------------------------------------- squash groups

  // Cached per rows array (a model's rows are frozen and replaced on every change).
  const groupCache = new WeakMap();

  function groups(model) {
    if (groupCache.has(model.rows)) return groupCache.get(model.rows);
    const out = [];
    let cur = null;
    for (let i = model.rows.length - 1; i >= 0; i--) {
      const r = model.rows[i];
      if (r.action === 'drop') continue;
      if (FOLDS.has(r.action)) {
        if (cur) cur.members.push(r); // else: squash-first (validate reports it)
        continue;
      }
      cur = { target: r, members: [] };
      out.push(cur);
    }
    const res = Object.freeze(out.map((g) => Object.freeze({
      target: g.target, members: Object.freeze(g.members), squash: g.members.some((m) => m.action === 'squash'),
      last: g.members.length ? g.members[g.members.length - 1].sha : null,
    })));
    groupCache.set(model.rows, res);
    return res;
  }

  function groupOf(model, sha) {
    return groups(model).find((g) => g.target.sha === sha || g.members.some((m) => m.sha === sha)) || null;
  }

  function intoOf(model, sha) {
    const g = groupOf(model, sha);
    return g && g.target.sha !== sha ? g.target : null;
  }

  const groupKey = (g) => `g:${g.target.sha}:${g.members.map((m) => `${m.action[0]}${m.sha}`).join(',')}`;
  const rewordKey = (sha) => `r:${sha}`;
  const rowBy = (model, sha) => model.rows.find((r) => r.sha === sha) || null;

  /** The target's message (its reword, when edited) followed by each squashed commit's, blank lines between. */
  function squashPrefill(model, g) {
    const t = g.target;
    const first = t.action === 'reword' && Object.hasOwn(model.messages, rewordKey(t.sha)) ? model.messages[rewordKey(t.sha)] : t.message;
    const parts = [first, ...g.members.filter((m) => m.action === 'squash').map((m) => m.message)];
    return parts.map((p) => String(p || '').trimEnd()).filter((p) => p.trim()).join('\n\n');
  }

  function rewordSlot(model, r) {
    const key = rewordKey(r.sha);
    const edited = Object.hasOwn(model.messages, key);
    return { kind: 'reword', key, sha: r.sha, rowSha: r.sha, prefill: r.message, message: edited ? model.messages[key] : r.message, edited };
  }

  function squashSlot(model, g) {
    const key = groupKey(g);
    const prefill = squashPrefill(model, g);
    const edited = Object.hasOwn(model.messages, key);
    return { kind: 'squash', key, sha: g.last, rowSha: g.target.sha, prefill, message: edited ? model.messages[key] : prefill, edited };
  }

  /** Every message the todo needs: each reword row, each group with a squash. */
  function slotsOf(model) {
    const out = [];
    for (const g of groups(model)) {
      if (g.target.action === 'reword') out.push(rewordSlot(model, g.target));
      if (g.squash) out.push(squashSlot(model, g));
    }
    return out;
  }

  function messageSlot(model, sha) {
    const r = rowBy(model, sha);
    if (!r || r.action === 'drop') return null;
    const g = groupOf(model, sha);
    if (!g) return null; // an orphan squash (squash-first)
    if (g.squash) return squashSlot(model, g);
    if (g.target.action === 'reword') return rewordSlot(model, g.target);
    return null;
  }

  // The commit-message rules of the WIP panel (components/wip-model.js; loaded before any editing in the
  // app, required under node).
  const wip = () => (typeof window !== 'undefined' && window.PLWip) || require('./wip-model.js');

  /** A message as the editor dialog returns it (wip-model splitMessage + joinMessage). */
  function normalized(text) {
    const W = wip();
    const p = W.splitMessage(text);
    return W.joinMessage(p.summary, p.description);
  }

  function setMessage(model, sha, text) {
    const slot = messageSlot(model, sha);
    if (!slot || typeof text !== 'string') return model;
    const messages = { ...model.messages };
    if (normalized(text) === normalized(slot.prefill)) delete messages[slot.key];
    else messages[slot.key] = text;
    const lost = { ...model.lost };
    delete lost[slotIdOf(slot.key)]; // a new message for the slot replaces the one it lost
    const same = Object.keys(messages).length === Object.keys(model.messages).length
      && Object.entries(messages).every(([k, v]) => model.messages[k] === v)
      && Object.keys(lost).length === Object.keys(model.lost).length;
    if (same) return model;
    // A reword target's edit feeds its group's squash prefill: an unedited group message follows it.
    return freeze({ ...model, messages, lost });
  }

  function messagesFor(model) {
    const out = {};
    for (const s of slotsOf(model)) out[s.sha] = s.message;
    return out;
  }

  const toTodo = (model) => [...model.rows].reverse().map((r) => ({ action: r.action, sha: r.sha }));

  /** The todo differs from the plan (order, actions, messages). */
  function planChanged(model) {
    if (model.rows.length !== model.base.length) return true;
    return model.rows.some((r, i) => r.sha !== model.base[i].sha || r.action !== 'pick') || Object.keys(model.messages).length > 0;
  }

  /** The user changed the plan (order, actions, messages, or typed a message that was reset): Reset / "Discard your rebase plan?". */
  const changed = (model) => planChanged(model) || Object.keys(model.lost).length > 0;

  /** Starting would change nothing: unchanged, and the commits already sit on the target. */
  const noOp = (model) => !planChanged(model) && model.plan.sameBase !== false;

  // ---------------------------------------------------------------- validation and summary

  const quote = (r) => `"${dn(r.subject || short(r.sha))}"`;

  function validate(model, names = {}) {
    const rows = model.rows;
    const kept = rows.filter((r) => r.action !== 'drop');
    const errors = [...orderErrors(kept), ...messageErrors(model)];
    if (noOp(model)) errors.push({ code: 'nothing', message: 'Nothing to rebase: change an action or the order' });

    const warnings = [];
    if (rows.length && !kept.length) {
      warnings.push({ code: 'all-dropped', message: `Every commit is dropped: ${names.branch || 'the branch'} will be reset to ${names.onto || 'its new base'}` });
    }
    const published = publishedWarning(model);
    if (published) warnings.push(published);
    warnings.push(...lostWarnings(model));
    if (Object.values(messagesFor(model)).some((m) => /^#/m.test(m))) {
      warnings.push({ code: 'hash-lines', message: HASH_NOTE });
    }

    const infos = [];
    const rewrites = errors.some((e) => e.code === 'nothing') ? null : rewritesInfo(model);
    if (rewrites) infos.push(rewrites);
    return { ok: errors.length === 0, errors, warnings, infos };
  }

  /** validate(): the oldest kept commit can't fold into the one below it (there is none). */
  function orderErrors(kept) {
    const bottom = kept[kept.length - 1];
    if (!bottom || !FOLDS.has(bottom.action)) return [];
    return [{
      code: 'squash-first', sha: bottom.sha,
      message: `The oldest commit can't be ${bottom.action === 'fixup' ? 'fixed up' : 'squashed'}: there's nothing below it to combine with`,
    }];
  }

  /** validate(): every reword / squash message slot that is empty. */
  function messageErrors(model) {
    return slotsOf(model).filter((s) => !String(s.message).trim()).map((s) => ({
      code: 'empty-message', sha: s.rowSha,
      message: `${s.kind === 'reword' ? 'The reworded' : 'The squashed'} message of ${quote(rowBy(model, s.rowSha))} is empty`,
    }));
  }

  /** "origin/main", "origin/main and 2 other remote branches", or "a remote" (no names known). */
  function remoteNames(where) {
    if (!where.length) return 'a remote';
    const more = where.length > 1 ? ` and ${plural(where.length - 1, 'other remote branch', 'other remote branches')}` : '';
    return dn(where[0]) + more;
  }

  /** The subject of the published warning: which of the rewritten commits are already pushed. */
  function publishedWho(pub, rows) {
    if (pub.length === 1) return rows.length === 1 ? 'This commit is' : '1 commit this rewrites is';
    if (pub.length === rows.length) return `All ${pub.length} commits are`;
    return `${pub.length} commits this rewrites are`;
  }

  /** validate(): the warning that rewritten commits are already on a remote (a force push follows), or null. */
  function publishedWarning(model) {
    const pub = rewrittenRows(model).filter((r) => r.remoteRefs);
    if (!pub.length) return null;
    const on = remoteNames([...new Set(pub.flatMap((r) => r.remoteRefs))]);
    return {
      code: 'published',
      message: `${publishedWho(pub, model.rows)} already pushed to ${on}: you'll need to force push afterwards.`,
    };
  }

  /** validate(): one warning per message the user wrote that a change of action reset. */
  function lostWarnings(model) {
    return Object.values(model.lost).map((l) => {
      const r = rowBy(model, l.rowSha);
      return {
        code: 'message-reset', sha: l.rowSha,
        message: `The ${l.kind === 'reword' ? 'reworded' : 'squash'} message you wrote for ${r ? quote(r) : short(l.rowSha)} was reset: Undo or restoring the ${l.kind} brings it back`,
      };
    });
  }

  /** validate(): how many commits the plan rewrites (naming the one reword when that is all), or null. */
  function rewritesInfo(model) {
    const n = rewritten(model);
    if (n <= 0) return null;
    const touched = model.rows.filter((r, i) => r.action !== 'pick' || r.sha !== model.base[i].sha);
    const one = touched.length === 1 && touched[0].action === 'reword' ? touched[0] : null;
    return { code: 'rewrites', message: one ? `Rewording ${quote(one)} rewrites ${plural(n, 'commit')}` : `${plural(n, 'commit')} will be rewritten` };
  }

  /** Index of the oldest row git re-creates or removes (rows are newest first), -1: none. */
  function oldestChange(model) {
    const { rows, base } = model;
    if (model.plan.sameBase === false) return rows.length - 1; // a new base: all of them
    const changedAt = (r, i) => r.sha !== (base[i] && base[i].sha) || r.action !== 'pick' || Object.hasOwn(model.messages, rewordKey(r.sha));
    const from = rows.map((r, i) => (changedAt(r, i) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    if (from < 0) return -1;
    // a squash / fixup at the oldest change rewrites the commit it folds into too
    const into = FOLDS.has(rows[from].action) ? intoOf(model, rows[from].sha) : null;
    return into ? Math.max(from, rows.indexOf(into)) : from;
  }

  /** The rows git re-creates or removes: everything from the oldest changed position up. */
  const rewrittenRows = (model) => model.rows.slice(0, oldestChange(model) + 1);

  /** Commits git re-creates (drops excluded). */
  const rewritten = (model) => rewrittenRows(model).filter((r) => r.action !== 'drop').length;

  function summary(model) {
    const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
    for (const r of model.rows) counts[r.action]++;
    const reordered = model.rows.some((r, i) => r.sha !== model.base[i].sha);
    const before = model.rows.length;
    const after = groups(model).length; // each kept commit that isn't folded into the one below
    const parts = [];
    const add = (n, verb) => { if (n) parts.push([n, verb]); };
    add(counts.reword, 'reworded');
    add(counts.squash + counts.fixup, 'squashed');
    add(counts.edit, 'stopped for editing');
    add(counts.drop, 'dropped');
    const actions = parts.map(([n, verb], i) => (i === 0 ? `${plural(n, 'commit')} will be ${verb}` : `${n} ${verb}`)).join(', ');
    const text = summaryText(model, actions, reordered);
    const countsText = [['pick', 'picked'], ['reword', 'reworded'], ['edit', 'to edit'], ['squash', 'squashed'], ['fixup', 'fixed up'], ['drop', 'dropped']]
      .filter(([a]) => counts[a]).map(([a, w]) => `${counts[a]} ${w}`).join(' · ');
    return { counts, reordered, before, after, text, countsText };
  }

  /** summary().text: the action counts, whether the order changes, else what else the plan does. */
  function summaryText(model, actions, reordered) {
    if (reordered) return actions ? `${actions}; the order changes` : 'The order of the commits changes';
    if (actions) return actions;
    if (planChanged(model)) return 'Messages edited';
    return noOp(model) ? 'No changes yet' : 'The commits are replayed onto the new base';
  }

  // ---------------------------------------------------------------- can the plan start now?

  const STALE_PLAN = 'The branch moved since you opened this plan: reload it to review the commits again';
  const HASH_NOTE = 'Lines starting with # are removed in rebased messages';

  /**
   * Why the open editor `ed` ({plan, stale}, store.state.rebaseEditor) can't start for `st` (the live
   * status), or null. The one check the editor's Start button and the Start flow share. A plan belongs
   * to the branch it was read on (plan.branch; null: a detached HEAD): another branch checked out at
   * the same commit is as stale as a moved HEAD, but Reload can't fix it (it would read the other
   * branch's commits): {reload: false}.
   */
  function planBlocker(ed, st) {
    if (!ed) return null;
    if (ed.stale) return { text: ed.stale, reload: true };
    const O = Op();
    if (O && O.inProgress(st)) return { text: `A ${O.opName(st)} is in progress: finish or abort it, then reload the plan`, reload: false };
    if (O && O.pendingAutostashOf(st)) return { text: O.pendingStashTitle('Interactive rebase'), reload: false };
    const plan = ed.plan;
    if (!st || !plan) return null;
    if (plan.branch !== undefined && (st.branch || null) !== (plan.branch || null)) {
      const was = plan.branch ? dn(plan.branch) : 'a detached HEAD';
      return { text: `This plan is for ${was}, which is no longer checked out: check it out again, or cancel the plan`, reload: false };
    }
    if (plan.head && st.oid !== plan.head) return { text: STALE_PLAN, reload: true };
    return null;
  }

  const api = {
    ACTIONS, KEY_ACTIONS, LABELS, MAX_ROWS, STALE_PLAN, HASH_NOTE, limitOf, planBlocker,
    fromPlan, setAction, move, moveTo, reset, reloadFrom, groups, groupOf, intoOf, messageSlot, setMessage, squashPrefill,
    messagesFor, toTodo, changed, noOp, validate, summary, rewritten, rewrittenRows, normalized,
  };
  if (typeof window !== 'undefined') window.PLRebase = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
