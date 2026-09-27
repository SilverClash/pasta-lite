'use strict';
// Object ids and ref names: the pure helpers every git module shares. No git process runs here
// (the object-format probe is in src/git-reads.js), so any module may require this one.

/** A full object id: 40 hex digits (sha1) or 64 (sha256), lower case. */
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** True when `oid` is all zeros (git's "no object": a created or deleted ref in a reflog). */
const isZero = (oid) => /^0+$/.test(oid);

/** The 7-digit abbreviation of an object id, as the UI and our messages show it. */
const sha7 = (s) => s.slice(0, 7);

/** The ref namespaces we read and write. */
const PREFIX = Object.freeze({ HEADS: 'refs/heads/', REMOTES: 'refs/remotes/', TAGS: 'refs/tags/' });

/** `ref` without `prefix`, or null when it doesn't start with it. */
const after = (ref, prefix) => (typeof ref === 'string' && ref.startsWith(prefix) ? ref.slice(prefix.length) : null);

/** The branch name of 'refs/heads/<name>', or null for any other ref. */
const branchOf = (ref) => after(ref, PREFIX.HEADS);

/**
 * The short name git shows for a branch or remote-tracking ref: 'refs/heads/x' -> 'x',
 * 'refs/remotes/origin/x' -> 'origin/x'; anything else unchanged.
 */
const shortName = (ref) => after(ref, PREFIX.HEADS) ?? after(ref, PREFIX.REMOTES) ?? ref;

/** 'refs/heads/<name>'. */
const fullBranch = (name) => `${PREFIX.HEADS}${name}`;

/** 'refs/remotes/<name>' ('origin/x' -> 'refs/remotes/origin/x'). */
const fullRemote = (name) => `${PREFIX.REMOTES}${name}`;

/**
 * for-each-ref's `%(upstream:track,nobracket)` ('ahead 2, behind 1', 'gone', ''):
 * {ahead, behind, gone}.
 */
function parseTrack(track) {
  const t = String(track || '');
  const ahead = /ahead (\d+)/.exec(t);
  const behind = /behind (\d+)/.exec(t);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: t === 'gone' };
}

// A name that can only ever mean itself inside `refs/heads/<name>:refs/heads/<name>`: no refspec
// or revision metacharacters, whitespace or leading '-'. (check-ref-format covers most of these;
// '+' is valid in branch names but reads as "force" at the start of a refspec.)
const REFSPEC_SAFE = /^(?![-+])[^*:^~?[\\\s\0]+$/; // leading '+' would mean force; mid-name '+' is fine

/** True when the branch name `name` is safe inside an explicit push refspec (REFSPEC_SAFE). */
const isRefspecSafe = (name) => typeof name === 'string' && REFSPEC_SAFE.test(name);

module.exports = {
  OID, isZero, sha7, PREFIX, after, branchOf, shortName, fullBranch, fullRemote, parseTrack, REFSPEC_SAFE, isRefspecSafe,
};
