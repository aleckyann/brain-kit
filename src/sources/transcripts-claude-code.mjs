// The transcripts source: which Claude Code session files belong to a
// round's window, and whether the round read them.
//
// Three incidents shaped it (docs/incidents.md):
//   - 24/09/2026, selection by modification time turned an old session
//     into a new fact. A file is selected by the timestamps of the
//     messages inside it; its mtime is only a pre-filter (a file last
//     modified before the window opened cannot hold a message inside it,
//     so it is not opened). A file touched today whose messages are all
//     from weeks ago stays out.
//   - 11/08/2026, the self-trace filter ate the day's work. The curator's
//     own runs are recognized only by the FIRST user message, parsed as
//     JSON; a signature anywhere else never drops a file. In doubt the
//     file stays in.
//   - 11/08/2026, the cap threw away exactly the work of the day. The cap
//     keeps the newest by last message inside the window, and the prompt
//     block says how many fell off. Every ceiling announces itself.
// And one rule of the prompt: a transcript is sampled from its end, never
// read whole ("reading a transcript whole blew the context"), so the plan
// carries where the last 64 KB begin.
//
// Transcript shape (Claude Code 2.1.281): one JSON object per line. Lines
// of type user, assistant, system and attachment are messages and carry an
// ISO `timestamp`; last-prompt, custom-title and mode carry none;
// queue-operation, file-history-snapshot and any unknown type are not
// messages and are skipped. Only the `.jsonl` files directly inside a
// listed project directory are sessions; subdirectories (subagent
// transcripts) are not walked.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createTranslator } from '../lang.mjs';

export const SAMPLE_BYTES = 64 * 1024;

const MESSAGE_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);

const NEWLINE = 0x0a;

function expandHome(path, home) {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
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

// One pass over a file's lines: the earliest and latest message timestamps
// inside [from, to), whether any message timestamp parsed at all, and
// whether the first user message with text starts with a signature.
function scan(text, window, signatures) {
  const from = window.from.getTime();
  const to = window.to.getTime();
  let first = null;
  let last = null;
  let anyTimestamp = false;
  let firstUserSeen = false;
  let selfTrace = false;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (line === null || typeof line !== 'object' || !MESSAGE_TYPES.has(line.type)) continue;
    if (!firstUserSeen && line.type === 'user' && line.isMeta !== true) {
      const content = userText(line.message?.content);
      if (content !== null) {
        firstUserSeen = true;
        const trimmed = content.trim();
        selfTrace = signatures.some((sig) => trimmed.startsWith(sig));
      }
    }
    if (typeof line.timestamp !== 'string') continue;
    const at = Date.parse(line.timestamp);
    if (Number.isNaN(at)) continue;
    anyTimestamp = true;
    if (at < from || at >= to) continue;
    if (first === null || at < first) first = at;
    if (last === null || at > last) last = at;
  }
  return { first, last, anyTimestamp, selfTrace };
}

// The 1-based number of the first line that starts at or after byte
// `offset`, which is what the Read tool's line offset takes (the line that
// holds `offset` when no newline follows it).
function lineAt(buffer, offset) {
  let line = 1;
  let start = 0;
  while (start < offset) {
    const newline = buffer.indexOf(NEWLINE, start);
    if (newline === -1) break;
    start = newline + 1;
    line += 1;
  }
  return line;
}

function problemLine(t, problem, root) {
  if (problem.code === 'no_projects') return t('sources.transcripts.problem_no_projects');
  if (problem.code === 'root_missing') return t('sources.transcripts.problem_root_missing', { root });
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
        path: file.path, project: file.project, firstAt: file.firstAt, lastAt: file.lastAt,
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
  if (d.excludedPath) lines.push(t('sources.transcripts.dropped_excluded_path', { count: d.excludedPath }));
  if (d.unreadable) lines.push(t('sources.transcripts.dropped_unreadable', { count: d.unreadable }));
  return lines.join('\n');
}

// collect({ window: { from, to }, config, machine, now, home })
//   window: Date instants, [from, to), computed by the caller in the
//           vault's time zone.
//   home:   the home directory `~` stands for (tests); os.homedir() when
//           absent.
function collect({ window, config, machine, home = homedir() }) {
  const settings = config?.sources?.transcripts ?? {};
  const root = expandHome(machine?.transcripts_dir ?? join('~', '.claude', 'projects'), home);
  const projects = [...new Set(settings.include_projects ?? [])];
  const patterns = (settings.exclude_path_patterns ?? []).filter((p) => typeof p === 'string' && p !== '');
  const capValue = config?.curate?.caps?.transcripts;
  const cap = Number.isInteger(capValue) && capValue >= 0 ? capValue : Infinity;
  const signatures = signaturesOf(config);
  const dropped = { byCap: 0, selfTrace: 0, outOfWindow: 0, excludedPath: 0, unreadable: 0 };
  const problems = [];
  const unreadable = [];
  let kept = [];

  const rootExists = isDirectory(root);
  if (projects.length === 0) problems.push({ code: 'no_projects', detail: '' });
  else if (!rootExists) problems.push({ code: 'root_missing', detail: root });

  const present = [];
  if (projects.length && rootExists) {
    const names = new Set(readdirSync(root));
    for (const project of projects) {
      if (names.has(project) && isDirectory(join(root, project))) present.push(project);
      else problems.push({ code: 'project_missing', detail: project });
    }
  }
  const misconfigured = projects.length === 0 || !rootExists || present.length === 0;

  for (const project of present) {
    const dir = join(root, project);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.name.endsWith('.jsonl') || entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (patterns.some((pattern) => path.includes(pattern))) {
        dropped.excludedPath += 1;
        continue;
      }
      let stat;
      try {
        stat = statSync(path);
      } catch {
        dropped.unreadable += 1;
        unreadable.push({ path, project, bytes: 0 });
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < window.from.getTime()) {
        dropped.outOfWindow += 1;
        continue;
      }
      let buffer;
      try {
        buffer = readFileSync(path);
      } catch {
        dropped.unreadable += 1;
        unreadable.push({ path, project, bytes: stat.size });
        continue;
      }
      const found = scan(buffer.toString('utf8'), window, signatures);
      if (!found.anyTimestamp) {
        dropped.unreadable += 1;
        unreadable.push({ path, project, bytes: buffer.length });
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
      const sampleFrom = Math.max(0, buffer.length - SAMPLE_BYTES);
      kept.push({
        path,
        project,
        firstAt: new Date(found.first).toISOString(),
        lastAt: new Date(found.last).toISOString(),
        bytes: buffer.length,
        sampleFrom,
        sampleLine: lineAt(buffer, sampleFrom),
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
  return { read, expected, ok: expected === 0 || read > 0 };
}

export const transcriptsSource = Object.freeze({
  id: 'transcripts',
  kind: 'local',
  required: true,
  collect,
  readEvidence,
});
