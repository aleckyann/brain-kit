// `brain-kit schedule`: renders the curator's scheduler files for systemd,
// launchd and cron, installs them under a HOME and XDG_CONFIG_HOME that are
// scratch directories, and drives fake `systemctl`, `launchctl` and
// `crontab` found first (and only) on PATH. No test here can reach the real
// scheduler of the machine running the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { nextFireTimes } from '../src/commands/schedule.mjs';
import {
  ACCENTED, VAULT_ID, cronCommand, dryFiles, makeScheduleWorld, systemdWords, unitValues, xmlText,
} from './helpers/schedule-world.mjs';

const KIT_BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const NEW_DEFAULT = ['09:30', '14:00', '20:00'];

function expectedPath(world, node = process.execPath) {
  const dirs = [join(world.home, '.local/bin'), '/opt/tools/bin', world.claudeDir, dirname(node), '/usr/local/bin', '/usr/bin', '/bin'];
  return [...new Set(dirs)].join(':');
}

test('both config packs default to three daytime windows, 09:30, 14:00 and 20:00', () => {
  for (const lang of ['en', 'pt-BR']) {
    const defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
    assert.deepEqual(defaults.curate.schedule, NEW_DEFAULT, lang);
  }
});

test('systemd --dry renders a oneshot service and a timer named by function, writes nothing and runs nothing', async () => {
  const world = makeScheduleWorld({ schedule: ['14:00', '09:30', '20:00', '14:00'] });
  const r = await world.run(['install', '--platform', 'systemd', '--dry']);
  assert.equal(r.status, 0, r.stderr);
  const files = dryFiles(r.stdout);
  const service = files[join(world.unitDir, `${world.name}.service`)];
  const timer = files[join(world.unitDir, `${world.name}.timer`)];
  assert.ok(service && timer, r.stdout);
  assert.deepEqual(unitValues(service, 'Type'), ['oneshot']);
  assert.deepEqual(unitValues(timer, 'OnCalendar'), ['*-*-* 09:30:00', '*-*-* 14:00:00', '*-*-* 20:00:00']);
  assert.deepEqual(unitValues(timer, 'Persistent'), ['false']);
  assert.deepEqual(unitValues(timer, 'Unit'), [`${world.name}.service`]);
  const exec = unitValues(service, 'ExecStart');
  assert.equal(exec.length, 1);
  assert.deepEqual(systemdWords(exec[0], { exec: true }), [process.execPath, KIT_BIN, 'curate', world.vault]);
  const env = unitValues(service, 'Environment').map((value) => systemdWords(value, { exec: false }));
  assert.deepEqual(env, [[`PATH=${expectedPath(world)}`], ['LC_ALL=C.UTF-8'], ['TZ=America/Sao_Paulo']]);
  assert.match(r.stdout, new RegExp(`\\$ systemctl --user daemon-reload\\n\\$ systemctl --user enable ${world.name}.timer\\n\\$ systemctl --user restart ${world.name}.timer`));
  assert.equal(existsSync(world.unitDir), false);
  assert.deepEqual(world.commands(), []);
});

test('quoting survives a vault path with a space, an accent, quotes, a percent sign, a dollar sign, an ampersand and angle brackets, on every platform', async () => {
  const world = makeScheduleWorld({ vaultName: `it's 100% "$HOME" & <b> \\ vault` });
  const node = join(world.base, `n'o %d $e`, 'node');
  mkdirSync(dirname(node), { recursive: true });
  const out = join(world.base, 'argv.txt');
  writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\nprintf 'PATH=%s\\nLC_ALL=%s\\nTZ=%s\\n' "$PATH" "$LC_ALL" "$TZ" >> '${out}'\n`, { mode: 0o755 });
  const argv = [node, KIT_BIN, 'curate', world.vault];

  const systemd = dryFiles((await world.run(['install', '--platform', 'systemd', '--dry'], { node })).stdout);
  const service = systemd[join(world.unitDir, `${world.name}.service`)];
  assert.deepEqual(systemdWords(unitValues(service, 'ExecStart')[0], { exec: true }), argv);

  const launchd = dryFiles((await world.run(['install', '--platform', 'launchd', '--dry'], { node })).stdout);
  const plist = launchd[join(world.agentsDir, `${world.name}.plist`)];
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)[1];
  assert.deepEqual([...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => xmlText(m[1])), argv);
  // Well-formed XML: every ampersand starts an entity.
  assert.doesNotMatch(plist, /&(?!(amp|lt|gt|quot|apos);)/);

  // A vault path with a backslash is refused on cron (cronie cannot carry
  // a backslash in front of a percent sign), so the cron run uses a vault
  // with every other character.
  const cronWorld = makeScheduleWorld({ vaultName: `it's 100% "$HOME" & <b> vault` });
  const cronNode = join(cronWorld.base, `n'o %d $e`, 'node');
  mkdirSync(dirname(cronNode), { recursive: true });
  writeFileSync(cronNode, readFileSync(node, 'utf8'), { mode: 0o755 });
  const cron = await cronWorld.run(['install', '--platform', 'cron', '--dry'], { node: cronNode });
  assert.equal(cron.status, 0, cron.stderr);
  const lines = cron.stdout.split('\n').filter((line) => /^\d+ \d+ \* \* \* /.test(line));
  assert.equal(lines.length, 3);
  const command = cronCommand(lines[0].replace(/^\d+ \d+ \* \* \* /, ''));
  const ran = spawnSync('/bin/sh', ['-c', command], { env: {}, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  // The shell found and ran the fake node at its quoted path; it wrote the
  // arguments it received and the environment the line gave it.
  const got = readFileSync(out, 'utf8').split('\n');
  assert.deepEqual(got.slice(0, 3), [KIT_BIN, 'curate', cronWorld.vault]);
  assert.deepEqual(got.slice(3, 6), [`PATH=${expectedPath(cronWorld, cronNode)}`, 'LC_ALL=C.UTF-8', 'TZ=America/Sao_Paulo']);

  const refused = await world.run(['install', '--platform', 'cron', '--dry'], { node });
  assert.equal(refused.status, 2);
  assert.equal(refused.stderr, `${world.t('schedule.unsafe_path', { path: world.vault })}\n`);
});

test('launchd --dry renders a plist with the label, the environment and one calendar entry per window', async () => {
  const world = makeScheduleWorld();
  const r = await world.run(['install', '--platform', 'launchd', '--dry']);
  assert.equal(r.status, 0, r.stderr);
  const plist = dryFiles(r.stdout)[join(world.agentsDir, `${world.name}.plist`)];
  assert.match(plist, new RegExp(`<key>Label</key>\\s*<string>${world.name}</string>`));
  assert.match(plist, new RegExp(`<key>PATH</key>\\s*<string>${expectedPath(world).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
  assert.match(plist, /<key>LC_ALL<\/key>\s*<string>C\.UTF-8<\/string>/);
  assert.match(plist, /<key>TZ<\/key>\s*<string>America\/Sao_Paulo<\/string>/);
  const windows = [...plist.matchAll(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.deepEqual(windows, [[9, 30], [14, 0], [20, 0]]);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(r.stdout, new RegExp(`\\$ launchctl bootout gui/501/${world.name}\\n\\$ launchctl bootstrap gui/501 `));
  assert.deepEqual(world.commands(), []);
});

test('systemd install writes under XDG_CONFIG_HOME, enables the timer, and status then reports it with the next windows and the last run', async () => {
  const world = makeScheduleWorld();
  const r = await world.run(['install', '--platform', 'systemd']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(world.unitDir).sort(), [`${world.name}.service`, `${world.name}.timer`]);
  assert.deepEqual(world.commands(), [
    'systemctl --user daemon-reload',
    `systemctl --user enable ${world.name}.timer`,
    `systemctl --user restart ${world.name}.timer`,
  ]);
  assert.match(r.stdout, new RegExp(world.t('schedule.installed', { name: world.name, platform: 'systemd', windows: NEW_DEFAULT.join(', ') }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  writeFileSync(join(world.stateDir, 'last-run.json'), JSON.stringify({ status: 'ok', details: { a: 1 }, exit_code: 0, finished_at: '2026-09-24T09:31:10-03:00' }));
  const s = await world.run(['status', '--platform', 'systemd'], { now: new Date(2026, 8, 24, 10, 0) });
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(s.stdout.split('\n'), [
    world.t('schedule.status_active', { name: world.name, platform: 'systemd' }),
    world.t('schedule.status_next', { times: '24/09/2026 14:00, 24/09/2026 20:00, 25/09/2026 09:30' }),
    world.t('schedule.status_last_run', { summary: 'status=ok, exit_code=0, finished_at=2026-09-24T09:31:10-03:00' }),
    '',
  ]);
});

test('the next fire times start strictly after now and roll over the days as far as they need to', () => {
  const at = (h, m) => new Date(2026, 8, 24, h, m);
  assert.deepEqual(nextFireTimes(['09:30', '14:00'], at(14, 0)), ['25/09/2026 09:30', '25/09/2026 14:00', '26/09/2026 09:30']);
  assert.deepEqual(nextFireTimes(['09:30'], at(10, 0)), ['25/09/2026 09:30', '26/09/2026 09:30', '27/09/2026 09:30']);
  assert.deepEqual(nextFireTimes(['09:30', '20:00'], new Date(2026, 8, 30, 21, 0)), ['01/10/2026 09:30', '01/10/2026 20:00', '02/10/2026 09:30']);
});

test('install falls back to ~/.config when XDG_CONFIG_HOME is unset or relative', async () => {
  for (const xdg of [undefined, 'relative/config']) {
    const world = makeScheduleWorld();
    const r = await world.run(['install', '--platform', 'systemd'], { env: { XDG_CONFIG_HOME: xdg } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(world.home, '.config', 'systemd', 'user', `${world.name}.timer`)), String(xdg));
    assert.equal(existsSync(world.unitDir), false);
  }
});

test('systemd uninstall removes only its own two files, keeping another vault\'s and a foreign unit', async () => {
  const world = makeScheduleWorld();
  assert.equal((await world.run(['install', '--platform', 'systemd'])).status, 0);
  const other = join(world.unitDir, 'brain-kit-curate-other-99999999.timer');
  const foreign = join(world.unitDir, 'backup.service');
  writeFileSync(other, '[Timer]\n');
  writeFileSync(foreign, '[Service]\n');
  const before = world.commands().length;
  const r = await world.run(['uninstall', '--platform', 'systemd']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(world.unitDir).sort(), ['backup.service', 'brain-kit-curate-other-99999999.timer']);
  assert.deepEqual(world.commands().slice(before), [`systemctl --user disable --now ${world.name}.timer`, 'systemctl --user daemon-reload']);
  const again = await world.run(['uninstall', '--platform', 'systemd']);
  assert.equal(again.status, 0);
  assert.equal(again.stdout, `${world.t('schedule.nothing_installed', { name: world.name, platform: 'systemd' })}\n`);
});

test('cron install keeps every foreign line, replaces its own block on reinstall, and uninstall removes only that block', async () => {
  const world = makeScheduleWorld();
  const foreign = [
    'MAILTO=ana@example.invalid',
    '# a comment of her own',
    '15 3 * * 1 /usr/bin/backup --tag 50\\% >/dev/null 2>&1',
    '# BEGIN brain-kit-curate-other-99999999: written by brain-kit schedule, run it again rather than editing these lines',
    '0 10 * * * /usr/bin/true',
    '# END brain-kit-curate-other-99999999',
    '',
  ].join('\n');
  writeFileSync(world.crontab, foreign);
  assert.equal((await world.run(['install', '--platform', 'cron'])).status, 0);
  const first = readFileSync(world.crontab, 'utf8');
  assert.ok(first.startsWith(foreign), first);
  const block = first.slice(foreign.length);
  assert.match(block, new RegExp(`^# BEGIN ${world.name}: `));
  assert.deepEqual(block.split('\n').filter((l) => /^\d/.test(l)).map((l) => l.split(' ').slice(0, 5).join(' ')), ['30 9 * * *', '0 14 * * *', '0 20 * * *']);
  assert.deepEqual(world.commands(), ['crontab -l', 'crontab -']);

  assert.equal((await world.run(['install', '--platform', 'cron'])).status, 0);
  assert.equal(readFileSync(world.crontab, 'utf8'), first, 'a second install leaves one block, not two');

  const s = await world.run(['status', '--platform', 'cron'], { now: new Date(2026, 8, 24, 21, 0) });
  assert.equal(s.status, 0, s.stderr);
  assert.ok(s.stdout.includes(world.t('schedule.status_next', { times: '25/09/2026 09:30, 25/09/2026 14:00, 25/09/2026 20:00' })), s.stdout);
  assert.ok(s.stdout.includes(world.t('schedule.status_no_last_run', { file: join(world.stateDir, 'last-run.json') })), s.stdout);

  // A line she added after the block later is hers too.
  const later = '45 18 * * 5 /usr/bin/weekly-report\n';
  writeFileSync(world.crontab, `${first}${later}`);
  assert.equal((await world.run(['uninstall', '--platform', 'cron'])).status, 0);
  assert.equal(readFileSync(world.crontab, 'utf8'), `${foreign}${later}`);
});

test('cron install on a user with no crontab yet writes the block alone; a crontab -l that fails otherwise is exit 1 and writes nothing', async () => {
  const world = makeScheduleWorld();
  assert.equal((await world.run(['install', '--platform', 'cron'])).status, 0);
  assert.match(readFileSync(world.crontab, 'utf8'), new RegExp(`^# BEGIN ${world.name}: [^\\n]*\\n(\\d+ \\d+ \\* \\* \\* [^\\n]*\\n){3}# END ${world.name}\\n$`));

  const broken = makeScheduleWorld();
  writeFileSync(join(broken.fakeBin, 'crontab'), `#!/bin/sh\nprintf 'crontab %s\\n' "$*" >> "$FAKE_LOG"\necho "crontab: permission denied" >&2\nexit 1\n`, { mode: 0o755 });
  const r = await broken.run(['install', '--platform', 'cron']);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `${broken.t('schedule.crontab_read_failed', { detail: 'crontab: permission denied' })}\n`);
  assert.deepEqual(broken.commands(), ['crontab -l']);
});

test('a crontab with its own BEGIN line and no END is refused, never guessed at', async () => {
  const world = makeScheduleWorld();
  writeFileSync(world.crontab, `# BEGIN ${world.name}: written by brain-kit schedule\n0 9 * * * true\n`);
  const r = await world.run(['uninstall', '--platform', 'cron']);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `${world.t('schedule.crontab_broken', { name: world.name })}\n`);
  assert.deepEqual(world.commands(), ['crontab -l']);
});

test('launchd install writes under ~/Library/LaunchAgents and bootstraps it; uninstall boots it out and removes only its plist', async () => {
  const world = makeScheduleWorld();
  const r = await world.run(['install', '--platform', 'launchd']);
  assert.equal(r.status, 0, r.stderr);
  const plist = join(world.agentsDir, `${world.name}.plist`);
  assert.ok(existsSync(plist));
  assert.deepEqual(world.commands(), [`launchctl bootout gui/501/${world.name}`, `launchctl bootstrap gui/501 ${plist}`]);
  writeFileSync(join(world.agentsDir, 'com.example.other.plist'), '<plist/>\n');
  const s = await world.run(['status', '--platform', 'launchd'], { now: new Date(2026, 8, 24, 8, 0) });
  assert.equal(s.status, 0, s.stderr);
  assert.ok(s.stdout.includes(world.t('schedule.status_next', { times: '24/09/2026 09:30, 24/09/2026 14:00, 24/09/2026 20:00' })), s.stdout);
  // bootout answers non-zero when the job is not loaded; that is not a
  // failure of the install or of the uninstall.
  const again = await world.run(['install', '--platform', 'launchd'], { env: { FAKE_BOOTOUT_STATUS: '3' } });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(world.commands().at(-1), `launchctl bootstrap gui/501 ${plist}`);
  const u = await world.run(['uninstall', '--platform', 'launchd'], { env: { FAKE_BOOTOUT_STATUS: '3' } });
  assert.equal(u.status, 0, u.stderr);
  assert.deepEqual(readdirSync(world.agentsDir), ['com.example.other.plist']);
});

test('status is exit 1 when nothing is installed, when the files no longer match the configuration, and when the timer is not enabled', async () => {
  const world = makeScheduleWorld();
  const none = await world.run(['status', '--platform', 'systemd']);
  assert.equal(none.status, 1);
  assert.ok(none.stdout.includes(world.t('schedule.status_not_installed', { name: world.name, platform: 'systemd' })), none.stdout);

  assert.equal((await world.run(['install', '--platform', 'systemd'])).status, 0);
  const config = join(world.vault, 'brain-kit.config.json');
  const changed = JSON.parse(readFileSync(config, 'utf8'));
  changed.curate.schedule = ['10:00'];
  writeFileSync(config, JSON.stringify(changed));
  const outdated = await world.run(['status', '--platform', 'systemd']);
  assert.equal(outdated.status, 1);
  assert.ok(outdated.stdout.includes(world.t('schedule.status_outdated', { name: world.name, platform: 'systemd' })), outdated.stdout);

  assert.equal((await world.run(['install', '--platform', 'systemd'])).status, 0);
  const disabled = await world.run(['status', '--platform', 'systemd'], { env: { FAKE_SYSTEMCTL_DISABLED: '1' } });
  assert.equal(disabled.status, 1);
  assert.ok(disabled.stdout.includes(world.t('schedule.status_inactive', { name: world.name, platform: 'systemd', detail: 'disabled' })), disabled.stdout);
});

test('a failing systemctl is exit 1 naming the command, never a quiet success', async () => {
  const world = makeScheduleWorld();
  const r = await world.run(['install', '--platform', 'systemd'], { env: { FAKE_SYSTEMCTL_STATUS: '1' } });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `${world.t('schedule.command_failed', { command: 'systemctl --user daemon-reload', status: 1, detail: world.t('schedule.no_output') })}\n`);
  assert.deepEqual(world.commands(), ['systemctl --user daemon-reload']);
});

test('the platform is detected: systemd when systemctl --user answers, launchd on darwin, cron otherwise', async () => {
  const systemd = makeScheduleWorld();
  const a = await systemd.run(['install', '--dry']);
  assert.equal(a.status, 0, a.stderr);
  assert.ok(a.stdout.includes(`--- ${join(systemd.unitDir, `${systemd.name}.timer`)}`), a.stdout);
  assert.deepEqual(systemd.commands(), ['systemctl --user show-environment']);

  const silent = makeScheduleWorld();
  const b = await silent.run(['install', '--dry'], { env: { FAKE_SYSTEMCTL_PROBE: '1' } });
  assert.ok(b.stdout.includes(`# BEGIN ${silent.name}: `), b.stdout);

  const mac = makeScheduleWorld({ fakes: ['launchctl'] });
  const c = await mac.run(['install', '--dry'], { platform: 'darwin' });
  assert.ok(c.stdout.includes(`--- ${join(mac.agentsDir, `${mac.name}.plist`)}`), c.stdout);

  const bare = makeScheduleWorld({ fakes: ['crontab'] });
  const d = await bare.run(['install', '--dry']);
  assert.ok(d.stdout.includes(`# BEGIN ${bare.name}: `), d.stdout);
});

test('on Windows it is exit 2 with the manual instruction, and nothing is written', async () => {
  const world = makeScheduleWorld();
  const r = await world.run(['install'], { platform: 'win32' });
  assert.equal(r.status, 2);
  const command = [process.execPath, KIT_BIN, 'curate', world.vault].map((arg) => `"${arg}"`).join(' ');
  assert.equal(r.stderr, `${world.t('schedule.windows_manual', { windows: NEW_DEFAULT.join(', '), command })}\n`);
  assert.deepEqual(world.commands(), []);
});

test('refusals: disabled curate, no window, an unknown timezone, a claude that cannot be found, a moved vault', async () => {
  const disabled = makeScheduleWorld({ enabled: false });
  let r = await disabled.run(['install', '--platform', 'systemd']);
  assert.deepEqual([r.status, r.stderr], [2, `${disabled.t('schedule.disabled', { file: 'brain-kit.config.json' })}\n`]);

  const empty = makeScheduleWorld({ schedule: [] });
  r = await empty.run(['install', '--platform', 'systemd']);
  assert.deepEqual([r.status, r.stderr], [2, `${empty.t('schedule.no_windows', { file: 'brain-kit.config.json' })}\n`]);

  const zone = makeScheduleWorld({ timezone: '<vault-timezone>' });
  r = await zone.run(['install', '--platform', 'systemd']);
  assert.deepEqual([r.status, r.stderr], [2, `${zone.t('schedule.bad_timezone', { timezone: '<vault-timezone>', file: 'brain-kit.config.json' })}\n`]);

  const lost = makeScheduleWorld({ machine: { claude_bin: 'claude' } });
  r = await lost.run(['install', '--platform', 'systemd']);
  assert.deepEqual([r.status, r.stderr], [2, `${lost.t('schedule.claude_not_found', { bin: 'claude' })}\n`]);

  const moved = makeScheduleWorld({ machine: { canonical_path: '/home/ana/old/vault' } });
  r = await moved.run(['install', '--platform', 'systemd']);
  assert.deepEqual([r.status, r.stderr], [2, `${moved.t('schedule.moved', { recorded: '/home/ana/old/vault', root: moved.vault })}\n`]);

  for (const world of [disabled, empty, zone, lost, moved]) {
    assert.equal(existsSync(world.unitDir), false);
    assert.deepEqual(world.commands(), []);
  }
});

test('a bare claude_bin found on PATH puts its own directory on the unit PATH', async () => {
  const world = makeScheduleWorld({ machine: { claude_bin: 'claude' } });
  const r = await world.run(['install', '--platform', 'systemd', '--dry'], { env: { PATH: `${world.fakeBin}:${world.claudeDir}` } });
  assert.equal(r.status, 0, r.stderr);
  const service = dryFiles(r.stdout)[join(world.unitDir, `${world.name}.service`)];
  assert.deepEqual(systemdWords(unitValues(service, 'Environment')[0], { exec: false }), [`PATH=${expectedPath(world)}`]);
});

test('a machine timezone other than the vault\'s is said, since the scheduler fires on the machine\'s clock', async () => {
  const world = makeScheduleWorld();
  const r = await world.run(['install', '--platform', 'systemd', '--dry'], { localZone: 'Europe/Lisbon' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, `${world.t('schedule.timezone_differs', { local: 'Europe/Lisbon', vault: 'America/Sao_Paulo' })}\n`);
});

test('usage errors are exit 2: no action, an unknown action, an unknown platform, --platform with no value, --dry on status, an extra argument', async () => {
  const world = makeScheduleWorld();
  const usage = world.t('schedule.usage');
  const cases = [
    [[], `${usage}\n`],
    [['enable'], `${world.t('schedule.unknown_action', { action: 'enable' })}\n${usage}\n`],
    [['install', '--platform', 'upstart'], `${world.t('schedule.bad_platform', { platform: 'upstart', platforms: 'systemd, launchd, cron' })}\n${usage}\n`],
    [['install', '--platform'], `${world.t('schedule.platform_needs_value')}\n${usage}\n`],
    [['status', '--dry'], `${world.t('schedule.bad_argument', { arg: '--dry' })}\n${usage}\n`],
    [['install', 'a', 'b'], `${world.t('schedule.bad_argument', { arg: 'b' })}\n${usage}\n`],
    [['install', '--now'], `${world.t('schedule.bad_argument', { arg: '--now' })}\n${usage}\n`],
  ];
  for (const [argv, stderr] of cases) {
    const r = await world.run(argv);
    assert.deepEqual([r.status, r.stderr], [2, stderr], argv.join(' '));
  }
  const help = await world.run(['--help']);
  assert.deepEqual([help.status, help.stdout], [0, `${usage}\n`]);
  const missing = await world.run(['install', join(world.base, 'nowhere')]);
  assert.equal(missing.status, 2);
  assert.equal(missing.stderr, `${world.t('schedule.path_not_found', { dir: join(world.base, 'nowhere') })}\n`);
  const outside = await world.run(['install', world.base]);
  assert.equal(outside.status, 2);
  assert.equal(outside.stderr, `${world.t('schedule.no_vault', { dir: world.base, config: 'brain-kit.config.json', index: 'index.md' })}\n`);
});

test('the CLI lists schedule and routes to it', () => {
  const world = makeScheduleWorld();
  const help = spawnSync(process.execPath, [KIT_BIN, '--help'], { env: { ...world.env, BRAIN_KIT_LANG: 'en' }, encoding: 'utf8' });
  assert.match(help.stdout, /\n {2}schedule install\|uninstall\|status /);
  const r = spawnSync(process.execPath, [KIT_BIN, 'schedule', 'install', world.vault, '--platform', 'systemd', '--dry'], { env: { ...world.env, BRAIN_KIT_LANG: 'en' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`--- ${join(world.unitDir, `${world.name}.service`)}`), r.stdout);
  assert.ok(r.stdout.includes(ACCENTED));
  assert.ok(r.stdout.includes(VAULT_ID));
});
