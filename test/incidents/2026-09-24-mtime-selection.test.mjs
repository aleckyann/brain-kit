// docs/incidents.md, 24/09/2026: selection by modification time turned an
// old session into a new fact. A session file touched again weeks after
// its last message was selected by its mtime, and the round wrote it up as
// new, twice. The rule: select by the timestamps of the messages inside
// the window; modification time is only a pre-filter.
//
// Phase 2 (this file): src/sources/transcripts-claude-code.mjs opens every
// candidate whose mtime is not before the window's start and keeps it only
// when one of its messages falls inside [from, to).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MTIME_SLACK_MS } from '../../src/sources/transcripts-claude-code.mjs';
import {
  FROM, NOW, PROJECT, WEEKS_AGO, assistant, customTitle, lastPrompt, makeWorld, paths, user,
} from '../helpers/transcripts-world.mjs';

test('a file touched today whose messages are all from weeks ago stays out', () => {
  const world = makeWorld();
  world.write(PROJECT, 'old.jsonl', [
    user('Ana planned the quarter', WEEKS_AGO),
    assistant('noted', WEEKS_AGO),
    customTitle(),
    lastPrompt(),
  ], { mtime: NOW });
  const plan = world.collect();
  assert.deepEqual(plan.files, []);
  assert.equal(plan.dropped.outOfWindow, 1);
  assert.equal(plan.dropped.unreadable, 0);
});

test('a file whose last message is inside the window comes in though its mtime is older than a touched one', () => {
  const world = makeWorld();
  const early = new Date(Date.parse(FROM.toISOString()) + 60 * 60_000);
  const inWindow = world.write(PROJECT, 'day.jsonl', [
    user('Ana decided the pricing', WEEKS_AGO),
    user('Ana came back to it', early.toISOString()),
  ], { mtime: early });
  world.write(PROJECT, 'touched.jsonl', [user('Ana, weeks ago', WEEKS_AGO)], { mtime: NOW });
  const plan = world.collect();
  assert.deepEqual(paths(plan), [inWindow]);
  assert.equal(plan.files[0].firstAt, early.toISOString());
  assert.equal(plan.files[0].lastAt, early.toISOString());
});

test('the order of the kept files follows their last message, not their mtime', () => {
  const world = makeWorld();
  const recentMessage = world.write(PROJECT, 'a.jsonl', [user('Ana, late', '2026-09-23T22:00:00.000Z')], { mtime: '2026-09-23T22:00:00.000Z' });
  const touchedLater = world.write(PROJECT, 'b.jsonl', [user('Ana, early', '2026-09-23T05:00:00.000Z')], { mtime: NOW });
  const plan = world.collect();
  assert.deepEqual(paths(plan), [recentMessage, touchedLater]);
});

test('mtime is only a pre-filter: a file last modified well before the window opened is not opened, and is counted as such', () => {
  // On one clock a transcript cannot hold a message written after its own
  // mtime; this fixture forces it to show the file is skipped on mtime
  // alone, and that the count says "not opened", not "no message".
  const world = makeWorld();
  world.write(PROJECT, 'rewound.jsonl', [user('Ana', '2026-09-23T10:00:00.000Z')], { mtime: new Date(FROM.getTime() - MTIME_SLACK_MS - 1000) });
  const plan = world.collect();
  assert.deepEqual(plan.files, []);
  assert.equal(plan.dropped.modifiedBeforeWindow, 1);
  assert.equal(plan.dropped.outOfWindow, 0);
  assert.match(plan.promptBlock, /1 transcripts? not opened because they were last modified before the window opened/);
  assert.doesNotMatch(plan.promptBlock, /no message falls inside the window/);
});

test('the pre-filter leaves a margin for a clock that is behind: an mtime just before the window still opens the file', () => {
  const world = makeWorld();
  const skewed = world.write(PROJECT, 'skewed.jsonl', [user('Ana', '2026-09-23T10:00:00.000Z')], { mtime: new Date(FROM.getTime() - MTIME_SLACK_MS + 60_000) });
  const plan = world.collect();
  assert.deepEqual(paths(plan), [skewed]);
  assert.equal(MTIME_SLACK_MS, 15 * 60 * 1000);
});
