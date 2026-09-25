// The briefing's blocks: what the morning briefing holds, in the order the
// vault's own configuration asks for (phase 4, decision B1).
//
// `briefing.blocks` is an ordered list. Each entry is either the id of a
// block of the kit's catalog, BLOCKS below, or a block the person defines:
//
//   { "id": "<lower-case slug>", "title": "<text>",
//     "read": ["<vault-relative path>", ...], "instruction": "<text>" }
//
// A configuration that predates the setting reads its language pack's own
// default list (lang/<code>/config.defaults.json), as every briefing
// setting does; one that sets it is taken exactly as written, and nothing
// the list does not name is ever added to it.
//
// Two kinds of catalog block. A FACT block is filled here, from the facts
// the kit computed (src/briefing/facts.mjs), as text in the vault's
// language: the model only presents it, and never computes a date, a count
// or a deadline of its own (layer 1). A JUDGEMENT block is an instruction
// the model follows, with the paths it may read. A custom block is the
// person's own instruction and paths.
//
// Validation (validateBriefingBlocks): an unknown id, an id listed twice, an
// empty list, and a custom block with a bad id, a missing title or
// instruction, or a `read` path that is outside the vault, missing, not a
// file, or inside `briefing.never_read`, are each a named problem. A block
// with a problem is left out, and the briefing says which and why; an id
// listed twice keeps its first place. Nothing is silently dropped, and an
// empty list is never replaced by the default one.
//
// A `read` path is vault-relative and normalised ("./a/../b.md" is
// "b.md"). It is checked against `never_read` BEFORE the file system is
// touched, so a path the person keeps out of every reading is never even
// checked for existence, and again by its real path, so a link inside the
// vault that leads into a never-read folder is refused too. The never-read
// test is src/briefing/pending.mjs's inNeverRead: an entry without a
// trailing slash covers the folder of that name as the one with it does,
// and an entry with a fragment ("memory/log.md#full") covers its file.
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { KIT_ROOT } from '../version.mjs';
import { REFERENCE_LANG, SUPPORTED_LANGS } from '../lang.mjs';
import { inNeverRead } from './pending.mjs';
import { humanDay } from './facts.mjs';
import {
  itemLines, problemLine, renderGit, renderLastRun, renderLock, renderPullRequests, renderStale,
} from '../commands/preflight.mjs';

// The catalog: every block id the kit knows, and its kind.
export const BLOCKS = Object.freeze({
  sources: 'fact',
  due: 'fact',
  upcoming: 'fact',
  undated: 'fact',
  open_prs: 'fact',
  stale: 'fact',
  questions: 'fact',
  blind_spots: 'judgement',
  strategy: 'judgement',
  today_calendar: 'judgement',
});

// The three blocks drawn from the pending tables.
const PENDING_BLOCKS = Object.freeze(['due', 'upcoming', 'undated']);

// A custom block's id: lower case letters and digits, words joined by one
// hyphen or underscore, starting with a letter.
export const CUSTOM_ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

// The pending problems that belong to one table row, and are written under
// the item they name (matched by file and line).
const ITEM_PROBLEMS = new Set(['invalid_date', 'date_without_year', 'ambiguous_deadline']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The language pack's config.defaults.json, read once per language.
const packCache = new Map();
function packDefaults(lang) {
  const chosen = SUPPORTED_LANGS.includes(lang) ? lang : REFERENCE_LANG;
  if (!packCache.has(chosen)) packCache.set(chosen, JSON.parse(readFileSync(join(KIT_ROOT, 'lang', chosen, 'config.defaults.json'), 'utf8')));
  return packCache.get(chosen);
}

function packBriefing(lang) {
  return packDefaults(lang).briefing ?? {};
}

// One briefing setting: the configuration's own value when it has the key
// (null included, which means "none"), else its language pack's default,
// else null.
export function briefingSetting(config, key) {
  const own = isPlainObject(config?.briefing) ? config.briefing : {};
  if (Object.hasOwn(own, key)) return own[key];
  const pack = packBriefing(config?.lang);
  return Object.hasOwn(pack, key) ? pack[key] : null;
}

// The limits the person set (decision B4): null means none.
export function briefingLimits(config) {
  const caps = briefingSetting(config, 'write_caps');
  return {
    maxWords: briefingSetting(config, 'max_words'),
    maxQuestions: briefingSetting(config, 'max_questions'),
    writeCaps: isPlainObject(caps) ? caps : {},
  };
}

function neverReadOf(config) {
  const list = briefingSetting(config, 'never_read');
  return Array.isArray(list) ? list : [];
}

// The never_read entry that covers `path`, or null.
function coveringEntry(path, neverRead) {
  return neverRead.find((entry) => inNeverRead(path, [entry])) ?? null;
}

function insideDir(base, path) {
  const rel = relative(base, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// A vault-relative path, normalised, or a problem: { path, unreadable? } |
// { problem: 'read_empty' | 'read_outside' | 'read_never_read' |
// 'read_missing' | 'read_not_file', entry? }. `unreadable` is the error
// code of a path that is there but cannot be read (fix round 1, ruling
// R-T8): not a configuration problem, it is rendered in its block as not
// verified. With `mustExist` false a path that does not exist is
// accepted as it is (the model reports it not found), and one that exists
// still has its real path checked. The real path comes from
// realpathSync.native, which gives the case the file system stores, so a
// "People/ana.md" on a file system that ignores case still meets the
// "people/" entry.
export function checkReadPath(root, raw, neverRead, { mustExist = true } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') return { problem: 'read_empty' };
  const text = raw.trim();
  if (isAbsolute(text) || text.startsWith('~')) return { problem: 'read_outside' };
  const path = posix.normalize(text).replace(/\/+$/, '');
  if (path === '.' || path === '' || path === '..' || path.startsWith('../')) return { problem: 'read_outside' };
  const entry = coveringEntry(path, neverRead);
  if (entry !== null) return { problem: 'read_never_read', entry };
  let real;
  let realRoot;
  try {
    realRoot = realpathSync.native(root);
    real = realpathSync.native(join(root, path));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return mustExist ? { problem: 'read_missing' } : { path };
    return { path, unreadable: error.code ?? 'EIO' };
  }
  if (!insideDir(realRoot, real)) return { problem: 'read_outside' };
  const realEntry = coveringEntry(relative(realRoot, real).split(sep).join('/'), neverRead);
  if (realEntry !== null) return { problem: 'read_never_read', entry: realEntry };
  if (!mustExist) return { path };
  if (!statSync(real).isFile()) return { problem: 'read_not_file' };
  try {
    accessSync(real, constants.R_OK);
  } catch (error) {
    return { path, unreadable: error.code ?? 'EIO' };
  }
  return { path };
}

// The blocks the configuration asks for, resolved: { blocks, problems }.
// `blocks` in the configuration's order, each { id, kind } for a catalog
// block and { id, kind: 'custom', title, instruction, read } for the
// person's own; `problems` each { code, position (1-based), id?, field?,
// path?, entry?, value? }.
export function briefingBlocks(config, root) {
  const list = briefingSetting(config, 'blocks');
  const neverRead = neverReadOf(config);
  const blocks = [];
  const problems = [];
  if (!Array.isArray(list)) {
    problems.push({ code: 'not_a_list', value: JSON.stringify(list) });
    return { blocks, problems };
  }
  if (list.length === 0) {
    problems.push({ code: 'empty' });
    return { blocks, problems };
  }
  const seen = new Set();
  list.forEach((entry, index) => {
    const position = index + 1;
    if (typeof entry === 'string') {
      if (!Object.hasOwn(BLOCKS, entry)) {
        problems.push({ code: 'unknown', position, id: entry });
        return;
      }
      if (seen.has(entry)) {
        problems.push({ code: 'duplicate', position, id: entry });
        return;
      }
      seen.add(entry);
      blocks.push({ id: entry, kind: BLOCKS[entry] });
      return;
    }
    if (!isPlainObject(entry)) {
      problems.push({ code: 'not_a_block', position, value: JSON.stringify(entry) });
      return;
    }
    const id = entry.id;
    if (typeof id !== 'string' || !CUSTOM_ID.test(id)) {
      problems.push({ code: 'bad_id', position, id: typeof id === 'string' ? id : JSON.stringify(id ?? null) });
      return;
    }
    if (Object.hasOwn(BLOCKS, id)) {
      problems.push({ code: 'custom_id_taken', position, id });
      return;
    }
    if (seen.has(id)) {
      problems.push({ code: 'duplicate', position, id });
      return;
    }
    seen.add(id);
    const own = [];
    for (const field of ['title', 'instruction']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') own.push({ code: 'missing_field', position, id, field });
    }
    const read = [];
    const unreadable = [];
    for (const raw of Array.isArray(entry.read) ? entry.read : []) {
      const checked = checkReadPath(root, raw, neverRead);
      if (checked.problem !== undefined) own.push({ code: checked.problem, position, id, path: String(raw), entry: checked.entry ?? null });
      else if (checked.unreadable !== undefined) {
        if (!unreadable.some((u) => u.path === checked.path)) unreadable.push({ path: checked.path, detail: checked.unreadable });
      } else if (!read.includes(checked.path)) read.push(checked.path);
    }
    if (own.length > 0) {
      problems.push(...own);
      return;
    }
    blocks.push({ id, kind: 'custom', title: entry.title.trim(), instruction: entry.instruction.trim(), read, unreadable });
  });
  return { blocks, problems };
}

export function validateBriefingBlocks(config, root) {
  return briefingBlocks(config, root).problems;
}

// One problem of briefingBlocks as a sentence, in the language of `t`.
export function blockProblemLine(t, problem) {
  const { code, position, id, field, path, entry, value } = problem;
  switch (code) {
    case 'not_a_list': return t('briefing.problem_not_a_list', { value });
    case 'empty': return t('briefing.problem_empty', { defaults: packBriefing(null).blocks ?? [] });
    case 'unknown': return t('briefing.problem_unknown', { position, id, known: Object.keys(BLOCKS) });
    case 'duplicate': return t('briefing.problem_duplicate', { position, id });
    case 'not_a_block': return t('briefing.problem_not_a_block', { position, value });
    case 'bad_id': return t('briefing.problem_bad_id', { position, id });
    case 'custom_id_taken': return t('briefing.problem_custom_id_taken', { position, id });
    case 'missing_field': return t('briefing.problem_missing_field', { position, id, field });
    case 'read_empty': return t('briefing.problem_read_empty', { position, id });
    case 'read_outside': return t('briefing.problem_read_outside', { position, id, path });
    case 'read_never_read': return t('briefing.problem_read_never_read', { position, id, path, entry });
    case 'read_missing': return t('briefing.problem_read_missing', { position, id, path });
    case 'read_not_file': return t('briefing.problem_read_not_file', { position, id, path });
    default: return t('briefing.problem_other', { code, detail: JSON.stringify(problem) });
  }
}

// ------------------------------------------------------------ the questions

// Which open questions the briefing asks today (ruling R-T6): the escalated
// ones first, then the other open ones, each group in the queue's order;
// every one of them when `maxQuestions` is null, else the first
// `maxQuestions`, and `notShown` says how many were cut. `room` is how many
// new questions fit under the limit (null: no limit). A question due for
// archiving is still open, so it is placed like any other and marked;
// `toArchive` is every such question, placed or not, which
// `brain-kit questions sweep` archives.
export function selectQuestions(questions, maxQuestions) {
  if (questions === null || questions === undefined || questions.ok !== true) return { placed: [], notShown: 0, room: maxQuestions, toArchive: [] };
  const escalatedIds = new Set(questions.escalated.map((q) => q.id));
  const archiveIds = new Set(questions.toArchive.map((q) => q.id));
  const ordered = [
    ...questions.open.filter((q) => escalatedIds.has(q.id)).map((q) => ({ ...q, escalated: true, dueForArchive: archiveIds.has(q.id) })),
    ...questions.open.filter((q) => !escalatedIds.has(q.id)).map((q) => ({ ...q, escalated: false, dueForArchive: archiveIds.has(q.id) })),
  ];
  const placed = maxQuestions === null ? ordered : ordered.slice(0, maxQuestions);
  return {
    placed,
    notShown: ordered.length - placed.length,
    room: maxQuestions === null ? null : Math.max(0, maxQuestions - placed.length),
    toArchive: questions.toArchive,
  };
}

function corruptDetail(t, item) {
  if (item.reason === 'encoding') return t('briefing.corrupt_encoding');
  if (item.reason === 'json') return t('briefing.corrupt_json');
  return t('briefing.corrupt_shape', { field: item.field });
}

function questionLine(t, q, limits) {
  const created = humanDay(q.createdOn);
  const lines = [q.askedCount === 0
    ? t('briefing.question_never_asked', { id: q.id, text: q.text, created })
    : t('briefing.question_asked', { id: q.id, text: q.text, created, count: q.askedCount, last: humanDay(q.lastAskedOn) })];
  if (q.escalated) lines.push(t('briefing.question_escalated', { count: q.askedCount, limit: limits.escalateAfter }));
  if (q.dueForArchive) lines.push(t('briefing.question_due_archive', { days: q.ageDays, limit: limits.maxAgeDays }));
  return lines;
}

function questionsBlock(facts, { t, kit, selection, maxQuestions }) {
  const q = facts.questions;
  if (q === null || q === undefined || q.ok !== true) {
    return [t('briefing.questions_unknown', { file: q?.file ?? '-', detail: q?.reason ?? '-', kit })];
  }
  const lines = [t('briefing.questions_header', { open: q.open.length, placed: selection.placed.length, file: q.file })];
  const escalated = selection.placed.filter((item) => item.escalated);
  const open = selection.placed.filter((item) => !item.escalated);
  if (escalated.length > 0) {
    lines.push(t('briefing.questions_escalated_header', { count: escalated.length, kit }));
    for (const item of escalated) lines.push(...questionLine(t, item, q));
  }
  if (open.length > 0) {
    lines.push(t('briefing.questions_open_header', { count: open.length }));
    for (const item of open) lines.push(...questionLine(t, item, q));
  }
  if (selection.placed.length === 0) lines.push(t('briefing.questions_none'));
  if (selection.notShown > 0) lines.push(t('briefing.questions_not_shown', { count: selection.notShown, limit: maxQuestions }));
  if (selection.toArchive.length > 0) lines.push(t('briefing.questions_sweep', { count: selection.toArchive.length, limit: q.maxAgeDays, kit }));
  for (const item of q.corrupt) lines.push(t('briefing.questions_corrupt', { line: item.line, detail: corruptDetail(t, item), text: item.text, file: q.file }));
  if (selection.room === null) lines.push(t('briefing.questions_room_unlimited', { kit }));
  else if (selection.room > 0) lines.push(t('briefing.questions_room', { count: selection.room, limit: maxQuestions, kit }));
  else lines.push(t('briefing.questions_room_none', { limit: maxQuestions, kit }));
  // The render records the placed questions only after the whole prompt is
  // rendered (ruling R-T8), so the line says what is about to happen.
  if (selection.placed.length > 0) lines.push(t('briefing.questions_marked', { day: facts.todayHuman }));
  return lines;
}

// ------------------------------------------------------------ the fact blocks

function sourcesBlock(facts, { t }) {
  const lines = [...renderLastRun(facts, t)];
  const run = facts.lastRun;
  if (run === null) lines.push(t('briefing.sources_no_round'));
  else if (run.problem !== null) lines.push(t('briefing.sources_run_unreadable'));
  else {
    if (run.exit !== 0) lines.push(t('briefing.sources_run_not_ok', { exit: run.exit ?? '-' }));
    for (const [source, entry] of Object.entries(run.sources)) {
      if (entry.advanced === true) continue;
      let action;
      if (entry.state === 'needs_auth') action = t('briefing.action_needs_auth');
      else if (['absent', 'tools_missing', 'blocked_by_user_rules'].includes(entry.state)) action = t('briefing.action_not_in_session');
      else action = t('briefing.action_doctor');
      lines.push(t('briefing.sources_not_read', { source, action }));
    }
  }
  lines.push(...renderGit(facts, t), ...renderLock(facts, t));
  return lines;
}

function itemKey(file, line) {
  return `${file}\n${line}`;
}

// The pending problems split for the blocks being rendered: `byItem`, the
// ones that name a row shown in one of those blocks, by file and line (ruling
// R-T7), and `loose`, every other one (a table, heading or column that is not
// there, or a row the enabled blocks do not show).
function splitPendingProblems(facts, pendingIds) {
  const pending = facts.pending;
  const shown = new Set();
  const itemsOf = { due: [...pending.overdue, ...pending.today], upcoming: pending.upcoming, undated: pending.undated };
  for (const id of pendingIds) for (const item of itemsOf[id]) shown.add(itemKey(item.file, item.line));
  const byItem = new Map();
  const loose = [];
  for (const problem of pending.problems) {
    const key = ITEM_PROBLEMS.has(problem.code) ? itemKey(problem.detail.path, problem.detail.line) : null;
    if (key !== null && shown.has(key)) {
      if (!byItem.has(key)) byItem.set(key, []);
      byItem.get(key).push(problem);
    } else loose.push(problem);
  }
  return { byItem, loose };
}

function pendingItems(t, items, byItem, mark) {
  if (items.length === 0) return itemLines(t, []);
  const lines = [];
  for (const item of items) {
    lines.push(...itemLines(t, [item]).map((line) => `${line}${mark(item.file)}`));
    for (const problem of byItem.get(itemKey(item.file, item.line)) ?? []) lines.push(`  ${problemLine(t, problem)}`);
  }
  return lines;
}

function pendingBlock(id, facts, { t, split, firstPending, firstTitle, mark }) {
  const pending = facts.pending;
  const lines = [];
  if (split.loose.length > 0) {
    if (id === firstPending) {
      lines.push(t('preflight.pending_problems', { count: split.loose.length }));
      for (const problem of split.loose) lines.push(problemLine(t, problem));
    } else lines.push(t('briefing.pending_problems_above', { count: split.loose.length, title: firstTitle }));
  }
  if (id === 'due') {
    lines.push(t('preflight.pending_overdue', { count: pending.overdue.length }), ...pendingItems(t, pending.overdue, split.byItem, mark));
    lines.push(t('preflight.pending_today', { count: pending.today.length }), ...pendingItems(t, pending.today, split.byItem, mark));
  } else if (id === 'upcoming') {
    lines.push(t('preflight.pending_upcoming', { days: pending.upcomingDays, count: pending.upcoming.length }), ...pendingItems(t, pending.upcoming, split.byItem, mark));
    lines.push(t('preflight.pending_later', { days: pending.upcomingDays, count: pending.later }));
  } else {
    lines.push(t('preflight.pending_undated', { count: pending.undated.length }), ...pendingItems(t, pending.undated, split.byItem, mark));
  }
  return lines;
}

// ------------------------------------------------------------ the judgement blocks

// Markdown links in `text`: [label](target "title").
const LINK = /\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

// The strategy document the configuration names: the notes linked from
// `briefing.strategy_doc.index` whose link text contains
// `strategy_doc.title_contains` (case not minded). { found: true, index,
// paths, unreadable } or { found: false, reason, index?, contains?, detail? }.
// The index and every target are held to the same rules as a custom block's
// `read`; one that is there but cannot be read is never an exception
// (ruling R-T8): the index is `index_unreadable`, a target is listed in
// `unreadable` with its error code.
export function strategyDoc(config, root) {
  const doc = briefingSetting(config, 'strategy_doc');
  const index = isPlainObject(doc) && typeof doc.index === 'string' ? doc.index.trim() : '';
  const contains = isPlainObject(doc) && typeof doc.title_contains === 'string' ? doc.title_contains.trim() : '';
  if (index === '' || contains === '') return { found: false, reason: 'not_configured' };
  const neverRead = neverReadOf(config);
  const checked = checkReadPath(root, index, neverRead);
  if (checked.problem !== undefined) return { found: false, reason: 'index_unusable', index, contains, detail: checked.problem };
  // An index that is there but cannot be read (checkReadPath's `unreadable`,
  // or a read that fails after it) is index_unreadable, never a throw.
  let text;
  try {
    text = readFileSync(join(root, checked.path), 'utf8');
  } catch (error) {
    return { found: false, reason: 'index_unreadable', index: checked.path, contains, detail: error.code ?? 'EIO' };
  }
  const needle = contains.toLowerCase();
  const paths = [];
  const unreadable = [];
  const refused = [];
  for (const match of text.matchAll(LINK)) {
    if (!match[1].toLowerCase().includes(needle)) continue;
    let target = match[2].split('#')[0];
    if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      // Left as written.
    }
    const relativeTarget = target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(checked.path), target);
    const found = checkReadPath(root, relativeTarget, neverRead);
    if (found.problem !== undefined) refused.push({ path: relativeTarget, problem: found.problem });
    else if (found.unreadable !== undefined) {
      if (!unreadable.some((u) => u.path === found.path)) unreadable.push({ path: found.path, detail: found.unreadable });
    } else if (!paths.includes(found.path)) paths.push(found.path);
  }
  if (paths.length > 0 || unreadable.length > 0) return { found: true, index: checked.path, paths, unreadable };
  if (refused.length > 0) return { found: false, reason: 'targets_unusable', index: checked.path, contains, detail: refused.map((r) => `${r.path} (${r.problem})`).join(', ') };
  return { found: false, reason: 'no_match', index: checked.path, contains };
}

function blindSpotsBlock(readList, log, { t }) {
  const paths = readList.length > 0 ? codeList(readList) : [t('briefing.none_listed')];
  const logPath = codeList([log])[0];
  return [t('briefing.blind_spots_instruction', { paths, log: logPath })];
}

function codeList(paths) {
  return paths.map((path) => `\`${path}\``);
}

function readProblemWord(t, problem) {
  switch (problem) {
    case 'read_outside': return t('briefing.read_problem_outside');
    case 'read_never_read': return t('briefing.read_problem_never_read');
    case 'read_not_file': return t('briefing.read_problem_not_file');
    default: return t('briefing.read_problem_missing');
  }
}

function unreadableLines(t, unreadable) {
  return unreadable.map((item) => t('briefing.read_unreadable', { path: item.path, detail: item.detail }));
}

function strategyBlock(config, root, { t }) {
  const doc = strategyDoc(config, root);
  if (doc.found) {
    const lines = doc.paths.length > 0 ? [t('briefing.strategy_instruction', { paths: codeList(doc.paths), index: doc.index })] : [t('briefing.strategy_none_readable', { index: doc.index })];
    return [...lines, ...unreadableLines(t, doc.unreadable)];
  }
  if (doc.reason === 'not_configured') return [t('briefing.strategy_not_configured')];
  if (doc.reason === 'index_unreadable') return [t('briefing.strategy_index_unreadable', { index: doc.index, detail: doc.detail })];
  if (doc.reason === 'index_unusable') return [t('briefing.strategy_index_unusable', { index: doc.index, why: readProblemWord(t, doc.detail) })];
  if (doc.reason === 'targets_unusable') return [t('briefing.strategy_targets_unusable', { index: doc.index, contains: doc.contains, detail: doc.detail })];
  return [t('briefing.strategy_not_found', { index: doc.index, contains: doc.contains })];
}

function calendarBlock(facts, config, { t, packCalendar }) {
  const calendar = isPlainObject(config?.sources?.calendar) ? config.sources.calendar : {};
  const id = briefingSetting(config, 'calendar_id');
  const named = typeof id === 'string' && id.trim() !== '' && !/^<.*>$/.test(id.trim());
  const privacy = isPlainObject(calendar.privacy) ? calendar.privacy : (packCalendar.privacy ?? {});
  const types = Array.isArray(privacy.exclude_event_types) && privacy.exclude_event_types.length > 0 ? privacy.exclude_event_types : [t('briefing.none_listed')];
  const keywords = Array.isArray(privacy.exclude_keywords) && privacy.exclude_keywords.length > 0 ? privacy.exclude_keywords.map((k) => JSON.stringify(String(k))) : [t('briefing.none_listed')];
  const which = named ? codeList([id.trim()])[0] : t('briefing.calendar_primary');
  const prefix = typeof calendar.tool_prefix === 'string' && calendar.tool_prefix !== '' ? calendar.tool_prefix : packCalendar.tool_prefix;
  return [t('briefing.calendar_instruction', { day: facts.todayHuman, timezone: facts.tz, calendar: which, prefix, types, keywords })];
}

// ------------------------------------------------------------ the whole list

function titleOf(t, block) {
  if (block.kind === 'custom') return block.title;
  switch (block.id) {
    case 'sources': return t('briefing.title_sources');
    case 'due': return t('briefing.title_due');
    case 'upcoming': return t('briefing.title_upcoming');
    case 'undated': return t('briefing.title_undated');
    case 'open_prs': return t('briefing.title_open_prs');
    case 'stale': return t('briefing.title_stale');
    case 'questions': return t('briefing.title_questions');
    case 'blind_spots': return t('briefing.title_blind_spots');
    case 'strategy': return t('briefing.title_strategy');
    default: return t('briefing.title_today_calendar');
  }
}

function kindLine(t, block) {
  if (block.kind === 'fact') return t('briefing.kind_fact');
  if (block.kind === 'judgement') return t('briefing.kind_judgement');
  return t('briefing.kind_custom');
}

function packCalendarOf(lang) {
  return packDefaults(lang).sources.calendar;
}

// The text of `{{blocks}}`: first the blocks left out and why (the
// configuration's problems), then every block of `blocks` in its order,
// each under its number, title and id. `selection` is selectQuestions'
// result (null when the questions block is not in the list). Ruling R-T10:
// a path a fact block lists that never_read covers is marked "(never
// read)", so no block reads as leave to open it.
export function renderBlocks({ blocks, problems, facts, config, root, t, kit, log, selection = null }) {
  const out = [];
  if (problems.length > 0) {
    out.push(t('briefing.left_out_header', { count: problems.length }));
    for (const problem of problems) out.push(`- ${blockProblemLine(t, problem)}`);
    out.push('');
  }
  if (blocks.length === 0) {
    out.push(t('briefing.no_blocks'));
    return out.join('\n');
  }
  const pendingIds = blocks.filter((b) => PENDING_BLOCKS.includes(b.id)).map((b) => b.id);
  const split = splitPendingProblems(facts, pendingIds);
  const firstPendingBlock = blocks.find((b) => PENDING_BLOCKS.includes(b.id));
  const firstPending = firstPendingBlock?.id ?? null;
  const firstTitle = firstPendingBlock === undefined ? '' : titleOf(t, firstPendingBlock);
  const { maxQuestions } = briefingLimits(config);
  const readList = briefingReadList(config, root).paths;
  const neverRead = neverReadOf(config);
  const neverReadMark = t('briefing.never_read_mark');
  const mark = (path) => (typeof path === 'string' && coveringEntry(path, neverRead) !== null ? neverReadMark : '');
  blocks.forEach((block, index) => {
    out.push(`### ${index + 1}. ${titleOf(t, block)} (${block.id})`, '', kindLine(t, block), '');
    let lines;
    switch (block.id) {
      case 'sources': lines = sourcesBlock(facts, { t }); break;
      case 'due':
      case 'upcoming':
      case 'undated': lines = pendingBlock(block.id, facts, { t, split, firstPending, firstTitle, mark }); break;
      case 'open_prs': lines = renderPullRequests(facts, t); break;
      case 'stale': lines = renderStale(facts, t, { mark }); break;
      case 'questions': lines = questionsBlock(facts, { t, kit, selection: selection ?? selectQuestions(facts.questions, maxQuestions), maxQuestions }); break;
      case 'blind_spots': lines = blindSpotsBlock(readList, log, { t }); break;
      case 'strategy': lines = strategyBlock(config, root, { t }); break;
      case 'today_calendar': lines = calendarBlock(facts, config, { t, packCalendar: packCalendarOf(config?.lang) }); break;
      default:
        lines = [
          t('briefing.custom_instruction', { instruction: block.instruction }),
          block.read.length > 0 ? t('briefing.custom_read', { paths: codeList(block.read) }) : t('briefing.custom_read_none'),
          ...unreadableLines(t, block.unreadable ?? []),
        ];
    }
    out.push(...lines, '');
  });
  return out.join('\n').replace(/\n+$/, '');
}

// ------------------------------------------------------------ the other placeholders

// `briefing.read`, normalised, with every entry outside the vault or inside
// never_read left out and said. Only the entry's real path is resolved: a
// note of the list that is not there is the model's to report as not found.
// One whose resolution fails for another reason (a directory the user
// cannot read) is `unreadable`, `{ path, detail }`, never an ordinary note
// (final review of phase 4, M1).
export function briefingReadList(config, root) {
  const list = briefingSetting(config, 'read');
  const neverRead = neverReadOf(config);
  const paths = [];
  const unreadable = [];
  const leftOut = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const checked = checkReadPath(root, raw, neverRead, { mustExist: false });
    if (checked.problem !== undefined) leftOut.push({ path: String(raw), problem: checked.problem, entry: checked.entry ?? null });
    else if (checked.unreadable !== undefined) {
      if (!unreadable.some((item) => item.path === checked.path)) unreadable.push({ path: checked.path, detail: checked.unreadable });
    } else if (!paths.includes(checked.path)) paths.push(checked.path);
  }
  return { paths, unreadable, leftOut };
}

export function renderReadList(config, root, t) {
  const { paths, unreadable, leftOut } = briefingReadList(config, root);
  const lines = paths.length > 0 || unreadable.length > 0 ? paths.map((path) => `- \`${path}\``) : [t('briefing.read_none')];
  lines.push(...unreadableLines(t, unreadable));
  for (const item of leftOut) {
    if (item.problem === 'read_never_read') lines.push(t('briefing.read_left_out_never_read', { path: item.path, entry: item.entry }));
    else lines.push(t('briefing.read_left_out_outside', { path: item.path }));
  }
  return lines.join('\n');
}

export function renderNeverRead(config, t) {
  const list = neverReadOf(config).filter((entry) => typeof entry === 'string' && entry.trim() !== '');
  if (list.length === 0) return t('briefing.never_read_none');
  return list.map((entry) => `- \`${entry}\``).join('\n');
}

// Only the limits the person set, one line each; nothing at all when every
// one is null (decision B4).
export function renderLimits(config, t) {
  const { maxWords, maxQuestions, writeCaps } = briefingLimits(config);
  const lines = [];
  if (maxWords !== null) lines.push(t('briefing.limit_max_words', { count: maxWords }));
  if (maxQuestions !== null) lines.push(t('briefing.limit_max_questions', { count: maxQuestions }));
  for (const [key, count] of Object.entries(writeCaps)) {
    if (count === null) continue;
    if (key === 'captures') lines.push(t('briefing.limit_captures', { count }));
    else if (key === 'pending_changes') lines.push(t('briefing.limit_pending_changes', { count }));
    else lines.push(t('briefing.limit_write_cap', { key, count }));
  }
  return lines.join('\n');
}
