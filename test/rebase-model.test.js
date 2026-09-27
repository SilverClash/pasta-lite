'use strict';
// renderer/components/rebase-model.js (window.PLRebase): the interactive rebase plan the editor edits
// (docs/plans/rebase.md §4.2, §5.6). Pure: actions, reorder, squash groups, validation, toTodo,
// message prefill, summary, dirty detection, reload — plus a seeded property run.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const SHA = (c) => c.repeat(40);
// The backend's grouping of a todo (pure), to check the message keys against the rule ops enforces.
const { todoGroups } = require('../src/rebase.js');

function load() {
  const win = H.loadRenderer(); // components.js (displayName) + rebase-model.js
  return win.PLRebase;
}

/** A rebasePlan result: commits c1..cN oldest first (sha 1111…, 2222…, …). */
function plan({ n = 5, published = [], extra = {} } = {}) {
  const commits = Array.from({ length: n }, (_, i) => {
    const k = String(i + 1);
    return {
      sha: SHA(k), parents: [i ? SHA(String(i)) : SHA('0')], subject: `c${k} subject`, message: `c${k} subject\n\nbody of c${k}`,
      author: 'Ada Lovelace', email: 'ada@example.com', date: 1700000000 + i, isMerge: false,
    };
  });
  return {
    head: SHA(String(n)), branch: 'feat', upstream: SHA('0'), onto: SHA('0'), commits, mergeBase: SHA('0'), isAncestor: true,
    published: published.map((k) => ({ sha: SHA(k), remoteRefs: ['origin/feat'] })), branchesInRange: [], limit: 500, truncated: false, ...extra,
  };
}

const order = (m) => m.rows.map((r) => r.sha[0]).join('');
const actions = (m) => m.rows.map((r) => r.action[0]).join('');
const todoText = (m, R) => R.toTodo(m).map((t) => `${t.action} ${t.sha[0]}`);

test('fromPlan: rows newest first, all pick; published and merge flags; malformed / duplicate commits skipped; frozen', () => {
  const R = load();
  const m = R.fromPlan(plan({ published: ['1', '2'] }));
  assert.equal(order(m), '54321');
  assert.equal(actions(m), 'ppppp');
  assert.equal(m.rows, m.base);
  assert.deepEqual(m.rows[4].remoteRefs, ['origin/feat']);
  assert.equal(m.rows[0].remoteRefs, null);
  assert.equal(m.rows[0].subject, 'c5 subject');
  assert.equal(m.rows[0].message, 'c5 subject\n\nbody of c5');
  assert.equal(m.plan.head, SHA('5'));
  assert.equal(m.plan.upstream, SHA('0'));
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.rows) && Object.isFrozen(m.rows[0]));
  const odd = R.fromPlan({ commits: [null, { sha: 'x' }, { sha: 'x', subject: 'dup' }, { sha: 'y', parents: ['p', 'q'], message: 'only a message\nline 2' }, 7] });
  assert.deepEqual(odd.rows.map((r) => r.sha), ['y', 'x']);
  assert.equal(odd.rows[0].isMerge, true);
  assert.equal(odd.rows[0].subject, 'only a message', 'subject from the message');
  assert.equal(odd.rows[1].message, '', 'no message');
  assert.deepEqual(R.fromPlan(null).rows, []);
  assert.deepEqual(R.fromPlan({ commits: 'nope' }).rows, []);
  // the newest MAX_ROWS only
  const big = { commits: Array.from({ length: 510 }, (_, i) => ({ sha: `s${i}`, subject: `${i}` })) };
  const bm = R.fromPlan(big);
  assert.equal(bm.rows.length, R.MAX_ROWS);
  assert.equal(bm.rows[0].sha, 's509');
  assert.equal(bm.rows[499].sha, 's10');
});

test('setAction: one sha or a selection; unknown actions and unknown shas change nothing (same model)', () => {
  const R = load();
  const m = R.fromPlan(plan());
  const a = R.setAction(m, SHA('3'), 'reword');
  assert.equal(actions(a), 'pprpp');
  assert.equal(actions(m), 'ppppp', 'immutable');
  const b = R.setAction(a, [SHA('5'), SHA('4')], 'squash');
  assert.equal(actions(b), 'ssrpp');
  assert.equal(R.setAction(b, [SHA('5'), SHA('4')], 'squash'), b, 'already set');
  assert.equal(R.setAction(b, SHA('5'), 'exec'), b);
  assert.equal(R.setAction(b, SHA('5'), 'break'), b);
  assert.equal(R.setAction(b, SHA('9'), 'drop'), b);
  assert.equal(R.setAction(b, [], 'drop'), b);
  for (const act of R.ACTIONS) assert.equal(R.setAction(m, SHA('1'), act).rows[4].action, act);
  assert.deepEqual(R.KEY_ACTIONS, { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' });
});

test('move: by one row, as a block, clamped at the edges; out of range and empty selections do nothing', () => {
  const R = load();
  const m = R.fromPlan(plan()); // 54321
  assert.equal(order(R.move(m, SHA('3'), -1)), '53421');
  assert.equal(order(R.move(m, SHA('3'), 1)), '54231');
  assert.equal(order(R.move(m, SHA('3'), -2)), '35421');
  assert.equal(order(R.move(m, SHA('3'), -9)), '35421', 'clamped at the top');
  assert.equal(order(R.move(m, SHA('3'), 9)), '54213', 'clamped at the bottom');
  assert.equal(R.move(m, SHA('5'), -1), m, 'already at the top');
  assert.equal(R.move(m, SHA('1'), 1), m, 'already at the bottom');
  assert.equal(order(R.move(m, [SHA('4'), SHA('2')], -1)), '45231', 'each selected row moves up once');
  assert.equal(order(R.move(m, [SHA('3'), SHA('2')], 1)), '54132', 'a contiguous block moves together');
  assert.equal(R.move(m, [SHA('5'), SHA('3')], -1), m, 'a block touching the edge does not move');
  assert.equal(R.move(m, SHA('9'), -1), m);
  assert.equal(R.move(m, [], 1), m);
  assert.equal(R.move(m, SHA('3'), 0), m);
  const moved = R.setAction(R.move(m, SHA('3'), -1), SHA('3'), 'drop');
  assert.equal(moved.rows[1].action, 'drop', 'actions travel with their row');
});

test('moveTo: drag and drop inserts before the row at the index; a selection keeps its order', () => {
  const R = load();
  const m = R.fromPlan(plan()); // 54321
  assert.equal(order(R.moveTo(m, SHA('1'), 0)), '15432');
  assert.equal(order(R.moveTo(m, SHA('5'), 5)), '43215', 'to the bottom');
  assert.equal(order(R.moveTo(m, SHA('5'), 2)), '45321', 'index counts the rows before the drop line');
  assert.equal(order(R.moveTo(m, SHA('2'), 1)), '52431');
  assert.equal(R.moveTo(m, SHA('3'), 2), m, 'dropped where it was');
  assert.equal(R.moveTo(m, SHA('3'), 3), m, 'just below itself: same place');
  assert.equal(order(R.moveTo(m, [SHA('1'), SHA('4')], 0)), '41532');
  assert.equal(order(R.moveTo(m, [SHA('5'), SHA('3')], 99)), '42153', 'clamped');
  assert.equal(order(R.moveTo(m, SHA('1'), -4)), '15432', 'clamped');
  assert.equal(R.moveTo(m, SHA('9'), 0), m);
  assert.equal(R.moveTo(m, SHA('1'), 'x'), m);
});

test('reset and changed: back to the plan as loaded; order, actions and edited messages count as changes', () => {
  const R = load();
  const m = R.fromPlan(plan());
  assert.equal(R.changed(m), false);
  assert.equal(R.reset(m), m, 'nothing to reset');
  const moved = R.move(m, SHA('2'), -1);
  assert.equal(R.changed(moved), true);
  assert.equal(R.changed(R.move(moved, SHA('2'), 1)), false, 'moved back');
  const act = R.setAction(m, SHA('2'), 'edit');
  assert.equal(R.changed(act), true);
  assert.equal(R.changed(R.setAction(act, SHA('2'), 'pick')), false);
  const reword = R.setAction(m, SHA('2'), 'reword');
  const msg = R.setMessage(reword, SHA('2'), 'new');
  const back = R.reset(msg);
  assert.equal(order(back), '54321');
  assert.equal(actions(back), 'ppppp');
  assert.deepEqual(back.messages, {});
  assert.equal(back.rows, m.base);
  assert.equal(R.changed(back), false);
});

test('groups: squash / fixup fold into the nearest kept row below; drops are skipped; an orphan at the bottom has no group', () => {
  const R = load();
  let m = R.fromPlan(plan()); // 5 4 3 2 1 (top = newest)
  m = R.setAction(m, [SHA('4'), SHA('3')], 'squash');
  m = R.setAction(m, SHA('2'), 'drop');
  // todo (oldest first): pick 1, drop 2, squash 3, squash 4, pick 5 -> groups {1: [3, 4]}, {5}
  const g = R.groups(m);
  assert.deepEqual(g.map((x) => [x.target.sha[0], x.members.map((r) => r.sha[0]).join(''), x.squash, x.last && x.last[0]]), [['1', '34', true, '4'], ['5', '', false, null]]);
  assert.equal(R.groups(m), g, 'cached per rows array');
  assert.equal(R.intoOf(m, SHA('4')).sha, SHA('1'));
  assert.equal(R.intoOf(m, SHA('3')).sha, SHA('1'), 'through the dropped row');
  assert.equal(R.intoOf(m, SHA('1')), null, 'the target itself');
  assert.equal(R.intoOf(m, SHA('2')), null, 'dropped');
  assert.equal(R.groupOf(m, SHA('3')).target.sha, SHA('1'));
  assert.equal(R.groupOf(m, SHA('2')), null);
  const fix = R.setAction(m, SHA('3'), 'fixup');
  assert.equal(R.groups(fix)[0].squash, true, 'one squash is enough');
  assert.equal(R.groups(R.setAction(fix, SHA('4'), 'fixup'))[0].squash, false, 'fixups only');
  const orphan = R.setAction(R.fromPlan(plan()), SHA('1'), 'squash');
  assert.deepEqual(R.groups(orphan).map((x) => x.target.sha[0]), ['2', '3', '4', '5']);
  assert.equal(R.groupOf(orphan, SHA('1')), null);
  assert.equal(R.summary(m).after, 2);
});

test('messageSlot / squashPrefill / setMessage: reword prefill is the commit message; a squash group combines the messages (fixups left out)', () => {
  const R = load();
  let m = R.fromPlan(plan());
  assert.equal(R.messageSlot(m, SHA('3')), null, 'a pick has no message to edit');
  m = R.setAction(m, SHA('3'), 'reword');
  const rs = R.messageSlot(m, SHA('3'));
  assert.deepEqual([rs.kind, rs.sha, rs.rowSha, rs.prefill, rs.message, rs.edited], ['reword', SHA('3'), SHA('3'), 'c3 subject\n\nbody of c3', 'c3 subject\n\nbody of c3', false]);
  m = R.setMessage(m, SHA('3'), 'c3 new\n\nnew body');
  assert.equal(R.messageSlot(m, SHA('3')).message, 'c3 new\n\nnew body');
  assert.equal(R.messageSlot(m, SHA('3')).edited, true);
  assert.equal(R.setMessage(m, SHA('3'), 'c3 new\n\nnew body'), m, 'same text: same model');
  assert.deepEqual(R.messagesFor(m), { [SHA('3')]: 'c3 new\n\nnew body' });
  const unedited = R.setMessage(m, SHA('3'), 'c3 subject\n\nbody of c3');
  assert.equal(R.messageSlot(unedited, SHA('3')).edited, false, 'back to the prefill: unedited');
  assert.deepEqual(unedited.messages, {});
  assert.deepEqual(R.messagesFor(unedited), { [SHA('3')]: 'c3 subject\n\nbody of c3' }, 'a reword always sends its message');

  // squash group: target 1 + squash 2 + fixup 3 + squash 4 → key = the last member (4)
  let s = R.fromPlan(plan());
  s = R.setAction(s, [SHA('2'), SHA('4')], 'squash');
  s = R.setAction(s, SHA('3'), 'fixup');
  for (const k of ['1', '2', '3', '4']) {
    const slot = R.messageSlot(s, SHA(k));
    assert.equal(slot.kind, 'squash', k);
    assert.equal(slot.sha, SHA('4'), 'the helper sees the last member');
    assert.equal(slot.rowSha, SHA('1'));
  }
  const prefill = 'c1 subject\n\nbody of c1\n\nc2 subject\n\nbody of c2\n\nc4 subject\n\nbody of c4';
  assert.equal(R.messageSlot(s, SHA('1')).prefill, prefill);
  assert.equal(R.squashPrefill(s, R.groups(s)[0]), prefill);
  assert.ok(!/^#/m.test(prefill), 'no # comment lines');
  assert.deepEqual(R.messagesFor(s), { [SHA('4')]: prefill });
  assert.equal(R.messageSlot(s, SHA('5')), null);
  const edited = R.setMessage(s, SHA('2'), 'one combined');
  assert.deepEqual(R.messagesFor(edited), { [SHA('4')]: 'one combined' }, 'any row of the group edits the group message');
  // the group gains a member but keeps its target: the typed message is carried over to the new key
  const regrouped = R.setAction(edited, SHA('5'), 'squash');
  assert.deepEqual(Object.values(regrouped.messages), ['one combined']);
  assert.equal(R.messageSlot(regrouped, SHA('5')).sha, SHA('5'));
  assert.equal(R.messageSlot(regrouped, SHA('5')).message, 'one combined');
  assert.equal(R.messageSlot(regrouped, SHA('5')).edited, true);
  assert.match(R.messageSlot(regrouped, SHA('5')).prefill, /c5 subject/);
  assert.deepEqual(R.messagesFor(regrouped), { [SHA('5')]: 'one combined' });
  assert.deepEqual(regrouped.lost, {});
  // fixups only: the target keeps its message; no message is sent
  let f = R.setAction(R.fromPlan(plan()), SHA('2'), 'fixup');
  assert.equal(R.messageSlot(f, SHA('2')), null);
  assert.deepEqual(R.messagesFor(f), {});
  // a reworded target of a fixup: the fixup row edits the reword
  f = R.setAction(f, SHA('1'), 'reword');
  assert.equal(R.messageSlot(f, SHA('2')).kind, 'reword');
  assert.equal(R.messageSlot(f, SHA('2')).sha, SHA('1'));
  // a reworded target of a squash: both messages are sent; the reword's edit feeds the prefill
  let rw = R.setAction(R.fromPlan(plan()), SHA('1'), 'reword');
  rw = R.setMessage(rw, SHA('1'), 'c1 reworded');
  rw = R.setAction(rw, SHA('2'), 'squash');
  assert.equal(R.messageSlot(rw, SHA('1')).kind, 'squash');
  assert.deepEqual(R.messagesFor(rw), { [SHA('1')]: 'c1 reworded', [SHA('2')]: 'c1 reworded\n\nc2 subject\n\nbody of c2' });
  // not a slot: nothing changes
  assert.equal(R.setMessage(rw, SHA('5'), 'x'), rw);
  assert.equal(R.setMessage(rw, SHA('1'), 42), rw);
  assert.equal(R.messageSlot(rw, SHA('9')), null);
  assert.equal(R.messageSlot(R.setAction(rw, SHA('3'), 'drop'), SHA('3')), null, 'dropped');
});

test('a typed squash message whose group loses its target or its squash is kept in `lost`, noted, and comes back with the slot', () => {
  const R = load();
  const names = { branch: 'feat', onto: 'main' };
  let m = R.setAction(R.fromPlan(plan()), SHA('3'), 'squash'); // 3 folds into 2
  m = R.setMessage(m, SHA('3'), 'c2 and c3 together');
  assert.deepEqual(R.messagesFor(m), { [SHA('3')]: 'c2 and c3 together' });
  // the squash becomes a fixup: the group keeps target 2 but has no squash message any more
  const fix = R.setAction(m, SHA('3'), 'fixup');
  assert.deepEqual(fix.messages, {});
  assert.deepEqual(fix.lost, { [`g:${SHA('2')}`]: { kind: 'squash', rowSha: SHA('2'), message: 'c2 and c3 together' } });
  const note = R.validate(fix, names).warnings.find((w) => w.code === 'message-reset');
  assert.deepEqual([note.sha, note.message], [SHA('2'), 'The squash message you wrote for "c2 subject" was reset: Undo or restoring the squash brings it back']);
  assert.equal(R.changed(fix), true);
  // back to squash: the message is restored, the note goes away
  const back = R.setAction(fix, SHA('3'), 'squash');
  assert.deepEqual(R.messagesFor(back), { [SHA('3')]: 'c2 and c3 together' });
  assert.deepEqual(back.lost, {});
  assert.ok(!R.validate(back, names).warnings.some((w) => w.code === 'message-reset'));
  // the target is dropped: 3 now folds into 1 (another target): not carried, kept as lost for c2
  const moved = R.setAction(m, SHA('2'), 'drop');
  assert.equal(R.messageSlot(moved, SHA('3')).rowSha, SHA('1'));
  assert.equal(R.messageSlot(moved, SHA('3')).edited, false, 'the new group starts from its prefill');
  assert.deepEqual(Object.keys(moved.lost), [`g:${SHA('2')}`]);
  assert.deepEqual(R.messagesFor(R.setAction(moved, SHA('2'), 'pick')), { [SHA('3')]: 'c2 and c3 together' }, 'target back: restored');
  // a new message for the slot replaces the lost one; reset clears it
  const typed = R.setMessage(R.setAction(fix, SHA('3'), 'squash'), SHA('3'), 'fresh');
  assert.deepEqual([R.messagesFor(typed)[SHA('3')], typed.lost], ['fresh', {}]);
  const rs = R.reset(fix);
  assert.deepEqual([rs.messages, rs.lost, R.changed(rs)], [{}, {}, false]);
  // a reword set back to pick keeps its text the same way
  const rw = R.setMessage(R.setAction(R.fromPlan(plan()), SHA('4'), 'reword'), SHA('4'), 'c4 better');
  const picked = R.setAction(rw, SHA('4'), 'pick');
  assert.equal(R.validate(picked, names).warnings.find((w) => w.code === 'message-reset').message, 'The reworded message you wrote for "c4 subject" was reset: Undo or restoring the reword brings it back');
  assert.equal(R.noOp(picked), true, 'a lost message changes nothing git does');
  assert.deepEqual(R.messagesFor(R.setAction(picked, SHA('4'), 'reword')), { [SHA('4')]: 'c4 better' });
  // reloadFrom keeps lost messages of commits still there, forgets the others
  const reloaded = R.reloadFrom(fix, plan({ n: 5 }));
  assert.deepEqual(Object.keys(reloaded.lost), [`g:${SHA('2')}`]);
  assert.deepEqual(R.reloadFrom(fix, plan({ n: 1 })).lost, {});
});

test('setMessage: an unedited Save (the prefill as the dialog normalizes it) does not mark the slot edited', () => {
  const R = load();
  const p = plan();
  p.commits[2].message = 'c3 subject  \n\n\nbody of c3\n\n'; // stored with trailing spaces and blank lines
  const m = R.setAction(R.fromPlan(p), SHA('3'), 'reword');
  const saved = R.setMessage(m, SHA('3'), 'c3 subject\n\nbody of c3'); // what dialog.editMessage returns unchanged
  assert.equal(saved, m, 'same model');
  assert.equal(R.messageSlot(saved, SHA('3')).edited, false);
  assert.equal(R.changed(R.setAction(saved, SHA('3'), 'pick')), false);
  const sq = R.setAction(R.fromPlan(plan()), SHA('2'), 'squash');
  assert.equal(R.setMessage(sq, SHA('2'), `${R.messageSlot(sq, SHA('2')).prefill}\n\n`), sq);
  assert.equal(R.messageSlot(R.setMessage(sq, SHA('2'), 'other'), SHA('2')).edited, true);
});

test('rewrittenRows: the rows from the oldest change up (drops included); every row onto a new base', () => {
  const R = load();
  const m = R.fromPlan(plan());
  const shas = (rows) => rows.map((r) => r.sha[0]).join('');
  assert.equal(shas(R.rewrittenRows(m)), '');
  assert.equal(shas(R.rewrittenRows(R.setAction(m, SHA('3'), 'reword'))), '543');
  assert.equal(shas(R.rewrittenRows(R.setAction(m, SHA('2'), 'drop'))), '5432', 'a dropped commit is removed: rewritten too');
  assert.equal(R.rewritten(R.setAction(m, SHA('2'), 'drop')), 3);
  assert.equal(shas(R.rewrittenRows(R.setAction(m, SHA('4'), 'squash'))), '543', 'a squash rewrites the commit it folds into');
  assert.equal(shas(R.rewrittenRows(R.move(m, SHA('5'), 1))), '45');
  assert.equal(shas(R.rewrittenRows(R.fromPlan(plan({ extra: { onto: SHA('9'), upstream: SHA('9') } })))), '54321');
});

test('toTodo: oldest first, one entry per commit, only {action, sha}', () => {
  const R = load();
  let m = R.fromPlan(plan());
  m = R.move(m, SHA('1'), -2); // 5 4 1 3 2
  m = R.setAction(m, SHA('3'), 'squash');
  m = R.setAction(m, SHA('5'), 'drop');
  m = R.setAction(m, SHA('4'), 'edit');
  assert.deepEqual(todoText(m, R), ['pick 2', 'squash 3', 'pick 1', 'edit 4', 'drop 5']);
  assert.deepEqual(Object.keys(R.toTodo(m)[0]).sort(), ['action', 'sha']);
  assert.equal(R.toTodo(m)[0].sha, SHA('2'));
});

test('validate: squash-first, empty-message and nothing errors; all-dropped, published and hash-lines warnings; the rewrites info', () => {
  const R = load();
  const names = { branch: 'feat', onto: 'main' };
  const m = R.fromPlan(plan({ published: ['1', '2'] }));
  const codes = (v) => [v.errors.map((e) => e.code), v.warnings.map((w) => w.code), v.infos.map((i) => i.code)];

  const fresh = R.validate(m, names);
  assert.equal(fresh.ok, false);
  assert.deepEqual(codes(fresh), [['nothing'], [], []], 'nothing rewritten: no published warning');
  assert.equal(fresh.errors[0].message, 'Nothing to rebase: change an action or the order');
  // published c1 / c2 are the oldest: rewording c3 leaves them alone, rewording c2 rewrites c2 only of them
  assert.deepEqual(codes(R.validate(R.setAction(m, SHA('3'), 'reword'), names))[1], []);
  assert.equal(R.validate(R.setAction(m, SHA('2'), 'reword'), names).warnings[0].message, "1 commit this rewrites is already pushed to origin/feat: you'll need to force push afterwards.");
  assert.equal(R.validate(R.setAction(m, SHA('1'), 'reword'), names).warnings[0].message, "2 commits this rewrites are already pushed to origin/feat: you'll need to force push afterwards.");

  const sq = R.setAction(m, SHA('1'), 'squash');
  const v1 = R.validate(sq, names);
  assert.deepEqual(v1.errors.map((e) => [e.code, e.sha]), [['squash-first', SHA('1')]]);
  assert.equal(v1.errors[0].message, "The oldest commit can't be squashed: there's nothing below it to combine with");
  assert.equal(R.validate(R.setAction(m, SHA('1'), 'fixup'), names).errors[0].message, "The oldest commit can't be fixed up: there's nothing below it to combine with");
  // the bottom-most KEPT row counts: squash above a dropped oldest commit is still first
  const overDrop = R.setAction(R.setAction(m, SHA('1'), 'drop'), SHA('2'), 'squash');
  assert.deepEqual(R.validate(overDrop, names).errors.map((e) => [e.code, e.sha[0]]), [['squash-first', '2']]);
  assert.equal(R.validate(R.move(sq, SHA('1'), -1), names).ok, true, 'moved above another commit: fine');

  const rw = R.setMessage(R.setAction(m, SHA('3'), 'reword'), SHA('3'), '  \n ');
  const v2 = R.validate(rw, names);
  assert.deepEqual(v2.errors.map((e) => [e.code, e.sha]), [['empty-message', SHA('3')]]);
  assert.equal(v2.errors[0].message, 'The reworded message of "c3 subject" is empty');
  const sqEmpty = R.setMessage(R.setAction(m, SHA('3'), 'squash'), SHA('3'), '');
  assert.deepEqual(R.validate(sqEmpty, names).errors.map((e) => [e.code, e.sha]), [['empty-message', SHA('2')]], 'reported on the group target');
  assert.equal(R.validate(sqEmpty, names).errors[0].message, 'The squashed message of "c2 subject" is empty');

  const all = R.setAction(m, m.rows.map((r) => r.sha), 'drop');
  const v3 = R.validate(all, names);
  assert.equal(v3.ok, true, 'allowed (the flow confirms it)');
  assert.deepEqual(codes(v3)[1], ['all-dropped', 'published']);
  assert.equal(v3.warnings[0].message, 'Every commit is dropped: feat will be reset to main');

  const hash = R.setMessage(R.setAction(m, SHA('3'), 'reword'), SHA('3'), 'subject\n\n#123 is fixed');
  assert.ok(codes(R.validate(hash, names))[1].includes('hash-lines'));
  assert.equal(R.validate(hash, names).warnings.find((w) => w.code === 'hash-lines').message, 'Lines starting with # are removed in rebased messages');
  assert.ok(!codes(R.validate(R.setMessage(R.setAction(m, SHA('3'), 'reword'), SHA('3'), 'a # b'), names))[1].includes('hash-lines'));

  // rewrites: from the oldest changed position up, drops excluded
  const one = R.setAction(R.fromPlan(plan()), SHA('3'), 'reword');
  assert.deepEqual(R.validate(one, names).infos, [{ code: 'rewrites', message: 'Rewording "c3 subject" rewrites 3 commits' }]);
  const two = R.setAction(one, SHA('5'), 'drop');
  assert.deepEqual(R.validate(two, names).infos, [{ code: 'rewrites', message: '2 commits will be rewritten' }]);
  assert.equal(R.rewritten(R.fromPlan(plan())), 0);
  assert.equal(R.rewritten(R.move(R.fromPlan(plan()), SHA('1'), -1)), 5);
  // all published / display-safe subjects
  const allPub = R.setAction(R.fromPlan(plan({ n: 2, published: ['1', '2'] })), SHA('1'), 'reword');
  assert.equal(R.validate(allPub, names).warnings[0].message, "All 2 commits are already pushed to origin/feat: you'll need to force push afterwards.");
  const evil = R.fromPlan({ commits: [{ sha: SHA('a'), subject: 'x\u202ey', message: 'x\u202ey' }] });
  assert.equal(R.validate(R.setMessage(R.setAction(evil, SHA('a'), 'reword'), SHA('a'), ''), names).errors[0].message, 'The reworded message of "x\\u{202E}y" is empty');
  assert.equal(R.validate(R.setAction(evil, SHA('a'), 'reword'), {}).ok, true);
});

test('a new base: all picks in the original order is a plain rebase onto it (no nothing error), and every commit is rewritten', () => {
  const R = load();
  const m = R.fromPlan(plan({ extra: { onto: SHA('9'), upstream: SHA('9') } }));
  assert.equal(m.plan.sameBase, false);
  assert.equal(R.changed(m), false, 'the user changed nothing');
  assert.equal(R.noOp(m), false);
  const v = R.validate(m);
  assert.equal(v.ok, true);
  assert.deepEqual(v.infos, [{ code: 'rewrites', message: '5 commits will be rewritten' }]);
  assert.equal(R.summary(m).text, 'The commits are replayed onto the new base');
  assert.equal(R.fromPlan(plan()).plan.sameBase, true);
  assert.equal(R.noOp(R.fromPlan(plan())), true);
  assert.equal(R.fromPlan({ commits: [] }).plan.sameBase, true, 'unknown: treated as the same base');
});

test('summary: counts, the sentence, reordering and the resulting number of commits', () => {
  const R = load();
  const m = R.fromPlan(plan());
  assert.deepEqual(R.summary(m), { counts: { pick: 5, reword: 0, edit: 0, squash: 0, fixup: 0, drop: 0 }, reordered: false, before: 5, after: 5, text: 'No changes yet', countsText: '5 picked' });
  let x = R.setAction(m, [SHA('2'), SHA('3')], 'squash');
  x = R.setAction(x, SHA('4'), 'fixup');
  x = R.setAction(x, SHA('5'), 'drop');
  const s = R.summary(x);
  assert.equal(s.text, '3 commits will be squashed, 1 dropped');
  assert.equal(s.countsText, '1 picked · 2 squashed · 1 fixed up · 1 dropped');
  assert.deepEqual([s.before, s.after], [5, 1]);
  const r = R.summary(R.setAction(R.move(m, SHA('1'), -1), SHA('3'), 'reword'));
  assert.equal(r.text, '1 commit will be reworded; the order changes');
  assert.equal(r.reordered, true);
  assert.equal(R.summary(R.move(m, SHA('1'), -1)).text, 'The order of the commits changes');
  assert.equal(R.summary(R.setAction(m, SHA('1'), 'edit')).text, '1 commit will be stopped for editing');
  assert.equal(R.summary(R.setAction(m, m.rows.map((y) => y.sha), 'drop')).after, 0);
});

test('reloadFrom: a re-read plan keeps the actions and messages of commits still there; new commits are picks', () => {
  const R = load();
  let m = R.fromPlan(plan({ n: 3 }));
  m = R.setAction(m, SHA('2'), 'reword');
  m = R.setMessage(m, SHA('2'), 'c2 again');
  m = R.setAction(m, SHA('3'), 'drop');
  m = R.move(m, SHA('1'), -2);
  // the branch got a new commit 4 and lost commit 3
  const p = plan({ n: 4 });
  p.commits = p.commits.filter((c) => c.sha !== SHA('3'));
  const r = R.reloadFrom(m, p);
  assert.equal(order(r), '421', 'the new plan order');
  assert.equal(actions(r), 'prp');
  assert.deepEqual(R.messagesFor(r), { [SHA('2')]: 'c2 again' });
  assert.equal(r.plan.head, SHA('4'));
  assert.equal(R.changed(r), true);
  assert.equal(r.base, r.base, 'a fresh base');
  assert.equal(order(R.reset(r)), '421');
});

test('property: random move / moveTo / setAction / reset keep toTodo a permutation of the plan and never validate squash-first', () => {
  const R = load();
  let seed = 20260925;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let iter = 0; iter < 200; iter++) {
    const n = 2 + rnd(9);
    const p = plan({ n });
    const all = p.commits.map((c) => c.sha).sort();
    let m = R.fromPlan(p);
    for (let step = 0; step < 25; step++) {
      const pickSha = () => m.rows[rnd(m.rows.length)].sha;
      const op = rnd(10);
      if (op < 3) m = R.move(m, [pickSha()], rnd(5) - 2);
      else if (op < 5) m = R.moveTo(m, [pickSha(), pickSha()], rnd(n + 1));
      else if (op < 9) m = R.setAction(m, [pickSha()], R.ACTIONS[rnd(R.ACTIONS.length)]);
      else if (rnd(4) === 0) m = R.reset(m);
      const todo = R.toTodo(m);
      assert.deepEqual(todo.map((t) => t.sha).sort(), all, `seed iteration ${iter}: a permutation`);
      assert.ok(todo.every((t) => R.ACTIONS.includes(t.action)));
      const v = R.validate(m);
      const firstKept = todo.find((t) => t.action !== 'drop');
      if (firstKept && (firstKept.action === 'squash' || firstKept.action === 'fixup')) {
        assert.equal(v.ok, false, `iteration ${iter}: squash-first accepted`);
        assert.ok(v.errors.some((e) => e.code === 'squash-first'));
      }
      // the message keys are exactly what the backend needs (src/rebase.js todoGroups, the ops rule):
      // each reword group head, and the last member of each group containing a squash
      const keys = Object.keys(R.messagesFor(m)).sort();
      const need = new Set();
      for (const g of todoGroups(todo.map((t) => ({ cmd: t.action, sha: t.sha })))) {
        if (g.reword) need.add(g.head);
        if (g.squash) need.add(g.members[g.members.length - 1]);
      }
      if (!(firstKept && (firstKept.action === 'squash' || firstKept.action === 'fixup'))) {
        assert.deepEqual(keys, [...need].sort(), `iteration ${iter}: message keys`);
      }
    }
  }
});
