// Did the round read its sources? docs/incidents.md, 20/08/2026: a round
// declared "no curation today" without reading anything, exited 0 and
// closed the day in the high water mark. The answer is never the model's
// word: each source measures it on the round record (tool uses and their
// results, src/harness/stream.mjs) against the plan it handed the model,
// through its own `readEvidence(record, plan)`. This module only asks every
// source and refuses to let a malformed or failing answer count as read.
//
//   evidenceFor(sources, plans, record) -> { [id]: { read, expected, ok } }
//
// `plans` is `{ [id]: plan }` from each source's `collect`. A source with no
// plan, whose readEvidence throws, or whose answer is not two non-negative
// integers and a boolean, is `{ read: 0, expected: null, ok: false }`:
// `expected: null` is never 0, so a broken answer can never pass for an
// empty window either (src/guards/watermark.mjs, the vacuous advance).
// `record` may be null (no model ran: the empty window path); the sources
// then see a record with no tool use at all.

const EMPTY_RECORD = Object.freeze({ toolUses: [], toolResults: [], denials: [], result: null });
const UNREAD = Object.freeze({ read: 0, expected: null, ok: false });

function isCount(n) {
  return Number.isInteger(n) && n >= 0;
}

function evidenceOf(source, plan, record) {
  if (plan === null || typeof plan !== 'object') return { ...UNREAD };
  let answer;
  try {
    answer = source.readEvidence(record, plan);
  } catch {
    return { ...UNREAD };
  }
  if (answer === null || typeof answer !== 'object' || !isCount(answer.read) || !isCount(answer.expected) || typeof answer.ok !== 'boolean') {
    return { ...UNREAD };
  }
  return { read: answer.read, expected: answer.expected, ok: answer.ok };
}

export function evidenceFor(sources, plans, record) {
  const round = record ?? EMPTY_RECORD;
  const result = {};
  for (const source of sources) {
    const plan = plans !== null && typeof plans === 'object' && Object.hasOwn(plans, source.id) ? plans[source.id] : null;
    result[source.id] = evidenceOf(source, plan, round);
  }
  return result;
}

// The ids in `requiredIds` whose evidence is missing or not ok: a round with
// any exits 4 (src/exit-codes.mjs, SOURCE_UNREAD).
export function unreadRequired(evidence, requiredIds) {
  return requiredIds.filter((id) => !(evidence !== null && typeof evidence === 'object' && evidence[id]?.ok === true));
}
