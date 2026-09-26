// The transcripts source: which Claude Code session files belong to a
// round's window, and whether the round read them.
//
// Three incidents shaped it (docs/incidents.md):
//   - 24/09/2026, selection by modification time turned an old session
//     into a new fact. A file is selected by the timestamps of the
//     messages inside it; its mtime is only a pre-filter. A file whose
//     mtime is more than MTIME_SLACK_MS before the window opened is not
//     opened (a margin for a transcripts directory whose clock is not
//     this machine's: a synced copy, a network filesystem), and it is
//     counted on its own, as "not opened", never as "no message in the
//     window", which nobody checked for it. A file touched today whose
//     messages are all from weeks ago stays out.
//   - 11/08/2026, the self-trace filter ate the day's work. The curator's
//     own runs are recognized only by the FIRST user message, parsed as
//     JSON; a signature anywhere else never drops a file. In doubt the
//     file stays in.
//   - 11/08/2026, the cap threw away exactly the work of the day. The cap
//     never cuts a day in half: it takes WHOLE days, oldest first (the
//     order a catch-up round reads them in), while the distinct files of
//     the days taken stay within `curate.caps.transcripts`. A file belongs
//     to every day, in the vault's time zone, that one of its in-window
//     messages falls on. The days taken are `daysCovered`, the rest
//     `daysDeferred`, and the plan's window ends at the last covered day, so
//     curate advances the mark only through days whose files were all
//     offered (final review C1, 24/09/2026: cutting the window's oldest
//     sessions and then closing their days lost them for good). When the
//     first open day alone holds more files than the cap, nothing is
//     covered and `overCap` says so: curate refuses to run the model.
//     Every ceiling announces itself.
// And one rule of the prompt: a transcript is sampled from its end, never
// read whole ("reading a transcript whole blew the context"), so the plan
// carries where the last 64 KB begin, as a byte offset and as the number
// of the line that holds that byte (the Read tool takes a line offset).
//
// A file is scanned in fixed-size chunks, line by line, never loaded
// whole: an active session can be hundreds of megabytes and is exactly
// the file the mtime pre-filter lets through on every round. A line
// longer than maxLineChars is skipped like a malformed one. `unreadable`
// is only for a file that could not be read (an I/O error while statting
// or scanning it) or decoded (not one of its lines parses as JSON), or one
// holding conversation (a user or assistant line) of which no line carries
// a timestamp that parses: a field Claude Code renamed or reformatted must
// stop the round loudly, never close its days as empty (re-review N1,
// 24/09/2026). Such a file blocks its day, and curate refuses to start the
// model on it. So does a file the round would offer whose path holds a
// character no read permission can name exactly (src/curate/rule-path.mjs;
// fix round 1 of phase 3 task 1, 25/09/2026): the round could not be
// allowed to read it without being allowed more, so it is listed with
// those characters (`unsafe`) instead of offered. Only a file that would
// have been offered: one outside the window blocks nothing. A file with no user or assistant line at all (a title or
// summary line only, or nothing) is counted as `noTimestamp`: there is no
// conversation in it to date, so it belongs to no day and blocks none
// (final review I2, 24/09/2026: as unreadable it kept its day open forever
// and every retry opened the same pull request again). Nothing about one
// file throws out of `collect`. A project directory that cannot be listed
// is `unreadable` too, marked `directory` (ruling R-A4, 26/09/2026: as a
// warning alone it let the round close days whose sessions in it nobody
// read): its sessions could be on any day, and no modification time can
// say otherwise (appending to a session does not touch its directory), so
// it blocks every day of the source, in every window, until it can be
// listed or leaves the configuration; curate refuses to start the model
// on it, as on a file it cannot read. So is a project reached through a
// link the round cannot follow (ruling R-A7: under "all" it was silently
// left out, under a list called missing, and the mark moved on either
// way); a name that is simply not there stays `project_missing`.
//
// Transcript shape (Claude Code 2.1.281): one JSON object per line. Lines
// of type user, assistant, system and attachment are messages and carry an
// ISO `timestamp`; last-prompt, custom-title and mode carry none;
// queue-operation, file-history-snapshot and any unknown type are not
// messages and are skipped. Only the `.jsonl` files directly inside a
// listed project directory are sessions; subdirectories (subagent
// transcripts) are not walked.
//
// Which project directories: the names `sources.transcripts.include_projects`
// lists, by exact name, or, when it is the string "all" (phase 5a task 4:
// the owner's explicit choice, and the configuration is that confirmation),
// every directory under the transcripts root at the time of the round,
// minus each one an `exclude_path_patterns` pattern excludes whole
// (allProjects, which doctor's include-projects asks too). A list holding
// "all" names a directory called "all", nothing more. "all" that finds no
// directory reads nothing and says so (`all_empty`), and the round refuses,
// as it does for a list none of whose projects is there, rather than close
// a day nobody read. Any other value lists no project (`no_projects`).
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createTranslator } from '../lang.mjs';
import { addDays, localDay, startOfDay } from '../guards/watermark.mjs';
import { unsafeRuleCharacters } from '../curate/rule-path.mjs';

export const SAMPLE_BYTES = 64 * 1024;
export const MTIME_SLACK_MS = 15 * 60 * 1000;
export const DEFAULT_LIMITS = Object.freeze({ chunkBytes: 256 * 1024, maxLineChars: 32 * 1024 * 1024 });
// The one value of include_projects that is not a list.
export const ALL_PROJECTS = 'all';

const MESSAGE_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);

const NEWLINE = 0x0a;

function expandHome(path, home) {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

function isDirectory(path) {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDir(path, options) {
  try {
    return fs.readdirSync(path, options);
  } catch {
    return null;
  }
}

// The exclude_path_patterns a round applies: the non-empty strings (an empty
// one is a substring of every path, and would exclude every file).
export function exclusionPatterns(config) {
  const patterns = config?.sources?.transcripts?.exclude_path_patterns;
  return Array.isArray(patterns) ? patterns.filter((p) => typeof p === 'string' && p !== '') : [];
}

// What a name under the transcripts root is (ruling R-A7, 26/09/2026):
// 'directory' (one, or a link to one), 'other' (a file, or a link to
// something that is not a directory), 'gone' (nothing there any more) or
// 'unreachable' (a link whose target cannot be looked at, for any reason: a
// directory the round cannot enter, an unmounted volume, a loop). An
// unreachable project may hold sessions of any day, so it is unread like
// one that cannot be listed: never silently "not a project", never
// "missing". doctor's include-projects asks this same function.
export function projectEntryKind(path) {
  let entry;
  try {
    entry = fs.lstatSync(path);
  } catch {
    return 'gone';
  }
  if (!entry.isSymbolicLink()) return entry.isDirectory() ? 'directory' : 'other';
  try {
    return fs.statSync(path).isDirectory() ? 'directory' : 'other';
  } catch {
    return 'unreachable';
  }
}

// The project directories "all" stands for: of `names`, the listing of
// `root`, each one that is a directory, or a link the round cannot follow
// (then unread, below), and that no pattern excludes whole, sorted. A
// pattern excludes a directory whole when it is found in the directory's
// path followed by the separator, the start of the path of every
// transcript inside it; so no directory is left out here whose transcripts
// the per-file exclusion would have kept, and one a pattern such as
// "/-tmp-" or "--claude-worktrees-" covers is no project at all.
export function allProjects(root, names, patterns) {
  return names
    .filter((name) => {
      const dir = join(root, name);
      const kind = projectEntryKind(dir);
      return (kind === 'directory' || kind === 'unreachable') && !patterns.some((pattern) => `${dir}${sep}`.includes(pattern));
    })
    .sort();
}

// The text of a user line's content, or null when it has none: a string
// is text; an array contributes its text blocks; an array with no text
// block (only tool results, images) has no text.
function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text);
  return texts.length ? texts.join('\n') : null;
}

// The kit's own sessions: the curator's rounds (curate.signature, and any
// curate.extra_signatures the person lists) and, always, the morning
// briefing's (briefing.signature, phase 4 decision B6): what a briefing
// records it proposes itself, so the curator never reads it again as the
// person's own work.
export function signaturesOf(config) {
  const all = [config?.curate?.signature, config?.briefing?.signature, ...(config?.curate?.extra_signatures ?? [])];
  // A blank signature would be a prefix of every message and drop every file.
  return all.filter((sig) => typeof sig === 'string' && sig.trim() !== '');
}

// THE one predicate that says a session is one of the kit's own (ruling
// R-T12, phase 4 fix round 1): `text` is the session's first user message
// with text, and it is the kit's own when, trimmed, it starts with one of
// `signatures`. A blank signature never counts. `schedule status --job
// briefing` and doctor's `briefing` check call this same function on the
// desktop task's prompt, so "the task is signed" and "the curator drops
// its sessions" can never disagree.
export function startsWithSignature(text, signatures) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return signatures.some((sig) => typeof sig === 'string' && sig.trim() !== '' && trimmed.startsWith(sig));
}

// Why a configured signature cannot sign anything reliably, or null: not a
// string, blank, more than one line, or with whitespace at either end. The
// predicate above compares against a trimmed message, so a signature with
// a leading space never matches, and one with a trailing space matches or
// not depending on how the application stores the task's prompt (ruling
// R-T12: refused, never guessed at).
export function signatureProblem(value) {
  if (typeof value !== 'string') return 'not_text';
  if (value.trim() === '') return 'blank';
  if (/[\r\n]/.test(value)) return 'multiline';
  if (value !== value.trim()) return 'padded';
  return null;
}

// Every configured signature that signatureProblem refuses: [{ key, value,
// problem }], with `key` the configuration path, in the order
// curate.signature, briefing.signature, curate.extra_signatures[i].
export function signatureProblems(config) {
  const entries = [['curate.signature', config?.curate?.signature], ['briefing.signature', config?.briefing?.signature]];
  const extra = config?.curate?.extra_signatures;
  if (Array.isArray(extra)) extra.forEach((value, index) => entries.push([`curate.extra_signatures[${index}]`, value]));
  return entries
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value, problem: signatureProblem(value) }))
    .filter((entry) => entry.problem !== null);
}

// One pass over a file, `size` bytes of it (the size stat reported, so a
// session still being written yields a consistent plan), in chunks:
//   perDay:        day index -> { first, last }, the earliest and latest
//                  message timestamps inside [from, to) falling on that day
//                  (`starts` holds each day's first instant, ascending)
//   anyTimestamp:  whether any message timestamp parsed at all
//   lines, parsed: non-blank lines judged, and how many parsed as JSON
//   conversation:  lines of type user or assistant, dated or not
//   selfTrace:     whether the first user message with text starts with a
//                  signature
//   sampleLine:    the 1-based number of the line holding byte sampleFrom,
//                  that is 1 + the newlines strictly before it
function scanFile(path, size, sampleFrom, window, starts, signatures, io, limits) {
  const from = window.from.getTime();
  const to = window.to.getTime();
  const perDay = new Map();
  let anyTimestamp = false;
  let lines = 0;
  let parsed = 0;
  let conversation = 0;
  let firstUserSeen = false;
  let selfTrace = false;
  let sampleLine = 1;

  function judge(raw) {
    if (raw.trim() === '') return;
    lines += 1;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      return;
    }
    parsed += 1;
    if (line === null || typeof line !== 'object' || !MESSAGE_TYPES.has(line.type)) return;
    if (line.type === 'user' || line.type === 'assistant') conversation += 1;
    if (!firstUserSeen && line.type === 'user' && line.isMeta !== true) {
      const content = userText(line.message?.content);
      if (content !== null) {
        firstUserSeen = true;
        selfTrace = startsWithSignature(content, signatures);
      }
    }
    if (typeof line.timestamp !== 'string') return;
    const at = Date.parse(line.timestamp);
    if (Number.isNaN(at)) return;
    anyTimestamp = true;
    if (at < from || at >= to) return;
    let index = starts.length - 1;
    while (index > 0 && at < starts[index]) index -= 1;
    const span = perDay.get(index);
    if (span === undefined) perDay.set(index, { first: at, last: at });
    else {
      if (at < span.first) span.first = at;
      if (at > span.last) span.last = at;
    }
  }

  const fd = io.openSync(path, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(limits.chunkBytes);
    let position = 0;
    let carry = '';
    let skipping = false;
    while (position < size) {
      const n = io.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (n === 0) break;
      const chunk = buffer.subarray(0, n);
      // Newlines strictly before sampleFrom, counted on bytes: 0x0a never
      // occurs inside a multi-byte UTF-8 sequence.
      if (position < sampleFrom) {
        const end = Math.min(n, sampleFrom - position);
        let index = chunk.indexOf(NEWLINE);
        while (index !== -1 && index < end) {
          sampleLine += 1;
          index = chunk.indexOf(NEWLINE, index + 1);
        }
      }
      position += n;
      const parts = (carry + decoder.write(chunk)).split('\n');
      carry = parts.pop();
      for (const part of parts) {
        if (skipping) skipping = false;
        else judge(part);
      }
      if (carry.length > limits.maxLineChars) {
        carry = '';
        skipping = true;
      }
    }
    const rest = carry + decoder.end();
    if (!skipping) judge(rest);
  } finally {
    io.closeSync(fd);
  }
  return { perDay, anyTimestamp, lines, parsed, conversation, selfTrace, sampleLine };
}

// The short identifier a capture names its session by: Claude Code names
// a session file by its uuid, and the first 8 characters of the name
// without `.jsonl` are enough to find it again.
export function sessionId(fileName) {
  return fileName.slice(0, -'.jsonl'.length).slice(0, 8);
}

function problemLine(t, problem, root) {
  if (problem.code === 'no_projects') return t('sources.transcripts.problem_no_projects');
  if (problem.code === 'all_empty') return t('sources.transcripts.problem_all_empty', { root });
  if (problem.code === 'root_missing') return t('sources.transcripts.problem_root_missing', { root });
  if (problem.code === 'root_unreadable') return t('sources.transcripts.problem_root_unreadable', { root });
  if (problem.code === 'project_unreadable') return t('sources.transcripts.problem_project_unreadable', { project: problem.detail, root });
  return t('sources.transcripts.problem_project_missing', { project: problem.detail, root });
}

function renderPromptBlock(t, plan) {
  const lines = [];
  for (const problem of plan.problems) lines.push(problemLine(t, problem, plan.root));
  if (plan.files.length) {
    lines.push(t('sources.transcripts.heading', {
      count: plan.files.length, from: plan.window.from, to: plan.window.to, sample: SAMPLE_BYTES / 1024,
    }));
    for (const file of plan.files) {
      lines.push(t('sources.transcripts.file_line', {
        session: file.session, path: file.path, project: file.project, firstAt: file.firstAt, lastAt: file.lastAt,
        bytes: file.bytes, sampleLine: file.sampleLine,
      }));
    }
  } else if (!plan.misconfigured && !plan.unreadable.some((entry) => entry.directory === true)) {
    // Not said while a project directory could not be listed: its
    // transcripts may well have messages in the window.
    lines.push(t('sources.transcripts.none_in_window', { from: plan.window.from, to: plan.window.to }));
  }
  for (const file of plan.unreadable) {
    // A directory is named by its own problem line, above.
    if (file.directory === true) continue;
    if (Array.isArray(file.unsafe)) lines.push(t('sources.transcripts.unsafe_line', { path: file.path, project: file.project, bytes: file.bytes, characters: file.unsafe.join(' ') }));
    else lines.push(t('sources.transcripts.unreadable_line', { path: file.path, project: file.project, bytes: file.bytes }));
  }
  const d = plan.dropped;
  if (plan.overCap) lines.push(t('sources.transcripts.over_cap', { day: shownDay(plan.overCap.day), count: plan.overCap.files, cap: plan.cap }));
  else if (d.byCap) lines.push(t('sources.transcripts.dropped_by_cap', { count: d.byCap, cap: plan.cap, days: plan.daysDeferred.map(shownDay).join(', ') }));
  if (d.selfTrace) lines.push(t('sources.transcripts.dropped_self_trace', { count: d.selfTrace }));
  if (d.outOfWindow) lines.push(t('sources.transcripts.dropped_out_of_window', { count: d.outOfWindow }));
  if (d.modifiedBeforeWindow) lines.push(t('sources.transcripts.dropped_modified_before_window', { count: d.modifiedBeforeWindow }));
  if (d.excludedPath) lines.push(t('sources.transcripts.dropped_excluded_path', { count: d.excludedPath }));
  if (d.unreadable) lines.push(t('sources.transcripts.dropped_unreadable', { count: d.unreadable }));
  if (d.noTimestamp) lines.push(t('sources.transcripts.dropped_no_timestamp', { count: d.noTimestamp }));
  return lines.join('\n');
}

// DD/MM/YYYY, for a person.
function shownDay(day) {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

// The calendar days of the window, each with the first instant it holds
// inside [from, to): `window.days` and `window.timezone` when the caller
// gives them (curate always does), otherwise derived from `from` and `to`
// in the vault's time zone. A time zone that cannot be used (only a
// direct call can reach here with one: curate refuses it first) makes the
// whole window a single day, which the cap then takes or refuses whole.
function daysOf(window, config) {
  const from = window.from.getTime();
  const to = window.to.getTime();
  const tz = window.timezone ?? config?.vault?.timezone;
  try {
    let names = Array.isArray(window.days) ? window.days : null;
    if (names === null) {
      names = [];
      for (let day = localDay(from, tz); startOfDay(day, tz).getTime() < to; day = addDays(day, 1)) names.push(day);
    }
    return names.map((day) => ({ day, start: Math.max(from, startOfDay(day, tz).getTime()) }));
  } catch {
    return from < to ? [{ day: window.from.toISOString().slice(0, 10), start: from }] : [];
  }
}

// collect({ window: { from, to, days, timezone }, config, machine, now, home, io, limits })
//   window: Date instants, [from, to), computed by the caller in the
//           vault's time zone; `days` (YYYY-MM-DD, oldest first) and
//           `timezone` name the calendar days it spans (derived from
//           from/to and config.vault.timezone when absent).
//   home:   the home directory `~` stands for (tests); os.homedir() when
//           absent.
//   io, limits: tests only. `io` replaces openSync/readSync/closeSync
//           used by the scan (to inject a read error); `limits` replaces
//           DEFAULT_LIMITS (small chunks to cross chunk boundaries).
function collect({ window, config, machine, home = homedir(), io = fs, limits = DEFAULT_LIMITS }) {
  const settings = config?.sources?.transcripts ?? {};
  const root = expandHome(machine?.transcripts_dir ?? join('~', '.claude', 'projects'), home);
  const all = settings.include_projects === ALL_PROJECTS;
  const named = Array.isArray(settings.include_projects) ? [...new Set(settings.include_projects)] : [];
  const patterns = exclusionPatterns(config);
  const capValue = config?.curate?.caps?.transcripts;
  const cap = Number.isInteger(capValue) && capValue >= 0 ? capValue : Infinity;
  const signatures = signaturesOf(config);
  const dropped = { byCap: 0, selfTrace: 0, outOfWindow: 0, modifiedBeforeWindow: 0, excludedPath: 0, unreadable: 0, noTimestamp: 0 };
  const problems = [];
  const unreadable = [];
  const candidates = [];
  const days = daysOf(window, config);
  const starts = days.map((d) => d.start);

  const rootExists = isDirectory(root);
  const names = (all || named.length > 0) && rootExists ? listDir(root) : null;
  if (!all && named.length === 0) problems.push({ code: 'no_projects', detail: '' });
  else if (!rootExists) problems.push({ code: 'root_missing', detail: root });
  else if (names === null) problems.push({ code: 'root_unreadable', detail: root });
  // "all" is resolved here, at the time of the round.
  const projects = all && names !== null ? allProjects(root, names, patterns) : named;
  if (all && names !== null && projects.length === 0) problems.push({ code: 'all_empty', detail: root });

  const present = [];
  if (names !== null) {
    const listed = new Set(names);
    for (const project of projects) {
      const dir = join(root, project);
      const kind = listed.has(project) ? projectEntryKind(dir) : 'gone';
      const entries = kind === 'directory' ? listDir(dir, { withFileTypes: true }) : undefined;
      if (kind === 'unreachable' || entries === null) {
        problems.push({ code: 'project_unreadable', detail: project });
        unreadable.push({ path: dir, project, bytes: 0, directory: true });
      } else if (entries === undefined) problems.push({ code: 'project_missing', detail: project });
      else present.push({ project, entries });
    }
  }
  // Nothing to read because nothing is there; a directory that is there but
  // cannot be listed is a source not read (exit 4), never a configuration
  // to fix (exit 1).
  const misconfigured = present.length === 0 && !unreadable.some((entry) => entry.directory === true);

  const openBefore = window.from.getTime() - MTIME_SLACK_MS;
  for (const { project, entries } of present) {
    const dir = join(root, project);
    for (const entry of entries) {
      if (!entry.name.endsWith('.jsonl') || entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (patterns.some((pattern) => path.includes(pattern))) {
        dropped.excludedPath += 1;
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(path);
      } catch {
        dropped.unreadable += 1;
        unreadable.push({ path, project, bytes: 0 });
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < openBefore) {
        dropped.modifiedBeforeWindow += 1;
        continue;
      }
      const bytes = stat.size;
      const sampleFrom = Math.max(0, bytes - SAMPLE_BYTES);
      let found;
      try {
        found = scanFile(path, bytes, sampleFrom, window, starts, signatures, io, limits);
      } catch {
        found = null;
      }
      // Not read; not decoded (nothing in it is JSON); or a conversation
      // none of whose lines can be dated.
      if (found === null || (!found.anyTimestamp && ((found.lines > 0 && found.parsed === 0) || found.conversation > 0))) {
        dropped.unreadable += 1;
        unreadable.push({ path, project, bytes });
        continue;
      }
      if (!found.anyTimestamp) {
        dropped.noTimestamp += 1;
        continue;
      }
      if (found.perDay.size === 0) {
        dropped.outOfWindow += 1;
        continue;
      }
      if (found.selfTrace) {
        dropped.selfTrace += 1;
        continue;
      }
      const unsafe = unsafeRuleCharacters(path);
      if (unsafe.length > 0) {
        dropped.unreadable += 1;
        unreadable.push({ path, project, bytes, unsafe });
        continue;
      }
      candidates.push({ path, project, session: sessionId(entry.name), bytes, sampleFrom, sampleLine: found.sampleLine, perDay: found.perDay });
    }
  }

  // Whole days, oldest first, while the distinct files of the days taken
  // stay within the cap.
  const byDay = days.map(() => []);
  for (const candidate of candidates) for (const index of candidate.perDay.keys()) byDay[index].push(candidate);
  const taken = new Set();
  let covered = 0;
  for (let index = 0; index < days.length; index += 1) {
    const added = byDay[index].filter((candidate) => !taken.has(candidate));
    if (taken.size + added.length > cap) break;
    for (const candidate of added) taken.add(candidate);
    covered = index + 1;
  }
  const overCap = covered === 0 && days.length > 0 ? { day: days[0].day, files: byDay[0].length } : null;
  dropped.byCap = candidates.length - taken.size;

  // A kept file's span counts only its messages on the covered days.
  const kept = [...taken].map((candidate) => {
    let first = null;
    let last = null;
    for (const [index, span] of candidate.perDay) {
      if (index >= covered) continue;
      if (first === null || span.first < first) first = span.first;
      if (last === null || span.last > last) last = span.last;
    }
    const { perDay, ...file } = candidate;
    return { ...file, firstAt: new Date(first).toISOString(), lastAt: new Date(last).toISOString(), last };
  });
  kept.sort((a, b) => b.last - a.last || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files = kept.map(({ last, ...file }) => ({
    path: file.path, project: file.project, session: file.session, firstAt: file.firstAt, lastAt: file.lastAt,
    bytes: file.bytes, sampleFrom: file.sampleFrom, sampleLine: file.sampleLine,
  }));
  unreadable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const coveredTo = covered === days.length ? window.to.getTime() : days[covered].start;
  const plan = {
    root,
    window: { from: window.from.toISOString(), to: new Date(covered === 0 ? window.from.getTime() : coveredTo).toISOString() },
    cap: cap === Infinity ? null : cap,
    files,
    unreadable,
    dropped,
    daysCovered: days.slice(0, covered).map((d) => d.day),
    daysDeferred: days.slice(covered).map((d) => d.day),
    overCap,
    problems,
    misconfigured,
  };
  const t = createTranslator(config?.lang ?? 'en');
  plan.promptBlock = renderPromptBlock(t, plan);
  return plan;
}

// readEvidence(record, plan): a kept file counts as read when the round
// record holds a Read tool use whose input `file_path` is exactly the
// file's path and whose tool result is not an error. Record shape read
// here: { toolUses: [{ id, name, input }], toolResults: [{ toolUseId, isError }] }.
// The source counts as read only when EVERY kept file was read (ruling
// R13, 24/09/2026): a day read in part stays open, and the round's report
// says "read x of y", so the next round reads it again instead of closing
// a day whose unread sessions nobody will ever look at. A file the plan
// lists as unreadable counts as expected and can never be read (controller
// ruling, fix round 1 of task 6): a day holding a session nobody could open
// stays open, loudly, until a person looks, instead of closing as "nothing
// to curate". So does a project directory the plan could not list (ruling
// R-A4).
function readEvidence(record, plan) {
  // Nothing to read because nothing is there (misconfigured: no project
  // listed, the root missing or unlistable, no listed project there, "all"
  // over no directory) is a source that failed, never an empty one (ruling
  // R-A9): nothing was read, so it never counts as read, and no advance,
  // vacuous or not, moves its mark, required or best effort.
  if (plan?.misconfigured === true) return { read: 0, expected: 0, ok: false };
  const failed = new Set();
  const answered = new Set();
  for (const result of record?.toolResults ?? []) {
    answered.add(result.toolUseId);
    if (result.isError) failed.add(result.toolUseId);
  }
  const readPaths = new Set();
  for (const use of record?.toolUses ?? []) {
    if (use?.name !== 'Read' || !answered.has(use.id) || failed.has(use.id)) continue;
    if (typeof use.input?.file_path === 'string') readPaths.add(use.input.file_path);
  }
  const expected = plan.files.length + (plan.unreadable?.length ?? 0);
  const read = plan.files.filter((file) => readPaths.has(file.path)).length;
  return { read, expected, ok: read === expected };
}

export const transcriptsSource = Object.freeze({
  id: 'transcripts',
  kind: 'local',
  required: true,
  collect,
  readEvidence,
});
