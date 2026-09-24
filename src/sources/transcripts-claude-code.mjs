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
//     keeps the newest by last message inside the window, and the prompt
//     block says how many fell off. Every ceiling announces itself.
// And one rule of the prompt: a transcript is sampled from its end, never
// read whole ("reading a transcript whole blew the context"), so the plan
// carries where the last 64 KB begin, as a byte offset and as the number
// of the line that holds that byte (the Read tool takes a line offset).
//
// A file is scanned in fixed-size chunks, line by line, never loaded
// whole: an active session can be hundreds of megabytes and is exactly
// the file the mtime pre-filter lets through on every round. A line
// longer than maxLineChars is skipped like a malformed one. Any error
// while scanning a file lists it as unreadable; nothing about one file
// throws out of `collect`.
//
// Transcript shape (Claude Code 2.1.281): one JSON object per line. Lines
// of type user, assistant, system and attachment are messages and carry an
// ISO `timestamp`; last-prompt, custom-title and mode carry none;
// queue-operation, file-history-snapshot and any unknown type are not
// messages and are skipped. Only the `.jsonl` files directly inside a
// listed project directory are sessions; subdirectories (subagent
// transcripts) are not walked.
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createTranslator } from '../lang.mjs';

export const SAMPLE_BYTES = 64 * 1024;
export const MTIME_SLACK_MS = 15 * 60 * 1000;
export const DEFAULT_LIMITS = Object.freeze({ chunkBytes: 256 * 1024, maxLineChars: 32 * 1024 * 1024 });

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

// The text of a user line's content, or null when it has none: a string
// is text; an array contributes its text blocks; an array with no text
// block (only tool results, images) has no text.
function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text);
  return texts.length ? texts.join('\n') : null;
}

function signaturesOf(config) {
  const all = [config?.curate?.signature, ...(config?.curate?.extra_signatures ?? [])];
  // A blank signature would be a prefix of every message and drop every file.
  return all.filter((sig) => typeof sig === 'string' && sig.trim() !== '');
}

// One pass over a file, `size` bytes of it (the size stat reported, so a
// session still being written yields a consistent plan), in chunks:
//   first, last:   earliest and latest message timestamps inside [from, to)
//   anyTimestamp:  whether any message timestamp parsed at all
//   selfTrace:     whether the first user message with text starts with a
//                  signature
//   sampleLine:    the 1-based number of the line holding byte sampleFrom,
//                  that is 1 + the newlines strictly before it
function scanFile(path, size, sampleFrom, window, signatures, io, limits) {
  const from = window.from.getTime();
  const to = window.to.getTime();
  let first = null;
  let last = null;
  let anyTimestamp = false;
  let firstUserSeen = false;
  let selfTrace = false;
  let sampleLine = 1;

  function judge(raw) {
    if (raw.trim() === '') return;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      return;
    }
    if (line === null || typeof line !== 'object' || !MESSAGE_TYPES.has(line.type)) return;
    if (!firstUserSeen && line.type === 'user' && line.isMeta !== true) {
      const content = userText(line.message?.content);
      if (content !== null) {
        firstUserSeen = true;
        const trimmed = content.trim();
        selfTrace = signatures.some((sig) => trimmed.startsWith(sig));
      }
    }
    if (typeof line.timestamp !== 'string') return;
    const at = Date.parse(line.timestamp);
    if (Number.isNaN(at)) return;
    anyTimestamp = true;
    if (at < from || at >= to) return;
    if (first === null || at < first) first = at;
    if (last === null || at > last) last = at;
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
  return { first, last, anyTimestamp, selfTrace, sampleLine };
}

// The short identifier a capture names its session by: Claude Code names
// a session file by its uuid, and the first 8 characters of the name
// without `.jsonl` are enough to find it again.
export function sessionId(fileName) {
  return fileName.slice(0, -'.jsonl'.length).slice(0, 8);
}

function problemLine(t, problem, root) {
  if (problem.code === 'no_projects') return t('sources.transcripts.problem_no_projects');
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
        bytes: file.bytes, sampleFrom: file.sampleFrom, sampleLine: file.sampleLine,
      }));
    }
  } else if (!plan.misconfigured) {
    lines.push(t('sources.transcripts.none_in_window', { from: plan.window.from, to: plan.window.to }));
  }
  for (const file of plan.unreadable) {
    lines.push(t('sources.transcripts.unreadable_line', { path: file.path, project: file.project, bytes: file.bytes }));
  }
  const d = plan.dropped;
  if (d.byCap) lines.push(t('sources.transcripts.dropped_by_cap', { count: d.byCap, cap: plan.cap }));
  if (d.selfTrace) lines.push(t('sources.transcripts.dropped_self_trace', { count: d.selfTrace }));
  if (d.outOfWindow) lines.push(t('sources.transcripts.dropped_out_of_window', { count: d.outOfWindow }));
  if (d.modifiedBeforeWindow) lines.push(t('sources.transcripts.dropped_modified_before_window', { count: d.modifiedBeforeWindow }));
  if (d.excludedPath) lines.push(t('sources.transcripts.dropped_excluded_path', { count: d.excludedPath }));
  if (d.unreadable) lines.push(t('sources.transcripts.dropped_unreadable', { count: d.unreadable }));
  return lines.join('\n');
}

// collect({ window: { from, to }, config, machine, now, home, io, limits })
//   window: Date instants, [from, to), computed by the caller in the
//           vault's time zone.
//   home:   the home directory `~` stands for (tests); os.homedir() when
//           absent.
//   io, limits: tests only. `io` replaces openSync/readSync/closeSync
//           used by the scan (to inject a read error); `limits` replaces
//           DEFAULT_LIMITS (small chunks to cross chunk boundaries).
function collect({ window, config, machine, home = homedir(), io = fs, limits = DEFAULT_LIMITS }) {
  const settings = config?.sources?.transcripts ?? {};
  const root = expandHome(machine?.transcripts_dir ?? join('~', '.claude', 'projects'), home);
  const projects = [...new Set(settings.include_projects ?? [])];
  const patterns = (settings.exclude_path_patterns ?? []).filter((p) => typeof p === 'string' && p !== '');
  const capValue = config?.curate?.caps?.transcripts;
  const cap = Number.isInteger(capValue) && capValue >= 0 ? capValue : Infinity;
  const signatures = signaturesOf(config);
  const dropped = { byCap: 0, selfTrace: 0, outOfWindow: 0, modifiedBeforeWindow: 0, excludedPath: 0, unreadable: 0 };
  const problems = [];
  const unreadable = [];
  let kept = [];

  const rootExists = isDirectory(root);
  const names = projects.length && rootExists ? listDir(root) : null;
  if (projects.length === 0) problems.push({ code: 'no_projects', detail: '' });
  else if (!rootExists) problems.push({ code: 'root_missing', detail: root });
  else if (names === null) problems.push({ code: 'root_unreadable', detail: root });

  const present = [];
  if (names !== null) {
    const listed = new Set(names);
    for (const project of projects) {
      const entries = listed.has(project) && isDirectory(join(root, project)) ? listDir(join(root, project), { withFileTypes: true }) : undefined;
      if (entries === undefined) problems.push({ code: 'project_missing', detail: project });
      else if (entries === null) problems.push({ code: 'project_unreadable', detail: project });
      else present.push({ project, entries });
    }
  }
  const misconfigured = present.length === 0;

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
        found = scanFile(path, bytes, sampleFrom, window, signatures, io, limits);
      } catch {
        found = null;
      }
      if (found === null || !found.anyTimestamp) {
        dropped.unreadable += 1;
        unreadable.push({ path, project, bytes });
        continue;
      }
      if (found.first === null) {
        dropped.outOfWindow += 1;
        continue;
      }
      if (found.selfTrace) {
        dropped.selfTrace += 1;
        continue;
      }
      kept.push({
        path,
        project,
        session: sessionId(entry.name),
        firstAt: new Date(found.first).toISOString(),
        lastAt: new Date(found.last).toISOString(),
        bytes,
        sampleFrom,
        sampleLine: found.sampleLine,
        last: found.last,
      });
    }
  }

  kept.sort((a, b) => b.last - a.last || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (kept.length > cap) {
    dropped.byCap = kept.length - cap;
    kept = kept.slice(0, cap);
  }
  const files = kept.map(({ last, ...file }) => file);
  unreadable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const plan = {
    root,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    cap: cap === Infinity ? null : cap,
    files,
    unreadable,
    dropped,
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
// a day whose unread sessions nobody will ever look at.
function readEvidence(record, plan) {
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
  const expected = plan.files.length;
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
