'use strict';
// The loaded history as a graph (plain script; exposes window.PLHistory, and module.exports under
// node for the tests; loads after policy.js, before store.js, which re-exports it on window.Store).
// Pure, no DOM; cached per commits array (a new log or page is a new array).
//   ancestorsOf(commits, sha) -> Set of the loaded hashes reachable from `sha` (itself included) | null
//   headAncestors(state) -> ancestorsOf(state.commits, HEAD) (PLPolicy.headView's oid) | null
//   tipsContaining(commits, tips) -> null | (sha) -> [tip names]: which of `tips` ([{name, oid}], e.g.
//                                  the remote branches) have a loaded commit in their history, from one walk
(function () {
  const P = (typeof window !== 'undefined' && window.PLPolicy) || (typeof module !== 'undefined' && typeof require === 'function' ? require('./policy.js') : null);

  // Ancestor sets over the loaded history, cached per commits array (a new log or page is a new array).
  const ancestorCache = new WeakMap(); // commits -> Map sha -> Set | null
  const indexCache = new WeakMap(); // commits -> Map hash -> position

  /** hash -> position in `commits` (cached per commits array). */
  function indexOf(commits) {
    if (!indexCache.has(commits)) indexCache.set(commits, new Map(commits.map((c, i) => [c.hash, i])));
    return indexCache.get(commits);
  }

  /**
   * The loaded commits reachable from `sha` through parents, `sha` included: a Set of hashes, or null
   * when `sha` isn't loaded. Exact for the loaded rows: git.log's --date-order never shows a parent
   * before all its children, so every commit between `sha` and a loaded ancestor is loaded too
   * (docs/plans/rebase.md §5.1). Pure (cached per commits array).
   */
  function ancestorsOf(commits, sha) {
    if (!Array.isArray(commits) || typeof sha !== 'string' || !sha) return null;
    if (!ancestorCache.has(commits)) ancestorCache.set(commits, new Map());
    const perSha = ancestorCache.get(commits);
    if (perSha.has(sha)) return perSha.get(sha);
    const out = walkAncestors(commits, sha);
    if (perSha.size > 16) perSha.clear();
    perSha.set(sha, out);
    return out;
  }

  /** The uncached walk of ancestorsOf. */
  function walkAncestors(commits, sha) {
    const index = indexOf(commits);
    if (!index.has(sha)) return null;
    const out = new Set();
    const todo = [sha];
    while (todo.length) {
      const h = todo.pop();
      const c = commits[index.get(h)];
      if (out.has(h) || !c) continue;
      out.add(h);
      for (const p of c.parents || []) if (!out.has(p)) todo.push(p);
    }
    return out;
  }

  /**
   * Which of `tips` ([{name, oid}]) reach each loaded commit: a function sha -> [names] (in `tips`
   * order; [] for a commit none reaches or that isn't loaded), or null when a tip isn't loaded. One
   * pass over the history, children before parents (the --date-order guarantee of ancestorsOf): each
   * commit's bitmask of tips is OR-ed into its parents'. Pure.
   */
  function tipsContaining(commits, tips) {
    if (!Array.isArray(commits)) return null;
    const list = Array.isArray(tips) ? tips : [];
    const index = indexOf(commits);
    if (list.some((t) => !t || !index.has(t.oid))) return null;
    const words = Math.max(1, Math.ceil(list.length / 32));
    const masks = new Uint32Array(commits.length * words);
    list.forEach((t, i) => { masks[index.get(t.oid) * words + (i >> 5)] |= 1 << (i & 31); });
    for (let c = 0; c < commits.length; c++) {
      for (const p of commits[c].parents || []) {
        const j = index.get(p);
        if (j === undefined) continue;
        for (let w = 0; w < words; w++) masks[j * words + w] |= masks[c * words + w];
      }
    }
    return (sha) => {
      const c = index.get(sha);
      if (c === undefined) return [];
      return list.filter((t, i) => (masks[c * words + (i >> 5)] >>> (i & 31)) & 1).map((t) => t.name);
    };
  }

  /** ancestorsOf(state.commits, HEAD) for store state `s`, or null (unborn, HEAD not loaded). */
  function headAncestors(s) {
    const oid = s ? P.headView(s).oid : null;
    return s && oid ? ancestorsOf(s.commits, oid) : null;
  }

  const api = { ancestorsOf, headAncestors, tipsContaining };
  if (typeof window !== 'undefined') window.PLHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
