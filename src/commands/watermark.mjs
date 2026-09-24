// The `watermark` command: the owner's view of, and hand on, the high
// water mark the scheduled curator keeps per source (src/guards/watermark.mjs).
//
//   brain-kit watermark show [dir]
//   brain-kit watermark set <source> <YYYY-MM-DD> [dir]
//   brain-kit watermark reopen <source> <YYYY-MM-DD> [dir]
//   brain-kit watermark assume-covered <source> [dir]
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
// The three writing subcommands take the vault lock (src/guards/lock.mjs),
// so they never race a round; `show` only reads, and the mark is written by
// rename, so it never sees half a file. The source must be one the vault's
// configuration names (curate.sources or sources), or one the mark already
// holds.
//
// `deps` hands in the environment, the working directory and the clock, for
// the tests. Production passes nothing.
import { existsSync, statSync } from 'node:fs';
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

const ROOT_INDEX = 'index.md';
const SUBCOMMANDS = Object.freeze({ show: 0, set: 2, reopen: 2, 'assume-covered': 1 });

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

function parseArgs(argv) {
  const positional = [];
  let help = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg.startsWith('-')) return { error: 'argument', arg };
    else positional.push(arg);
  }
  if (help) return { help: true };
  const [sub, ...rest] = positional;
  if (sub === undefined) return { error: 'missing' };
  if (!Object.hasOwn(SUBCOMMANDS, sub)) return { error: 'subcommand', arg: sub };
  const need = SUBCOMMANDS[sub];
  if (rest.length < need) return { error: 'missing' };
  if (rest.length > need + 1) return { error: 'argument', arg: rest[need + 1] };
  return { sub, operands: rest.slice(0, need), dir: rest[need] };
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

  const [source, dayArg] = parsed.operands;
  if (!sources.includes(source)) {
    io.stderr.write(`${t('watermark.unknown_source', { source, sources })}\n`);
    return EXIT.USAGE;
  }
  if (dayArg !== undefined && !isValidIsoDate(dayArg)) {
    io.stderr.write(`${t('watermark.bad_date', { value: dayArg })}\n`);
    return EXIT.USAGE;
  }
  if (dayArg !== undefined && dayArg > yesterday) {
    io.stderr.write(`${t('watermark.future_date', { day: shown(dayArg), yesterday: shown(yesterday), timezone: tz })}\n`);
    return EXIT.USAGE;
  }

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
    // Read again under the lock: a round may have moved it since.
    const current = readWatermark(stateDir).sources[source] ?? null;
    // Unset reads only yesterday, so it behaves as a mark on the day before.
    const effective = current ?? addDays(yesterday, -1);
    let target;
    if (parsed.sub === 'set') {
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
    if (target === current) {
      io.stdout.write(`${t('watermark.unchanged', { source, day: shown(target) })}\n`);
      return EXIT.OK;
    }
    const skipped = target > effective ? daysFrom(addDays(effective, 1), target) : [];
    setWatermark(stateDir, source, target);
    io.stdout.write(`${t('watermark.moved', { source, from: current === null ? '-' : shown(current), to: shown(target) })}\n`);
    if (skipped.length > 0) {
      io.stdout.write(`${t('watermark.skipped', { count: skipped.length, days: skipped.map(shown) })}\n`);
    }
    const open = daysBetween(target, yesterday);
    if (open > DEFAULT_MAX_DAYS) {
      io.stdout.write(`${t('watermark.beyond_clip', { count: open, max: DEFAULT_MAX_DAYS })}\n`);
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
