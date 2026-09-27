'use strict';
// WIP panel rules (renderer/components/wip-model.js) and the shared discard confirmation (dialog.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const load = () => H.loadComponentHelpers();
const E = (path, status = 'M', orig) => ({ path, status, ...(orig ? { orig } : {}) });

// ------------------------------------------------------------------ messages

test('splitMessage: summary and description', () => {
  const { splitMessage } = load().PLWip;
  assert.deepEqual(splitMessage('fix: thing'), { summary: 'fix: thing', description: '' });
  assert.deepEqual(splitMessage('fix: thing\n\nbody line 1\nbody line 2\n'), { summary: 'fix: thing', description: 'body line 1\nbody line 2' });
  assert.deepEqual(splitMessage('  sum  \r\n\r\n\r\nbody\r\n'), { summary: 'sum', description: 'body' });
  assert.deepEqual(splitMessage('sum\nno blank line'), { summary: 'sum', description: 'no blank line' });
  assert.deepEqual(splitMessage(''), { summary: '', description: '' });
  assert.deepEqual(splitMessage(null), { summary: '', description: '' });
});

test('joinMessage: blank description dropped, trailing whitespace trimmed', () => {
  const { joinMessage } = load().PLWip;
  assert.equal(joinMessage('sum', ''), 'sum');
  assert.equal(joinMessage('sum', '  \n '), 'sum');
  assert.equal(joinMessage('sum', 'body\n\n'), 'sum\n\nbody');
  assert.equal(joinMessage('sum  ', ''), 'sum');
  assert.equal(joinMessage('sum', '  indented'), 'sum\n\n  indented');
});

test('blocker: why a commit is not possible', () => {
  const { blocker } = load().PLWip;
  const st = (o = {}) => H.status({ oid: 'abc', ...o });
  const staged = [E('a')];
  assert.equal(blocker({ status: null, summary: 'x' }), 'Loading…');
  assert.equal(blocker({ status: st({ staged }), summary: 'x', committing: true }), 'Committing…');
  assert.equal(blocker({ status: st({ staged }), summary: 'x', busy: true }), 'Another operation is running');
  assert.equal(blocker({ status: st({ staged }), summary: '  ' }), 'Enter a commit summary');
  assert.equal(blocker({ status: st(), summary: 'x' }), 'Stage files to commit');
  assert.equal(blocker({ status: st({ staged }), summary: 'x' }), '');
  assert.equal(blocker({ status: st(), summary: 'x', amend: true }), '', 'message-only amend');
  assert.equal(blocker({ status: H.status({ oid: null, staged }), summary: 'x', amend: true }), 'There is no commit to amend yet');
  assert.equal(blocker({ status: st({ unstaged: [E('b')] }), summary: 'x', all: true }), '');
  assert.equal(blocker({ status: st(), summary: 'x', all: true }), 'There are no changes to commit');
  assert.equal(blocker({ status: st({ unstaged: [E('b')], conflicted: [E('c', 'U')] }), summary: 'x', all: true }), 'Resolve the conflicts first');
});

// ------------------------------------------------------------------ renames

test('unstagePathsFor: a rename takes its old path, a copy does not', () => {
  const { unstagePathsFor, unstagePaths } = load().PLWip;
  assert.deepEqual(unstagePathsFor(E('new.txt', 'R', 'old.txt')), ['new.txt', 'old.txt']);
  assert.deepEqual(unstagePathsFor(E('copy.txt', 'C', 'src.txt')), ['copy.txt'], 'unstaging a copy must not unstage its source');
  assert.deepEqual(unstagePathsFor(E('a.txt', 'M')), ['a.txt']);
  assert.deepEqual(unstagePathsFor(E('a.txt', 'R', 'a.txt')), ['a.txt']);
  assert.deepEqual(unstagePaths([E('n', 'R', 'o'), E('o', 'M'), E('c', 'C', 'n')]), ['n', 'o', 'c'], 'deduplicated');
});

// ------------------------------------------------------------------ freshness

test('stillCurrent: every entry still unstaged with the same status', () => {
  const { stillCurrent } = load().PLWip;
  const st = H.status({ unstaged: [E('a', 'M'), E('b', '?')], staged: [E('c', 'M')] });
  assert.equal(stillCurrent([E('a', 'M')], st), true);
  assert.equal(stillCurrent([E('a', 'M'), E('b', '?')], st), true);
  assert.equal(stillCurrent([E('b', 'M')], st), false, 'status changed (untracked now)');
  assert.equal(stillCurrent([E('c', 'M')], st), false, 'no longer unstaged');
  assert.equal(stillCurrent([E('a', 'M'), E('gone', 'M')], st), false);
  assert.equal(stillCurrent([], st), false);
  assert.equal(stillCurrent([E('a', 'M')], null), false);
});

// ------------------------------------------------------------------ multi-selection

const order = (...paths) => paths.map((p) => E(p));

test('nextSelection: single, toggle, range within a section', () => {
  const { nextSelection, emptySelection } = load().PLWip;
  const o = order('a', 'b', 'c', 'd');
  let sel = nextSelection(emptySelection(), 'unstaged', 'single', 'b', null);
  assert.deepEqual([...sel.paths], ['b']);
  assert.equal(sel.anchor, 'b');
  sel = nextSelection(sel, 'unstaged', 'toggle', 'd', o);
  assert.deepEqual([...sel.paths].sort(), ['b', 'd']);
  assert.equal(sel.anchor, 'd');
  sel = nextSelection(sel, 'unstaged', 'toggle', 'd', o);
  assert.deepEqual([...sel.paths], ['b']);
  sel = nextSelection({ list: 'unstaged', paths: new Set(['b']), anchor: 'b' }, 'unstaged', 'range', 'd', o);
  assert.deepEqual([...sel.paths], ['b', 'c', 'd']);
  assert.equal(sel.anchor, 'b', 'the anchor stays');
  sel = nextSelection(sel, 'unstaged', 'range', 'a', o);
  assert.deepEqual([...sel.paths], ['a', 'b']);
});

test('nextSelection: another section starts over; Shift+arrow keeps the row it came from', () => {
  const { nextSelection } = load().PLWip;
  const staged = order('x', 'y', 'z');
  const inUnstaged = { list: 'unstaged', paths: new Set(['a']), anchor: 'a' };
  let sel = nextSelection(inUnstaged, 'staged', 'toggle', 'y', staged);
  assert.deepEqual([sel.list, [...sel.paths]], ['staged', ['y']]);
  sel = nextSelection(inUnstaged, 'staged', 'range', 'z', staged);
  assert.deepEqual([...sel.paths], ['z'], 'Shift-click: no anchor in this section');
  sel = nextSelection(inUnstaged, 'staged', 'range', 'y', staged, 'x');
  assert.deepEqual([...sel.paths], ['x', 'y'], 'Shift+arrow from x: x is the anchor');
  assert.equal(sel.anchor, 'x');
  sel = nextSelection({ list: 'staged', paths: new Set(['gone']), anchor: 'gone' }, 'staged', 'range', 'z', staged, 'y');
  assert.deepEqual([...sel.paths], ['y', 'z'], 'anchor left the list: start at the row moved from');
});

test('selectAll, pruneSelection and targets', () => {
  const { selectAll, pruneSelection, targets, emptySelection } = load().PLWip;
  const entries = [E('a'), E('b'), E('c')];
  const all = selectAll('unstaged', entries, 'b');
  assert.deepEqual([...all.paths], ['a', 'b', 'c']);
  assert.equal(all.anchor, 'b');
  const st = H.status({ unstaged: [E('a'), E('c')] });
  const pruned = pruneSelection(all, st);
  assert.deepEqual([...pruned.paths], ['a', 'c']);
  assert.equal(pruneSelection(pruned, st), pruned, 'unchanged: same object');
  assert.deepEqual(pruneSelection({ list: 'unstaged', paths: new Set(['z']), anchor: 'z' }, st), emptySelection());
  assert.deepEqual(targets(all, 'unstaged', entries[1], entries), entries, 'row in a multi-selection: all of it');
  assert.deepEqual(targets(all, 'staged', entries[1], entries), [entries[1]], 'other section');
  assert.deepEqual(targets({ list: 'unstaged', paths: new Set(['b']), anchor: 'b' }, 'unstaged', entries[1], entries), [entries[1]]);
  assert.deepEqual(targets(all, 'unstaged', E('zz'), entries), [E('zz')], 'row outside the selection');
});

// ------------------------------------------------------------------ discard confirmation

test('pathListText: at most 10 paths, then "and N more", names made safe', () => {
  const { pathListText } = load().Components.dialog;
  const paths = Array.from({ length: 12 }, (_, i) => `f${i}`);
  assert.equal(pathListText(paths), `${paths.slice(0, 10).join('\n')}\nand 2 more`);
  assert.equal(pathListText(['a\u202eb']), 'a\\u{202E}b');
  assert.equal(pathListText(['a', 'b', 'c'], 2), 'a\nb\nand 1 more');
});

test('discardOptions: one tracked file, one untracked file, several, all', () => {
  const { discardOptions } = load().Components.dialog;
  const one = discardOptions([E('src/a.js', 'M')]);
  assert.equal(one.title, 'Discard changes?');
  assert.equal(one.confirmLabel, 'Discard');
  assert.match(one.message, /src\/a\.js/);
  assert.match(one.message, /Undo/);
  assert.equal(one.danger, true);
  const un = discardOptions([E('new.txt', '?')]);
  assert.equal(un.title, 'Delete untracked file?');
  assert.equal(un.confirmLabel, 'Delete File');
  assert.match(un.message, /deletes the file/);
  assert.equal(un.danger, true);
  const many = discardOptions([E('b', 'M'), E('a', '?'), E('c', '?')]);
  assert.equal(many.title, 'Discard changes to 3 files?');
  assert.match(many.message, /3 files will be discarded\. 2 untracked files will be deleted\./);
  assert.equal(many.detail, 'a\nb\nc', 'sorted path list');
  assert.equal(many.confirmLabel, 'Discard');
  const all = discardOptions([E('a', 'M'), E('b', 'D')], { all: true });
  assert.equal(all.title, 'Discard all changes?');
  assert.equal(all.confirmLabel, 'Discard All');
  assert.doesNotMatch(all.message, /untracked/);
  assert.equal(all.danger, true);
});

test('confirmDiscard: asks through dialog.confirm with the danger options; nothing for no entries', async () => {
  const { dialog } = load().Components;
  const seen = [];
  dialog.confirm = async (opts) => { seen.push(opts); return seen.length === 1; };
  assert.equal(await dialog.confirmDiscard([E('a', 'M')]), true);
  assert.equal(await dialog.confirmDiscard([E('a', '?')]), false, 'cancelled');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].danger, true);
  assert.equal(seen[1].confirmLabel, 'Delete File');
  assert.equal(await dialog.confirmDiscard([]), false);
  assert.equal(seen.length, 2, 'no dialog for an empty list');
});

test('alert: one confirm call with the OK label and no cancel', async () => {
  const { dialog } = load().Components;
  let got = null;
  dialog.confirm = async (opts) => { got = opts; return true; };
  assert.equal(await dialog.alert({ title: 'T', message: 'M', detail: 'D', okLabel: 'Got it' }), undefined);
  assert.deepEqual(got, { title: 'T', message: 'M', detail: 'D', confirmLabel: 'Got it', alertOnly: true });
});

// ------------------------------------------------------------------ keybindings

test('shortcut: the WIP keys (⌘⇧S / ⌘⇧U / ⌘⇧M / ⌘↵ / ⌘⇧↵), Ctrl elsewhere', () => {
  const { shortcut } = load().PLWip;
  const k = (key, extra = {}) => ({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...extra });
  for (const mac of [true, false]) {
    const cmd = mac ? { metaKey: true } : { ctrlKey: true };
    const other = mac ? { ctrlKey: true } : { metaKey: true };
    assert.equal(shortcut(k('S', { ...cmd, shiftKey: true }), mac), 'stageAll');
    assert.equal(shortcut(k('s', { ...cmd, shiftKey: true }), mac), 'stageAll', 'Caps Lock');
    assert.equal(shortcut(k('U', { ...cmd, shiftKey: true }), mac), 'unstageAll');
    assert.equal(shortcut(k('M', { ...cmd, shiftKey: true }), mac), 'focusMessage');
    assert.equal(shortcut(k('Enter', cmd), mac), 'commit');
    assert.equal(shortcut(k('Enter', { ...cmd, shiftKey: true }), mac), 'commitAll');
    assert.equal(shortcut(k('Enter', { ...cmd, repeat: true }), mac), 'commit', 'a repeat still matches (the caller swallows it)');
    assert.equal(shortcut(k('s', cmd), mac), null, '⌘S alone is not stage all');
    assert.equal(shortcut(k('Enter'), mac), null);
    assert.equal(shortcut(k('Enter', { shiftKey: true }), mac), null);
    assert.equal(shortcut(k('S', { ...other, shiftKey: true }), mac), null, 'the other modifier');
    assert.equal(shortcut(k('S', { ...cmd, ...other, shiftKey: true }), mac), null, 'both modifiers');
    assert.equal(shortcut(k('S', { ...cmd, shiftKey: true, altKey: true }), mac), null, 'Alt');
    assert.equal(shortcut(k('Enter', { ...cmd, isComposing: true }), mac), null, 'IME');
  }
  assert.equal(shortcut(null), null);
});

// ------------------------------------------------------------------ Continue Rebase / Commit and Merge (docs/plans/rebase.md §5.4)

test('editedMessage: null while the fields still hold the prefill (normalized), else the joined message', () => {
  const { editedMessage } = load().PLWip;
  const prefill = 'add the widget\n\nWith a body.\n';
  assert.equal(editedMessage(prefill, 'add the widget', 'With a body.'), null);
  assert.equal(editedMessage(prefill, 'add the widget  ', 'With a body.\n\n'), null, 'trailing whitespace is not an edit');
  assert.equal(editedMessage(prefill, 'add the widget', 'With a better body.'), 'add the widget\n\nWith a better body.');
  assert.equal(editedMessage(prefill, '', ''), '');
  assert.equal(editedMessage('', '', ''), null, 'no prefill, nothing typed');
  assert.equal(editedMessage(null, 'typed', ''), 'typed');
  assert.equal(editedMessage("Merge branch 'x'\r\n", "Merge branch 'x'", ''), null);
});

test('continueBlocker: loading, running, busy, conflicts left, a cleared summary; an unedited message is fine', () => {
  const { continueBlocker, OP_COMMIT_ALL_BLOCKED } = load().PLWip;
  const st = (conflicted = []) => H.status({ oid: 'a', conflicted });
  const base = { status: st(), summary: 'sum', description: '', prefill: 'sum' };
  assert.equal(continueBlocker(base), '');
  assert.equal(continueBlocker({ ...base, status: null }), 'Loading…');
  assert.equal(continueBlocker({ ...base, committing: true }), 'Continuing…');
  assert.equal(continueBlocker({ ...base, committing: true, merge: true }), 'Committing…');
  assert.equal(continueBlocker({ ...base, busy: true }), 'Another operation is running');
  assert.equal(continueBlocker({ ...base, status: st([E('a', 'UU')]) }), 'Resolve and mark all conflicted files first');
  assert.equal(continueBlocker({ ...base, summary: ' ', description: 'x' }), 'Enter a commit summary');
  assert.equal(continueBlocker({ ...base, summary: '', prefill: '' }), '', 'unchanged empty prefill: git uses its own message');
  assert.match(OP_COMMIT_ALL_BLOCKED, /one by one/);
});
