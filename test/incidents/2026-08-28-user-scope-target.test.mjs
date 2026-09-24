// docs/incidents.md, 28/08/2026: dependency directives on a network target
// were added to the curator's service unit and the blindness continued for
// three more nights. That target does not exist in the user scope, so the
// directives were dead letter. The rule: the network wait is an explicit
// step in the engine, and the unit carries no dependency on any network
// target; this test fails if the inert line comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { dryFiles, makeScheduleWorld } from '../helpers/schedule-world.mjs';

const DEPENDENCY_KEYS = ['After', 'Before', 'Wants', 'Requires', 'Requisite', 'BindsTo', 'PartOf', 'Upholds', 'WantedBy'];

function directives(text) {
  return text.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#') && !line.startsWith(';'));
}

test('the rendered service names no network target, and carries no ordering or dependency line at all', async () => {
  const world = makeScheduleWorld();
  const r = await world.run(['install', '--platform', 'systemd', '--dry']);
  assert.equal(r.status, 0, r.stderr);
  const files = dryFiles(r.stdout);
  const service = files[join(world.unitDir, `${world.name}.service`)];
  const timer = files[join(world.unitDir, `${world.name}.timer`)];
  assert.ok(service && timer, r.stdout);
  for (const line of [...directives(service), ...directives(timer)]) {
    assert.doesNotMatch(line, /network/i, line);
  }
  const serviceKeys = directives(service).map((line) => line.split('=')[0]);
  for (const key of DEPENDENCY_KEYS) assert.ok(!serviceKeys.includes(key), `${key}= in the service`);
  // The timer's own [Install] section is how it is enabled at all; it is
  // the only dependency line anywhere, and it names the timers target.
  const timerDeps = directives(timer).filter((line) => DEPENDENCY_KEYS.includes(line.split('=')[0]));
  assert.deepEqual(timerDeps, ['WantedBy=timers.target']);
});

test('the launchd job has no network condition either: it is started by the calendar alone', async () => {
  const world = makeScheduleWorld();
  const r = await world.run(['install', '--platform', 'launchd', '--dry']);
  assert.equal(r.status, 0, r.stderr);
  const plist = dryFiles(r.stdout)[join(world.agentsDir, `${world.name}.plist`)];
  assert.doesNotMatch(plist, /network|KeepAlive/i);
});
