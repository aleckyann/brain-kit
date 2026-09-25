// `brain-kit schedule`: renders the curator's scheduler files for systemd,
// launchd and cron, installs them under a HOME and XDG_CONFIG_HOME that are
// scratch directories, and drives fake `systemctl`, `launchctl` and
// `crontab` found first (and only) on PATH. No test here can reach the real
// scheduler of the machine running the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { CRON_LINE_LIMIT, briefingTask, briefingTaskFile, nextFireTimes, readBriefingTask, sameClock } from '../src/commands/schedule.mjs';
import { startsWithSignature } from '../src/sources/transcripts-claude-code.mjs';
import { kitCommand } from '../src/curate/tools.mjs';
import { createTranslator } from '../src/lang.mjs';
import { INSIDE, PROJECT, assistant, makeWorld as makeTranscriptsWorld, paths, user } from './helpers/transcripts-world.mjs';
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

  assert.throws(() => systemdWords(`"${node.replace(/%/g, '%%')}" "curate"`, { exec: true }), /special character in the executable path/, 'the helper holds the program to systemd\'s own rule');

  // systemd cannot run a program whose path holds a quote or a backslash,
  // however it is quoted: refused before anything is written.
  const quoted = await world.run(['install', '--platform', 'systemd'], { node });
  assert.deepEqual([quoted.status, quoted.stderr], [2, `${world.t('schedule.unsafe_path', { path: node })}\n`]);
  assert.equal(existsSync(world.unitDir), false);
  // A dollar sign, a percent sign and a space in the program path are fine:
  // `%` doubled, `$` left single (systemd expands no variable there), and
  // the vault argument keeps every hostile character.
  const plainNode = join(world.base, 'n o %d d$e', 'node');
  mkdirSync(dirname(plainNode), { recursive: true });
  writeFileSync(plainNode, '#!/bin/sh\n', { mode: 0o755 });
  const systemdRun = await world.run(['install', '--platform', 'systemd', '--dry'], { node: plainNode });
  assert.equal(systemdRun.status, 0, systemdRun.stderr);
  const service = dryFiles(systemdRun.stdout)[join(world.unitDir, `${world.name}.service`)];
  const execStart = unitValues(service, 'ExecStart')[0];
  assert.ok(execStart.startsWith(`"${plainNode.replace(/%/g, '%%')}" `), execStart);
  assert.deepEqual(systemdWords(execStart, { exec: true }), [plainNode, KIT_BIN, 'curate', world.vault]);
  // The kit's own path is the other program path: held to the same rule.
  const kit = join(world.base, 'kit "x"', 'bin', 'brain-kit.mjs');
  const kitRun = await world.run(['install', '--platform', 'systemd', '--dry'], { kit });
  assert.deepEqual([kitRun.status, kitRun.stderr], [2, `${world.t('schedule.unsafe_path', { path: kit })}\n`]);

  const launchd = dryFiles((await world.run(['install', '--platform', 'launchd', '--dry'], { node })).stdout);
  const plist = launchd[join(world.agentsDir, `${world.name}.plist`)];
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)[1];
  assert.deepEqual([...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => xmlText(m[1])), argv);
  // Well-formed XML: every ampersand starts an entity.
  assert.doesNotMatch(plist, /&(?!(amp|lt|gt|quot|apos);)/);

  // A vault path with a backslash is refused on cron (cronie cannot carry
  // a backslash in front of a percent sign), so the cron run uses a vault
  // with every other character.
  // No path_extra here: every path in this world sits under the temporary
  // directory, repeated in the PATH, and a long TMPDIR would otherwise push
  // the line past the kit's cron length limit, which has its own test.
  const cronWorld = makeScheduleWorld({ vaultName: `it's 100% "$HOME" & <b> vault`, machine: { path_extra: [] } });
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
  const cronPath = [...new Set([cronWorld.claudeDir, dirname(cronNode), '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
  assert.deepEqual(got.slice(3, 6), [`PATH=${cronPath}`, 'LC_ALL=C.UTF-8', 'TZ=America/Sao_Paulo']);

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
    world.t('schedule.status_last_run', { summary: `status=ok, exit_code=0, finished_at=${shownLocal('2026-09-24T09:31:10-03:00')}` }),
    '',
  ]);
});

// DD/MM/YYYY HH:MM on this machine's clock, computed apart from the code
// under test.
function shownLocal(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

test('status reads a relative machine.paths.last_run from the state directory, never from the working directory', async () => {
  const world = makeScheduleWorld();
  world.setMachine({ paths: { watermark: 'watermark.json', last_run: 'last-run.json', log_dir: 'logs' } });
  assert.equal((await world.run(['install', '--platform', 'systemd'])).status, 0);
  writeFileSync(join(world.stateDir, 'last-run.json'), JSON.stringify({ exit: 0, reasonCode: 'from-state-dir' }));
  // A decoy where a working-directory resolution would look.
  const elsewhere = join(world.stateDir, '..', 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'last-run.json'), JSON.stringify({ exit: 1, reasonCode: 'from-cwd' }));
  const s = await world.run(['status', world.vault, '--platform', 'systemd'], { cwd: elsewhere });
  assert.match(s.stdout, /reasonCode=from-state-dir/);
  assert.doesNotMatch(s.stdout, /from-cwd/);
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

test('a machine clock that differs from the vault\'s, now or half a year from now, is said; another name for the same clock is not', async () => {
  const world = makeScheduleWorld();
  const september = new Date(Date.UTC(2026, 8, 24, 12));
  const r = await world.run(['install', '--platform', 'systemd', '--dry'], { localZone: 'Europe/Lisbon', now: september });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, `${world.t('schedule.timezone_differs', { local: 'Europe/Lisbon', vault: 'America/Sao_Paulo' })}\n`);

  const alias = await world.run(['install', '--platform', 'systemd', '--dry'], { localZone: 'America/Recife', now: september });
  assert.deepEqual([alias.status, alias.stderr], [0, '']);

  // In January London and UTC read the same; in July they do not.
  const london = makeScheduleWorld({ timezone: 'Europe/London' });
  const january = new Date(Date.UTC(2026, 0, 15, 12));
  const winter = await london.run(['install', '--platform', 'systemd', '--dry'], { localZone: 'UTC', now: january });
  assert.equal(winter.stderr, `${london.t('schedule.timezone_differs', { local: 'UTC', vault: 'Europe/London' })}\n`);
  assert.equal(sameClock('UTC', 'Europe/London', january), false);
  assert.equal(sameClock('Etc/UTC', 'UTC', january), true);
});

test('a cron line longer than the kit allows is refused in its own words, before the crontab is read', async () => {
  const world = makeScheduleWorld();
  world.setMachine({ path_extra: [`/opt/${'deep/'.repeat(180)}bin`] });
  const r = await world.run(['install', '--platform', 'cron']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, new RegExp(`^${world.t('schedule.cron_line_too_long', { bytes: 'BYTES', limit: CRON_LINE_LIMIT }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('BYTES', '(\\d+)')}\\n$`));
  assert.ok(Number(/(\d+) bytes/.exec(r.stderr)[1]) > CRON_LINE_LIMIT);
  assert.deepEqual(world.commands(), []);
  assert.equal((await world.run(['install', '--platform', 'systemd', '--dry'])).status, 0, 'systemd has no such limit');
});

test('a systemd uninstall whose disable fails still removes its own files, says so, and is exit 1', async () => {
  const world = makeScheduleWorld();
  assert.equal((await world.run(['install', '--platform', 'systemd'])).status, 0);
  const r = await world.run(['uninstall', '--platform', 'systemd'], { env: { FAKE_SYSTEMCTL_STATUS: '1' } });
  assert.equal(r.status, 1);
  assert.deepEqual(readdirSync(world.unitDir), []);
  assert.equal(r.stderr, [
    world.t('schedule.command_failed', { command: `systemctl --user disable --now ${world.name}.timer`, status: 1, detail: world.t('schedule.no_output') }),
    world.t('schedule.command_failed', { command: 'systemctl --user daemon-reload', status: 1, detail: world.t('schedule.no_output') }),
    world.t('schedule.uninstall_unconfirmed', { name: world.name, platform: 'systemd' }),
    '',
  ].join('\n'));

  // The disable alone failing, the reload succeeding: still exit 1.
  const alone = makeScheduleWorld();
  assert.equal((await alone.run(['install', '--platform', 'systemd'])).status, 0);
  const a = await alone.run(['uninstall', '--platform', 'systemd'], { env: { FAKE_DISABLE_STATUS: '1' } });
  assert.equal(a.status, 1);
  assert.deepEqual(readdirSync(alone.unitDir), []);
  assert.equal(alone.commands().at(-1), 'systemctl --user daemon-reload');
  assert.equal(a.stderr, [
    alone.t('schedule.command_failed', { command: `systemctl --user disable --now ${alone.name}.timer`, status: 1, detail: alone.t('schedule.no_output') }),
    alone.t('schedule.uninstall_unconfirmed', { name: alone.name, platform: 'systemd' }),
    '',
  ].join('\n'));
});

test('a second copy of this vault\'s cron block is refused; foreign environment lines above the block are said', async () => {
  const world = makeScheduleWorld();
  assert.equal((await world.run(['install', '--platform', 'cron'])).status, 0);
  const once = readFileSync(world.crontab, 'utf8');
  writeFileSync(world.crontab, `${once}${once}`);
  const r = await world.run(['uninstall', '--platform', 'cron']);
  assert.deepEqual([r.status, r.stderr], [1, `${world.t('schedule.crontab_duplicate', { name: world.name })}\n`]);
  assert.equal(readFileSync(world.crontab, 'utf8'), `${once}${once}`);

  const env = makeScheduleWorld();
  writeFileSync(env.crontab, 'CRON_TZ=UTC\nSHELL=/bin/zsh\nMAILTO=ana@example.invalid\n0 3 * * * /usr/bin/true\n');
  const e = await env.run(['install', '--platform', 'cron']);
  assert.equal(e.status, 0);
  assert.equal(e.stderr, `${env.t('schedule.crontab_foreign_env', { lines: ['CRON_TZ=UTC', 'SHELL=/bin/zsh'] })}\n`);
});

test('status and uninstall that detect their platform name an entry installed under another one, never "nothing to remove"', async () => {
  const world = makeScheduleWorld();
  assert.equal((await world.run(['install', '--platform', 'cron'])).status, 0);
  const s = await world.run(['status']);
  assert.equal(s.status, 1);
  assert.ok(s.stdout.includes(world.t('schedule.found_elsewhere', { name: world.name, platform: 'systemd', platforms: ['cron'] })), s.stdout);
  const u = await world.run(['uninstall']);
  assert.deepEqual([u.status, u.stderr], [1, `${world.t('schedule.found_elsewhere', { name: world.name, platform: 'systemd', platforms: ['cron'] })}\n`]);
  assert.match(readFileSync(world.crontab, 'utf8'), new RegExp(`# BEGIN ${world.name}:`));
  const explicit = await world.run(['uninstall', '--platform', 'systemd']);
  assert.deepEqual([explicit.status, explicit.stdout], [0, `${world.t('schedule.nothing_installed', { name: world.name, platform: 'systemd' })}\n`]);
});

test('a node or kit under a version manager or the npx cache is said at install', async () => {
  const world = makeScheduleWorld();
  const node = '/home/ana/.nvm/versions/node/v24.1.0/bin/node';
  const kit = '/home/ana/.npm/_npx/0123abcd/node_modules/second-brain-kit/bin/brain-kit.mjs';
  const r = await world.run(['install', '--platform', 'systemd', '--dry'], { node, kit });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, `${world.t('schedule.pinned_path', { path: node })}\n${world.t('schedule.pinned_path', { path: kit })}\n`);
  const plain = await world.run(['install', '--platform', 'systemd', '--dry']);
  assert.equal(plain.stderr, '');
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

// ------------------------------------------------ final review I1: the round's commands

test('install adds the directory where the installing shell finds brain-kit when the unit PATH would not reach it, after every other directory', async () => {
  const world = makeScheduleWorld({ roundTools: false });
  writeFileSync(join(world.claudeDir, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const npmBin = join(world.base, 'npm global', 'bin');
  mkdirSync(npmBin, { recursive: true });
  writeFileSync(join(npmBin, 'brain-kit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const node = join(world.base, 'node-dir', 'node');
  mkdirSync(dirname(node), { recursive: true });
  writeFileSync(node, '#!/bin/sh\n', { mode: 0o755 });
  const r = await world.run(['install', '--platform', 'systemd', '--dry'], { env: { PATH: `${world.fakeBin}:${npmBin}` }, node, systemPath: ['/nonexistent-system-dir'] });
  assert.equal(r.status, 0, r.stderr);
  const service = dryFiles(r.stdout)[join(world.unitDir, `${world.name}.service`)];
  const expected = [join(world.home, '.local/bin'), '/opt/tools/bin', world.claudeDir, dirname(node), '/nonexistent-system-dir', npmBin].join(':');
  assert.deepEqual(systemdWords(unitValues(service, 'Environment')[0], { exec: false }), [`PATH=${expected}`]);
});

test('install refuses with exit 2, naming the command and how to install it, when brain-kit or gh is found neither on the unit PATH nor on the shell\'s; nothing is written or run', async () => {
  for (const [command, present, hintKey] of [['brain-kit', 'gh', 'schedule.hint_brain_kit'], ['gh', 'brain-kit', 'schedule.hint_gh']]) {
    const world = makeScheduleWorld({ roundTools: false });
    writeFileSync(join(world.claudeDir, present), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const node = join(world.base, 'node-dir', 'node');
    mkdirSync(dirname(node), { recursive: true });
    writeFileSync(node, '#!/bin/sh\n', { mode: 0o755 });
    for (const dry of [[], ['--dry']]) {
      const r = await world.run(['install', '--platform', 'systemd', ...dry], { node, systemPath: ['/nonexistent-system-dir'] });
      const path = [join(world.home, '.local/bin'), '/opt/tools/bin', world.claudeDir, dirname(node), '/nonexistent-system-dir'].join(':');
      assert.equal(r.status, 2, command);
      assert.equal(r.stderr, `${world.t('schedule.command_missing', { command, path, hint: world.t(hintKey) })}\n`);
      assert.equal(r.stdout, '');
    }
    assert.equal(existsSync(world.unitDir), false);
    assert.deepEqual(world.commands(), []);
  }
});

test('status compares with the PATH recorded in the installed unit: run from a shell that no longer finds brain-kit, a correct entry is still current; a changed base is still outdated', async () => {
  const world = makeScheduleWorld({ roundTools: false });
  writeFileSync(join(world.claudeDir, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const npmBin = join(world.base, 'npm global', 'bin');
  mkdirSync(npmBin, { recursive: true });
  writeFileSync(join(npmBin, 'brain-kit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const node = join(world.base, 'node-dir', 'node');
  mkdirSync(dirname(node), { recursive: true });
  writeFileSync(node, '#!/bin/sh\n', { mode: 0o755 });
  const deps = { node, systemPath: ['/nonexistent-system-dir'] };
  const installed = await world.run(['install', '--platform', 'systemd'], { env: { PATH: `${world.fakeBin}:${npmBin}` }, ...deps });
  assert.equal(installed.status, 0, installed.stderr);
  const status = await world.run(['status', '--platform', 'systemd'], { env: { PATH: world.fakeBin }, ...deps });
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.match(status.stdout, new RegExp(world.t('schedule.status_active', { name: world.name, platform: 'systemd' }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  world.setMachine({ path_extra: ['/opt/tools/bin'] });
  const changed = await world.run(['status', '--platform', 'systemd'], { env: { PATH: world.fakeBin }, ...deps });
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, new RegExp(world.t('schedule.status_outdated', { name: world.name, platform: 'systemd' }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ------------------------------------------------ phase 4, task 4: the briefing's desktop task

const BRIEFING_TASK_ID = `brain-kit-briefing-${VAULT_ID}`;

function setConfig(world, mutate) {
  const file = join(world.vault, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  mutate(config);
  writeFileSync(file, JSON.stringify(config, null, 2));
  return config;
}

function configOf(world) {
  return JSON.parse(readFileSync(join(world.vault, 'brain-kit.config.json'), 'utf8'));
}

// What `install --job briefing` prints on stdout, taken apart: the
// explanation, the four fields, the line that announces the prompt, and
// the prompt's two lines.
function registration(stdout) {
  const lines = stdout.replace(/\n$/, '').split('\n');
  assert.equal(lines.length, 8, stdout);
  const field = (line, name) => {
    assert.ok(line.startsWith(`${name}: `), `${name}: ${line}`);
    return line.slice(name.length + 2);
  };
  return {
    explanation: lines[0],
    taskId: field(lines[1], 'taskId'),
    title: field(lines[2], 'title'),
    cronExpression: field(lines[3], 'cronExpression'),
    description: field(lines[4], 'description'),
    follows: lines[5],
    prompt: lines.slice(6).join('\n'),
    promptLines: lines.slice(6),
  };
}

// The task file as the desktop application would keep it, with a
// frontmatter of its own above the prompt.
function writeTask(world, prompt, { frontmatter = true } = {}) {
  const file = briefingTaskFile(world.env, BRIEFING_TASK_ID);
  mkdirSync(dirname(file), { recursive: true });
  const head = frontmatter ? `---\nname: ${BRIEFING_TASK_ID}\ndescription: the briefing\n---\n\n` : '';
  writeFileSync(file, `${head}${prompt}\n`);
  return file;
}

async function registeredPrompt(world) {
  const r = await world.run(['install', '--job', 'briefing']);
  assert.equal(r.status, 3, r.stderr);
  return registration(r.stdout).prompt;
}

test('install --job briefing prints the task to register in the vault\'s language and exits 3, for a vault under a path with a space and an accent', async () => {
  const expected = {
    en: { title: "brain-kit morning briefing: Ana's Second Brain", run: /^Run exactly this command with Bash and follow what it prints as this session's instructions: / },
    'pt-BR': { title: "Briefing matinal do brain-kit: Ana's Second Brain", run: /^Rode exatamente este comando com o Bash e siga o que ele imprimir como as instruções desta sessão: / },
  };
  for (const [lang, want] of Object.entries(expected)) {
    const world = makeScheduleWorld({ vaultName: 'meu cérebro' });
    const config = setConfig(world, (c) => { c.lang = lang; });
    assert.ok(world.vault.includes(' ') && world.vault.includes(ACCENTED), world.vault);
    const r = await world.run(['install', '--job', 'briefing']);
    assert.equal(r.status, 3, `${lang}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stderr, '', lang);
    const got = registration(r.stdout);
    // The explanation is in the caller's language (the world's translator
    // is English); the task's own texts are in the vault's.
    assert.equal(got.explanation, world.t('schedule.briefing_register', { taskId: BRIEFING_TASK_ID }), lang);
    assert.equal(got.follows, world.t('schedule.briefing_prompt_follows'), lang);
    assert.equal(got.taskId, BRIEFING_TASK_ID, lang);
    assert.equal(got.title, want.title, lang);
    assert.equal(got.cronExpression, '0 9 * * 1-5', lang);
    assert.equal(got.description, createTranslator(lang)('schedule.briefing_description', { vault: world.vault }), lang);
    // Exactly two lines: the signature, then the one instruction.
    assert.equal(got.promptLines.length, 2, lang);
    assert.equal(got.promptLines[0], config.briefing.signature, lang);
    assert.match(got.promptLines[1], want.run, lang);
    assert.ok(got.promptLines[1].endsWith(`node ${kitCommand()} prompt briefing --vault "${world.vault}"`), `${lang}: ${got.promptLines[1]}`);
    // Nothing is written: the task exists only once the application creates it.
    assert.equal(existsSync(join(world.home, '.claude')), false, lang);
    assert.deepEqual(world.commands(), [], lang);
  }
});

test('the command in the task\'s second line runs, through bash, the kit\'s prompt briefing for exactly this vault, whatever the vault\'s name holds', async () => {
  const world = makeScheduleWorld({ vaultName: `Ana's "brain" $HOME \`x\` \\ 100%` });
  const prompt = await registeredPrompt(world);
  const command = prompt.split('\n')[1].slice(prompt.split('\n')[1].indexOf('node "'));
  // A stand-in for node on PATH that prints the arguments bash hands it.
  const bin = join(world.base, 'argv-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'node'), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
  const ran = spawnSync('bash', ['-c', command], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.stdout.replace(/\n$/, '').split('\n'), [KIT_BIN, 'prompt', 'briefing', '--vault', world.vault]);
});

test('the task\'s prompt, as a session\'s first user message, is dropped by the transcripts source as the briefing\'s own run (decision B6)', async () => {
  for (const lang of ['en', 'pt-BR']) {
    const transcripts = makeTranscriptsWorld({ lang, extraSignatures: [] });
    const task = briefingTask({ root: '/home/ana/vault', config: transcripts.config, vaultId: VAULT_ID, env: {} });
    assert.equal(task.problem, undefined, lang);
    transcripts.write(PROJECT, 'briefing.jsonl', [user(task.prompt, INSIDE), assistant('Good morning, Ana.', INSIDE)]);
    const human = transcripts.write(PROJECT, 'ana.jsonl', [user(`Ana pastes the task: ${task.prompt}`, INSIDE)]);
    const plan = transcripts.collect();
    assert.deepEqual(paths(plan), [human], lang);
    assert.equal(plan.dropped.selfTrace, 1, lang);
  }
});

test('install --job briefing refuses with exit 2 when the briefing is off, its signature is blank, two lines or padded, or its schedule is not a cron expression', async () => {
  const bad = (value) => (w) => w.t('schedule.bad_signature', { key: 'briefing.signature', value: JSON.stringify(value), file: 'brain-kit.config.json' });
  const cases = [
    [(c) => { c.briefing.enabled = false; }, (w) => w.t('schedule.briefing_disabled', { file: 'brain-kit.config.json' })],
    [(c) => { c.briefing.signature = '   '; }, bad('   ')],
    [(c) => { c.briefing.signature = 'Morning\nbriefing'; }, bad('Morning\nbriefing')],
    // The review's reproduction (ruling R-T12): a leading space, which the
    // curator's trimmed comparison never matches, and a trailing one.
    [(c) => { c.briefing.signature = ' Second brain morning briefing'; }, bad(' Second brain morning briefing')],
    [(c) => { c.briefing.signature = 'Second brain morning briefing '; }, bad('Second brain morning briefing ')],
    [(c) => { c.briefing.schedule = '09:00'; }, (w) => w.t('schedule.briefing_bad_cron', { value: '"09:00"', file: 'brain-kit.config.json' })],
  ];
  for (const [mutate, message] of cases) {
    const world = makeScheduleWorld();
    setConfig(world, mutate);
    const r = await world.run(['install', '--job', 'briefing']);
    assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', `${message(world)}\n`]);
  }
});

test('install --job briefing warns on stderr when the machine\'s clock and the vault\'s zone differ, and still prints the task', async () => {
  const world = makeScheduleWorld({ timezone: 'America/Argentina/Buenos_Aires' });
  const r = await world.run(['install', '--job', 'briefing'], { localZone: 'Europe/Lisbon' });
  assert.equal(r.status, 3);
  assert.equal(r.stderr, `${world.t('schedule.briefing_timezone_differs', { local: 'Europe/Lisbon', vault: 'America/Argentina/Buenos_Aires' })}\n`);
  assert.equal(registration(r.stdout).taskId, BRIEFING_TASK_ID);
});

test('--job takes curate or briefing; --platform and --dry mean nothing for the briefing', async () => {
  const world = makeScheduleWorld();
  const usage = world.t('schedule.usage');
  const cases = [
    [['install', '--job', 'nightly'], `${world.t('schedule.bad_job', { job: 'nightly', jobs: 'curate, briefing' })}\n${usage}\n`],
    [['install', '--job'], `${world.t('schedule.job_needs_value', { jobs: 'curate, briefing' })}\n${usage}\n`],
    [['status', '--job', 'briefing', '--platform', 'cron'], `${world.t('schedule.bad_argument', { arg: '--platform' })}\n${usage}\n`],
    [['install', '--job', 'briefing', '--dry'], `${world.t('schedule.bad_argument', { arg: '--dry' })}\n${usage}\n`],
  ];
  for (const [argv, stderr] of cases) {
    const r = await world.run(argv);
    assert.deepEqual([r.status, r.stderr], [2, stderr], argv.join(' '));
  }
  // --job curate is the default, spelled out.
  const curate = await world.run(['install', '--job=curate', '--platform', 'systemd', '--dry']);
  assert.equal(curate.status, 0, curate.stderr);
  assert.ok(curate.stdout.includes(`${world.name}.service`), curate.stdout);
});

test('uninstall --job briefing removes nothing, says the task is deleted in the application, and exits 3', async () => {
  const world = makeScheduleWorld();
  const file = writeTask(world, await registeredPrompt(world));
  const r = await world.run(['uninstall', '--job', 'briefing']);
  assert.deepEqual([r.status, r.stdout], [3, `${world.t('schedule.briefing_uninstall', { taskId: BRIEFING_TASK_ID, file })}\n`]);
  assert.ok(existsSync(file));
  assert.deepEqual(world.commands(), []);
});

test('status --job briefing: absent, present and signed, unsigned, and without the kit\'s command (HOME in scratch)', async () => {
  const world = makeScheduleWorld();
  const file = briefingTaskFile(world.env, BRIEFING_TASK_ID);
  assert.ok(file.startsWith(world.home), file);
  const command = 'brain-kit schedule install --job briefing';

  let r = await world.run(['status', '--job', 'briefing']);
  assert.deepEqual([r.status, r.stdout], [1, `${world.t('schedule.briefing_status_absent', { taskId: BRIEFING_TASK_ID, file, command })}\n`]);

  const prompt = await registeredPrompt(world);
  writeTask(world, prompt);
  r = await world.run(['status', '--job', 'briefing']);
  assert.deepEqual([r.status, r.stdout], [0, `${world.t('schedule.briefing_status_ok', { taskId: BRIEFING_TASK_ID, file, kit: KIT_BIN })}\n`]);
  // Without a frontmatter, the same.
  writeTask(world, prompt, { frontmatter: false });
  r = await world.run(['status', '--job', 'briefing']);
  assert.equal(r.status, 0, r.stdout);

  // The signature anywhere but the first line is no signature.
  const signature = configOf(world).briefing.signature;
  writeTask(world, `Good morning\n${prompt}`);
  r = await world.run(['status', '--job', 'briefing']);
  assert.deepEqual([r.status, r.stdout], [1, `${world.t('schedule.briefing_status_unsigned', { taskId: BRIEFING_TASK_ID, file, signature, command })}\n`]);
  // A signature changed in the configuration after registering: the task's
  // sessions would no longer be recognised.
  writeTask(world, prompt);
  setConfig(world, (c) => { c.briefing.signature = 'Another signature'; });
  r = await world.run(['status', '--job', 'briefing']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, `${world.t('schedule.briefing_status_unsigned', { taskId: BRIEFING_TASK_ID, file, signature: 'Another signature', command })}\n`);
  setConfig(world, (c) => { c.briefing.signature = signature; });

  writeTask(world, `${signature}\nRun the brain-kit briefing.`);
  r = await world.run(['status', '--job', 'briefing']);
  assert.deepEqual([r.status, r.stdout], [1, `${world.t('schedule.briefing_status_no_command', { taskId: BRIEFING_TASK_ID, file, command })}\n`]);
});

test('status --job briefing: a kit path that no longer exists (a plugin update moved it) and a task for another vault each say to install again', async () => {
  const world = makeScheduleWorld();
  const command = 'brain-kit schedule install --job briefing';
  const prompt = await registeredPrompt(world);
  const gone = join(world.base, 'plugins', 'cache', 'brain-kit', '0.0.1', 'bin', 'brain-kit.mjs');
  writeTask(world, prompt.replace(kitCommand(), `"${gone}"`));
  let r = await world.run(['status', '--job', 'briefing']);
  assert.deepEqual([r.status, r.stdout], [1, `${world.t('schedule.briefing_status_kit_missing', { taskId: BRIEFING_TASK_ID, kit: gone, command })}\n`]);

  const other = join(world.base, 'other vault');
  mkdirSync(other);
  writeTask(world, prompt.replace(`--vault "${world.vault}"`, `--vault "${other}"`));
  r = await world.run(['status', '--job', 'briefing']);
  assert.deepEqual([r.status, r.stdout], [1, `${world.t('schedule.briefing_status_vault_differs', { taskId: BRIEFING_TASK_ID, vault: other, root: world.vault, command })}\n`]);
});

test('status --job briefing: a task file that cannot be read is said, never read as absent', { skip: process.getuid?.() === 0 && 'root reads every file' }, async () => {
  const world = makeScheduleWorld();
  const file = writeTask(world, await registeredPrompt(world));
  chmodSync(file, 0o000);
  try {
    const r = await world.run(['status', '--job', 'briefing']);
    assert.deepEqual([r.status, r.stdout], [1, `${world.t('schedule.briefing_status_unreadable', { taskId: BRIEFING_TASK_ID, file, detail: 'EACCES' })}\n`]);
  } finally {
    chmodSync(file, 0o600);
  }
});

test('status --job briefing with briefing.enabled false: nothing registered is fine, a task still registered is not', async () => {
  const world = makeScheduleWorld();
  const prompt = await registeredPrompt(world);
  setConfig(world, (c) => { c.briefing.enabled = false; });
  let r = await world.run(['status', '--job', 'briefing']);
  assert.deepEqual([r.status, r.stdout], [0, `${world.t('schedule.briefing_status_disabled', { file: 'brain-kit.config.json' })}\n`]);
  const file = writeTask(world, prompt);
  r = await world.run(['status', '--job', 'briefing']);
  assert.deepEqual([r.status, r.stdout], [1, `${world.t('schedule.briefing_status_disabled_registered', { taskId: BRIEFING_TASK_ID, file, config: 'brain-kit.config.json' })}\n`]);
});

test('the CLI routes schedule install --job briefing to the task, exit 3, in the vault\'s language', () => {
  const world = makeScheduleWorld();
  setConfig(world, (c) => { c.lang = 'pt-BR'; });
  const r = spawnSync(process.execPath, [KIT_BIN, 'schedule', 'install', '--job', 'briefing', world.vault], { env: { ...world.env, BRAIN_KIT_LANG: 'en' }, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stderr);
  const got = registration(r.stdout);
  assert.equal(got.taskId, BRIEFING_TASK_ID);
  assert.match(got.promptLines[1], /^Rode exatamente este comando/);
});

// ------------------------------------------------ fix round 1, ruling R-T12: one predicate signs a session

// What the curator does with a session whose first user message is `text`,
// under a configuration whose briefing signature is `signature`: true when
// the transcripts source drops it as one of the kit's own runs.
function curatorDrops(signature, text) {
  const transcripts = makeTranscriptsWorld({ extraSignatures: [] });
  transcripts.config.briefing.signature = signature;
  transcripts.write(PROJECT, 'session.jsonl', [user(text, INSIDE), assistant('Good morning.', INSIDE)]);
  const plan = transcripts.collect();
  assert.equal(plan.dropped.selfTrace + paths(plan).length, 1, JSON.stringify(plan.dropped));
  return plan.dropped.selfTrace === 1;
}

test('status and the curator\'s filter agree, on every signature and first line, whether a task\'s sessions are the briefing\'s own', async () => {
  const world = makeScheduleWorld();
  const line2 = (await registeredPrompt(world)).split('\n')[1];
  const sig = 'Second brain morning briefing';
  const signatures = [sig, ` ${sig}`, `${sig} `, `${sig}\t`, 'Second brain'];
  const prompts = [
    `${sig}\n${line2}`, ` ${sig}\n${line2}`, `${sig} \n${line2}`, `\n\n${sig}\n${line2}`, `${sig} extra words\n${line2}`,
    `Good morning\n${sig}\n${line2}`, `${sig.toLowerCase()}\n${line2}`, `Second brain\n${line2}`, `${line2}\n${sig}`,
  ];
  let signedSeen = 0;
  let unsignedSeen = 0;
  for (const signature of signatures) {
    const config = configOf(world);
    config.briefing.signature = signature;
    for (const prompt of prompts) {
      for (const frontmatter of [true, false]) {
        writeTask(world, prompt, { frontmatter });
        const found = readBriefingTask({ root: world.vault, config, vaultId: VAULT_ID, env: world.env });
        const drops = curatorDrops(signature, prompt);
        assert.equal(found.signed, drops, `${JSON.stringify(signature)} / ${JSON.stringify(prompt.split('\n')[0])}: status says signed=${found.signed} (${found.state}), the curator drops=${drops}`);
        assert.equal(found.signed, startsWithSignature(prompt, [signature]));
        // "Working" is only ever said of a session the curator drops.
        if (found.state === 'ok' || found.state === 'kit_other') assert.equal(drops, true);
        if (found.signed) signedSeen += 1; else unsignedSeen += 1;
      }
    }
  }
  assert.ok(signedSeen > 0 && unsignedSeen > 0, `${signedSeen} ${unsignedSeen}`);
});

test('the review\'s leading-space signature end to end: install refuses naming the key, a hand-written task reads refused, and the curator keeps its sessions', async () => {
  const world = makeScheduleWorld();
  const line2 = (await registeredPrompt(world)).split('\n')[1];
  const padded = ' Second brain morning briefing';
  setConfig(world, (c) => { c.briefing.signature = padded; });
  const message = world.t('schedule.bad_signature', { key: 'briefing.signature', value: JSON.stringify(padded), file: 'brain-kit.config.json' });
  const install = await world.run(['install', '--job', 'briefing']);
  assert.deepEqual([install.status, install.stdout, install.stderr], [2, '', `${message}\n`]);
  // The task the person might write by hand from the configuration.
  writeTask(world, `${padded}\n${line2}`);
  const status = await world.run(['status', '--job', 'briefing']);
  assert.deepEqual([status.status, status.stdout], [1, `${message}\n`]);
  const found = readBriefingTask({ root: world.vault, config: configOf(world), vaultId: VAULT_ID, env: world.env });
  assert.equal(found.state, 'bad_signature');
  assert.equal(found.signed, false);
  assert.equal(curatorDrops(padded, `${padded}\n${line2}`), false);
});

test('install of the curator refuses a curate signature or extra signature with space at either end, naming each key', async () => {
  const world = makeScheduleWorld();
  setConfig(world, (c) => { c.curate.signature = 'Second brain curator '; c.curate.extra_signatures = ['ok one', ' padded']; });
  const r = await world.run(['install', '--platform', 'systemd']);
  const line = (key, value) => world.t('schedule.bad_signature', { key, value: JSON.stringify(value), file: 'brain-kit.config.json' });
  assert.deepEqual([r.status, r.stderr], [2, `${line('curate.signature', 'Second brain curator ')}\n${line('curate.extra_signatures[1]', ' padded')}\n`]);
  assert.equal(existsSync(world.unitDir), false);
});

test('status --job briefing: a task running an existing kit that is not this one warns with both paths and versions, never fails', async () => {
  const world = makeScheduleWorld();
  const prompt = await registeredPrompt(world);
  const oldKit = join(world.base, 'plugins', 'cache', 'brain-kit', '0.0.1', 'bin', 'brain-kit.mjs');
  mkdirSync(dirname(oldKit), { recursive: true });
  writeFileSync(oldKit, '');
  writeFileSync(join(dirname(dirname(oldKit)), 'package.json'), JSON.stringify({ name: 'brain-kit', version: '0.0.1' }));
  writeTask(world, prompt.replace(kitCommand(), `"${oldKit}"`));
  const currentVersion = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8')).version;
  const r = await world.run(['status', '--job', 'briefing']);
  assert.deepEqual([r.status, r.stdout], [0, `${world.t('schedule.briefing_status_kit_other', {
    taskId: BRIEFING_TASK_ID, kit: oldKit, version: '0.0.1', current: KIT_BIN, currentVersion, command: 'brain-kit schedule install --job briefing',
  })}\n`]);
});

test('status --job briefing reads the command from the prompt only, never from a frontmatter field the application writes', async () => {
  const world = makeScheduleWorld();
  const prompt = await registeredPrompt(world);
  const file = briefingTaskFile(world.env, BRIEFING_TASK_ID);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: ${BRIEFING_TASK_ID}\ndescription: was node "/nowhere/bin/brain-kit.mjs" prompt briefing --vault "/elsewhere"\n---\n\n${prompt}\n`);
  const r = await world.run(['status', '--job', 'briefing']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stdout, `${world.t('schedule.briefing_status_ok', { taskId: BRIEFING_TASK_ID, file, kit: KIT_BIN })}\n`);
});
