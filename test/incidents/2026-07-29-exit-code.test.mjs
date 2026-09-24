// docs/incidents.md, 29/07/2026: the log reported exit 0 when the round
// failed, because the status was read after another command had reset it.
// The rule: the round's exit comes from the model's own process and from
// what the round can prove, never from a status computed on the side; a
// failure that announces itself as a success is worse than the failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCurate } from '../../src/commands/curate.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { EXIT } from '../../src/exit-codes.mjs';
import { FAKE, makeCurateWorld } from '../helpers/curate-world.mjs';

test('the process exit of `brain-kit curate` is the round\'s exit, the one last-run and the log record', () => {
  const w = makeCurateWorld();
  w.scenario({ stderr: 'boom\n', exitCode: 2 });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE);
  assert.equal(w.lastRun().exit, r.status);
  assert.match(w.logText(), /"exit":1,/);
});

test('a model that exits 0 but never reports a result is a failed round, and the day stays open', () => {
  const w = makeCurateWorld();
  w.scenario({ rewrite: { dropResult: true }, exitCode: 0 });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'model_failed');
  assert.equal(w.watermark(), null);
});

test('a model that exits 0 with a result marked as an error is a failed round', () => {
  const w = makeCurateWorld();
  w.scenario({ rewrite: { replace: [['"is_error":false,"duration_ms"', '"is_error":true,"duration_ms"']] }, exitCode: 0 });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.watermark(), null);
});

test('a model killed at the round timeout never maps to 0, whatever it exits with', async () => {
  const w = makeCurateWorld();
  w.scenario({ delayMs: 60000 });
  assert.equal(w.machine.claude_bin, FAKE);
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  const status = await runCurate([], io, createTranslator('en'), { env: w.env, cwd: w.vault, roundTimeoutMs: 1000, killGraceMs: 300 });
  assert.equal(status, EXIT.FAILURE);
  assert.equal(w.lastRun().reasonCode, 'timed_out');
  assert.equal(w.watermark(), null);
});
