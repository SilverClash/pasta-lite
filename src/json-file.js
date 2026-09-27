'use strict';
// Small JSON files in userData (recent.json, trusted.json, tabs.json): read tolerantly, written
// atomically. (src/gitfiles.js has its own readJson for files inside a git dir.)
const fs = require('node:fs');
const path = require('node:path');

/** Parsed JSON of `file`, or null when it is missing or corrupt. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Write `data` as JSON: tmp + rename, so a crash mid-write never leaves a truncated file. */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

module.exports = { readJson, writeJson };
