'use strict';
// docs/plans/rebase.md R3, renderer half: the interactive rebase flows (window.PLFlows
// interactiveRebase / startInteractiveRebase / reloadInteractiveRebase / cancelInteractiveRebase)
// over a scripted api and scripted dialogs, and the store's rebaseEditor state.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const SHA = (c) => c.repeat(40);
const err = H.errOf;

/** A rebasePlan result for feat: commits 1..n oldest first on 0 (main). */
function plan({ n = 3, head = SHA(String(n)), published = [], onto = SHA('0'), extra = {} } = {}) {
  const commits = Array.from({ length: n }, (_, i) => {
    const k = String(i + 1);
    return { sha: SHA(k), parents: [i ? SHA(String(i)) : SHA('0')], subject: `c${k}`, message: `c${k}\n\nbody ${k}`, author: 'Ada', email: 'a@x', date: 1700000000 + i, isMerge: false };
  });
  return {
    head, branch: 'feat', upstream: onto, onto, commits, mergeBase: SHA('0'), isAncestor: true,
    published: published.map((k) => ({ sha: SHA(k), remoteRefs: ['origin/feat'] })), branchesInRange: [], limit: 500, truncated: false,
    interactiveRefusal: null, ...extra,
  };
}

function baseData({ head = SHA('3'), dirty = false, st = {} } = {}) {
  const status = { ...H.status({ oid: head, branch: 'feat', dirty }), upstream: 'origin/feat', ...st };
  return {
    status,
    refs: H.refs({
      head: { branch: 'feat', oid: head, detached: false },
      local: [
        { name: 'feat', oid: head, upstream: 'origin/feat', current: true },
        { name: 'main', oid: SHA('0'), upstream: null, current: false },
      ],
      remote: [{ name: 'origin/feat', remote: 'origin', branch: 'feat', oid: SHA('2') }],
    }),
    stashes: [],
    log: { commits: [H.commit(SHA('3'), [SHA('2')]), H.commit(SHA('2'), [SHA('1')]), H.commit(SHA('1'), [SHA('0')]), H.commit(SHA('0'), [], { subject: 'base' })], hasMore: false, next: null },
    undoState: { undo: null, redo: null, busy: false, undoBlocked: null, redoBlocked: null },
    remotes: ['origin'],
  };
}

async function setup({ data = {}, handlers = {}, answers = [] } = {}) {
  H.setLocalStorage(H.memoryStorage());
  const win = H.loadFlows();
  const d = baseData(data);
  const api = H.scriptedApi(d, { rebasePlan: () => plan(), ...handlers });
  win.api = api;
  const store = win.Store.create(api);
  const toasts = [];
  store.setToast((e) => toasts.push(e));
  await store.actions.loadRepo({ root: '/r', name: 'r' });
  await H.flush();
  const dialogs = H.scriptDialogs(win, answers);
  return {
    win, api, store, F: win.PLFlows, R: win.PLRebase, dialogs, data: d,
    notices: () => toasts.filter((t) => t.level === 'info').map((t) => t.message),
    errors: () => toasts.filter((t) => t.level !== 'info'),
    ops: () => api.writes().map((c) => c.op).filter((op) => op !== 'rebasePlan'), // rebasePlan is a read
  };
}

const planCalls = (api) => api.calls.filter((c) => c.op === 'rebasePlan').map((c) => c.args[0]);
const edit = (s, fn) => s.store.actions.editRebase(fn);

// ------------------------------------------------------------------ opening the editor

test('interactiveRebase: reads the plan with interactive: true and opens the editor (names, args); the diff closes', async () => {
  const s = await setup();
  s.store.set({ diff: { spec: { kind: 'commit', sha: SHA('1'), file: 'a' }, loading: false, data: null, error: null } });
  assert.equal(await s.F.interactiveRebase(s.store, { upstream: 'refs/heads/main', expectHead: SHA('3') }), true);
  assert.deepEqual(planCalls(s.api), [{ upstream: 'refs/heads/main', interactive: true }]);
  const ed = s.store.state.rebaseEditor;
  assert.ok(ed);
  assert.deepEqual(ed.args, { upstream: 'refs/heads/main' });
  assert.deepEqual(ed.names, { branch: 'feat', onto: 'main', ontoSha: SHA('0') });
  assert.equal(ed.model.rows.map((r) => r.sha[0]).join(''), '321');
  assert.deepEqual([ed.running, ed.stale, ed.past.length], [false, null, 0]);
  assert.equal(s.store.state.diff, null);
  assert.deepEqual(s.ops(), [], 'nothing written');
  // openDiff doesn't open a diff while the editor is open: it says why
  await s.store.actions.openDiff({ kind: 'commit', sha: SHA('1'), file: 'a' });
  assert.equal(s.store.state.diff, null);
  assert.deepEqual(s.notices(), ['Close the rebase editor to view diffs']);
  assert.equal(s.api.calls.filter((c) => c.op === 'commitDiffView').length, 0);
  // a commit ("children of"): onto named by its sha7, onto passed through
  s.store.actions.closeRebaseEditor();
  assert.equal(await s.F.interactiveRebase(s.store, { upstream: SHA('1'), onto: 'refs/heads/main' }), true);
  assert.deepEqual(planCalls(s.api)[1], { upstream: SHA('1'), onto: 'refs/heads/main', interactive: true });
  assert.equal(s.store.state.rebaseEditor.names.onto, 'main');
});

test('interactiveRebase: the backend\'s refusals explained — merge commits, the root commit, too many (kind with err.plan); an empty range', async () => {
  const mergesPlan = plan();
  mergesPlan.commits[1] = { ...mergesPlan.commits[1], parents: [SHA('1'), SHA('9')], isMerge: true };
  const cases = [
    [() => { throw err('merge-commits', 'An interactive rebase is not available…', { plan: mergesPlan }); }, /include 1 merge commit\. Interactive rebase can't keep merges yet/],
    [() => { throw err('root-commit'); }, /the repository's first commit \(the root\)/],
    [() => { throw err('too-many'); }, /more than 500 commits between main and feat/],
  ];
  for (const [h, re] of cases) {
    const s = await setup({ handlers: { rebasePlan: h } });
    assert.equal(await s.F.interactiveRebase(s.store, { upstream: 'refs/heads/main' }), false);
    assert.equal(s.dialogs.length, 1);
    assert.equal(s.dialogs[0].type, 'alert');
    assert.equal(s.dialogs[0].opts.title, "Can't rebase interactively");
    assert.match(s.dialogs[0].opts.message, re);
    assert.equal(s.store.state.rebaseEditor, null);
  }
  for (const h of [() => { throw err('nothing', 'There are no commits to rebase'); }, () => plan({ n: 0 })]) {
    const s = await setup({ handlers: { rebasePlan: h } });
    assert.equal(await s.F.interactiveRebase(s.store, { upstream: 'refs/heads/main' }), false);
    assert.deepEqual(s.notices(), ['feat has no commits of its own to rebase onto main']);
    assert.equal(s.dialogs.length, 0);
  }
  // the backend refuses these plans itself (interactive: true): a plan it returns is taken as is
  const taken = await setup({ handlers: { rebasePlan: () => plan({ extra: { hasMerges: true, interactiveRefusal: { kind: 'root-commit', message: 'x' } } }) } });
  assert.equal(await taken.F.interactiveRebase(taken.store, { upstream: 'refs/heads/main' }), true);
  const bad = await setup({ handlers: { rebasePlan: () => { throw err('invalid-args', 'upstream is not a branch'); } } });
  assert.equal(await bad.F.interactiveRebase(bad.store, { upstream: 'refs/heads/nope' }), false);
  assert.equal(bad.errors()[0].message, 'upstream is not a branch', 'toasted');
});

test('interactiveRebase: in progress, pending autostash, unborn, a stale menu and a changed open plan are handled before the plan is read', async () => {
  const mid = await setup({ data: { st: { state: 'rebasing', rebase: H.rebaseState() } } });
  assert.equal(await mid.F.interactiveRebase(mid.store, { upstream: 'refs/heads/main' }), false);
  assert.deepEqual(mid.notices(), ['Interactive rebase — finish or abort the rebase first']);
  const stash = await setup({ data: { st: { pendingAutostash: SHA('5') } } });
  assert.equal(await stash.F.interactiveRebase(stash.store, { upstream: 'refs/heads/main' }), false);
  assert.match(stash.notices()[0], /restore or keep the stash/);
  const unborn = await setup({ data: { head: null } });
  assert.equal(await unborn.F.interactiveRebase(unborn.store, { upstream: 'refs/heads/main' }), false);
  assert.equal(unborn.dialogs[0].opts.title, 'Cannot rebase');
  const stale = await setup();
  assert.equal(await stale.F.interactiveRebase(stale.store, { upstream: 'refs/heads/main', expectHead: SHA('7') }), false);
  assert.deepEqual(stale.notices(), ['The branch moved since you opened this; review and try again']);
  for (const x of [mid, stash, unborn, stale]) assert.deepEqual(planCalls(x.api), []);
  assert.equal(await stale.F.interactiveRebase(stale.store), false, 'no upstream');

  // an open plan with changes: "Discard your rebase plan?" (Keep Editing is the default)
  const s = await setup();
  await s.F.interactiveRebase(s.store, { upstream: 'refs/heads/main' });
  edit(s, (m) => s.R.setAction(m, SHA('2'), 'drop'));
  const first = s.store.state.rebaseEditor;
  assert.equal(await s.F.interactiveRebase(s.store, { upstream: SHA('1') }), false);
  assert.deepEqual(s.dialogs.map((d) => [d.type, d.opts.title, d.opts.defaultCancel]), [['confirm', 'Discard your rebase plan?', true]]);
  assert.equal(s.store.state.rebaseEditor, first, 'kept');
  s.dialogs.length = 0;
  H.scriptDialogs(s.win, [true]);
  assert.equal(await s.F.interactiveRebase(s.store, { upstream: SHA('1') }), true);
  assert.notEqual(s.store.state.rebaseEditor, first);
});

// ------------------------------------------------------------------ starting

async function opened(opts = {}) {
  const s = await setup(opts);
  assert.equal(await s.F.interactiveRebase(s.store, { upstream: 'refs/heads/main' }), true);
  return s;
}

test('startInteractiveRebase: sends the todo oldest first, the messages and expectHead, cancellable; done closes the editor with "5 commits → 3"', async () => {
  let args = null;
  const s = await opened({ handlers: { rebaseInteractive: (...a) => { args = a; return { status: 'done', branch: 'feat', before: SHA('3'), after: SHA('8'), dropped: [], published: 0 }; } } });
  edit(s, (m) => s.R.setAction(m, SHA('2'), 'squash'));
  edit(s, (m) => s.R.setAction(m, SHA('3'), 'reword'));
  edit(s, (m) => s.R.setMessage(m, SHA('3'), 'c3 reworded'));
  assert.equal(await s.F.startInteractiveRebase(s.store), true);
  const call = s.api.calls.find((c) => c.op === 'rebaseInteractive');
  assert.ok(call.opId, 'cancellable');
  assert.deepEqual(args, [
    { upstream: 'refs/heads/main', onto: 'refs/heads/main' }, // the menu's ref, still at the plan's commit: the banner names it
    [{ action: 'pick', sha: SHA('1') }, { action: 'squash', sha: SHA('2') }, { action: 'reword', sha: SHA('3') }],
    { messages: { [SHA('2')]: 'c1\n\nbody 1\n\nc2\n\nbody 2', [SHA('3')]: 'c3 reworded' }, expectHead: SHA('3'), expectBranch: 'feat' },
  ]);
  assert.equal(s.store.state.rebaseEditor, null);
  assert.deepEqual(s.notices(), ['Rebased feat: 3 commits → 2']);
  assert.deepEqual(s.dialogs, [], 'no drop, nothing published: no confirm');
  // commits git emptied are named
  const t = await opened({ handlers: { rebaseInteractive: () => ({ status: 'done', dropped: [SHA('2')], published: 0 }) } });
  edit(t, (m) => t.R.move(m, SHA('1'), -1));
  await t.F.startInteractiveRebase(t.store);
  assert.deepEqual(t.notices(), ['Rebased feat: 3 commits → 3. 1 commit became empty and was dropped']);
});

test('startInteractiveRebase: the range names the menu\'s refs only while they still point at the plan\'s commits; shas otherwise', async () => {
  const range = async (open, refsPatch) => {
    let got = null;
    const s = await setup({ handlers: { rebaseInteractive: (r) => { got = r; return { status: 'done', dropped: [], published: 0 }; } } });
    assert.equal(await s.F.interactiveRebase(s.store, open), true);
    if (refsPatch) s.store.set({ refs: refsPatch(s.store.state.refs) });
    edit(s, (m) => s.R.setAction(m, SHA('2'), 'drop'));
    H.scriptDialogs(s.win, [true]);
    assert.equal(await s.F.startInteractiveRebase(s.store), true);
    return got;
  };
  assert.deepEqual(await range({ upstream: 'refs/heads/main' }), { upstream: 'refs/heads/main', onto: 'refs/heads/main' });
  // main moved since the plan was read (a fetch, a terminal): the plan's shas
  const moved = (refs) => ({ ...refs, local: refs.local.map((b) => (b.name === 'main' ? { ...b, oid: SHA('9') } : b)) });
  assert.deepEqual(await range({ upstream: 'refs/heads/main' }, moved), { upstream: SHA('0'), onto: SHA('0') });
  // "n children of <sha>": a sha upstream stays a sha
  assert.deepEqual(await range({ upstream: SHA('0') }), { upstream: SHA('0'), onto: SHA('0') });
});

test('startInteractiveRebase: validation errors, a stale plan and another op refuse before any dialog', async () => {
  const s = await opened({ handlers: { rebaseInteractive: () => ({ status: 'done' }) } });
  assert.equal(await s.F.startInteractiveRebase(s.store), false);
  assert.deepEqual(s.notices(), ['Nothing to rebase: change an action or the order']);
  edit(s, (m) => s.R.setAction(m, SHA('1'), 'squash'));
  assert.equal(await s.F.startInteractiveRebase(s.store), false);
  assert.match(s.notices()[1], /The oldest commit can't be squashed/);
  edit(s, (m) => s.R.setAction(m, SHA('1'), 'pick'));
  edit(s, (m) => s.R.setAction(m, SHA('2'), 'reword'));
  edit(s, (m) => s.R.setMessage(m, SHA('2'), ' '));
  assert.equal(await s.F.startInteractiveRebase(s.store), false);
  assert.match(s.notices()[2], /message of "c2" is empty/);
  edit(s, (m) => s.R.setMessage(m, SHA('2'), 'ok'));
  // HEAD moved (the watcher refreshed): stale
  s.store.set({ status: { ...s.store.state.status, oid: SHA('7') } });
  assert.equal(await s.F.startInteractiveRebase(s.store), false);
  assert.match(s.notices()[3], /The branch moved since you opened this plan/);
  s.store.set({ status: { ...s.store.state.status, oid: SHA('3'), state: 'merging', merge: { head: SHA('9'), name: 'x', message: '' } } });
  assert.equal(await s.F.startInteractiveRebase(s.store), false);
  assert.equal(s.notices()[4], 'A merge is in progress: finish or abort it, then reload the plan');
  s.store.set({ status: { ...s.store.state.status, state: 'clean', merge: null } });
  s.store.actions.patchRebaseEditor({ stale: 'The branch moved since you opened this plan: reload it to review the commits again' });
  assert.equal(await s.F.startInteractiveRebase(s.store), false);
  assert.deepEqual(s.ops(), []);
  assert.deepEqual(s.dialogs, []);
  s.store.actions.closeRebaseEditor();
  assert.equal(await s.F.startInteractiveRebase(s.store), false, 'no editor');
});

test('startInteractiveRebase: dropping asks (Cancel focused, the subjects listed); dropping everything is a danger confirm', async () => {
  const s = await opened({ handlers: { rebaseInteractive: () => ({ status: 'done', dropped: [], published: 0 }) } });
  edit(s, (m) => s.R.setAction(m, SHA('2'), 'drop'));
  assert.equal(await s.F.startInteractiveRebase(s.store), false, 'declined');
  assert.deepEqual(s.dialogs.map((d) => [d.opts.title, d.opts.confirmLabel, !!d.opts.defaultCancel, !!d.opts.danger]), [['Drop 1 commit?', 'Drop and Rebase', true, false]]);
  assert.equal(s.dialogs[0].opts.detail, '2222222 c2');
  assert.match(s.dialogs[0].opts.message, /Its changes are left out of the rebased feat/);
  assert.ok(s.store.state.rebaseEditor, 'still open');
  assert.deepEqual(s.ops(), []);

  H.scriptDialogs(s.win, [true]);
  assert.equal(await s.F.startInteractiveRebase(s.store), true);
  assert.deepEqual(s.ops(), ['rebaseInteractive']);

  const all = await opened({ handlers: { rebaseInteractive: () => ({ status: 'done', dropped: [], published: 0 }) } });
  edit(all, (m) => all.R.setAction(m, m.rows.map((r) => r.sha), 'drop'));
  H.scriptDialogs(all.win, [false]);
  const seen = H.scriptDialogs(all.win, []);
  assert.equal(await all.F.startInteractiveRebase(all.store), false);
  assert.deepEqual(seen.map((d) => [d.opts.title, !!d.opts.danger, d.opts.confirmLabel]), [['Drop every commit?', true, 'Drop All and Rebase']]);
  assert.match(seen[0].opts.message, /All 3 commits are dropped, so feat will be reset to main/);
  H.scriptDialogs(all.win, [true]);
  assert.equal(await all.F.startInteractiveRebase(all.store), true);
  assert.deepEqual(all.api.calls.find((c) => c.op === 'rebaseInteractive').args[1].map((t) => t.action), ['drop', 'drop', 'drop']);
});

test('startInteractiveRebase: published commits — the warning first (Cancel is the default), then the lease force-push follow-up (Later default)', async () => {
  const s = await opened({
    handlers: {
      rebasePlan: () => plan({ published: ['1', '2'] }),
      rebaseInteractive: () => ({ status: 'done', dropped: [], published: 2 }),
    },
  });
  // rewording c3 leaves the published c1 / c2 as they are: no warning, and a result with published 0 offers no force push
  edit(s, (m) => s.R.setAction(m, SHA('3'), 'reword'));
  s.api.handlers.rebaseInteractive = () => ({ status: 'done', dropped: [], published: 0 });
  assert.equal(await s.F.startInteractiveRebase(s.store), true);
  assert.deepEqual(s.dialogs, [], 'no published commit is rewritten');
  assert.deepEqual(s.ops(), ['rebaseInteractive']);
  s.api.calls.length = 0;
  s.api.handlers.rebaseInteractive = () => ({ status: 'done', dropped: [], published: 2 });
  assert.equal(await s.F.interactiveRebase(s.store, { upstream: 'refs/heads/main' }), true);
  // rewording c2 rewrites c3 and c2: one published commit, only on feat's own upstream: no warning, the offer after
  edit(s, (m) => s.R.setAction(m, SHA('2'), 'reword'));
  const own = H.scriptDialogs(s.win, [null]);
  assert.equal(await s.F.startInteractiveRebase(s.store), true);
  assert.deepEqual(own.map((d) => [d.type, d.opts.title]), [['choose', 'Force push feat?']]);
  assert.equal(own[0].opts.cancelLabel, 'Later');
  assert.deepEqual(s.ops(), ['rebaseInteractive'], 'Later: no push');

  // the same commit also on another remote branch: the warning first (Cancel is the default)
  s.api.calls.length = 0;
  const shared = plan({ published: ['1', '2'] });
  shared.published = shared.published.map((p) => ({ ...p, remoteRefs: ['origin/feat', 'origin/shared'] }));
  s.api.handlers.rebasePlan = () => shared;
  assert.equal(await s.F.interactiveRebase(s.store, { upstream: 'refs/heads/main' }), true);
  edit(s, (m) => s.R.setAction(m, SHA('2'), 'reword'));
  const seen = H.scriptDialogs(s.win, [false]);
  assert.equal(await s.F.startInteractiveRebase(s.store), false, 'warning declined');
  assert.equal(seen[0].opts.title, 'Rewrite pushed commits?');
  assert.equal(seen[0].opts.defaultCancel, true);
  assert.match(seen[0].opts.message, /^1 of your 3 commits is already pushed to origin\/feat\. Rebasing replaces it with a new copy, so you'll need to force push feat afterwards to update origin\/feat\./);
  assert.deepEqual(s.ops(), [], 'declined: no rebase');
});

test('startInteractiveRebase: stopped (edit / conflict) closes the editor and hands over to the banner; running flag while the op runs', async () => {
  let release;
  const s = await opened({
    handlers: {
      rebaseInteractive: () => new Promise((r) => { release = r; }),
    },
  });
  edit(s, (m) => s.R.setAction(m, SHA('2'), 'edit'));
  const p = s.F.startInteractiveRebase(s.store);
  await H.flush();
  assert.equal(s.store.state.rebaseEditor.running, true);
  assert.equal(s.store.actions.editRebase((m) => s.R.setAction(m, SHA('1'), 'drop')), false, 'locked while running');
  assert.equal(await s.F.cancelInteractiveRebase(s.store), false, 'no cancel while running');
  assert.equal(s.store.state.remoteOp.op, 'rebaseInteractive', 'the toolbar Cancel can abort it');
  release({ status: 'stopped', state: H.rebaseState({ stop: 'edit', conflicted: 0, current: { cmd: 'edit', sha: SHA('2'), subject: 'c2' } }) });
  assert.equal(await p, true);
  assert.equal(s.store.state.rebaseEditor, null);
  assert.deepEqual(s.notices(), ['Rebase stopped to edit 2222222 "c2": amend or continue']);
  assert.deepEqual(s.store.state.selection, { kind: 'wip' });
});

test('startInteractiveRebase: stale keeps the editor open with the reload prompt; cancelled, invalid-todo, nothing, empty-message, refusals and a cancel mid-way', async () => {
  const run = async (e, setupEdit = (s) => edit(s, (m) => s.R.setAction(m, SHA('2'), 'reword'))) => {
    const s = await opened({ handlers: { rebaseInteractive: () => { throw e; } } });
    setupEdit(s);
    assert.equal(await s.F.startInteractiveRebase(s.store), false);
    return s;
  };
  const stale = await run(err('stale', 'The branch moved'));
  assert.equal(stale.store.state.rebaseEditor.stale, 'The branch moved since you opened this plan: reload it to review the commits again');
  assert.equal(stale.store.state.rebaseEditor.running, false);
  assert.match(stale.notices()[0], /reload it/);
  assert.deepEqual(stale.errors(), [], 'not toasted');

  const cancelled = await run(err('aborted'));
  assert.deepEqual(cancelled.notices(), ['Rebase cancelled']);
  assert.ok(cancelled.store.state.rebaseEditor, 'nothing happened: still open');

  const midway = await run(err('aborted', 'cancelled', { rebase: H.rebaseState() }));
  assert.deepEqual(midway.notices(), ['Rebase stopped: continue or abort it']);
  assert.equal(midway.store.state.rebaseEditor, null, 'mid-rebase: the banner takes over');

  const invalid = await run(err('invalid-todo', 'git refused the plan'));
  assert.deepEqual(invalid.dialogs.map((d) => [d.type, d.opts.title, d.opts.message]), [['alert', 'The rebase plan was refused', 'git refused the plan']]);
  assert.ok(invalid.store.state.rebaseEditor);

  const nothing = await run(err('nothing', 'Nothing to change'));
  assert.deepEqual(nothing.notices(), ['Nothing to rebase: change an action or the order']);
  const empty = await run(err('empty-message', 'The commit 2222222 needs a message'));
  assert.deepEqual(empty.notices(), ['The commit 2222222 needs a message: edit it in the plan (Enter on the row)']);
  const merges = await run(err('merge-commits', 'x', { plan: plan() }));
  assert.equal(merges.dialogs[0].opts.title, "Can't rebase interactively");
  const hook = await run(err('hook-failed', 'pre-rebase said no'));
  assert.equal(hook.dialogs[0].opts.title, 'A hook refused the rebase');
  const other = await run(err('invalid-args', 'todo entry 1 may only have action and sha'));
  assert.equal(other.errors()[0].message, 'todo entry 1 may only have action and sha', 'unexpected: toasted by write');
  assert.ok(other.store.state.rebaseEditor);
});

// ------------------------------------------------------------------ reload / cancel

test('reloadInteractiveRebase: re-reads with the original args, keeps the actions of commits still there, clears stale and the undo stack', async () => {
  let n = 3;
  const s = await opened({ handlers: { rebasePlan: () => plan({ n }) } });
  edit(s, (m) => s.R.setAction(m, SHA('2'), 'drop'));
  s.store.actions.patchRebaseEditor({ stale: 'moved' });
  n = 4;
  assert.equal(await s.F.reloadInteractiveRebase(s.store), true);
  const ed = s.store.state.rebaseEditor;
  assert.equal(ed.model.rows.map((r) => `${r.sha[0]}${r.action[0]}`).join(' '), '4p 3p 2d 1p');
  assert.deepEqual([ed.stale, ed.past.length, ed.plan.head], [null, 0, SHA('4')]);
  assert.deepEqual(planCalls(s.api).slice(-1), [{ upstream: 'refs/heads/main', interactive: true }]);
  assert.deepEqual(s.notices(), ['Plan reloaded']);
  // commits that left the range are counted; an empty range closes the editor
  n = 3;
  const t = await opened({ handlers: { rebasePlan: () => plan({ n }) } });
  n = 2;
  await t.F.reloadInteractiveRebase(t.store);
  assert.deepEqual(t.notices(), ['Plan reloaded: 1 commit is no longer in the range']);
  n = 0;
  assert.equal(await t.F.reloadInteractiveRebase(t.store), false);
  assert.equal(t.store.state.rebaseEditor, null);
  assert.match(t.notices()[1], /no commits of its own to rebase onto main any more/);
});

test('cancelInteractiveRebase: closes at once when unchanged; asks when changed (Keep Editing keeps it); works while busy', async () => {
  const s = await opened();
  assert.equal(await s.F.cancelInteractiveRebase(s.store), true);
  assert.equal(s.store.state.rebaseEditor, null);
  assert.deepEqual(s.dialogs, []);
  const t = await opened();
  edit(t, (m) => t.R.move(m, SHA('1'), -1));
  t.store.set({ busy: true });
  assert.equal(await t.F.cancelInteractiveRebase(t.store), false, 'kept');
  assert.equal(t.dialogs[0].opts.title, 'Discard your rebase plan?');
  assert.equal(t.dialogs[0].opts.cancelLabel, 'Keep Editing');
  assert.ok(t.store.state.rebaseEditor);
  H.scriptDialogs(t.win, [true]);
  assert.equal(await t.F.cancelInteractiveRebase(t.store), true);
  assert.equal(t.store.state.rebaseEditor, null);
  assert.equal(await t.F.cancelInteractiveRebase(t.store), false, 'nothing open');
});

test('store rebaseEditor: editRebase records undo, undoRebaseEdit / redoRebaseEdit walk it, resetRebaseEditor clears both, a new repo drops the editor', async () => {
  const s = await opened();
  const a = s.store.state.rebaseEditor.model;
  assert.equal(edit(s, (m) => s.R.setAction(m, SHA('1'), 'drop')), true);
  assert.equal(edit(s, (m) => m), false, 'unchanged: not recorded');
  assert.equal(edit(s, (m) => s.R.move(m, SHA('1'), -1)), true);
  assert.equal(s.store.state.rebaseEditor.past.length, 2);
  assert.equal(s.store.actions.undoRebaseEdit(), true);
  assert.equal(s.store.state.rebaseEditor.model.rows[2].action, 'drop');
  assert.equal(s.store.actions.undoRebaseEdit(), true);
  assert.equal(s.store.state.rebaseEditor.model, a);
  assert.equal(s.store.actions.undoRebaseEdit(), false, 'empty stack');
  // redo walks forward again; a new edit clears it
  assert.equal(s.store.state.rebaseEditor.future.length, 2);
  assert.equal(s.store.actions.redoRebaseEdit(), true);
  assert.equal(s.store.state.rebaseEditor.model.rows[2].action, 'drop');
  assert.equal(s.store.actions.redoRebaseEdit(), true);
  assert.equal(s.store.actions.redoRebaseEdit(), false, 'nothing left to redo');
  assert.equal(s.store.actions.undoRebaseEdit(), true);
  edit(s, (m) => s.R.setAction(m, SHA('2'), 'drop'));
  assert.deepEqual([s.store.state.rebaseEditor.future.length, s.store.actions.redoRebaseEdit()], [0, false]);
  s.store.actions.patchRebaseEditor({ running: true });
  assert.equal(s.store.actions.undoRebaseEdit(), false, 'locked while running');
  s.store.actions.patchRebaseEditor({ running: false });
  edit(s, (m) => s.R.setAction(m, SHA('1'), 'drop'));
  s.store.actions.undoRebaseEdit();
  assert.equal(s.store.actions.resetRebaseEditor(), true);
  assert.deepEqual([s.R.changed(s.store.state.rebaseEditor.model), s.store.state.rebaseEditor.past.length, s.store.state.rebaseEditor.future.length], [false, 0, 0]);
  for (let i = 0; i < 120; i++) edit(s, (m) => s.R.setAction(m, SHA('1'), i % 2 ? 'pick' : 'drop'));
  assert.equal(s.store.state.rebaseEditor.past.length, 100, 'capped');
  assert.equal(s.store.actions.openRebaseEditor({}), false, 'no plan');
  const p = s.store.actions.loadRepo({ root: '/other', name: 'o' });
  assert.equal(s.store.state.rebaseEditor, null);
  await p.catch(() => {});
});

// ------------------------------------------------------------------ second review: the plan belongs to its branch

test('another branch checked out at the same sha while the editor is open: Start refuses (no rebase of it), Reload too; back on feat it starts with expectBranch', async () => {
  const s = await opened({ handlers: { rebaseInteractive: () => ({ status: 'done', branch: 'feat', published: 0, dropped: [] }) }, answers: [true, true] });
  edit(s, (m) => s.R.setAction(m, SHA('3'), 'drop'));
  // the sidebar checks out feat2, which points at the same commit
  s.data.status = { ...s.data.status, branch: 'feat2' };
  await s.store.actions.refresh();
  await H.flush();
  assert.equal(s.store.state.status.oid, SHA('3'), 'HEAD did not move');
  const why = 'This plan is for feat, which is no longer checked out: check it out again, or cancel the plan';
  assert.equal(await s.F.startInteractiveRebase(s.store), false);
  assert.deepEqual(s.notices(), [why]);
  assert.equal(await s.F.reloadInteractiveRebase(s.store), false, 'Reload would read feat2\'s commits');
  assert.deepEqual(s.notices(), [why, why]);
  assert.equal(planCalls(s.api).length, 1, 'the plan was not re-read');
  // a detached HEAD at the same commit is another place too
  s.data.status = { ...s.data.status, branch: null, detached: true };
  await s.store.actions.refresh();
  await H.flush();
  assert.equal(await s.F.startInteractiveRebase(s.store), false);
  assert.deepEqual(s.ops(), [], 'nothing ran');
  assert.deepEqual(s.dialogs, [], 'refused before any dialog');
  // back on feat: it starts, telling the backend which branch the plan is for
  s.data.status = { ...s.data.status, branch: 'feat', detached: false };
  await s.store.actions.refresh();
  await H.flush();
  assert.equal(await s.F.startInteractiveRebase(s.store), true);
  const call = s.api.calls.find((c) => c.op === 'rebaseInteractive');
  assert.deepEqual([call.args[2].expectHead, call.args[2].expectBranch], [SHA('3'), 'feat']);
});

test('a plan read on a detached HEAD sends expectBranch null; the backend\'s stale refusal keeps the editor open with the reload prompt', async () => {
  const s = await setup({
    data: { st: { branch: null, detached: true } },
    handlers: { rebasePlan: () => plan({ extra: { branch: null } }), rebaseInteractive: () => { throw err('stale', 'HEAD or the branch changed'); } },
    answers: [true],
  });
  assert.equal(await s.F.interactiveRebase(s.store, { upstream: 'refs/heads/main' }), true);
  edit(s, (m) => s.R.setAction(m, SHA('3'), 'drop'));
  assert.equal(await s.F.startInteractiveRebase(s.store), false);
  assert.equal(s.api.calls.find((c) => c.op === 'rebaseInteractive').args[2].expectBranch, null);
  assert.equal(s.store.state.rebaseEditor.stale, s.R.STALE_PLAN);
  assert.deepEqual(s.notices(), [s.R.STALE_PLAN]);
  assert.equal(s.errors().length, 0);
});

test('the Start flow and the editor share one check (PLRebase.planBlocker), a pending autostash included', () => {
  const win = H.loadRenderer();
  const R = win.PLRebase;
  const ed = { plan: plan(), stale: null };
  const st = (o = {}) => H.status({ oid: SHA('3'), branch: 'feat', ...o });
  assert.equal(R.planBlocker(ed, st()), null);
  assert.deepEqual(R.planBlocker(ed, st({ oid: SHA('9') })), { text: R.STALE_PLAN, reload: true });
  assert.equal(R.planBlocker(ed, st({ branch: 'feat2' })).reload, false);
  assert.equal(R.planBlocker(ed, st({ branch: null })).text, 'This plan is for feat, which is no longer checked out: check it out again, or cancel the plan');
  assert.equal(R.planBlocker({ plan: plan({ extra: { branch: null } }) }, st()).text, 'This plan is for a detached HEAD, which is no longer checked out: check it out again, or cancel the plan');
  assert.deepEqual(R.planBlocker(ed, st({ pendingAutostash: SHA('7') })), { text: 'Interactive rebase — restore or keep the stash left over from the last rebase first (see the banner)', reload: false });
  assert.match(R.planBlocker(ed, st({ state: 'merging' })).text, /^A merge is in progress/);
  assert.equal(R.planBlocker({ ...ed, stale: 'x' }, st()).text, 'x');
  assert.equal(R.limitOf({ limit: 250 }), 250);
  assert.equal(R.limitOf({}), R.MAX_ROWS);
  assert.equal(R.fromPlan({ ...plan({ n: 5 }), limit: 2 }).rows.length, 2, 'the plan\'s limit caps the rows');
});
