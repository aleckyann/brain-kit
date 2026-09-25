// The source interface every input of a curation round implements.
//
// A source answers two questions for `curate`: before the model runs,
// what is there to read in the window (`collect`, which returns a plan
// with a prompt block the round hands to the model); and after the model
// ran, whether it actually read it (`readEvidence`, measured on the round
// record, never on the model's own report). The second question is the
// one the 20/08/2026 incident paid for: a round may not close a day as
// swept on the agent's exit code alone.
//
// `kind` says where the reading happens: 'local' for files on this
// machine the kit can list itself (transcripts), 'connector' for a remote
// service reached only through the model's tools (calendar, documents).
// `required` is the source's own default; the vault's configuration
// (`curate.sources.required` / `best_effort`) decides for a given round.
//
// Optional members (phase 3, the connector sources):
//   - `emptyMeansNothingListed`, true when absent: the phase 2 rule for a
//     source the model reports `empty`, which counts only when the plan
//     offered nothing (evidence.expected === 0). A source whose plan never
//     offers nothing while it is on (the calendar plans one listing per
//     calendar, and an empty day is a listing with no events) sets it to
//     false: for it, nothing to read is itself a reading to prove.
//   - `isConfigured(config)`: whether the vault named what the source reads;
//     a connector source is off until it did (decision D6).
//   - `serverSpec(config)`: the connector the source reads through, in the
//     shape src/guards/connectors.mjs takes. Connector sources only, and
//     every connector source has one.
//   - `toolRules(config)`: the permission rules the source asks the round
//     for, its read tools allowed and its connector's write tools denied.
//     Connector sources only, and every connector source has one.

/**
 * @typedef {Object} ReadEvidence
 * @property {number} read      items of the plan the round record shows as read
 * @property {number} expected  items the plan offered
 * @property {boolean} ok       whether the source counts as read for this round
 */

/**
 * One entry of the round record's `toolResults`, as `readEvidence` sees it
 * (src/harness/stream.mjs; rulings R-B3 and I2 of 25/09/2026). A connector
 * source must treat a result with `complete === false` as a failed call,
 * the same as `isError`: the model saw only part of it (cut, previewed or
 * followed by a notice), so neither its content nor the absence of a next
 * page can be trusted. `hasNextPage` is read only from a complete result.
 * @typedef {Object} ToolResult
 * @property {string} toolUseId     the tool_use this answers
 * @property {boolean} isError      the CLI reported the call as an error
 * @property {boolean} complete     the result's text parses as one JSON document
 * @property {boolean} hasNextPage  that document's top-level nextPageToken is a non-empty string
 */

/**
 * @typedef {Object} ServerSpec
 * @property {string} id                 the source's id
 * @property {string} serverDisplayName  the server's name in the init event's mcp_servers
 * @property {string} toolPrefix         the prefix of its tools, e.g. mcp__claude_ai_<Server>__
 * @property {string[]} toolSuffixes     the tools the source needs, without the prefix
 */

/**
 * @typedef {Object} Source
 * @property {string} id                         key used in config and in the round's report
 * @property {'local'|'connector'} kind
 * @property {boolean} required
 * @property {(record: object, plan: object) => ReadEvidence} readEvidence
 * @property {(args: { window: { from: Date, to: Date, days?: string[], timezone?: string }, config: object, machine?: object, now?: Date }) => object} collect
 * @property {boolean} [emptyMeansNothingListed]  default true
 * @property {(config: object) => boolean} [isConfigured]
 * @property {(config: object) => ServerSpec} [serverSpec]                       connector sources
 * @property {(config: object) => { allow: string[], deny: string[] }} [toolRules] connector sources
 */

export const SOURCE_KINDS = Object.freeze(['local', 'connector']);

const OPTIONAL_FUNCTIONS = Object.freeze(['isConfigured', 'serverSpec', 'toolRules']);
const CONNECTOR_FUNCTIONS = Object.freeze(['serverSpec', 'toolRules']);

// Errors, one string each, for an object that does not implement the
// interface; an empty list when it does.
export function validateSource(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return ['source: must be an object'];
  const errors = [];
  if (typeof obj.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(obj.id)) {
    errors.push('source.id: must be a lower case identifier');
  }
  if (!SOURCE_KINDS.includes(obj.kind)) errors.push(`source.kind: must be one of ${SOURCE_KINDS.join(', ')}`);
  if (typeof obj.required !== 'boolean') errors.push('source.required: must be a boolean');
  if (typeof obj.collect !== 'function') errors.push('source.collect: must be a function');
  if (typeof obj.readEvidence !== 'function') errors.push('source.readEvidence: must be a function');
  if (obj.emptyMeansNothingListed !== undefined && typeof obj.emptyMeansNothingListed !== 'boolean') {
    errors.push('source.emptyMeansNothingListed: must be a boolean when present');
  }
  for (const member of OPTIONAL_FUNCTIONS) {
    const required = obj.kind === 'connector' && CONNECTOR_FUNCTIONS.includes(member);
    if (typeof obj[member] === 'function' || (obj[member] === undefined && !required)) continue;
    errors.push(`source.${member}: must be a function${required ? ' in a connector source' : ' when present'}`);
  }
  return errors;
}
