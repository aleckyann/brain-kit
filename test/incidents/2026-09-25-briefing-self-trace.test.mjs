// Phase 4, decision B6: the briefing's own sessions never reach the
// curator. The morning briefing runs in the person's own session, in a
// project the transcripts source includes, and what it records it proposes
// itself (`propose --only`). Had the curator read those sessions, the next
// round would capture the briefing's own questions and summaries as new
// facts of the person's day, a second time.
//
// The rule: src/sources/transcripts-claude-code.mjs counts
// `briefing.signature` among the signatures of the kit's own runs ALWAYS,
// alongside `curate.signature` and `curate.extra_signatures`, whatever the
// person lists there; a session whose first user message starts with it is
// dropped as `selfTrace`. The 11/08/2026 rule still holds: only the FIRST
// user message counts, so a human session that quotes the signature later
// stays in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSIDE, PROJECT, assistant, customTitle, makeWorld, paths, user } from '../helpers/transcripts-world.mjs';

const LATER = '2026-09-23T15:00:00.000Z';

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: a briefing session is dropped by its first user line, with extra_signatures empty`, () => {
    const world = makeWorld({ lang, extraSignatures: [] });
    const signature = world.config.briefing.signature;
    assert.equal(typeof signature, 'string');
    assert.notEqual(signature.trim(), '');
    assert.deepEqual(world.config.curate.extra_signatures, []);
    world.write(PROJECT, 'briefing.jsonl', [customTitle(), user(`${signature}\n\nToday is 23/09/2026.`, INSIDE), assistant('Good morning, Ana.', LATER)]);
    const human = world.write(PROJECT, 'ana.jsonl', [user('Ana asks about the budget', INSIDE)]);
    const plan = world.collect();
    assert.deepEqual(paths(plan), [human]);
    assert.equal(plan.dropped.selfTrace, 1);
  });

  test(`${lang}: a human session that quotes the briefing signature later stays in`, () => {
    const world = makeWorld({ lang, extraSignatures: [] });
    const signature = world.config.briefing.signature;
    const quoting = world.write(PROJECT, 'ana.jsonl', [
      user('Ana wants to change what the morning message says', INSIDE),
      assistant(`The briefing prompt starts with "${signature}".`, LATER),
      user(`${signature}: why does it start like this?`, LATER),
    ]);
    const plan = world.collect();
    assert.deepEqual(paths(plan), [quoting]);
    assert.equal(plan.dropped.selfTrace, 0);
  });
}

test('a blank briefing signature drops nothing', () => {
  const world = makeWorld({ extraSignatures: [] });
  for (const blank of ['', '   ']) {
    world.config.briefing.signature = blank;
    const file = world.write(PROJECT, `ana-${blank.length}.jsonl`, [user('Ana asks', INSIDE)]);
    assert.ok(paths(world.collect()).includes(file), JSON.stringify(blank));
  }
});

test('the curator\'s own signature still drops its runs next to the briefing\'s', () => {
  const world = makeWorld({ extraSignatures: [] });
  world.write(PROJECT, 'round.jsonl', [user(`${world.config.curate.signature}\nWindow: 23/09/2026.`, INSIDE)]);
  world.write(PROJECT, 'briefing.jsonl', [user(`${world.config.briefing.signature}\nToday.`, INSIDE)]);
  const human = world.write(PROJECT, 'ana.jsonl', [user('Ana asks', INSIDE)]);
  const plan = world.collect();
  assert.deepEqual(paths(plan), [human]);
  assert.equal(plan.dropped.selfTrace, 2);
  assert.match(plan.promptBlock, /2 transcripts left out as the curator's own runs or the briefing's/);
});
