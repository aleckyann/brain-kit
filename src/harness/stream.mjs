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
// `"nextPageToken":"<token>"` in that text, and its last page has no such
// key. Every entry of `toolResults` says whether its text holds a
// non-empty token (`hasNextPage`, ruling R-B3; a content given as blocks is
// read from its text blocks, joined), so a source can tell a first page
// from every page. The text itself is never kept in the record.

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

// A next-page token in the form the capture showed. Inside the JSON text a
// quote that belongs to a string value is escaped, so a description that
// merely mentions a token does not match.
const NEXT_PAGE_TOKEN = /"nextPageToken"\s*:\s*"[^"]+"/;

// The text of a tool result: its content when that is a string, the text
// of its text blocks when it is a list, nothing otherwise.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('');
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
          toolResults.push({ toolUseId: block.tool_use_id, isError: block.is_error === true, hasNextPage: NEXT_PAGE_TOKEN.test(resultText(block.content)) });
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
