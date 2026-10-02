// `brain-kit machine register --new`: the way a vault that already has its
// configuration is set up on a machine that never had state for it (a clone on
// a laptop, a curator machine rebuilt after an incident).
//
// Before it existed, such a machine had no way out from the CLI: `machine
// show` and `machine set` told it to run `init --adopt`, which refuses a vault
// that is already adopted and suggested starting over by deleting the
// configuration; `machine register` refuses on purpose to guess which state
// is a vault's, because a vault that was MOVED must not silently start a
// second, empty state and lose its marks. `--new` is the person's own
// statement that this machine has never had state for the vault, and what it
// does is checked here against a real clone of a vault the real `init` made.
//
// Nothing here touches the real home or the real state home: every run carries
// an explicit environment (no variable is inherited) whose HOME, git
// configuration and state directory are scratch, and `claude` and `gh` are
// stand-in scripts first on PATH. No test goes to the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
import { makeTempDir } from './helpers/tmp.mjs';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator, loadMessages } from '../src/lang.mjs';
import { STATE_FILES, stateDirFor, vaultIdFor } from '../src/state.mjs';
import { acquireLock } from '../src/guards/lock.mjs';
import { runMachine } from '../src/commands/machine.mjs';
import { validateMachine } from '../src/config.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const NOTES_NAME = 'Ana notes';

// --- a configured vault, cloned -----------------------------------------------------

function writeExecutable(path, text) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

// What a command sees: nothing inherited, scratch home, scratch git
// configuration, the stand-ins first on PATH.
function baseEnv(world) {
  return {
    PATH: `${world.bin}${delimiter}${process.env.PATH}`,
    HOME: world.home,
    XDG_CONFIG_HOME: join(world.home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(world.home, '.gitconfig'),
    BRAIN_KIT_LANG: world.lang,
  };
}

function git(cwd, args, env) {
  const r = spawnSync('git', ['-c', 'user.name=Ana', '-c', 'user.email=ana@example.com', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function cli(world, args, { env = world.env, cwd = world.clone } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
}

// A vault made by the real `init` on a first machine and committed, then
// cloned (git clone, a real one) to a second path. The second machine's
// state is, by default, an EMPTY directory pinned by BRAIN_KIT_STATE_DIR;
// `pinned: false` derives it from the clone's path under XDG_STATE_HOME
// instead, as a machine does that nobody pinned.
function makeWorld({ lang = 'en', pinned = true, stateExists = true } = {}) {
  const base = realpathSync(makeTempDir('bkf3-'));
  const world = { base, lang, bin: join(base, 'bin'), home: join(base, 'home') };
  mkdirSync(world.bin);
  mkdirSync(world.home);
  writeFileSync(join(world.home, '.gitconfig'), '');
  writeExecutable(join(world.bin, 'claude'), '#!/bin/sh\necho "2.1.281 (Claude Code)"\n');
  writeExecutable(join(world.bin, 'gh'), '#!/bin/sh\nexit 0\n');

  const firstEnv = { ...baseEnv(world), BRAIN_KIT_STATE_DIR: join(base, 'state first') };
  world.origin = join(base, 'first machine', NOTES_NAME);
  const init = spawnSync(process.execPath, [BIN, 'init', '--yes', '--lang', lang, world.origin], { cwd: base, env: firstEnv, encoding: 'utf8' });
  assert.equal(init.status, EXIT.OK, `init: ${init.stdout}\n${init.stderr}`);
  world.firstStateDir = join(base, 'state first');
  git(world.origin, ['add', '-A'], firstEnv);
  git(world.origin, ['commit', '-q', '-m', 'Start the vault'], firstEnv);

  world.clone = join(base, 'second machine', NOTES_NAME);
  mkdirSync(dirname(world.clone));
  git(base, ['clone', '-q', world.origin, world.clone], firstEnv);

  world.env = baseEnv(world);
  if (pinned) {
    world.stateDir = join(base, 'state second');
    world.env.BRAIN_KIT_STATE_DIR = world.stateDir;
    if (stateExists) mkdirSync(world.stateDir);
  } else {
    world.env.XDG_STATE_HOME = join(base, 'xdg second');
    world.stateDir = stateDirFor(world.clone, world.env);
  }
  world.machineFile = join(world.stateDir, 'machine.json');
  return world;
}

async function machine(world, argv, { env = world.env, cwd = world.clone, lang = world.lang, deps = {} } = {}) {
  let stdout = '';
  let stderr = '';
  const io = { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } };
  const code = await runMachine(argv, io, createTranslator(lang), { env, cwd, ...deps });
  return { code, stdout, stderr };
}

// Everything under `root` but .git: path, kind, mode and a hash of the
// bytes, so equal listings mean nothing was created, removed or rewritten.
function treeOf(root) {
  const out = [];
  const walk = (rel) => {
    const abs = rel === '' ? root : join(root, rel);
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      out.push(`${rel || '.'} dir ${(st.mode & 0o7777).toString(8)}`);
      for (const name of readdirSync(abs).sort()) {
        if (rel === '' && name === '.git') continue;
        walk(rel === '' ? name : `${rel}/${name}`);
      }
    } else {
      out.push(`${rel} file ${(st.mode & 0o7777).toString(8)} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
    }
  };
  walk('');
  return out;
}

function gitStatus(world, root = world.clone) {
  return git(root, ['status', '--porcelain', '--untracked-files=all', '--ignored'], baseEnv(world));
}

const modeOf = (path) => statSync(path).mode & 0o777;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// --- the defect: nothing led out ---------------------------------------------------

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: on a clone with no state, show and set fail and name machine register --new, and no longer init --adopt`, async () => {
    const world = makeWorld({ lang });
    for (const argv of [['show'], ['set', 'notify_command', '["notify-send", "brain-kit"]']]) {
      const r = await machine(world, argv);
      assert.equal(r.code, EXIT.FAILURE, r.stderr);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes(world.machineFile), r.stderr);
      assert.ok(r.stderr.includes('machine register --new'), r.stderr);
      assert.ok(r.stderr.includes('machine register --from'), 'a moved vault is still told its way');
      assert.ok(!r.stderr.includes('init --adopt'), r.stderr);
    }
    assert.equal(existsSync(world.machineFile), false);
  });

  test(`${lang}: init --adopt on an already adopted vault still refuses, and leads with machine register --new`, async () => {
    const world = makeWorld({ lang });
    const before = treeOf(world.clone);
    const r = cli(world, ['init', '--adopt', '.', '--yes', '--lang', lang]);
    assert.equal(r.status, EXIT.USAGE, r.stderr);
    assert.equal(r.stdout, '');
    const at = r.stderr.indexOf('machine register --new');
    assert.ok(at >= 0, r.stderr);
    for (const destructive of [/remove brain-kit\.config\.json/, /remova o brain-kit\.config\.json/]) {
      const found = destructive.exec(r.stderr);
      if (found) assert.ok(at < found.index, `the destructive recovery is not first: ${r.stderr}`);
    }
    assert.equal(existsSync(world.machineFile), false, 'nothing was written');
    assert.deepEqual(treeOf(world.clone), before);
  });
}

test('init --adopt on a folder that is not a vault yet is still the advice for it (a repository that is not adopted, a non-empty folder)', () => {
  const world = makeWorld();
  const repo = join(world.base, 'plain notes');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main'], baseEnv(world));
  let r = cli(world, ['init', '--yes', '--lang', 'en', repo]);
  assert.equal(r.status, EXIT.USAGE, r.stderr);
  assert.match(r.stderr, /brain-kit init --adopt/);
  const notEmpty = join(world.base, 'some files');
  mkdirSync(notEmpty);
  writeFileSync(join(notEmpty, 'a.md'), 'a\n');
  r = cli(world, ['init', '--yes', '--lang', 'pt-BR', notEmpty], { env: { ...world.env, BRAIN_KIT_LANG: 'pt-BR' } });
  assert.equal(r.status, EXIT.USAGE, r.stderr);
  assert.match(r.stderr, /brain-kit init --adopt/);
});

test('no message of either pack sends a configured vault to init --adopt; the ones about a folder that is not a vault still do', () => {
  for (const lang of ['en', 'pt-BR']) {
    const pack = loadMessages(lang);
    // The two refusals of --new for a folder that is not a configured vault are about exactly such a folder.
    const ABOUT_A_FOLDER_THAT_IS_NOT_A_VAULT = ['machine.register_new_no_vault', 'machine.register_new_not_configured'];
    for (const [key, value] of Object.entries(pack)) {
      if (key.startsWith('init.') || key.startsWith('adopt.') || key === 'cli.usage' || ABOUT_A_FOLDER_THAT_IS_NOT_A_VAULT.includes(key)) continue;
      assert.ok(!value.includes('init --adopt'), `${lang} ${key} still says init --adopt: ${value}`);
    }
    for (const key of ['machine.missing', 'doctor.machine_valid.missing', 'hook.stop.release_unregistered',
      'machine.register_source_live', 'init.adopt_already_vault', 'curate.machine_missing', 'schedule.machine_missing']) {
      assert.ok(pack[key]?.includes('machine register --new'), `${lang} ${key} does not name machine register --new`);
    }
    assert.ok(pack['init.not_empty'].includes('init --adopt'), `${lang}: a non-empty folder is still pointed at adopt`);
    assert.ok(pack['init.already_repository'].includes('init --adopt'), `${lang}: a repository is still pointed at adopt`);
  }
});

test('every other place that reports a missing machine.json names register --new: doctor, the Stop hook, curate, schedule, and register itself', async () => {
  for (const lang of ['en', 'pt-BR']) {
    const world = makeWorld({ lang });
    // register without --from, on a machine with no state, is the refusal that never guesses; it now says the way out.
    const refused = await machine(world, ['register']);
    assert.equal(refused.code, EXIT.USAGE, refused.stderr);
    assert.ok(refused.stderr.includes('--from'), refused.stderr);
    assert.ok(refused.stderr.includes('--new'), refused.stderr);
    assert.equal(existsSync(world.machineFile), false);

    const doctor = cli(world, ['doctor', '--json', '--only', 'machine-valid,state-dir-resolves']);
    const report = JSON.parse(doctor.stdout);
    const check = report.checks.find((c) => c.id === 'machine-valid');
    assert.equal(check.status, 'fail');
    assert.ok(check.message.includes('machine register --new'), check.message);
    assert.ok(!check.message.includes('init --adopt'), check.message);

    const curate = cli(world, ['curate']);
    assert.equal(curate.status, EXIT.USAGE, curate.stderr);
    assert.ok(curate.stderr.includes('machine register --new'), curate.stderr);
    assert.ok(curate.stderr.includes(world.machineFile), curate.stderr);
    assert.ok(!/phase 1/.test(curate.stderr), curate.stderr);

    const schedule = cli(world, ['schedule', 'install', '--dry']);
    assert.equal(schedule.status, EXIT.USAGE, schedule.stderr);
    assert.ok(schedule.stderr.includes('machine register --new'), schedule.stderr);
  }
});

// --- what register --new writes ---------------------------------------------------

test('register --new writes the machine.json init writes (same keys), at 0600 in a directory at 0700, and nothing else', async () => {
  const world = makeWorld();
  chmodSync(world.stateDir, 0o755);
  const r = await machine(world, ['register', '--new']);
  assert.equal(r.code, EXIT.OK, r.stderr);

  assert.equal(modeOf(world.machineFile), 0o600);
  assert.equal(modeOf(world.stateDir), 0o700);
  assert.deepEqual(readdirSync(world.stateDir), ['machine.json'], 'no watermark, no log, no temporary file');

  const written = readJson(world.machineFile);
  const initWrote = readJson(join(world.firstStateDir, 'machine.json'));
  assert.deepEqual(Object.keys(written), Object.keys(initWrote));
  assert.deepEqual(Object.keys(written.paths), Object.keys(initWrote.paths));
  assert.deepEqual(validateMachine(written), []);
  assert.equal(written.vault_id, vaultIdFor(world.clone));
  assert.equal(written.canonical_path, realpathSync(world.clone));
  assert.equal(written.state_dir, world.stateDir);
  assert.equal(written.claude_bin, join(world.bin, 'claude'), 'the claude found on PATH, as init finds it');
  assert.equal(written.paths.watermark, join(world.stateDir, STATE_FILES.WATERMARK));
  assert.equal(written.paths.last_run, join(world.stateDir, STATE_FILES.LAST_RUN));
  assert.equal(written.paths.log_dir, join(world.stateDir, STATE_FILES.LOG_DIR));
  assert.equal(written.paths.questions_log, join(world.stateDir, STATE_FILES.QUESTIONS_LOG));
  assert.ok(!existsSync(written.paths.watermark), 'it creates no watermark');
  // Bytes: the same serialisation init gives.
  assert.equal(readFileSync(world.machineFile, 'utf8'), `${JSON.stringify(written, null, 2)}\n`);
});

test('register --new works when the state directory does not exist yet, and under a restrictive and a permissive umask', async () => {
  for (const mask of [0o077, 0o000]) {
    const world = makeWorld({ stateExists: false });
    const saved = process.umask(mask);
    let r;
    try {
      r = await machine(world, ['register', '--new']);
    } finally {
      process.umask(saved);
    }
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.equal(modeOf(world.machineFile), 0o600, `umask ${mask.toString(8)}`);
    assert.equal(modeOf(world.stateDir), 0o700, `umask ${mask.toString(8)}`);
  }
});

test('register --new derives the state directory from the clone\'s path when nothing pins it, and doctor finds it there', async () => {
  const world = makeWorld({ pinned: false });
  assert.equal(existsSync(world.stateDir), false);
  const r = await machine(world, ['register', '--new']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(readJson(world.machineFile).state_dir, world.stateDir);
  const doctor = cli(world, ['doctor', '--json', '--only', 'machine-valid,state-dir-resolves,state-dir-mode']);
  const byId = Object.fromEntries(JSON.parse(doctor.stdout).checks.map((c) => [c.id, c]));
  for (const id of ['machine-valid', 'state-dir-resolves', 'state-dir-mode']) assert.equal(byId[id].status, 'ok', JSON.stringify(byId[id]));
});

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: register --new says what it wrote and what it found, that it wrote no watermark, and the next two commands`, async () => {
    const world = makeWorld({ lang });
    const r = await machine(world, ['register', '--new']);
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.equal(r.stderr, '');
    assert.ok(r.stdout.includes(world.machineFile), r.stdout);
    assert.ok(r.stdout.includes(join(world.bin, 'claude')), 'it names the claude it found');
    for (const key of ['model', 'network_check', 'notify_command', 'transcripts_dir']) assert.ok(r.stdout.includes(key), `${key}: ${r.stdout}`);
    assert.ok(r.stdout.includes('api.anthropic.com:443'), 'the default network check is named');
    assert.ok(r.stdout.includes('brain-kit doctor'), r.stdout);
    assert.ok(r.stdout.includes('brain-kit schedule install'), r.stdout);
    assert.ok(r.stdout.indexOf('brain-kit doctor') < r.stdout.indexOf('brain-kit schedule install'), 'doctor first');
    assert.ok(r.stdout.includes('watermark'), r.stdout);
    assert.ok(!r.stdout.includes(String.fromCharCode(0x2014)), 'no em dash');
    // It runs nothing else: no schedule entry, no log.
    assert.deepEqual(readdirSync(world.stateDir), ['machine.json']);
  });
}

test('when no claude is on PATH, register --new writes "claude", as init does, and says it was not found', async () => {
  const world = makeWorld();
  rmSync(join(world.bin, 'claude'));
  const env = { ...world.env, PATH: join(world.base, 'nowhere') };
  // git is needed for the lock: give it its own directory on PATH, with no claude in it.
  const gitDir = dirname(spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim());
  env.PATH = `${join(world.base, 'nowhere')}${delimiter}${gitDir}`;
  const r = await machine(world, ['register', '--new'], { env });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(readJson(world.machineFile).claude_bin, 'claude');
  assert.match(r.stdout, /claude_bin/);
  assert.match(r.stdout, /machine set claude_bin/);
});

test('doctor after register --new has no missing-machine failure, and the three state checks are ok', async () => {
  const world = makeWorld();
  const r = await machine(world, ['register', '--new']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const doctor = cli(world, ['doctor', '--json']);
  const report = JSON.parse(doctor.stdout);
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  for (const id of ['machine-valid', 'state-dir-resolves', 'state-dir-mode']) assert.equal(byId[id].status, 'ok', JSON.stringify(byId[id]));
  for (const check of report.checks) {
    assert.ok(!/doctor\.(machine_valid\.missing|state_dir_resolves\.none)/.test(JSON.stringify(check)), JSON.stringify(check));
  }
  // show now answers, and set works.
  assert.equal((await machine(world, ['show'])).code, EXIT.OK);
  assert.equal((await machine(world, ['set', 'notify_command', '["notify-send", "brain-kit"]'])).code, EXIT.OK);
});

// --- what it refuses ----------------------------------------------------------------

test('a second register --new refuses, says what is there, and leaves the file byte for byte and mode for mode', async () => {
  const world = makeWorld();
  assert.equal((await machine(world, ['register', '--new'])).code, EXIT.OK);
  const bytes = readFileSync(world.machineFile);
  const mode = modeOf(world.machineFile);
  const id = readJson(world.machineFile).vault_id;
  const r = await machine(world, ['register', '--new']);
  assert.equal(r.code, EXIT.FAILURE, r.stderr);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.includes(world.machineFile), r.stderr);
  assert.ok(r.stderr.includes(id), 'it says whose state is there');
  assert.ok(r.stderr.includes(realpathSync(world.clone)), 'and where that vault is');
  assert.ok(readFileSync(world.machineFile).equals(bytes));
  assert.equal(modeOf(world.machineFile), mode);
  assert.deepEqual(readdirSync(world.stateDir), ['machine.json']);
});

test('register --new refuses a machine.json that is there already, whatever it holds, and never touches it', async () => {
  const contents = {
    'another vault\'s record': `${JSON.stringify({ vault_id: 'other-1234abcd', canonical_path: '/srv/example/other', claude_bin: 'claude', paths: { watermark: '/w', last_run: '/l', log_dir: '/d' } }, null, 2)}\n`,
    'not JSON': '{ not json',
    'empty': '',
    'an array': '[]\n',
  };
  for (const [what, text] of Object.entries(contents)) {
    const world = makeWorld();
    writeFileSync(world.machineFile, text);
    chmodSync(world.machineFile, 0o640);
    const before = readFileSync(world.machineFile);
    const r = await machine(world, ['register', '--new']);
    assert.equal(r.code, EXIT.FAILURE, `${what}: ${r.stderr}`);
    assert.ok(r.stderr.includes(world.machineFile), `${what}: ${r.stderr}`);
    assert.ok(readFileSync(world.machineFile).equals(before), what);
    assert.equal(modeOf(world.machineFile), 0o640, what);
    assert.deepEqual(readdirSync(world.stateDir), ['machine.json'], what);
  }
});

test('register --new and --from together refuse with exit 2, in either order and either spelling, and write nothing', async () => {
  for (const lang of ['en', 'pt-BR']) {
    const world = makeWorld({ lang });
    for (const argv of [
      ['register', '--new', '--from', '/srv/example/old'],
      ['register', '--from', '/srv/example/old', '--new'],
      ['register', '--new', '--from=/srv/example/old'],
      ['register', '--from=/srv/example/old', '--new', world.clone],
    ]) {
      const r = await machine(world, argv);
      assert.equal(r.code, EXIT.USAGE, `${argv.join(' ')}: ${r.stderr}`);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes('--new') && r.stderr.includes('--from'), r.stderr);
      // The combination is named as such, not refused as an argument nobody knows.
      assert.ok(!r.stderr.includes(createTranslator(lang)('machine.bad_argument', { arg: '--new' })), r.stderr);
      assert.ok(!r.stderr.includes(createTranslator(lang)('machine.usage')), 'no usage dump');
      assert.deepEqual(readdirSync(world.stateDir), [], argv.join(' '));
    }
  }
});

test('--new belongs to register alone: show and set refuse it as an unknown argument', async () => {
  const world = makeWorld();
  assert.equal((await machine(world, ['show', '--new'])).code, EXIT.USAGE);
  assert.equal((await machine(world, ['set', 'model', 'x', '--new'])).code, EXIT.USAGE);
  assert.deepEqual(readdirSync(world.stateDir), []);
});

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: register --new outside any vault refuses with exit 2, names init and init --adopt, and creates nothing`, async () => {
    const world = makeWorld({ lang });
    const outside = join(world.base, 'elsewhere');
    mkdirSync(outside);
    const before = readdirSync(world.base).sort();
    const r = await machine(world, ['register', '--new'], { cwd: outside });
    assert.equal(r.code, EXIT.USAGE, r.stderr);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(outside), r.stderr);
    assert.ok(/brain-kit init /.test(r.stderr), r.stderr);
    assert.ok(r.stderr.includes('init --adopt'), r.stderr);
    assert.deepEqual(readdirSync(world.stateDir), []);
    assert.deepEqual(readdirSync(world.base).sort(), before);
  });
}

test('register --new in a folder with a root index.md and an invalid configuration, or with no manifest, is not a configured vault: exit 2, nothing written', async () => {
  const cases = {
    'an invalid configuration': (world) => writeFileSync(join(world.clone, 'brain-kit.config.json'), '{}\n'),
    'a configuration that is not JSON': (world) => writeFileSync(join(world.clone, 'brain-kit.config.json'), '{ nope'),
    'no manifest': (world) => rmSync(join(world.clone, '.brain-kit', 'manifest.json')),
    'a manifest that is not valid': (world) => writeFileSync(join(world.clone, '.brain-kit', 'manifest.json'), '{"files": []}\n'),
  };
  for (const [what, spoil] of Object.entries(cases)) {
    const world = makeWorld();
    spoil(world);
    const r = await machine(world, ['register', '--new']);
    assert.equal(r.code, EXIT.USAGE, `${what}: ${r.stderr}`);
    assert.equal(r.stdout, '', what);
    assert.ok(/brain-kit init /.test(r.stderr) && r.stderr.includes('init --adopt'), `${what}: ${r.stderr}`);
    assert.deepEqual(readdirSync(world.stateDir), [], what);
  }
});

test('register --new leaves the vault as it found it: the tree, git status with ignored files, and every tracked file', async () => {
  const world = makeWorld();
  const tree = treeOf(world.clone);
  assert.equal(gitStatus(world), '', 'setup: the clone is clean');
  const head = git(world.clone, ['rev-parse', 'HEAD'], baseEnv(world));
  const r = await machine(world, ['register', '--new']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(treeOf(world.clone), tree);
  assert.equal(gitStatus(world), '');
  assert.equal(git(world.clone, ['rev-parse', 'HEAD'], baseEnv(world)), head);
  // And a refusal leaves it as it found it too.
  assert.equal((await machine(world, ['register', '--new'])).code, EXIT.FAILURE);
  assert.deepEqual(treeOf(world.clone), tree);
  assert.equal(gitStatus(world), '');
});

test('register --new takes the vault lock: a held lock is exit 75 naming the holder, and nothing is written', async () => {
  const world = makeWorld();
  const lock = acquireLock(world.clone, { command: 'test holder', env: world.env });
  try {
    const r = await machine(world, ['register', '--new']);
    assert.equal(r.code, EXIT.TEMPFAIL, r.stderr);
    assert.match(r.stderr, /test holder/);
    assert.deepEqual(readdirSync(world.stateDir), []);
  } finally {
    lock.release();
  }
  assert.equal((await machine(world, ['register', '--new'])).code, EXIT.OK);
});

test('register --new refuses a state directory inside the vault, as every machine subcommand does', async () => {
  const world = makeWorld();
  const inside = join(world.clone, 'state');
  const env = { ...world.env, BRAIN_KIT_STATE_DIR: inside };
  const r = await machine(world, ['register', '--new'], { env });
  assert.equal(r.code, EXIT.USAGE, r.stderr);
  assert.ok(r.stderr.includes(inside), `the refusal names the state directory: ${r.stderr}`);
  assert.equal(existsSync(inside), false);
  assert.equal(gitStatus(world), '');
});

// --- state that is not nothing -------------------------------------------------------

test('register --new refuses a state directory that holds anything but the trace of a refused round, and writes nothing', async () => {
  for (const name of ['watermark.json', 'questions.log', 'notes.txt']) {
    const world = makeWorld();
    writeFileSync(join(world.stateDir, name), 'x\n');
    const r = await machine(world, ['register', '--new']);
    assert.equal(r.code, EXIT.FAILURE, `${name}: ${r.stderr}`);
    assert.ok(r.stderr.includes(world.stateDir) && r.stderr.includes(name), `${name}: ${r.stderr}`);
    assert.deepEqual(readdirSync(world.stateDir), [name]);
    assert.equal(existsSync(world.machineFile), false);
  }
  const world = makeWorld({ stateExists: false });
  writeFileSync(world.stateDir, 'a file, not a directory\n');
  const r = await machine(world, ['register', '--new']);
  assert.equal(r.code, EXIT.FAILURE, r.stderr);
  assert.equal(readFileSync(world.stateDir, 'utf8'), 'a file, not a directory\n');
});

test('register --new accepts what a round refused for lack of machine.json left behind (logs and last-run.json), and keeps it', async () => {
  const world = makeWorld();
  const curate = cli(world, ['curate']);
  assert.equal(curate.status, EXIT.USAGE, curate.stderr);
  const left = readdirSync(world.stateDir).sort();
  assert.ok(left.includes('last-run.json'), `the refused round leaves its trace: ${left}`);
  const r = await machine(world, ['register', '--new']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(readdirSync(world.stateDir).sort(), [...left, 'machine.json'].sort());
});

// --- a vault that moved ---------------------------------------------------------------

// A vault the real init made on this machine, with its state derived from
// its path (nothing pinned), then moved by hand to another folder.
function makeMovedVault(world, { newName = NOTES_NAME } = {}) {
  const env = { ...baseEnv(world), XDG_STATE_HOME: join(world.base, 'xdg moved') };
  const oldPath = join(world.base, 'old place', NOTES_NAME);
  const init = spawnSync(process.execPath, [BIN, 'init', '--yes', '--lang', 'en', oldPath], { cwd: world.base, env, encoding: 'utf8' });
  assert.equal(init.status, EXIT.OK, init.stderr);
  const oldState = stateDirFor(oldPath, env);
  assert.ok(existsSync(join(oldState, 'machine.json')));
  const newPath = join(world.base, 'new place', newName);
  mkdirSync(dirname(newPath));
  renameSync(oldPath, newPath);
  return { env, oldPath, newPath, oldState };
}

test('register --new at the new path of a vault that moved refuses and names --from, rather than start a second, empty state beside the marks', async () => {
  const world = makeWorld();
  const moved = makeMovedVault(world);
  const stateBefore = readFileSync(join(moved.oldState, 'machine.json'));
  const r = await machine(world, ['register', '--new'], { env: moved.env, cwd: moved.newPath });
  assert.equal(r.code, EXIT.FAILURE, r.stderr);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.includes(moved.oldPath), 'it names the old path');
  assert.ok(r.stderr.includes(moved.oldState), 'and the state it found');
  assert.ok(r.stderr.includes('machine register --from'), r.stderr);
  assert.equal(existsSync(stateDirFor(moved.newPath, moved.env)), false, 'no second state was started');
  assert.ok(readFileSync(join(moved.oldState, 'machine.json')).equals(stateBefore), 'the old state was not touched');
  // And the move itself still works, with the path it named.
  const done = await machine(world, ['register', '--from', moved.oldPath], { env: moved.env, cwd: moved.newPath });
  assert.equal(done.code, EXIT.OK, done.stderr);
});

test('register --new refuses the state of a vault that left a link behind it, whatever the new folder is called', async () => {
  const world = makeWorld();
  const moved = makeMovedVault(world, { newName: 'Renamed notes' });
  // The old path now leads to the vault again (a link left by the move).
  mkdirSync(dirname(moved.oldPath), { recursive: true });
  spawnSync('ln', ['-s', moved.newPath, moved.oldPath]);
  const r = await machine(world, ['register', '--new'], { env: moved.env, cwd: moved.newPath });
  assert.equal(r.code, EXIT.FAILURE, r.stderr);
  assert.ok(r.stderr.includes('machine register --from'), r.stderr);
});

test('register --new is not stopped by the state of an unrelated vault that is gone, or of a vault of the same name that is still there', async () => {
  const world = makeWorld({ pinned: false });
  // A vault with another name, deleted: its state is left behind on this machine.
  const stranger = join(world.base, 'strangers', 'Other notes');
  const init = spawnSync(process.execPath, [BIN, 'init', '--yes', '--lang', 'en', stranger], { cwd: world.base, env: world.env, encoding: 'utf8' });
  assert.equal(init.status, EXIT.OK, init.stderr);
  rmSync(stranger, { recursive: true, force: true });
  // A vault of the same name that is alive somewhere else: its state is not this vault's.
  const twin = join(world.base, 'twin place', NOTES_NAME);
  const twinInit = spawnSync(process.execPath, [BIN, 'init', '--yes', '--lang', 'en', twin], { cwd: world.base, env: world.env, encoding: 'utf8' });
  assert.equal(twinInit.status, EXIT.OK, twinInit.stderr);
  const r = await machine(world, ['register', '--new']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(readJson(world.machineFile).canonical_path, realpathSync(world.clone));
});

test('a state directory pinned by BRAIN_KIT_STATE_DIR is not searched for a moved vault\'s state: the pin is the person\'s statement', async () => {
  const world = makeWorld();
  const moved = makeMovedVault(world);
  const env = { ...moved.env, BRAIN_KIT_STATE_DIR: world.stateDir };
  const r = await machine(world, ['register', '--new'], { env, cwd: moved.newPath });
  assert.equal(r.code, EXIT.OK, r.stderr);
});

// --- when the write cannot happen ------------------------------------------------------

test('register --new where the state directory cannot be created says why, exits 1, and leaves nothing behind', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) t.skip('root can write anywhere');
  const world = makeWorld({ stateExists: false });
  const locked = join(world.base, 'locked');
  mkdirSync(locked);
  const stateDir = join(locked, 'inner', 'state');
  const env = { ...world.env, BRAIN_KIT_STATE_DIR: stateDir };
  chmodSync(locked, 0o500);
  try {
    const r = await machine(world, ['register', '--new'], { env });
    assert.equal(r.code, EXIT.FAILURE, r.stderr);
    assert.ok(r.stderr.includes(stateDir), r.stderr);
    assert.equal(r.stdout, '');
  } finally {
    chmodSync(locked, 0o700);
  }
  assert.deepEqual(readdirSync(locked), []);
});

test('register --new tightens a state directory that was left open, and says so', async () => {
  const world = makeWorld();
  chmodSync(world.stateDir, 0o755);
  const r = await machine(world, ['register', '--new']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(modeOf(world.stateDir), 0o700);
  assert.ok(r.stdout.includes('755'), r.stdout);
});

// --- the usage ---------------------------------------------------------------------------

test('the usage of machine says that register takes --from or --new, in both languages', () => {
  for (const lang of ['en', 'pt-BR']) {
    const usage = loadMessages(lang)['machine.usage'];
    const line = usage.split('\n').find((l) => l.includes('machine register'));
    assert.ok(line.includes('--from') && line.includes('--new'), `${lang}: ${line}`);
  }
});

test('the real launcher: register --new in pt-BR prints the Portuguese messages and exits 0', () => {
  const world = makeWorld({ lang: 'pt-BR' });
  const r = cli(world, ['machine', 'register', '--new']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.ok(r.stdout.includes('brain-kit doctor'));
  assert.match(r.stdout, /m[aá]quina/i);
  assert.equal(modeOf(world.machineFile), 0o600);
  const again = cli(world, ['machine', 'register', '--new']);
  assert.equal(again.status, EXIT.FAILURE, again.stderr);
});

// --- fix round 1 -----------------------------------------------------------------------
//
// What the first review found: a vault moved AND renamed got a second, empty
// state with no word about the old one (S1); after a move a refused round's
// trace sent the person from `curate` to `register --from`, which refused
// because of that same trace (S2); the rollback of a failed write was never
// exercised (S3); the second-machine steps left out the push gate (S4); plain
// `init` and `schedule` said things that were not true for a clone (S5, S6);
// and `watermark set` before `--new` made it refuse with advice that loses
// what the person set (S7).

// --- S1: the state --new cannot tie to this vault is listed, with the way back -------------

test('S1: --new on a vault that moved AND was renamed succeeds, lists the state it cannot tie to it, and the undo it gives works', async () => {
  for (const lang of ['en', 'pt-BR']) {
    const world = makeWorld({ lang });
    const moved = makeMovedVault(world, { newName: 'Renamed notes' });
    const oldId = readJson(join(moved.oldState, 'machine.json')).vault_id;
    const r = await machine(world, ['register', '--new'], { env: moved.env, cwd: moved.newPath });
    assert.equal(r.code, EXIT.OK, `${lang}: ${r.stderr}`);
    assert.ok(r.stdout.includes(moved.oldPath), `${lang}: it names the old path: ${r.stdout}`);
    assert.ok(r.stdout.includes(moved.oldState), `${lang}: and the old state directory`);
    assert.ok(r.stdout.includes('machine register --from'), `${lang}: and the way to adopt it`);
    const newFile = join(stateDirFor(moved.newPath, moved.env), 'machine.json');
    assert.ok(r.stdout.includes(newFile), `${lang}: and the file to remove first`);
    // The undo, as given: remove what --new wrote, then register --from.
    unlinkSync(newFile);
    const undo = await machine(world, ['register', '--from', moved.oldPath], { env: moved.env, cwd: moved.newPath });
    assert.equal(undo.code, EXIT.OK, `${lang}: ${undo.stderr}`);
    assert.equal(readJson(newFile).vault_id, oldId, `${lang}: the old state is this vault's now`);
    assert.equal(existsSync(moved.oldState), false);
  }
});

test('S1: the notice also lists an unrelated vault that is gone, and is absent when the machine holds no such state', async () => {
  const world = makeWorld({ pinned: false });
  const stranger = join(world.base, 'strangers', 'Other notes');
  const init = spawnSync(process.execPath, [BIN, 'init', '--yes', '--lang', 'en', stranger], { cwd: world.base, env: world.env, encoding: 'utf8' });
  assert.equal(init.status, EXIT.OK, init.stderr);
  const strangerState = stateDirFor(stranger, world.env);
  rmSync(stranger, { recursive: true, force: true });
  const r = await machine(world, ['register', '--new']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.ok(r.stdout.includes(stranger) && r.stdout.includes(strangerState), r.stdout);
  const clean = makeWorld();
  const quiet = await machine(clean, ['register', '--new']);
  assert.equal(quiet.code, EXIT.OK, quiet.stderr);
  assert.ok(!quiet.stdout.includes('--from'), `no notice when there is nothing to tell: ${quiet.stdout}`);
});

test('S1: every message that reports a missing machine.json says "moved or renamed", and the limit is written in docs/scheduling.md', () => {
  const keys = ['machine.missing', 'doctor.machine_valid.missing', 'curate.machine_missing', 'schedule.machine_missing',
    'hook.stop.release_unregistered', 'machine.register_nothing'];
  for (const [lang, pattern] of [['en', /moved or renamed/], ['pt-BR', /mov(ido|ida) ou renomead[oa]/]]) {
    const pack = loadMessages(lang);
    for (const key of keys) assert.match(pack[key], pattern, `${lang} ${key}`);
  }
  const doc = readFileSync(join(KIT_ROOT, 'docs', 'scheduling.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## The same vault on a second machine'), doc.indexOf('## Moving from a legacy lock'));
  assert.match(section, /moved and renamed/);
  assert.match(section, /lists/);
});

// --- S2: register --from takes the trace a refused round leaves, as --new does -----------------

// A vault moved by hand, then a round refused at its new path for lack of
// machine.json: its trace is what register --from used to refuse.
function movedWithRefusedRound(world) {
  const moved = makeMovedVault(world);
  const newState = stateDirFor(moved.newPath, moved.env);
  const curate = cli(world, ['curate'], { env: moved.env, cwd: moved.newPath });
  assert.equal(curate.status, EXIT.USAGE, curate.stderr);
  assert.deepEqual(readdirSync(newState).sort(), ['last-run.json', 'logs']);
  return { ...moved, newState };
}

test('S2: move, curate refused, then register --from succeeds: the advice of curate and of --new is not a dead end', async () => {
  const world = makeWorld();
  const moved = movedWithRefusedRound(world);
  const refused = await machine(world, ['register', '--new'], { env: moved.env, cwd: moved.newPath });
  assert.equal(refused.code, EXIT.FAILURE, refused.stderr);
  assert.ok(refused.stderr.includes('machine register --from'));
  const r = await machine(world, ['register', '--from', moved.oldPath], { env: moved.env, cwd: moved.newPath });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(readdirSync(moved.newState), ['machine.json'], 'the old state is in place and the refused round\'s trace is gone');
  assert.equal(existsSync(moved.oldState), false);
  assert.deepEqual(readdirSync(dirname(moved.newState)).filter((name) => name.includes('trace')), [], 'nothing was left beside it');
  assert.equal(readJson(join(moved.newState, 'machine.json')).canonical_path, realpathSync(moved.newPath));
});

test('S2: register --from still refuses anything beyond that trace in the target, naming it, and leaves everything where it was', async () => {
  const world = makeWorld();
  const moved = movedWithRefusedRound(world);
  writeFileSync(join(moved.newState, 'watermark.json'), '{}\n');
  const r = await machine(world, ['register', '--from', moved.oldPath], { env: moved.env, cwd: moved.newPath });
  assert.equal(r.code, EXIT.FAILURE, r.stderr);
  assert.ok(r.stderr.includes('watermark.json') && r.stderr.includes(moved.newState), r.stderr);
  assert.deepEqual(readdirSync(moved.newState).sort(), ['last-run.json', 'logs', 'watermark.json']);
  assert.ok(existsSync(join(moved.oldState, 'machine.json')));
});

test('S2: a register --from that fails after setting the trace aside puts the trace and the old state back', async () => {
  for (const failAt of [2, 3]) {
    const world = makeWorld();
    const moved = movedWithRefusedRound(world);
    const before = readFileSync(join(moved.oldState, 'machine.json'));
    let calls = 0;
    const rename = (from, to) => {
      calls += 1;
      if (calls === failAt) throw Object.assign(new Error('EXDEV: simulated'), { code: 'EXDEV' });
      return renameSync(from, to);
    };
    await assert.rejects(machine(world, ['register', '--from', moved.oldPath], { env: moved.env, cwd: moved.newPath, deps: { rename } }), /EXDEV/);
    assert.deepEqual(readdirSync(moved.newState).sort(), ['last-run.json', 'logs'], `failing rename ${failAt}: the trace is back`);
    assert.ok(readFileSync(join(moved.oldState, 'machine.json')).equals(before), `failing rename ${failAt}: the old state is where it was`);
    assert.deepEqual(readdirSync(dirname(moved.newState)).filter((name) => name.includes('trace')), []);
    const again = await machine(world, ['register', '--from', moved.oldPath], { env: moved.env, cwd: moved.newPath });
    assert.equal(again.code, EXIT.OK, again.stderr);
  }
});

// --- S3: a write that fails after the directory exists leaves nothing behind -------------------

test('S3: --new whose machine.json write fails midway (a file-size limit) rolls back the file and the directories, and a later --new works', (t) => {
  if (spawnSync('bash', ['-c', 'exit 0']).status !== 0) t.skip('no bash to set a file-size limit');
  const world = makeWorld({ stateExists: false });
  // A long state path: machine.json (five paths in it) passes 1 KiB, the vault lock's file does not.
  const first = join(world.base, 'a'.repeat(200));
  const long = join(first, 'b'.repeat(200));
  const env = { ...world.env, BRAIN_KIT_STATE_DIR: long };
  const limited = spawnSync('bash', ['-c', 'ulimit -f 1; exec "$0" "$@"', process.execPath, BIN, 'machine', 'register', '--new'], {
    cwd: world.clone, env, encoding: 'utf8',
  });
  assert.equal(limited.status, EXIT.FAILURE, limited.stdout + limited.stderr);
  assert.match(limited.stderr, /EFBIG/);
  assert.ok(limited.stderr.includes(long), limited.stderr);
  assert.equal(existsSync(first), false, 'the directories this run created are gone, and no file cut short is left in them');
  const ok = spawnSync(process.execPath, [BIN, 'machine', 'register', '--new'], { cwd: world.clone, env, encoding: 'utf8' });
  assert.equal(ok.status, EXIT.OK, ok.stderr);
});

// --- S4: the push gate -----------------------------------------------------------------------------

test('S4: the second-machine steps give the clone its push gate: the section, both complete guides, the incident page and the next steps', () => {
  const doc = readFileSync(join(KIT_ROOT, 'docs', 'scheduling.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## The same vault on a second machine'), doc.indexOf('## Moving from a legacy lock'));
  const gate = 'git config core.hooksPath .githooks';
  assert.ok(section.includes(gate), 'docs/scheduling.md');
  // The second machine moved from the READMEs to the complete guides (02/10/2026).
  for (const file of ['docs/guide.md', 'docs/guia.md']) {
    const text = readFileSync(join(KIT_ROOT, file), 'utf8');
    const at = text.indexOf('machine register --new');
    assert.ok(at >= 0 && text.slice(at - 600, at + 900).includes(gate), file);
  }
  const incident = readFileSync(join(KIT_ROOT, 'docs', 'incident-response.md'), 'utf8');
  assert.ok(incident.indexOf(gate, incident.indexOf('machine register --new')) > 0, 'the gate comes after the registration there');
  for (const lang of ['en', 'pt-BR']) {
    const next = loadMessages(lang)['machine.register_new_next'];
    const at = (needle) => next.indexOf(needle);
    assert.ok(at('core.hooksPath') > -1, lang);
    // The order a person must follow: the push gate first, then the check that looks for it, then the schedule.
    assert.ok(at('core.hooksPath') < at('brain-kit doctor'), `${lang}: git config before doctor`);
    assert.ok(at('brain-kit doctor') < at('brain-kit schedule install'), `${lang}: doctor before schedule install`);
  }
});

// --- S5: plain init on a configured clone ---------------------------------------------------------

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: plain init on a configured clone with no state names machine register --new, and does not once the machine has its own`, async () => {
    const world = makeWorld({ lang });
    let r = cli(world, ['init', '.', '--yes', '--lang', lang]);
    assert.equal(r.status, EXIT.USAGE, r.stderr);
    assert.ok(r.stderr.includes('machine register --new'), r.stderr);
    assert.ok(r.stderr.includes('brain-kit update'), 'the advice for a vault that has its state is still there');
    assert.equal((await machine(world, ['register', '--new'])).code, EXIT.OK);
    r = cli(world, ['init', '.', '--yes', '--lang', lang]);
    assert.equal(r.status, EXIT.USAGE, r.stderr);
    assert.ok(!r.stderr.includes('machine register --new'), r.stderr);
    assert.ok(r.stderr.includes('brain-kit update'), r.stderr);
  });
}

// --- S6: schedule says what is true for each caller --------------------------------------------

test('S6: schedule status and uninstall on a machine with no machine.json do not claim an installation was refused, and doctor\'s schedule check fails on it', () => {
  const world = makeWorld();
  for (const args of [['schedule', 'status'], ['schedule', 'uninstall'], ['schedule', 'install', '--dry']]) {
    const r = cli(world, args);
    assert.equal(r.status, EXIT.USAGE, `${args.join(' ')}: ${r.stderr}`);
    assert.ok(r.stderr.includes('machine register --new'), r.stderr);
    assert.ok(!/nothing was installed/.test(r.stderr), `${args.join(' ')}: ${r.stderr}`);
  }
  for (const lang of ['en', 'pt-BR']) {
    const text = loadMessages(lang)['schedule.machine_missing'];
    assert.ok(!/nothing was installed|nada foi instalado/.test(text), lang);
  }
  // The decision, pinned: a configured vault with no machine.json cannot run a round at all, so the check fails (it was a warning before).
  const doctor = cli(world, ['doctor', '--json', '--only', 'schedule']);
  const check = JSON.parse(doctor.stdout).checks[0];
  assert.equal(check.status, 'fail');
  assert.equal(check.messageKey, 'schedule.machine_missing');
  assert.equal(doctor.status, EXIT.FAILURE);
});

// --- S7: a mark set before --new is not lost by the way out --------------------------------------

test('S7: watermark set before --new makes it refuse, the message does not offer to lose the mark, and the way it gives keeps it', async () => {
  for (const lang of ['en', 'pt-BR']) {
    const world = makeWorld({ lang });
    const set = cli(world, ['watermark', 'set', 'transcripts', '2020-01-02']);
    assert.equal(set.status, EXIT.OK, set.stdout + set.stderr);
    assert.ok(existsSync(join(world.stateDir, 'watermark.json')));
    const r = await machine(world, ['register', '--new']);
    assert.equal(r.code, EXIT.FAILURE, r.stderr);
    assert.ok(r.stderr.includes('watermark.json'), r.stderr);
    assert.ok(!/do not need them|não precisa deles/.test(r.stderr), `${lang}: it must not offer to throw the mark away: ${r.stderr}`);
    assert.match(r.stderr, lang === 'en' ? /watermark set/ : /watermark set/);
    assert.match(r.stderr, lang === 'en' ? /back/ : /de volta/);
    // The way it gives: move aside, --new, move back.
    const aside = join(world.base, 'aside');
    mkdirSync(aside);
    renameSync(join(world.stateDir, 'watermark.json'), join(aside, 'watermark.json'));
    assert.equal((await machine(world, ['register', '--new'])).code, EXIT.OK);
    renameSync(join(aside, 'watermark.json'), join(world.stateDir, 'watermark.json'));
    const show = cli(world, ['watermark', 'show']);
    assert.equal(show.status, EXIT.OK, show.stderr);
    assert.ok(show.stdout.includes('02/01/2020'), show.stdout);
  }
  const doc = readFileSync(join(KIT_ROOT, 'docs', 'scheduling.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## The same vault on a second machine'), doc.indexOf('## Moving from a legacy lock'));
  assert.match(section, /after `brain-kit machine register --new`/, 'the marks are set after --new');
});
