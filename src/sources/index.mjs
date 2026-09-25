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
 * @typedef {Object} Source
 * @property {string} id                         key used in config and in the round's report
 * @property {'local'|'connector'} kind
 * @property {boolean} required
 * @property {(record: object, plan: object) => ReadEvidence} readEvidence
 * @property {(args: { window: { from: Date, to: Date }, config: object, machine: object, now?: Date }) => object} collect
 */

export const SOURCE_KINDS = Object.freeze(['local', 'connector']);

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
  return errors;
}
