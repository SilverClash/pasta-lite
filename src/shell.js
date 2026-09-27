'use strict';
// Helpers for the Electron main process, kept free of Electron so they can be unit-tested with
// plain node:test. Re-exports only: the git-failure dialog text lives in gitcheck.js (next to
// findGit, whose result it describes), the PATH lookup in which.js (exec.js and gitcheck.js use it too).

const { describeGitFailure } = require('./gitcheck');
const { findOnPath, isRunnable } = require('./which');

module.exports = {
  describeGitFailure,
  findOnPath,
  isRunnable,
};
