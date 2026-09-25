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
//   no_init          no init event at all, so nothing above can be proved
//
// Fail closed: a missing permissionMode is not dontAsk, and a missing or
// malformed mcp_servers list cannot prove there is no server.
export function checkIsolation(record, { allowMcp = [] } = {}) {
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
