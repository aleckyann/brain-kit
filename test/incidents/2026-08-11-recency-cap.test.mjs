// docs/incidents.md, 11/08/2026: the cap threw away exactly the work of the
// day. The cap on how many transcripts to read sorted candidates by path,
// so unrelated projects sorted first and the day's own work was cut. The
// rule then: newest first, the oldest fall off, and the cut is announced.
//
// Final review of phase 2, 24/09/2026 (C1): a cap that cuts the window's
// oldest sessions while the round reads the oldest open days first, and
// advances through all of them, closed those days with none of their
// sessions read. The rule now: the cap takes WHOLE days, oldest first,
// while the distinct files of the days taken stay within
// `curate.caps.transcripts` (a file belongs to every day one of its
// in-window messages falls on); the rest of the days are deferred to the
// next round, the plan's window ends at the last covered day, and a first
// day that alone passes the cap is refused (`overCap`), never cut.
//
// src/sources/transcripts-claude-code.mjs; the round's side is in
// test/curate.test.mjs (the reviewer's reproduction, run end to end).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT, OTHER_PROJECT, TIMEZONE, makeWorld, user } from '../helpers/transcripts-world.mjs';

// 26/09, 27/09 and 28/09/2026 in the vault's zone (UTC-3).
const DAYS = ['2026-09-26', '2026-09-27', '2026-09-28'];
const WINDOW = { from: new Date('2026-09-26T03:00:00.000Z'), to: new Date('2026-09-29T03:00:00.000Z'), days: DAYS, timezone: TIMEZONE };
const MTIME = new Date('2026-09-29T12:00:00.000Z');

// Noon (UTC-3) of `day`, plus `minutes`.
function on(day, minutes = 0) {
  return new Date(Date.parse(`${day}T15:00:00.000Z`) + minutes * 60_000).toISOString();
}

function sessions(world, day, count, tag) {
  const written = [];
  for (let i = 0; i < count; i += 1) {
    written.push(world.write(i % 2 ? PROJECT : OTHER_PROJECT, `${tag}-${String(i).padStart(2, '0')}.jsonl`, [user(`Ana, ${tag} ${i}`, on(day, i))], { mtime: MTIME }));
  }
  return written;
}

test('5 + 10 + 10 sessions with a cap of 20: the first two days are covered whole, the third waits, and the window ends where the covered days end', () => {
  const world = makeWorld({ include: [PROJECT, OTHER_PROJECT], cap: 20 });
  const first = sessions(world, DAYS[0], 5, 'a');
  const second = sessions(world, DAYS[1], 10, 'b');
  sessions(world, DAYS[2], 10, 'c');
  const plan = world.collect(WINDOW);
  assert.deepEqual(plan.daysCovered, ['2026-09-26', '2026-09-27']);
  assert.deepEqual(plan.daysDeferred, ['2026-09-28']);
  assert.equal(plan.overCap, null);
  assert.deepEqual(new Set(plan.files.map((f) => f.path)), new Set([...first, ...second]), 'every session of the covered days, none of the deferred one');
  assert.equal(plan.dropped.byCap, 10);
  assert.equal(plan.window.to, '2026-09-28T03:00:00.000Z', 'the window stops at the start of the deferred day');
  assert.match(plan.promptBlock, /10 transcripts wait for a later round: every message they have in the window falls on 28\/09\/2026/);
});

test('the kept files are listed newest first by their last message, never by name or modification time', () => {
  const world = makeWorld({ include: [PROJECT, OTHER_PROJECT], cap: 20 });
  const written = [];
  for (let i = 0; i < 6; i += 1) {
    // Names sort against recency, and modification times run against it too.
    const name = `${String(99 - i).padStart(2, '0')}.jsonl`;
    written.push(world.write(i % 2 ? PROJECT : OTHER_PROJECT, name, [user(`Ana, session ${i}`, on(DAYS[i % 3], i))], { mtime: new Date(MTIME.getTime() - i * 60_000) }));
  }
  const plan = world.collect(WINDOW);
  const expected = written.map((path, i) => ({ path, at: on(DAYS[i % 3], i) })).sort((a, b) => (a.at < b.at ? 1 : -1)).map((w) => w.path);
  assert.deepEqual(plan.files.map((f) => f.path), expected);
});

test('a file spanning a covered day and a deferred one counts once, and its span holds only its messages on the covered days', () => {
  const world = makeWorld({ cap: 2 });
  const spanning = world.write(PROJECT, 'span.jsonl', [user('Ana starts', on(DAYS[0])), user('Ana goes on', on(DAYS[1], 5))], { mtime: MTIME });
  const firstDay = world.write(PROJECT, 'one.jsonl', [user('Ana alone', on(DAYS[0], 1))], { mtime: MTIME });
  world.write(PROJECT, 'two.jsonl', [user('Ana later', on(DAYS[1], 2))], { mtime: MTIME });
  const plan = world.collect(WINDOW);
  // Day 1 holds span and one (2 files, the cap); day 2 would add two.jsonl.
  assert.deepEqual(plan.daysCovered, ['2026-09-26']);
  assert.deepEqual(plan.daysDeferred, ['2026-09-27', '2026-09-28']);
  assert.deepEqual(new Set(plan.files.map((f) => f.path)), new Set([spanning, firstDay]));
  const span = plan.files.find((f) => f.path === spanning);
  assert.equal(span.lastAt, on(DAYS[0]), 'its message on the deferred day is left for that day\'s round');
  assert.equal(plan.dropped.byCap, 1);

  // With room for three files, the spanning file is counted once over the
  // two days, and the third day (empty) is covered too.
  const roomy = makeWorld({ cap: 3 });
  roomy.write(PROJECT, 'span.jsonl', [user('Ana starts', on(DAYS[0])), user('Ana goes on', on(DAYS[1], 5))], { mtime: MTIME });
  roomy.write(PROJECT, 'one.jsonl', [user('Ana alone', on(DAYS[0], 1))], { mtime: MTIME });
  roomy.write(PROJECT, 'two.jsonl', [user('Ana later', on(DAYS[1], 2))], { mtime: MTIME });
  const all = roomy.collect(WINDOW);
  assert.deepEqual(all.daysCovered, DAYS);
  assert.deepEqual(all.daysDeferred, []);
  assert.equal(all.files.length, 3);
  assert.equal(all.window.to, WINDOW.to.toISOString());
});

test('a first day that alone holds more files than the cap is refused whole: nothing offered, overCap names the day and the count', () => {
  const world = makeWorld({ include: [PROJECT, OTHER_PROJECT], cap: 20 });
  sessions(world, DAYS[0], 25, 'a');
  sessions(world, DAYS[1], 1, 'b');
  const plan = world.collect(WINDOW);
  assert.deepEqual(plan.overCap, { day: '2026-09-26', files: 25 });
  assert.deepEqual(plan.files, []);
  assert.deepEqual(plan.daysCovered, []);
  assert.deepEqual(plan.daysDeferred, DAYS);
  assert.equal(plan.window.to, plan.window.from);
  assert.match(plan.promptBlock, /The day 26\/09\/2026 alone holds 25 transcripts, more than the cap of 20/);
});

test('an empty first day is covered; the over-cap day after it is deferred, not refused', () => {
  const world = makeWorld({ include: [PROJECT, OTHER_PROJECT], cap: 20 });
  sessions(world, DAYS[1], 21, 'b');
  const plan = world.collect(WINDOW);
  assert.equal(plan.overCap, null);
  assert.deepEqual(plan.daysCovered, ['2026-09-26']);
  assert.deepEqual(plan.files, []);
  assert.equal(plan.dropped.byCap, 21);
});

test('under the cap every day is covered, nothing is dropped and the cap is not mentioned', () => {
  const world = makeWorld({ cap: 20 });
  for (let i = 0; i < 3; i += 1) world.write(PROJECT, `${i}.jsonl`, [user(`Ana ${i}`, on(DAYS[i]))], { mtime: MTIME });
  const plan = world.collect(WINDOW);
  assert.equal(plan.files.length, 3);
  assert.deepEqual(plan.daysCovered, DAYS);
  assert.equal(plan.dropped.byCap, 0);
  assert.doesNotMatch(plan.promptBlock, /cap of/);
});

test('a cap of 0 refuses the first day that holds a file, and says so', () => {
  const world = makeWorld({ cap: 0 });
  world.write(PROJECT, 'a.jsonl', [user('Ana', on(DAYS[0]))], { mtime: MTIME });
  const plan = world.collect(WINDOW);
  assert.deepEqual(plan.files, []);
  assert.deepEqual(plan.overCap, { day: '2026-09-26', files: 1 });
  assert.match(plan.promptBlock, /more than the cap of 0/);
});
