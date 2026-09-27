'use strict';
// docs/plans/rebase.md R2, renderer half: the merge / rebase menu builders (Components.actions
// refMenuItems / commitOpItems, the graph's ref pills), the loaded-history ancestor sets they gate
// on (window.Store.ancestorsOf / headAncestors), and the keep-a-side model (PLOp.resolveChoices).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const ACTIONS = require.resolve('../renderer/actions.js');
const GRAPH = require.resolve('../renderer/components/graph-view.js');
const SHA = (c) => c.repeat(40);

function load() {
  const win = H.loadRenderer();
  delete require.cache[ACTIONS];
  const A = require(ACTIONS);
  delete require.cache[GRAPH];
  const G = require(GRAPH);
  return { win, A, G, Op: win.PLOp, Store: win.Store };
}

const FLOWS = ['checkout', 'createBranch', 'deleteBranch', 'push', 'fetch', 'setUpstream', 'merge', 'rebase', 'interactiveRebase'];
const flows = Object.fromEntries(FLOWS.map((n) => [n, async () => true]));
const labels = (items) => items.map((d) => (d.separator ? '---' : d.label));
const byLabel = (items, label) => items.find((d) => d.label === label);

/**
 * main (current) at a tracking origin/main (at b); feat at e (e -> b); old at c (in main's history);
 * tag v1 at c, tag next at e. History: a -> b -> c, e -> b.
 */
function state(extra = {}) {
  const commits = [H.commit(SHA('e'), [SHA('b')]), H.commit(SHA('a'), [SHA('b')]), H.commit(SHA('b'), [SHA('c')]), H.commit(SHA('c'))];
  return {
    repo: { root: '/r', name: 'r' }, busy: false, remotes: ['origin'],
    status: { ...H.status({ oid: SHA('a') }), upstream: 'origin/main' },
    refs: H.refs({
      head: { branch: 'main', oid: SHA('a'), detached: false },
      local: [
        { name: 'main', oid: SHA('a'), upstream: 'origin/main', ahead: 1, behind: 0, gone: false, current: true },
        { name: 'feat', oid: SHA('e'), upstream: null, ahead: 0, behind: 0, gone: false, current: false },
        { name: 'old', oid: SHA('c'), upstream: null, ahead: 0, behind: 0, gone: false, current: false },
      ],
      remote: [{ name: 'origin/main', remote: 'origin', branch: 'main', oid: SHA('b') }, { name: 'origin/feat', remote: 'origin', branch: 'feat', oid: SHA('e') }],
      tags: [{ name: 'v1', oid: SHA('c') }, { name: 'next', oid: SHA('e') }],
    }),
    commits,
    refsBySha: new Map(),
    ...extra,
  };
}
const ref = (kind, name, s = state()) => {
  const list = { local: s.refs.local, remote: s.refs.remote, tag: s.refs.tags }[kind];
  const r = list.find((x) => x.name === name);
  const t = { kind, name, oid: r.oid, current: kind === 'local' && !!r.current };
  if (kind === 'remote') t.remote = r.remote;
  return t;
};
const pick = (items, label) => { const d = byLabel(items, label); assert.ok(d, `missing ${label}`); return [d.flow, d.args, !!d.disabled, d.title]; };

// ------------------------------------------------------------------ ancestors over the loaded history

test('Store.ancestorsOf / headAncestors: parents walked over the loaded commits, itself included; null when not loaded', () => {
  const { Store } = load();
  const s = state();
  assert.deepEqual([...Store.ancestorsOf(s.commits, SHA('a'))].sort(), [SHA('a'), SHA('b'), SHA('c')]);
  assert.deepEqual([...Store.ancestorsOf(s.commits, SHA('e'))].sort(), [SHA('b'), SHA('c'), SHA('e')]);
  assert.equal(Store.ancestorsOf(s.commits, SHA('9')), null, 'not loaded');
  assert.equal(Store.ancestorsOf(s.commits, SHA('a')), Store.ancestorsOf(s.commits, SHA('a')), 'cached per commits array');
  assert.equal(Store.ancestorsOf(null, SHA('a')), null);
  assert.deepEqual([...Store.headAncestors(s)].sort(), [SHA('a'), SHA('b'), SHA('c')]);
  assert.equal(Store.headAncestors({ ...s, status: H.status(), refs: H.refs() }), null, 'unborn');
  // a page not loaded yet: the walk stops at the edge of the loaded history
  const partial = [H.commit(SHA('a'), [SHA('b')])];
  assert.deepEqual([...Store.ancestorsOf(partial, SHA('a'))], [SHA('a')]);
});

test('Store.tipsContaining: which tips reach each loaded commit, from one walk (more than 32 tips); null when a tip is not loaded', () => {
  const { Store } = load();
  // c <- b <- a (main), b <- e (side); 40 remote tips: r0..r37 at a, r38 at e, r39 at c
  const commits = [H.commit(SHA('a'), [SHA('b')]), H.commit(SHA('e'), [SHA('b')]), H.commit(SHA('b'), [SHA('c')]), H.commit(SHA('c'))];
  const tips = Array.from({ length: 40 }, (_, i) => ({ name: `r${i}`, oid: i < 38 ? SHA('a') : i === 38 ? SHA('e') : SHA('c') }));
  const on = Store.tipsContaining(commits, tips);
  assert.equal(on(SHA('a')).length, 38);
  assert.deepEqual(on(SHA('e')), ['r38']);
  assert.equal(on(SHA('b')).length, 39, 'every tip but the one at c');
  assert.equal(on(SHA('c')).length, 40);
  assert.deepEqual(on(SHA('9')), [], 'not loaded');
  assert.equal(Store.tipsContaining(commits, [...tips, { name: 'far', oid: SHA('8') }]), null, 'a tip outside the loaded history');
  assert.deepEqual(Store.tipsContaining(commits, [])(SHA('a')), []);
});

test('store.headAncestors() / ancestorsOf(sha) follow the loaded history', async () => {
  const { store } = await H.loadedStore(H.repoData({ commits: H.chain([SHA('a'), SHA('b')]), status: H.status({ oid: SHA('a') }) }));
  assert.deepEqual([...store.headAncestors()].sort(), [SHA('a'), SHA('b')]);
  assert.deepEqual([...store.ancestorsOf(SHA('b'))], [SHA('b')]);
  assert.equal(store.ancestorsOf(SHA('f')), null);
});

// ------------------------------------------------------------------ sidebar / pill menus

test('refMenuItems: another local branch — Merge it into / Rebase the current branch onto it; never "Rebase it onto the current branch"', () => {
  const { A } = load();
  const s = state();
  const items = A.refMenuItems(ref('local', 'feat'), s, flows);
  assert.deepEqual(labels(items), [
    'Checkout', 'Push', 'Create branch here…', 'Set upstream…', '---',
    'Merge feat into main', 'Rebase main onto feat', 'Interactive Rebase main onto feat', '---', 'Delete',
  ]);
  assert.equal(items.filter((d) => d.flow === 'rebase').length, 1, 'one plain rebase, the current branch moving');
  assert.deepEqual(pick(items, 'Interactive Rebase main onto feat').slice(0, 3), ['interactiveRebase', [{ upstream: 'refs/heads/feat', expectHead: SHA('a') }], false]);
  assert.deepEqual(pick(items, 'Merge feat into main').slice(0, 3), ['merge', [{ target: 'refs/heads/feat', expectHead: SHA('a') }], false]);
  assert.deepEqual(pick(items, 'Rebase main onto feat').slice(0, 3), ['rebase', [{ onto: 'refs/heads/feat', expectHead: SHA('a') }], false]);
  assert.ok(!items.some((d) => d.flow === 'rebase' && d.args[0].branch), 'nothing checks the other branch out to rebase it');
});

test('refMenuItems: no-ops the loaded history shows are disabled with the reason', () => {
  const { A } = load();
  const s = state();
  const old = A.refMenuItems(ref('local', 'old'), s, flows); // c: in main's history
  assert.deepEqual(pick(old, 'Merge old into main').slice(2), [true, 'main already contains old']);
  assert.deepEqual(pick(old, 'Rebase main onto old').slice(2), [true, 'main is already based on old']);
  assert.ok(!byLabel(old, 'Rebase old onto main…'), 'no reverse rebase');
  // a branch already on top of HEAD: merging it fast-forwards, rebasing onto it moves main up to it
  const ahead = state();
  ahead.refs.local.push({ name: 'top', oid: SHA('f'), upstream: null, current: false });
  ahead.commits = [H.commit(SHA('f'), [SHA('a')]), ...ahead.commits];
  const top = A.refMenuItems(ref('local', 'top', ahead), ahead, flows);
  assert.equal(pick(top, 'Merge top into main')[2], false, 'a fast-forward merge is fine');
  assert.deepEqual(pick(top, 'Rebase main onto top').slice(2), [false, "Replay main's own commits on top of top"]);
  // a target outside the loaded history is left to the backend (it answers up-to-date)
  const unknown = { kind: 'local', name: 'far', oid: SHA('9'), current: false };
  assert.equal(pick(A.refMenuItems(unknown, s, flows), 'Merge far into main')[2], false);
});

/**
 * The user's case: feat (current, at f) branched from local main (m); main tracks origin/main (o2),
 * 2 commits ahead of it. History: f -> m, o2 -> o1 -> m.
 */
function behindState(extra = {}) {
  return {
    repo: { root: '/r', name: 'r' }, busy: false, remotes: ['origin'],
    status: { ...H.status({ oid: SHA('f') }), branch: 'feat', upstream: null },
    refs: H.refs({
      head: { branch: 'feat', oid: SHA('f'), detached: false },
      local: [
        { name: 'feat', oid: SHA('f'), upstream: null, ahead: 0, behind: 0, gone: false, current: true },
        { name: 'main', oid: SHA('1'), upstream: 'origin/main', ahead: 0, behind: 2, gone: false, current: false },
      ],
      remote: [{ name: 'origin/main', remote: 'origin', branch: 'main', oid: SHA('3') }],
    }),
    commits: [H.commit(SHA('3'), [SHA('2')]), H.commit(SHA('f'), [SHA('1')]), H.commit(SHA('2'), [SHA('1')]), H.commit(SHA('1'))],
    refsBySha: new Map(),
    ...extra,
  };
}

test('refMenuItems: a local branch behind its upstream — the no-op says so and points at the upstream, which is offered enabled', () => {
  const { A } = load();
  const s = behindState();
  const main = { kind: 'local', name: 'main', oid: SHA('1'), current: false };
  const items = A.refMenuItems(main, s, flows);
  assert.deepEqual(labels(items), [
    'Checkout', 'Push', 'Create branch here…', 'Set upstream…', '---',
    'Merge main into feat', 'Rebase feat onto main', 'Interactive Rebase feat onto main', '---', 'Delete',
  ]);
  assert.deepEqual(pick(items, 'Rebase feat onto main').slice(2),
    [true, 'feat is already based on main — main is 2 behind origin/main: rebase onto origin/main instead']);
  assert.deepEqual(pick(items, 'Merge main into feat').slice(2),
    [true, 'feat already contains main — main is 2 behind origin/main: merge origin/main instead']);
  assert.equal(pick(items, 'Interactive Rebase feat onto main')[2], false, 'edits main..feat');

  const remote = A.refMenuItems({ kind: 'remote', name: 'origin/main', oid: SHA('3'), current: false, remote: 'origin' }, s, flows);
  assert.deepEqual(labels(remote), ['Checkout', 'Create branch here…', 'Fetch origin', '---', 'Merge origin/main into feat', 'Rebase feat onto origin/main', 'Interactive Rebase feat onto origin/main']);
  assert.deepEqual(pick(remote, 'Rebase feat onto origin/main'), ['rebase', [{ onto: 'refs/remotes/origin/main', expectHead: SHA('f') }], false, "Replay feat's own commits on top of origin/main"]);
  assert.equal(pick(remote, 'Merge origin/main into feat')[2], false);
  assert.equal(pick(remote, 'Interactive Rebase feat onto origin/main')[2], false);

  // up to date with its upstream, gone, or not a no-op: the plain reason / no reason
  const even = behindState();
  even.refs.local[1] = { ...even.refs.local[1], behind: 0 };
  assert.equal(pick(A.refMenuItems(main, even, flows), 'Rebase feat onto main')[3], 'feat is already based on main');
  const gone = behindState();
  gone.refs.local[1] = { ...gone.refs.local[1], gone: true };
  assert.equal(pick(A.refMenuItems(main, gone, flows), 'Rebase feat onto main')[3], 'feat is already based on main');
  const moved = behindState();
  moved.refs.local[1] = { ...moved.refs.local[1], oid: SHA('2'), behind: 1 };
  assert.deepEqual(pick(A.refMenuItems({ ...main, oid: SHA('2') }, moved, flows), 'Rebase feat onto main').slice(2), [false, "Replay feat's own commits on top of main"]);
  // in progress: "finish or abort … first" wins, without the hint
  const mid = behindState({ status: { ...behindState().status, state: 'merging', merge: { head: SHA('3'), name: 'x', message: 'm' } } });
  assert.deepEqual(pick(A.refMenuItems(main, mid, flows), 'Rebase feat onto main').slice(2), [true, 'Rebase — finish or abort the merge first']);
});

test('the user\'s case through Components.menu: the disabled rebase / merge onto main show why, without hovering', () => {
  const dom = H.fakeDom().install();
  const win = H.loadFlows();
  dom.attach(win);
  const A = win.Components.actions;
  const s = behindState();
  const store = { state: s, actions: {} };
  const descs = A.refMenuItems({ kind: 'local', name: 'main', oid: SHA('1'), current: false }, s, flows);
  const root = win.Components.menu.open({ x: 0, y: 0 }, A.toMenuItems(descs, store, flows));
  const shown = root.children.filter((n) => n.getAttribute('role') === 'menuitem').map((n) => {
    const hint = n.children.find((c) => c.classList.contains('pl-menu-hint'));
    return [n.children.find((c) => c.classList.contains('pl-menu-label')).textContent, n.getAttribute('aria-disabled') === 'true', hint ? hint.textContent : null];
  });
  assert.deepEqual(shown, [
    ['Checkout', false, null], ['Push', false, null], ['Create branch here…', false, null], ['Set upstream…', false, null],
    ['Merge main into feat', true, 'feat already contains main — main is 2 behind origin/main: merge origin/main instead'],
    ['Rebase feat onto main', true, 'feat is already based on main — main is 2 behind origin/main: rebase onto origin/main instead'],
    ['Interactive Rebase feat onto main', false, null],
    ['Delete', false, null],
  ]);
  win.Components.menu.close();
});

test('refMenuItems: the current branch offers Rebase onto its upstream (disabled when gone or up to date); no merge into itself', () => {
  const { A } = load();
  const s = state();
  const cur = A.refMenuItems(ref('local', 'main'), s, flows);
  assert.deepEqual(labels(cur), ['Checkout', 'Push', 'Create branch here…', 'Set upstream…', '---', 'Rebase main onto origin/main', 'Interactive Rebase main onto origin/main', '---', 'Delete']);
  // origin/main (b) is in main's history: a plain rebase is a no-op, an interactive one edits b..main
  assert.deepEqual(pick(cur, 'Interactive Rebase main onto origin/main').slice(0, 3), ['interactiveRebase', [{ upstream: 'refs/remotes/origin/main', expectHead: SHA('a') }], false]);
  assert.deepEqual(pick(cur, 'Rebase main onto origin/main').slice(0, 3), ['rebase', [{ onto: 'refs/remotes/origin/main', expectHead: SHA('a') }], true]);
  assert.equal(pick(cur, 'Rebase main onto origin/main')[3], 'main is already based on origin/main', 'origin/main (b) is in main');

  const behind = state();
  behind.refs.remote[0] = { ...behind.refs.remote[0], oid: SHA('e') };
  assert.deepEqual(pick(A.refMenuItems(ref('local', 'main', behind), behind, flows), 'Rebase main onto origin/main').slice(2), [false, "Replay main's own commits on top of origin/main"]);

  const gone = state();
  gone.refs.local[0] = { ...gone.refs.local[0], gone: true };
  gone.refs.remote = gone.refs.remote.slice(1);
  assert.deepEqual(pick(A.refMenuItems(ref('local', 'main', gone), gone, flows), 'Rebase main onto origin/main').slice(2), [true, 'The upstream origin/main is gone']);
  assert.deepEqual(pick(A.refMenuItems(ref('local', 'main', gone), gone, flows), 'Interactive Rebase main onto origin/main').slice(2), [true, 'The upstream origin/main is gone']);

  const noUp = state();
  noUp.refs.local[0] = { ...noUp.refs.local[0], upstream: null };
  assert.deepEqual(labels(A.refMenuItems(ref('local', 'main', noUp), noUp, flows)), ['Checkout', 'Push', 'Create branch here…', 'Set upstream…', '---', 'Delete']);
});

test('refMenuItems: remote branches and tags; names are display-safe in labels and raw in the args', () => {
  const { A } = load();
  const s = state();
  const remote = A.refMenuItems(ref('remote', 'origin/feat'), s, flows);
  assert.deepEqual(labels(remote), ['Checkout', 'Create branch here…', 'Fetch origin', '---', 'Merge origin/feat into main', 'Rebase main onto origin/feat', 'Interactive Rebase main onto origin/feat']);
  assert.deepEqual(pick(remote, 'Interactive Rebase main onto origin/feat')[1], [{ upstream: 'refs/remotes/origin/feat', expectHead: SHA('a') }]);
  assert.deepEqual(pick(remote, 'Merge origin/feat into main')[1], [{ target: 'refs/remotes/origin/feat', expectHead: SHA('a') }]);
  const tag = A.refMenuItems(ref('tag', 'next'), s, flows);
  assert.deepEqual(labels(tag), ['Checkout', 'Create branch here…', '---', 'Rebase main onto next', 'Interactive Rebase main onto next', 'Merge next into main']);
  assert.deepEqual(pick(tag, 'Rebase main onto next')[1], [{ onto: 'refs/tags/next', expectHead: SHA('a') }]);
  const evil = { kind: 'local', name: 'x\u202ey', oid: SHA('e'), current: false };
  const e = A.refMenuItems(evil, s, flows);
  assert.ok(byLabel(e, 'Merge x\\u{202E}y into main'), 'label made safe');
  assert.deepEqual(byLabel(e, 'Merge x\\u{202E}y into main').args, [{ target: 'refs/heads/x\u202ey', expectHead: SHA('a') }]);
});

test('refMenuItems: detached HEAD, unborn, in progress, busy and a missing flow', () => {
  const { A } = load();
  const det = state({ status: { ...H.status({ oid: SHA('a') }), branch: null } });
  det.refs = { ...det.refs, head: { branch: null, oid: SHA('a'), detached: true }, local: det.refs.local.map((b) => ({ ...b, current: false })) };
  const d = A.refMenuItems(ref('local', 'feat', det), det, flows);
  assert.ok(byLabel(d, 'Merge feat into HEAD'));
  assert.deepEqual(pick(d, 'Rebase HEAD onto feat')[1], [{ onto: 'refs/heads/feat', expectHead: SHA('a') }], 'the detached HEAD moves');

  const unborn = state({ status: H.status(), refs: H.refs({ local: [{ name: 'feat', oid: SHA('e'), current: false }] }), commits: [] });
  const u = A.refMenuItems({ kind: 'local', name: 'feat', oid: SHA('e'), current: false }, unborn, flows);
  assert.deepEqual(pick(u, 'Merge feat into main').slice(2), [true, 'Merge — main has no commits yet']);
  assert.deepEqual(pick(u, 'Rebase main onto feat').slice(2), [true, 'Rebase — main has no commits yet']);

  const mid = state({ status: { ...H.status({ oid: SHA('a') }), state: 'merging', merge: { head: SHA('e'), name: 'feat', message: 'm' } } });
  const m = A.refMenuItems(ref('local', 'old', mid), mid, flows);
  for (const l of ['Merge old into main', 'Rebase main onto old']) {
    assert.deepEqual(pick(m, l).slice(2), [true, `${l.startsWith('Merge') ? 'Merge' : 'Rebase'} — finish or abort the merge first`], l);
  }
  const busy = A.refMenuItems(ref('local', 'feat'), state({ busy: true }), flows);
  assert.deepEqual(pick(busy, 'Merge feat into main').slice(2), [true, A.BUSY_TITLE]);
  const noFlows = A.refMenuItems(ref('local', 'feat'), state(), { ...flows, merge: undefined });
  assert.deepEqual(pick(noFlows, 'Merge feat into main').slice(2), [true, 'Not available']);
  assert.deepEqual(A.refMenuItems(null, state(), flows), []);
  assert.deepEqual(A.refMenuItems({ kind: 'stash' }, state(), flows), []);
});

test('commitOpItems: Rebase onto this commit / Merge this commit for commits outside HEAD’s history only', () => {
  const { A } = load();
  const s = state();
  const e = A.commitOpItems(SHA('e'), s);
  assert.deepEqual(e.map((d) => [d.label, d.flow, d.args]), [
    ['Rebase main onto this commit', 'rebase', [{ onto: SHA('e'), expectHead: SHA('a') }]],
    ['Interactive Rebase main onto this commit', 'interactiveRebase', [{ upstream: SHA('e'), expectHead: SHA('a') }]],
    ['Merge this commit into main', 'merge', [{ target: SHA('e'), expectHead: SHA('a') }]],
  ]);
  assert.deepEqual(A.commitOpItems(SHA('a'), s), [], 'HEAD itself: nothing');
  // in main's history: "Interactive Rebase <n> children of <sha7>" only
  assert.deepEqual(A.commitOpItems(SHA('b'), s).map((d) => [d.label, d.flow, d.args, !!d.disabled]),
    [['Interactive Rebase 1 child of bbbbbbb', 'interactiveRebase', [{ upstream: SHA('b'), expectHead: SHA('a') }], false]]);
  assert.deepEqual(A.commitOpItems(SHA('c'), s).map((d) => d.label), ['Interactive Rebase 2 children of ccccccc']);
  assert.deepEqual(A.commitOpItems('abc', s), [], 'not a full sha');
  assert.deepEqual(A.commitOpItems(SHA('e'), state({ status: H.status(), refs: H.refs() })), [], 'unborn');
  assert.equal(A.commitOpItems(SHA('9'), s).length, 3, 'outside the loaded history: offered (the backend re-checks)');
});

test('interactive rebase items (R3): no-ops, merges and the 500-commit limit in the range, detached, busy and in progress', () => {
  const { A, G } = load();
  const s = state();
  // a branch whose history contains HEAD has nothing of main's own to edit
  const ahead = state();
  ahead.refs.local.push({ name: 'top', oid: SHA('f'), upstream: null, current: false });
  ahead.commits = [H.commit(SHA('f'), [SHA('a')]), ...ahead.commits];
  assert.deepEqual(pick(A.refMenuItems(ref('local', 'top', ahead), ahead, flows), 'Interactive Rebase main onto top').slice(2),
    [true, 'main has no commits of its own to rebase onto top']);
  // onto a branch already in main's history: allowed (edits old..main)
  assert.equal(pick(A.refMenuItems(ref('local', 'old'), s, flows), 'Interactive Rebase main onto old')[2], false);

  // children of: a merge commit in the range disables it with the reason
  const merged = state();
  merged.status = { ...merged.status, oid: SHA('m') };
  merged.refs = { ...merged.refs, head: { branch: 'main', oid: SHA('m'), detached: false } };
  merged.commits = [H.commit(SHA('m'), [SHA('a'), SHA('e')]), ...merged.commits];
  const [d] = A.commitOpItems(SHA('b'), merged);
  assert.equal(d.label, 'Interactive Rebase 3 children of bbbbbbb');
  assert.equal(d.disabled, true);
  assert.match(d.title, /include 1 merge commit: interactive rebase can't keep merges yet/);
  assert.equal(A.commitOpItems(SHA('a'), merged)[0].disabled, true, 'm is a merge');

  // more than 500 commits after it
  const hashes = Array.from({ length: 502 }, (_, i) => i.toString(16).padStart(40, '0'));
  const long = state({ commits: H.chain(hashes) });
  long.status = { ...long.status, oid: hashes[0] };
  long.refs = { ...long.refs, head: { branch: 'main', oid: hashes[0], detached: false } };
  const [far] = A.commitOpItems(hashes[501], long);
  assert.equal(far.label, `Interactive Rebase 501 children of ${hashes[501].slice(0, 7)}`);
  assert.deepEqual([far.disabled, far.title], [true, `Interactive rebase is limited to 500 commits (there are 501 after ${hashes[501].slice(0, 7)})`]);
  assert.equal(A.commitOpItems(hashes[500], long)[0].disabled, undefined, '500 is fine');

  // detached HEAD: "HEAD" in the label; unborn: disabled
  const det = state({ status: { ...H.status({ oid: SHA('a') }), branch: null } });
  det.refs = { ...det.refs, head: { branch: null, oid: SHA('a'), detached: true }, local: det.refs.local.map((b) => ({ ...b, current: false })) };
  assert.ok(byLabel(A.refMenuItems(ref('local', 'feat', det), det, flows), 'Interactive Rebase HEAD onto feat'));
  const unborn = state({ status: H.status(), refs: H.refs({ local: [{ name: 'feat', oid: SHA('e'), current: false }] }), commits: [] });
  assert.deepEqual(pick(A.refMenuItems({ kind: 'local', name: 'feat', oid: SHA('e'), current: false }, unborn, flows), 'Interactive Rebase main onto feat').slice(2),
    [true, 'Interactive rebase — main has no commits yet']);

  // in progress: gated like every start ("finish or abort … first"); busy: Working…; no flow: Not available
  const mid = state({ status: { ...H.status({ oid: SHA('a') }), state: 'rebasing', rebase: H.rebaseState() } });
  assert.deepEqual(pick(A.refMenuItems(ref('local', 'feat', mid), mid, flows), 'Interactive Rebase main onto feat').slice(2),
    [true, 'Interactive rebase — finish or abort the rebase first']);
  const row = { kind: 'commit', commit: s.commits.find((c) => c.hash === SHA('c')) };
  const midMenu = G.commitMenuItems(row, { ...mid, commits: s.commits }, flows);
  assert.deepEqual(pick(midMenu, 'Interactive Rebase 2 children of ccccccc').slice(2), [true, 'Interactive rebase — finish or abort the rebase first']);
  assert.deepEqual(pick(A.refMenuItems(ref('local', 'feat'), state({ busy: true }), flows), 'Interactive Rebase main onto feat').slice(2), [true, A.BUSY_TITLE]);
  assert.deepEqual(pick(A.refMenuItems(ref('local', 'feat'), s, { ...flows, interactiveRebase: undefined }), 'Interactive Rebase main onto feat').slice(2), [true, 'Not available']);
  // the graph row menu of a commit in HEAD's history runs the flow with the commit as upstream
  const menu = G.commitMenuItems(row, s, flows);
  assert.deepEqual(labels(menu), ['Checkout this commit', 'Create branch here…', '---', 'Interactive Rebase 2 children of ccccccc']);
  assert.deepEqual(pick(menu, 'Interactive Rebase 2 children of ccccccc').slice(0, 3), ['interactiveRebase', [{ upstream: SHA('c'), expectHead: SHA('a') }], false]);
});

test('graph pills: pillTarget keeps raw names; pillMenuItems is the ref menu; HEAD pills have none', () => {
  const { G, A } = load();
  const s = state();
  const pills = G.refPills([
    { type: 'head', name: 'HEAD' },
    { type: 'local', name: 'feat', current: false, upstream: 'origin/feat' },
    { type: 'remote', name: 'origin/feat', remote: 'origin', branch: 'feat' },
    { type: 'remote', name: 'up/x', remote: 'up', branch: 'x' },
    { type: 'tag', name: 'next' },
  ], new Map());
  const [head, local, remote, tag] = pills;
  const row = { kind: 'commit', commit: { hash: SHA('e'), parents: [SHA('b')] } };
  assert.equal(G.pillTarget(head, SHA('e')), null);
  assert.deepEqual(G.pillTarget(local, SHA('e')), { kind: 'local', name: 'feat', oid: SHA('e'), current: false });
  assert.deepEqual(G.pillTarget(remote, SHA('e')), { kind: 'remote', name: 'up/x', oid: SHA('e'), current: false, remote: 'up' });
  assert.deepEqual(G.pillTarget(tag, SHA('e')), { kind: 'tag', name: 'next', oid: SHA('e'), current: false });
  assert.deepEqual(labels(G.pillMenuItems(local, row, s, flows)), labels(A.refMenuItems(ref('local', 'feat'), s, flows)));
  assert.deepEqual(labels(G.pillMenuItems(tag, row, s, flows)), ['Checkout', 'Create branch here…', '---', 'Rebase main onto next', 'Interactive Rebase main onto next', 'Merge next into main']);
  assert.deepEqual(G.pillMenuItems(head, row, s, flows), []);
  assert.deepEqual(G.pillMenuItems(local, { kind: 'wip' }, s, flows), []);
});

// ------------------------------------------------------------------ keep a side (PLOp.resolveChoices)

test('resolveChoices: rebase names onto and the replayed commit; merge names the branches; nothing otherwise', () => {
  const { Op } = load();
  const entry = H.conflict('w.txt');
  const rb = H.status({ oid: SHA('e'), branch: null, state: 'rebasing', rebase: H.rebaseState(), conflicted: [entry] });
  assert.deepEqual(Op.resolveChoices(rb, new Map(), entry).map((c) => [c.side, c.label]), [['ours', "Keep main's version"], ['theirs', "Keep ddddddd's version"]]);
  assert.equal(Op.resolveChoices(rb, new Map(), entry)[0].title, "Keep main's version of the file and mark it resolved");
  // onto named from the refs when meta.json has no name; a full refname is shown short
  const noName = { ...rb, rebase: H.rebaseState({ ontoName: null }) };
  assert.equal(Op.resolveChoices(noName, new Map([[SHA('b'), [{ type: 'remote', name: 'origin/dev' }]]]), entry)[0].label, "Keep origin/dev's version");
  assert.equal(Op.resolveChoices({ ...rb, rebase: H.rebaseState({ ontoName: 'refs/heads/dev' }) }, null, entry)[0].label, "Keep dev's version");

  const mg = H.status({ oid: SHA('a'), branch: 'main', state: 'merging', merge: { head: SHA('f'), name: 'refs/remotes/origin/x', message: 'm' }, conflicted: [entry] });
  assert.deepEqual(Op.resolveChoices(mg, null, entry).map((c) => c.label), ["Keep main's version", "Keep origin/x's version"]);
  const noMergeName = { ...mg, merge: { head: SHA('f') } };
  assert.equal(Op.resolveChoices(noMergeName, new Map([[SHA('f'), [{ type: 'local', name: 'side' }]]]), entry)[1].label, "Keep side's version");
  assert.equal(Op.resolveChoices(noMergeName, new Map(), entry)[1].label, "Keep fffffff's version");

  assert.equal(Op.resolveChoices(H.status({ oid: SHA('a'), conflicted: [entry] }), null, entry), null, 'a stash conflict: Mark resolved only');
  assert.equal(Op.resolveChoices(H.status({ oid: SHA('a'), state: 'cherry-picking', conflicted: [entry] }), null, entry), null);
  const evil = { ...mg, branch: 'm\u202ea' };
  assert.equal(Op.resolveChoices(evil, null, entry)[0].label, "Keep m\\u{202E}a's version", 'display-safe');
});

test('resolveChoices: a modify/delete conflict (entry.xy) says exactly what each side does: "Delete a.txt (main deleted it)" / "Keep a.txt"', () => {
  const { Op } = load();
  const rb = H.status({ oid: SHA('e'), branch: null, state: 'rebasing', rebase: H.rebaseState() });
  const pick = (xy, st = rb) => Op.resolveChoices(st, null, H.conflict('src/a.txt', xy));
  // UD: deleted by them (the replayed commit): ours keeps the file, theirs deletes it
  assert.deepEqual(pick('UD').map((c) => [c.side, c.label, c.deletes]), [
    ['ours', 'Keep a.txt', false],
    ['theirs', 'Delete a.txt (ddddddd deleted it)', true],
  ]);
  assert.equal(pick('UD')[0].title, "Keep the file with main's changes and mark it resolved (ddddddd deleted it)");
  assert.equal(pick('UD')[1].title, "Delete the file, as ddddddd did, and mark the deletion resolved: main's changes to it are discarded");
  assert.deepEqual(pick('DU').map((c) => [c.label, c.why]), [['Delete a.txt (main deleted it)', 'main deleted it'], ['Keep a.txt', "with ddddddd's changes; main deleted it"]]);
  assert.deepEqual(pick('AA').map((c) => [c.label, c.deletes]), [["Keep main's version", false], ["Keep ddddddd's version", false]]);
  assert.deepEqual(pick('UU').map((c) => c.why), ["main's version", "ddddddd's version"]);
  assert.deepEqual(pick('DD').map((c) => [c.side, c.label, c.deletes]), [['ours', 'Delete a.txt (both sides deleted it)', true]], 'one choice');
  // a merge: ours is the branch, theirs what is merged in
  const mg = H.status({ oid: SHA('a'), branch: 'main', state: 'merging', merge: { head: SHA('f'), name: 'side', message: 'm' } });
  assert.deepEqual(pick('UD', mg).map((c) => c.label), ['Keep a.txt', 'Delete a.txt (side deleted it)']);
  // display-safe file names
  assert.equal(Op.resolveChoices(rb, null, H.conflict('x\u202ey.txt', 'DU'))[0].label, 'Delete x\\u{202E}y.txt (main deleted it)');
  // only the backend's xy field counts
  assert.equal(Op.conflictCode({ xy: 'zz' }), null);
  assert.equal(Op.conflictCode({ conflict: 'DU' }), null);
  assert.equal(Op.conflictCode(H.conflict('a', 'DU')), 'DU');
  assert.equal(Op.refShort('refs/tags/v1'), 'v1');
  assert.equal(Op.refShort('origin/main'), 'origin/main');
});

test('resolveChoices: a file only one side added (AU / UA) — keeping the side without it deletes the file, and says so', () => {
  const { Op } = load();
  const rb = H.status({ oid: SHA('e'), branch: null, state: 'rebasing', rebase: H.rebaseState() });
  const pick = (xy, st = rb) => Op.resolveChoices(st, null, H.conflict('src/a.txt', xy));
  // AU: added by us (only stage 2): theirs has no version, so keeping theirs is `git rm` (merge.resolveWith)
  assert.deepEqual(pick('AU').map((c) => [c.side, c.label, c.deletes]), [
    ['ours', 'Keep a.txt', false],
    ['theirs', "Delete a.txt (ddddddd doesn't have it)", true],
  ]);
  assert.equal(pick('AU')[0].title, "Keep the file with main's changes and mark it resolved (ddddddd doesn't have it)");
  assert.equal(pick('AU')[1].title, "Delete the file (only main added it) and mark the deletion resolved: main's version is discarded");
  // UA: added by them (only stage 3): ours has no version
  assert.deepEqual(pick('UA').map((c) => [c.side, c.label, c.deletes, c.why]), [
    ['ours', "Delete a.txt (main doesn't have it)", true, "main doesn't have it"],
    ['theirs', 'Keep a.txt', false, "with ddddddd's changes; main doesn't have it"],
  ]);
  // a merge: ours the branch, theirs what is merged in
  const mg = H.status({ oid: SHA('a'), branch: 'main', state: 'merging', merge: { head: SHA('f'), name: 'side', message: 'm' } });
  assert.deepEqual(pick('UA', mg).map((c) => c.label), ["Delete a.txt (main doesn't have it)", 'Keep a.txt']);
  assert.deepEqual(pick('AU', mg).map((c) => c.label), ['Keep a.txt', "Delete a.txt (side doesn't have it)"]);
  // every porcelain v2 unmerged code: the side without an index stage is the one that deletes
  const missing = Object.fromEntries(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].map((xy) => {
    const m = Op.missingSides(xy);
    return [xy, `${m.ours ? 'ours' : ''}${m.theirs ? 'theirs' : ''}` || '-'];
  }));
  assert.deepEqual(missing, { DD: 'ourstheirs', AU: 'theirs', UD: 'theirs', UA: 'ours', DU: 'ours', AA: '-', UU: '-' });
});

test('resolveChoices over the conflicted entries of a real git.status (UU / UD / DU / AA, test/fixtures/status-conflicts.json)', () => {
  const { Op } = load();
  const real = H.realConflicts();
  assert.deepEqual(real.conflicted.map((e) => Object.keys(e).sort()), real.conflicted.map(() => ['path', 'status', 'xy']), 'the backend shape');
  const st = { ...H.status({ oid: SHA('a'), branch: 'main', state: 'merging', conflicted: real.conflicted }), merge: { head: SHA('f'), name: 'side', message: 'm' } };
  const labels = Object.fromEntries(real.conflicted.map((e) => [e.path, Op.resolveChoices(st, null, e).map((c) => c.label)]));
  assert.deepEqual(labels, {
    'aa.txt': ["Keep main's version", "Keep side's version"],
    'both.txt': ["Keep main's version", "Keep side's version"],
    'du.txt': ['Delete du.txt (main deleted it)', 'Keep du.txt'],
    'ud.txt': ['Keep ud.txt', 'Delete ud.txt (side deleted it)'],
  });
});
