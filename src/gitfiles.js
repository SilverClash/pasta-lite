'use strict';
// Readers for the small files git (and our state folder) keep inside the git dir: rebase-merge/*,
// MERGE_HEAD, MERGE_MSG, <git-dir>/pasta-lite/*. None follows a symlink or reads a big file, and
// none throws for an odd file: a caller treats null as "missing or malformed".
const fs = require('node:fs');
const path = require('node:path');
const { OID } = require('./gitref');

/** Max bytes of a git-dir file we read. */
const MAX_FILE = 1024 * 1024;

/** Contents of the regular file `p` (not a symlink, at most MAX_FILE bytes), or null. */
function readSmall(p) {
  try {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.size > MAX_FILE) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** A JSON object stored in the regular file `p`, or null (missing, malformed, not an object). */
function readJson(p) {
  const raw = readSmall(p);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const exists = (p) => !!fs.lstatSync(p, { throwIfNoEntry: false });

/** True when `p` is a real directory (not a symlink to one). */
const isRealDir = (p) => {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  return !!st && st.isDirectory() && !st.isSymbolicLink();
};

/**
 * A message file as the composer shows it: lines starting with the comment string `char` removed,
 * blank lines around trimmed; null when nothing is left.
 */
function stripComments(text, char = '#') {
  if (typeof text !== 'string') return null;
  const t = text.split('\n').filter((l) => !l.startsWith(char)).join('\n').trimEnd();
  return t.replace(/^\n+/, '') || null;
}

/**
 * status.merge while MERGE_HEAD exists: {head, name, message}.
 * - head: the (first) commit being merged, or null when MERGE_HEAD is unreadable
 * - name: the branch / commit named in MERGE_MSG's subject ("Merge branch 'x'…",
 *   "Merge remote-tracking branch 'origin/x'", "Merge commit 'abc'"), or null
 * - message: MERGE_MSG minus comment lines (`char`: the repo's core.commentChar), what Commit
 *   and Merge without a message commits; null when empty
 * It only reads two files of the git dir `gd`.
 */
function mergeState(gd, char = '#') {
  const first = (readSmall(path.join(gd, 'MERGE_HEAD')) || '').split('\n')[0].trim();
  const message = stripComments(readSmall(path.join(gd, 'MERGE_MSG')), char);
  const m = message && /^Merge (?:remote-tracking branch|branch|tag|commit) '([^'\n]+)'/.exec(message);
  return { head: OID.test(first) ? first : null, name: m ? m[1] : null, message };
}

module.exports = { readSmall, readJson, exists, isRealDir, stripComments, mergeState };
