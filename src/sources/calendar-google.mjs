// The calendar source: which calendars a round lists through the claude.ai
// Google Calendar connector, and whether the round listed every one of them
// over the whole window, with the private-event filter and every page
// (phase 3, docs/superpowers/plans/2026-09-24-phase-3-connector-sources.md,
// decisions D6 and D7).
//
// Off until the person turns it on and names what to read (D6): the source
// is on only when `sources.calendar.enabled` is exactly true and
// `sources.calendar.calendars` is a non-empty list of calendar ids, none
// blank and none a placeholder such as "<owner-email>". `primary` names the
// owner's main calendar. `enabled` exists because the kit's init wrote the
// owner's e-mail into calendars until phase 3: a vault made then carries a
// calendar and no enabled key, and stays off after the upgrade, told why
// (`not_enabled`; fix round 1 of task 3, finding I4). The tool configuration
// is checked here, never by the schema (ruling R-E1: a best-effort source
// never stops the whole vault): a tool_prefix that is not one MCP server's
// prefix (`bad_tool_prefix`), a tool outside the calendar's read tools
// (`bad_tool_suffixes`), or a list without list_events (`missing_tools`)
// keeps only this source off, with that problem named in the plan. Every
// reason is named at once, in the order a person fixes them. Calendar ids
// are planned trimmed, so the ids the model is given are the ids it is
// checked against.
//
// Other people's calendars (`sources.calendar.team_calendars`) are read
// only when the vault records who authorised reading the team's calendars
// and on which day (docs/incidents.md, 11/08/2026, "a squad's daily
// stand-up was invisible to the vault", and the undated "a colleague's
// medical appointment was in the calendar window"):
// `team_authorization: { by: "human:<handle>", at: "YYYY-MM-DD" }`, a
// person and a day that exists (phase 5a task 4). It replaced
// `team_calendars_consent_noted`, which nothing reads any more (ruling
// R-A5; doctor says so while the key is there). It is checked here, never
// by the schema (ruling R-A6, after R-E1): a missing, malformed or
// impossible authorization records nothing, so the team calendars are left
// out of the plan and the round is told how many and why
// (`team_calendars_without_authorization`, with its `reason`), while the
// owner's own calendars are planned all the same; a calendar left out is
// never one the round must read, so it can never make the source unread,
// and no command refuses the configuration because of it. With it, the
// prompt block prints who authorised them and the day, DD/MM/YYYY. An entry
// of team_calendars that is blank or a placeholder names no calendar and is
// not counted. A calendar listed twice, or listed both as the owner's and
// as someone else's, is planned once, as the owner's.
//
// Read evidence is mechanical (D7), measured on the round record built by
// src/harness/stream.mjs, never on the model's word, over every call of the
// tool named toolPrefix + "list_events", exactly. A call is `ok` when it was
// answered without error and its result came back whole (`complete: false`
// from the stream parser means its text did not parse as one JSON
// document, and a truncated page can look like a last one; a result with no
// `complete` at all, from a record made before the parser said, counts as
// whole). Every call of a listing asks only for the listing the prompt
// gives: eventType exactly ["DEFAULT"], the privacy filter made mechanical
// (out of office, focus time, working location, birthdays and events from
// mail never enter the round), and no input the prompt does not name
// (fullText narrows by text; eventTypeFilter, served beside eventType on
// 25/09/2026, widens or narrows the event types; orderBy changes what a page
// token means; an input the connector adds later might filter: finding I3).
// A planned calendar counts as read only when one listing of it was read to
// its last page:
//   - its first page is an ok call with no pageToken, startTime at or before
//     the window's start and endTime at or after its end, compared as
//     instants with no slack, both written with an explicit offset ("Z" is
//     one: a time with no offset names no instant, since this machine would
//     read it in its own zone and the connector in another);
//   - the next page of a page whose result advertises one (`hasNextPage`)
//     is the FIRST later call for the same calendar that carries a
//     pageToken, whatever came of it (finding I2: a failed page is never
//     stepped over): it must carry a non-empty token and exactly the first
//     page's instants; when it failed, came back cut or was never answered,
//     only a later call with that very same pageToken, a retry, takes its
//     place, and any other call with a token breaks the listing.
// `primary` also matches a call with no calendarId, which the connector
// reads as the main calendar; any other id matches only itself, as written,
// since the kit cannot know which calendar primary is. A listing that
// breaks can be started again from its first page. The source is ok only
// when every planned calendar was read (a day read in part stays open,
// ruling R13 of phase 2), and a plan with no calendar is never ok: a source
// that is off reads nothing.
// `listed` counts the events on every page of every listing of a planned
// calendar over the window in the round (the stream parser's `items`):
// each successful first page that opens the window and each successful
// next page of one, whether or not that listing is the one that proves the
// read (scoped re-review: a second listing that found events after a
// first that found none is still something listed). Metadata only; null
// when nothing was read or any of those pages says no count. A connector source's `empty` counts only
// when it is 0 (ruling R-F1, src/guards/watermark.mjs).
//
// The recurring shape this guards against (the plan's "How work is proven
// here"): a command that succeeds answering about something other than
// what we act on, a listing of one hour of a day read as the whole day, a
// first page read as every page (docs/incidents.md, 20/08/2026, "the round
// closed a day it had never read").
//
// Connector shapes, measured on 24/09/2026 with Claude Code 2.1.281 (the
// controller's capture, test/fixtures/stream/connectors-connected.jsonl):
// list_events takes calendarId, startTime, endTime, eventType[], pageSize
// (at most 250), pageToken and timeZone; its result is JSON text holding
// "nextPageToken" only while more pages exist; an event's attachments carry
// fileUrl and title only. The connector's write tools (create_event,
// update_event, delete_event, respond_to_event) are denied to every round,
// whatever the configuration says.
import { createTranslator } from '../lang.mjs';
import { DATE_PATTERN, isValidIsoDate } from '../dates.mjs';

const PRIMARY = 'primary';
const LIST_EVENTS = 'list_events';
const PRIVATE_EVENT_FILTER = Object.freeze(['DEFAULT']);
const PAGE_SIZE = 250;
const READ_TOOLS = Object.freeze(['list_events', 'get_event', 'list_calendars']);
const REQUIRED_TOOLS = Object.freeze([LIST_EVENTS]);
const WRITE_TOOLS = Object.freeze(['create_event', 'update_event', 'delete_event', 'respond_to_event']);
const LISTING_INPUTS = Object.freeze(['calendarId', 'startTime', 'endTime', 'eventType', 'pageSize', 'pageToken', 'timeZone']);

// The packs' defaults (lang/<code>/config.defaults.json), for a
// configuration with no calendar section; test/sources-calendar.test.mjs
// holds them equal.
const DEFAULT_SPEC = Object.freeze({
  serverDisplayName: 'claude.ai Google Calendar',
  toolPrefix: 'mcp__claude_ai_Google_Calendar__',
  toolSuffixes: Object.freeze(['list_events', 'get_event', 'list_calendars']),
});

// One MCP server's tool prefix: each rule toolRules builds must stay one
// permission rule. The CLI splits a tool list at a comma or a space outside
// parentheses (src/harness/claude-code.mjs, rulesIn), so a prefix holding
// either would carry a second rule of the vault's choosing into the round's
// lists.
const TOOL_PREFIX = /^mcp__[A-Za-z0-9_-]+__$/;

// An instant: an ISO 8601 date and time with an explicit offset.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// A person, as the configuration writes one (actors.human): the only
// team_authorization.by that records anything.
const HUMAN_ACTOR = /^human:[a-z0-9][a-z0-9-]*$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function settingsOf(config) {
  const settings = config?.sources?.calendar;
  return isObject(settings) ? settings : {};
}

function isCalendarId(id) {
  return typeof id === 'string' && id.trim() !== '' && !id.trim().startsWith('<');
}

// The calendar ids of a list: trimmed, each once, blank entries and
// placeholders left out.
function calendarIds(list) {
  return Array.isArray(list) ? [...new Set(list.filter(isCalendarId).map((id) => id.trim()))] : [];
}

// Why a team_authorization value records no authorization, or null when it
// records one: 'absent' (no key, or null), 'not_object', 'by' (not a person
// written human:<handle>), 'at' (not a day written YYYY-MM-DD) or 'day'
// (written as one, but a day that does not exist, such as 31/02). Keys
// besides by and at are not read.
export function authorizationProblem(value) {
  if (value === undefined || value === null) return 'absent';
  if (!isObject(value)) return 'not_object';
  if (typeof value.by !== 'string' || !HUMAN_ACTOR.test(value.by)) return 'by';
  if (typeof value.at !== 'string' || !DATE_PATTERN.test(value.at)) return 'at';
  if (!isValidIsoDate(value.at)) return 'day';
  return null;
}

// The sentence saying why, in `t`'s terms: a translator, or doctor's
// message maker (src/doctor/checks.mjs, asMessage), so doctor renders the
// very sentence the round's parameters carry, in the report's language.
export function authorizationWhy(t, reason) {
  switch (reason) {
    case 'not_object': return t('sources.calendar.team_authorization_not_object');
    case 'by': return t('sources.calendar.team_authorization_bad_by');
    case 'at': return t('sources.calendar.team_authorization_bad_at');
    case 'day': return t('sources.calendar.team_authorization_no_such_day');
    default: return t('sources.calendar.team_authorization_absent');
  }
}

// DD/MM/YYYY, for a person.
function shownDay(day) {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

function serverSpec(config) {
  const settings = settingsOf(config);
  return {
    id: 'calendar',
    serverDisplayName: typeof settings.server_display_name === 'string' ? settings.server_display_name : DEFAULT_SPEC.serverDisplayName,
    toolPrefix: typeof settings.tool_prefix === 'string' ? settings.tool_prefix : DEFAULT_SPEC.toolPrefix,
    toolSuffixes: [...(Array.isArray(settings.tool_suffixes) ? settings.tool_suffixes : DEFAULT_SPEC.toolSuffixes)],
  };
}

// Why the source is off, as { code, detail } problems, every reason at once;
// empty when it is on. Turned off on purpose, the other settings do not
// matter yet.
function configurationProblems(config) {
  const settings = settingsOf(config);
  if (settings.enabled !== true) {
    const listed = calendarIds(settings.calendars).length;
    return [listed > 0 ? { code: 'not_enabled', detail: String(listed) } : { code: 'disabled', detail: '' }];
  }
  const problems = [];
  const { calendars } = settings;
  if (!Array.isArray(calendars) || calendars.length === 0 || !calendars.every(isCalendarId)) {
    problems.push({ code: 'not_configured', detail: '' });
  }
  const { toolPrefix, toolSuffixes } = serverSpec(config);
  if (!TOOL_PREFIX.test(toolPrefix)) problems.push({ code: 'bad_tool_prefix', detail: toolPrefix });
  const outside = toolSuffixes.filter((suffix) => !READ_TOOLS.includes(suffix));
  if (outside.length > 0) problems.push({ code: 'bad_tool_suffixes', detail: outside.map((suffix) => JSON.stringify(suffix)).join(', ') });
  const missing = REQUIRED_TOOLS.filter((tool) => !toolSuffixes.includes(tool));
  if (missing.length > 0) problems.push({ code: 'missing_tools', detail: missing.join(', ') });
  return problems;
}

function isConfigured(config) {
  return configurationProblems(config).length === 0;
}

// The source's read tools allowed while it is on, and the connector's write
// tools always denied (a deny wins over an allow), under a prefix that is
// one MCP server's; under any other prefix, no rule at all.
function toolRules(config) {
  const { toolPrefix, toolSuffixes } = serverSpec(config);
  if (!TOOL_PREFIX.test(toolPrefix)) return { allow: [], deny: [] };
  return {
    allow: isConfigured(config) ? [...new Set(toolSuffixes)].map((suffix) => toolPrefix + suffix) : [],
    deny: WRITE_TOOLS.map((suffix) => toolPrefix + suffix),
  };
}

// The exact inputs of the first page of one calendar's listing.
function inputFor(calendarId, plan) {
  return JSON.stringify({
    calendarId,
    startTime: plan.window.from,
    endTime: plan.window.to,
    eventType: PRIVATE_EVENT_FILTER,
    pageSize: PAGE_SIZE,
    timeZone: plan.window.timezone,
  });
}

function problemLine(t, problem) {
  switch (problem.code) {
    case 'disabled': return t('sources.calendar.disabled');
    case 'not_enabled': return t('sources.calendar.not_enabled', { count: problem.detail });
    case 'not_configured': return t('sources.calendar.not_configured');
    case 'bad_tool_prefix': return t('sources.calendar.bad_tool_prefix', { prefix: JSON.stringify(problem.detail) });
    case 'bad_tool_suffixes': return t('sources.calendar.bad_tool_suffixes', { tools: problem.detail });
    case 'missing_tools': return t('sources.calendar.missing_tools', { tools: problem.detail });
    default: return t('sources.calendar.team_calendars_without_authorization', { count: problem.detail, why: authorizationWhy(t, problem.reason) });
  }
}

function renderPromptBlock(t, plan) {
  const lines = plan.problems.map((problem) => problemLine(t, problem));
  if (!plan.configured) return lines.join('\n');
  const tool = plan.toolPrefix + LIST_EVENTS;
  const count = plan.calendars.length + plan.otherCalendars.length;
  lines.push(t('sources.calendar.heading', { count, from: plan.window.from, to: plan.window.to, tool }));
  for (const calendar of plan.calendars) lines.push(t('sources.calendar.own_line', { calendar, input: inputFor(calendar, plan) }));
  for (const calendar of plan.otherCalendars) lines.push(t('sources.calendar.other_line', { calendar, input: inputFor(calendar, plan) }));
  if (plan.teamAuthorization) lines.push(t('sources.calendar.team_authorized', { by: plan.teamAuthorization.by, day: shownDay(plan.teamAuthorization.at) }));
  lines.push(t('sources.calendar.pages', { tool }));
  lines.push(t('sources.calendar.dedup'));
  lines.push(t('sources.calendar.privacy'));
  lines.push(t('sources.calendar.attachments'));
  return lines.join('\n');
}

// collect({ window: { from, to, days, timezone }, config, now })
//   window: Date instants, [from, to), the source's own window, computed
//           by the caller in the vault's time zone; `timezone` is that zone
//           (config.vault.timezone when absent). `days` and `now` are not
//           needed here.
// Returns { configured, calendars, otherCalendars, teamAuthorization,
// window: { from, to, timezone }, toolPrefix, problems, promptBlock }, the
// instants as ISO 8601 UTC strings; `teamAuthorization` is the recorded
// { by, at } when other people's calendars are planned, null otherwise.
// `problems` holds { code, detail }: the reasons the source is off
// (`disabled`; `not_enabled` with the number of calendars listed;
// `not_configured`; `bad_tool_prefix` with the prefix; `bad_tool_suffixes`
// with the tools outside the read tools; `missing_tools` with the tools it
// needs), or, while it is on, `team_calendars_without_authorization` with
// the number of calendars left out and a `reason`, authorizationProblem's.
function collect({ window, config }) {
  const settings = settingsOf(config);
  const problems = configurationProblems(config);
  const configured = problems.length === 0;
  const calendars = configured ? calendarIds(settings.calendars) : [];
  const others = calendarIds(settings.team_calendars).filter((id) => !calendars.includes(id));
  const authorization = settings.team_authorization;
  const reason = authorizationProblem(authorization);
  if (configured && others.length > 0 && reason !== null) {
    problems.push({ code: 'team_calendars_without_authorization', detail: String(others.length), reason });
  }
  const readOthers = configured && reason === null && others.length > 0;
  const plan = {
    configured,
    calendars,
    otherCalendars: readOthers ? others : [],
    teamAuthorization: readOthers ? { by: authorization.by, at: authorization.at } : null,
    window: { from: window.from.toISOString(), to: window.to.toISOString(), timezone: window.timezone ?? config?.vault?.timezone },
    toolPrefix: serverSpec(config).toolPrefix,
    problems,
  };
  plan.promptBlock = renderPromptBlock(createTranslator(config?.lang ?? 'en'), plan);
  return plan;
}

function instant(value) {
  if (typeof value !== 'string' || !INSTANT.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function isPrivateEventFilter(eventType) {
  return Array.isArray(eventType) && eventType.length === PRIVATE_EVENT_FILTER.length && eventType.every((type, index) => type === PRIVATE_EVENT_FILTER[index]);
}

// Whether a call asks for the listing the prompt gives: the private-event
// filter, and no input the prompt does not name.
function asksTheListing(input) {
  return isPrivateEventFilter(input.eventType) && Object.keys(input).every((key) => LISTING_INPUTS.includes(key));
}

// Whether a list_events input names `calendarId`: as written, or, for
// primary, by leaving calendarId out.
function names(input, calendarId) {
  if (input.calendarId === undefined) return calendarId === PRIMARY;
  return input.calendarId === calendarId;
}

// The first page of a listing that covers [from, to).
function opensListing(input, from, to) {
  if (input.pageToken !== undefined) return false;
  const start = instant(input.startTime);
  const end = instant(input.endTime);
  return start !== null && end !== null && start <= from && end >= to && asksTheListing(input);
}

// A next page of the listing whose first page was asked with `first`.
function continuesListing(input, first) {
  return typeof input.pageToken === 'string' && input.pageToken !== ''
    && instant(input.startTime) === instant(first.startTime)
    && instant(input.endTime) === instant(first.endTime)
    && asksTheListing(input);
}

// The position of the first call after `at` that names `calendarId` and
// carries a pageToken, or -1.
function nextWithToken(calendarId, calls, at) {
  for (let position = at + 1; position < calls.length; position += 1) {
    const { input } = calls[position];
    if (input.pageToken !== undefined && names(input, calendarId)) return position;
  }
  return -1;
}

// The pages of the listing whose first page is at `start`, when it was
// read to its last page, null otherwise: each next page the first later
// call with a token, and one that did not come back whole taken over only
// by a retry of its very token.
function readToLastPage(calendarId, calls, start) {
  const first = calls[start].input;
  const pages = [start];
  let at = start;
  while (calls[at].more) {
    let next = nextWithToken(calendarId, calls, at);
    if (next === -1 || !continuesListing(calls[next].input, first)) return null;
    while (!calls[next].ok) {
      const retry = nextWithToken(calendarId, calls, next);
      if (retry === -1 || calls[retry].input.pageToken !== calls[next].input.pageToken || !continuesListing(calls[retry].input, first)) return null;
      next = retry;
    }
    pages.push(next);
    at = next;
  }
  return pages;
}

// `calls` are every list_events call, in record order, each { input, ok,
// more, items }. The pages of the first listing of the calendar read to its
// last page, or null.
function readCalendar(calendarId, calls, from, to) {
  for (let position = 0; position < calls.length; position += 1) {
    const call = calls[position];
    if (!call.ok || !names(call.input, calendarId) || !opensListing(call.input, from, to)) continue;
    const pages = readToLastPage(calendarId, calls, position);
    if (pages !== null) return pages;
  }
  return null;
}

// The positions of every successful page of a listing of `calendarId` over
// the window: a first page that opens it, or a next page of one.
function listingPages(calendarId, calls, from, to) {
  // A next page counts even when its first page came back failed: the
  // model still saw what the next page listed.
  const opens = calls.filter((call) => names(call.input, calendarId) && opensListing(call.input, from, to));
  const out = [];
  calls.forEach((call, position) => {
    if (!call.ok || !names(call.input, calendarId)) return;
    const token = call.input.pageToken;
    if (opensListing(call.input, from, to) || (typeof token === 'string' && token !== '' && opens.some((open) => continuesListing(call.input, open.input)))) out.push(position);
  });
  return out;
}

// The events those pages listed, or null when a page gave no count.
function listedOn(calls, pages) {
  let total = 0;
  for (const position of pages) {
    const { items } = calls[position];
    if (!Number.isInteger(items) || items < 0) return null;
    total += items;
  }
  return total;
}

// readEvidence(record, plan): record shape { toolUses: [{ id, name, input }],
// toolResults: [{ toolUseId, isError, hasNextPage, complete? }] }.
function readEvidence(record, plan) {
  const tool = `${plan.toolPrefix}${LIST_EVENTS}`;
  const outcomes = new Map();
  for (const result of record?.toolResults ?? []) {
    const seen = outcomes.get(result.toolUseId);
    const outcome = seen ?? { failed: false, more: false, items: result.items };
    if (result.isError || result.complete === false) outcome.failed = true;
    if (result.hasNextPage) outcome.more = true;
    // Two results for one call: which one the model saw is not known.
    if (seen !== undefined) outcome.items = null;
    outcomes.set(result.toolUseId, outcome);
  }
  const calls = [];
  for (const use of record?.toolUses ?? []) {
    if (use?.name !== tool || !isObject(use.input)) continue;
    const outcome = outcomes.get(use.id);
    calls.push({ input: use.input, ok: outcome !== undefined && !outcome.failed, more: outcome?.more === true, items: outcome?.items ?? null });
  }
  const from = instant(plan.window?.from);
  const to = instant(plan.window?.to);
  const calendars = [...(plan.calendars ?? []), ...(plan.otherCalendars ?? [])];
  const readings = from === null || to === null ? [] : calendars.map((id) => readCalendar(id, calls, from, to)).filter((pages) => pages !== null);
  const read = readings.length;
  const every = from === null || to === null ? [] : [...new Set(calendars.flatMap((id) => listingPages(id, calls, from, to)))];
  const listed = read === 0 ? null : listedOn(calls, every);
  return { read, expected: calendars.length, ok: calendars.length > 0 && read === calendars.length, listed };
}

export const calendarSource = Object.freeze({
  id: 'calendar',
  kind: 'connector',
  required: false,
  emptyMeansNothingListed: false,
  isConfigured,
  serverSpec,
  toolRules,
  collect,
  readEvidence,
});
