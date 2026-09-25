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
//   builtin_tools    the init event's built-in tools (every name in its
//                    `tools` list that does not start with `mcp__`) are not
//                    exactly ROUND_TOOLS as a set: one more (the default set
//                    adds Task, Workflow, CronCreate and more, measured on
//                    24/09/2026) or one missing, each named in the detail
//   no_init          no init event at all, so nothing above can be proved
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

export function checkIsolation(record, { allowMcp = [], disallowed = [] } = {}) {
  const problems = [];
  const details = [];
  const init = record ? record.init : null;
  if (!init) {
    problems.push('no_init');
    details.push({ code: 'no_init', messageKey: 'harness.isolation.no_init', params: {} });
  } else {
    if (init.permissionMode !== 'dontAsk') {
      const mode = String(init.permissionMode);
      problems.push('permission_mode');
      details.push({ code: 'permission_mode', messageKey: 'harness.isolation.permission_mode', params: { mode } });
    }
    const listed = init.mcp_servers;
    const extra = Array.isArray(listed)
      ? listed.map((s) => (s && typeof s.name === 'string' ? s.name : String(s))).filter((name) => !allowMcp.includes(name))
      : ['(unreadable mcp_servers)'];
    if (extra.length > 0) {
      const servers = extra.join(', ');
      problems.push('mcp');
      details.push({ code: 'mcp', messageKey: 'harness.isolation.mcp', params: { servers } });
    }
    const diff = builtinToolsDiff(init.tools, disallowed);
    if (diff.extra.length > 0 || diff.missing.length > 0) {
      problems.push('builtin_tools');
      details.push({ code: 'builtin_tools', messageKey: 'harness.isolation.builtin_tools', params: { extra: diff.extra.join(', ') || '-', missing: diff.missing.join(', ') || '-' } });
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
