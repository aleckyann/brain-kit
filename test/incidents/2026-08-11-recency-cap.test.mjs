// docs/incidents.md, 11/08/2026: the cap threw away exactly the work of the
// day. The cap on how many transcripts to read sorted candidates by path,
// so unrelated projects sorted first and the day's own work was cut. The
// rule: newest first, the oldest fall off, and the cut is announced.
//
// Phase 2 (this file): src/sources/transcripts-claude-code.mjs sorts the
// kept files by the time of their last message inside the window (not by
// path, and not by modification time: see the 24/09/2026 incident), keeps
// `curate.caps.transcripts` of them, counts the rest in `dropped.byCap`
// and says so in the prompt block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT, OTHER_PROJECT, makeWorld, user } from '../helpers/transcripts-world.mjs';

function at(minutes) {
  return new Date(Date.parse('2026-09-23T04:00:00.000Z') + minutes * 60_000);
}

test('25 candidates with a cap of 20 keep the 20 newest by last message and announce the other 5', () => {
  const world = makeWorld({ include: [PROJECT, OTHER_PROJECT], cap: 20 });
  const written = [];
  for (let i = 0; i < 25; i += 1) {
    // Names sort in the opposite order of recency, and modification times
    // run against it too, so neither a path sort nor an mtime sort can
    // pass this test by accident.
    const name = `${String(99 - i).padStart(2, '0')}.jsonl`;
    const last = at(i * 30);
    const project = i % 2 ? PROJECT : OTHER_PROJECT;
    const path = world.write(project, name, [user(`Ana, session ${i}`, last.toISOString())], { mtime: at(24 * 60 - i) });
    written.push({ path, last });
  }
  const plan = world.collect();
  const newest = written.slice(5).reverse().map((w) => w.path);
  assert.deepEqual(plan.files.map((f) => f.path), newest);
  assert.equal(plan.dropped.byCap, 5);
  assert.match(plan.promptBlock, /5 transcripts left out by the cap of 20/);
});

test('under the cap nothing is dropped and the cap is not mentioned', () => {
  const world = makeWorld({ cap: 20 });
  for (let i = 0; i < 3; i += 1) world.write(PROJECT, `${i}.jsonl`, [user(`Ana ${i}`, at(i).toISOString())]);
  const plan = world.collect();
  assert.equal(plan.files.length, 3);
  assert.equal(plan.dropped.byCap, 0);
  assert.doesNotMatch(plan.promptBlock, /cap of/);
});

test('a cap of 0 keeps nothing and says so', () => {
  const world = makeWorld({ cap: 0 });
  world.write(PROJECT, 'a.jsonl', [user('Ana', at(1).toISOString())]);
  const plan = world.collect();
  assert.deepEqual(plan.files, []);
  assert.equal(plan.dropped.byCap, 1);
  assert.match(plan.promptBlock, /1 transcripts? left out by the cap of 0/);
});
