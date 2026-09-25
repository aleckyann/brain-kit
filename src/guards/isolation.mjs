// Proves, from the round's own stream, that the model runs isolated from
// the person's Claude Code settings (src/harness/claude-code.mjs says which
// flags do it and how that was measured on 24/09/2026). The flags are what
// we ask for; the init event is what the CLI says it did, and the round
// acts on the second. The caller reads this as soon as the init event
// arrives and stops the round before the model does any work.
//
// Problems, each a code the caller can act on and a message both packs
// carry:
//   permission_mode  init.permissionMode is not dontAsk (a default run on the
//                    maintainer's machine reported `auto`, and ran a
//                    disallowed command)
//   hooks            any hook event in the stream: a hook of the person's ran
//                    (`hookEventsAfterInit` > 0 picks the message for one
//                    that ran after the model started)
//   mcp              any MCP server in init the round did not ask for
//                    (isolated mode only, see below)
//   builtin_tools    the init event's built-in tools (every name in its
//                    `tools` list that does not start with `mcp__`) are not
//                    exactly ROUND_TOOLS as a set: one more (the default set
//                    adds Task, Workflow, CronCreate and more, measured on
//                    24/09/2026) or one missing, each named in the detail
//   memory           init.memory_paths is present and not empty: the CLI
//                    loaded the person's memory, or would write it outside
//                    the vault (ruling R-C1; runModel sets the two switches
//                    that, measured on 25/09/2026, leave it absent); the
//                    paths are named in the detail
//   no_init          no init event at all, so nothing above can be proved
//
// Two launch modes (src/harness/claude-code.mjs). In 'isolated' every check
// above applies. In 'connectors' the round loads the person's user
// settings on purpose, because that is what brings the claude.ai
// connectors, so the servers listed are theirs and `mcp` does not apply:
// each connector's state is read from the same init event by
// src/guards/connectors.mjs, and the servers' tools are reachable only
// through the round's own allow rules under dontAsk. The permission mode,
// the hooks (every one of the person's is switched off in that mode, and
// one that runs means the switch failed) and the built-in tools are
// checked in both modes, and so is `memory`. A mode that is neither
// throws: guessing which checks apply is how a check goes missing.
//
// A built-in tool the round itself denies by its bare name is removed from
// the session by the CLI (measured on 24/09/2026: a bare "Bash" in
// --disallowedTools removed Bash from the built-ins), so `disallowed`, the
// round's own deny list, makes it expected absent (ruling R-B4). Each
// element is split where the CLI splits a tool list, so `"Glob,Grep"`
// denies both (review M3, 25/09/2026). A rule with a scope, such as
// `Glob(./secret/**)`, removes nothing.
//
// Fail closed: a missing permissionMode is not dontAsk, a missing or
// malformed mcp_servers list cannot prove there is no server, and a
// missing or malformed tools list cannot prove which tools there are.
import { ROUND_TOOLS, rulesIn } from '../harness/claude-code.mjs';

const UNREADABLE_TOOLS = '(unreadable tools)';

function builtinToolsDiff(tools, disallowed) {
  const denied = new Set(disallowed.filter((rule) => typeof rule === 'string').flatMap((rule) => rulesIn(rule)));
  const expected = ROUND_TOOLS.filter((name) => !denied.has(name));
  if (!Array.isArray(tools)) return { extra: [UNREADABLE_TOOLS], missing: expected };
  const builtins = [...new Set(tools.map((name) => String(name)).filter((name) => !name.startsWith('mcp__')))];
  return {
    extra: builtins.filter((name) => !expected.includes(name)),
    missing: expected.filter((name) => !builtins.includes(name)),
  };
}

// The memory paths an init event lists, as text; null when there are none.
// The measured shape is an object of paths ({ auto: '<dir>' }); a list is
// read the same way, and any other value that is not empty counts as a
// path the CLI names (fail closed on a shape a later release brings).
function memoryPaths(value) {
  if (value === undefined || value === null || value === '') return null;
  let items;
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'object') items = Object.values(value);
  else items = [value];
  if (items.length === 0) return null;
  return items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ') || '-';
}

const MODES = Object.freeze(['isolated', 'connectors']);

export function checkIsolation(record, { mode = 'isolated', allowMcp = [], disallowed = [] } = {}) {
  if (!MODES.includes(mode)) throw new TypeError(`checkIsolation: not a launch mode: ${JSON.stringify(mode)} (isolated or connectors)`);
  const problems = [];
  const details = [];
  const init = record ? record.init : null;
  if (!init) {
    problems.push('no_init');
    details.push({ code: 'no_init', messageKey: 'harness.isolation.no_init', params: {} });
  } else {
    if (init.permissionMode !== 'dontAsk') {
      const reported = String(init.permissionMode);
      problems.push('permission_mode');
      details.push({ code: 'permission_mode', messageKey: 'harness.isolation.permission_mode', params: { mode: reported } });
    }
    if (mode === 'isolated') {
      const listed = init.mcp_servers;
      const extra = Array.isArray(listed)
        ? listed.map((s) => (s && typeof s.name === 'string' ? s.name : String(s))).filter((name) => !allowMcp.includes(name))
        : ['(unreadable mcp_servers)'];
      if (extra.length > 0) {
        const servers = extra.join(', ');
        problems.push('mcp');
        details.push({ code: 'mcp', messageKey: 'harness.isolation.mcp', params: { servers } });
      }
    }
    const diff = builtinToolsDiff(init.tools, disallowed);
    if (diff.extra.length > 0 || diff.missing.length > 0) {
      problems.push('builtin_tools');
      details.push({ code: 'builtin_tools', messageKey: 'harness.isolation.builtin_tools', params: { extra: diff.extra.join(', ') || '-', missing: diff.missing.join(', ') || '-' } });
    }
    const paths = memoryPaths(init.memory_paths);
    if (paths !== null) {
      problems.push('memory');
      details.push({ code: 'memory', messageKey: 'harness.isolation.memory', params: { paths } });
    }
  }
  const count = record && typeof record.hookEvents === 'number' ? record.hookEvents : 0;
  // A hook after the init event means the model may already have worked
  // under the person's settings: said so, never "before any work".
  const late = record && typeof record.hookEventsAfterInit === 'number' && record.hookEventsAfterInit > 0;
  if (count > 0) {
    problems.push('hooks');
    details.push({ code: 'hooks', messageKey: late ? 'harness.isolation.hooks_late' : 'harness.isolation.hooks', params: { count } });
  }
  return { ok: problems.length === 0, problems, details };
}
