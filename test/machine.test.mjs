// `brain-kit machine show|set|register`: the one command that reads and
// edits a vault's machine.json, the machine-local file outside the vault
// that holds everything that executes or points at this machine.
//
// Nothing here touches the real home state directory: every run carries an
// env object whose XDG_STATE_HOME (and, where a test pins it,
// BRAIN_KIT_STATE_DIR) points inside a temporary directory, and the one
// test that spawns the real launcher removes BRAIN_KIT_STATE_DIR from the
// inherited environment and sets XDG_STATE_HOME itself.
//
// Every vault lives under a directory whose name has a space, an accented
// letter and both quote characters, because a real vault lives in a
// localised desktop folder and nothing may split that path.
//
// What these tests hold, beyond "it works": a refusal leaves every byte it
// refused to write where it was (compared byte for byte, and by mode), no
// temporary file is left beside machine.json, and after `register` the
// three doctor checks that read the state directory all call it healthy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers/tmp.mjs';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { stateDirFor, STATE_FILES } from '../src/state.mjs';
import { runMachine } from '../src/commands/machine.mjs';
import { runDoctor } from '../src/commands/doctor.mjs';

const A_ACUTE = String.fromCodePoint(0xc1);
const E_ACUTE = String.fromCodePoint(0xe9);
const PARENT_NAME = `${A_ACUTE}rea de trabalho`;
const VAULT_NAME = `Ana's "brain"`;
const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const t = createTranslator('en');

function makeVaultAt(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'brain-kit.config.json'), '{}\n');
  writeFileSync(join(root, 'index.md'), '# Index\n');
  return root;
}

// The machine.json init writes (src/commands/init.mjs, buildMachine), in
// the state directory derived from the vault's path, with init's modes.
function machineFor(root, stateDir, extra = {}) {
  return {
    vault_id: 'ana-brain-0a1b2c3d',
    canonical_path: realpathSync(root),
    claude_bin: '/opt/example/bin/claude',
    state_dir: stateDir,
    paths: {
      watermark: join(stateDir, STATE_FILES.WATERMARK),
      last_run: join(stateDir, STATE_FILES.LAST_RUN),
      log_dir: join(stateDir, STATE_FILES.LOG_DIR),
      questions_log: join(stateDir, STATE_FILES.QUESTIONS_LOG),
    },
    ...extra,
  };
}

function writeMachine(stateDir, value, { text = null, mode = 0o600 } = {}) {
  mkdirSync(stateDir, { recursive: true });
  chmodSync(stateDir, 0o700);
  const file = join(stateDir, 'machine.json');
  writeFileSync(file, text ?? `${JSON.stringify(value, null, 2)}\n`);
  chmodSync(file, mode);
  return file;
}

// A vault with a valid machine.json. `pinned` puts the state directory
// under BRAIN_KIT_STATE_DIR instead of deriving it from the path.
function setup({ name = VAULT_NAME, machine = {}, writeFile = true, pinned = false } = {}) {
  const base = makeTempDir('brain-kit-machine-');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const root = makeVaultAt(join(base, PARENT_NAME, name));
  const env = { HOME: home, XDG_STATE_HOME: join(base, 'state'), PATH: process.env.PATH };
  if (pinned) env.BRAIN_KIT_STATE_DIR = join(base, 'pinned state');
  const stateDir = stateDirFor(root, env);
  const machineFile = join(stateDir, 'machine.json');
  if (writeFile) writeMachine(stateDir, machineFor(root, stateDir, machine));
  return { base, home, root, env, stateDir, machineFile };
}

async function machine(fx, argv, { env = fx.env, cwd = fx.root, deps = {} } = {}) {
  let stdout = '';
  let stderr = '';
  const io = { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } };
  const code = await runMachine(argv, io, t, { env, cwd, ...deps });
  return { code, stdout, stderr };
}

// The file's bytes and mode, so "unchanged" means unchanged.
function snapshot(file) {
  return { bytes: readFileSync(file), mode: statSync(file).mode & 0o7777 };
}

function assertUnchanged(file, before) {
  const after = snapshot(file);
  assert.ok(after.bytes.equals(before.bytes), `${file} changed:\n${before.bytes}\n---\n${after.bytes}`);
  assert.equal(after.mode, before.mode);
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function onlyMachineJson(dir) {
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('machine')), ['machine.json'], `leftover beside machine.json in ${dir}`);
}

async function stateChecks(root, env) {
  let out = '';
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } };
  const code = await runDoctor(['--json', '--only', 'machine-valid,state-dir-resolves,state-dir-mode', root], io, t, { env, cwd: root });
  const report = JSON.parse(out);
  return { code, byId: Object.fromEntries(report.checks.map((c) => [c.id, c])) };
}

// Moves the vault to a new parent directory, the way a person drags it.
function moveVault(fx, newName = `moved ${E_ACUTE} "here"`) {
  const to = join(fx.base, newName, VAULT_NAME);
  mkdirSync(join(fx.base, newName));
  renameSync(fx.root, to);
  return to;
}

// --- show --------------------------------------------------------------------

test('show prints this vault\'s machine.json and exits 0', async () => {
  const fx = setup();
  assert.ok(fx.root.includes(A_ACUTE) && fx.root.includes(' ') && fx.root.includes('"') && fx.root.includes("'"));
  const r = await machine(fx, ['show']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(r.stdout, readFileSync(fx.machineFile, 'utf8'));
  assert.equal(r.stderr, '');
});

test('show finds the vault from a directory argument and from a subdirectory', async () => {
  const fx = setup();
  mkdirSync(join(fx.root, 'notes'));
  let r = await machine(fx, ['show', fx.root], { cwd: fx.base });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(JSON.parse(r.stdout).canonical_path, realpathSync(fx.root));
  r = await machine(fx, ['show'], { cwd: join(fx.root, 'notes') });
  assert.equal(r.code, EXIT.OK, r.stderr);
});

test('show outside any vault exits 2 and says where it looked', async () => {
  const fx = setup();
  const outside = join(fx.base, 'elsewhere');
  mkdirSync(outside);
  const r = await machine(fx, ['show'], { cwd: outside });
  assert.equal(r.code, EXIT.USAGE);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no brain-kit vault/);
  assert.ok(r.stderr.includes(outside), r.stderr);
});

test('show of a path that does not exist, or is a file, exits 2 without climbing to a vault above it', async () => {
  const fx = setup();
  let r = await machine(fx, ['show', join(fx.root, 'typo')]);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.stderr, /does not exist/);
  r = await machine(fx, ['show', join(fx.root, 'index.md')]);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.stderr, /not a directory/);
});

test('show in a vault with no machine.json exits 1 and names the file it looked for', async () => {
  const fx = setup({ writeFile: false });
  const r = await machine(fx, ['show']);
  assert.equal(r.code, EXIT.FAILURE);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.includes(fx.machineFile), r.stderr);
  assert.match(r.stderr, /machine register --from/);
});

test('show of a machine.json the schema rejects prints it and exits 1 with the errors', async () => {
  const fx = setup({ machine: { claude_bin: '' } });
  const r = await machine(fx, ['show']);
  assert.equal(r.code, EXIT.FAILURE);
  assert.equal(r.stdout, readFileSync(fx.machineFile, 'utf8'));
  assert.match(r.stderr, /claude_bin/);
});

test('show of a machine.json that is not JSON exits 1', async () => {
  const fx = setup();
  writeMachine(fx.stateDir, null, { text: '{ not json' });
  const r = await machine(fx, ['show']);
  assert.equal(r.code, EXIT.FAILURE);
  assert.ok(r.stderr.includes(fx.machineFile), r.stderr);
  assert.match(r.stderr, /is not JSON/);
});

test('show of an older file carrying the retired lock and snapshot paths exits 0', async () => {
  const fx = setup();
  const value = machineFor(fx.root, fx.stateDir);
  value.paths.lock = join(fx.stateDir, 'lock');
  value.paths.snapshot = join(fx.stateDir, 'snapshot.json');
  writeMachine(fx.stateDir, value);
  const r = await machine(fx, ['show']);
  assert.equal(r.code, EXIT.OK, r.stderr);
});

// --- set ---------------------------------------------------------------------

test('set of a string key writes it, keeps every other key, and leaves the file at 0600 with no temporary file beside it', async () => {
  const fx = setup();
  const before = readJson(fx.machineFile);
  const bin = join(fx.base, `tools ${E_ACUTE}`, "Ana's claude");
  const r = await machine(fx, ['set', 'claude_bin', bin]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const after = readJson(fx.machineFile);
  assert.deepEqual(after, { ...before, claude_bin: bin });
  assert.equal(mode(fx.machineFile), 0o600);
  onlyMachineJson(fx.stateDir);
});

test('set of an array key takes a JSON array and stores each argument literally, never through a shell', async () => {
  const fx = setup();
  const argv = ['notify-send', 'brain-kit: "done"', '$(touch pwned)', '`id`', 'a b', `r${E_ACUTE}sum${E_ACUTE}`];
  const r = await machine(fx, ['set', 'notify_command', JSON.stringify(argv)]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(readJson(fx.machineFile).notify_command, argv);
  assert.equal(existsSync(join(fx.root, 'pwned')), false);
  assert.equal(mode(fx.machineFile), 0o600);
});

test('set of an array key given as a plain string, or a JSON value that is not an array, is refused and changes nothing', async () => {
  const fx = setup();
  const before = snapshot(fx.machineFile);
  for (const value of ['notify-send done', '"notify-send"', '{"a":1}', '', 'null']) {
    const r = await machine(fx, ['set', 'notify_command', value]);
    assert.equal(r.code, EXIT.USAGE, `${value}: ${r.stderr}`);
    assert.match(r.stderr, /JSON array/);
    assertUnchanged(fx.machineFile, before);
  }
});

test('set of an array whose items are not strings is refused by the schema and changes nothing', async () => {
  const fx = setup();
  const before = snapshot(fx.machineFile);
  const r = await machine(fx, ['set', 'path_extra', '["/opt/bin", 3]']);
  assert.equal(r.code, EXIT.FAILURE);
  assert.match(r.stderr, /path_extra/);
  assertUnchanged(fx.machineFile, before);
});

test('set parses integers, booleans, null and nested paths keys by the type the schema declares', async () => {
  const fx = setup();
  let r = await machine(fx, ['set', 'log_retention_days', '30']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  r = await machine(fx, ['set', 'keep_stream', 'true']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  r = await machine(fx, ['set', 'model', 'claude-opus-5-5']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  r = await machine(fx, ['set', 'briefing_task_id', 'null']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const logs = join(fx.base, 'logs elsewhere');
  r = await machine(fx, ['set', 'paths.log_dir', logs]);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const after = readJson(fx.machineFile);
  assert.equal(after.log_retention_days, 30);
  assert.equal(after.keep_stream, true);
  assert.equal(after.model, 'claude-opus-5-5');
  assert.equal(after.briefing_task_id, null);
  assert.equal(after.paths.log_dir, logs);
  assert.equal(after.paths.watermark, join(fx.stateDir, STATE_FILES.WATERMARK));
  assert.equal(mode(fx.machineFile), 0o600);
});

test('set refuses a value that does not parse as the key\'s type and changes nothing', async () => {
  const fx = setup();
  const before = snapshot(fx.machineFile);
  for (const [key, value, pattern] of [
    ['keep_stream', 'yes', /true or false/],
    ['log_retention_days', '1.5', /whole number/],
    ['log_retention_days', 'thirty', /whole number/],
    ['log_retention_days', '', /whole number/],
    ['paths', '["a"]', /JSON object/],
  ]) {
    const r = await machine(fx, ['set', key, value]);
    assert.equal(r.code, EXIT.USAGE, `${key}=${value}: ${r.stderr}`);
    assert.match(r.stderr, pattern);
    assertUnchanged(fx.machineFile, before);
  }
});

test('set of a value the schema rejects is refused with exit 1 and leaves the file byte for byte unchanged', async () => {
  const fx = setup();
  const before = snapshot(fx.machineFile);
  for (const [key, value] of [
    ['log_retention_days', '0'],
    ['claude_bin', ''],
    ['paths', '{"watermark":"w","last_run":"l","log_dir":"d","extra":"x"}'],
    ['paths', '{"watermark":"w"}'],
  ]) {
    const r = await machine(fx, ['set', key, value]);
    assert.equal(r.code, EXIT.FAILURE, `${key}=${value}: ${r.stderr}`);
    assert.match(r.stderr, /left as it was/);
    assertUnchanged(fx.machineFile, before);
    onlyMachineJson(fx.stateDir);
  }
  // A nullable string is still a string when it is not null.
  const r = await machine(fx, ['set', 'model', '']);
  assert.equal(r.code, EXIT.OK, r.stderr);
});

test('set of a key the schema does not declare is refused with exit 2 and changes nothing', async () => {
  const fx = setup();
  const before = snapshot(fx.machineFile);
  for (const key of ['notify', 'lock', 'paths.lock', 'paths.snapshot', 'paths.nope', 'claude_bin.x', 'paths.watermark.x',
    '__proto__', 'constructor', 'toString', 'paths.__proto__', 'paths.constructor', 'hasOwnProperty', '', '.', 'paths.']) {
    const r = await machine(fx, ['set', key, 'x']);
    assert.equal(r.code, EXIT.USAGE, `${key}: ${r.stderr}`);
    assert.match(r.stderr, /not a machine\.json key/);
    assertUnchanged(fx.machineFile, before);
  }
});

test('set refuses the keys only init and register write: vault_id, canonical_path, state_dir', async () => {
  const fx = setup();
  const before = snapshot(fx.machineFile);
  for (const key of ['vault_id', 'canonical_path', 'state_dir']) {
    const r = await machine(fx, ['set', key, 'ana-other']);
    assert.equal(r.code, EXIT.USAGE, `${key}: ${r.stderr}`);
    assert.match(r.stderr, /machine register/);
    assertUnchanged(fx.machineFile, before);
  }
});

test('set with no machine.json exits 1 and creates nothing', async () => {
  const fx = setup({ writeFile: false });
  const r = await machine(fx, ['set', 'claude_bin', '/opt/example/claude']);
  assert.equal(r.code, EXIT.FAILURE);
  assert.ok(r.stderr.includes(fx.machineFile), r.stderr);
  assert.match(r.stderr, /no machine\.json at/);
  assert.equal(existsSync(fx.machineFile), false);
  assert.equal(existsSync(fx.stateDir), false);
});

test('set on a machine.json that is not JSON, or not an object, exits 1 and leaves it as it was', async () => {
  const fx = setup();
  for (const text of ['{ not json', '[]', 'null', '"x"']) {
    writeMachine(fx.stateDir, null, { text });
    const before = snapshot(fx.machineFile);
    const r = await machine(fx, ['set', 'claude_bin', '/opt/example/claude']);
    assert.equal(r.code, EXIT.FAILURE, `${text}: ${r.stderr}`);
    assert.match(r.stderr, text === '{ not json' ? /is not JSON/ : /must be an object/);
    assertUnchanged(fx.machineFile, before);
  }
});

test('set writes 0600 even under a umask that takes the owner\'s write bit away', async () => {
  const fx = setup();
  const previous = process.umask(0o377);
  let r;
  try {
    r = await machine(fx, ['set', 'claude_bin', '/opt/example/claude']);
  } finally {
    process.umask(previous);
  }
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(mode(fx.machineFile), 0o600);
});

test('set brings a file left at 0644 back to 0600', async () => {
  const fx = setup();
  chmodSync(fx.machineFile, 0o644);
  const r = await machine(fx, ['set', 'claude_bin', '/opt/example/claude']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(mode(fx.machineFile), 0o600);
});

test('set on an older file drops the retired lock and snapshot paths and keeps the rest', async () => {
  const fx = setup();
  const value = machineFor(fx.root, fx.stateDir);
  value.paths.lock = join(fx.stateDir, 'lock');
  value.paths.snapshot = join(fx.stateDir, 'snapshot.json');
  writeMachine(fx.stateDir, value);
  const r = await machine(fx, ['set', 'claude_bin', '/opt/example/claude']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  const after = readJson(fx.machineFile);
  assert.deepEqual(Object.keys(after.paths).sort(), ['last_run', 'log_dir', 'questions_log', 'watermark']);
  assert.equal(after.paths.watermark, value.paths.watermark);
});

test('set of a whole paths object carrying a retired key writes it without that key', async () => {
  const fx = setup();
  const r = await machine(fx, ['set', 'paths', '{"watermark":"w","last_run":"l","log_dir":"d","lock":"k","snapshot":"s"}']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.deepEqual(readJson(fx.machineFile).paths, { watermark: 'w', last_run: 'l', log_dir: 'd' });
});

test('set writes the machine.json of the vault it was pointed at, not of the working directory', async () => {
  const a = setup({ name: 'vault a' });
  const b = setup({ name: 'vault b' });
  const beforeA = snapshot(a.machineFile);
  const r = await machine(b, ['set', 'claude_bin', '/opt/example/b', b.root], { cwd: a.root });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assertUnchanged(a.machineFile, beforeA);
  assert.equal(readJson(b.machineFile).claude_bin, '/opt/example/b');
});

test('set of a value that starts with a dash is a value, not a flag', async () => {
  const fx = setup();
  const r = await machine(fx, ['set', 'model', '--help']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(readJson(fx.machineFile).model, '--help');
});

test('a write that cannot rename leaves the old file and no temporary file behind', async () => {
  const fx = setup();
  const before = snapshot(fx.machineFile);
  const renameFails = () => { throw Object.assign(new Error('EXDEV: simulated'), { code: 'EXDEV' }); };
  await assert.rejects(machine(fx, ['set', 'claude_bin', '/opt/example/claude'], { deps: { rename: renameFails } }), /EXDEV/);
  assertUnchanged(fx.machineFile, before);
  onlyMachineJson(fx.stateDir);
});

test('show and set refuse a pinned machine.json that records another vault still in place, and change nothing', async () => {
  const a = setup({ pinned: true, name: 'vault a' });
  const b = setup({ name: 'vault b', writeFile: false });
  const env = { ...b.env, BRAIN_KIT_STATE_DIR: a.stateDir };
  const before = snapshot(a.machineFile);
  let r = await machine(b, ['show'], { env });
  assert.equal(r.code, EXIT.FAILURE);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.includes(realpathSync(a.root)), r.stderr);
  r = await machine(b, ['set', 'claude_bin', '/opt/example/b'], { env });
  assert.equal(r.code, EXIT.FAILURE);
  assert.ok(r.stderr.includes(realpathSync(a.root)), r.stderr);
  assertUnchanged(a.machineFile, before);
  // The vault it records may still read and edit it.
  r = await machine(a, ['set', 'claude_bin', '/opt/example/a']);
  assert.equal(r.code, EXIT.OK, r.stderr);
});

test('set still works in a pinned state directory whose vault moved and is not yet registered', async () => {
  const fx = setup({ pinned: true });
  const newRoot = moveVault(fx);
  const r = await machine(fx, ['set', 'claude_bin', '/opt/example/claude'], { cwd: newRoot });
  assert.equal(r.code, EXIT.OK, r.stderr);
});

// --- register ------------------------------------------------------------------

test('register after a move carries the state to the directory the new path implies, and doctor calls it healthy', async () => {
  const fx = setup();
  writeFileSync(join(fx.stateDir, STATE_FILES.WATERMARK), '{"day":"2026-09-22"}\n');
  mkdirSync(join(fx.stateDir, STATE_FILES.LOG_DIR));
  writeFileSync(join(fx.stateDir, STATE_FILES.LOG_DIR, 'run.log'), 'ok\n');
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  const newState = stateDirFor(newRoot, fx.env);
  assert.notEqual(newState, fx.stateDir);

  // Control: before register, doctor sees the move.
  const control = await stateChecks(newRoot, fx.env);
  assert.equal(control.byId['state-dir-resolves'].status, 'fail');
  assert.equal(control.code, EXIT.FAILURE);

  const r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(existsSync(fx.stateDir), false);
  const file = join(newState, 'machine.json');
  const after = readJson(file);
  assert.equal(after.canonical_path, realpathSync(newRoot));
  assert.equal(after.vault_id, 'ana-brain-0a1b2c3d');
  assert.equal(after.state_dir, newState);
  assert.deepEqual(after.paths, {
    watermark: join(newState, STATE_FILES.WATERMARK),
    last_run: join(newState, STATE_FILES.LAST_RUN),
    log_dir: join(newState, STATE_FILES.LOG_DIR),
    questions_log: join(newState, STATE_FILES.QUESTIONS_LOG),
  });
  assert.equal(readFileSync(join(newState, STATE_FILES.WATERMARK), 'utf8'), '{"day":"2026-09-22"}\n');
  assert.equal(readFileSync(join(newState, STATE_FILES.LOG_DIR, 'run.log'), 'utf8'), 'ok\n');
  assert.equal(mode(file), 0o600);
  assert.equal(mode(newState), 0o700);
  onlyMachineJson(newState);

  const doctor = await stateChecks(newRoot, fx.env);
  for (const id of ['machine-valid', 'state-dir-resolves', 'state-dir-mode']) {
    assert.equal(doctor.byId[id].status, 'ok', JSON.stringify(doctor.byId[id]));
  }
  assert.equal(doctor.code, EXIT.OK);
});

test('register --from accepts a path relative to the working directory', async () => {
  const fx = setup();
  const newRoot = moveVault(fx);
  const r = await machine(fx, ['register', newRoot, '--from', join(PARENT_NAME, VAULT_NAME)], { cwd: fx.base });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(readJson(join(stateDirFor(newRoot, fx.env), 'machine.json')).canonical_path, realpathSync(newRoot));
});

test('register keeps a path a person pointed outside the state directory', async () => {
  const logs = '/var/example/ana-logs';
  const fx = setup();
  const value = machineFor(fx.root, fx.stateDir);
  value.paths.log_dir = logs;
  value.transcripts_dir = '/var/example/transcripts';
  writeMachine(fx.stateDir, value);
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  const r = await machine(fx, ['register', `--from=${oldRoot}`], { cwd: newRoot });
  assert.equal(r.code, EXIT.OK, r.stderr);
  const after = readJson(join(stateDirFor(newRoot, fx.env), 'machine.json'));
  assert.equal(after.paths.log_dir, logs);
  assert.equal(after.transcripts_dir, '/var/example/transcripts');
});

test('register after a move with no --from exits 2, lists the state that lost its vault, and moves nothing', async () => {
  const fx = setup();
  const before = snapshot(fx.machineFile);
  const recorded = readJson(fx.machineFile).canonical_path;
  const newRoot = moveVault(fx);
  const r = await machine(fx, ['register'], { cwd: newRoot });
  assert.equal(r.code, EXIT.USAGE);
  assert.ok(r.stderr.includes(recorded), r.stderr);
  assert.ok(r.stderr.includes(fx.stateDir), r.stderr);
  assert.match(r.stderr, /--from/);
  assertUnchanged(fx.machineFile, before);
  assert.equal(existsSync(stateDirFor(newRoot, fx.env)), false);
});

test('register finds the old state of a vault moved with a symbolic link left at its old path, and lists it without --from', async () => {
  const fx = setup();
  const oldRoot = fx.root;
  const recorded = readJson(fx.machineFile).canonical_path;
  const newRoot = moveVault(fx);
  symlinkSync(newRoot, oldRoot);
  const target = stateDirFor(newRoot, fx.env);
  let r = await machine(fx, ['register'], { cwd: newRoot });
  assert.equal(r.code, EXIT.USAGE);
  assert.ok(r.stderr.includes(recorded) && r.stderr.includes(fx.stateDir), r.stderr);
  r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(existsSync(fx.stateDir), false);
  assert.equal(readJson(join(target, 'machine.json')).canonical_path, realpathSync(newRoot));
  const doctor = await stateChecks(newRoot, fx.env);
  for (const id of ['machine-valid', 'state-dir-resolves', 'state-dir-mode']) {
    assert.equal(doctor.byId[id].status, 'ok', JSON.stringify(doctor.byId[id]));
  }
});

test('register --from a path that never had state here exits 1 and moves nothing', async () => {
  const fx = setup();
  const newRoot = moveVault(fx);
  const r = await machine(fx, ['register', '--from', join(fx.base, 'never')], { cwd: newRoot });
  assert.equal(r.code, EXIT.FAILURE);
  assert.equal(existsSync(fx.machineFile), true);
  assert.equal(existsSync(stateDirFor(newRoot, fx.env)), false);
});

test('register refuses when the target state directory holds another vault\'s machine.json, and changes neither', async () => {
  const fx = setup();
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  const target = stateDirFor(newRoot, fx.env);
  const other = makeVaultAt(join(fx.base, 'other vault'));
  const otherFile = writeMachine(target, machineFor(other, target, { vault_id: 'other-vault' }));
  const beforeTarget = snapshot(otherFile);
  const beforeSource = snapshot(fx.machineFile);
  const r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.FAILURE);
  assert.ok(r.stderr.includes(otherFile), r.stderr);
  assert.match(r.stderr, /records the vault at/);
  // Refused by its own clause, not caught later by the empty-directory one.
  assert.doesNotMatch(r.stderr, /holds files but no machine\.json/);
  assertUnchanged(otherFile, beforeTarget);
  assertUnchanged(fx.machineFile, beforeSource);
});

test('register refuses a target machine.json whose vault is gone too: only a record of this vault may be replaced', async () => {
  const fx = setup();
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  const target = stateDirFor(newRoot, fx.env);
  const otherFile = writeMachine(target, machineFor(fx.base, target, { canonical_path: join(fx.base, 'gone vault') }));
  const beforeTarget = snapshot(otherFile);
  const beforeSource = snapshot(fx.machineFile);
  const r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.FAILURE);
  assertUnchanged(otherFile, beforeTarget);
  assertUnchanged(fx.machineFile, beforeSource);
});

test('register refuses a target machine.json it cannot read, and changes neither', async () => {
  const fx = setup();
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  const target = stateDirFor(newRoot, fx.env);
  const otherFile = writeMachine(target, null, { text: '{ broken' });
  const beforeTarget = snapshot(otherFile);
  const beforeSource = snapshot(fx.machineFile);
  const r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.FAILURE);
  assert.match(r.stderr, /cannot be read/);
  assertUnchanged(otherFile, beforeTarget);
  assertUnchanged(fx.machineFile, beforeSource);
});

test('register refuses a target state directory that holds files but no machine.json', async () => {
  const fx = setup();
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  const target = stateDirFor(newRoot, fx.env);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, STATE_FILES.WATERMARK), 'someone else\n');
  const beforeSource = snapshot(fx.machineFile);
  const r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.FAILURE);
  assert.equal(readFileSync(join(target, STATE_FILES.WATERMARK), 'utf8'), 'someone else\n');
  assert.equal(existsSync(join(target, 'machine.json')), false);
  assertUnchanged(fx.machineFile, beforeSource);
});

test('register takes over an empty target state directory', async () => {
  const fx = setup();
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  const target = stateDirFor(newRoot, fx.env);
  mkdirSync(target, { recursive: true, mode: 0o755 });
  chmodSync(target, 0o755);
  const r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(mode(target), 0o700);
  assert.equal(readJson(join(target, 'machine.json')).canonical_path, realpathSync(newRoot));
});

test('register refuses to take the state of a vault that still exists where its machine.json says (a copy, not a move)', async () => {
  const fx = setup();
  const copy = join(fx.base, 'copy of it', VAULT_NAME);
  cpSync(fx.root, copy, { recursive: true });
  const before = snapshot(fx.machineFile);
  let r = await machine(fx, ['register', '--from', fx.root], { cwd: copy });
  assert.equal(r.code, EXIT.FAILURE);
  assert.ok(r.stderr.includes(realpathSync(fx.root)), r.stderr);
  assert.match(r.stderr, /still there/);
  assertUnchanged(fx.machineFile, before);
  assert.equal(existsSync(stateDirFor(copy, fx.env)), false);
  // The original named through a link to it: the same state, the same refusal.
  const link = join(fx.base, 'link to original');
  symlinkSync(fx.root, link);
  r = await machine(fx, ['register', '--from', link], { cwd: copy });
  assert.equal(r.code, EXIT.FAILURE);
  assert.match(r.stderr, /still there/);
  assertUnchanged(fx.machineFile, before);
});

test('register of a vault already registered where it is exits 0 and writes nothing', async () => {
  const fx = setup();
  const before = snapshot(fx.machineFile);
  const mtime = statSync(fx.machineFile).mtimeMs;
  const r = await machine(fx, ['register']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.match(r.stdout, /already/);
  assertUnchanged(fx.machineFile, before);
  assert.equal(statSync(fx.machineFile).mtimeMs, mtime);
});

test('register --from after the state already moved leaves both where they are and exits 0', async () => {
  const fx = setup();
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  let r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.OK, r.stderr);
  const file = join(stateDirFor(newRoot, fx.env), 'machine.json');
  const before = snapshot(file);
  // Someone recreated a record at the old place; it is not touched.
  writeMachine(fx.stateDir, machineFor(fx.base, fx.stateDir, { canonical_path: oldRoot }));
  const beforeOld = snapshot(fx.machineFile);
  r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assertUnchanged(file, before);
  assertUnchanged(fx.machineFile, beforeOld);
});

test('register --from answers already registered only for a target record doctor calls healthy', async () => {
  const fx = setup();
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  const target = stateDirFor(newRoot, fx.env);
  // A record of this vault at the target that the schema rejects: refused, not "already".
  const file = writeMachine(target, machineFor(newRoot, target, { claude_bin: '' }));
  const before = snapshot(file);
  let r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.FAILURE, r.stdout);
  assertUnchanged(file, before);
  // A valid one at the wrong modes: exit 0, and doctor agrees.
  writeMachine(target, machineFor(newRoot, target), { mode: 0o644 });
  chmodSync(target, 0o755);
  const content = readFileSync(file);
  r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.ok(readFileSync(file).equals(content));
  const doctor = await stateChecks(newRoot, fx.env);
  for (const id of ['machine-valid', 'state-dir-resolves', 'state-dir-mode']) {
    assert.equal(doctor.byId[id].status, 'ok', JSON.stringify(doctor.byId[id]));
  }
  assert.equal(existsSync(fx.machineFile), true);
});

test('register of a vault already registered in place at the wrong modes sets them and leaves the content', async () => {
  const fx = setup();
  chmodSync(fx.machineFile, 0o640);
  chmodSync(fx.stateDir, 0o750);
  const content = readFileSync(fx.machineFile);
  const r = await machine(fx, ['register']);
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.ok(readFileSync(fx.machineFile).equals(content));
  assert.equal(mode(fx.machineFile), 0o600);
  assert.equal(mode(fx.stateDir), 0o700);
});

test('register of a source machine.json that is not JSON exits 1 and moves nothing', async () => {
  const fx = setup();
  writeMachine(fx.stateDir, null, { text: '{ not json' });
  const before = snapshot(fx.machineFile);
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  const r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.FAILURE);
  assert.match(r.stderr, /is not JSON/);
  assertUnchanged(fx.machineFile, before);
  assert.equal(existsSync(stateDirFor(newRoot, fx.env)), false);
});

test('register with the state directory pinned at the wrong mode leaves it at 0700', async () => {
  const fx = setup({ pinned: true });
  chmodSync(fx.stateDir, 0o750);
  const newRoot = moveVault(fx);
  const r = await machine(fx, ['register'], { cwd: newRoot });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(mode(fx.stateDir), 0o700);
  assert.equal((await stateChecks(newRoot, fx.env)).byId['state-dir-mode'].status, 'ok');
});

test('register refuses a state directory inside the vault as reached through a link', async () => {
  const fx = setup({ pinned: true });
  const link = join(fx.base, 'vault link');
  symlinkSync(fx.root, link);
  const inside = join(link, '.state');
  const r = await machine(fx, ['register'], { cwd: link, env: { ...fx.env, BRAIN_KIT_STATE_DIR: inside } });
  assert.equal(r.code, EXIT.USAGE, r.stderr);
  assert.match(r.stderr, /is inside the vault/);
  assert.equal(existsSync(join(fx.root, '.state')), false);
});

test('register takes the state when the old path now holds a directory that is not a vault', async () => {
  const fx = setup();
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  mkdirSync(oldRoot);
  const r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(readJson(join(stateDirFor(newRoot, fx.env), 'machine.json')).canonical_path, realpathSync(newRoot));
});

test('register rewrites a relative canonical_path, never resolving it against the working directory', async () => {
  const fx = setup({ pinned: true, machine: { canonical_path: '.' } });
  // Run from inside the vault, where "." would resolve to it: a relative
  // path read that way would answer "already registered" and leave "." in
  // place, which doctor reads as a vault somewhere else.
  const previous = process.cwd();
  process.chdir(fx.root);
  let r;
  try {
    r = await machine(fx, ['register']);
  } finally {
    process.chdir(previous);
  }
  assert.equal(r.code, EXIT.OK, r.stderr);
  assert.equal(readJson(fx.machineFile).canonical_path, realpathSync(fx.root));
  assert.equal((await stateChecks(fx.root, fx.env)).byId['machine-valid'].status, 'ok');
});

test('register of a source machine.json the schema rejects exits 1 and moves nothing', async () => {
  const fx = setup({ machine: { claude_bin: '' } });
  const before = snapshot(fx.machineFile);
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  const r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot });
  assert.equal(r.code, EXIT.FAILURE);
  assertUnchanged(fx.machineFile, before);
  assert.equal(existsSync(stateDirFor(newRoot, fx.env)), false);
});

test('register with the state directory pinned rewrites canonical_path in place, and doctor calls it healthy', async () => {
  const fx = setup({ pinned: true });
  const newRoot = moveVault(fx);
  assert.equal(stateDirFor(newRoot, fx.env), fx.stateDir);
  const before = readJson(fx.machineFile);
  const r = await machine(fx, ['register'], { cwd: newRoot });
  assert.equal(r.code, EXIT.OK, r.stderr);
  const after = readJson(fx.machineFile);
  assert.deepEqual(after, { ...before, canonical_path: realpathSync(newRoot) });
  assert.equal(mode(fx.machineFile), 0o600);
  onlyMachineJson(fx.stateDir);
  const doctor = await stateChecks(newRoot, fx.env);
  for (const id of ['machine-valid', 'state-dir-resolves', 'state-dir-mode']) {
    assert.equal(doctor.byId[id].status, 'ok', JSON.stringify(doctor.byId[id]));
  }
});

test('register with the state directory pinned refuses a machine.json that records another vault still in place', async () => {
  const fx = setup({ pinned: true });
  const other = setup();
  const before = snapshot(fx.machineFile);
  const r = await machine(other, ['register'], { cwd: other.root, env: { ...other.env, BRAIN_KIT_STATE_DIR: fx.stateDir } });
  assert.equal(r.code, EXIT.FAILURE);
  assert.ok(r.stderr.includes(realpathSync(fx.root)), r.stderr);
  assertUnchanged(fx.machineFile, before);
});

test('register refuses a state directory inside the vault', async () => {
  const fx = setup({ pinned: true });
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  const inside = join(newRoot, '.state');
  const r = await machine(fx, ['register', '--from', oldRoot], { cwd: newRoot, env: { ...fx.env, BRAIN_KIT_STATE_DIR: inside } });
  assert.equal(r.code, EXIT.USAGE);
  assert.equal(existsSync(inside), false);
  assert.equal(existsSync(fx.machineFile), true);
});

test('a register whose write fails puts the state back where it was', async () => {
  const fx = setup();
  const before = snapshot(fx.machineFile);
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  const target = stateDirFor(newRoot, fx.env);
  let calls = 0;
  const rename = (from, to) => {
    calls += 1;
    // The first rename moves the directory; the second is the write's.
    if (calls === 2) throw Object.assign(new Error('ENOSPC: simulated'), { code: 'ENOSPC' });
    return renameSync(from, to);
  };
  await assert.rejects(machine(fx, ['register', '--from', oldRoot], { cwd: newRoot, deps: { rename } }), /ENOSPC/);
  assertUnchanged(fx.machineFile, before);
  onlyMachineJson(fx.stateDir);
  assert.equal(existsSync(target), false);
});

// --- usage and wiring -----------------------------------------------------------

test('usage errors exit 2 and write nothing', async () => {
  const fx = setup();
  const before = snapshot(fx.machineFile);
  for (const argv of [[], ['frobnicate'], ['set'], ['set', 'claude_bin'], ['set', 'claude_bin', 'x', fx.root, 'extra'],
    ['show', fx.root, 'extra'], ['show', '--json'], ['register', '--from'], ['register', '--from='], ['register', '--bogus'], ['register', 'a', 'b']]) {
    const r = await machine(fx, argv);
    assert.equal(r.code, EXIT.USAGE, `${JSON.stringify(argv)}: ${r.stderr}`);
    assert.match(r.stderr, /Usage: brain-kit machine/);
    assertUnchanged(fx.machineFile, before);
  }
  const help = await machine(fx, ['--help']);
  assert.equal(help.code, EXIT.OK);
  assert.match(help.stdout, /Usage: brain-kit machine/);
});

test('the real launcher runs machine show and machine set, with the state directory pinned to scratch', () => {
  const fx = setup();
  const env = { ...process.env, ...fx.env, BRAIN_KIT_LANG: 'en' };
  delete env.BRAIN_KIT_STATE_DIR;
  let r = spawnSync(process.execPath, [BIN, 'machine', 'show'], { cwd: fx.root, env, encoding: 'utf8' });
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(r.stdout, readFileSync(fx.machineFile, 'utf8'));
  r = spawnSync(process.execPath, [BIN, 'machine', 'set', 'log_retention_days', '0'], { cwd: fx.root, env, encoding: 'utf8' });
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  r = spawnSync(process.execPath, [BIN, 'machine', 'set', 'log_retention_days', '14'], { cwd: fx.root, env, encoding: 'utf8' });
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(readJson(fx.machineFile).log_retention_days, 14);
  r = spawnSync(process.execPath, [BIN, '--help'], { env, encoding: 'utf8' });
  assert.match(r.stdout, /machine show/);
});

test('a register whose write and whose way back both fail says where the state is and how to put it back', async () => {
  const fx = setup();
  const oldRoot = fx.root;
  const newRoot = moveVault(fx);
  const target = stateDirFor(newRoot, fx.env);
  let calls = 0;
  const rename = (from, to) => {
    calls += 1;
    if (calls >= 2) throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' });
    return renameSync(from, to);
  };
  let stderr = '';
  const io = { stdout: { write: () => {} }, stderr: { write: (s) => { stderr += s; } } };
  await assert.rejects(runMachine(['register', '--from', oldRoot], io, t, { env: fx.env, cwd: newRoot, rename }), /EIO/);
  assert.ok(stderr.includes(target) && stderr.includes(fx.stateDir), stderr);
  assert.match(stderr, /by hand/);
  assert.equal(existsSync(join(target, 'machine.json')), true);
});
