// The meeting-notes source: the one query a round must run against the
// document store to find the meeting notes of its window, the prompt block
// around it, and whether the round ran that query, on every page.
//
// The incidents it carries (docs/incidents.md, "Connectors"):
//   - 11/08/2026, half the meeting notes were invisible. Two doors: the
//     title search finds the notes the meeting service writes on its own,
//     and the documents attached to the window's calendar events find the
//     minutes people write by hand, whatever their title
//     (`attached_title_prefix` "" takes every attached document). The one
//     exception, checked with get_file_metadata before opening anything
//     attached: an audio or video file, or a document the meeting service
//     marks as a recording or a full transcription, is never opened, only
//     listed by title as not read (fix round 1 of task 4, ruling I1). The
//     second door also stays inside the events the calendar block keeps.
//   - Undated, the document search is accent sensitive and fails silently.
//     The title searched for is the configured literal, copied by the
//     person from one of their own documents, and it goes into the query
//     untouched. A search without the accent answers no document and no
//     error, so the only evidence that counts is a search whose query holds
//     the literal clause and the modification bound exactly (decision D7),
//     neither of them negated.
//   - 11/08/2026, a meeting note entered the log as a link and nothing
//     else: a note is a first class source, distilled into the log.
//   - 10/08/2026 and 21/08/2026: a document is never declared empty
//     without being opened, and one that does not open for a permission
//     reason is "no access (document store permission)".
//   - 03/09/2026, the search found nothing because the event is named after
//     two people: minutes are reached through the event's attachment, never
//     a search by a person's name; the whole document is read, every tab;
//     a speaker attribution error is a divergence to confirm.
//   - Undated, the deduplication key had to be the escaped literal title:
//     a title already in the log, in straight quotes and exactly as
//     written there, is not distilled again.
// The prompt block says all of it, in the vault's language. The kit can
// measure only the search: how many documents exist it cannot know, so the
// documents a round opens are counted (`documents`), never a condition.
//
// The connector (claude.ai Google Drive, measured 24/09/2026 with Claude
// Code 2.1.281): search_files(query, pageSize, pageToken,
// excludeContentSnippets, snippetVerbosity) answers { files[...],
// nextPageToken? }; its query language has `title contains '...'` and
// `modifiedTime > '<RFC 3339>'`, strings in single quotes and a quote inside
// one written \'. How it reads a backslash is unmeasured, so a title holding
// one builds no query at all. An event's attachment carries only fileUrl and
// title, and the document id is the part of fileUrl after /d/ (ruling R-B2):
// the prompt block says so, and the evidence never depends on it. The
// connector also has write tools, which the round must never reach:
// WRITE_SUFFIXES are denied whatever the configuration lists, and never
// allowed.
import { createTranslator } from '../lang.mjs';

export const SEARCH_SUFFIX = 'search_files';
export const READ_SUFFIX = 'read_file_content';
export const METADATA_SUFFIX = 'get_file_metadata';
export const WRITE_SUFFIXES = Object.freeze(['create_file', 'update_file', 'copy_file', 'share_file', 'trash_file', 'download_file_content']);

// The tools the prompt block names: without any one of them the round
// would be denied a call the block asks for, so the source is off.
const REQUIRED_SUFFIXES = Object.freeze([SEARCH_SUFFIX, READ_SUFFIX, METADATA_SUFFIX]);

// An MCP tool is named mcp__<server>__<tool>, the server's name reduced to
// letters, digits, _ and -; the connector's tools are lower-case snake case.
// Anything else in the configuration never becomes a permission rule.
const TOOL_PREFIX_SHAPE = /^mcp__[A-Za-z0-9_-]+__$/;
const TOOL_SUFFIX_SHAPE = /^[a-z][a-z0-9_]*$/;

const HOUR_MS = 60 * 60 * 1000;

function settingsOf(config) {
  const settings = config?.sources?.meeting_notes;
  return settings !== null && typeof settings === 'object' ? settings : {};
}

function stringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

// A title worth searching for: a blank one would match nearly every
// document in the store.
function usableTitle(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// The tools the round may call: the configured suffixes of the right shape,
// each once, never a write tool.
function readSuffixes(settings) {
  const listed = Array.isArray(settings.tool_suffixes) ? settings.tool_suffixes : [];
  return [...new Set(listed.filter((suffix) => typeof suffix === 'string' && TOOL_SUFFIX_SHAPE.test(suffix) && !WRITE_SUFFIXES.includes(suffix)))];
}

// Why the source is off, one { code, detail } each; none means it is on
// (decision D6: the pack's literal is a suggestion until the person turns
// the source on and names the title).
//   disabled         enabled is not true
//   no_title         search_title_contains is missing or blank
//   title_backslash  the title holds a backslash, whose escaping in the
//                    search's query language is unmeasured
//   bad_tool_prefix  tool_prefix is not an MCP prefix; detail: the prefix
//   missing_tools    a tool the prompt block names is not among the usable
//                    tool_suffixes; detail: the missing suffixes
function problemsOf(settings) {
  const problems = [];
  const title = settings.search_title_contains;
  const prefix = stringOr(settings.tool_prefix, '');
  if (settings.enabled !== true) problems.push({ code: 'disabled', detail: '' });
  if (!usableTitle(title)) problems.push({ code: 'no_title', detail: '' });
  else if (title.includes('\\')) problems.push({ code: 'title_backslash', detail: '' });
  if (!TOOL_PREFIX_SHAPE.test(prefix)) problems.push({ code: 'bad_tool_prefix', detail: prefix });
  const usable = readSuffixes(settings);
  const missing = REQUIRED_SUFFIXES.filter((suffix) => !usable.includes(suffix));
  if (missing.length > 0) problems.push({ code: 'missing_tools', detail: missing.join(', ') });
  return problems;
}

function isConfigured(config) {
  return problemsOf(settingsOf(config)).length === 0;
}

function serverSpec(config) {
  const settings = settingsOf(config);
  return {
    id: 'meeting_notes',
    serverDisplayName: stringOr(settings.server_display_name, ''),
    toolPrefix: stringOr(settings.tool_prefix, ''),
    toolSuffixes: readSuffixes(settings),
  };
}

// Nothing is allowed under a prefix that is not an MCP prefix; the write
// tools are denied under whatever prefix is configured.
function toolRules(config) {
  const settings = settingsOf(config);
  const prefix = stringOr(settings.tool_prefix, '');
  return {
    allow: TOOL_PREFIX_SHAPE.test(prefix) ? readSuffixes(settings).map((suffix) => prefix + suffix) : [],
    deny: WRITE_SUFFIXES.map((suffix) => prefix + suffix),
  };
}

// The two clauses of the query, each a string of the search's own language.
function titleClause(literal) {
  return `title contains '${literal.replaceAll("'", "\\'")}'`;
}

function modifiedClause(since) {
  return `modifiedTime > '${since}'`;
}

// An instant as RFC 3339 in UTC, a whole second written without a fraction.
function rfc3339(ms) {
  const iso = new Date(ms).toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -'.000Z'.length)}Z` : iso;
}

// The modification bound: window.from minus window_hours_before_day hours.
// A value that is not a whole number of hours at or above zero counts as no
// hours, and so does one reaching before the first instant a date can hold.
function sinceOf(window, settings) {
  const from = window.from.getTime();
  const hours = settings.window_hours_before_day;
  const since = Number.isInteger(hours) && hours >= 0 ? from - hours * HOUR_MS : from;
  return rfc3339(Number.isNaN(new Date(since).getTime()) ? from : since);
}

function renderPromptBlock(t, plan, settings) {
  if (!plan.configured) return t('sources.meeting_notes.off');
  const attached = stringOr(settings.attached_title_prefix, '');
  const metadata = plan.toolPrefix + METADATA_SUFFIX;
  return [
    t('sources.meeting_notes.heading'),
    t('sources.meeting_notes.search', { tool: plan.toolPrefix + SEARCH_SUFFIX, query: plan.query }),
    attached === '' ? t('sources.meeting_notes.attachments_any', { metadata }) : t('sources.meeting_notes.attachments_prefix', { prefix: attached, metadata }),
    t('sources.meeting_notes.read', { tool: plan.toolPrefix + READ_SUFFIX }),
    t('sources.meeting_notes.distill'),
    t('sources.meeting_notes.no_access'),
    t('sources.meeting_notes.speakers'),
    t('sources.meeting_notes.never_download'),
  ].join('\n');
}

// collect({ window: { from, to }, config, now }): the plan.
//   configured  no problem stands in the way (isConfigured)
//   literal     the configured title, as written (null when it is not a string)
//   since       the modification bound, RFC 3339 in UTC
//   query       the exact query for search_files; null when not configured,
//               so no search is ever offered for a source that is off
//   toolPrefix  the connector's tool prefix, which names the tools the
//               evidence counts
//   problems    { code, detail }, see problemsOf
//   promptBlock the block the round hands the model, in the vault's language
function collect({ window, config }) {
  const settings = settingsOf(config);
  const problems = problemsOf(settings);
  const configured = problems.length === 0;
  const literal = stringOr(settings.search_title_contains, null);
  const since = sinceOf(window, settings);
  const plan = {
    configured,
    literal,
    since,
    query: configured ? `${titleClause(literal)} and ${modifiedClause(since)}` : null,
    toolPrefix: stringOr(settings.tool_prefix, ''),
    problems,
  };
  plan.promptBlock = renderPromptBlock(createTranslator(config?.lang ?? 'en'), plan, settings);
  return plan;
}

// A first page is asked for with no page token (absent, null or empty); a
// later page with a non-empty token. A token of any other kind is neither.
function noPageToken(use) {
  const token = use.input?.pageToken;
  return token === undefined || token === null || token === '';
}

function hasPageToken(use) {
  const token = use.input?.pageToken;
  return typeof token === 'string' && token !== '';
}

// Whether `clause` occurs in `query` right after a `not` (spaces and opening
// parentheses between them allowed): the search then answers for the
// complement of what the clause asks.
const NOT_BEFORE = /(?:^|[^A-Za-z0-9_])not[\s(]*$/i;

function negated(query, clause) {
  for (let at = query.indexOf(clause); at !== -1; at = query.indexOf(clause, at + 1)) {
    if (NOT_BEFORE.test(query.slice(0, at))) return true;
  }
  return false;
}

// Whether the search chain that starts at uses[start] reached a last page:
// every result that does not say `hasNextPage: false` must be followed, later
// in the round, by a successful call of the same tool with the same query and
// a page token. A call whose result failed is skipped, so a retry of a page
// counts; none after it breaks the chain.
function reachedLastPage(uses, succeeded, results, start) {
  const { name, input: { query } } = uses[start];
  let at = start;
  while (results.get(uses[at].id).hasNextPage !== false) {
    const next = uses.findIndex((use, index) => index > at && use.name === name && use.input?.query === query && hasPageToken(use) && succeeded(use));
    if (next === -1) return false;
    at = next;
  }
  return true;
}

// readEvidence(record, plan): the source counts as read when the record
// holds a chain of search_files calls (toolPrefix + 'search_files') whose
// first call has no page token and a query holding both the exact title
// clause and the exact modification bound, neither negated, each call
// successful, and every advertised next page asked for (reachedLastPage).
// Clauses the model adds around the two do not matter; the two themselves
// must be there character for character, so a search without an accent,
// with the title reworded, or with the bound missing, moved or negated is
// not a read. A plan that is not configured is never read. `expected` is
// always 1: the kit cannot know how many documents exist, so `documents`
// only counts the read_file_content results, succeeded and failed, for the
// round's report.
// A result succeeded only when it says so (`isError: false`) and its text
// was whole (`complete` is not false: a truncated answer is a failed call,
// ruling I2 of task 2's review, which extends R-B3; a record without the
// field counts as whole); it is a last page only when it says so
// (`hasNextPage: false`). Record shape: { toolUses: [{ id, name, input }],
// toolResults: [{ toolUseId, isError, hasNextPage, complete }] }.
function readEvidence(record, plan) {
  const results = new Map((record?.toolResults ?? []).map((result) => [result?.toolUseId, result]));
  const uses = (record?.toolUses ?? []).filter((use) => use !== null && typeof use === 'object');
  const succeeded = (use) => {
    const result = results.get(use.id);
    return result?.isError === false && result.complete !== false;
  };
  const prefix = stringOr(plan?.toolPrefix, '');

  const documents = { read: 0, failed: 0 };
  for (const use of uses) {
    if (use.name !== prefix + READ_SUFFIX || !results.has(use.id)) continue;
    if (succeeded(use)) documents.read += 1;
    else documents.failed += 1;
  }

  let read = 0;
  if (plan?.configured === true) {
    const title = titleClause(plan.literal);
    const bound = modifiedClause(plan.since);
    const found = uses.some((use, index) => use.name === prefix + SEARCH_SUFFIX && noPageToken(use) && succeeded(use)
      && typeof use.input?.query === 'string' && use.input.query.includes(title) && use.input.query.includes(bound)
      && !negated(use.input.query, title) && !negated(use.input.query, bound)
      && reachedLastPage(uses, succeeded, results, index));
    if (found) read = 1;
  }
  return { read, expected: 1, ok: read === 1, documents };
}

export const meetingNotesSource = Object.freeze({
  id: 'meeting_notes',
  kind: 'connector',
  required: false,
  emptyMeansNothingListed: false,
  isConfigured,
  serverSpec,
  toolRules,
  collect,
  readEvidence,
});
