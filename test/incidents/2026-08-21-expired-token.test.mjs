// docs/incidents.md, 21/08/2026: the round died on an authentication error
// six seconds after it started, and the service manager reported success,
// because the status it propagated was a wrapper's, not the process's. The
// rule: the real process's failure is the round's; an API or login failure
// is "model unavailable" (69), said in the log and in last-run.json with
// the duration, the cost and the turns, and the notify command is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT } from '../../src/exit-codes.mjs';
import { makeCurateWorld } from '../helpers/curate-world.mjs';

test('a 401 in seconds is exit 69, never 0: in the log, in last-run with no turns, and in a notification', () => {
  const w = makeCurateWorld();
  w.scenario({ stream: undefined, stderr: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}\n', exitCode: 1 });
  const r = w.curate();
  assert.equal(r.status, EXIT.UNAVAILABLE, r.stderr);
  const last = w.lastRun();
  assert.equal(last.exit, EXIT.UNAVAILABLE);
  assert.equal(last.reasonCode, 'model_unavailable');
  assert.equal(last.numTurns, null);
  assert.equal(last.costUsd, null);
  assert.equal(typeof last.durationMs, 'number');
  assert.match(last.reason, /API Error, 401, authentication/);
  assert.match(w.logText(), /"exit":69/);
  assert.equal(w.watermark(), null);
  const [call] = w.notifications();
  assert.equal(call.at(-1), last.reason);
});
