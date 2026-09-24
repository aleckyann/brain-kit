// docs/incidents.md, 29/08/2026: for three nights the network guard called
// a check that waited for the network manager to initialise, not for a
// connection. It returned in 0.02 seconds with exit 0, while the connection
// arrived 4 to 5 seconds after the service started. The rule: a guard that
// comes back instantly waited for nothing, so a first-try success under 100
// milliseconds is reported as "did not wait". No test here touches the
// network: the check is injected, and the clock is the test's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MIN_WAIT_MS, waitForNetwork } from '../../src/guards/network.mjs';

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; }, sleep: async (ms) => { t += ms; } };
}

test('29/08/2026 replayed: a check that answers exit 0 in 20 ms on its first try is reported as not having waited', async () => {
  const c = clock();
  const r = await waitForNetwork(async () => { c.advance(20); return true; }, { timeoutMs: 60000 }, c);
  assert.equal(DEFAULT_MIN_WAIT_MS, 100);
  assert.equal(r.ok, true, 'accepted: the round still runs');
  assert.equal(r.warning, 'did_not_wait');
  assert.equal(r.waitedMs, 20);
});

test('the connection that arrives 4.5 seconds later is waited for, and no warning is raised', async () => {
  const c = clock();
  const up = 4500;
  const r = await waitForNetwork(async () => { c.advance(20); return c.now() >= up; }, { timeoutMs: 60000 }, c);
  assert.equal(r.ok, true);
  assert.equal(r.warning, null);
  assert.ok(r.waitedMs >= up, `waited ${r.waitedMs} ms`);
  assert.ok(r.attempts > 1);
});

test('a network that never comes up within the timeout is not ok (curate exits 69), never a silent success', async () => {
  const c = clock();
  const r = await waitForNetwork(async () => { c.advance(20); return false; }, { timeoutMs: 10000 }, c);
  assert.equal(r.ok, false);
  assert.equal(r.warning, null);
});
