'use strict';
// The open tabs, remembered in userData/tabs.json and restored at launch. Pure apart
// from the file itself: main's tabs controller saves a snapshot of the registry (src/tabs.js)
// after every change and restores it with restoreActive.
const path = require('node:path');
const { readJson, writeJson } = require('./json-file');

const MAX_TABS_SAVED = 50;

/**
 * The open tabs, persisted as {version: 1, tabs: [{root|null}], active: index}, written atomically
 * (tmp + rename, like recent.json). A New Tab is kept as {root: null} so the order survives.
 * load() never throws: missing or corrupt → no tabs. save() writes only when the content changed.
 */
function createTabsStore(filePath) {
  let last = null; // the JSON last written or read
  function load() {
    const data = readJson(filePath);
    const list = data && Array.isArray(data.tabs) ? data.tabs.slice(0, MAX_TABS_SAVED) : [];
    const roots = list.map((t) => (t && typeof t.root === 'string' && path.isAbsolute(t.root) ? t.root : null));
    const a = data && Number.isInteger(data.active) ? data.active : 0;
    const res = { roots, active: roots.length ? Math.max(0, Math.min(a, roots.length - 1)) : 0 };
    last = JSON.stringify(toJson(res));
    return res;
  }
  const toJson = ({ roots, active }) => ({ version: 1, tabs: roots.map((root) => ({ root: root || null })), active });
  /** Save {roots, active}; true when the file was written. Throws when it can't be. */
  function save(state) {
    const data = toJson(state);
    const json = JSON.stringify(data);
    if (json === last) return false;
    writeJson(filePath, data);
    last = json;
    return true;
  }
  return { load, save };
}

/**
 * The saved state as main keeps it: roots in strip order (null for a New Tab) and the active index.
 * `tabs` is the registry.
 */
function snapshot(tabs) {
  const list = tabs.list();
  return { roots: list.map((t) => (t.repo ? t.repo.root : null)), active: Math.max(0, tabs.indexOf(tabs.activeId)) };
}

/**
 * Restoring: `opened` are the saved indexes that became tabs again, in order (gone roots, failed
 * opens and New Tabs are left out). Returns the index (into `opened`) to activate: the saved
 * active tab if it came back, else the nearest one before it, else the first; -1 when none.
 */
function restoreActive(savedActive, opened) {
  if (!opened.length) return -1;
  const exact = opened.indexOf(savedActive);
  if (exact >= 0) return exact;
  let best = 0;
  opened.forEach((saved, i) => { if (saved < savedActive) best = i; });
  return best;
}

module.exports = { createTabsStore, snapshot, restoreActive };
