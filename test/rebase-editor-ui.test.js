'use strict';
// docs/plans/rebase.md R3: the interactive rebase editor (renderer/components/rebase-editor.js) mounted
// on the fake DOM of test/renderer-harness.js — keyboard (p/r/e/s/f/d, ⌥↑/⌥↓ with the live note, Enter,
// ⌘↵, ⌘Z, Esc), multi-select, pointer-drag reorder, the published warning, the stale plan prompt,
// virtualization above 200 rows — and Components.dialog.editMessage on the same DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const H = require('./renderer-harness.js');

const SHA = (c) => c.repeat(40);
const R_ = (f) => path.join(__dirname, '..', 'renderer', f);

function plan({ n = 4, published = [], shas } = {}) {
  const list = shas || Array.from({ length: n }, (_, i) => SHA(String(i + 1)));
  const commits = list.map((sha, i) => ({
    sha, parents: [i ? list[i - 1] : SHA('0')], subject: `c${i + 1}`, message: `c${i + 1}\n\nbody ${i + 1}`,
    author: 'Ada Lovelace', email: 'a@x', date: 1700000000 + i, isMerge: false,
  }));
  return {
    head: list[list.length - 1], branch: 'feat', upstream: SHA('0'), onto: SHA('0'), commits, mergeBase: SHA('0'), isAncestor: true,
    published: published.map((sha) => ({ sha, remoteRefs: ['origin/feat'] })), branchesInRange: [], limit: 500, truncated: false,
  };
}

/** Store + fake DOM + the editor mounted in a .center next to a .graph-view; PLFlows records calls. */
async function mount(tc, { p = plan(), open = true } = {}) {
  const head = p.head;
  const { win, api, store } = await H.loadedStore(H.repoData({
    commits: [H.commit(head, [SHA('0')]), H.commit(SHA('0'), [], { subject: 'base subject' })],
    status: H.status({ oid: head, branch: 'feat' }),
  }));
  const dom = H.fakeDom().install();
  dom.attach(win);
  H.setLocalStorage(H.memoryStorage());
  win.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
  for (const f of ['dialog.js', 'menu.js', 'actions.js', 'components/wip-model.js', 'components/rebase-editor.js']) {
    delete require.cache[require.resolve(R_(f))];
    require(R_(f));
  }
  const calls = [];
  const rec = (name) => async (s, ...a) => { calls.push([name, ...a]); return true; };
  win.PLFlows = {
    startInteractiveRebase: rec('startInteractiveRebase'),
    cancelInteractiveRebase: rec('cancelInteractiveRebase'),
    reloadInteractiveRebase: rec('reloadInteractiveRebase'),
  };
  const edits = [];
  win.Components.dialog.editMessage = async (o) => { edits.push(o); return edits.answer === undefined ? null : edits.answer; };
  const center = dom.document.createElement('main');
  center.className = 'center';
  const graph = dom.document.createElement('section');
  graph.className = 'graph-view';
  const scroller = dom.document.createElement('div');
  scroller.className = 'gv-scroll';
  graph.append(scroller);
  const root = dom.document.createElement('section');
  root.dataset.component = 'rebase-editor';
  center.append(graph, root);
  dom.document.body.append(center);
  const unmount = win.Components.mountAll({ querySelectorAll: () => [root], contains: (n) => n === root }, store);
  tc.after(() => unmount());
  if (open) store.actions.openRebaseEditor({ plan: p, args: { upstream: 'refs/heads/main' }, names: { branch: 'feat', onto: 'main', ontoSha: SHA('0') } });
  await H.flush(2);
  const q = (sel) => root.querySelector(sel);
  const grid = q('.re-grid');
  // DOM order (what Tab and screen readers follow); it must match the visual order (dataset.index)
  const rows = () => {
    const list = root.querySelectorAll('.re-row');
    assert.deepEqual(list.map((r) => Number(r.dataset.index)), list.map((r) => Number(r.dataset.index)).sort((a, b) => a - b), 'DOM order is the visual order');
    return list;
  };
  const model = () => store.state.rebaseEditor.model;
  const order = () => model().rows.map((r) => `${r.sha[0]}${r.action[0]}`).join(' ');
  const key = (k, mods = {}, target = dom.document.activeElement) => dom.dispatch(target, 'keydown', { key: k, ...mods });
  return { win, api, store, dom, root, graph, scroller, grid, q, rows, model, order, key, calls, edits, R: win.PLRebase };
}

test('mounted editor: replaces the graph, header and rows (select, subject, sha, author), onto row, footer; closing brings the graph back', async (tc) => {
  const t = await mount(tc);
  assert.equal(t.root.hidden, false);
  assert.equal(t.store.state.centre, 'rebaseEditor', 'the centre pane is the editor (graph-view hides itself for it)');
  assert.equal(t.graph.hidden, false, 'the editor shows or hides only itself');
  assert.equal(t.q('.re-title').textContent, 'Interactive Rebase');
  assert.equal(t.q('.re-subtitle').textContent, 'Rebasing 4 commits of feat onto main (0000000)');
  assert.equal(t.grid.getAttribute('role'), 'grid');
  const rows = t.rows();
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.querySelector('.re-subject').textContent), ['c4', 'c3', 'c2', 'c1'], 'newest first');
  assert.equal(rows[0].getAttribute('role'), 'row');
  assert.equal(rows[0].querySelector('.re-c-sha').textContent, '4444444');
  assert.equal(rows[0].querySelector('.re-c-author').textContent, 'Ada Lovelace');
  assert.equal(rows[0].querySelector('.re-avatar').textContent, 'AL');
  const select = rows[0].querySelector('select');
  assert.deepEqual(select.children.map((o) => [o.value, o.textContent]), [['pick', 'Pick'], ['reword', 'Reword'], ['edit', 'Edit'], ['squash', 'Squash'], ['fixup', 'Fixup'], ['drop', 'Drop']]);
  assert.equal(select.value, 'pick');
  assert.match(t.q('.re-onto').textContent, /^● main {2}0000000 {2}"base subject" {3}\(onto — not editable\)$/);
  assert.equal(t.q('.re-summary-text').textContent, 'No changes yet');
  assert.equal(t.q('.re-count').textContent, '4 commits → 4');
  assert.equal(t.q('.re-start').disabled, true, 'nothing to rebase yet');
  assert.equal(t.q('.re-start').title, 'Nothing to rebase: change an action or the order');
  assert.equal(t.q('.re-reset').disabled, true);
  assert.equal(t.q('.re-stale').hidden, true);
  assert.equal(t.dom.document.activeElement, t.grid, 'the grid takes focus');
  assert.equal(t.grid.getAttribute('aria-activedescendant'), `re-row-${SHA('4')}`);
  t.store.actions.closeRebaseEditor();
  assert.equal(t.root.hidden, true);
  assert.equal(t.store.state.centre, 'graph');
  assert.equal(t.rows().length, 0);
  assert.equal(t.dom.document.activeElement, t.dom.document.body, 'focus leaves with the editor (graph-view takes it back)');
});

test('keyboard: j/k/arrows move the cursor, p/r/e/s/f/d set actions, Shift extends, Space toggles, ⌘A selects all', async (tc) => {
  const t = await mount(tc);
  t.key('j');
  assert.equal(t.grid.getAttribute('aria-activedescendant'), `re-row-${SHA('3')}`);
  t.key('s');
  assert.equal(t.order(), '4p 3s 2p 1p');
  t.key('ArrowDown');
  t.key('f');
  t.key('ArrowDown');
  t.key('r');
  t.key('k');
  t.key('k');
  t.key('e');
  t.key('Home');
  t.key('d');
  assert.equal(t.order(), '4d 3e 2f 1r');
  t.key('End');
  t.key('p');
  assert.equal(t.order(), '4d 3e 2f 1p');
  // the view follows: classes, select values, "↳ into", ✎ on rewordable rows
  const rows = t.rows();
  assert.equal(rows[0].querySelector('select').value, 'drop');
  assert.ok(rows[0].classList.contains('is-drop'));
  assert.equal(rows[2].querySelector('.re-into').textContent, '↳ into c1');
  assert.equal(rows[2].querySelector('.re-into').hidden, false);
  assert.equal(rows[1].querySelector('.re-into').hidden, true);
  assert.equal(rows[0].querySelector('.re-edit').hidden, true, 'a drop has no message');
  assert.equal(t.q('.re-summary-text').textContent, '1 commit will be squashed, 1 stopped for editing, 1 dropped');
  assert.equal(t.q('.re-count').textContent, '4 commits → 2');
  // multi-select: Shift+↑ extends, then one key sets them all
  t.key('ArrowUp', { shiftKey: true });
  t.key('ArrowUp', { shiftKey: true });
  t.key('p');
  assert.equal(t.order(), '4d 3p 2p 1p');
  assert.equal(t.rows().filter((r) => r.getAttribute('aria-selected') === 'true').length, 3);
  t.key('ArrowUp'); // a plain move collapses the selection
  t.key('ArrowDown', { shiftKey: true });
  t.key(' ');
  t.key('ArrowDown');
  t.key(' '); // toggle adds row 2
  t.key('ArrowUp');
  t.key('ArrowUp');
  t.key(' ');
  t.key('d');
  assert.ok(t.model().rows.some((r) => r.action === 'drop'));
  t.key('a', { metaKey: true, ctrlKey: true }); // either platform's modifier
  t.key('a', t.win.Components.util.IS_MAC ? { metaKey: true } : { ctrlKey: true });
  t.key('r');
  assert.equal(t.order(), '4r 3r 2r 1r', '⌘A then r');
  assert.equal(t.q('.re-live').textContent, '4 commits set to Reword');
  // keys with modifiers / from a select / while a dialog is open do nothing here
  const before = t.order();
  t.key('p', { altKey: true });
  t.key('d', {}, t.rows()[0].querySelector('select'));
  t.win.Components.dialog.isOpen = () => true;
  t.key('d');
  t.win.Components.dialog.isOpen = () => false;
  assert.equal(t.order(), before);
});

test('keyboard: ⌥↑ / ⌥↓ move the selection one row with the live note; ⌘Z undoes; Reset clears', async (tc) => {
  const t = await mount(tc);
  t.key('End'); // c1
  t.key('ArrowUp', { altKey: true });
  assert.equal(t.order(), '4p 3p 1p 2p');
  assert.equal(t.q('.re-live').textContent, 'c1 moved to position 3 of 4');
  t.key('ArrowUp', { altKey: true });
  t.key('ArrowUp', { altKey: true });
  assert.equal(t.order(), '1p 4p 3p 2p');
  t.key('ArrowUp', { altKey: true }); // at the top: nothing
  assert.equal(t.order(), '1p 4p 3p 2p');
  assert.equal(t.grid.getAttribute('aria-activedescendant'), `re-row-${SHA('1')}`, 'focus follows the row');
  assert.equal(t.rows()[0].querySelector('.re-subject').textContent, 'c1');
  assert.equal(t.q('.re-summary-text').textContent, 'The order of the commits changes');
  assert.equal(t.q('.re-start').disabled, false);
  assert.equal(t.q('.re-reset').disabled, false);
  // a two-row block moves together
  t.key('ArrowDown', { shiftKey: true });
  t.key('ArrowDown', { altKey: true });
  assert.equal(t.order(), '3p 1p 4p 2p');
  assert.equal(t.q('.re-live').textContent, '2 commits moved to position 3 of 4');
  const mod = t.win.Components.util.IS_MAC ? { metaKey: true } : { ctrlKey: true };
  t.key('z', mod);
  assert.equal(t.order(), '1p 4p 3p 2p');
  t.key('z', mod);
  t.key('z', mod);
  t.key('z', mod);
  assert.equal(t.order(), '4p 3p 2p 1p');
  t.key('z', mod); // empty stack
  t.key('d');
  t.q('.re-reset').click();
  assert.equal(t.order(), '4p 3p 2p 1p');
  assert.equal(t.store.state.rebaseEditor.past.length, 0, 'Reset clears the undo stack');
  assert.equal(t.q('.re-live').textContent, 'Reset: every commit picked, in its original order');
});

test('keyboard: ⌘⇧Z redoes what ⌘Z undid; a new edit clears the redo stack', async (tc) => {
  const t = await mount(tc);
  const mod = t.win.Components.util.IS_MAC ? { metaKey: true } : { ctrlKey: true };
  t.key('d'); // c4 drop
  t.key('j');
  t.key('s'); // c3 squash
  assert.equal(t.order(), '4d 3s 2p 1p');
  t.key('z', mod);
  t.key('z', mod);
  assert.equal(t.order(), '4p 3p 2p 1p');
  assert.equal(t.key('z', { ...mod, shiftKey: true }).defaultPrevented, true);
  assert.equal(t.order(), '4d 3p 2p 1p');
  assert.equal(t.q('.re-live').textContent, 'Redone');
  t.key('Z', { ...mod, shiftKey: true }); // Shift gives an upper-case key
  assert.equal(t.order(), '4d 3s 2p 1p');
  t.key('z', { ...mod, shiftKey: true }); // nothing left to redo
  assert.equal(t.order(), '4d 3s 2p 1p');
  t.key('z', mod);
  t.key('k');
  t.key('p'); // a new edit
  assert.equal(t.store.state.rebaseEditor.future.length, 0, 'a new edit clears redo');
  t.key('z', { ...mod, shiftKey: true });
  assert.equal(t.order(), '4p 3p 2p 1p');
  t.key('z', { ...mod, shiftKey: true, repeat: true });
  assert.equal(t.store.actions.redoRebaseEdit(), false);
});

test('the editor claims every global write shortcut while it has focus (defaultPrevented, nothing runs) except ⌘L fetch and ⇧⌘O', async (tc) => {
  const t = await mount(tc);
  const A = t.win.Components.actions;
  const mac = t.win.Components.util.IS_MAC;
  // What app.js / details.js do with a key nobody handled: they skip defaultPrevented events.
  const reached = [];
  const globalHandler = (e) => { const k = A.matchKey(e); if (k && !e.defaultPrevented) reached.push(k.id); };
  t.dom.window.addEventListener('keydown', globalHandler);
  tc.after(() => t.dom.window.removeEventListener('keydown', globalHandler));
  const before = t.order();
  const writesBefore = t.api.calls.length;
  for (const target of [t.grid, t.rows()[1].querySelector('select'), t.rows()[1].querySelector('.re-edit')]) {
    t.dom.document.activeElement = target;
    for (const k of A.KEYS) {
      const e = t.dom.dispatch(target, 'keydown', { key: k.key === 'enter' ? 'Enter' : k.key, shiftKey: k.shift, ...(mac ? { metaKey: true } : { ctrlKey: true }) });
      const passes = k.id === 'fetch' || k.id === 'open';
      assert.equal(e.defaultPrevented, !passes, `${k.id} on ${target.className}`);
    }
  }
  assert.deepEqual([...new Set(reached)], ['fetch', 'open'], 'only ⌘L and ⇧⌘O reach the global handlers');
  assert.equal(t.api.calls.length, writesBefore, 'no write ran (⌘⇧S, ⌘⇧U, ⌘B, …)');
  assert.equal(t.order(), before, 'undo / redo of an unchanged plan change nothing');
  assert.deepEqual(t.calls, [['startInteractiveRebase'], ['startInteractiveRebase'], ['startInteractiveRebase']], '⌘↵ is Start Rebase; ⌘⇧↵ does nothing');
  // outside the editor the keys are the app's again
  const other = t.dom.document.createElement('input');
  t.dom.document.body.append(other);
  other.focus();
  const e = t.dom.dispatch(other, 'keydown', { key: 's', shiftKey: true, ...(mac ? { metaKey: true } : { ctrlKey: true }) });
  assert.equal(e.defaultPrevented, false);
  // closed: nothing claimed
  t.store.actions.closeRebaseEditor();
  t.dom.document.activeElement = t.dom.document.body;
  assert.equal(t.dom.dispatch(t.dom.document.body, 'keydown', { key: 'b', ...(mac ? { metaKey: true } : { ctrlKey: true }) }).defaultPrevented, false);
});

test('DOM order follows the list after ⌥↓ / ⌥↑ (Tab order), and focus inside a moved row stays there', async (tc) => {
  const t = await mount(tc);
  const domShas = () => t.root.querySelectorAll('.re-row').map((r) => r.dataset.sha[0]).join('');
  t.key('ArrowDown', { altKey: true }); // c4 down
  assert.equal(t.order(), '3p 4p 2p 1p');
  assert.equal(domShas(), '3421');
  assert.equal(t.q('.re-spacer').firstChild, t.q('.re-drop-line'), 'the drop line stays first');
  // Tab from the first row's select reaches the next row's select in list order
  const selects = t.root.querySelectorAll('select');
  assert.deepEqual(selects.map((x) => x.getAttribute('aria-label')), ['Action for c3', 'Action for c4', 'Action for c2', 'Action for c1']);
  // a focused select in a row that moves up keeps its focus
  const sel = t.rows()[2].querySelector('select'); // c2
  sel.focus();
  t.store.actions.editRebase((m) => t.R.move(m, SHA('2'), -2));
  assert.equal(domShas(), '2341');
  assert.equal(t.dom.document.activeElement, sel);
});

test('drag auto-scroll keeps scrolling while the pointer rests at an edge, and stops at the end or on drop', async (tc) => {
  const shas = Array.from({ length: 250 }, (_, i) => (i + 1).toString(16).padStart(40, '0'));
  const t = await mount(tc, { p: plan({ shas }) });
  t.grid.rect = { left: 0, top: 100, right: 800, bottom: 500, width: 800, height: 400 };
  t.grid.clientHeight = 400;
  const doc = t.dom.document;
  t.dom.dispatch(t.rows()[0].querySelector('.re-c-handle'), 'pointerdown', { button: 0, clientY: 117, pointerId: 1 });
  t.dom.dispatch(doc, 'pointermove', { clientY: 300 });
  assert.equal(t.grid.scrollTop || 0, 0, 'not at an edge');
  t.dom.dispatch(doc, 'pointermove', { clientY: 490 }); // rests near the bottom edge
  await new Promise((r) => setTimeout(r, 30));
  const scrolled = t.grid.scrollTop;
  assert.ok(scrolled >= 3 * 17, `kept scrolling without pointer moves (${scrolled})`);
  assert.equal(t.q('.re-drop-line').style.transform, `translateY(${Math.round((490 - 100 + t.grid.scrollTop) / 34) * 34 - 1}px)`, 'the drop line follows the scroll');
  t.dom.dispatch(doc, 'pointerup', { clientY: 490 });
  const atDrop = t.grid.scrollTop;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.grid.scrollTop, atDrop, 'stopped on drop');
  // the top edge at scrollTop 0 has nowhere to go: no loop
  t.grid.scrollTop = 0;
  t.dom.dispatch(t.rows()[0].querySelector('.re-c-handle'), 'pointerdown', { button: 0, clientY: 117, pointerId: 1 });
  t.dom.dispatch(doc, 'pointermove', { clientY: 105 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(t.grid.scrollTop, 0);
  t.key('Escape');
});

test('keyboard: Enter edits the message (reword / squash group) through dialog.editMessage; elsewhere it focuses the select; ⌘↵ starts; Esc cancels', async (tc) => {
  const t = await mount(tc);
  t.key('j'); // c3
  t.key('r');
  t.edits.answer = 'c3 new\n\nnew body';
  t.key('Enter');
  await H.flush();
  assert.equal(t.edits.length, 1);
  assert.equal(t.edits[0].title, 'Reword "c3"');
  assert.equal(t.edits[0].message, 'c3\n\nbody 3');
  assert.deepEqual(t.R.messagesFor(t.model()), { [SHA('3')]: 'c3 new\n\nnew body' });
  assert.ok(t.rows()[1].querySelector('.re-edit').classList.contains('is-edited'));
  assert.equal(t.dom.document.activeElement, t.grid, 'focus back on the grid');
  // a squash group: the combined message, from any row of the group
  t.key('j'); // c2
  t.key('s');
  t.edits.answer = null; // cancelled: unchanged
  t.key('Enter');
  await H.flush();
  assert.equal(t.edits[1].title, 'Message for the 2 squashed commits');
  assert.equal(t.edits[1].message, 'c1\n\nbody 1\n\nc2\n\nbody 2');
  assert.match(t.edits[1].note, /combined into one/);
  // the ✎ button opens it too
  t.rows()[3].querySelector('.re-edit').click();
  await H.flush();
  assert.equal(t.edits.length, 3);
  // a pick: Enter focuses the row's select
  t.key('Home');
  t.key('Enter');
  await H.flush();
  assert.equal(t.edits.length, 3);
  assert.equal(t.dom.document.activeElement, t.rows()[0].querySelector('select'));
  // ⌘↵ from the select starts; Esc from it cancels (the flows decide what happens)
  const mod = t.win.Components.util.IS_MAC ? { metaKey: true } : { ctrlKey: true };
  t.key('Enter', mod);
  t.key('Enter', { ...mod, repeat: true });
  t.key('Escape');
  await H.flush();
  assert.deepEqual(t.calls, [['startInteractiveRebase'], ['cancelInteractiveRebase']]);
  // the buttons run the same flows
  t.q('.re-start').click();
  t.q('.re-cancel').click();
  await H.flush();
  assert.deepEqual(t.calls.slice(2), [['startInteractiveRebase'], ['cancelInteractiveRebase']]);
  // keys outside the editor (a sidebar field) are not the editor's
  const other = t.dom.document.createElement('input');
  t.dom.document.body.append(other);
  other.focus();
  t.key('Escape', {}, other);
  t.key('d', {}, other);
  await H.flush();
  assert.equal(t.calls.length, 4);
});

test('mouse: click / Shift-click / ⌘-click select; the select sets the action for the whole selection when its row is in it', async (tc) => {
  const t = await mount(tc);
  const at = (i) => t.rows()[i];
  t.dom.dispatch(at(0).querySelector('.re-subject'), 'click');
  t.dom.dispatch(at(2).querySelector('.re-subject'), 'click', { shiftKey: true });
  assert.deepEqual(t.rows().map((r) => r.classList.contains('is-selected')), [true, true, true, false]);
  const mod = t.win.Components.util.IS_MAC ? { metaKey: true } : { ctrlKey: true };
  t.dom.dispatch(at(1).querySelector('.re-subject'), 'click', mod);
  assert.deepEqual(t.rows().map((r) => r.classList.contains('is-selected')), [true, false, true, false]);
  const sel = at(0).querySelector('select');
  sel.value = 'drop';
  t.dom.dispatch(sel, 'change');
  assert.equal(t.order(), '4d 3p 2d 1p');
  // a row outside the selection: only that row
  const s3 = at(3).querySelector('select');
  s3.value = 'reword';
  t.dom.dispatch(s3, 'change');
  assert.equal(t.order(), '4d 3p 2d 1r');
  assert.deepEqual(t.rows().map((r) => r.classList.contains('is-selected')), [false, false, false, true]);
  // double-click edits the message
  t.dom.dispatch(at(3).querySelector('.re-subject'), 'dblclick');
  await H.flush();
  assert.equal(t.edits.length, 1);
});

test('pointer drag on ⋮⋮ reorders (threshold, drop line, the selection moves as a block); Esc cancels a drag', async (tc) => {
  const t = await mount(tc);
  t.grid.rect = { left: 0, top: 100, right: 800, bottom: 500, width: 800, height: 400 };
  const handle = (i) => t.rows()[i].querySelector('.re-c-handle');
  const doc = t.dom.document;
  // c1 (row 3, y 100 + 3*34) dragged to the top
  t.dom.dispatch(handle(3), 'pointerdown', { button: 0, clientY: 100 + 3 * 34 + 17, pointerId: 1 });
  t.dom.dispatch(doc, 'pointermove', { clientY: 100 + 3 * 34 + 18 }); // under the threshold
  assert.equal(t.q('.re-drop-line').hidden, true);
  t.dom.dispatch(doc, 'pointermove', { clientY: 100 + 5 });
  assert.equal(t.q('.re-drop-line').hidden, false);
  assert.ok(t.root.classList.contains('is-dragging'));
  assert.ok(t.rows()[3].classList.contains('is-dragged'));
  assert.equal(t.q('.re-drop-line').style.transform, 'translateY(-1px)');
  t.dom.dispatch(doc, 'pointerup', { clientY: 100 + 5 });
  assert.equal(t.order(), '1p 4p 3p 2p');
  assert.equal(t.q('.re-drop-line').hidden, true);
  assert.equal(t.q('.re-live').textContent, 'c1 moved to position 1 of 4');
  // a selection of two moves to the bottom
  t.key('Home');
  t.key('ArrowDown', { shiftKey: true }); // c1, c4
  t.dom.dispatch(handle(0), 'pointerdown', { button: 0, clientY: 110, pointerId: 1 });
  t.dom.dispatch(doc, 'pointermove', { clientY: 100 + 4 * 34 });
  t.dom.dispatch(doc, 'pointerup', {});
  assert.equal(t.order(), '3p 2p 1p 4p');
  // Esc cancels; a click without moving is no drag; right button is ignored
  t.dom.dispatch(handle(0), 'pointerdown', { button: 0, clientY: 110, pointerId: 1 });
  t.dom.dispatch(doc, 'pointermove', { clientY: 400 });
  t.key('Escape');
  t.dom.dispatch(doc, 'pointerup', {});
  assert.equal(t.order(), '3p 2p 1p 4p');
  assert.deepEqual(t.calls, [], 'Esc ended the drag, not the editor');
  t.dom.dispatch(handle(0), 'pointerdown', { button: 0, clientY: 110 });
  t.dom.dispatch(doc, 'pointerup', {});
  t.dom.dispatch(handle(0), 'pointerdown', { button: 2, clientY: 110 });
  t.dom.dispatch(doc, 'pointermove', { clientY: 400 });
  t.dom.dispatch(doc, 'pointerup', {});
  assert.equal(t.order(), '3p 2p 1p 4p');
  // auto-scroll near the bottom edge
  t.grid.scrollTop = 0;
  t.dom.dispatch(handle(0), 'pointerdown', { button: 0, clientY: 110 });
  t.dom.dispatch(doc, 'pointermove', { clientY: 495 });
  assert.ok(t.grid.scrollTop > 0);
  t.dom.dispatch(doc, 'pointercancel', {});
  assert.equal(t.order(), '3p 2p 1p 4p');
});

test('validation in the view: squash-first under the row and in the footer (Start disabled); the published warning; hash-lines', async (tc) => {
  const t = await mount(tc, { p: plan({ published: [SHA('1'), SHA('2')] }) });
  const notes = () => t.root.querySelectorAll('.re-note').map((n) => [n.dataset.code, n.textContent]);
  assert.deepEqual(notes(), [], 'nothing rewritten yet: no published warning');
  assert.ok(t.rows()[3].classList.contains('is-published'));
  assert.match(t.rows()[3].querySelector('.re-c-sha').title, /Already on origin\/feat/);
  t.key('End');
  t.key('r'); // rewording c1 rewrites every commit, the published c1 / c2 too
  assert.deepEqual(notes().filter(([c]) => c === 'published'), [['published', "⚠ 2 commits this rewrites are already pushed to origin/feat: you'll need to force push afterwards."]]);
  t.key('s');
  const bottom = t.rows()[3];
  assert.ok(bottom.classList.contains('is-error'));
  assert.equal(bottom.getAttribute('aria-invalid'), 'true');
  assert.equal(bottom.querySelector('.re-row-error').textContent, "The oldest commit can't be squashed: there's nothing below it to combine with");
  assert.equal(t.q('.re-error').textContent, "The oldest commit can't be squashed: there's nothing below it to combine with");
  assert.equal(t.q('.re-start').disabled, true);
  t.key('p');
  t.key('Home');
  t.key('r');
  t.store.actions.editRebase((m) => t.R.setMessage(m, SHA('4'), 'c4\n\n# not a comment'));
  assert.ok(notes().some(([c]) => c === 'hash-lines'));
  assert.ok(!notes().some(([c]) => c === 'published'), 'rewording c4 only: the published commits stay');
  assert.ok(notes().some(([c, text]) => c === 'rewrites' && text === 'Rewording "c4" rewrites 1 commit'));
  assert.equal(t.q('.re-start').disabled, false);
  assert.match(t.q('.re-start').title, /Start the rebase \((⌘↵|Ctrl\+Enter)\)/);
  // busy / running
  t.store.set({ busy: true });
  assert.equal(t.q('.re-start').disabled, true);
  assert.equal(t.q('.re-start').title, 'Working…');
  t.store.set({ busy: false });
  t.store.actions.patchRebaseEditor({ running: true });
  assert.equal(t.q('.re-start').textContent, 'Rebasing…');
  assert.equal(t.q('.re-cancel').disabled, true);
  assert.equal(t.rows()[0].querySelector('select').disabled, true);
  t.key('d');
  assert.equal(t.model().rows[0].action, 'reword', 'locked while running');
});

test('stale plan: HEAD moving (or another op) shows the reload prompt and disables Start; Reload runs the flow', async (tc) => {
  const t = await mount(tc);
  t.key('d');
  assert.equal(t.q('.re-stale').hidden, true);
  t.store.set({ status: { ...t.store.state.status, oid: SHA('9') } });
  assert.equal(t.q('.re-stale').hidden, false);
  assert.equal(t.q('.re-stale-text').textContent, 'The branch moved since you opened this plan: reload it to review the commits again');
  assert.equal(t.q('.re-reload').disabled, false, 'Reload re-reads the moved branch');
  assert.equal(t.q('.re-stale').getAttribute('role'), 'alert');
  assert.equal(t.q('.re-start').disabled, true);
  t.q('.re-reload').click();
  await H.flush();
  assert.deepEqual(t.calls, [['reloadInteractiveRebase']]);
  t.store.set({ status: { ...t.store.state.status, oid: SHA('4'), state: 'rebasing', rebase: H.rebaseState() } });
  assert.equal(t.q('.re-stale-text').textContent, 'A rebase is in progress: finish or abort it, then reload the plan');
  assert.equal(t.q('.re-reload').disabled, true, 'nothing to reload until the rebase is over');
  t.store.set({ status: { ...t.store.state.status, state: 'clean', rebase: null } });
  t.store.actions.patchRebaseEditor({ stale: 'The branch moved since you opened this plan: reload it to review the commits again' });
  assert.match(t.q('.re-stale-text').textContent, /reload it/);
  t.store.actions.patchRebaseEditor({ stale: null });
  assert.equal(t.q('.re-stale').hidden, true);
  assert.equal(t.q('.re-start').disabled, false);
});

test('another branch (or a detached HEAD) at the same sha: the stale bar names the plan\'s branch, Start and Reload are off', async (tc) => {
  const t = await mount(tc);
  t.key('d');
  assert.equal(t.q('.re-start').disabled, false);
  t.store.set({ status: { ...t.store.state.status, branch: 'feat2' } });
  assert.equal(t.q('.re-stale').hidden, false);
  assert.equal(t.q('.re-stale-text').textContent, 'This plan is for feat, which is no longer checked out: check it out again, or cancel the plan');
  assert.equal(t.q('.re-start').disabled, true);
  assert.equal(t.q('.re-start').title, t.q('.re-stale-text').textContent);
  assert.equal(t.q('.re-reload').disabled, true);
  t.store.set({ status: { ...t.store.state.status, branch: null } });
  assert.equal(t.q('.re-start').disabled, true, 'detached at the same commit');
  t.store.set({ status: { ...t.store.state.status, branch: 'feat' } });
  assert.equal(t.q('.re-stale').hidden, true);
  assert.equal(t.q('.re-start').disabled, false);
  // a pending autostash (planBlocker, as the Start flow checks it)
  t.store.set({ status: { ...t.store.state.status, pendingAutostash: SHA('7') } });
  assert.match(t.q('.re-stale-text').textContent, /restore or keep the stash left over/);
  assert.equal(t.q('.re-start').disabled, true);
});

test('virtualized above 200 rows: only the visible window is in the DOM, keyed by sha; scrolling renders the next window; 500 max', async (tc) => {
  const shas = Array.from({ length: 450 }, (_, i) => (i + 1).toString(16).padStart(40, '0'));
  const t = await mount(tc, { p: plan({ shas }) });
  const n = t.rows().length;
  assert.ok(n > 10 && n < 80, `window of ${n} rows`);
  assert.equal(t.q('.re-spacer').style.height, `${450 * 34}px`);
  assert.equal(t.rows()[0].dataset.sha, shas[449]);
  const firstEl = t.rows()[0];
  t.key('j');
  assert.equal(t.rows()[0], firstEl, 'rows are updated in place');
  t.grid.clientHeight = 340;
  t.key('End');
  await new Promise((r) => setTimeout(r, 5));
  const shown = t.rows();
  assert.equal(shown[shown.length - 1].dataset.sha, shas[0], 'the last row is rendered after End');
  assert.ok(Number(shown[0].dataset.index) > 300);
  assert.equal(t.grid.getAttribute('aria-activedescendant'), `re-row-${shas[0]}`);
  assert.equal(t.rows()[shown.length - 1].style.transform, `translateY(${449 * 34}px)`);
  // a plan above 500 commits is cut to the newest 500 by the model (the flow refuses it anyway)
  const big = Array.from({ length: 520 }, (_, i) => (i + 1).toString(16).padStart(40, '0'));
  t.store.actions.openRebaseEditor({ plan: plan({ shas: big }), args: {}, names: { branch: 'feat', onto: 'main' } });
  assert.equal(t.model().rows.length, 500);
  assert.equal(t.q('.re-spacer').style.height, `${500 * 34}px`);
});

// ------------------------------------------------------------------ Components.dialog.editMessage

async function dialogDom() {
  const win = H.loadFlows();
  const dom = H.fakeDom().install();
  dom.attach(win);
  return { win, dom, D: win.Components.dialog };
}

test('dialog.editMessage: summary + description prefilled from message, 72-char counter, Enter moves to the description, ⌘↵ saves', async () => {
  const { dom, D, win } = await dialogDom();
  const p = D.editMessage({ title: 'Reword "x"', message: 'first line\n\nthe body\nmore' });
  const box = dom.document.body.querySelector('.dlg');
  assert.equal(box.getAttribute('aria-modal'), 'true');
  assert.ok(box.classList.contains('dlg-wide'));
  const summary = box.querySelector('.dlg-summary');
  const desc = box.querySelector('.dlg-description');
  assert.equal(summary.value, 'first line');
  assert.equal(desc.value, 'the body\nmore');
  assert.equal(box.querySelector('.dlg-summary-count').textContent, String(72 - 'first line'.length));
  assert.equal(dom.document.activeElement, summary);
  assert.equal(D.isOpen(), true);
  dom.key('Enter');
  assert.equal(dom.document.activeElement, desc, 'Enter in the summary moves on');
  assert.equal(D.isOpen(), true);
  const plainEnter = dom.key('Enter');
  assert.equal(plainEnter.defaultPrevented, false, 'a newline in the description');
  summary.value = 'x'.repeat(80);
  dom.dispatch(summary, 'input');
  assert.equal(box.querySelector('.dlg-summary-count').textContent, '-8');
  assert.ok(box.querySelector('.dlg-summary-count').classList.contains('is-over'));
  summary.value = 'new subject';
  desc.value = 'new body\n# issue 12\n';
  dom.dispatch(desc, 'input');
  assert.equal(box.querySelector('.dlg-hash-note').hidden, false, 'the # warning');
  assert.equal(box.querySelector('.dlg-hash-note').textContent, 'Lines starting with # are removed in rebased messages');
  dom.key('Enter', win.Components.util.IS_MAC ? { metaKey: true } : { ctrlKey: true });
  assert.equal(await p, 'new subject\n\nnew body\n# issue 12');
  assert.equal(D.isOpen(), false);
});

test('dialog.editMessage: a blank message blocks Save; validate; Esc / Cancel resolve null; summary + description options', async () => {
  const { dom, D } = await dialogDom();
  const p = D.editMessage({ title: 't', summary: '', description: '', note: 'A note', okLabel: 'Keep' });
  const box = dom.document.body.querySelector('.dlg');
  const [cancel, ok] = box.querySelector('.dlg-actions').children;
  assert.equal(ok.textContent, 'Keep');
  assert.equal(ok.disabled, true, 'blank');
  assert.equal(box.querySelector('.dlg-error').hidden, true, 'no error until touched');
  assert.equal(box.querySelectorAll('.dlg-note').map((n) => n.textContent).includes('A note'), true);
  const summary = box.querySelector('.dlg-summary');
  summary.value = '  ';
  dom.dispatch(summary, 'input');
  assert.equal(box.querySelector('.dlg-error').textContent, 'Enter a commit message');
  assert.equal(summary.getAttribute('aria-invalid'), 'true');
  summary.value = 'ok';
  dom.dispatch(summary, 'input');
  assert.equal(ok.disabled, false);
  cancel.click();
  assert.equal(await p, null);

  const q = D.editMessage({ title: 't', message: 'bad', validate: (m) => (m === 'bad' ? 'Not that one' : null) });
  const b2 = dom.document.body.querySelector('.dlg');
  assert.equal(b2.querySelector('.dlg-actions').children[1].disabled, true);
  dom.key('Escape');
  assert.equal(await q, null);
  const r = D.editMessage({ title: 't', summary: 'only a summary' });
  dom.document.body.querySelector('.dlg').querySelector('.dlg-actions').children[1].click();
  assert.equal(await r, 'only a summary');
});
