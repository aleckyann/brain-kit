// The pending tables, read into deadline buckets for the briefing.
//
// The briefing states which items are overdue, which are due today, which
// fall in the next few days and which carry no date at all. Every one of
// those is a fact the kit computes here, so the model never reads a date
// out of a table cell or does calendar arithmetic of its own (phase 4,
// layer 1).
//
// Which tables: `briefing.pending`, a list of
//   { file, heading, date_column, what_column }
// where `file` names a key of `taxonomy.files` (the path), `heading` a key
// of `taxonomy.columns.<file>.labels` (the heading line the table sits
// under, "## Open"), and the two columns are header cells of that table.
// A vault whose configuration predates the setting reads the language
// pack's own default list, the one `init` writes today, as it is: columns
// are always found by their exact header name, never by their place (fix
// round 1: a contract with a column inserted had its deadline read from the
// column beside it). A table without the named column is a problem naming
// file, heading and column, and none of its rows is bucketed; the owner
// names the columns in `briefing.pending`. The same default for
// `briefing.upcoming_days`.
//
// A cell's deadline is the FIRST date in it, written DD/MM/YYYY (day and
// month may have one digit) or YYYY-MM-DD, that is a real calendar date:
// "call Ana by 05/10/2026" is due 05/10/2026, "05/10/2026 or 12/10/2026"
// is due 05/10/2026. A date-shaped text that names no real day (31/02) is
// a problem naming the file and the line, and when the cell holds no real
// date at all the item goes to `undated`: an item is never dropped, and
// "no date" is a bucket of its own, never silence. A cell whose deadline
// was found but which holds any other date-like text (an unreal date, a
// date with no year, a second full date) keeps that deadline and is a
// problem naming the other texts: the deadline may not be the one meant
// (ruling R-T4).
//
// Buckets, for `today` in the vault's time zone and N upcoming days:
//   overdue   deadline before today
//   today     deadline equal to today
//   upcoming  deadline after today, at most N days after it
//   later     deadline after that (a count only)
//   undated   no real date in the cell
// The result carries `upcomingDays` too, the N it was computed with.
//
// A table that is not there, a heading that is not there, a column that is
// not there: each is a problem, never an exception, and the table it names
// is not read (its items are not guessed into any bucket). The heading
// written twice, or more than one table under it, is a problem too: the
// first heading and its first table are read, and what is left is said. A file under
// `briefing.never_read` is never opened.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../version.mjs';
import { REFERENCE_LANG, SUPPORTED_LANGS } from '../lang.mjs';
import { isValidCalendarDate, isValidIsoDate } from '../dates.mjs';
import { splitFrontmatter } from '../frontmatter.mjs';
import { stripCode } from '../markdown.mjs';
import { makeReadFile } from '../commands/validate.mjs';
import { bodyPrefixLineCount } from '../rules/house.mjs';
import { findAllTables } from '../rules/lint.mjs';
import { addDays, localDay } from '../guards/watermark.mjs';

// DD/MM/YYYY (one or two digits for the day and the month) or YYYY-MM-DD,
// not glued to another digit on either side: "123/10/2026" holds no date.
const DATE_IN_TEXT = /(?<!\d)(?:(\d{1,2})\/(\d{1,2})\/(\d{4})|(\d{4})-(\d{2})-(\d{2}))(?!\d)/g;

// A day and a month with no year, or a two-digit year ("05/10", "05/10/26"):
// no day can be computed from it, so the item stays undated, and a problem
// says which text was not taken for a date. Not glued to a digit or a slash
// on either side, so no part of a full DD/MM/YYYY matches.
const DATE_WITHOUT_YEAR = /(?<![\d/])\d{1,2}\/\d{1,2}(?:\/\d{2})?(?![\d/])/g;

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

// The deadline a cell holds: `{ deadline, invalid, incomplete, others }`,
// `deadline` the first real date as YYYY-MM-DD or null, `invalid` every
// date-shaped text in the cell that names no real day, as written,
// `incomplete` every day and month written without a four-digit year, and
// `others` every date-like text in the cell but the one the deadline came
// from (unreal, yearless, or a second full date), in the cell's order: what
// makes the deadline possibly not the one the person meant (ruling R-T4).
export function parseDeadline(cell) {
  const text = typeof cell === 'string' ? cell : '';
  let deadline = null;
  let chosen = -1;
  const invalid = [];
  const tokens = [];
  for (const match of text.matchAll(DATE_IN_TEXT)) {
    tokens.push({ at: match.index, value: match[0] });
    const dmy = match[1] !== undefined;
    const year = Number(dmy ? match[3] : match[4]);
    const month = Number(dmy ? match[2] : match[5]);
    const day = Number(dmy ? match[1] : match[6]);
    if (!isValidCalendarDate(year, month, day)) {
      invalid.push(match[0]);
      continue;
    }
    if (deadline === null) {
      deadline = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
      chosen = match.index;
    }
  }
  const incomplete = [];
  for (const match of text.matchAll(DATE_WITHOUT_YEAR)) {
    incomplete.push(match[0]);
    tokens.push({ at: match.index, value: match[0] });
  }
  const others = tokens.filter((token) => token.at !== chosen).sort((a, b) => a.at - b.at).map((token) => token.value);
  return { deadline, invalid, incomplete, others };
}

// Which bucket a deadline falls in: 'overdue' | 'today' | 'upcoming' |
// 'later' | 'undated'.
export function bucketOf(deadline, today, upcomingDays) {
  if (deadline === null) return 'undated';
  if (deadline < today) return 'overdue';
  if (deadline === today) return 'today';
  if (deadline <= addDays(today, upcomingDays)) return 'upcoming';
  return 'later';
}

// True when `path` (vault-relative, posix) is one `never_read` names: the
// same path, or a path under it, with or without a trailing "/" on the
// entry ("people" covers people/ana.md as "people/" does, and never
// peoplex/ana.md). An entry carrying a
// fragment ("memory/log.md#full") names its file too: reading a table out
// of a file means opening the whole file, which is what the fragment
// forbids.
export function inNeverRead(path, neverRead) {
  if (!Array.isArray(neverRead)) return false;
  for (const entry of neverRead) {
    if (typeof entry !== 'string' || entry === '') continue;
    const hash = entry.indexOf('#');
    const target = (hash === -1 ? entry : entry.slice(0, hash)).replace(/^\.\//, '').replace(/\/+$/, '');
    if (target === '') continue;
    if (path === target || path.startsWith(`${target}/`)) return true;
  }
  return false;
}

const packDefaults = new Map();
function defaultsFor(lang) {
  const chosen = SUPPORTED_LANGS.includes(lang) ? lang : REFERENCE_LANG;
  if (!packDefaults.has(chosen)) {
    packDefaults.set(chosen, JSON.parse(readFileSync(join(KIT_ROOT, 'lang', chosen, 'config.defaults.json'), 'utf8')));
  }
  return packDefaults.get(chosen);
}

// The pending tables the vault asks for, and how many days "upcoming"
// spans: the configuration's own values, or its language pack's defaults
// when the configuration predates them.
export function pendingSettings(config) {
  const briefing = config?.briefing ?? {};
  const pack = defaultsFor(config?.lang);
  return {
    entries: Array.isArray(briefing.pending) ? briefing.pending : pack.briefing.pending,
    upcomingDays: Number.isInteger(briefing.upcoming_days) ? briefing.upcoming_days : pack.briefing.upcoming_days,
  };
}

function todayOf(today, tz) {
  if (today instanceof Date) return localDay(today, tz);
  if (typeof today === 'string' && isValidIsoDate(today)) return today;
  throw new TypeError('today must be a Date or a YYYY-MM-DD string');
}

// The lines of the section under `heading` in the stripped body: from the
// line after it to the next heading of the same or a higher level (any
// heading, when the label is not itself an ATX heading). Returns
// { start, lines } with `start` the body line index of the first line, or
// null when no line reads exactly the heading. `repeated` is true when more
// than one line does: the first is read, and the others are said.
function sectionUnder(strippedLines, heading) {
  const label = heading.trim();
  const at = strippedLines.findIndex((line) => line.trim() === label);
  if (at === -1) return null;
  const repeated = strippedLines.filter((line) => line.trim() === label).length > 1;
  const own = ATX_HEADING.exec(label);
  const level = own === null ? 0 : own[1].length;
  let end = strippedLines.length;
  for (let i = at + 1; i < strippedLines.length; i += 1) {
    const found = ATX_HEADING.exec(strippedLines[i]);
    if (found !== null && (level === 0 || found[1].length <= level)) {
      end = i;
      break;
    }
  }
  return { start: at + 1, lines: strippedLines.slice(at + 1, end), repeated };
}

function sortDated(items) {
  return items.sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0) || (a.order - b.order));
}

function strip(items) {
  return items.map(({ order, ...item }) => item);
}

export function pendingBuckets({ root, config, today, tz }) {
  const day = todayOf(today, tz);
  const { entries, upcomingDays } = pendingSettings(config);
  const files = config?.taxonomy?.files ?? {};
  const columns = config?.taxonomy?.columns ?? {};
  const neverRead = config?.briefing?.never_read;
  const readFile = makeReadFile(root);
  const buckets = { overdue: [], today: [], upcoming: [], undated: [] };
  let later = 0;
  const problems = [];
  const seen = new Set();
  let order = 0;

  for (const entry of entries) {
    const fileKey = entry?.file;
    const headingKey = entry?.heading;
    const path = typeof fileKey === 'string' && Object.hasOwn(files, fileKey) ? files[fileKey] : null;
    if (typeof path !== 'string' || path === '') {
      problems.push({ code: 'not_configured', detail: { file: String(fileKey) } });
      continue;
    }
    const labels = columns[fileKey]?.labels;
    const heading = labels !== null && typeof labels === 'object' && typeof headingKey === 'string' && Object.hasOwn(labels, headingKey)
      ? labels[headingKey] : null;
    if (typeof heading !== 'string' || heading.trim() === '') {
      problems.push({ code: 'heading_not_configured', detail: { file: fileKey, heading: String(headingKey) } });
      continue;
    }
    const key = JSON.stringify([path, heading.trim()]);
    if (seen.has(key)) {
      problems.push({ code: 'duplicate_entry', detail: { path, heading } });
      continue;
    }
    seen.add(key);
    if (inNeverRead(path, neverRead)) {
      problems.push({ code: 'never_read', detail: { path } });
      continue;
    }

    let text;
    try {
      text = readFile(path);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') problems.push({ code: 'file_missing', detail: { path } });
      else problems.push({ code: 'unreadable', detail: { path, detail: error.code ?? error.message } });
      continue;
    }
    const { body } = splitFrontmatter(text);
    const prefix = bodyPrefixLineCount(text, body);
    const section = sectionUnder(stripCode(body).split('\n'), heading);
    if (section === null) {
      problems.push({ code: 'heading_missing', detail: { path, heading } });
      continue;
    }
    if (section.repeated) problems.push({ code: 'heading_repeated', detail: { path, heading } });
    const [table, ...others] = findAllTables(section.lines.join('\n'));
    if (table === undefined) {
      problems.push({ code: 'table_missing', detail: { path, heading } });
      continue;
    }
    if (others.length > 0) problems.push({ code: 'tables_ignored', detail: { path, heading, count: others.length } });
    const header = table.headerCells.map((cell) => cell.trim());
    const headerLine = prefix + section.start + table.headerLineIndex;
    const dateAt = header.indexOf(String(entry.date_column ?? '').trim());
    const whatAt = header.indexOf(String(entry.what_column ?? '').trim());
    let complete = true;
    for (const [at, column] of [[dateAt, entry.date_column], [whatAt, entry.what_column]]) {
      if (at === -1) {
        problems.push({ code: 'column_missing', detail: { path, heading, column: String(column), line: headerLine } });
        complete = false;
      }
    }
    if (!complete) continue;

    for (const row of table.dataRows) {
      const cells = row.cells.map((cell) => cell.trim());
      if (cells.every((cell) => cell === '')) continue;
      const line = prefix + section.start + row.lineIndex;
      const raw = cells[dateAt] ?? '';
      const { deadline, invalid, incomplete, others } = parseDeadline(raw);
      if (deadline === null) {
        for (const value of invalid) problems.push({ code: 'invalid_date', detail: { path, line, value } });
        for (const value of incomplete) problems.push({ code: 'date_without_year', detail: { path, line, value } });
      } else if (others.length > 0) {
        // The item keeps its bucket by the first real date, and the cell is
        // named with every other date-like text in it (ruling R-T4).
        problems.push({ code: 'ambiguous_deadline', detail: { path, line, deadline, others } });
      }
      const item = { file: path, line, what: cells[whatAt] ?? '', deadline, raw, order };
      order += 1;
      const bucket = bucketOf(deadline, day, upcomingDays);
      if (bucket === 'later') later += 1;
      else buckets[bucket].push(item);
    }
  }

  return {
    overdue: strip(sortDated(buckets.overdue)),
    today: strip(buckets.today),
    upcoming: strip(sortDated(buckets.upcoming)),
    undated: strip(buckets.undated),
    later,
    upcomingDays,
    problems,
  };
}
