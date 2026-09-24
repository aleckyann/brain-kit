// docs/incidents.md, 27/08/2026: a global reinstall moved the CLI from one
// binary directory to another, and the next day's round died with exit 127
// after 3 seconds while the service manager reported success. The rule: the
// scheduler's PATH lists both possible directories for the binary, the
// machine's path_extra and the directory claude_bin names, so the routine
// survives the next migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { dryFiles, cronCommand, makeScheduleWorld, systemdWords, unitValues, xmlText } from '../helpers/schedule-world.mjs';

async function pathOf(world, platform) {
  const r = await world.run(['install', '--platform', platform, '--dry']);
  assert.equal(r.status, 0, r.stderr);
  const files = dryFiles(r.stdout);
  if (platform === 'systemd') {
    const service = files[join(world.unitDir, `${world.name}.service`)];
    const [assignment] = systemdWords(unitValues(service, 'Environment')[0], { exec: false });
    return assignment.replace(/^PATH=/, '').split(':');
  }
  if (platform === 'launchd') {
    const plist = files[join(world.agentsDir, `${world.name}.plist`)];
    return xmlText(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)[1]).split(':');
  }
  const line = r.stdout.split('\n').find((l) => /^\d+ \d+ \* \* \* /.test(l));
  const command = cronCommand(line.replace(/^\d+ \d+ \* \* \* /, ''));
  return /^PATH='([^']*)'/.exec(command)[1].split(':');
}

test('every platform\'s PATH carries path_extra, home expanded, and the directory of claude_bin, in that order', async () => {
  for (const platform of ['systemd', 'launchd', 'cron']) {
    const world = makeScheduleWorld();
    const dirs = await pathOf(world, platform);
    const extra = [join(world.home, '.local/bin'), '/opt/tools/bin'];
    assert.deepEqual(dirs.slice(0, 3), [...extra, world.claudeDir], platform);
  }
});

test('a claude directory already listed in path_extra appears once, where path_extra put it', async () => {
  for (const platform of ['systemd', 'launchd', 'cron']) {
    const world = makeScheduleWorld();
    world.setMachine({ path_extra: ['/opt/tools/bin', world.claudeDir] });
    const dirs = await pathOf(world, platform);
    assert.equal(dirs.filter((d) => d === world.claudeDir).length, 1, platform);
    assert.deepEqual(dirs.slice(0, 3), ['/opt/tools/bin', world.claudeDir, dirs[2]], platform);
    assert.notEqual(dirs[2], world.claudeDir, platform);
  }
});
