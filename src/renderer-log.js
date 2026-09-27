'use strict';
// Main-side validation for the renderer's fire-and-forget `app:log` records. Pure:
// main.js checks the sender (senderContext) and passes the rest here; tests use a fake logger/clock.
//
// A renderer (even a compromised one) can only add records to main.log, so everything is bounded:
// - level must be one of LEVELS (anything else is dropped);
// - msg must be a string; msg + fields are capped at maxBytes of JSON (beyond it the fields are
//   replaced by {truncated: <bytes>} and msg is cut);
// - fields must be a plain object (anything else is dropped from the record);
// - at most `max` records per `windowMs` per sender; the rest are counted and reported as one
//   "dropped N renderer log records" warning when the next window opens (or on forget()).
// The logger redacts every record again, whatever the renderer already did.

const { LEVELS: LOG_LEVELS } = require('./log');

const LEVELS = new Set(Object.keys(LOG_LEVELS)); // the logger's own levels
const MAX_BYTES = 8 * 1024;
const RATE_MAX = 50;
const RATE_WINDOW_MS = 10000;

const isPlainObject = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const jsonSize = (v) => {
  try {
    return Buffer.byteLength(JSON.stringify(v) || '');
  } catch {
    return Infinity;
  }
};

/**
 * Validate one record: {level, msg, fields} ready for the logger, or null to drop it.
 * Exported for tests; accept() below adds the rate limit.
 */
function validate(level, msg, fields, { maxBytes = MAX_BYTES } = {}) {
  if (typeof level !== 'string' || !LEVELS.has(level)) return null;
  if (typeof msg !== 'string') return null;
  let f = isPlainObject(fields) ? fields : undefined;
  let m = msg;
  if (jsonSize({ msg: m, fields: f }) > maxBytes) {
    const bytes = jsonSize({ msg, fields });
    if (Buffer.byteLength(m) > maxBytes / 2) m = `${Buffer.from(m).subarray(0, Math.floor(maxBytes / 2)).toString('utf8')}…`;
    f = { truncated: Number.isFinite(bytes) ? bytes : 'unserializable' };
  }
  return { level, msg: m, fields: f };
}

/**
 * @param {{logger: {log(level, msg, fields)}, now?: () => number, max?: number,
 *   windowMs?: number, maxBytes?: number}} o  logger: a child logger (scope 'renderer').
 * @returns {{accept(senderId, level, msg, fields): boolean, forget(senderId): void}}
 *   accept: true when the record was logged. forget: the sender went away (window closed or its
 *   renderer crashed): report what it had dropped and free its counters.
 */
function createRendererLogSink({
  logger, now = Date.now, max = RATE_MAX, windowMs = RATE_WINDOW_MS, maxBytes = MAX_BYTES,
}) {
  const senders = new Map(); // id -> {start, count, dropped}

  function reportDropped(id, s) {
    if (!s.dropped) return;
    logger.log('warn', `dropped ${s.dropped} renderer log records (rate limit ${max} per ${windowMs / 1000} s)`, { sender: id });
    s.dropped = 0;
  }

  function accept(senderId, level, msg, fields) {
    const rec = validate(level, msg, fields, { maxBytes });
    if (!rec) return false;
    const t = now();
    let s = senders.get(senderId);
    if (!s || t - s.start >= windowMs) {
      if (s) reportDropped(senderId, s);
      s = { start: t, count: 0, dropped: 0 };
      senders.set(senderId, s);
    }
    if (s.count >= max) {
      s.dropped++;
      return false;
    }
    s.count++;
    logger.log(rec.level, rec.msg, rec.fields);
    return true;
  }

  function forget(senderId) {
    const s = senders.get(senderId);
    if (!s) return;
    reportDropped(senderId, s);
    senders.delete(senderId);
  }

  return { accept, forget };
}

module.exports = { createRendererLogSink, validate, MAX_BYTES };
