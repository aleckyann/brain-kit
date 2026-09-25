// The state of each claude.ai connector a round depends on, read from the
// round's own init event (phase 3, decision D2 of
// docs/superpowers/plans/2026-09-24-phase-3-connector-sources.md): the
// invocation that will use a connector is the one that says whether it is
// there. No listing from another command is read: on four nights of
// September 2026 the CLI's listing said connected while the tools were not
// in the session that needed them (docs/incidents.md, 05/09/2026).
//
// A source describes its connector as a spec:
//   { id, serverDisplayName, toolPrefix, toolSuffixes }
// `serverDisplayName` is matched exactly against the init event's
// `mcp_servers[].name` (claude.ai connectors are listed as, for example,
// "claude.ai Google Calendar"), and the source's tools are
// `toolPrefix + suffix` in the init event's `tools` list.
//
// States:
//   connected      listed as connected, and every tool the source needs is
//                  in the session
//   needs_auth     status `needs-auth` (seen on 24/09/2026)
//   failed         status `failed` (seen on 24/09/2026)
//   pending        status `pending`: still connecting when the session
//                  started (seen on 24/09/2026, on two to six servers in
//                  every launch)
//   absent         not in the server list: never connected in claude.ai,
//                  or disabled for Claude Code; the two cannot be told apart
//   tools_missing  listed as connected, but a tool the source needs is not
//                  in the session (the fifth trap of 05 to 08/09/2026), or
//                  the source names no tool at all; `observedPrefix` names
//                  another prefix under which every one of its tools was
//                  seen (a source configured with the wrong prefix), and is
//                  null otherwise: one tool of the same name on an
//                  unrelated server proves nothing (review M5, 25/09/2026)
//   unknown        any other status, or one that is not a string: a status
//                  a later release adds stays unknown until it is mapped
//
// Each entry also keeps `rawStatus`, the status exactly as the CLI printed
// it (null when there was none), and `observedPrefix`.

export const CONNECTOR_STATES = Object.freeze(['connected', 'needs_auth', 'failed', 'pending', 'absent', 'tools_missing', 'unknown']);

// The statuses measured, and the state each one means. Looked up as own
// properties only: a status such as "constructor" is unknown.
const STATUS_STATES = Object.freeze({ connected: 'connected', 'needs-auth': 'needs_auth', failed: 'failed', pending: 'pending' });

export function connectorStates(init, specs) {
  const servers = Array.isArray(init?.mcp_servers) ? init.mcp_servers : [];
  const tools = Array.isArray(init?.tools) ? init.tools : [];
  const out = {};
  for (const spec of specs) {
    const server = servers.find((s) => s && s.name === spec.serverDisplayName);
    if (!server) {
      out[spec.id] = { state: 'absent', rawStatus: null, observedPrefix: null };
      continue;
    }
    const raw = typeof server.status === 'string' ? server.status : null;
    const mapped = raw !== null && Object.hasOwn(STATUS_STATES, raw) ? STATUS_STATES[raw] : 'unknown';
    if (mapped !== 'connected') {
      out[spec.id] = { state: mapped, rawStatus: raw, observedPrefix: null };
      continue;
    }
    const suffixes = spec.toolSuffixes;
    const carries = (prefix) => suffixes.length > 0 && suffixes.every((suffix) => tools.includes(prefix + suffix));
    if (carries(spec.toolPrefix)) {
      out[spec.id] = { state: 'connected', rawStatus: raw, observedPrefix: spec.toolPrefix };
      continue;
    }
    const prefixes = new Set(tools.filter((name) => typeof name === 'string' && name.lastIndexOf('__') > 0).map((name) => name.slice(0, name.lastIndexOf('__') + 2)));
    const observedPrefix = [...prefixes].find(carries) ?? null;
    out[spec.id] = { state: 'tools_missing', rawStatus: raw, observedPrefix };
  }
  return out;
}

// The message for one connector's state, for the round's log, doctor and
// the session's status line: the state names the key, the params name the
// connector and what was seen. A tools_missing whose tools were seen under
// another prefix names both prefixes, so a wrong prefix in the vault's
// configuration reads as that and not as an outage.
export function connectorStateMessage(spec, entry) {
  const connector = spec.serverDisplayName;
  if (entry.state === 'unknown') {
    return { messageKey: 'harness.connectors.unknown', params: { connector, status: entry.rawStatus ?? '-' } };
  }
  if (entry.state === 'tools_missing') {
    if (typeof entry.observedPrefix === 'string' && entry.observedPrefix !== spec.toolPrefix) {
      return { messageKey: 'harness.connectors.tools_elsewhere', params: { connector, prefix: spec.toolPrefix, observed: entry.observedPrefix } };
    }
    return { messageKey: 'harness.connectors.tools_missing', params: { connector, prefix: spec.toolPrefix } };
  }
  return { messageKey: `harness.connectors.${entry.state}`, params: { connector } };
}
