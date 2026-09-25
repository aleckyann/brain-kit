// Reads the stream-json output of `claude -p --verbose --output-format
// stream-json`, one JSON object per line, into a round record.
//
// The shapes below were measured on 24/09/2026 with Claude Code 2.1.281
// (test/fixtures/stream/ holds the anonymized streams):
//
//   system/init   { permissionMode, tools[], mcp_servers[{ name, status }], model, cwd }
//   assistant     message.content[] with tool_use { id, name, input }
//   user          message.content[] with tool_result { tool_use_id, is_error, content }
//   result        { subtype, is_error, total_cost_usd, num_turns,
//                   permission_denials[{ tool_name, tool_use_id, tool_input }],
//                   terminal_reason, result }
//
// plus system subtypes this record does not need (thinking_tokens,
// commands_changed, task_summary, post_turn_summary), the hook events
// (hook_started, hook_response, counted for the isolation guard), a
// permission_denied system event per denial, and a top-level
// rate_limit_event. The CLI adds event types between releases, so an
// unknown type or subtype is counted in `unknownTypes`, never fatal, and a
// line that is not a JSON object is counted in `invalidLines`. Deciding
// whether an unknown shape matters is the caller's job; this reader only
// refuses to hide it.
//
// A claude.ai connector's tool result (the controller's capture of
// 24/09/2026, test/fixtures/stream/connectors-connected.jsonl) carries its
// answer as a string of compact JSON in `content`, with the same text in a
// top-level `tool_use_result`; a list or a search that has more pages holds
// `"nextPageToken":"<token>"` at the top level of that document, and its
// last page has no such key. Every entry of `toolResults` carries, besides
// `toolUseId` and `isError` (rulings R-B3 and I2 of 25/09/2026):
//   complete     the result's text (its string content, or its text blocks
//                concatenated) parses as one JSON document. A result the
//                model saw only in part (cut, previewed, or followed by a
//                notice) does not, and must read as a failed call: the
//                capture's keys are sorted, so the token comes right after
//                the list a size cap would cut first
//                A document that is not an object (null, a list, a string,
//                a number) is not complete either: every connector answer
//                measured is an object, and a later CLI that encoded the
//                page twice would otherwise read as a whole last page
//                (review N2 of task 2)
//   hasNextPage  that document's top-level `nextPageToken` is a non-empty
//                string; false whenever `complete` is false, and for a token
//                nested anywhere else (a third party's event cannot hold a
//                page open)
//   items        the length of that document's top-level `events` list (a
//                calendar listing) or, failing that, its top-level `files`
//                list (a document search); null when it has neither or is
//                not complete (ruling R-F1: a connector source's `empty`
//                counts only when its reads listed nothing)
// so a source can tell a first page, or a part of one, from every page,
// and a listing that found something from one that found nothing. The
// text itself is never kept in the record, only those counts.

const KNOWN_SYSTEM_SUBTYPES = new Set([
  'init',
  'hook_started',
  'hook_response',
  'thinking_tokens',
  'commands_changed',
  'task_summary',
  'post_turn_summary',
  'permission_denied',
]);

// Only the result subtypes actually measured. Another one (the SDK
// documents more) still fills `result`, and is also listed as unknown.
const KNOWN_RESULT_SUBTYPES = new Set(['success', 'error_max_turns']);

const KNOWN_PLAIN_TYPES = new Set(['assistant', 'user', 'rate_limit_event']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contentBlocks(event) {
  const content = isObject(event.message) ? event.message.content : undefined;
  return Array.isArray(content) ? content.filter(isObject) : [];
}

// The text of a tool result: its content when that is a string, the text
// of its text blocks when it is a list, nothing otherwise.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('');
}

// `complete`, `hasNextPage` and `items` for one tool result's content (see
// the header).
const NOT_A_PAGE = Object.freeze({ complete: false, hasNextPage: false, items: null });

function pageOf(content) {
  let document;
  try {
    document = JSON.parse(resultText(content));
  } catch {
    return { ...NOT_A_PAGE };
  }
  if (!isObject(document)) return { ...NOT_A_PAGE };
  const token = document.nextPageToken;
  let items = null;
  if (Array.isArray(document.events)) items = document.events.length;
  else if (Array.isArray(document.files)) items = document.files.length;
  return { complete: true, hasNextPage: typeof token === 'string' && token !== '', items };
}

// An incremental reader: `push` one line at a time (runModel feeds it as the
// child writes), `record` whenever the caller needs the state so far.
export function createStreamParser() {
  const events = [];
  const toolUses = [];
  const toolResults = [];
  const denials = [];
  const deniedIds = new Set();
  const unknownTypes = [];
  let init = null;
  let result = null;
  let hookEvents = 0;
  let hookEventsAfterInit = 0;
  let invalidLines = 0;

  const addDenial = (toolName, toolUseId, input) => {
    if (toolUseId !== undefined && deniedIds.has(toolUseId)) return;
    if (toolUseId !== undefined) deniedIds.add(toolUseId);
    denials.push({ toolName, toolUseId, input });
  };

  function push(line) {
    if (typeof line !== 'string' || line.trim() === '') return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      invalidLines++;
      return;
    }
    if (!isObject(event) || typeof event.type !== 'string') {
      invalidLines++;
      return;
    }
    events.push(event);
    const { type, subtype } = event;
    if (type === 'system') {
      if (!KNOWN_SYSTEM_SUBTYPES.has(subtype)) unknownTypes.push(`system/${subtype}`);
      // Any hook event counts, including a hook_* subtype a later release
      // adds: a hook that ran at all means the person's settings were read.
      if (typeof subtype === 'string' && subtype.startsWith('hook_')) {
        hookEvents++;
        if (init !== null) hookEventsAfterInit++;
      }
      if (subtype === 'init' && init === null) init = event;
      if (subtype === 'permission_denied') {
        const use = toolUses.find((u) => u.id === event.tool_use_id);
        addDenial(event.tool_name, event.tool_use_id, use ? use.input : undefined);
      }
      return;
    }
    if (type === 'result') {
      if (!KNOWN_RESULT_SUBTYPES.has(subtype)) unknownTypes.push(`result/${subtype}`);
      result = {
        subtype: typeof subtype === 'string' ? subtype : null,
        isError: event.is_error === true,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
        numTurns: typeof event.num_turns === 'number' ? event.num_turns : null,
        terminalReason: typeof event.terminal_reason === 'string' ? event.terminal_reason : null,
        text: typeof event.result === 'string' ? event.result : null,
      };
      for (const d of Array.isArray(event.permission_denials) ? event.permission_denials.filter(isObject) : []) {
        addDenial(d.tool_name, d.tool_use_id, d.tool_input);
      }
      return;
    }
    if (!KNOWN_PLAIN_TYPES.has(type)) {
      unknownTypes.push(type);
      return;
    }
    if (type === 'assistant') {
      for (const block of contentBlocks(event)) {
        if (block.type === 'tool_use') toolUses.push({ id: block.id, name: block.name, input: block.input });
      }
    } else if (type === 'user') {
      for (const block of contentBlocks(event)) {
        if (block.type === 'tool_result') {
          toolResults.push({ toolUseId: block.tool_use_id, isError: block.is_error === true, ...pageOf(block.content) });
        }
      }
    }
  }

  function record() {
    return {
      init,
      events: [...events],
      toolUses: [...toolUses],
      toolResults: [...toolResults],
      denials: [...denials],
      result,
      hookEvents,
      hookEventsAfterInit,
      unknownTypes: [...unknownTypes],
      invalidLines,
    };
  }

  return { push, record };
}

// The whole stream at once: an array of lines, or one string with newlines.
export function parseStream(lines) {
  const parser = createStreamParser();
  const list = typeof lines === 'string' ? lines.split('\n') : lines;
  for (const line of list) parser.push(line);
  return parser.record();
}
