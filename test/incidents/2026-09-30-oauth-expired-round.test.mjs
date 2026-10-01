// docs/incidents.md, 30/09/2026: the Claude Code login had expired. The CLI
// started, printed "Failed to authenticate: OAuth session expired and could
// not be refreshed" as its only assistant text and ended with a result of
// subtype success, is_error true, cost 0 and one turn, then exit 1. The
// round recorded `model_failed` with "-" for its detail: the CLI's text was
// lost and nothing told the person what to do, so unattended the round
// would have failed the same way for days. The rule: an unattended round
// says why it stopped. An expired login is exit 69, `auth_expired`, with
// the CLI's own text and what to do (log in again with /login) in the
// vault's language, one notification, and no mark moved.
// test/fixtures/stream/auth-expired.jsonl replays the stream's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../../src/exit-codes.mjs';
import { makeCurateWorld, STREAMS, utcDay } from '../helpers/curate-world.mjs';

const SAID = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const WHAT_TO_DO = {
  en: [/the Claude Code login has expired/, /Run claude in a terminal and log in again with \/login\./, /The day is not lost: no watermark moved/],
  'pt-BR': [/o login do Claude Code expirou/, /Rode claude num terminal e entre de novo com \/login\./, /O dia não está perdido: nenhuma marca d'água andou/],
};

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: the expired login of 30/09/2026 is exit 69 auth_expired, its reason carries the CLI's text and what to do, one notification, the mark untouched`, () => {
    const w = makeCurateWorld({ config: (c) => { c.lang = lang; } });
    const before = { transcripts: utcDay(-2) };
    writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: before }));
    writeFileSync(join(w.state, 'last-run.json'), `${JSON.stringify({ at: '2026-09-29T12:30:00.000Z', exit: 0, reasonCode: 'nothing_proposed' })}\n`);
    w.scenario({ stream: join(STREAMS, 'auth-expired.jsonl'), rewrite: { toolUses: [], finalText: undefined }, exitCode: 1 });

    const r = w.curate();
    assert.equal(r.status, EXIT.UNAVAILABLE, r.stderr);
    const last = w.lastRun();
    assert.notEqual(last.at, '2026-09-29T12:30:00.000Z', 'last-run.json is this round\'s');
    assert.equal(last.exit, EXIT.UNAVAILABLE);
    assert.equal(last.reasonCode, 'auth_expired');
    assert.notEqual(last.reasonCode, 'model_failed');
    assert.ok(last.reason.includes(`(${lang === 'en' ? 'the CLI said' : 'o CLI disse'}: ${SAID})`), last.reason);
    for (const pattern of WHAT_TO_DO[lang]) assert.match(last.reason, pattern);
    assert.doesNotMatch(last.reason, /: -$/);
    assert.equal(last.costUsd, 0);
    assert.equal(last.numTurns, 1);
    assert.equal(last.isolation.ok, true);
    assert.equal(last.sources.transcripts.advanced, false);
    assert.doesNotMatch(w.logText(), /Z watermark /, 'the watermark step never ran');

    assert.deepEqual(w.watermark(), before, 'no mark moved');
    assert.deepEqual(w.notifications().map((call) => call.at(-1)), [last.reason], 'notified once, with the reason');
    assert.ok(r.stderr.includes(last.reason), 'the reason is printed');
    assert.match(w.logText(), /"exit":69,"reasonCode":"auth_expired"/);
    assert.equal(w.launches().length, 1, 'the model is launched once, never retried');
    assert.equal(w.ghCalls().filter((call) => call.args[1] === 'create').length, 0);
  });
}
