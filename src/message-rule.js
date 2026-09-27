'use strict';
// The one rule for commit messages the renderer sends (commit, Continue, Commit and Merge, an
// interactive rebase's reword / squash messages) and the git layer takes: a string, not blank
// (kind 'empty-message'), no NUL byte and at most MESSAGE_MAX bytes (kind 'invalid-args').
// Ops check it first; rebase.startInteractive and git.commit apply it again (defence in depth).
const { kindError } = require('./exec');

/** Max bytes of a commit message given to Continue, reword and squash. */
const MESSAGE_MAX = 64 * 1024;

/**
 * What is wrong with message `x`, or null: 'type' (not a string), 'blank', 'content' (a NUL
 * byte, or more than `max` bytes; `max: Infinity` for no cap).
 */
function messageProblem(x, { max = MESSAGE_MAX } = {}) {
  if (typeof x !== 'string') return 'type';
  if (!x.trim()) return 'blank';
  if (x.includes('\0') || (Number.isFinite(max) && Buffer.byteLength(x) > max)) return 'content';
  return null;
}

/**
 * `x` when messageProblem finds nothing, else throw: kind 'invalid-args' ("<what> must be a
 * string" / "<what> must have no NUL and at most <max> bytes") or 'empty-message' (`empty`).
 */
function messageRule(x, { what = 'message', empty = 'Commit message cannot be empty', max = MESSAGE_MAX } = {}) {
  const problem = messageProblem(x, { max });
  if (problem === 'type') throw kindError('invalid-args', `${what} must be a string`);
  if (problem === 'blank') throw kindError('empty-message', empty);
  if (problem === 'content') {
    throw kindError('invalid-args', `${what} must have no NUL${Number.isFinite(max) ? ` and at most ${max} bytes` : ''}`);
  }
  return x;
}

module.exports = { MESSAGE_MAX, messageProblem, messageRule };
