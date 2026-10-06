// 05/10/2026 (docs/incidents.md, "the first run on Windows"): a reader set
// the kit up on Windows 10 and found the manual flow working and three parts
// not. The briefing's task was refused (the kit's path, spelt with
// backslashes, failed the check for characters a bash word cannot carry);
// the scheduled curator could not run (no scheduler was installed on
// Windows, every state directory was one no read rule could name, the vault's
// Claude Code project was never derived from a Windows path, and the state
// directory always failed the 0700 check, since Node reports 0666 for every
// directory there); and doctor called node, gh and the kit on PATH missing,
// because it looked a program up by its bare name, without PATHEXT, and ran
// npm's sh launcher without a shell.
//
// The rules (src/platform.mjs): a program is looked up as a shell looks it
// up; a path in a permission rule is written in the POSIX form Claude Code
// matches rules in; the kit's own path, in a Bash command, is spelt with
// slashes; who may open the state directory is its ACL, read and set by SID;
// a batch launcher is named as such, never started; and Windows gets its
// own scheduler, the Task Scheduler.
//
// Most tests below reach the Windows branch on any machine through each
// function's `platform` seam and fakes of whoami, icacls, PowerShell and
// schtasks. The last ones need Windows itself, and run only there (the CI's
// windows job): the real lookup, the real ACL, a real task registered,
// read back and removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ADMINISTRATORS_SID, SYSTEM_SID, aclVerdict, currentUserSid, envValue, findProgram, isDiskRoot, npmShimTarget, pathEntries,
  programNames, restrictToOwner, ruleFormOf, slashed, startsWithoutShell, withPathPrefix,
} from '../../src/platform.mjs';
import { allowedTools, kitCommand, kitCommandIn } from '../../src/curate/tools.mjs';
import { unsafeRuleCharacters } from '../../src/curate/rule-path.mjs';
import { mirrorUserRules } from '../../src/curate/user-rules.mjs';
import { claudeProjectName } from '../../src/sources/transcripts-claude-code.mjs';
import { briefingTask } from '../../src/commands/schedule.mjs';
import { MACHINE_CHECKS, buildContext, runChecks } from '../../src/doctor/checks.mjs';
import { checkCli } from '../../src/guards/cli.mjs';
import { WINDOWS_READ_RULES_BUDGET, readGrantsOf } from '../../src/commands/curate.mjs';
import { ensureStateDir } from '../../src/state.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';
import { makeScheduleWorld, VAULT_ID } from '../helpers/schedule-world.mjs';

const ON_WINDOWS = process.platform === 'win32';
const USER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OTHER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
const PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

// A stand-in for run(): answers by program, and records each call.
function fakeRun(answers) {
  const calls = [];
  const runner = (program, args, options = {}) => {
    calls.push({ program, args, env: options.env });
    const answer = answers[program];
    const result = typeof answer === 'function' ? answer(args, options) : answer;
    return { status: 0, stdout: '', stderr: '', ...(result ?? { status: 1, stderr: `${program}: not faked` }) };
  };
  runner.calls = calls;
  return runner;
}

const WHOAMI = { stdout: `"desktop-1\\ana","${USER_SID}"\r\n` };

function aclLines(entries) {
  return { stdout: `${entries.map(([sid, type = 'Allow', rights = 2032127]) => `${sid}|${type}|${rights}`).join('\r\n')}\r\n` };
}

// --- looking a program up the way a shell does ------------------------------

test('on Windows a program is looked up with PATHEXT, in its order, PATH spelt Path included; elsewhere by its name alone', () => {
  assert.deepEqual(programNames('node', { platform: 'win32', env: { PATHEXT: '.COM;.EXE;.CMD' } }), ['node.com', 'node.exe', 'node.cmd']);
  assert.deepEqual(programNames('node.exe', { platform: 'win32', env: { PATHEXT: '.COM;.EXE' } }), ['node.exe']);
  assert.deepEqual(programNames('node', { platform: 'linux', env: { PATHEXT } }), ['node']);
  // No PATHEXT at all: the default of Windows 10.
  assert.ok(programNames('gh', { platform: 'win32', env: {} }).includes('gh.exe'));

  const dir = makeTempDir('brain-kit-win-path-');
  const npm = join(dir, 'npm');
  const nodejs = join(dir, 'Program Files', 'nodejs');
  mkdirSync(npm, { recursive: true });
  mkdirSync(nodejs, { recursive: true });
  writeFileSync(join(nodejs, 'node.exe'), '');
  writeFileSync(join(npm, 'brain-kit'), '#!/bin/sh\n');
  writeFileSync(join(npm, 'brain-kit.cmd'), '@ECHO off\r\n');
  // A copy of a Windows environment keeps PATH as `Path`.
  const env = { Path: `${npm};"${nodejs}"`, PATHEXT };
  assert.equal(envValue(env, 'PATH', 'win32'), env.Path);
  assert.equal(envValue(env, 'PATH', 'linux'), undefined);
  const dirs = pathEntries(env, 'win32');
  assert.equal(findProgram('node', dirs, { platform: 'win32', env }), join(nodejs, 'node.exe'), 'a quoted PATH entry is read without its quotes');
  assert.equal(findProgram('brain-kit', dirs, { platform: 'win32', env }), join(npm, 'brain-kit.cmd'));
  assert.equal(findProgram('gh', dirs, { platform: 'win32', env }), null);
  assert.equal(startsWithoutShell(join(nodejs, 'node.exe'), 'win32'), true);
  assert.equal(startsWithoutShell(join(npm, 'brain-kit.cmd'), 'win32'), false);
  assert.equal(startsWithoutShell(join(npm, 'brain-kit.cmd'), 'linux'), true);

  // A PATH put in front of, with every other spelling of the name dropped.
  const prefixed = withPathPrefix({ Path: 'C:\\Windows', HOME: 'h' }, ['C:\\tools'], 'win32');
  assert.deepEqual(prefixed, { HOME: 'h', PATH: 'C:\\tools;C:\\Windows' });
  assert.deepEqual(withPathPrefix({ PATH: '/usr/bin' }, ['/opt/x'], 'linux'), { PATH: '/opt/x:/usr/bin' });
});

test('npm\'s launchers are read for the script they start, never run, and anything else is no launcher', () => {
  const npm = makeTempDir('brain-kit-win-shim-');
  const script = join(npm, 'node_modules', 'second-brain-kit', 'bin', 'brain-kit.mjs');
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, '');
  writeFileSync(join(npm, 'brain-kit'), [
    '#!/bin/sh',
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    'if [ -x "$basedir/node" ]; then',
    '  exec "$basedir/node"  "$basedir/node_modules/second-brain-kit/bin/brain-kit.mjs" "$@"',
    'else ',
    '  exec node  "$basedir/node_modules/second-brain-kit/bin/brain-kit.mjs" "$@"',
    'fi',
    '',
  ].join('\n'));
  writeFileSync(join(npm, 'brain-kit.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\second-brain-kit\\bin\\brain-kit.mjs" %*',
    '',
  ].join('\r\n'));
  writeFileSync(join(npm, 'other'), '#!/bin/sh\nexec node "$basedir/../elsewhere.mjs"\n');
  writeFileSync(join(npm, 'climbs'), '#!/bin/sh\nexec node "$basedir/node_modules/../../x.mjs"\n');
  assert.equal(npmShimTarget(join(npm, 'brain-kit')), script);
  assert.equal(npmShimTarget(join(npm, 'brain-kit.cmd')), script);
  assert.equal(npmShimTarget(join(npm, 'other')), null);
  assert.equal(npmShimTarget(join(npm, 'climbs')), null);
  assert.equal(npmShimTarget(join(npm, 'absent')), null);
});

// --- paths: the briefing's task, the rules, the project ---------------------

test('the briefing\'s task: on Windows the kit and the vault are spelt with slashes, and the task is no longer refused', () => {
  assert.equal(slashed('C:\\Users\\Desenvolvedor\\.claude\\plugins\\cache\\brain-kit\\brain-kit\\0.1.0\\bin\\brain-kit.mjs', 'win32'),
    'C:/Users/Desenvolvedor/.claude/plugins/cache/brain-kit/brain-kit/0.1.0/bin/brain-kit.mjs');
  assert.equal(slashed('/home/ana/a\\b', 'linux'), '/home/ana/a\\b', 'a backslash is a character of a name on POSIX');
  assert.doesNotMatch(kitCommand('win32'), /\\/);
  assert.match(kitCommandIn('C:\\Users\\ana\\my-brain', 'win32'), / -C "C:\/Users\/ana\/my-brain"$/);
  const config = { vault: { title: 'Ana', timezone: 'America/Sao_Paulo' }, briefing: { enabled: true } };
  const task = briefingTask({ root: 'C:\\Users\\Desenvolvedor\\my-brain', config, vaultId: VAULT_ID, env: {}, platform: 'win32' });
  assert.equal(task.problem, undefined, JSON.stringify(task.problem));
  assert.match(task.command, /prompt briefing --vault "C:\/Users\/Desenvolvedor\/my-brain"$/);
  assert.doesNotMatch(task.command, /\\/);
});

test('a read rule names a Windows path in the POSIX form Claude Code matches, and a whole drive is refused like /', () => {
  assert.equal(ruleFormOf('C:\\Users\\Ana Silva\\.claude\\projects\\x.jsonl', 'win32'), '/c/Users/Ana Silva/.claude/projects/x.jsonl');
  assert.equal(ruleFormOf('D:/data', 'win32'), '/d/data');
  assert.equal(ruleFormOf('\\\\server\\share\\x', 'win32'), '\\\\server\\share\\x', 'a UNC path stays as it is, and is refused below');
  assert.equal(ruleFormOf('C:\\x', 'linux'), 'C:\\x');
  assert.equal(isDiskRoot('/c', 'win32'), true);
  assert.equal(isDiskRoot('/c/Users', 'win32'), false);
  assert.equal(isDiskRoot('/c', 'linux'), false);

  // The state directory of the report: a backslash separated its folders,
  // and every round with a transcript stopped (digest_dir_unsafe).
  const digests = 'C:\\Users\\Desenvolvedor\\.local\\state\\brain-kit\\my-brain-ac599029\\digests';
  assert.deepEqual(unsafeRuleCharacters(digests, 'win32'), []);
  assert.deepEqual(unsafeRuleCharacters(digests, 'linux'), ['\\']);
  assert.deepEqual(unsafeRuleCharacters('C:\\Users\\ana\\(old)', 'win32'), ['(', ')'], 'what a rule cannot carry is still refused');

  const tools = allowedTools([], { readFiles: [`${digests}\\a.txt`], readDirs: ['C:\\Users\\ana\\inbox\\'], platform: 'win32' });
  assert.ok(tools.includes('Read(//c/Users/Desenvolvedor/.local/state/brain-kit/my-brain-ac599029/digests/a.txt)'), tools.join('\n'));
  assert.ok(tools.includes('Read(//c/Users/ana/inbox/**)'), tools.join('\n'));
  assert.ok(tools.filter((rule) => rule.startsWith('Bash(')).every((rule) => !rule.includes('\\')));
  assert.throws(() => allowedTools([], { readDirs: ['C:\\'], platform: 'win32' }), /root of the file system/);
  assert.throws(() => allowedTools([], { readFiles: ['\\\\server\\share\\x'], platform: 'win32' }), /not an absolute path/);
});

test('on Windows, digests past what a command line holds are granted by their round\'s folder, which holds nothing else; one by one otherwise', () => {
  const dir = 'C:\\Users\\ana\\.local\\state\\brain-kit\\my-brain-ac599029\\digests\\2026-10-05T09-30-00Z-0a1b2c3d';
  const plan = (count) => ({ transcripts: { digestDir: dir, files: Array.from({ length: count }, (_, i) => ({ digest: { path: `${dir}\\${String(i + 1).padStart(3, '0')}-0a1b2c3d.txt` } })) } });
  const sources = [{ id: 'transcripts', kind: 'local' }, { id: 'calendar', kind: 'connector' }];
  const few = readGrantsOf(sources, plan(10), 'win32');
  assert.deepEqual([few.readFiles.length, few.readDirs], [10, []]);
  const many = plan(400);
  assert.ok(many.transcripts.files.reduce((sum, f) => sum + f.digest.path.length, 0) > WINDOWS_READ_RULES_BUDGET);
  assert.deepEqual(readGrantsOf(sources, many, 'win32'), { readFiles: [], readDirs: [dir] });
  assert.equal(readGrantsOf(sources, many, 'linux').readFiles.length, 400, 'elsewhere a command line holds them all');
  const rules = allowedTools([], { ...readGrantsOf(sources, many, 'win32'), platform: 'win32' }).filter((rule) => rule.startsWith('Read(//'));
  assert.deepEqual(rules, ['Read(//c/Users/ana/.local/state/brain-kit/my-brain-ac599029/digests/2026-10-05T09-30-00Z-0a1b2c3d/**)']);
});

test('the vault\'s Claude Code project is derived from a Windows path: C:\\Users\\Desenvolvedor\\my-brain is C--Users-Desenvolvedor-my-brain', () => {
  assert.equal(claudeProjectName('C:\\Users\\Desenvolvedor\\my-brain', 'win32'), 'C--Users-Desenvolvedor-my-brain');
  assert.equal(claudeProjectName('C:\\Users\\Desenvolvedor\\my-brain', 'linux'), null);
  assert.equal(claudeProjectName('\\\\server\\share\\brain', 'win32'), null);
  assert.equal(claudeProjectName('/home/ana/brain', 'win32'), '-home-ana-brain');
});

test('the person\'s own rules are judged in the same POSIX form on Windows: inside the vault, beside it, over it', () => {
  const dir = makeTempDir('brain-kit-win-rules-');
  const file = join(dir, 'settings.json');
  const KIT = '"C:/kit/bin/brain-kit.mjs"';
  writeFileSync(file, JSON.stringify({ permissions: { allow: ['Read(//c/Users/ana/brain/notes/**)', 'Read(//c/Users/ana/Documents/**)', 'Edit(//c/Users/ana/**)', 'Read(~/Downloads/**)'] } }));
  const out = mirrorUserRules({ files: [file], ownAllowed: ['Read(./**)'], vaultRoot: 'C:\\Users\\ana\\brain', home: 'C:\\Users\\ana', kit: KIT, platform: 'win32' });
  assert.ok(out.deny.includes('Read(//c/Users/ana/Documents/**)'), JSON.stringify(out));
  assert.ok(out.deny.includes('Read(//c/Users/ana/Downloads/**)'), JSON.stringify(out));
  assert.ok(!out.deny.some((rule) => rule.includes('/brain/notes')), 'a read inside the vault is the round\'s own');
  assert.deepEqual(out.blocking.map((entry) => [entry.rule, entry.reason]), [['Edit(//c/Users/ana/**)', 'covers_vault']]);
});

// --- who may open the state directory ---------------------------------------

test('the ACL is read and set by SID: private, open to another account, or not verified', () => {
  assert.equal(currentUserSid({ run: fakeRun({ whoami: WHOAMI }) }), USER_SID);
  assert.equal(currentUserSid({ run: fakeRun({ whoami: { stdout: '"desktop-1\\ana","not a sid"\r\n' } }) }), null);

  const own = [[USER_SID], [SYSTEM_SID], [ADMINISTRATORS_SID], ['S-1-1-0', 'Deny']];
  let runner = fakeRun({ whoami: WHOAMI, 'powershell.exe': aclLines(own) });
  assert.deepEqual(aclVerdict('C:\\state', { run: runner }), { state: 'private' });
  const ps = runner.calls.find((call) => call.program === 'powershell.exe');
  assert.equal(ps.env.BRAIN_KIT_ACL_PATH, 'C:\\state', 'the path travels in the environment');
  assert.ok(!ps.args.join(' ').includes('C:\\state'), 'and never inside the script');

  runner = fakeRun({ whoami: WHOAMI, 'powershell.exe': aclLines([...own, [OTHER_SID]]) });
  assert.deepEqual(aclVerdict('C:\\state', { run: runner }), { state: 'open', sids: [OTHER_SID] });
  runner = fakeRun({ whoami: WHOAMI, 'powershell.exe': { status: 1, stderr: 'Get-Acl : access denied' } });
  assert.deepEqual(aclVerdict('C:\\state', { run: runner }), { state: 'unverified', error: 'Get-Acl : access denied' });
  runner = fakeRun({ whoami: WHOAMI, 'powershell.exe': { stdout: 'BUILTIN\\Administradores|Allow|1\r\n' } });
  assert.equal(aclVerdict('C:\\state', { run: runner }).state, 'unverified', 'a line that is not a SID is never guessed at');

  // Restricting: inheritance dropped, the three granted by SID; an entry for
  // anyone else that survives is removed by SID too.
  let acl = [...own, [OTHER_SID]];
  runner = fakeRun({
    whoami: WHOAMI,
    icacls: (args) => {
      if (args.includes('/remove:g')) acl = acl.filter(([sid]) => sid !== OTHER_SID);
      return { status: 0 };
    },
    'powershell.exe': () => aclLines(acl),
  });
  assert.deepEqual(restrictToOwner('C:\\state', { run: runner }), { ok: true });
  const icacls = runner.calls.filter((call) => call.program === 'icacls').map((call) => call.args);
  assert.deepEqual(icacls[0], ['C:\\state', '/inheritance:r', '/grant:r', `*${USER_SID}:(OI)(CI)F`, '/grant:r', `*${SYSTEM_SID}:(OI)(CI)F`, '/grant:r', `*${ADMINISTRATORS_SID}:(OI)(CI)F`]);
  assert.deepEqual(icacls[1], ['C:\\state', '/remove:g', `*${OTHER_SID}`]);
  assert.deepEqual(restrictToOwner('C:\\state', { run: fakeRun({ whoami: WHOAMI, icacls: { status: 5, stderr: 'Access is denied.' } }) }), { ok: false, error: 'Access is denied.' });
});

test('the state directory is made private when it is created and when init or register tighten it, on Windows only', () => {
  const base = makeTempDir('brain-kit-win-state-');
  const calls = [];
  const restrict = (dir, options) => {
    calls.push([dir, options]);
    return { ok: true };
  };
  const dir = join(base, 'state', 'vault-1');
  ensureStateDir(dir, { platform: 'win32', restrict });
  ensureStateDir(dir, { platform: 'win32', restrict });
  ensureStateDir(dir, { platform: 'win32', restrict, tighten: true });
  ensureStateDir(join(base, 'posix'), { platform: 'linux', restrict });
  assert.deepEqual(calls, [[dir, { directory: true }], [dir, { directory: true }]]);
  assert.throws(() => ensureStateDir(join(base, 'denied'), { platform: 'win32', restrict: () => ({ ok: false, error: 'Access is denied.' }) }), /Access is denied/);
});

// --- doctor -------------------------------------------------------------------

// A machine of Windows on this one: programs with their extensions on a
// PATH spelt Path, npm's two launchers, and node.exe a stand-in that
// answers its version and otherwise runs the real node.
function windowsMachine() {
  const base = realpathSync(makeTempDir('brain-kit-win-doctor-'));
  const nodejs = join(base, 'Program Files', 'nodejs');
  const npm = join(base, 'AppData', 'Roaming', 'npm');
  const ghDir = join(base, 'Program Files', 'GitHub CLI');
  const script = join(npm, 'node_modules', 'second-brain-kit', 'bin', 'brain-kit.mjs');
  for (const d of [nodejs, ghDir, dirname(script)]) mkdirSync(d, { recursive: true });
  writeFileSync(join(nodejs, 'node.exe'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${process.versions.node}; exit 0; fi\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(ghDir, 'gh.exe'), '#!/bin/sh\necho "gh version 2.60.0 (2026-01-01)"\n', { mode: 0o755 });
  writeFileSync(script, 'console.log("0.1.0");\n');
  writeFileSync(join(npm, 'brain-kit'), '#!/bin/sh\nexec node  "$basedir/node_modules/second-brain-kit/bin/brain-kit.mjs" "$@"\n');
  writeFileSync(join(npm, 'brain-kit.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\second-brain-kit\\bin\\brain-kit.mjs" %*\r\n');
  return { base, nodejs, npm, ghDir, script, env: { Path: [npm, nodejs, ghDir].join(';'), PATHEXT } };
}

function check(results, id) {
  const found = results.find((result) => result.id === id);
  assert.ok(found, `${id}: ${JSON.stringify(results)}`);
  return found;
}

test('doctor on Windows finds node.exe and gh.exe, and asks npm\'s launcher\'s script for its version', () => {
  const machine = windowsMachine();
  const ctx = buildContext({ root: machine.base, hasVault: false, env: machine.env, platform: 'win32', engineVersion: '0.1.0', nodeVersion: process.versions.node, execPath: join(machine.nodejs, 'node.exe') });
  const results = runChecks(ctx, ['node-version', 'brain-kit-on-path', 'gh-present'], MACHINE_CHECKS);
  assert.equal(check(results, 'node-version').status, 'ok', JSON.stringify(results));
  assert.equal(check(results, 'gh-present').status, 'ok', JSON.stringify(results));
  const kit = check(results, 'brain-kit-on-path');
  assert.deepEqual([kit.status, kit.messageKey, kit.params.version], ['ok', 'doctor.brain_kit_on_path.ok', '0.1.0'], JSON.stringify(kit));

  // A launcher npm did not write is not run, and is said to be unchecked.
  writeFileSync(join(machine.npm, 'brain-kit.cmd'), '@ECHO off\r\nnode C:\\elsewhere\\kit.mjs %*\r\n');
  writeFileSync(join(machine.npm, 'brain-kit'), '#!/bin/sh\nexec node /elsewhere/kit.mjs "$@"\n');
  const unread = check(runChecks(buildContext({ root: machine.base, hasVault: false, env: machine.env, platform: 'win32', engineVersion: '0.1.0' }), ['brain-kit-on-path'], MACHINE_CHECKS), 'brain-kit-on-path');
  assert.deepEqual([unread.status, unread.messageKey], ['warn', 'doctor.brain_kit_on_path.launcher_unread']);
});

test('a claude that is a batch launcher (npm\'s claude.cmd) is named as one, never started, by doctor and by the round\'s guard', () => {
  const dir = makeTempDir('brain-kit-win-claude-');
  const cmd = join(dir, 'claude.cmd');
  writeFileSync(cmd, `@ECHO off\r\n${'rem padding\r\n'.repeat(400)}`);
  const cli = checkCli('claude', { env: { Path: dir, PATHEXT }, platform: 'win32' });
  assert.deepEqual([cli.ok, cli.problem, cli.messageKey], [false, 'batch', 'harness.cli.batch']);
  const results = runChecks(buildContext({ root: dir, hasVault: false, env: { Path: dir, PATHEXT }, platform: 'win32' }), ['claude-present', 'claude-real'], MACHINE_CHECKS);
  assert.equal(check(results, 'claude-present').messageKey, 'doctor.claude_present.batch');
  assert.equal(check(results, 'claude-real').messageKey, 'doctor.claude_real.batch');
});

test('state-dir-mode on Windows reads the ACL, never the mode Node reports', () => {
  const root = makeTempDir('brain-kit-win-vault-');
  const state = makeTempDir('brain-kit-win-statedir-');
  writeFileSync(join(state, 'machine.json'), '{}');
  const run = (verdicts) => {
    const ctx = buildContext({ root, env: { BRAIN_KIT_STATE_DIR: state }, platform: 'win32', acl: (path) => verdicts[path === state ? 'dir' : 'file'] });
    return check(runChecks(ctx, ['state-dir-mode']), 'state-dir-mode');
  };
  assert.equal(run({ dir: { state: 'private' }, file: { state: 'private' } }).messageKey, 'doctor.state_dir_mode.ok_acl');
  const open = run({ dir: { state: 'private' }, file: { state: 'open', sids: [OTHER_SID] } });
  assert.deepEqual([open.status, open.messageKey, open.params.sids, open.params.command], ['fail', 'doctor.state_dir_mode.acl_open', [OTHER_SID], 'brain-kit machine register']);
  const unverified = run({ dir: { state: 'unverified', error: 'no PowerShell' }, file: { state: 'private' } });
  assert.deepEqual([unverified.status, unverified.messageKey], ['warn', 'doctor.state_dir_mode.acl_unverified']);
});

// --- the scheduled curator: the Task Scheduler --------------------------------

// The schedule world on Windows: LOCALAPPDATA and SystemRoot of its own,
// brain-kit.cmd, gh.exe and git.exe beside claude, the account's SID, and a
// stand-in for schtasks and PowerShell that keeps the registered task.
function windowsScheduleWorld(options = {}) {
  const world = makeScheduleWorld({ ...options, roundTools: false, fakes: [] });
  for (const name of ['brain-kit.cmd', 'gh.exe', 'git.exe']) writeFileSync(join(world.claudeDir, name), '');
  const localAppData = join(world.home, 'AppData', 'Local');
  const scheduleDir = join(localAppData, 'brain-kit', 'schedule');
  const env = { LOCALAPPDATA: localAppData, SystemRoot: 'C:\\Windows', PATHEXT };
  let task = null;
  const runner = fakeRun({
    schtasks: (args) => {
      if (args[0] === '/Create') {
        const xml = readFileSync(args[args.indexOf('/XML') + 1]);
        assert.deepEqual([...xml.subarray(0, 2)], [0xff, 0xfe], 'the task\'s XML is UTF-16 with its byte order mark');
        const text = xml.subarray(2).toString('utf16le');
        task = {
          state: 'Ready',
          execute: /<Command>([^<]*)<\/Command>/.exec(text)[1],
          arguments: /<Arguments>([^<]*)<\/Arguments>/.exec(text)[1].replace(/&quot;/g, '"'),
          starts: [...text.matchAll(/<StartBoundary>([^<]*)<\/StartBoundary>/g)].map((m) => m[1]),
        };
        return { status: 0 };
      }
      if (args[0] === '/Delete') {
        if (task === null) return { status: 1, stderr: 'ERROR: The system cannot find the file specified.' };
        task = null;
        return { status: 0 };
      }
      return { status: 2 };
    },
    'powershell.exe': () => ({ stdout: `${JSON.stringify(task ?? { state: 'absent' })}\r\n` }),
  });
  const run = (argv, deps = {}) => world.run(argv, { platform: 'win32', sid: USER_SID, run: runner, ...deps, env: { ...env, ...(deps.env ?? {}) } });
  return {
    ...world, run, runner, scheduleDir,
    batch: join(scheduleDir, `${world.name}.cmd`),
    xml: join(scheduleDir, `${world.name}.xml`),
    disable() { task.state = 'Disabled'; },
  };
}

test('schedule on Windows: --dry shows the batch file and the task, writes nothing and registers nothing', async () => {
  const w = windowsScheduleWorld();
  const r = await w.run(['install', '--dry']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`--- ${w.batch}`), r.stdout);
  assert.ok(r.stdout.includes(`--- ${w.xml}`), r.stdout);
  assert.match(r.stdout, /^set "PATH=[^\n]*;C:\\Windows\\System32;C:\\Windows;/m, 'the PATH is joined at ; with the system directories of Windows');
  assert.match(r.stdout, /^set "LC_ALL=C\.UTF-8"/m);
  assert.doesNotMatch(r.stdout, /^set "TZ=/m, 'no zone name is handed to the programs of Windows');
  assert.ok(r.stdout.includes(`"${process.execPath}" "${join(dirname(dirname(new URL('../../src/version.mjs', import.meta.url).pathname)), 'bin', 'brain-kit.mjs')}" "curate" "${w.vault}"`), r.stdout);
  assert.equal((r.stdout.match(/<CalendarTrigger>/g) ?? []).length, 3);
  assert.match(r.stdout, /<StartWhenAvailable>false<\/StartWhenAvailable>/);
  assert.match(r.stdout, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.ok(r.stdout.includes(`<UserId>${USER_SID}</UserId>`), r.stdout);
  assert.ok(r.stdout.includes(`$ schtasks /Create /TN ${w.name} /XML`), r.stdout);
  assert.equal(existsSync(w.scheduleDir), false);
  assert.deepEqual(w.runner.calls.map((call) => call.program), []);
});

test('schedule on Windows: install registers the task, status reads it back, a disabled task is said, and uninstall removes it', async () => {
  const w = windowsScheduleWorld();
  const installed = await w.run(['install']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.ok(installed.stdout.includes(createTranslator('en')('schedule.windows_console')), installed.stdout);
  const batch = readFileSync(w.batch, 'utf8');
  assert.match(batch, /\r\n/, 'a batch file has Windows line endings');
  assert.doesNotMatch(batch, /[^\r]\n/);
  assert.match(batch, /^chcp 65001 >nul\r$/m, 'the accented paths are read as UTF-8');

  let status = await w.run(['status']);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.ok(status.stdout.includes(`${w.name} (taskscheduler) is installed`), status.stdout);

  w.disable();
  status = await w.run(['status']);
  assert.equal(status.status, 1);
  assert.ok(status.stdout.includes('(Disabled)'), status.stdout);

  // A task whose files no longer match what install would write now.
  writeFileSync(w.batch, batch.replace('chcp 65001', 'rem edited'));
  status = await w.run(['status']);
  assert.equal(status.status, 1);
  assert.ok(status.stdout.includes('no longer matches'), status.stdout);

  const removed = await w.run(['uninstall']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(w.batch) || existsSync(w.xml), false);
  assert.ok(w.runner.calls.some((call) => call.program === 'schtasks' && call.args[0] === '/Delete'));
  const again = await w.run(['uninstall']);
  assert.equal(again.status, 0);
  assert.ok(again.stdout.includes('not installed'), again.stdout);
});

test('schedule on Windows refuses a percent sign, a platform of another system, and an account whose SID cannot be read', async () => {
  const percent = windowsScheduleWorld({ vaultName: '100% brain' });
  let r = await percent.run(['install']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /100% brain/);
  assert.equal(existsSync(percent.scheduleDir), false);

  const w = windowsScheduleWorld();
  r = await w.run(['install', '--platform', 'systemd']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /systemd does not exist on this system \(win32\)/);
  r = await makeScheduleWorld().run(['install', '--platform', 'taskscheduler']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /taskscheduler does not exist on this system \(linux\)/);

  r = await w.run(['install'], { sid: null, run: fakeRun({ whoami: { status: 1 } }) });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `${w.t('schedule.no_user_sid')}\n`);
  assert.equal(existsSync(w.scheduleDir), false);

  // git is a command a round needs on Windows, and Git for Windows keeps it
  // in its own folder.
  const noGit = windowsScheduleWorld();
  const fs = await import('node:fs');
  fs.rmSync(join(noGit.claudeDir, 'git.exe'));
  r = await noGit.run(['install']);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes(noGit.t('schedule.hint_git')), r.stderr);
});

// --- on Windows itself ----------------------------------------------------------

test('on Windows: node and git are found on the real PATH with PATHEXT, and the kit finds its own Claude Code project name', { skip: !ON_WINDOWS && 'Windows only' }, () => {
  const node = findProgram('node', pathEntries(process.env), { env: process.env });
  assert.ok(node !== null && /\.exe$/i.test(node), String(node));
  assert.ok(findProgram('git', pathEntries(process.env), { env: process.env }) !== null);
  const dir = realpathSync(makeTempDir('brain-kit-win-real-'));
  assert.match(claudeProjectName(dir), /^[A-Za-z]--/);
});

test('on Windows: a state directory made by the kit is open to its owner, the system and the administrators only', { skip: !ON_WINDOWS && 'Windows only' }, () => {
  const dir = join(makeTempDir('brain-kit-win-acl-'), 'state');
  ensureStateDir(dir);
  assert.deepEqual(aclVerdict(dir), { state: 'private' });
  writeFileSync(join(dir, 'machine.json'), '{}');
  assert.deepEqual(aclVerdict(join(dir, 'machine.json')), { state: 'private' }, 'a file made inside inherits it');
});

test('on Windows: a real task is registered, read back as installed, and removed', { skip: !ON_WINDOWS && 'Windows only' }, async () => {
  const world = makeScheduleWorld({ roundTools: false, fakes: [] });
  for (const name of ['brain-kit.cmd', 'gh.exe', 'git.exe']) writeFileSync(join(world.claudeDir, name), '');
  const env = { ...process.env, ...world.env, LOCALAPPDATA: join(world.home, 'AppData', 'Local') };
  delete env.Path;
  env.PATH = `${world.fakeBin};${process.env.Path ?? process.env.PATH}`;
  const run = (argv) => world.run(argv, { platform: 'win32', env });
  try {
    const installed = await run(['install']);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const status = await run(['status']);
    assert.equal(status.status, 0, status.stdout + status.stderr);
  } finally {
    const removed = await run(['uninstall']);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  }
});
