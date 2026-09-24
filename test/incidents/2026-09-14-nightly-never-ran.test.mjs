// docs/incidents.md, 14/09/2026: the routine scheduled for midnight with
// catch up enabled never fired at midnight. It fired at resume, 08:46,
// 08:36 and 07:13, always before the wireless connection was up; it was
// moved to 09:30 while its files kept the word "nightly" in their names.
// The rule: schedule in the window when the machine is on and connected,
// never overnight with catch up, and name the routine by what it does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';
import { dryFiles, makeScheduleWorld, unitValues, VAULT_ID } from '../helpers/schedule-world.mjs';

test('the timer never catches up at resume: Persistent=false, once, and nothing else', async () => {
  const world = makeScheduleWorld();
  const r = await world.run(['install', '--platform', 'systemd', '--dry']);
  assert.equal(r.status, 0, r.stderr);
  const timer = dryFiles(r.stdout)[join(world.unitDir, `${world.name}.timer`)];
  assert.deepEqual(unitValues(timer, 'Persistent'), ['false']);
  assert.deepEqual(unitValues(timer, 'OnBootSec'), []);
  assert.deepEqual(unitValues(timer, 'OnStartupSec'), []);
});

test('the default windows of both packs are daytime, and they are the windows the timer gets', async () => {
  for (const lang of ['en', 'pt-BR']) {
    const { schedule } = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8')).curate;
    assert.deepEqual(schedule, ['09:30', '14:00', '20:00'], lang);
    const world = makeScheduleWorld({ schedule });
    const r = await world.run(['install', '--platform', 'systemd', '--dry']);
    assert.equal(r.status, 0, r.stderr);
    const timer = dryFiles(r.stdout)[join(world.unitDir, `${world.name}.timer`)];
    assert.deepEqual(unitValues(timer, 'OnCalendar'), schedule.map((w) => `*-*-* ${w}:00`));
  }
});

test('an overnight window is refused on every platform, exit 2, naming it, with nothing written or run', async () => {
  for (const platform of ['systemd', 'launchd', 'cron']) {
    const world = makeScheduleWorld({ schedule: ['09:30', '00:00', '06:59', '23:00'] });
    const r = await world.run(['install', '--platform', platform]);
    assert.equal(r.status, 2, platform);
    assert.equal(r.stderr, `${world.t('schedule.overnight', { windows: '00:00, 06:59, 23:00', from: '07:00', until: '23:00', file: 'brain-kit.config.json' })}\n`);
    assert.deepEqual(world.commands(), [], platform);
    assert.equal(existsSync(world.unitDir) || existsSync(world.agentsDir) || existsSync(world.crontab), false, platform);
  }
  const edge = makeScheduleWorld({ schedule: ['07:00', '22:59'] });
  assert.equal((await edge.run(['install', '--platform', 'systemd', '--dry'])).status, 0);
});

test('the units are named by function and vault, never by a time of day', async () => {
  const world = makeScheduleWorld();
  const r = await world.run(['install', '--platform', 'systemd', '--dry']);
  const names = Object.keys(dryFiles(r.stdout)).map((path) => path.split('/').pop());
  assert.deepEqual(names, [`brain-kit-curate-${VAULT_ID}.service`, `brain-kit-curate-${VAULT_ID}.timer`]);
  for (const name of names) assert.doesNotMatch(name, /night|noturn|morning|evening|daily|\d\d:?\d\d/i);
});
