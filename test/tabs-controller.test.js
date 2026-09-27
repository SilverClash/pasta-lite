'use strict';
// main/tabs-controller.js over fake views, window, runner and tabs.json: restoring the saved tabs,
// with tabs.json suppressed as a scoped counter and the restore stopping when its
// window goes away.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createTabsController } = require('../main/tabs-controller');

let nextId = 100;
function fakeContents() {
  const wc = {
    id: nextId++, destroyed: false, sent: [],
    send: (ch, p) => wc.sent.push([ch, p]),
    isDestroyed: () => wc.destroyed,
    once: () => {}, on: () => {},
    loadURL: () => Promise.resolve(),
    close: () => { wc.destroyed = true; },
    focus: () => {},
  };
  return wc;
}
class FakeView {
  constructor() { this.webContents = fakeContents(); this.visible = null; }
  setBackgroundColor() {}
  setVisible(v) { this.visible = v; }
  setBounds() {}
}

function setup({ saved = { roots: [], active: 0 } } = {}) {
  const calls = { created: 0, saves: [] };
  let win = null;
  const makeWin = () => ({
    destroyed: false,
    contentView: { addChildView() {}, removeChildView() {} },
    getContentSize: () => [1000, 700],
    setTitle() {},
    isFocused: () => false,
    isDestroyed() { return this.destroyed; },
    isFullScreen: () => false,
    webContents: fakeContents(),
  });
  const windowHost = {
    get: () => win,
    alive: () => !!win && !win.destroyed,
    create: () => { calls.created++; win = makeWin(); return win; },
    sendStrip() {},
    isFullScreen: () => false,
    close: () => { win.destroyed = true; win = null; },
  };
  const store = { load: () => saved, save: (s) => { calls.saves.push(s); return true; } };
  const logs = [];
  const controller = createTabsController({
    windowHost,
    runner: { running: () => [], on() {} },
    rendererLog: { forget() {} },
    ui: { interactive: true, confirm: async () => true, focus() {} },
    isMac: false,
    indexUrl: 'file:///index.html',
    viewPrefs: {},
    createWatcher: () => ({ pause() {}, resume() {}, close() {} }),
    logWatch: () => {},
    store: () => store,
    report: () => () => {},
    log: { info: (m, f) => logs.push([m, f]), warn: (m, f) => logs.push([m, f]) },
    View: FakeView,
    menu: { buildFromTemplate: () => ({ popup() {} }) },
  });
  /** A fake openBackgroundTab: a new tab with `root` open (as src/repo-opening.js does it). */
  const open = (hook = () => {}) => async (root, { abort } = {}) => {
    await hook(root);
    if (abort && abort()) return null;
    const s = controller.addTab({ activate: false });
    controller.setRepo(s, { root, name: root.slice(1), bare: false });
    return { info: s.repo, session: s };
  };
  windowHost.create();
  calls.created = 0;
  return { controller, windowHost, calls, logs, open };
}

describe('restoreTabs', () => {
  test('reopens the saved tabs in order, shows the saved active one, saves tabs.json once at the end', async () => {
    const { controller, calls, open } = setup({ saved: { roots: ['/a', null, '/b', '/c'], active: 2 } });
    await controller.restoreTabs(open());
    assert.deepEqual(controller.tabs.list().map((t) => t.repo.root), ['/a', '/b', '/c'], 'New Tabs are not restored');
    assert.equal(controller.tabs.active().repo.root, '/b');
    assert.ok(calls.saves.length > 0);
    for (const saved of calls.saves) assert.deepEqual(saved, { roots: ['/a', '/b', '/c'], active: 1 }, 'nothing saved while placing the tabs');
  });

  test('nothing to restore: one New Tab', async () => {
    const { controller, open } = setup();
    await controller.restoreTabs(open());
    assert.equal(controller.tabs.size, 1);
    assert.equal(controller.tabs.active().repo, null);
  });

  test('bug fix: the window closing mid-restore stops it; no window comes back, tabs.json is not rewritten', async () => {
    const t = setup({ saved: { roots: ['/a', '/b', '/c'], active: 0 } });
    const opened = [];
    await t.controller.restoreTabs(t.open((root) => {
      opened.push(root);
      if (root === '/b') {
        t.controller.destroyAll(); // what the window's 'closed' does
        t.windowHost.close();
      }
    }));
    assert.deepEqual(opened, ['/a', '/b'], 'the rest is not even opened');
    assert.equal(t.calls.created, 0, 'no window was created again');
    assert.equal(t.windowHost.get(), null);
    assert.equal(t.controller.tabs.size, 0);
    assert.deepEqual(t.calls.saves, []);
    assert.equal(t.logs.at(-1)[0], 'tab restore stopped: the window closed');
  });

  test('bug fix: suppression is a counter: two overlapping restores keep tabs.json quiet until both end', async () => {
    const t = setup({ saved: { roots: ['/a'], active: 0 } });
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = t.controller.restoreTabs(t.open(() => gate));
    const fast = t.controller.restoreTabs(t.open());
    await fast;
    t.controller.activateTab(t.controller.tabs.list()[0].id); // a change while the slow one still places tabs
    assert.deepEqual(t.calls.saves, [], 'still suppressed by the slow restore');
    release();
    await slow;
    assert.ok(t.calls.saves.length > 0);
    assert.deepEqual(t.calls.saves.at(-1).roots, ['/a', '/a']);
  });

  test('suppressPersist: release is idempotent; a change after the last release saves', () => {
    const t = setup();
    t.controller.addTab();
    const n = t.calls.saves.length;
    const r1 = t.controller.suppressPersist();
    const r2 = t.controller.suppressPersist();
    t.controller.addTab();
    r1();
    r1();
    t.controller.addTab();
    assert.equal(t.calls.saves.length, n, 'one hold is left');
    r2();
    t.controller.addTab();
    assert.equal(t.calls.saves.length, n + 1);
  });
});
