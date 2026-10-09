// incidents.jsonl (spec R6): every round that went wrong, or repaired
// something, leaves one line in the state directory, so a failure is a
// record somebody can read and not only the last-run.json the next round
// overwrites. Unit tests of src/incidents.mjs first, then the rounds that
// write it (the curate world).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT } from '../src/exit-codes.mjs';
import { acquireLock } from '../src/guards/lock.mjs';
import { STATE_FILES } from '../src/state.mjs';
import { appendIncident, incidentFor, openIncidents, pruneIncidents, readIncidents } from '../src/incidents.mjs';
import { makeCurateWorld, note } from './helpers/curate-world.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const AT = '2026-10-09T09:30:00.000Z';

// The part of a round's record an incident is made from.
function round(fields) {
  return { at: AT, exit: EXIT.OK, reasonCode: 'up_to_date', reason: 'Nothing to do.', repairs: [], unknownCause: undefined, ...fields };
}

const file = (dir) => join(dir, STATE_FILES.INCIDENTS);
const linesOf = (dir) => readFileSync(file(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('the state directory names the file', () => {
  assert.equal(STATE_FILES.INCIDENTS, 'incidents.jsonl');
});

test('a round that exits 69 is an incident: the line has exactly the spec shape', () => {
  const entry = incidentFor(round({ exit: EXIT.UNAVAILABLE, reasonCode: 'sync_offline', reason: 'No network.' }));
  assert.deepEqual(entry, { at: AT, exit: 69, reasonCode: 'sync_offline', known: true, reason: 'No network.', repairs: [], closes: false });
});

test('lock_held says nothing new, so it is no incident; lock_unusable, its neighbour, is one', () => {
  assert.equal(incidentFor(round({ exit: EXIT.TEMPFAIL, reasonCode: 'lock_held' })), null);
  const entry = incidentFor(round({ exit: EXIT.USAGE, reasonCode: 'lock_unusable' }));
  assert.equal(entry.reasonCode, 'lock_unusable');
  assert.equal(entry.closes, false);
});

test('an exit 0 that repaired nothing and proved nothing is no incident, whatever the code', () => {
  for (const reasonCode of ['disabled', 'up_to_date', 'nothing_to_curate', 'nothing_available']) {
    assert.equal(incidentFor(round({ reasonCode })), null, reasonCode);
  }
});

test('an exit 0 that made a repair is an incident that closes nothing', () => {
  const repairs = [{ kind: 'index_lock_moved', to: '/x/.git/index.lock.stale-20261009T093000', ageMinutes: 20 }];
  const entry = incidentFor(round({ reasonCode: 'nothing_to_curate', repairs }));
  assert.equal(entry.closes, false);
  assert.deepEqual(entry.repairs, repairs);
  assert.equal(entry.exit, 0);
});

test('a round that ran the model and proposed, or found nothing to propose, closes the open incidents; each is one line even with no repair', () => {
  for (const reasonCode of ['proposed', 'nothing_proposed']) {
    const entry = incidentFor(round({ reasonCode }));
    assert.equal(entry.closes, true, reasonCode);
    assert.equal(entry.exit, 0);
  }
  // The nearest refusal: a repair on a round that proposed is still closing.
  assert.equal(incidentFor(round({ reasonCode: 'proposed', repairs: [{ kind: 'cli_reinstalled', version: '2.1.0' }] })).closes, true);
});

test('known follows the round\'s own record of an unknown cause, never the reason code', () => {
  // The same code can be either: sync_failed carries the kit's own diagnoses as well.
  assert.equal(incidentFor(round({ exit: EXIT.FAILURE, reasonCode: 'model_failed', unknownCause: true })).known, false);
  assert.equal(incidentFor(round({ exit: EXIT.FAILURE, reasonCode: 'sync_failed', unknownCause: true })).known, false);
  assert.equal(incidentFor(round({ exit: EXIT.FAILURE, reasonCode: 'sync_failed' })).known, true);
  assert.equal(incidentFor(round({ exit: EXIT.FAILURE, reasonCode: 'model_failed' })).known, true);
});

test('a round that never set its exit counts as a failure, as finishRound does', () => {
  assert.equal(incidentFor(round({ exit: null, reasonCode: 'internal_error' })).exit, EXIT.FAILURE);
});

test('openIncidents: the non-zero lines newer than the newest closing line', () => {
  const t1 = { at: '2026-10-01T09:30:00.000Z', exit: 69, closes: false };
  const closing = { at: '2026-10-02T09:30:00.000Z', exit: 0, closes: true };
  const t3 = { at: '2026-10-03T09:30:00.000Z', exit: 75, closes: false };
  assert.deepEqual(openIncidents([t1, closing, t3]), [t3]);
  assert.deepEqual(openIncidents([t1, t3]), [t1, t3], 'nothing closed: both are open');
  assert.deepEqual(openIncidents([t1, closing]), [], 'closed: none open');
  assert.deepEqual(openIncidents([]), []);
  // A repair on an exit 0 is a record, not a cause: it is never open.
  const repaired = { at: '2026-10-04T09:30:00.000Z', exit: 0, closes: false, repairs: [{ kind: 'cli_reinstalled' }] };
  assert.deepEqual(openIncidents([t1, repaired]), [t1]);
});

test('readIncidents: no file is an empty record, not a problem', () => {
  const dir = makeTempDir('brain-kit-incidents-');
  assert.deepEqual(readIncidents(dir), { lines: [], corrupt: 0, problem: null });
});

test('readIncidents: a corrupt line in the middle is skipped and counted, the lines around it are kept', () => {
  const dir = makeTempDir('brain-kit-incidents-');
  const a = { at: '2026-10-01T09:30:00.000Z', exit: 69 };
  const b = { at: '2026-10-02T09:30:00.000Z', exit: 75 };
  writeFileSync(file(dir), `${JSON.stringify(a)}\n{"at": "2026-10-01\n\nnull\n[1]\n${JSON.stringify(b)}\n`);
  const read = readIncidents(dir);
  assert.deepEqual(read.lines, [a, b]);
  assert.equal(read.corrupt, 3, 'the cut line, the null and the array; the blank line is not a record');
  assert.equal(read.problem, null);
});

test('readIncidents: a read error other than a missing file is a problem named by its code, never a throw', () => {
  const dir = makeTempDir('brain-kit-incidents-');
  mkdirSync(file(dir));
  const read = readIncidents(dir);
  assert.deepEqual(read.lines, []);
  assert.equal(read.corrupt, 0);
  assert.equal(read.problem, 'EISDIR');
});

test('appendIncident writes one line, mode 0600 on creation, and appends the next', () => {
  const dir = makeTempDir('brain-kit-incidents-');
  appendIncident(dir, { at: AT, exit: 69 });
  appendIncident(dir, { at: AT, exit: 75 });
  assert.deepEqual(linesOf(dir), [{ at: AT, exit: 69 }, { at: AT, exit: 75 }]);
  if (process.platform !== 'win32') assert.equal(statSync(file(dir)).mode & 0o777, 0o600);
});

test('pruneIncidents drops the line 31 days old and keeps the one 29 days old', () => {
  const dir = makeTempDir('brain-kit-incidents-');
  const now = new Date('2026-10-09T12:00:00.000Z');
  const old = { at: new Date(now.getTime() - 31 * DAY_MS).toISOString(), exit: 69 };
  const recent = { at: new Date(now.getTime() - 29 * DAY_MS).toISOString(), exit: 75 };
  writeFileSync(file(dir), `${JSON.stringify(old)}\nnot json\n${JSON.stringify(recent)}\n`);
  pruneIncidents(dir, { now, retentionDays: 30 });
  assert.deepEqual(linesOf(dir), [recent], 'the old line and the corrupt one are gone');
  assert.equal(readFileSync(file(dir), 'utf8').endsWith('\n'), true);
  if (process.platform !== 'win32') assert.equal(statSync(file(dir)).mode & 0o777, 0o600);
  // The retention is the machine's: 20 days drops the 29-day-old line too.
  pruneIncidents(dir, { now, retentionDays: 20 });
  assert.deepEqual(linesOf(dir), []);
});

test('pruneIncidents with nothing to drop leaves the file as it is, and with no file does nothing', () => {
  const dir = makeTempDir('brain-kit-incidents-');
  const now = new Date('2026-10-09T12:00:00.000Z');
  pruneIncidents(dir, { now, retentionDays: 30 });
  assert.throws(() => statSync(file(dir)), { code: 'ENOENT' });
  const text = `${JSON.stringify({ at: now.toISOString(), exit: 69 })}\n`;
  writeFileSync(file(dir), text);
  const before = statSync(file(dir)).ino;
  pruneIncidents(dir, { now, retentionDays: 30 });
  assert.equal(readFileSync(file(dir), 'utf8'), text);
  assert.equal(statSync(file(dir)).ino, before, 'not rewritten');
});

test('pruneIncidents on a file it cannot read says so by throwing, for the round to log', () => {
  const dir = makeTempDir('brain-kit-incidents-');
  mkdirSync(file(dir));
  assert.throws(() => pruneIncidents(dir, { now: new Date(), retentionDays: 30 }), /EISDIR/);
});

test('two processes appending 200 lines each at once leave 400 whole lines (Review Focus 1)', async () => {
  const dir = makeTempDir('brain-kit-incidents-');
  const module = pathToFileURL(join(import.meta.dirname, '..', 'src', 'incidents.mjs')).href;
  const script = `
    import { appendIncident } from ${JSON.stringify(module)};
    const [dir, id] = process.argv.slice(1);
    const reason = 'x'.repeat(2000);
    for (let i = 0; i < 200; i += 1) appendIncident(dir, { at: '2026-10-09T09:30:00.000Z', exit: 69, id, i, reason });
  `;
  const run = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, id], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`child ${id} exited ${code}: ${stderr}`))));
  });
  await Promise.all([run('a'), run('b')]);
  const read = readIncidents(dir);
  assert.equal(read.corrupt, 0);
  assert.equal(read.lines.length, 400);
  for (const id of ['a', 'b']) {
    assert.deepEqual(read.lines.filter((l) => l.id === id).map((l) => l.i), Array.from({ length: 200 }, (_, i) => i), `${id}: every line, in order`);
  }
});

// The rounds that write it.

test('a dirty tree (75) leaves one line; the next round that proposes closes it', () => {
  const w = makeCurateWorld();
  writeFileSync(join(w.vault, 'draft.md'), 'draft\n');
  const r = w.curate();
  assert.equal(r.status, EXIT.TEMPFAIL, r.stderr);
  const first = readIncidents(w.state);
  assert.equal(first.lines.length, 1);
  assert.equal(first.lines[0].reasonCode, 'dirty_tree');
  assert.equal(first.lines[0].exit, EXIT.TEMPFAIL);
  assert.equal(first.lines[0].known, true);
  assert.equal(first.lines[0].closes, false);
  assert.equal(first.lines[0].reason, w.lastRun().reason, 'the line says what the notification said');
  assert.equal(first.lines[0].at, w.lastRun().at);
  assert.equal(openIncidents(first.lines).length, 1);
  if (process.platform !== 'win32') assert.equal(statSync(join(w.state, STATE_FILES.INCIDENTS)).mode & 0o777, 0o600);

  rmSync(join(w.vault, 'draft.md'));
  w.scenario({ actions: [{ write: { path: 'notes/meeting.md', content: note('Meeting') } }, w.proposeAction('notes/meeting.md')] });
  const clean = w.curate();
  assert.equal(clean.status, EXIT.OK, clean.stderr);
  assert.equal(w.lastRun().reasonCode, 'proposed');
  const read = readIncidents(w.state);
  assert.equal(read.lines.length, 2);
  assert.equal(read.lines[1].reasonCode, 'proposed');
  assert.equal(read.lines[1].exit, 0);
  assert.equal(read.lines[1].closes, true);
  assert.deepEqual(openIncidents(read.lines), []);
});

test('--check writes no line, where the same round without it writes one', () => {
  const w = makeCurateWorld();
  writeFileSync(join(w.vault, 'draft.md'), 'draft\n');
  const checked = w.curate(['--check']);
  assert.equal(checked.status, EXIT.TEMPFAIL, checked.stderr);
  assert.deepEqual(readIncidents(w.state), { lines: [], corrupt: 0, problem: null });
  w.curate();
  assert.equal(readIncidents(w.state).lines.length, 1);
});

test('a round that finds nothing wrong leaves no line', () => {
  const w = makeCurateWorld();
  w.scenario({ actions: [{ write: { path: 'notes/meeting.md', content: note('Meeting') } }, w.proposeAction('notes/meeting.md')] });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  // The first round is a proposing one, which closes: it is the one line, with nothing before it to close.
  assert.deepEqual(readIncidents(w.state).lines.map((l) => [l.reasonCode, l.closes]), [['proposed', true]]);
  // The second finds the day already read: exit 0, nothing proved, nothing recorded.
  const again = w.curate();
  assert.equal(again.status, EXIT.OK, again.stderr);
  assert.equal(readIncidents(w.state).lines.length, 1);
});

test('a lock held by a live process leaves no line; a lock that cannot be used leaves one, unless the run is --dry or --check', () => {
  const w = makeCurateWorld();
  const held = acquireLock(w.vault, { command: 'sync', env: w.env });
  try {
    const r = w.curate();
    assert.equal(r.status, EXIT.TEMPFAIL, r.stderr);
    assert.equal(w.lastRun().reasonCode, 'lock_held');
  } finally {
    held.release();
  }
  assert.deepEqual(readIncidents(w.state), { lines: [], corrupt: 0, problem: null });

  rmSync(join(w.vault, '.git'), { recursive: true, force: true });
  // --dry and --check change nothing a person reads later: a false open incident would outlive them.
  w.curate(['--dry']);
  assert.deepEqual(readIncidents(w.state), { lines: [], corrupt: 0, problem: null }, '--dry');
  const checked = w.curate(['--check']);
  assert.equal(checked.status, EXIT.USAGE, checked.stderr);
  assert.equal(w.lastRun().reasonCode, 'lock_unusable', 'the same refusal the plain run records');
  assert.deepEqual(readIncidents(w.state), { lines: [], corrupt: 0, problem: null }, '--check');
  const unusable = w.curate();
  assert.equal(unusable.status, EXIT.USAGE, unusable.stderr);
  const { lines } = readIncidents(w.state);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reasonCode, 'lock_unusable');
  assert.equal(lines[0].exit, EXIT.USAGE);
});

test('a machine.json that cannot be read leaves one line, with the shape of any other; --dry and --check leave none', () => {
  const w = makeCurateWorld();
  writeFileSync(w.machineFile, '{ not json\n');
  const dry = w.curate(['--dry']);
  assert.equal(dry.status, EXIT.USAGE, dry.stderr);
  assert.deepEqual(readIncidents(w.state), { lines: [], corrupt: 0, problem: null }, '--dry');
  // The rollout proves machine.json with --check: a typo there must not be an open incident.
  const checked = w.curate(['--check']);
  assert.equal(checked.status, EXIT.USAGE, checked.stderr);
  assert.deepEqual(readIncidents(w.state), { lines: [], corrupt: 0, problem: null }, '--check');
  const r = w.curate();
  assert.equal(r.status, EXIT.USAGE, r.stderr);
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'machine_invalid');
  assert.deepEqual(readIncidents(w.state).lines, [{ at: last.at, exit: EXIT.USAGE, reasonCode: 'machine_invalid', known: true, reason: last.reason, repairs: [], closes: false }]);
});

test('an incidents file that cannot be written never changes the round\'s exit, and the log says so', () => {
  const w = makeCurateWorld();
  writeFileSync(join(w.vault, 'draft.md'), 'draft\n');
  mkdirSync(join(w.state, STATE_FILES.INCIDENTS));
  const r = w.curate();
  assert.equal(r.status, EXIT.TEMPFAIL, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'dirty_tree');
  assert.match(w.logText(), /incident_not_written \{"error":"EISDIR"\}/);
  assert.match(w.logText(), /incidents_not_pruned/);
});

// Lines `days` old, written as an earlier round would have.
function seed(w, ...days) {
  const lines = days.map((d) => ({ at: new Date(Date.now() - d * DAY_MS).toISOString(), exit: 69, reasonCode: 'sync_offline', known: true, reason: `${d} days ago`, repairs: [], closes: false }));
  writeFileSync(join(w.state, STATE_FILES.INCIDENTS), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
}

test('a round that holds the lock prunes the lines older than log_retention_days (30 by default), after it appends its own', () => {
  const w = makeCurateWorld();
  seed(w, 31, 29);
  writeFileSync(join(w.vault, 'draft.md'), 'draft\n');
  w.curate();
  assert.deepEqual(readIncidents(w.state).lines.map((l) => l.reason.slice(0, 11)), ['29 days ago', w.lastRun().reason.slice(0, 11)]);

  const shorter = makeCurateWorld({ machine: { log_retention_days: 10 } });
  seed(shorter, 12, 5);
  writeFileSync(join(shorter.vault, 'draft.md'), 'draft\n');
  shorter.curate();
  assert.deepEqual(readIncidents(shorter.state).lines.map((l) => l.reason.slice(0, 10)), ['5 days ago', shorter.lastRun().reason.slice(0, 10)], 'the machine\'s own retention');
});

test('a round with no lock only appends: it prunes nothing', () => {
  const w = makeCurateWorld();
  seed(w, 31);
  rmSync(join(w.vault, '.git'), { recursive: true, force: true });
  w.curate();
  assert.deepEqual(readIncidents(w.state).lines.map((l) => l.reasonCode), ['sync_offline', 'lock_unusable']);
});
