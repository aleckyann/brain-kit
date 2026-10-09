// incidents.jsonl in the state directory: one JSON line for every round that
// went wrong or repaired something, so a failure outlives the last-run.json
// the next round overwrites and the briefing can say what is still open
// (spec R6, docs/superpowers/specs/2026-10-09-round-repairs-and-incidents-
// design.md).
//
// Append-only while the round runs: one appendFileSync of one line, which the
// kernel adds at the end whatever another process is doing, so two writers
// (the round, and a refusal that holds no lock) never interleave. The only
// rewrite is pruneIncidents, and only a round holding the vault lock calls it.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from './exit-codes.mjs';
import { STATE_FILES, writePrivate } from './state.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

// The reason codes of a round that reached the model and finished: only
// these prove the causes before them are gone. `up_to_date`, `disabled`,
// `nothing_to_curate` and `nothing_available` never reach the model.
const CLOSING = new Set(['proposed', 'nothing_proposed']);

// The incident a round's record makes, or null when the round says nothing
// worth keeping. `known` is the round's own word that it explained the cause
// (`unknownCause`, set where the explanation is written), not a list of codes:
// `sync_failed` carries the kit's own diagnoses as well as the unexplained.
export function incidentFor(run) {
  const exit = run.exit ?? EXIT.FAILURE;
  const repairs = run.repairs ?? [];
  const closes = CLOSING.has(run.reasonCode);
  if (run.reasonCode === 'lock_held') return null;
  if (exit === EXIT.OK && !closes && repairs.length === 0) return null;
  return { at: run.at, exit, reasonCode: run.reasonCode, known: run.unknownCause !== true, reason: run.reason, repairs, closes };
}

const fileOf = (stateDir) => join(stateDir, STATE_FILES.INCIDENTS);

export function appendIncident(stateDir, entry) {
  appendFileSync(fileOf(stateDir), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

// Every line that is a JSON object, in the order written; a line that is
// not one (a write cut short, a hand edit) is counted, never raised. A file
// that is not there is an empty record; any other read error is a `problem`
// named by its code.
export function readIncidents(stateDir) {
  let text;
  try {
    text = readFileSync(fileOf(stateDir), 'utf8');
  } catch (error) {
    return { lines: [], corrupt: 0, problem: error.code === 'ENOENT' ? null : (error.code ?? error.message) };
  }
  const lines = [];
  let corrupt = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const entry = JSON.parse(raw);
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) lines.push(entry);
      else corrupt += 1;
    } catch {
      corrupt += 1;
    }
  }
  return { lines, corrupt, problem: null };
}

// The incidents nobody has closed: the lines after the newest closing one
// (their order in the file is the order the rounds ended in), minus the
// exit-0 repairs, which are a record and not a cause.
export function openIncidents(lines) {
  const last = lines.findLastIndex((line) => line.closes === true);
  return lines.slice(last + 1).filter((line) => line.exit !== 0);
}

// Rewrites the file without the lines older than `retentionDays` and the
// ones that are not records. Not rewritten when nothing would change, so a
// round that has nothing to prune cannot lose a line a lock-less refusal
// appended meanwhile. A file that cannot be read is raised, for the round to log.
export function pruneIncidents(stateDir, { now, retentionDays }) {
  const { lines, corrupt, problem } = readIncidents(stateDir);
  if (problem !== null) throw new Error(`${STATE_FILES.INCIDENTS}: ${problem}`);
  const limit = new Date(now).getTime() - retentionDays * DAY_MS;
  const kept = lines.filter((line) => Date.parse(line.at) >= limit);
  if (kept.length === lines.length && corrupt === 0) return;
  writePrivate(fileOf(stateDir), kept.map((line) => `${JSON.stringify(line)}\n`).join(''));
}
