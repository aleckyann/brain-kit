// The high water mark: per source, the last day the scheduled curator swept.
//
// docs/incidents.md, 17/09/2026: the mark holds the last target day swept
// (yesterday, on a healthy day) and reopens the window from there, so a
// machine suspended for days loses no day in silence. And 20/08/2026: a
// round that never read its sources exited 0 and wrote the previous day into
// the mark, closing a day nobody read. So the mark is kept per source, and it
// advances only when the model exited 0, the source's read evidence (taken
// from the round record, src/guards/read-evidence.mjs) is ok, and the model's
// final `BRAIN_KIT_SOURCES:` line reports the source. The agent's exit code
// alone never moves it.
//
// The file is STATE_FILES.WATERMARK in the vault's state directory:
//
//   { "sources": { "<source id>": "YYYY-MM-DD" } }
//
// A missing file means every source is unset. A file that cannot be read or
// has another shape is an error, never read as "unset": unset reopens only
// yesterday, and guessing it over a damaged file would skip days.
//
// Days are calendar days in the vault's time zone (config `vault.timezone`,
// an IANA name), computed with Intl alone. The window a round reads is
// [from, to): from local midnight of the first open day to local midnight of
// today, as Date instants.
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isValidIsoDate } from '../dates.mjs';
import { ensureStateDir, STATE_FILES } from '../state.mjs';

export const DEFAULT_MAX_DAYS = 7;
export const SOURCES_LINE_PREFIX = 'BRAIN_KIT_SOURCES:';

export class WatermarkError extends Error {
  constructor(file, detail) {
    super(`cannot read the watermark file ${file}: ${detail}`);
    this.name = 'WatermarkError';
    this.code = 'WATERMARK_UNREADABLE';
    this.file = file;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------- calendar

const DAY_MS = 24 * 60 * 60 * 1000;

function splitDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return { y, m, d };
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

// The day `n` days after `day` (n may be negative). Pure calendar
// arithmetic, no time zone involved.
export function addDays(day, n) {
  const { y, m, d } = splitDay(day);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// Whole days from `a` to `b` (positive when b is later).
export function daysBetween(a, b) {
  const pa = splitDay(a);
  const pb = splitDay(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / DAY_MS);
}

const formatters = new Map();
function formatterFor(tz) {
  let f = formatters.get(tz);
  if (f === undefined) {
    // Throws a RangeError for a name that is not a time zone, which is what
    // the caller should see: a vault with a broken time zone has no days.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

function wallClock(ms, tz) {
  const parts = {};
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    h: Number(parts.hour), min: Number(parts.minute), s: Number(parts.second),
  };
}

// The calendar day an instant falls on in `tz`.
export function localDay(instant, tz) {
  const w = wallClock(instant instanceof Date ? instant.getTime() : instant, tz);
  return `${pad(w.y, 4)}-${pad(w.m)}-${pad(w.d)}`;
}

// How far `tz`'s wall clock is ahead of UTC at instant `ms`, in ms.
function offsetAt(ms, tz) {
  const whole = Math.floor(ms / 1000) * 1000;
  const w = wallClock(whole, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - whole;
}

// The first instant of `day` in `tz`. Usually local 00:00; where a
// daylight saving change skips midnight (the clock jumps from 23:59:59 to
// 01:00), the day starts at the jump, so it is found by bisection between
// the two offsets around it. Where a change repeats midnight (01:00 back to
// 00:00), the earlier of the two 00:00 is the day's start.
export function startOfDay(day, tz) {
  const { y, m, d } = splitDay(day);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(first, tz);
  // Every offset in force within a day of the guess, so both occurrences
  // of a repeated midnight are candidates, tried earliest first.
  const candidates = new Set([first, second]);
  for (const probe of [guess - DAY_MS, guess + DAY_MS]) candidates.add(guess - offsetAt(probe, tz));
  for (const candidate of [...candidates].sort((a, b) => a - b)) {
    const w = wallClock(candidate, tz);
    if (localDay(candidate, tz) === day && w.h === 0 && w.min === 0 && w.s === 0) return new Date(candidate);
  }
  // No instant reads 00:00:00 on `day`: find the earliest instant whose
  // local day is `day` or later, between the two candidates widened by a
  // day on each side (the local day is monotonic across one change).
  let lo = Math.min(first, second) - DAY_MS;
  let hi = Math.max(first, second) + DAY_MS;
  const atOrAfter = (ms) => localDay(ms, tz) >= day;
  while (atOrAfter(lo)) lo -= DAY_MS;
  while (!atOrAfter(hi)) hi += DAY_MS;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (atOrAfter(mid)) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

// `today` is a Date (the instant now) or a 'YYYY-MM-DD' already in `tz`.
function todayIn(today, tz) {
  if (today instanceof Date) return localDay(today, tz);
  if (typeof today === 'string' && isValidIsoDate(today)) return today;
  throw new TypeError('today must be a Date or a YYYY-MM-DD string');
}

// The days a round reads: from the day after `mark` (yesterday when the
// mark is unset) to yesterday, inclusive, in `tz`. `from` is the first
// instant of the first day kept, `to` the first instant of the day after
// the last day kept (exclusive): today's, unless the window was clipped.
// More than `maxDays` open days keeps the OLDEST `maxDays` (ruling of
// 24/09/2026, fix round 1 of task 6): the round advances the mark through
// the last day it read, and `remaining` counts the newer open days left
// for the next round, so a machine that was off for weeks catches up
// oldest first and no day is ever closed unread. `clipped` is
// `remaining > 0`. An empty `days` means the mark already covers
// yesterday; then `from` equals `to`.
//
// A mark later than yesterday is an error state, never "covered": no round
// can have swept a day that has not ended, so it was written by a clock
// that ran ahead (a wrong clock at resume, a restored snapshot), and every
// real day up to it would be skipped in silence. It returns `future: true`
// with no days; `curate` exits 1 on it and names `watermark reopen`.
export function windowFor(mark, today, tz, { maxDays = DEFAULT_MAX_DAYS } = {}) {
  if (mark !== null && mark !== undefined && !isValidIsoDate(mark)) {
    throw new TypeError(`mark must be null or a YYYY-MM-DD string, got ${JSON.stringify(mark)}`);
  }
  if (!Number.isInteger(maxDays) || maxDays < 1) throw new TypeError('maxDays must be a positive integer');
  const current = todayIn(today, tz);
  const yesterday = addDays(current, -1);
  if (mark && mark > yesterday) {
    const to = startOfDay(current, tz);
    return { from: to, to, days: [], clipped: false, remaining: 0, future: true };
  }
  const first = mark ? addDays(mark, 1) : yesterday;
  const days = [];
  for (let day = first; day <= yesterday; day = addDays(day, 1)) days.push(day);
  const kept = days.slice(0, maxDays);
  const remaining = days.length - kept.length;
  const to = startOfDay(kept.length > 0 ? addDays(kept.at(-1), 1) : current, tz);
  const from = kept.length > 0 ? startOfDay(kept[0], tz) : to;
  return { from, to, days: kept, clipped: remaining > 0, remaining, future: false };
}

// ---------------------------------------------------------------- the file

export function watermarkFile(stateDir) {
  return join(stateDir, STATE_FILES.WATERMARK);
}

export function readWatermark(stateDir) {
  const file = watermarkFile(stateDir);
  if (!existsSync(file)) return { sources: {} };
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new WatermarkError(file, error.message);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.sources === null || typeof value.sources !== 'object' || Array.isArray(value.sources)) {
    throw new WatermarkError(file, 'expected { "sources": { "<id>": "YYYY-MM-DD" } }');
  }
  const sources = {};
  for (const [id, day] of Object.entries(value.sources)) {
    if (typeof day !== 'string' || !isValidIsoDate(day)) {
      throw new WatermarkError(file, `source ${id} holds ${JSON.stringify(day)}, not a YYYY-MM-DD date`);
    }
    sources[id] = day;
  }
  return { sources };
}

// Temp file in the same directory, mode 0600, then rename: a reader sees
// the old file or the new one, never half of one.
function writeAtomically(stateDir, mark) {
  ensureStateDir(stateDir);
  const file = watermarkFile(stateDir);
  const temp = join(stateDir, `.${STATE_FILES.WATERMARK}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(mark, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* already gone */ }
    throw error;
  }
}

// The owner's write (`brain-kit watermark set|reopen|assume-covered`): no
// condition but a valid day. Returns the previous day, or null.
export function setWatermark(stateDir, sourceId, day) {
  if (typeof sourceId !== 'string' || sourceId === '') throw new TypeError('sourceId must be a non-empty string');
  if (typeof day !== 'string' || !isValidIsoDate(day)) throw new TypeError(`day must be a YYYY-MM-DD date, got ${JSON.stringify(day)}`);
  const mark = readWatermark(stateDir);
  const previous = mark.sources[sourceId] ?? null;
  writeAtomically(stateDir, { sources: { ...mark.sources, [sourceId]: day } });
  return previous;
}

// The round's write. Moves the mark of `sourceId` to `day` only when:
//   - with `vacuous: true` (the empty window, no model ran): the source's
//     evidence says it expected nothing (evidence.expected === 0);
//   - otherwise: the model exited 0, AND the source's read evidence is ok,
//     AND the model's sources line reports the source `ok`, or `empty`
//     with evidence.expected === 0 (it said it found nothing, and the plan
//     indeed offered nothing).
// `emptyMeansNothingListed` is the source's own member of that name
// (src/sources/index.mjs), true when absent. A source that sets it false
// (the connector sources: phase 3, task 5) has a plan that never offers
// nothing while it is on, so nothing to read is itself a reading to prove:
// for it `empty` counts when its evidence is ok, which is the listing or
// search made (an empty day is a listing with no events), and only with
// something expected; and it never advances vacuously, since no model ran
// to make that listing. And it counts only when that listing or search
// listed nothing: `evidence.listed`, the events or files on the pages that
// read the source (src/harness/stream.mjs, `items`), must be exactly 0; an
// `empty` over a listing that found something, or whose count is not
// known, is `inconsistent_empty` (ruling R-F1: the search found two
// documents, none was opened, and the model said empty, the 10/08/2026
// shape).
// Never moves the mark backwards or onto the day it already holds, and
// never onto a day later than yesterday in `timezone` (the vault's zone,
// required) as of `now`: no round can have swept a day that has not ended.
// Returns { advanced: true, previous } or { advanced: false, reason }, and
// writes nothing in the second case.
export function advanceWatermark(stateDir, sourceId, day, {
  modelExit, evidence, sourcesLine, vacuous = false, timezone, now = new Date(), emptyMeansNothingListed = true,
} = {}) {
  if (typeof sourceId !== 'string' || sourceId === '') throw new TypeError('sourceId must be a non-empty string');
  if (typeof day !== 'string' || !isValidIsoDate(day)) throw new TypeError(`day must be a YYYY-MM-DD date, got ${JSON.stringify(day)}`);
  if (typeof timezone !== 'string' || timezone === '') throw new TypeError('advanceWatermark needs the vault time zone');
  if (day > addDays(todayIn(now, timezone), -1)) return { advanced: false, reason: 'future_day' };
  const hasEvidence = evidence !== null && typeof evidence === 'object';
  const listsNothing = emptyMeansNothingListed !== false;
  if (vacuous === true) {
    if (!listsNothing || !hasEvidence || evidence.expected !== 0) return { advanced: false, reason: 'not_vacuous' };
  } else {
    if (modelExit !== 0) return { advanced: false, reason: 'model_exit' };
    if (!hasEvidence || evidence.ok !== true) return { advanced: false, reason: 'no_evidence' };
    if (sourcesLine === null || typeof sourcesLine !== 'object') return { advanced: false, reason: 'no_sources_line' };
    const state = Object.hasOwn(sourcesLine, sourceId) ? sourcesLine[sourceId] : undefined;
    if (state === undefined) return { advanced: false, reason: 'not_reported' };
    if (state === 'empty') {
      if (listsNothing && evidence.expected !== 0) return { advanced: false, reason: 'empty_with_files' };
      if (!listsNothing && !(Number.isInteger(evidence.expected) && evidence.expected > 0)) return { advanced: false, reason: 'empty_nothing_listed' };
      if (!listsNothing && evidence.listed !== 0) return { advanced: false, reason: 'inconsistent_empty' };
    } else if (state !== 'ok') {
      return { advanced: false, reason: 'reported_failed' };
    }
  }
  const mark = readWatermark(stateDir);
  const previous = mark.sources[sourceId] ?? null;
  if (previous !== null && previous >= day) return { advanced: false, reason: 'not_later' };
  writeAtomically(stateDir, { sources: { ...mark.sources, [sourceId]: day } });
  return { advanced: true, previous };
}

// ---------------------------------------------------------------- the model's report

// The LAST line of the model's final text that starts with
// `BRAIN_KIT_SOURCES:`, read as space-separated `id=state` pairs, e.g.
// `BRAIN_KIT_SOURCES: transcripts=ok calendar=empty`. States are kept as
// written (`ok`, `empty`, `failed`, `partial`, `unavailable`, or anything
// else; only `ok` and `empty` can move a mark). A token without `=` is
// ignored. An id named twice keeps the first
// state that is not `ok`: a model contradicting itself in one line has not
// reported the source ok. One layer of markdown a model may wrap the line in
// (a `> ` quote, backticks, bold asterisks) is removed first; those
// characters never belong to an id or a state. No such line: null.
export function parseSourcesLine(text) {
  if (typeof text !== 'string') return null;
  let found = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^>\s*/, '').replace(/[`*]/g, '').trim();
    if (line.startsWith(SOURCES_LINE_PREFIX)) found = line;
  }
  if (found === null) return null;
  const states = {};
  for (const token of found.slice(SOURCES_LINE_PREFIX.length).trim().split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0 || eq === token.length - 1) continue;
    const id = token.slice(0, eq);
    if (Object.hasOwn(states, id) && states[id] !== 'ok') continue;
    states[id] = token.slice(eq + 1);
  }
  return states;
}
