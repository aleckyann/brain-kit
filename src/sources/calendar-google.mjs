// The calendar source: which calendars a round lists through the claude.ai
// Google Calendar connector, and whether the round listed every one of them
// over the whole window, with the private-event filter and every page
// (phase 3, docs/superpowers/plans/2026-09-24-phase-3-connector-sources.md,
// decisions D6 and D7).
//
// Off until the vault names what to read (D6): the source counts as
// configured only when `sources.calendar.calendars` is a non-empty list of
// calendar ids, none blank and none a placeholder such as "<owner-email>".
// `primary` names the owner's main calendar. Other people's calendars
// (`sources.calendar.team_calendars`) are read only when the vault records
// their consent with `team_calendars_consent_noted: true`, that boolean and
// nothing else; without it they are left out of the plan and the round is
// told how many were (docs/incidents.md, 11/08/2026, "a squad's daily
// stand-up was invisible to the vault", and the undated "a colleague's
// medical appointment was in the calendar window"). An entry of
// team_calendars that is blank or a placeholder names no calendar and is
// not counted. A calendar listed twice, or listed both as the owner's and
// as someone else's, is planned once, as the owner's.
//
// Read evidence is mechanical (D7), measured on the round record built by
// src/harness/stream.mjs, never on the model's word. A planned calendar
// counts as read only when the record holds a chain of list_events calls
// for it (the tool named toolPrefix + "list_events", exactly), each
// answered without error:
//   - the first asks for the first page (no pageToken), with startTime at
//     or before the window's start and endTime at or after its end, both
//     instants written with an explicit offset ("Z" is one: a time with no
//     offset names no instant, since this machine would read it in its own
//     zone and the connector in another), eventType exactly ["DEFAULT"],
//     the privacy filter made mechanical (out of office, focus time,
//     working location, birthdays and events from mail never enter the
//     round), and no fullText, the one input that would keep events out
//     of a listing that covers the window;
//   - every call whose result advertises a next page (`hasNextPage`: a
//     non-empty nextPageToken in the result's text) is followed, later in
//     the record, by a call for the same calendar with the same instants,
//     the same filter, no fullText and a non-empty pageToken. The filter
//     is asked of every page, not only of the first: a page asked without
//     it would bring the event types it keeps out.
// `primary` also matches a call with no calendarId, which the connector
// reads as the main calendar; any other id matches only itself, as written,
// since the kit cannot know which calendar primary is. An errored or
// unanswered call is no link of any chain, and neither is one whose result
// came back incomplete (`complete: false` from the stream parser: its text
// did not parse as one JSON document, and a truncated first page can look
// like a last one; a result with no `complete` at all, from a record made
// before the parser said, counts as complete), so a retry that succeeds
// still counts. The source is ok only when every planned calendar was read
// (a day read in part stays open, ruling R13 of phase 2), and a plan with
// no calendar is never ok: a source that is off reads nothing.
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
// update_event, delete_event, respond_to_event) are denied to every round
// that reads it.
import { createTranslator } from '../lang.mjs';

const PRIMARY = 'primary';
const LIST_EVENTS = 'list_events';
const PRIVATE_EVENT_FILTER = Object.freeze(['DEFAULT']);
const PAGE_SIZE = 250;
const WRITE_TOOLS = Object.freeze(['create_event', 'update_event', 'delete_event', 'respond_to_event']);

// The packs' defaults (lang/<code>/config.defaults.json), for a
// configuration with no calendar section; test/sources-calendar.test.mjs
// holds them equal.
const DEFAULT_SPEC = Object.freeze({
  serverDisplayName: 'claude.ai Google Calendar',
  toolPrefix: 'mcp__claude_ai_Google_Calendar__',
  toolSuffixes: Object.freeze(['list_events', 'get_event', 'list_calendars']),
});

// One MCP server's tool prefix, and one tool name: each rule toolRules
// builds must stay one permission rule. The CLI splits a tool list at a
// comma or a space outside parentheses (src/harness/claude-code.mjs,
// rulesIn), so a prefix holding either would carry a second rule of the
// vault's choosing into the round's allow list. The schema refuses such a
// prefix first; this is the last line.
const TOOL_PREFIX = /^mcp__[A-Za-z0-9_-]+__$/;
const TOOL_SUFFIX = /^[a-z][a-z0-9_]*$/;

// An instant: an ISO 8601 date and time with an explicit offset.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

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

function isConfigured(config) {
  const { calendars } = settingsOf(config);
  return Array.isArray(calendars) && calendars.length > 0 && calendars.every(isCalendarId);
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

// The configured read tools allowed, and the connector's write tools
// denied whatever the configuration says (a deny wins over an allow).
function toolRules(config) {
  const { toolPrefix, toolSuffixes } = serverSpec(config);
  if (!TOOL_PREFIX.test(toolPrefix)) {
    throw new TypeError(`sources.calendar.tool_prefix: ${JSON.stringify(toolPrefix)} is not one MCP server's tool prefix (mcp__<server>__)`);
  }
  for (const suffix of toolSuffixes) {
    if (typeof suffix !== 'string' || !TOOL_SUFFIX.test(suffix)) {
      throw new TypeError(`sources.calendar.tool_suffixes: ${JSON.stringify(suffix)} is not one tool name`);
    }
  }
  return {
    allow: [...new Set(toolSuffixes)].map((suffix) => toolPrefix + suffix),
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
  if (problem.code === 'not_configured') return t('sources.calendar.not_configured');
  return t('sources.calendar.other_calendars_without_consent', { count: problem.detail });
}

function renderPromptBlock(t, plan) {
  const lines = plan.problems.map((problem) => problemLine(t, problem));
  if (!plan.configured) return lines.join('\n');
  const tool = plan.toolPrefix + LIST_EVENTS;
  const count = plan.calendars.length + plan.otherCalendars.length;
  lines.push(t('sources.calendar.heading', { count, from: plan.window.from, to: plan.window.to, tool }));
  for (const calendar of plan.calendars) lines.push(t('sources.calendar.own_line', { calendar, input: inputFor(calendar, plan) }));
  for (const calendar of plan.otherCalendars) lines.push(t('sources.calendar.other_line', { calendar, input: inputFor(calendar, plan) }));
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
// Returns { configured, calendars, otherCalendars, window: { from, to,
// timezone }, toolPrefix, problems, promptBlock }, the instants as ISO
// 8601 UTC strings. `problems` holds { code, detail }: `not_configured`,
// or `other_calendars_without_consent` with the number of calendars left
// out as its detail.
function collect({ window, config }) {
  const settings = settingsOf(config);
  const configured = isConfigured(config);
  const calendars = configured ? [...new Set(settings.calendars)] : [];
  const listed = Array.isArray(settings.team_calendars) ? settings.team_calendars.filter(isCalendarId) : [];
  const others = [...new Set(listed)].filter((id) => !calendars.includes(id));
  const consent = settings.team_calendars_consent_noted === true;
  const problems = [];
  if (!configured) problems.push({ code: 'not_configured', detail: '' });
  else if (others.length > 0 && !consent) problems.push({ code: 'other_calendars_without_consent', detail: String(others.length) });
  const plan = {
    configured,
    calendars,
    otherCalendars: configured && consent ? others : [],
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

// What every page of a listing asks: the private-event filter and nothing
// narrower. fullText is the one input of list_events (measurement 5) that
// keeps events out while the window is covered.
function listsEveryEvent(input) {
  return isPrivateEventFilter(input.eventType) && input.fullText === undefined;
}

// Whether a list_events input names `calendarId`: as written, or, for
// primary, by leaving calendarId out.
function names(input, calendarId) {
  if (input.calendarId === undefined) return calendarId === PRIMARY;
  return input.calendarId === calendarId;
}

// The first page of a listing that covers [from, to) with the filter.
function opensListing(input, from, to) {
  if (input.pageToken !== undefined) return false;
  const start = instant(input.startTime);
  const end = instant(input.endTime);
  return start !== null && end !== null && start <= from && end >= to && listsEveryEvent(input);
}

// A next page of the listing whose first page was asked with `first`.
function continuesListing(input, first) {
  return typeof input.pageToken === 'string' && input.pageToken !== ''
    && instant(input.startTime) === instant(first.startTime)
    && instant(input.endTime) === instant(first.endTime)
    && listsEveryEvent(input);
}

// `calls` are the answered, non-error list_events calls, in record order,
// each { input, more }.
function readCalendar(calendarId, calls, from, to) {
  for (let index = 0; index < calls.length; index += 1) {
    const first = calls[index];
    if (!names(first.input, calendarId) || !opensListing(first.input, from, to)) continue;
    let page = first;
    let at = index;
    while (page.more) {
      const next = calls.findIndex((call, position) => position > at && names(call.input, calendarId) && continuesListing(call.input, first.input));
      if (next === -1) break;
      page = calls[next];
      at = next;
    }
    if (!page.more) return true;
  }
  return false;
}

// readEvidence(record, plan): record shape { toolUses: [{ id, name, input }],
// toolResults: [{ toolUseId, isError, hasNextPage, complete? }] }.
function readEvidence(record, plan) {
  const tool = `${plan.toolPrefix}${LIST_EVENTS}`;
  const answered = new Set();
  const failed = new Set();
  const more = new Set();
  for (const result of record?.toolResults ?? []) {
    answered.add(result.toolUseId);
    if (result.isError || result.complete === false) failed.add(result.toolUseId);
    if (result.hasNextPage) more.add(result.toolUseId);
  }
  const calls = [];
  for (const use of record?.toolUses ?? []) {
    if (use?.name !== tool || !answered.has(use.id) || failed.has(use.id) || !isObject(use.input)) continue;
    calls.push({ input: use.input, more: more.has(use.id) });
  }
  const from = instant(plan.window?.from);
  const to = instant(plan.window?.to);
  const calendars = [...(plan.calendars ?? []), ...(plan.otherCalendars ?? [])];
  const read = from === null || to === null ? 0 : calendars.filter((id) => readCalendar(id, calls, from, to)).length;
  return { read, expected: calendars.length, ok: calendars.length > 0 && read === calendars.length };
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
