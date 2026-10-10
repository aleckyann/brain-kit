// docs/incidents.md, 30/09/2026: the model's weekly usage limit ran out. The
// CLI started, printed "You've hit your weekly limit, resets 11am" (with a
// middle dot, in test/fixtures/stream/usage-limit.jsonl) as its only
// assistant text and ended with a result of subtype success, is_error true,
// cost 0 and one turn, then exit 1. The round recorded `model_failed`, a
// failure of the kit, for a limit that lifts on its own at the hour it
// names. The rule: a spent usage limit is postponed on purpose, exit 75,
// `usage_limited`, the reason carrying the hour the limit resets, one
// notification, and no mark moved (the first window after the reset covers
// the day). It is a known cause, so the reason does not say "unknown".
// Its nearest positive cases stay as they were: an expired login is still
// `auth_expired` (a text with both never happens, and auth wins by order),
// and "You have hit a snag" is still `model_failed`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../../src/exit-codes.mjs';
import { USAGE_LIMIT_PATTERNS } from '../../src/commands/curate.mjs';
import { makeCurateWorld, STREAMS, utcDay } from '../helpers/curate-world.mjs';

const COPY = {
  en: { head: /the model's usage limit is spent \(resets 11am\)/, tail: /\. No watermark moved; the first window after the reset resumes\.$/ },
  'pt-BR': { head: /o limite de uso do modelo acabou \(resets 11am\)/, tail: /\. Nenhuma marca d'água andou; a primeira janela depois da liberação retoma\.$/ },
};

function startRound(lang, scenario) {
  const w = makeCurateWorld({ config: (c) => { c.lang = lang; } });
  const before = { transcripts: utcDay(-2) };
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: before }));
  w.scenario({ rewrite: { toolUses: [], finalText: undefined }, ...scenario });
  return { w, before, r: w.curate() };
}

function assertPostponed({ w, before, r }, lang) {
  assert.equal(r.status, EXIT.TEMPFAIL, r.stderr);
  const last = w.lastRun();
  assert.equal(last.exit, EXIT.TEMPFAIL);
  assert.equal(last.reasonCode, 'usage_limited');
  assert.notEqual(last.reasonCode, 'model_failed');
  assert.match(last.reason, COPY[lang].head);
  assert.match(last.reason, COPY[lang].tail);
  assert.equal(last.unknownCause, undefined, 'a spent limit is a known cause');
  assert.equal(last.sources.transcripts.advanced, false);
  assert.doesNotMatch(w.logText(), /Z watermark /, 'the watermark step never ran');
  assert.deepEqual(w.watermark(), before, 'no mark moved');
  assert.deepEqual(w.notifications().map((call) => call.at(-1)), [last.reason], 'notified once, with the reason');
  assert.ok(r.stderr.includes(last.reason), 'the reason is printed');
  assert.match(w.logText(), /"exit":75,"reasonCode":"usage_limited"/);
  assert.equal(w.launches().length, 1, 'the model is launched once, never retried');
  assert.equal(w.ghCalls().filter((call) => call.args[1] === 'create').length, 0);
}

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: the weekly limit of 30/09/2026, said in the result, is exit 75 usage_limited with the reset hour, one notification, the mark untouched`, () => {
    assertPostponed(startRound(lang, { stream: join(STREAMS, 'usage-limit.jsonl'), exitCode: 1 }), lang);
  });

  test(`${lang}: a limit said only on the CLI's standard error, while the result is not an error, is the same postponed round`, () => {
    // The default stream's result is a success; only the stderr tail speaks.
    assertPostponed(startRound(lang, { exitCode: 1, stderr: 'Error: you have hit your usage limit, it resets 11am\n' }), lang);
  });
}

test('nearest positive cases: an expired login is still auth_expired, a plain "hit a snag" is still model_failed', () => {
  const both = startRound('en', { stream: join(STREAMS, 'usage-limit.jsonl'), rewrite: { toolUses: [], finalText: 'Failed to authenticate: you hit your weekly limit' }, exitCode: 1 });
  assert.equal(both.r.status, EXIT.UNAVAILABLE, both.r.stderr);
  assert.equal(both.w.lastRun().reasonCode, 'auth_expired', 'auth wins by order');

  const snag = startRound('en', { stream: join(STREAMS, 'usage-limit.jsonl'), rewrite: { toolUses: [], finalText: 'You have hit a snag' }, exitCode: 1 });
  assert.equal(snag.r.status, EXIT.FAILURE, snag.r.stderr);
  assert.equal(snag.w.lastRun().reasonCode, 'model_failed');
  assert.equal(snag.w.lastRun().unknownCause, true);
});

test('USAGE_LIMIT_PATTERNS: the CLI\'s words match, a word that only looks like them does not', () => {
  const says = (text) => USAGE_LIMIT_PATTERNS.some((re) => re.test(text));
  for (const text of ['You\'ve hit your weekly limit', 'You have hit your limit', 'HIT YOUR SESSION LIMIT', 'Claude usage limit reached', 'Usage Limit']) assert.equal(says(text), true, text);
  for (const text of ['You have hit a snag', 'Failed to authenticate', 'a rate-limit header', 'unlimited plan']) assert.equal(says(text), false, text);
});
