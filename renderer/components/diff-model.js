'use strict';
// Pure helpers of the diff view (plain script; exposes window.PLDiff, and module.exports under
// node for the tests). No DOM: row flattening, widths, specs, staging rules and the write flow.
(function () {
  const TAB = 4;
  const dn = (s) => window.Components.util.displayName(s);

  // Bidi controls, zero-width characters, BOM, and C0/C1 controls except TAB (line text never holds \n).
  const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
  const CONTROLS_G = new RegExp(CONTROLS.source, 'g');
  const ctlLabel = (c) => `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`;
  const CTL_EXTRA = ctlLabel('\u202e').length - 1; // extra columns a marker takes

  /** Visual width in columns of `s` with tabs expanded to TAB stops and control markers counted. */
  function columns(s) {
    let extra = 0;
    if (CONTROLS.test(s)) extra = (s.match(CONTROLS_G) || []).length * CTL_EXTRA;
    if (s.indexOf('\t') < 0) return s.length + extra;
    let col = 0;
    for (let i = 0; i < s.length; i++) col = s.charCodeAt(i) === 9 ? col + TAB - (col % TAB) : col + 1;
    return col + extra;
  }

  const MODE_NAMES = { 100644: 'file', 100755: 'executable', 120000: 'symlink', 160000: 'submodule', '040000': 'folder' };
  const modeName = (m) => (m ? `${MODE_NAMES[m] || 'mode'} ${m}` : '');

  /** The file views of a result, for both the sectioned and the older single-file shape. */
  function sectionsOf(data) {
    if (!data) return [];
    if (Array.isArray(data.sections)) return data.sections;
    return data.file ? [data.file] : [];
  }

  /** Sub-header label for one section of a multi-section diff. */
  function sectionLabel(f) {
    const path = dn(f.isDeleted ? f.oldPath || f.newPath : f.newPath || f.oldPath);
    if (f.isDeleted) return `Deleted ${modeName(f.oldMode)} · ${path}`;
    if (f.isNew) return `Added ${modeName(f.newMode)} · ${path}`;
    if (f.isRename || f.isCopy) return `${f.isRename ? 'Renamed' : 'Copied'} ${dn(f.oldPath)} → ${path}`;
    return `Modified · ${path}`;
  }

  /** Message for a file view without hunks. */
  function emptyText(f) {
    const modeOnly = f.oldMode && f.newMode && f.oldMode !== f.newMode;
    if (f.isBinary) return 'Binary file — no preview';
    if (f.isRename) return 'File renamed without content changes';
    if (f.isCopy) return 'File copied without content changes';
    if (modeOnly) return `File mode changed ${f.oldMode} → ${f.newMode}`;
    if (f.isNew) return 'Empty file';
    if (f.isDeleted) return 'Empty file deleted';
    return 'No changes';
  }

  /**
   * Flatten file views (or a conflict) into rows:
   * {t:'section', label} | {t:'note', text} | {t:'hunk', hunk, section, index} | {t:'line', line, s, h, li}
   * | {t:'cline', line} (conflict) | {t:'eof'}.
   * Also: hunkRows (row index of each hunk header), maxCols, maxNo, adds, dels, prefixW, and
   * blocked[h] (hunk h of section 0 can't be staged by hunk/line: truncated or with a clipped line).
   */
  function flatten(sections, conflict) {
    const rows = [];
    const hunkRows = [];
    const acc = { maxCols: 0, maxNo: 0, adds: 0, dels: 0, prefixW: 0 };
    const addHunk = (hunk, section, index) => {
      hunkRows.push(rows.length);
      rows.push({ t: 'hunk', hunk, section, index });
      acc.maxCols = Math.max(acc.maxCols, hunk.header.length + (hunk.truncated ? 18 : 0));
    };
    if (conflict) {
      conflict.hunks.forEach((hunk, index) => {
        addHunk(hunk, 0, index);
        for (const line of hunk.lines) {
          rows.push({ t: 'cline', line });
          if (line.noNewlineAtEof) rows.push({ t: 'eof' });
          acc.prefixW = Math.max(acc.prefixW, (line.prefix || '').length);
          acc.maxCols = Math.max(acc.maxCols, columns(line.text) + (line.cr ? 2 : 0) + (line.clipped ? 18 : 0));
          if (/\+/.test(line.prefix || '')) acc.adds++;
          if (/-/.test(line.prefix || '')) acc.dels++;
        }
      });
      return { rows, hunkRows, blocked: [], ...acc };
    }
    const multi = sections.length > 1;
    const blocked = [];
    sections.forEach((file, s) => {
      if (multi) rows.push({ t: 'section', label: sectionLabel(file) });
      if (!file.hunks.length) {
        if (multi) rows.push({ t: 'note', text: emptyText(file) });
        return;
      }
      file.hunks.forEach((hunk, index) => {
        addHunk(hunk, s, index);
        if (s === 0) blocked[index] = !!hunk.truncated || hunk.lines.some((l) => l.clipped);
        hunk.lines.forEach((line, li) => {
          // h/li: indices into sections[s].hunks[h].lines — the selection payload of hunks.js.
          rows.push({ t: 'line', line, s, h: index, li });
          const c = columns(line.text) + (line.cr ? 2 : 0) + (line.clipped ? 18 : 0);
          if (c > acc.maxCols) acc.maxCols = c;
          if (line.oldNo > acc.maxNo) acc.maxNo = line.oldNo;
          if (line.newNo > acc.maxNo) acc.maxNo = line.newNo;
          if (line.type === 'add') acc.adds++;
          else if (line.type === 'del') acc.dels++;
          if (line.noNewlineAtEof) rows.push({ t: 'eof' });
        });
      });
    });
    return { rows, hunkRows, blocked, ...acc };
  }

  /** Header title {old, path}: the rename from the diff, else from the spec, else the file. */
  function specTitle(spec, file) {
    if (file && (file.isRename || file.isCopy) && file.oldPath && file.newPath && file.oldPath !== file.newPath) {
      return { old: file.oldPath, path: file.newPath };
    }
    if (spec.orig && spec.orig !== spec.file) return { old: spec.orig, path: spec.file };
    if (file) return { old: null, path: file.newPath || file.oldPath || spec.file };
    return { old: null, path: spec.file };
  }

  /** Conflict line class: marker lines, else by the combined-diff prefix columns. */
  function conflictClass(line) {
    if (/^(<{7}|={7}|>{7}|\|{7})( |$)/.test(line.text)) return 'dv-conflict-marker';
    const p = line.prefix || '';
    if (p.includes('-')) return 'dv-del';
    if (p.includes('+')) return 'dv-add';
    return 'dv-context';
  }

  /**
   * Same diff target (kind, file, staged side, commit). A spec re-made by the store's followSpec
   * (untracked → tracked after a partial stage, a staged rename's orig updated) is the same.
   */
  const sameSpec = (a, b) => !!a && !!b && a.kind === b.kind && a.file === b.file
    && !!a.staged === !!b.staged && (a.sha || null) === (b.sha || null);

  /** Index into hunkRows of the last hunk header at or above `row`, or -1. */
  function hunkAt(hunkRows, row) {
    let k = -1;
    for (let lo = 0, hi = hunkRows.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1;
      if (hunkRows[mid] <= row) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return k;
  }

  /** 'unstaged' (incl. untracked) | 'staged' | null (commit diff, conflict, not loaded). */
  function actMode(spec, data) {
    if (!spec || spec.kind !== 'workdir' || !data || data.conflict) return null;
    return spec.staged ? 'staged' : 'unstaged';
  }

  const SPECIAL_MODES = new Set(['120000', '160000']); // symlink, submodule
  const isSpecial = (f) => SPECIAL_MODES.has(String(f.oldMode || '')) || SPECIAL_MODES.has(String(f.newMode || ''));

  /** The status entry of the spec's file on its side (staged / unstaged), or null. */
  function entryOf(spec, status) {
    if (!status || !spec) return null;
    return (spec.staged ? status.staged : status.unstaged).find((f) => f.path === spec.file) || null;
  }

  /**
   * A staged rename's or copy's status entry (it carries an old path; the diff is made over both
   * paths, and the header shows old → new), else null.
   */
  function origEntry(spec, status) {
    const e = spec && spec.staged ? entryOf(spec, status) : null;
    return e && e.orig && e.orig !== e.path ? e : null;
  }

  /**
   * Whether hunk / line actions are possible for this diff (per-hunk limits: flat.blocked). They
   * need the staging fingerprint (exactly one fully parsed text section), a regular file (no
   * symlink / submodule, no type change), and no staged rename or copy (diffed over two paths).
   */
  function hunkDataOk(spec, data, status) {
    if (!actMode(spec, data) || !data.fingerprint) return false;
    const sections = sectionsOf(data);
    if (sections.length !== 1 || isSpecial(sections[0])) return false;
    const entry = entryOf(spec, status);
    return !(entry && entry.status === 'T') && !origEntry(spec, status);
  }

  /** Why hunk / line staging is unavailable for a workdir diff that has content, else null. */
  function stagingNote(spec, data, status) {
    if (!data || !actMode(spec, data) || hunkDataOk(spec, data, status)) return null;
    const sections = sectionsOf(data);
    if (!sections.length) return null;
    const whole = spec.staged ? 'Unstage File' : 'Stage File';
    const entry = entryOf(spec, status);
    if (sections.length > 1 || (entry && entry.status === 'T')) return `Type change — stage it as a whole with ${whole}.`;
    if (sections[0].isBinary) return `Binary file — stage it as a whole with ${whole}.`;
    if (isSpecial(sections[0])) return `Symlink or submodule — stage it as a whole with ${whole}.`;
    if (!sections[0].hunks.length) return null;
    if (origEntry(spec, status)) return `Renamed file — hunk and line unstaging isn't available; use ${whole}.`;
    if (data.truncated) return `Diff too large for hunk and line staging — use ${whole}.`;
    return `Hunk and line staging isn't available for this diff — use ${whole}.`;
  }

  /** Row i can be picked for line staging (canPick: hunkDataOk of the shown diff). */
  function isPickable(flat, i, canPick) {
    if (!canPick || !flat) return false;
    const r = flat.rows[i];
    return !!r && r.t === 'line' && r.s === 0 && (r.line.type === 'add' || r.line.type === 'del') && !flat.blocked[r.h];
  }

  /** The next pickable row after `from` in direction `dir` (±1), or -1. */
  function nextPickable(flat, from, dir, canPick) {
    if (!flat) return -1;
    for (let i = from + dir; i >= 0 && i < flat.rows.length; i += dir) if (isPickable(flat, i, canPick)) return i;
    return -1;
  }

  /** [{hunk, lines}] for the picked row indices, in file order (hunks.js selection). */
  function selectionPayload(picked, rows) {
    const byHunk = new Map();
    for (const i of [...picked].sort((a, b) => a - b)) {
      const r = rows[i];
      if (!byHunk.has(r.h)) byHunk.set(r.h, []);
      byHunk.get(r.h).push(r.li);
    }
    return [...byHunk].map(([hunk, lines]) => ({ hunk, lines }));
  }

  const SELECTION_OPS = { stage: 'stageSelection', unstage: 'unstageSelection', discard: 'discardSelection' };

  /**
   * One working-tree write with its guards (the sequence of the flows-worktree.js flows, which the
   * diff view runs with its in-flight hooks). Side effects go through `io`:
   *   isOff()          a write is in flight (ours or another) — do nothing
   *   begin()          mark ours in flight (before the confirm: a second click can't start one)
   *   confirm(c)       -> Promise<boolean>; c = opts.confirm (dialog options, or a function)
   *   isCurrent()      the diff acted on is still the one shown (after the confirm)
   *   isBusy()         another write started meanwhile
   *   write()          -> Promise (store.actions.write)
   *   hold()           success: keep "in flight" until the reloaded diff arrives
   *   end()            not sent, or failed: clear "in flight" now
   *   stale(e)         the backend refused a changed file (kind 'stale')
   *   fail(e)          any other error (report it unless already toasted)
   *   changed()        `check` failed: the file changed since the confirm
   * opts: {confirm, check()}. Resolves to 'busy' | 'cancelled' | 'moved' | 'changed' | 'ok' | 'stale' | 'error'.
   */
  async function writeFlow(io, { confirm = null, check = null } = {}) {
    if (io.isOff()) return 'busy';
    io.begin();
    let held = false;
    try {
      if (confirm && !(await io.confirm(confirm))) return 'cancelled';
      if (!io.isCurrent() || io.isBusy()) return 'moved';
      if (check && !check()) {
        io.changed();
        return 'changed';
      }
      await io.write();
      held = true;
      io.hold();
      return 'ok';
    } catch (e) {
      if (e && e.kind === 'stale') {
        io.stale(e);
        return 'stale';
      }
      io.fail(e);
      return 'error';
    } finally {
      if (!held) io.end();
    }
  }

  const api = {
    CONTROLS, CONTROLS_G, ctlLabel, columns, sectionsOf, sectionLabel, emptyText, flatten, specTitle,
    conflictClass, sameSpec, hunkAt, actMode, entryOf, origEntry, hunkDataOk, stagingNote, isPickable, nextPickable,
    selectionPayload, SELECTION_OPS, writeFlow,
  };
  if (typeof window !== 'undefined') window.PLDiff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
