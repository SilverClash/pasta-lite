'use strict';
// The recent list as main last showed it (the pages' start screen and picker, the Open Recent
// menu). app:openRecent may only open a root from this list, never an arbitrary path
// (src/repo-opening.js findShownRecent). Pure: the store (src/recent.js) is passed in.

/**
 * @param {{store: () => ({list(): Promise<{root: string, name: string}[]>} | null)}} o
 *   store: the recent store, or null before main created it (then the list is empty).
 * @returns {{refresh(): Promise<{root: string, name: string}[]>, readonly shown: {root: string, name: string}[]}}
 *   refresh: re-read the list (it stats every entry) and return it; an older, slower read never
 *   replaces a newer one. shown: the list last read.
 */
function createRecentView({ store }) {
  let shown = [];
  let seq = 0;
  async function refresh() {
    const mine = ++seq;
    const s = store();
    const list = s ? (await s.list()).map(({ root, name }) => ({ root, name })) : [];
    if (mine === seq) shown = list;
    return shown;
  }
  return { refresh, get shown() { return shown; } };
}

module.exports = { createRecentView };
