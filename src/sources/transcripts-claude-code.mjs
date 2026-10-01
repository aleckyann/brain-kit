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
//     file stays in. Since 01/10/2026 that first message may be the
//     desktop application's envelope around a scheduled task's prompt:
//     startsWithSignature looks through it, by the task's name or by the
//     prompt inside, and nowhere else.
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
// read whole ("reading a transcript whole blew the context"). The plan
// still carries where the last 64 KB begin (sampleFrom, sampleLine), but
// the model no longer reads a transcript at all (01/10/2026, the first real
// round on a real vault: sessions of 386 to 512 KB of JSONL with enormous
// lines, which the Read tool refuses whole over 256 KB and in slices over
// 25 000 tokens, so the source could never be proven read). It reads a
// DIGEST of each kept transcript instead, which this module writes from
// the same parser and the same window before the model starts:
//   - only the user and assistant lines whose own timestamp falls inside
//     the plan's window (the covered days), in order of time, one line
//     each, `[HH:MM user] <text>` (`[DD/MM HH:MM user]` when the window
//     spans more than one day), the time on the vault's wall clock;
//   - only their text: the string content of a user line, the `text`
//     blocks of a content array; never a tool use, a tool result or a
//     thinking block; never a line the harness marks as its own (isMeta,
//     isCompactSummary, isVisibleInTranscriptOnly, a user line whose
//     `origin.kind` is not a person's); from a user line, every block of
//     HARNESS_TAGS removed wherever it stands (a system reminder appended
//     after the person's words, one with an id), the tags of what the
//     person typed unwrapped (PERSON_TAGS: `/name args`), and a block that
//     is then blank or starts with the harness speaking
//     (HARNESS_PREAMBLES) dropped. Text the person plausibly wrote stays:
//     in doubt, include;
//   - whitespace and control characters folded to single spaces, and each
//     message cut at DIGEST_LIMITS.messageChars with a visible ` [...]`;
//   - bounded so Read can always print it whole: what Read prints for the
//     digest, its line numbers included, stays under
//     DIGEST_LIMITS.readBytes UTF-8 bytes, and since every token covers at
//     least one byte, under Read's 25 000 tokens for any script
//     (test/transcript-digests.test.mjs builds the worst cases);
//   - whole days only (ruling R-D2 of fix round 1): the covered days are
//     those, oldest first, that every kept file's digest holds whole, and
//     the others wait for a later round, open, said in every digest's
//     first line, in the prompt block and by the round; a first day that
//     alone does not fit one digest is the only one cut, keeping its END
//     (the most recent messages);
//   - a first line naming the session, the window, the time zone, how
//     many messages the window held and how many the digest keeps, every
//     cut and the days left, in the vault's language.
// DIGEST_LIMITS is a technical bound of the Read tool, never a policy.
// Reading a digest whole is what proves the transcript read; the raw file
// is no longer granted, nor counted.
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
//
// One entry of the list is not a name: VAULT_PROJECT, "{vault}" (the second
// stranger's F1/D2, 01/10/2026). It stands for the project Claude Code names
// for THIS vault's folder ON THIS MACHINE. The name of a clone's project
// depends on the clone's path, and the configuration travels to every machine
// that clones the vault, so a name written out was right on the machine that
// wrote it and a project that is not there on every other. resolveIncludeProjects
// is the one place the entry becomes a name, and every reader of the list goes
// through it (this source, doctor's include-projects). The entry is the vault's
// own project and nothing broader: where the vault's path cannot be named
// (claudeProjectName) it stands for nothing, and the plan says so
// (`vault_unnamed`) instead of reading another project.
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createTranslator } from '../lang.mjs';
import { BRIEFING_TASK_PREFIX } from '../briefing/task-id.mjs';
import { addDays, localDay, startOfDay, wallClock } from '../guards/watermark.mjs';
import { unsafeRuleCharacters } from '../curate/rule-path.mjs';

export const SAMPLE_BYTES = 64 * 1024;
export const MTIME_SLACK_MS = 15 * 60 * 1000;
export const DEFAULT_LIMITS = Object.freeze({ chunkBytes: 256 * 1024, maxLineChars: 32 * 1024 * 1024 });
// The one value of include_projects that is not a list.
export const ALL_PROJECTS = 'all';
// The one entry of the list that is not a project name: the vault's own
// project, whatever the path of the clone on this machine. A project
// directory is named with letters, digits and dashes only (claudeProjectName),
// so no directory of the transcripts folder can ever be called this. No other
// token exists: any other string between braces is a name that will not be
// found.
export const VAULT_PROJECT = '{vault}';

// The bound of one digest (ruling R-D1 of fix round 1, 01/10/2026). Read
// prints a file numbered, each line behind its number and a separator, and
// a digest is read whole only when what Read prints for it stays under its
// limits: 256 KB, and 25 000 tokens counted by the real tokenizer. Every
// token covers at least one byte, so what Read prints for a digest is kept
// under `readBytes` UTF-8 bytes, whatever the script: Chinese, emoji and a
// base64 blob as plain prose, with 1 000 tokens to spare for what Read adds
// to its answer. `lineBytes` is what Read adds to a line, taken at 12 bytes:
// its number in six columns and a tab is 7, and with a three-byte arrow in
// place of the tab 9. That bound also keeps a digest far under Read's
// 2 000 lines (every line costs at least 27 bytes). `messageChars` cuts one
// message, so no line passes the 2 000 characters Read may cut a line at.
export const DIGEST_LIMITS = Object.freeze({ messageChars: 1800, readBytes: 24000, lineBytes: 12 });
// What a message cut at messageChars ends with.
export const DIGEST_CUT_MARK = '[...]';

// The tags of the blocks the harness writes into a user message: the tags
// the CLI itself strips from a person's text (read from Claude Code
// 2.1.286), and the ones it wrote before. Each block is removed wherever it
// stands, attributes and all.
export const HARNESS_TAGS = Object.freeze([
  'system-reminder', 'task-notification', 'command-message', 'command-stdout', 'command-stderr',
  'local-command-stdout', 'local-command-stderr', 'local-command-caveat', 'bash-stdout', 'bash-stderr', 'bash-exit-code',
  'user-prompt-submit-hook', 'agent-message', 'fetched-web-content', 'coordinator-relay', 'function_results', 'fork-boilerplate',
  'teammate-message', 'cross-session-message', 'slack-tag-message', 'forked-skill-launch', 'message-files-missing',
  'ide_opened_file', 'ide_selection',
]);
// The tags around what the person typed: the name and the arguments of a
// slash command, the command of a `!` line. The tags go, the text stays.
export const PERSON_TAGS = Object.freeze(['command-name', 'command-args', 'bash-input']);
// A text block that starts with one of these, once the blocks above are
// gone, is the harness speaking: a background task's notification and a
// Stop hook's feedback.
export const HARNESS_PREAMBLES = Object.freeze(['[SYSTEM NOTIFICATION - NOT USER INPUT]', 'Stop hook feedback:']);
// The `origin.kind` of a user line the person wrote (typed, typed from
// another device, or a suggestion the person sent); a user line that
// carries any other kind (a task notification, a peer, a channel, a plugin,
// an automatic continuation, an observer) is not the person's.
export const HUMAN_ORIGINS = Object.freeze(['human', 'remote', 'suggestion']);

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

// True when anything at all is at `path`, a link that leads nowhere included.
function somethingAt(path) {
  try {
    fs.lstatSync(path);
    return true;
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

// The longest project name Claude Code keeps as the path spells it. A longer
// one it shortens and suffixes with a hash this module cannot reproduce, so
// no name is predicted for such a path.
export const MAX_PROJECT_NAME_CHARS = 200;

// The name Claude Code gives the folder, under its projects folder, that
// holds the sessions run in `absolutePath`: the path with every character
// that is not an ASCII letter or digit turned into a dash, one dash for each
// character (a slash, a dot, a space and an accented letter alike). So
// /home/ana/brain is -home-ana-brain. This is what a vault's own project is
// called, which is what `init` lists in include_projects and what `doctor`
// knows has no folder until a session has run in the vault. Null for a path
// the rule does not cover: one that does not start with a slash (a relative
// path, a Windows one), and one whose name is longer than
// MAX_PROJECT_NAME_CHARS. A caller leaves the name out then, and says so.
// Observed behaviour of Claude Code, not a specification: a name that
// disagrees with the folder Claude Code really made shows as a project with
// no sessions. A value that is not a string is a defect of the caller and
// throws.
export function claudeProjectName(absolutePath) {
  if (typeof absolutePath !== 'string') throw new TypeError(`claudeProjectName needs a path (got ${JSON.stringify(absolutePath)})`);
  if (!absolutePath.startsWith('/')) return null;
  const name = absolutePath.replace(/[^A-Za-z0-9]/g, '-');
  return name.length <= MAX_PROJECT_NAME_CHARS ? name : null;
}

// The name of the project of the vault at `vaultRoot` on THIS machine, or
// null. Claude Code names a project after the folder its sessions run in, so
// this is the name of the vault's real path: a link, a trailing slash and a
// dot-dot are followed first, as they are in the working directory of a
// process. Null for a root that is not a path to something that exists, and
// for a path claudeProjectName has no name for (too long, or not absolute):
// the caller says so rather than guess another project. Everything that needs
// the vault's own project asks here: the entry VAULT_PROJECT
// (resolveIncludeProjects) and the project that may wait for its first
// session (waitingProjectName).
export function vaultProjectName(vaultRoot) {
  if (typeof vaultRoot !== 'string' || vaultRoot === '') return null;
  try {
    return claudeProjectName(fs.realpathSync(vaultRoot));
  } catch {
    return null;
  }
}

// The list `sources.transcripts.include_projects` holds, as THIS machine
// reads it: each VAULT_PROJECT becomes vaultProjectName(vaultRoot) (and is
// left out when that is null), every other entry stays as written, and a
// name that comes up twice is listed once. The one place the entry is
// resolved. What is not a list resolves to no project: "all" is not a list
// and is the caller's to handle first, and neither is the bare string
// "{vault}", which the schema refuses.
export function resolveIncludeProjects(list, vaultRoot) {
  if (!Array.isArray(list)) return [];
  const own = list.includes(VAULT_PROJECT) ? vaultProjectName(vaultRoot) : null;
  const names = [];
  for (const entry of list) {
    if (entry === VAULT_PROJECT) {
      if (own !== null && !names.includes(own)) names.push(own);
    } else if (!names.includes(entry)) {
      names.push(entry);
    }
  }
  return names;
}

// The listed project that is allowed to have no folder yet, or null: the
// vault's own, whose folder Claude Code makes only when a session first runs
// in the vault. `doctor` and the round read the same answer, so they cannot
// disagree about a new vault. Null when the vault's own name cannot be told
// (claudeProjectName), and when Claude Code keeps its projects somewhere this
// kit was not told about: CLAUDE_CONFIG_DIR is set and no transcripts_dir is
// named in machine.json, so a ~/.claude/projects without the vault's project
// says nothing about where its sessions are.
export function waitingProjectName({ vaultRoot, machine, env }) {
  const named = typeof machine?.transcripts_dir === 'string' && machine.transcripts_dir !== '';
  const moved = typeof env?.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR !== '';
  if (moved && !named) return null;
  return vaultProjectName(vaultRoot);
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

// The desktop application does not hand a scheduled task's prompt to the
// session as it is (measured on the first real briefing run, 01/10/2026,
// docs/incidents.md): the session's first user message is one string, an
// open tag `<scheduled-task name="..." file="...">`, a newline, one
// paragraph in the application's own wording, a blank line, the prompt as
// registered, a newline and a closing tag. Only the open tag, the blank
// line and the prompt's start are read here; the paragraph's wording is the
// application's, may change with its version, and is never matched. Every
// scan below stays inside the first ENVELOPE_HEAD characters of the message
// (a first message can be a pasted blob of megabytes), and a tag that is not
// finished inside them is not an envelope.
const ENVELOPE_TAG = '<scheduled-task';
const ENVELOPE_HEAD = 16 * 1024;
const BLANK_LINE = /\r?\n[ \t]*\r?\n/;
const ATTRIBUTE_NAME = /^[A-Za-z0-9_:.-]$/;

function isSpace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

// The index of the first character at or after `from` that is not
// whitespace, within `head`.
function skipSpace(head, from) {
  let index = from;
  while (index < head.length && isSpace(head[index])) index += 1;
  return index;
}

// The envelope's open tag at the start of `text`, or null when the start is
// not one that clearly matches: { name, end }, `name` the value of the first
// `name` attribute (null when there is none) and `end` the index just past
// the `>` that closes the tag. Attributes are `key=value` with the value in
// double or single quotes (a `>` inside a quoted value is a character of the
// value), in any order, each separated from the next by whitespace. Anything
// else (an unquoted value, an attribute with no value, `/>`, a quote that
// never closes, a tag not finished inside ENVELOPE_HEAD) is no envelope. One
// forward pass over the head, no backtracking.
function openTag(text) {
  if (!text.startsWith(ENVELOPE_TAG)) return null;
  const head = text.slice(0, ENVELOPE_HEAD);
  let index = ENVELOPE_TAG.length;
  if (!isSpace(head[index])) return null;
  let name = null;
  for (;;) {
    index = skipSpace(head, index);
    if (index >= head.length) return null;
    if (head[index] === '>') return { name, end: index + 1 };
    const keyStart = index;
    while (index < head.length && ATTRIBUTE_NAME.test(head[index])) index += 1;
    if (index === keyStart) return null;
    const key = head.slice(keyStart, index);
    index = skipSpace(head, index);
    if (head[index] !== '=') return null;
    index = skipSpace(head, index + 1);
    const quote = head[index];
    if (quote !== '"' && quote !== '\'') return null;
    const close = head.indexOf(quote, index + 1);
    if (close === -1) return null;
    if (key === 'name' && name === null) name = head.slice(index + 1, close);
    index = close + 1;
    if (index < head.length && head[index] !== '>' && !isSpace(head[index])) return null;
  }
}

// Where the task prompt may start inside an envelope whose open tag ends at
// `end`: right after the open tag's line (the application left its paragraph
// out), and after the first blank line that follows the tag (the paragraph,
// then the prompt). Never anywhere else: a signature further into the
// message signs nothing (11/08/2026).
function promptStarts(text, end) {
  const head = text.slice(0, ENVELOPE_HEAD);
  const starts = [skipSpace(head, end)];
  const blank = BLANK_LINE.exec(head.slice(end));
  if (blank !== null) starts.push(skipSpace(head, end + blank.index + blank[0].length));
  return starts;
}

// THE one predicate that says a session is one of the kit's own (ruling
// R-T12, phase 4 fix round 1): `text` is the session's first user message
// with text, and it is the kit's own when, trimmed, it starts with one of
// `signatures`, or when it is the desktop application's envelope of a
// scheduled task (above) and either the envelope's `name` starts with
// BRIEFING_TASK_PREFIX (the kit's own briefing task, also the one of
// another vault on this machine, whose signature this vault does not know)
// or the task prompt inside starts with one of `signatures`. A blank
// signature never counts. `schedule status --job briefing` and doctor's
// `briefing` check call this same function on the desktop task's prompt,
// which the application keeps unwrapped in the task's file, so on that prompt
// they agree with the curator: signed means the curator drops the task's
// sessions. The converse does not hold. A task named with the kit's prefix
// whose prompt lacks the signature is `unsigned` for them, which stays strict
// on purpose (the signature is what keeps working if the application changes
// or drops its envelope), while the curator drops that task's sessions by its
// name.
export function startsWithSignature(text, signatures) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  const usable = signatures.filter((sig) => typeof sig === 'string' && sig.trim() !== '');
  if (usable.some((sig) => trimmed.startsWith(sig))) return true;
  const tag = openTag(trimmed);
  if (tag === null) return false;
  if (tag.name !== null && tag.name.startsWith(BRIEFING_TASK_PREFIX)) return true;
  return promptStarts(trimmed, tag.end).some((at) => usable.some((sig) => trimmed.startsWith(sig, at)));
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
//   selfTrace:     whether the first user message with text is the kit's
//                  own (startsWithSignature: it starts with a signature, or
//                  it is the desktop application's envelope of the kit's
//                  scheduled task)
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
    const line = parseLine(raw);
    if (line === undefined) return;
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
    const at = instantOf(line);
    if (Number.isNaN(at)) return;
    anyTimestamp = true;
    if (!inWindow(at, from, to)) return;
    const index = dayOf(at, starts);
    const span = perDay.get(index);
    if (span === undefined) perDay.set(index, { first: at, last: at });
    else {
      if (at < span.first) span.first = at;
      if (at > span.last) span.last = at;
    }
  }

  // Newlines strictly before sampleFrom, counted on bytes: 0x0a never
  // occurs inside a multi-byte UTF-8 sequence.
  function countSample(chunk, position) {
    if (position >= sampleFrom) return;
    const end = Math.min(chunk.length, sampleFrom - position);
    let index = chunk.indexOf(NEWLINE);
    while (index !== -1 && index < end) {
      sampleLine += 1;
      index = chunk.indexOf(NEWLINE, index + 1);
    }
  }

  forEachLine(path, size, io, limits, judge, countSample);
  return { perDay, anyTimestamp, lines, parsed, conversation, selfTrace, sampleLine };
}

// One line of a transcript as JSON: the parsed value (null included), or
// undefined when it does not parse.
function parseLine(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// A message line's instant in ms, NaN when its `timestamp` is missing or
// does not parse.
function instantOf(line) {
  return typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN;
}

// The window is [from, to): a message at `from` is in, one at `to` is out.
function inWindow(at, from, to) {
  return at >= from && at < to;
}

// Every line of the first `size` bytes of `path`, in order, read in chunks
// of limits.chunkBytes and decoded as UTF-8 (a character split across two
// chunks is joined), never the whole file at once; a line longer than
// limits.maxLineChars is skipped whole, like a malformed one. `onChunk`,
// when given, sees each chunk's bytes and their position first.
function forEachLine(path, size, io, limits, onLine, onChunk = null) {
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
      if (onChunk !== null) onChunk(chunk, position);
      position += n;
      const parts = (carry + decoder.write(chunk)).split('\n');
      carry = parts.pop();
      for (const part of parts) {
        if (skipping) skipping = false;
        else onLine(part);
      }
      if (carry.length > limits.maxLineChars) {
        carry = '';
        skipping = true;
      }
    }
    const rest = carry + decoder.end();
    if (!skipping) onLine(rest);
  } finally {
    io.closeSync(fd);
  }
}

// --- digests ----------------------------------------------------------------

// What the harness writes into a user message as if the person had typed
// it (fix round 1 of 01/10/2026, the CLI's own rule): a block of one of
// HARNESS_TAGS is removed wherever it stands in the text, its attributes
// and its closing tag's own attributes included (Claude Code 2.1.286 writes
// `<system-reminder id="...">...</system-reminder id="...">`); a block of
// PERSON_TAGS loses its tags and keeps its text. A tag with no closing tag
// is someone quoting it, and stays as written.
const HARNESS_BLOCK = new RegExp(`<(${HARNESS_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1(?:\\s[^>]*)?>`, 'g');
const PERSON_BLOCK = new RegExp(`<(${PERSON_TAGS.join('|')})(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\1(?:\\s[^>]*)?>`, 'g');
// Spaces, control characters and format characters (a zero-width space).
const BLANK = /^[\s\p{Cc}\p{Cf}]*$/u;
const LEADING_BLANK = /^[\s\p{Cc}\p{Cf}]+/u;

// Whitespace and control characters, folded to one space.
function fold(text) {
  return text.replace(/[\s\p{Cc}]+/gu, ' ').trim();
}

// What a digest keeps of one text block of a user line: the harness's
// blocks removed, the person's own tags unwrapped, and nothing when what is
// left is blank or starts with the harness speaking (HARNESS_PREAMBLES).
// Text the person plausibly wrote is kept: in doubt, include.
function personText(text) {
  const rest = text.replace(HARNESS_BLOCK, ' ').replace(PERSON_BLOCK, ' $2 ');
  if (BLANK.test(rest)) return '';
  const head = rest.replace(LEADING_BLANK, '');
  if (HARNESS_PREAMBLES.some((preamble) => head.startsWith(preamble))) return '';
  return fold(rest);
}

// The text blocks of a line's content: a string is one, an array gives its
// `text` blocks (never tool_use, tool_result, thinking or images).
function textBlocks(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text);
}

// The text a digest keeps of a user or assistant line: a user line's blocks
// as personText leaves them, the assistant's as it wrote them (the harness
// writes nothing into them), folded and joined with a space. '' when
// nothing is left.
function messageText(line) {
  const blocks = textBlocks(line.message?.content);
  const kept = line.type === 'user' ? blocks.map(personText) : blocks.map((text) => (BLANK.test(text) ? '' : fold(text)));
  return kept.filter((text) => text !== '').join(' ');
}

// Whether a line is the harness's own by its own marks: isMeta (an
// expanded slash command or skill body, a caveat), a compact summary
// (isCompactSummary, isVisibleInTranscriptOnly), a subagent's side of the
// conversation (isSidechain: its "user" lines are prompts the model wrote,
// not the person), or a user line whose `origin.kind`, when it carries
// one, is none of HUMAN_ORIGINS.
function harnessLine(line) {
  if (line.isMeta === true || line.isCompactSummary === true || line.isVisibleInTranscriptOnly === true || line.isSidechain === true) return true;
  if (line.type !== 'user') return false;
  const origin = line.origin ?? line.message?.origin;
  return origin !== null && typeof origin === 'object' && typeof origin.kind === 'string' && !HUMAN_ORIGINS.includes(origin.kind);
}

// The index of the window's day an instant falls on (`starts` holds each
// day's first instant, ascending).
function dayOf(at, starts) {
  let index = starts.length - 1;
  while (index > 0 && at < starts[index]) index -= 1;
  return index;
}

// The messages of a digest: every user and assistant line of the first
// `size` bytes of `path` whose own timestamp falls in [from, to), with
// text, in order of time (ties in file order), each with its day. Each
// keeps its folded length and only as much of its text as a line can show,
// so a pasted blob costs no more memory than the cap.
function digestMessages(path, size, from, to, starts, io, limits) {
  const messages = [];
  forEachLine(path, size, io, limits, (raw) => {
    if (raw.trim() === '') return;
    const line = parseLine(raw);
    if (line === null || typeof line !== 'object' || (line.type !== 'user' && line.type !== 'assistant')) return;
    if (harnessLine(line)) return;
    const at = instantOf(line);
    if (Number.isNaN(at) || !inWindow(at, from, to)) return;
    const text = messageText(line);
    if (text === '') return;
    const cap = DIGEST_LIMITS.messageChars;
    messages.push({ at, day: dayOf(at, starts), role: line.type, length: text.length, text: text.length > cap ? text.slice(0, cap) : text, order: messages.length });
  });
  return messages.sort((a, b) => a.at - b.at || a.order - b.order);
}

// A usable time zone for the digest's clock: the given one when the
// platform knows it, UTC otherwise (the header then says UTC).
function clockZone(tz) {
  if (typeof tz !== 'string' || tz === '') return 'UTC';
  try {
    wallClock(0, tz);
    return tz;
  } catch {
    return 'UTC';
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// One message as its digest line: `[HH:MM role] text`, the date in front
// of the time when the window spans more than one day, the text cut at
// messageChars (never inside a surrogate pair) with the cut mark.
function messageLine(message, tz, withDate) {
  const w = wallClock(message.at, tz);
  const time = `${withDate ? `${pad2(w.d)}/${pad2(w.m)} ` : ''}${pad2(w.h)}:${pad2(w.min)}`;
  let text = message.text;
  if (message.length > DIGEST_LIMITS.messageChars) {
    let end = DIGEST_LIMITS.messageChars;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    text = `${text.slice(0, end)} ${DIGEST_CUT_MARK}`;
  }
  return `[${time} ${message.role}] ${text}`;
}

// What one line of a digest costs in what Read prints for it: its UTF-8
// bytes, its newline, and Read's own number and separator.
function lineCost(line) {
  return Buffer.byteLength(line) + 1 + DIGEST_LIMITS.lineBytes;
}

// A digest's first line: the session, its project, the window, the time
// zone, how many messages the window held and how many the digest keeps,
// the cut when there is one, and the days left for a later round.
function headerOf(t, { session, project, from, to, timezone, held, kept, cutMessages, cutChars, daysLeft }) {
  let header;
  if (cutMessages > 0) {
    const cut = t('sources.transcripts.digest_cut', { messages: cutMessages, chars: cutChars });
    header = t('sources.transcripts.digest_header_cut', { session, project, from, to, timezone, held, kept, cut });
  } else {
    header = t('sources.transcripts.digest_header', { session, project, from, to, timezone, held, kept });
  }
  if (daysLeft.length === 0) return header;
  return `${header} ${t('sources.transcripts.digest_days_left', { days: daysLeft.map(shownDay).join(', ') })}`;
}

// What the first line can cost at most for these messages: the longest
// form (cut, every count at its largest, every day after the first left),
// so the lines can be budgeted before their counts are known.
function headerBound(t, { session, project, from, to, timezone, messages, daysLeft }) {
  const all = Math.max(1, messages.length);
  const chars = messages.reduce((sum, message) => sum + message.length, 0);
  return lineCost(headerOf(t, { session, project, from, to, timezone, held: all, kept: all, cutMessages: all, cutChars: chars, daysLeft }));
}

// The covered days every kept file's digest can hold whole (ruling R-D2 of
// fix round 1, 01/10/2026): each file's messages over the `covered` days
// the cap took, and the number of those days, oldest first, whose lines fit
// whole under DIGEST_LIMITS.readBytes with the first line. The round covers
// the fewest any file holds, and never fewer than one: a first day that
// alone does not fit is the one cut, inside itself, from its end. Returns
// { fit, read (path -> messages), failed (files that could not be read
// again), holds (session -> days held) }.
function fitDigests(t, taken, { days, covered, window, starts, tz, io, limits }) {
  const zone = clockZone(tz);
  const from = window.from.getTime();
  const to = covered === days.length ? window.to.getTime() : days[covered].start;
  const withDate = covered > 1;
  const daysLeft = days.slice(1, covered).map((d) => d.day);
  const read = new Map();
  const failed = [];
  const holds = [];
  let fit = covered;
  for (const candidate of taken) {
    let messages;
    try {
      messages = digestMessages(candidate.path, candidate.bytes, from, to, starts, io, limits);
    } catch {
      failed.push(candidate);
      continue;
    }
    read.set(candidate.path, messages);
    const perDay = new Array(covered).fill(0);
    for (const message of messages) perDay[message.day] += lineCost(messageLine(message, zone, withDate));
    let used = headerBound(t, { session: candidate.session, project: candidate.project, from: new Date(from).toISOString(), to: new Date(to).toISOString(), timezone: zone, messages, daysLeft });
    let held = 0;
    while (held < covered && used + perDay[held] < DIGEST_LIMITS.readBytes) {
      used += perDay[held];
      held += 1;
    }
    holds.push({ session: candidate.session, held });
    fit = Math.min(fit, Math.max(1, held));
  }
  return { fit, read, failed, holds };
}

// The digest of one kept file over the plan's window: its text, and what
// the plan and the round report about it. Every line it holds, header
// included, is kept under DIGEST_LIMITS.readBytes as Read prints it; when
// the one covered day holds more, the most recent lines that fit are kept,
// and the first N messages (with M characters of text) that did not fit
// are said in the header.
function buildDigest(t, file, window, tz, withDate, messages, daysLeft) {
  const { session, project } = file;
  const { from, to } = window;
  const lineBudget = DIGEST_LIMITS.readBytes - headerBound(t, { session, project, from, to, timezone: tz, messages, daysLeft });
  // From the newest back, while the next older line still fits.
  const keptLines = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const line = messageLine(messages[index], tz, withDate);
    if (used + lineCost(line) >= lineBudget) break;
    used += lineCost(line);
    keptLines.push(line);
  }
  keptLines.reverse();
  const kept = keptLines.length;
  const held = messages.length;
  const cutMessages = held - kept;
  const cutChars = messages.slice(0, cutMessages).reduce((sum, message) => sum + message.length, 0);
  const header = headerOf(t, { session, project, from, to, timezone: tz, held, kept, cutMessages, cutChars, daysLeft });
  const body = [header, ...keptLines];
  return { text: `${body.join('\n')}\n`, held, kept, cutMessages, cutChars, lines: body.length };
}

// Gives every kept file of `plan` its digest, named `<NN>-<session>.txt`
// under `dir` in the plan's order (newest first), from the messages
// fitDigests read (`read`, path -> messages), cut to the plan's window:
// `file.digest` holds its path and counts, and the texts go in the plan's
// non-enumerable `digestTexts` ([{ path, text }]), which writeDigests
// writes and no log, report or JSON copy of the plan ever carries.
function attachDigests(plan, { dir, t, tz, read }) {
  const zone = clockZone(tz);
  const withDate = plan.daysCovered.length > 1;
  const to = Date.parse(plan.window.to);
  const width = Math.max(2, String(plan.files.length).length);
  const texts = [];
  plan.files = plan.files.map((file, index) => {
    const path = join(dir, `${String(index + 1).padStart(width, '0')}-${file.session}.txt`);
    const messages = (read.get(file.path) ?? []).filter((message) => message.at < to);
    const digest = buildDigest(t, file, plan.window, zone, withDate, messages, plan.digestDeferred);
    texts.push({ path, text: digest.text });
    return { ...file, digest: { path, held: digest.held, kept: digest.kept, cutMessages: digest.cutMessages, cutChars: digest.cutChars, lines: digest.lines } };
  });
  plan.digestDir = dir;
  Object.defineProperty(plan, 'digestTexts', { value: texts, enumerable: false });
}

// Writes the digests of `plan` (attachDigests): their directory created
// with mode 0700 (and its parent, when missing), each file created anew
// with mode 0600, never over an existing one. Returns how many it wrote.
// The caller removes the directory when the round ends.
export function writeDigests(plan) {
  const texts = plan?.digestTexts;
  if (!Array.isArray(texts) || texts.length === 0 || typeof plan.digestDir !== 'string') return 0;
  const dir = plan.digestDir;
  const parent = dirname(dir);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  for (const { path, text } of texts) {
    const fd = fs.openSync(path, 'wx', 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
  }
  return texts.length;
}

// The short identifier a capture names its session by: Claude Code names
// a session file by its uuid, and the first 8 characters of the name
// without `.jsonl` are enough to find it again.
export function sessionId(fileName) {
  return fileName.slice(0, -'.jsonl'.length).slice(0, 8);
}

function problemLine(t, problem, root) {
  if (problem.code === 'no_projects') return t('sources.transcripts.problem_no_projects', { token: VAULT_PROJECT });
  if (problem.code === 'vault_unnamed') return t('sources.transcripts.problem_vault_unnamed', { token: VAULT_PROJECT, dir: problem.detail });
  if (problem.code === 'own_project_missing') return t('sources.transcripts.problem_own_project_missing', { project: problem.detail, token: VAULT_PROJECT, root });
  if (problem.code === 'all_empty') return t('sources.transcripts.problem_all_empty', { root });
  if (problem.code === 'root_missing') return t('sources.transcripts.problem_root_missing', { root });
  if (problem.code === 'root_unreadable') return t('sources.transcripts.problem_root_unreadable', { root });
  if (problem.code === 'project_unreadable') return t('sources.transcripts.problem_project_unreadable', { project: problem.detail, root });
  return t('sources.transcripts.problem_project_missing', { project: problem.detail, root });
}

function renderPromptBlock(t, plan) {
  const lines = [];
  for (const problem of plan.problems) lines.push(problemLine(t, problem, plan.root));
  lines.push(...plan.waitingLines);
  if (plan.files.length) {
    lines.push(t('sources.transcripts.heading', { count: plan.files.length, from: plan.window.from, to: plan.window.to }));
    // Each file by its digest, never by its own path: the transcript is
    // not readable in the round, only its digest is.
    for (const file of plan.files) {
      const digest = file.digest;
      if (digest === undefined) {
        lines.push(t('sources.transcripts.file_line_no_digest', { session: file.session, project: file.project, firstAt: file.firstAt, lastAt: file.lastAt }));
      } else if (digest.cutMessages > 0) {
        const cut = t('sources.transcripts.digest_cut', { messages: digest.cutMessages, chars: digest.cutChars });
        lines.push(t('sources.transcripts.file_line_cut', {
          session: file.session, digest: digest.path, project: file.project, firstAt: file.firstAt, lastAt: file.lastAt, kept: digest.kept, held: digest.held, cut,
        }));
      } else {
        lines.push(t('sources.transcripts.file_line', {
          session: file.session, digest: digest.path, project: file.project, firstAt: file.firstAt, lastAt: file.lastAt, kept: digest.kept, held: digest.held,
        }));
      }
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
  const digestDays = plan.digestDeferred ?? [];
  if (digestDays.length > 0) {
    lines.push(t('sources.transcripts.days_left_digest', {
      days: digestDays.map(shownDay).join(', '), sessions: plan.digestLimitedBy.join(', '), bytes: DIGEST_LIMITS.readBytes, count: d.byDigest,
    }));
  }
  if (plan.overCap) lines.push(t('sources.transcripts.over_cap', { day: shownDay(plan.overCap.day), count: plan.overCap.files, cap: plan.cap }));
  else if (d.byCap) lines.push(t('sources.transcripts.dropped_by_cap', { count: d.byCap, cap: plan.cap, days: plan.daysDeferred.filter((day) => !digestDays.includes(day)).map(shownDay).join(', ') }));
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
//   digestDir: the absolute directory this round's digests go in (curate
//           names one per round). When given, every kept file gets its
//           digest (attachDigests), built in memory: nothing is written
//           here; writeDigests writes them. Without it the plan offers its
//           files with no digest, which no round can read.
//   waiting: the one listed project that may have no folder yet (the vault's
//           own, waitingProjectName), or null. Such a project is a project
//           with no sessions, not a misconfiguration: the plan names it in
//           `waiting` and offers nothing from it. A name that is not it, an
//           empty list, a root that cannot be listed stay what they were.
//   vaultRoot: the vault's folder, which the entry VAULT_PROJECT of the list
//           stands for the project of (resolveIncludeProjects). Without it
//           the entry stands for nothing (`vault_unnamed`), as it does for a
//           folder whose project cannot be named.
//   io, limits: tests only. `io` replaces openSync/readSync/closeSync
//           used by the scan (to inject a read error); `limits` replaces
//           DEFAULT_LIMITS (small chunks to cross chunk boundaries).
function collect({ window, config, machine, home = homedir(), digestDir, waiting = null, vaultRoot, io = fs, limits = DEFAULT_LIMITS }) {
  const settings = config?.sources?.transcripts ?? {};
  const root = expandHome(machine?.transcripts_dir ?? join('~', '.claude', 'projects'), home);
  const all = settings.include_projects === ALL_PROJECTS;
  // The list as this machine reads it: {vault} is the project of the vault at
  // `vaultRoot` here, and nothing else about the list changes.
  const named = resolveIncludeProjects(settings.include_projects, vaultRoot);
  // The project the entry stands for, when the list has the entry. A vault
  // whose project cannot be named here (`unnamed`) has nothing for the entry to
  // stand for, and an empty list of such a vault has no entry to offer in its
  // place: both say so, instead of "no project is listed".
  const entry = Array.isArray(settings.include_projects) && settings.include_projects.includes(VAULT_PROJECT);
  const vaultProject = vaultProjectName(vaultRoot);
  const own = entry ? vaultProject : null;
  const unnamed = vaultProject === null && (entry || (typeof vaultRoot === 'string' && !all && named.length === 0));
  const patterns = exclusionPatterns(config);
  const capValue = config?.curate?.caps?.transcripts;
  const cap = Number.isInteger(capValue) && capValue >= 0 ? capValue : Infinity;
  const signatures = signaturesOf(config);
  const dropped = { byCap: 0, byDigest: 0, selfTrace: 0, outOfWindow: 0, modifiedBeforeWindow: 0, excludedPath: 0, unreadable: 0, noTimestamp: 0 };
  const problems = [];
  const unreadable = [];
  const candidates = [];
  const days = daysOf(window, config);
  const starts = days.map((d) => d.start);

  const rootExists = isDirectory(root);
  const names = (all || named.length > 0) && rootExists ? listDir(root) : null;
  // The projects that have no sessions yet, which is not a problem: see `waiting`.
  const waitingNames = [];
  if (unnamed) problems.push({ code: 'vault_unnamed', detail: typeof vaultRoot === 'string' ? vaultRoot : '' });
  if (!all && named.length === 0) {
    // A vault with no project to name was said above; nothing else is listed.
    if (!unnamed) problems.push({ code: 'no_projects', detail: '' });
  } else if (!rootExists) {
    // The default folder is absent on a machine where Claude Code never ran a
    // session, and only the vault's own project is listed: nothing to read yet.
    // A folder named on purpose, a broken link or a file there is not that.
    const neverUsed = waiting !== null && machine?.transcripts_dir == null && !somethingAt(root) && named.every((project) => project === waiting);
    if (neverUsed) waitingNames.push(waiting);
    else problems.push({ code: 'root_missing', detail: root });
  } else if (names === null) problems.push({ code: 'root_unreadable', detail: root });
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
      } else if (entries === undefined && project === waiting && !all && kind === 'gone') waitingNames.push(project);
      // The vault's own project, which the entry stands for, missing where
      // nothing may wait for it: the place to fix is where Claude Code keeps its
      // projects (machine.json), never a name in the shared configuration.
      else if (entries === undefined) problems.push({ code: kind === 'gone' && project === own ? 'own_project_missing' : 'project_missing', detail: project });
      else present.push({ project, entries });
    }
  }
  // Nothing to read because nothing is there; a directory that is there but
  // cannot be listed is a source not read (exit 4), never a configuration
  // to fix (exit 1).
  // A project with no sessions yet is an empty window, as one that is there
  // with no session in it; it stops being so only beside a real problem (a
  // typo, a root that is not there) with nothing found.
  const misconfigured = present.length === 0 && !unreadable.some((entry) => entry.directory === true)
    && !(waitingNames.length > 0 && problems.length === 0);

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

  // The digests, read once here: the covered days narrow to those every
  // kept file's digest holds whole (fitDigests), the others stay open, and
  // a file with no message left on the covered days waits with them. A
  // file that cannot be read again is unreadable, as one the scan could
  // not read: a day the round cannot hand the model whole stays open.
  const t = createTranslator(config?.lang ?? 'en');
  const tz = window.timezone ?? config?.vault?.timezone;
  let digestRead = null;
  const digestDeferred = [];
  let digestLimitedBy = [];
  if (typeof digestDir === 'string' && covered > 0) {
    const fitted = fitDigests(t, taken, { days, covered, window, starts, tz, io, limits });
    for (const candidate of fitted.failed) {
      taken.delete(candidate);
      dropped.unreadable += 1;
      unreadable.push({ path: candidate.path, project: candidate.project, bytes: candidate.bytes });
    }
    if (fitted.fit < covered) {
      digestDeferred.push(...days.slice(fitted.fit, covered).map((d) => d.day));
      digestLimitedBy = [...new Set(fitted.holds.filter((h) => Math.max(1, h.held) === fitted.fit).map((h) => h.session))].sort();
      covered = fitted.fit;
      for (const candidate of [...taken]) {
        if ([...candidate.perDay.keys()].some((index) => index < covered)) continue;
        taken.delete(candidate);
        dropped.byDigest += 1;
      }
    }
    digestRead = fitted.read;
  }

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
    // The deferred days that are so because a digest could not hold them
    // whole (the others are the cap's), and the sessions whose digests
    // decided it.
    digestDeferred,
    digestLimitedBy,
    overCap,
    problems,
    // The same problems in words, in the vault's language: what `curate
    // --dry` says instead of the codes.
    problemLines: problems.map((problem) => problemLine(t, problem, root)),
    // The listed projects with no sessions yet, and that said in words.
    waiting: waitingNames,
    waitingLines: waitingNames.map((project) => t('sources.transcripts.no_sessions_yet', { project, root })),
    misconfigured,
  };
  if (digestRead !== null) attachDigests(plan, { dir: digestDir, t, tz, read: digestRead });
  plan.promptBlock = renderPromptBlock(t, plan);
  return plan;
}

// Whether a Read's input covers the whole digest: no offset past its first
// line, and no limit short of its last.
function wholeRead(input, lines) {
  const offset = input?.offset ?? null;
  const limit = input?.limit ?? null;
  return (offset === null || Number(offset) <= 1) && (limit === null || Number(limit) >= lines);
}

// readEvidence(record, plan): a kept file counts as read when the round
// record holds a Read tool use whose input `file_path` is exactly the path
// of the file's DIGEST, whose input reads it whole (wholeRead: a digest is
// small enough to be read whole, and a slice of it is not the transcript),
// and whose tool result is not an error. A Read of the transcript's own
// path never counts (01/10/2026): the round does not grant it, and the
// digest is what the model was handed. A kept file with no digest can never
// be read. `read` counts transcripts, as before the digests. Record shape
// read here: { toolUses: [{ id, name, input }], toolResults: [{ toolUseId, isError }] }.
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
  const reads = new Map();
  for (const use of record?.toolUses ?? []) {
    if (use?.name !== 'Read' || !answered.has(use.id) || failed.has(use.id)) continue;
    const path = use.input?.file_path;
    if (typeof path !== 'string') continue;
    if (!reads.has(path)) reads.set(path, []);
    reads.get(path).push(use.input);
  }
  const expected = plan.files.length + (plan.unreadable?.length ?? 0);
  const read = plan.files.filter((file) => typeof file.digest?.path === 'string'
    && (reads.get(file.digest.path) ?? []).some((input) => wholeRead(input, file.digest.lines))).length;
  return { read, expected, ok: read === expected };
}

export const transcriptsSource = Object.freeze({
  id: 'transcripts',
  kind: 'local',
  required: true,
  collect,
  readEvidence,
});
