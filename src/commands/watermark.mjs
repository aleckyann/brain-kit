// The `watermark` command: the owner's view of, and hand on, the high
// water mark the scheduled curator keeps per source (src/guards/watermark.mjs).
//
//   brain-kit watermark show [dir]
//   brain-kit watermark set <source> <YYYY-MM-DD> [dir]
//   brain-kit watermark reopen <source> <YYYY-MM-DD> [dir]
//   brain-kit watermark assume-covered <source> [dir]
//   brain-kit watermark import --from <file> [--sources <id,id,...>] [dir]
//
// `show` prints each source's mark and how many days behind yesterday it
// is. `set` writes a day as the last one swept. `reopen` moves the mark back
// so the given day, and every day after it, is read again by the next
// round. `assume-covered` sets the mark to yesterday and prints every day it
// skips, so nothing is closed in silence (docs/incidents.md, 20/08/2026).
// Days are calendar days in the vault's time zone (config vault.timezone);
// a mark can never name today or a later day, because no round can have
// swept a day that has not ended.
//
// `import` carries over the mark of a legacy setup that kept one date in a
// file of its own (phase 5a): the file must hold exactly one line, a day
// written as YYYY-MM-DD, with or without a final LF or CRLF, and that day
// becomes the last day swept of the chosen sources, every enabled source
// when --sources is not given. An enabled source is one a round reads: the
// round's own `active` (src/commands/curate.mjs, sourcesOf), listed in
// curate.sources, known to this version and configured. Everything is
// checked before anything is written: the file's one line, a real day,
// that day not after yesterday in the vault's zone (the rule `set`
// applies), and every source named enabled. A refusal quotes what the file
// holds, its first QUOTE_CHARS characters. Then the sources are written one
// after another along `set`'s own path, below, and one line per source
// says the day written and the mark it replaced. The file is only read:
// never written, moved or removed.
//
// The writing subcommands take the vault lock (src/guards/lock.mjs), so
// they never race a round; `show` only reads, and the mark is written by
// rename, so it never sees half a file. The source of set, reopen and
// assume-covered must be one the vault's configuration names
// (curate.sources or sources), or one the mark already holds.
//
// `deps` hands in the environment, the working directory and the clock, for
// the tests. Production passes nothing.
import { Buffer } from 'node:buffer';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, loadConfig } from '../config.mjs';
import { isValidIsoDate } from '../dates.mjs';
import { findVaultRoot } from '../vault.mjs';
import { stateDirFor } from '../state.mjs';
import { acquireLock } from '../guards/lock.mjs';
import { GuardError } from '../guards/location.mjs';
import {
  addDays, daysBetween, DEFAULT_MAX_DAYS, localDay, readWatermark, setWatermark, WatermarkError, watermarkFile,
} from '../guards/watermark.mjs';
import { sourcesOf } from './curate.mjs';

const ROOT_INDEX = 'index.md';
const SUBCOMMANDS = Object.freeze({ show: 0, set: 2, reopen: 2, 'assume-covered': 1, import: 0 });
// The options, each with one value, by the name parseArgs files them under.
// Only `import` takes them.
const OPTIONS = Object.freeze({ '--from': 'from', '--sources': 'sources' });

// The legacy file: exactly one line, a day written as YYYY-MM-DD, with or
// without a final LF or CRLF. `$` without the m flag is the end of the text.
const LEGACY_LINE = /^(\d{4}-\d{2}-\d{2})(?:\r?\n)?$/;
// How much of the legacy file is read: far more than the 12 bytes of the
// longest file that can pass, and enough to quote the start of any other.
const LEGACY_READ_BYTES = 4096;
// How much of what was read a refusal quotes.
const QUOTE_CHARS = 80;
// A character that prints as nothing or as a blank other than the space (a
// byte order mark, a zero width space, a no-break space): a quote names it
// as <U+XXXX>, so a file that looks right and is refused shows why.
const INVISIBLE = /(?! )[\p{C}\p{Z}]/gu;

// A day as a person reads it (DD/MM/YYYY); YYYY-MM-DD stays for arguments
// and files.
function shown(day) {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

// The command that brings a mark ahead of yesterday back: yesterday is read
// again; an earlier day reads more.
function reopenCommand(source, yesterday) {
  return `brain-kit watermark reopen ${source} ${yesterday}`;
}

function daysFrom(first, last) {
  const days = [];
  for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}

// The rule every day written as a mark passes, whichever subcommand writes
// it: a day the calendar has, and one that has ended in the vault's zone.
// null, 'bad_date' or 'future_date'.
function dayProblem(day, yesterday) {
  if (!isValidIsoDate(day)) return 'bad_date';
  if (day > yesterday) return 'future_date';
  return null;
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const option = eq === -1 ? arg : arg.slice(0, eq);
    if (arg === '--help' || arg === '-h') help = true;
    else if (Object.hasOwn(OPTIONS, option)) {
      if (Object.hasOwn(options, OPTIONS[option])) return { error: 'argument', arg };
      let value;
      if (eq !== -1) value = arg.slice(eq + 1);
      else if (i + 1 < argv.length) {
        i += 1;
        value = argv[i];
      }
      if (value === undefined || value === '') return { error: 'missing_value', arg: option };
      options[OPTIONS[option]] = value;
    } else if (arg.startsWith('-')) return { error: 'argument', arg };
    else positional.push(arg);
  }
  if (help) return { help: true };
  const [sub, ...rest] = positional;
  if (sub === undefined) return { error: 'missing' };
  if (!Object.hasOwn(SUBCOMMANDS, sub)) return { error: 'subcommand', arg: sub };
  const given = Object.keys(OPTIONS).find((name) => Object.hasOwn(options, OPTIONS[name]));
  if (sub !== 'import' && given !== undefined) return { error: 'argument', arg: given };
  if (sub === 'import' && options.from === undefined) return { error: 'no_from' };
  let sources;
  if (options.sources !== undefined) {
    const ids = options.sources.split(',').map((id) => id.trim());
    if (ids.includes('')) return { error: 'bad_sources', arg: options.sources };
    sources = [...new Set(ids)];
  }
  const need = SUBCOMMANDS[sub];
  if (rest.length < need) return { error: 'missing' };
  if (rest.length > need + 1) return { error: 'argument', arg: rest[need + 1] };
  return { sub, operands: rest.slice(0, need), dir: rest[need], from: options.from, sources };
}

function knownSources(config, mark) {
  const ids = new Set([
    ...(config.curate?.sources?.required ?? []),
    ...(config.curate?.sources?.best_effort ?? []),
    ...Object.keys(config.sources ?? {}),
    ...Object.keys(mark.sources),
  ]);
  return [...ids];
}

// The start of the legacy file, read and never written: `problem` when it
// cannot be read as a regular file, else its first LEGACY_READ_BYTES.
function readLegacyFile(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { problem: 'not_found' };
    return { problem: 'unreadable', detail: error.code ?? error.message };
  }
  if (!stat.isFile()) return { problem: 'not_a_file' };
  let fd;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size, LEGACY_READ_BYTES));
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.toString('utf8', 0, length) };
  } catch (error) {
    return { problem: 'unreadable', detail: error.code ?? error.message };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// What the file holds, as a refusal quotes it: its first QUOTE_CHARS
// characters in double quotes, a line break or a tab escaped as JSON
// escapes it, and a character INVISIBLE matches named.
function quoteOf(text, t) {
  const chars = Array.from(text);
  const quote = JSON.stringify(chars.slice(0, QUOTE_CHARS).join(''))
    .replace(INVISIBLE, (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
  return chars.length > QUOTE_CHARS ? t('watermark.import_cut', { quote, max: QUOTE_CHARS }) : quote;
}

// Everything `import` checks, all before anything is written: the file,
// its one line, its day (dayProblem, set's own rule), and the sources.
// { day, sources } to write, or { code } once the refusal is on stderr.
function planImport(parsed, { cwd, config, yesterday, tz }, io, t) {
  const file = resolve(cwd, parsed.from);
  const read = readLegacyFile(file);
  if (read.problem === 'not_found') {
    io.stderr.write(`${t('watermark.import_not_found', { file })}\n`);
    return { code: EXIT.USAGE };
  }
  if (read.problem === 'not_a_file') {
    io.stderr.write(`${t('watermark.import_not_a_file', { file })}\n`);
    return { code: EXIT.USAGE };
  }
  if (read.problem === 'unreadable') {
    io.stderr.write(`${t('watermark.import_unreadable', { file, detail: read.detail })}\n`);
    return { code: EXIT.USAGE };
  }
  const content = quoteOf(read.text, t);
  const line = LEGACY_LINE.exec(read.text);
  if (line === null) {
    io.stderr.write(`${t('watermark.import_bad_line', { file, content })}\n`);
    return { code: EXIT.USAGE };
  }
  const day = line[1];
  const problem = dayProblem(day, yesterday);
  if (problem === 'bad_date') {
    io.stderr.write(`${t('watermark.import_bad_day', { file, content })}\n`);
    return { code: EXIT.USAGE };
  }
  if (problem === 'future_date') {
    io.stderr.write(`${t('watermark.import_future', { file, content, day: shown(day), timezone: tz, yesterday: shown(yesterday) })}\n`);
    return { code: EXIT.USAGE };
  }
  const enabled = sourcesOf(config).active.map((source) => source.id);
  if (enabled.length === 0) {
    io.stderr.write(`${t('watermark.import_no_enabled')}\n`);
    return { code: EXIT.USAGE };
  }
  const sources = parsed.sources ?? enabled;
  const names = sources.filter((id) => !enabled.includes(id));
  if (names.length > 0) {
    io.stderr.write(`${t('watermark.import_not_enabled', { names, enabled })}\n`);
    return { code: EXIT.USAGE };
  }
  return { day, sources };
}

export async function runWatermark(argv, io, t, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? new Date();
  const parsed = parseArgs(argv);
  if (parsed.help) {
    io.stdout.write(`${t('watermark.usage')}\n`);
    return EXIT.OK;
  }
  if (parsed.error) {
    if (parsed.error === 'subcommand') io.stderr.write(`${t('watermark.unknown_subcommand', { arg: parsed.arg })}\n`);
    else if (parsed.error === 'argument') io.stderr.write(`${t('watermark.bad_argument', { arg: parsed.arg })}\n`);
    else if (parsed.error === 'missing_value') io.stderr.write(`${t('watermark.missing_value', { option: parsed.arg })}\n`);
    else if (parsed.error === 'no_from') io.stderr.write(`${t('watermark.import_no_from')}\n`);
    else if (parsed.error === 'bad_sources') io.stderr.write(`${t('watermark.import_bad_sources', { value: parsed.arg })}\n`);
    io.stderr.write(`${t('watermark.usage')}\n`);
    return EXIT.USAGE;
  }

  let startDir = cwd;
  if (parsed.dir !== undefined) {
    startDir = resolve(cwd, parsed.dir);
    if (!existsSync(startDir)) {
      io.stderr.write(`${t('watermark.path_not_found', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
    if (!statSync(startDir).isDirectory()) {
      io.stderr.write(`${t('watermark.path_not_a_directory', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
  }
  const root = findVaultRoot(startDir);
  if (!root) {
    io.stderr.write(`${t('watermark.no_vault', { dir: startDir, config: CONFIG_FILENAME, index: ROOT_INDEX })}\n`);
    return EXIT.USAGE;
  }
  const config = loadConfig(root);
  const tz = config.vault.timezone;
  let yesterday;
  try {
    yesterday = addDays(localDay(now, tz), -1);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    io.stderr.write(`${t('watermark.bad_timezone', { timezone: tz, file: CONFIG_FILENAME })}\n`);
    return EXIT.USAGE;
  }
  const stateDir = stateDirFor(root, env);

  let mark;
  try {
    mark = readWatermark(stateDir);
  } catch (error) {
    if (error instanceof WatermarkError) {
      io.stderr.write(`${t('watermark.unreadable', { file: error.file, detail: error.detail })}\n`);
      return EXIT.FAILURE;
    }
    throw error;
  }
  const sources = knownSources(config, mark);

  if (parsed.sub === 'show') {
    io.stdout.write(`${t('watermark.show_header', { file: watermarkFile(stateDir), timezone: tz, yesterday: shown(yesterday) })}\n`);
    for (const source of sources) {
      const day = mark.sources[source];
      if (day === undefined) io.stdout.write(`${t('watermark.show_unset', { source })}\n`);
      // A mark later than yesterday was written by a clock that ran ahead;
      // every real day up to it would be skipped (src/guards/watermark.mjs).
      else if (day > yesterday) io.stdout.write(`${t('watermark.show_future', { source, day: shown(day), ahead: daysBetween(yesterday, day), yesterday: shown(yesterday), command: reopenCommand(source, yesterday) })}\n`);
      else io.stdout.write(`${t('watermark.show_line', { source, day: shown(day), behind: Math.max(0, daysBetween(day, yesterday)) })}\n`);
    }
    return EXIT.OK;
  }

  // The sources to write and the day given, every check passed before the
  // lock is even asked for: nothing is written unless all of them pass.
  let targets;
  let dayArg;
  if (parsed.sub === 'import') {
    const plan = planImport(parsed, { cwd, config, yesterday, tz }, io, t);
    if (plan.code !== undefined) return plan.code;
    targets = plan.sources;
    dayArg = plan.day;
  } else {
    const [source, day] = parsed.operands;
    if (!sources.includes(source)) {
      io.stderr.write(`${t('watermark.unknown_source', { source, sources })}\n`);
      return EXIT.USAGE;
    }
    const problem = day === undefined ? null : dayProblem(day, yesterday);
    if (problem === 'bad_date') {
      io.stderr.write(`${t('watermark.bad_date', { value: day })}\n`);
      return EXIT.USAGE;
    }
    if (problem === 'future_date') {
      io.stderr.write(`${t('watermark.future_date', { day: shown(day), yesterday: shown(yesterday), timezone: tz })}\n`);
      return EXIT.USAGE;
    }
    targets = [source];
    dayArg = day;
  }
  const none = t('watermark.import_none');

  let lock;
  try {
    lock = acquireLock(root, { command: `watermark ${parsed.sub}`, env });
  } catch (error) {
    if (error instanceof GuardError) {
      io.stderr.write(`${t(error.messageKey, error.params)}\n`);
      return error.exitCode;
    }
    throw error;
  }
  try {
    // One source after another, under one hold of the lock: set, reopen and
    // assume-covered write one, import every source it checked.
    for (const source of targets) {
      // Read again under the lock: a round may have moved it since.
      const current = readWatermark(stateDir).sources[source] ?? null;
      // Unset reads only yesterday, so it behaves as a mark on the day before.
      const effective = current ?? addDays(yesterday, -1);
      let target;
      if (parsed.sub === 'set' || parsed.sub === 'import') {
        target = dayArg;
      } else if (parsed.sub === 'reopen') {
        if (dayArg > effective) {
          io.stderr.write(`${t('watermark.already_open', { source, day: shown(dayArg), mark: current === null ? '-' : shown(current) })}\n`);
          return EXIT.USAGE;
        }
        target = addDays(dayArg, -1);
      } else {
        target = yesterday;
      }
      if (target !== current) setWatermark(stateDir, source, target);
      if (parsed.sub === 'import') {
        // One line per source: the day written and the mark it replaced.
        if (target === current) io.stdout.write(`${t('watermark.import_unchanged', { source, day: shown(target) })}\n`);
        else io.stdout.write(`${t('watermark.imported', { source, day: shown(target), previous: current === null ? none : shown(current) })}\n`);
        continue;
      }
      if (target === current) {
        io.stdout.write(`${t('watermark.unchanged', { source, day: shown(target) })}\n`);
        continue;
      }
      const skipped = target > effective ? daysFrom(addDays(effective, 1), target) : [];
      io.stdout.write(`${t('watermark.moved', { source, from: current === null ? '-' : shown(current), to: shown(target) })}\n`);
      if (skipped.length > 0) {
        io.stdout.write(`${t('watermark.skipped', { count: skipped.length, days: skipped.map(shown) })}\n`);
      }
      const open = daysBetween(target, yesterday);
      if (open > DEFAULT_MAX_DAYS) {
        io.stdout.write(`${t('watermark.beyond_clip', { count: open, max: DEFAULT_MAX_DAYS })}\n`);
      }
    }
    return EXIT.OK;
  } catch (error) {
    if (error instanceof WatermarkError) {
      io.stderr.write(`${t('watermark.unreadable', { file: error.file, detail: error.detail })}\n`);
      return EXIT.FAILURE;
    }
    throw error;
  } finally {
    lock.release();
  }
}
