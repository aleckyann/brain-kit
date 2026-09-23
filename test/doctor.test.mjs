// `brain-kit doctor`, the phase 1 checks.
//
// Every check is driven into each of its states with a PATH this file
// builds itself (a directory holding a link to the real git and small
// shell scripts standing in for gh and claude), a HOME and git
// configuration isolated from the machine running the suite, and a
// throwaway repository. Nothing here reads the real home state directory:
// every run carries XDG_STATE_HOME (and, where a test needs the override,
// BRAIN_KIT_STATE_DIR) pointing inside a temporary directory.
//
// Every vault this file builds lives under a directory whose name has a
// space, an accented letter and both quote characters in it, because a
// real vault lives in a localised desktop folder and nothing may split
// that path (Review Focus 1).
//
// The recurring shape of this project, held here as tests: a probe that
// exits 0 and prints nothing is never reported `ok`. A stand-in `git`,
// `gh` and `claude` that do exactly that are on PATH in one test each,
// and every check that asked them must come back as something other than
// `ok`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { makeTempDir } from './helpers/tmp.mjs';
import { KIT_ROOT, kitVersion } from '../src/version.mjs';
import { createTranslator } from '../src/lang.mjs';
import { stateDirFor } from '../src/state.mjs';
import { runDoctor } from '../src/commands/doctor.mjs';
import { CHECK_IDS, exitCodeFor, runChecks } from '../src/doctor/checks.mjs';
import { EXIT } from '../src/exit-codes.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const TEMPLATE_HOOK = join(KIT_ROOT, 'templates', 'githooks', 'pre-push');
const A_ACUTE = String.fromCodePoint(0xc1);
// A localised desktop folder, and a vault name carrying both quotes.
const PARENT_NAME = `${A_ACUTE}rea de trabalho`;
const VAULT_NAME = `Ana's "brain"`;

function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  throw new Error(`the suite needs a real ${name} on PATH`);
}
const REAL_GIT = findOnPath('git');

function writeScript(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

// The stand-ins. `silent` is the recurring shape: status 0, no output.
const SCRIPTS = {
  gh: {
    ok: 'echo "gh version 2.40.1 (2026-01-01)"\necho "https://example.invalid/releases/v2.40.1"',
    silent: 'exit 0',
    broken: 'echo "gh: something went wrong" >&2\nexit 3',
  },
  claude: {
    ok: 'echo "1.2.3 (Claude Code)"',
    silent: 'exit 0',
    broken: 'echo "stub: postinstall never ran" >&2\nexit 1',
  },
  git: {
    silent: 'exit 0',
  },
};

// Builds a tools directory: `git` is a link to the real one unless told
// otherwise, `gh` and `claude` are stand-ins in the state asked for, and
// `absent` leaves a tool out altogether. `git: { script }` puts a scripted
// git on PATH, one that answers each subcommand the way a test needs, to
// reach the clauses the real git never exercises (a status and an output
// that disagree).
function makeTools({ git = 'real', gh = 'ok', claude = 'ok' } = {}) {
  const dir = join(makeTempDir('brain-kit-doctor-tools-'), 'bin');
  mkdirSync(dir);
  if (git === 'real') symlinkSync(REAL_GIT, join(dir, 'git'));
  else if (typeof git === 'object') writeScript(join(dir, 'git'), git.script);
  else if (git !== 'absent') writeScript(join(dir, 'git'), SCRIPTS.git[git]);
  if (gh !== 'absent') writeScript(join(dir, 'gh'), SCRIPTS.gh[gh]);
  if (claude !== 'absent') writeScript(join(dir, 'claude'), SCRIPTS.claude[claude]);
  return dir;
}

// A git invocation for building fixtures, never for the thing under test:
// the real git, an identity on the command line (fixture commits only),
// and a configuration isolated from the machine's own.
function fixtureGit(cwd, args, home) {
  const r = spawnSync(REAL_GIT, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig') },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r;
}

function baseConfig() {
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  config.kit_version = kitVersion();
  return config;
}

// A ready vault: a git repository whose core.hooksPath points at its own
// .githooks holding the template hook, an origin/HEAD that resolves,
// node_modules/ ignored, a valid configuration, and a valid machine.json
// in the state directory derived from the vault's path, with the modes
// init gives them. Every option breaks exactly one of those.
function setup({
  gitRepo = true,
  hooksPath = '.githooks',
  hook = 'template',
  hookMode = 0o755,
  originHead = 'main',
  gitignore = 'node_modules/\n',
  config = baseConfig(),
  configText = null,
  machine = {},
  writeMachine = true,
  machineText = null,
  dirMode = 0o700,
  fileMode = 0o600,
  tools = {},
} = {}) {
  const base = makeTempDir('brain-kit-doctor-');
  const home = join(base, 'home');
  mkdirSync(join(home, '.config'), { recursive: true });
  writeFileSync(join(home, '.gitconfig'), '');
  const root = join(base, PARENT_NAME, VAULT_NAME);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'brain-kit.config.json'), configText ?? JSON.stringify(config, null, 2));
  writeFileSync(join(root, 'index.md'), '# Index\n');
  if (gitignore !== null) writeFileSync(join(root, '.gitignore'), gitignore);
  if (hook !== 'absent') {
    mkdirSync(join(root, '.githooks'));
    const hookFile = join(root, '.githooks', 'pre-push');
    if (hook === 'template') copyFileSync(TEMPLATE_HOOK, hookFile);
    else if (hook === 'empty') writeFileSync(hookFile, '');
    chmodSync(hookFile, hookMode);
  }
  if (gitRepo) {
    fixtureGit(root, ['init', '-q', '-b', 'main', '.'], home);
    if (hooksPath !== null) fixtureGit(root, ['config', 'core.hooksPath', hooksPath], home);
    fixtureGit(root, ['commit', '-q', '--allow-empty', '-m', 'init'], home);
    if (originHead !== null) {
      fixtureGit(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], home);
      fixtureGit(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${originHead}`], home);
    }
  }
  const toolsDir = makeTools(tools);
  const env = {
    PATH: toolsDir,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(base, 'state'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
  };
  const stateDir = stateDirFor(root, env);
  const machineFile = join(stateDir, 'machine.json');
  if (writeMachine) {
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, dirMode);
    const value = {
      vault_id: 'ana-brain',
      canonical_path: realpathSync(root),
      claude_bin: 'claude',
      state_dir: stateDir,
      paths: { lock: 'lock', watermark: 'watermark.json', last_run: 'last-run.json', log_dir: 'logs' },
      ...machine,
    };
    writeFileSync(machineFile, machineText ?? JSON.stringify(value, null, 2));
    chmodSync(machineFile, fileMode);
  }
  return { base, home, root, env, stateDir, machineFile, toolsDir };
}

function fakeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

const t = createTranslator('en');

async function doctor(fixture, argv = [], { nodeVersion = '24.1.0', env = fixture.env, cwd = fixture.root } = {}) {
  const f = fakeIo();
  const code = await runDoctor(['--json', ...argv, fixture.root], f.io, t, { env, cwd, nodeVersion });
  let report = null;
  if (f.stdout()) report = JSON.parse(f.stdout());
  return { code, report, stdout: f.stdout(), stderr: f.stderr() };
}

function check(report, id) {
  const found = report.checks.find((c) => c.id === id);
  assert.ok(found, `no ${id} in ${report.checks.map((c) => c.id).join(', ')}`);
  return found;
}

function assertCheck(report, id, status, messageKey) {
  const c = check(report, id);
  assert.equal(c.status, status, `${id}: ${JSON.stringify(c)}`);
  if (messageKey) assert.equal(c.messageKey, messageKey, `${id}: ${JSON.stringify(c)}`);
  return c;
}

// --- the whole table, green, in the hard path --------------------------------

test('a ready vault under a path with a space, an accented letter and both quotes passes every check and exits 0', async () => {
  const fx = setup();
  assert.ok(fx.root.includes(A_ACUTE) && fx.root.includes(' ') && fx.root.includes('"') && fx.root.includes("'"));
  const { code, report } = await doctor(fx);
  assert.deepEqual(report.checks.map((c) => c.id), CHECK_IDS);
  for (const c of report.checks) assert.equal(c.status, 'ok', JSON.stringify(c));
  assert.equal(code, EXIT.OK);
  assert.equal(report.vault, fx.root);
  assert.deepEqual(report.counts, { ok: CHECK_IDS.length, warn: 0, fail: 0 });
});

test('the check table is exactly the phase 1 set, each named by what it prevents', () => {
  assert.deepEqual(CHECK_IDS, [
    'node-version', 'git-present', 'default-branch-known', 'hooks-path', 'config-valid', 'machine-valid',
    'state-dir-resolves', 'state-dir-mode', 'kit-version', 'gh-present', 'claude-present', 'gitignore-node-modules',
  ]);
});

// --- node-version ------------------------------------------------------------

test('node-version: fails below 24, passes at 24.0.0 exactly, and fails on a version it cannot read', async () => {
  const fx = setup();
  let r = await doctor(fx, ['--only', 'node-version'], { nodeVersion: '22.11.0' });
  assertCheck(r.report, 'node-version', 'fail', 'doctor.node_version.too_old');
  assert.equal(r.code, EXIT.FAILURE);
  r = await doctor(fx, ['--only', 'node-version'], { nodeVersion: '23.99.99' });
  assertCheck(r.report, 'node-version', 'fail', 'doctor.node_version.too_old');
  r = await doctor(fx, ['--only', 'node-version'], { nodeVersion: '24.0.0' });
  assertCheck(r.report, 'node-version', 'ok', 'doctor.node_version.ok');
  assert.equal(r.code, EXIT.OK);
  r = await doctor(fx, ['--only', 'node-version'], { nodeVersion: '' });
  assertCheck(r.report, 'node-version', 'fail', 'doctor.node_version.unreadable');
  r = await doctor(fx, ['--only', 'node-version'], { nodeVersion: 'banana' });
  assertCheck(r.report, 'node-version', 'fail', 'doctor.node_version.unreadable');
  // A version is read from its start, never picked out of the middle of
  // something else.
  r = await doctor(fx, ['--only', 'node-version'], { nodeVersion: 'x24.0.0' });
  assertCheck(r.report, 'node-version', 'fail', 'doctor.node_version.unreadable');
});

test('node-version reads the running Node when nothing is injected', async () => {
  const fx = setup();
  const f = fakeIo();
  const code = await runDoctor(['--json', '--only', 'node-version', fx.root], f.io, t, { env: fx.env, cwd: fx.root });
  const report = JSON.parse(f.stdout());
  assert.equal(check(report, 'node-version').params.version, process.versions.node);
  assert.equal(code, EXIT.OK);
});

// --- git-present -------------------------------------------------------------

test('git-present: fails when git is absent from PATH', async () => {
  const fx = setup({ tools: { git: 'absent' } });
  const { report, code } = await doctor(fx, ['--only', 'git-present']);
  assertCheck(report, 'git-present', 'fail', 'doctor.git_present.missing');
  assert.equal(code, EXIT.FAILURE);
});

test('git-present: a git that exits 0 printing nothing is not proof, it fails', async () => {
  const fx = setup({ tools: { git: 'silent' } });
  const { report } = await doctor(fx, ['--only', 'git-present']);
  assertCheck(report, 'git-present', 'fail', 'doctor.git_present.unrecognised');
});

test('git-present: the real git passes and names its version', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'git-present']);
  const c = assertCheck(report, 'git-present', 'ok', 'doctor.git_present.ok');
  assert.match(c.params.version, /^\d+\.\d+/);
});

// --- default-branch-known ----------------------------------------------------

test('default-branch-known: warns naming the set-head command when origin/HEAD is unset', async () => {
  const fx = setup({ originHead: null });
  const { report, code } = await doctor(fx, ['--only', 'default-branch-known']);
  const c = assertCheck(report, 'default-branch-known', 'warn', 'doctor.default_branch_known.unset');
  assert.equal(c.params.command, 'git remote set-head origin --auto');
  assert.match(c.message, /git remote set-head origin --auto/);
  assert.equal(code, EXIT.OK, 'a warning alone never fails the run');
});

test('default-branch-known: an origin/HEAD pointing at a branch that does not exist is not known, it warns', async () => {
  const fx = setup({ originHead: 'gone' });
  const { report } = await doctor(fx, ['--only', 'default-branch-known']);
  assertCheck(report, 'default-branch-known', 'warn', 'doctor.default_branch_known.dangling');
});

test('default-branch-known: passes and names the branch when origin/HEAD resolves', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'default-branch-known']);
  const c = assertCheck(report, 'default-branch-known', 'ok', 'doctor.default_branch_known.ok');
  assert.equal(c.params.branch, 'main');
});

// --- hooks-path --------------------------------------------------------------

test('hooks-path: fails when core.hooksPath is unset, a clone with no gate', async () => {
  const fx = setup({ hooksPath: null });
  const { report, code } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.unset');
  assert.equal(code, EXIT.FAILURE);
});

test('hooks-path: fails when core.hooksPath points somewhere other than the vault\'s hook directory', async () => {
  const fx = setup({ hooksPath: '.git/hooks' });
  // A pre-push sitting in the place it points at does not make it the vault's gate.
  copyFileSync(TEMPLATE_HOOK, join(fx.root, '.git', 'hooks', 'pre-push'));
  chmodSync(join(fx.root, '.git', 'hooks', 'pre-push'), 0o755);
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.elsewhere');
});

test('hooks-path: a core.hooksPath set only in the global configuration, pointing elsewhere, fails', async () => {
  const fx = setup({ hooksPath: null });
  const other = join(fx.base, 'other-hooks');
  mkdirSync(other);
  writeFileSync(fx.env.GIT_CONFIG_GLOBAL, `[core]\n\thooksPath = ${other}\n`);
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.elsewhere');
});

test('hooks-path: an empty core.hooksPath value fails', async () => {
  const fx = setup({ hooksPath: '' });
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.unset');
});

test('hooks-path: an absolute core.hooksPath naming the vault\'s own hook directory passes', async () => {
  const fx = setup({ hooksPath: null });
  fixtureGit(fx.root, ['config', 'core.hooksPath', join(fx.root, '.githooks')], fx.home);
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'ok', 'doctor.hooks_path.ok');
});

test('hooks-path: fails when the hook itself is absent', async () => {
  const fx = setup({ hook: 'absent' });
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.hook_missing');
});

test('hooks-path: fails when the hook is not executable, because git skips it', async () => {
  const fx = setup({ hookMode: 0o644 });
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.hook_not_executable');
});

test('hooks-path: fails when the hook is an empty file, which refuses nothing', async () => {
  const fx = setup({ hook: 'empty' });
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.hook_empty');
});

test('hooks-path: fails when the hook path is a directory, not a file', async () => {
  const fx = setup({ hook: 'absent' });
  mkdirSync(join(fx.root, '.githooks', 'pre-push'), { recursive: true });
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.hook_missing');
});

test('hooks-path: fails when the vault is not a git repository', async () => {
  const fx = setup({ gitRepo: false });
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.not_a_repo');
});

test('hooks-path: passes with the relative .githooks init writes and the template hook in place', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'ok', 'doctor.hooks_path.ok');
});

// --- config-valid ------------------------------------------------------------

test('config-valid: fails on a configuration the schema rejects', async () => {
  const config = baseConfig();
  config.lang = 'xx';
  const fx = setup({ config });
  const { report, code } = await doctor(fx, ['--only', 'config-valid']);
  assertCheck(report, 'config-valid', 'fail', 'doctor.config_valid.invalid');
  assert.equal(code, EXIT.FAILURE);
});

test('config-valid: fails on a machine-only key, naming where it sits', async () => {
  const config = baseConfig();
  config.curate.notify_command = ['notify-send', 'x'];
  const fx = setup({ config });
  const { report } = await doctor(fx, ['--only', 'config-valid']);
  const c = assertCheck(report, 'config-valid', 'fail', 'doctor.config_valid.machine_key');
  assert.deepEqual(c.params.keys, ['$.curate.notify_command']);
});

test('config-valid: fails on a configuration that is not JSON', async () => {
  const fx = setup({ configText: '{ "kit_version": ' });
  const { report } = await doctor(fx, ['--only', 'config-valid']);
  assertCheck(report, 'config-valid', 'fail', 'doctor.config_valid.unreadable');
});

test('config-valid: passes on a valid configuration', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'config-valid']);
  assertCheck(report, 'config-valid', 'ok', 'doctor.config_valid.ok');
});

// --- machine-valid -----------------------------------------------------------

test('machine-valid: fails when machine.json is missing', async () => {
  const fx = setup({ writeMachine: false });
  const { report, code } = await doctor(fx, ['--only', 'machine-valid']);
  const c = assertCheck(report, 'machine-valid', 'fail', 'doctor.machine_valid.missing');
  assert.equal(c.params.file, fx.machineFile);
  assert.equal(code, EXIT.FAILURE);
});

test('machine-valid: fails when machine.json is invalid against its schema', async () => {
  const fx = setup({ machine: { vault_id: 'Not Valid' } });
  const { report } = await doctor(fx, ['--only', 'machine-valid']);
  assertCheck(report, 'machine-valid', 'fail', 'doctor.machine_valid.invalid');
});

test('machine-valid: fails when machine.json is not JSON', async () => {
  const fx = setup({ machineText: 'not json' });
  const { report } = await doctor(fx, ['--only', 'machine-valid']);
  assertCheck(report, 'machine-valid', 'fail', 'doctor.machine_valid.unreadable');
});

test('machine-valid: warns when canonical_path differs from the vault\'s real path', async () => {
  const fx = setup({ machine: { canonical_path: '/home/ana/somewhere-else' } });
  const { report, code } = await doctor(fx, ['--only', 'machine-valid']);
  const c = assertCheck(report, 'machine-valid', 'warn', 'doctor.machine_valid.canonical_differs');
  assert.equal(c.params.actual, realpathSync(fx.root));
  assert.equal(code, EXIT.OK);
});

test('machine-valid: a relative canonical_path is not the real path, it warns', async () => {
  const fx = setup({ machine: { canonical_path: VAULT_NAME } });
  const { report } = await doctor(fx, ['--only', 'machine-valid']);
  assertCheck(report, 'machine-valid', 'warn', 'doctor.machine_valid.canonical_differs');
});

test('machine-valid: passes on a valid machine.json recording the real path', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'machine-valid']);
  assertCheck(report, 'machine-valid', 'ok', 'doctor.machine_valid.ok');
});

// --- state-dir-resolves ------------------------------------------------------

// The vault reached through a symbolic link: the state directory derived
// from the linked path is not the one derived from the real path.
function setupThroughLink({ machineUnder }) {
  const fx = setup({ writeMachine: false });
  const link = join(fx.base, 'link to brain');
  symlinkSync(fx.root, link);
  const real = realpathSync(fx.root);
  const linkState = stateDirFor(link, fx.env);
  const realState = stateDirFor(real, fx.env);
  assert.notEqual(linkState, realState, 'the two derivations must differ for this test to mean anything');
  const target = machineUnder === 'real' ? realState : linkState;
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o700);
  const file = join(target, 'machine.json');
  writeFileSync(file, JSON.stringify({
    vault_id: 'ana-brain', canonical_path: real, claude_bin: 'claude',
    paths: { lock: 'lock', watermark: 'watermark.json', last_run: 'last-run.json', log_dir: 'logs' },
  }));
  chmodSync(file, 0o600);
  return { ...fx, root: link, real, linkState, realState };
}

test('state-dir-resolves: fails through a symlink when only the canonical path finds machine.json, naming the path to use', async () => {
  const fx = setupThroughLink({ machineUnder: 'real' });
  const { report, code } = await doctor(fx, ['--only', 'state-dir-resolves']);
  const c = assertCheck(report, 'state-dir-resolves', 'fail', 'doctor.state_dir_resolves.use_canonical');
  assert.equal(c.params.path, fx.real);
  assert.match(c.message, new RegExp(fx.real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(code, EXIT.FAILURE);
});

test('state-dir-resolves: passes through a symlink when the linked path\'s own state directory holds machine.json', async () => {
  const fx = setupThroughLink({ machineUnder: 'link' });
  const { report } = await doctor(fx, ['--only', 'state-dir-resolves,machine-valid']);
  assertCheck(report, 'state-dir-resolves', 'ok', 'doctor.state_dir_resolves.ok');
  assertCheck(report, 'machine-valid', 'ok');
});

test('hooks-path: a vault reached through a symlink still finds its gate, since git reports the real top level', async () => {
  const fx = setupThroughLink({ machineUnder: 'link' });
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'ok', 'doctor.hooks_path.ok');
});

test('state-dir-resolves: fails when neither derivation finds machine.json', async () => {
  const fx = setup({ writeMachine: false });
  const { report } = await doctor(fx, ['--only', 'state-dir-resolves']);
  assertCheck(report, 'state-dir-resolves', 'fail', 'doctor.state_dir_resolves.none');
});

test('state-dir-resolves: a directory named machine.json is not the machine file', async () => {
  const fx = setup({ writeMachine: false });
  mkdirSync(fx.machineFile, { recursive: true });
  const { report } = await doctor(fx, ['--only', 'state-dir-resolves']);
  assertCheck(report, 'state-dir-resolves', 'fail', 'doctor.state_dir_resolves.none');
});

test('state-dir-resolves and machine-valid honour BRAIN_KIT_STATE_DIR', async () => {
  const fx = setup({ writeMachine: false });
  const pinned = join(fx.base, 'pinned-state');
  mkdirSync(pinned, { mode: 0o700 });
  chmodSync(pinned, 0o700);
  writeFileSync(join(pinned, 'machine.json'), JSON.stringify({
    vault_id: 'ana-brain', canonical_path: realpathSync(fx.root), claude_bin: 'claude',
    paths: { lock: 'lock', watermark: 'watermark.json', last_run: 'last-run.json', log_dir: 'logs' },
  }));
  chmodSync(join(pinned, 'machine.json'), 0o600);
  const env = { ...fx.env, BRAIN_KIT_STATE_DIR: pinned };
  const { report } = await doctor(fx, ['--only', 'state-dir-resolves,machine-valid,state-dir-mode'], { env });
  for (const c of report.checks) assert.equal(c.status, 'ok', JSON.stringify(c));
  assert.equal(check(report, 'machine-valid').params.file, join(pinned, 'machine.json'));
});

// --- state-dir-mode ----------------------------------------------------------

test('state-dir-mode: fails when the state directory is not 0700', async () => {
  const fx = setup({ dirMode: 0o755 });
  const { report, code } = await doctor(fx, ['--only', 'state-dir-mode']);
  const c = assertCheck(report, 'state-dir-mode', 'fail', 'doctor.state_dir_mode.dir_mode');
  assert.equal(c.params.mode, '0755');
  assert.equal(code, EXIT.FAILURE);
});

test('state-dir-mode: fails when the state directory is tighter than 0700 too, since it is not 0700', async () => {
  const fx = setup({ dirMode: 0o750 });
  const { report } = await doctor(fx, ['--only', 'state-dir-mode']);
  assertCheck(report, 'state-dir-mode', 'fail', 'doctor.state_dir_mode.dir_mode');
});

test('state-dir-mode: fails when machine.json is not 0600', async () => {
  const fx = setup({ fileMode: 0o644 });
  const { report } = await doctor(fx, ['--only', 'state-dir-mode']);
  const c = assertCheck(report, 'state-dir-mode', 'fail', 'doctor.state_dir_mode.file_mode');
  assert.equal(c.params.mode, '0644');
});

test('state-dir-mode: fails when the state directory does not exist', async () => {
  const fx = setup({ writeMachine: false });
  assert.equal(existsSync(fx.stateDir), false);
  const { report } = await doctor(fx, ['--only', 'state-dir-mode']);
  assertCheck(report, 'state-dir-mode', 'fail', 'doctor.state_dir_mode.dir_missing');
});

test('state-dir-mode: fails when the state directory exists but machine.json does not', async () => {
  const fx = setup({ writeMachine: false });
  mkdirSync(fx.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(fx.stateDir, 0o700);
  const { report } = await doctor(fx, ['--only', 'state-dir-mode']);
  assertCheck(report, 'state-dir-mode', 'fail', 'doctor.state_dir_mode.file_missing');
});

test('state-dir-mode: fails when machine.json is a directory, not a file', async () => {
  const fx = setup({ writeMachine: false });
  mkdirSync(fx.machineFile, { recursive: true });
  chmodSync(fx.stateDir, 0o700);
  chmodSync(fx.machineFile, 0o600);
  const { report } = await doctor(fx, ['--only', 'state-dir-mode']);
  assertCheck(report, 'state-dir-mode', 'fail', 'doctor.state_dir_mode.file_missing');
});

test('state-dir-mode: fails when the state directory path is a file', async () => {
  const fx = setup({ writeMachine: false });
  mkdirSync(join(fx.stateDir, '..'), { recursive: true });
  writeFileSync(fx.stateDir, '');
  const { report } = await doctor(fx, ['--only', 'state-dir-mode']);
  assertCheck(report, 'state-dir-mode', 'fail', 'doctor.state_dir_mode.dir_missing');
});

test('state-dir-mode: passes at 0700 and 0600', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'state-dir-mode']);
  assertCheck(report, 'state-dir-mode', 'ok', 'doctor.state_dir_mode.ok');
});

// --- kit-version -------------------------------------------------------------

test('kit-version: warns when the configuration\'s kit_version differs from the running engine', async () => {
  const config = baseConfig();
  config.kit_version = '0.0.0-older';
  const fx = setup({ config });
  const { report, code } = await doctor(fx, ['--only', 'kit-version']);
  const c = assertCheck(report, 'kit-version', 'warn', 'doctor.kit_version.differs');
  assert.equal(c.params.configured, '0.0.0-older');
  assert.equal(c.params.running, kitVersion());
  assert.equal(code, EXIT.OK);
});

test('kit-version: a configuration it cannot read is not a match, it warns', async () => {
  const fx = setup({ configText: 'nope' });
  const { report } = await doctor(fx, ['--only', 'kit-version']);
  assertCheck(report, 'kit-version', 'warn', 'doctor.kit_version.unknown');
});

test('kit-version: passes when the versions match', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'kit-version']);
  assertCheck(report, 'kit-version', 'ok', 'doctor.kit_version.ok');
});

// --- gh-present --------------------------------------------------------------

test('gh-present: warns when gh is absent, because propose will need it', async () => {
  const fx = setup({ tools: { gh: 'absent' } });
  const { report, code } = await doctor(fx, ['--only', 'gh-present']);
  assertCheck(report, 'gh-present', 'warn', 'doctor.gh_present.missing');
  assert.equal(code, EXIT.OK);
});

test('gh-present: a gh that exits 0 printing nothing is not proof, it warns', async () => {
  const fx = setup({ tools: { gh: 'silent' } });
  const { report } = await doctor(fx, ['--only', 'gh-present']);
  assertCheck(report, 'gh-present', 'warn', 'doctor.gh_present.unrecognised');
});

test('gh-present: a gh that exits non-zero warns', async () => {
  const fx = setup({ tools: { gh: 'broken' } });
  const { report } = await doctor(fx, ['--only', 'gh-present']);
  assertCheck(report, 'gh-present', 'warn', 'doctor.gh_present.missing');
});

test('gh-present: passes and names the version', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'gh-present']);
  const c = assertCheck(report, 'gh-present', 'ok', 'doctor.gh_present.ok');
  assert.equal(c.params.version, '2.40.1');
});

// --- claude-present ----------------------------------------------------------

test('claude-present: warns when the configured claude_bin is on no path', async () => {
  const fx = setup({ tools: { claude: 'absent' } });
  const { report, code } = await doctor(fx, ['--only', 'claude-present']);
  assertCheck(report, 'claude-present', 'warn', 'doctor.claude_present.not_found');
  assert.equal(code, EXIT.OK);
});

test('claude-present: a claude that exits 0 printing nothing is not proof, it warns', async () => {
  const fx = setup({ tools: { claude: 'silent' } });
  const { report } = await doctor(fx, ['--only', 'claude-present']);
  assertCheck(report, 'claude-present', 'warn', 'doctor.claude_present.unrecognised');
});

test('claude-present: a claude that resolves but will not run (a stub) warns', async () => {
  const fx = setup({ tools: { claude: 'broken' } });
  const { report } = await doctor(fx, ['--only', 'claude-present']);
  assertCheck(report, 'claude-present', 'warn', 'doctor.claude_present.failed');
});

test('claude-present: a file named like claude on PATH that is not executable does not resolve', async () => {
  const fx = setup({ tools: { claude: 'absent' } });
  writeFileSync(join(fx.toolsDir, 'claude'), '#!/bin/sh\necho "1.2.3 (Claude Code)"\n');
  chmodSync(join(fx.toolsDir, 'claude'), 0o644);
  const { report } = await doctor(fx, ['--only', 'claude-present']);
  assertCheck(report, 'claude-present', 'warn', 'doctor.claude_present.not_found');
});

test('claude-present: an absolute claude_bin that exists passes, and one that does not warns', async () => {
  const fx = setup({ tools: { claude: 'absent' } });
  const elsewhere = join(fx.base, 'opt bin');
  mkdirSync(elsewhere);
  const good = writeScript(join(elsewhere, 'claude'), SCRIPTS.claude.ok);
  writeFileSync(fx.machineFile, JSON.stringify({ ...JSON.parse(readFileSync(fx.machineFile, 'utf8')), claude_bin: good }));
  let r = await doctor(fx, ['--only', 'claude-present']);
  const c = assertCheck(r.report, 'claude-present', 'ok', 'doctor.claude_present.ok');
  assert.equal(c.params.bin, good);
  writeFileSync(fx.machineFile, JSON.stringify({ ...JSON.parse(readFileSync(fx.machineFile, 'utf8')), claude_bin: join(elsewhere, 'nope') }));
  r = await doctor(fx, ['--only', 'claude-present']);
  assertCheck(r.report, 'claude-present', 'warn', 'doctor.claude_present.not_found');
});

test('claude-present: resolves through the machine\'s path_extra, with ~ read from HOME', async () => {
  const fx = setup({ tools: { claude: 'absent' } });
  const extra = join(fx.home, '.npm-global', 'bin');
  mkdirSync(extra, { recursive: true });
  writeScript(join(extra, 'claude'), SCRIPTS.claude.ok);
  writeFileSync(fx.machineFile, JSON.stringify({ ...JSON.parse(readFileSync(fx.machineFile, 'utf8')), path_extra: ['~/.npm-global/bin'] }));
  const { report } = await doctor(fx, ['--only', 'claude-present']);
  const c = assertCheck(report, 'claude-present', 'ok', 'doctor.claude_present.ok');
  assert.equal(c.params.bin, join(extra, 'claude'));
});

test('claude-present: with no readable machine.json there is no claude_bin to resolve, it warns', async () => {
  const fx = setup({ writeMachine: false });
  const { report } = await doctor(fx, ['--only', 'claude-present']);
  assertCheck(report, 'claude-present', 'warn', 'doctor.claude_present.unknown');
});

test('claude-present: passes with a claude on PATH that prints a version', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'claude-present']);
  const c = assertCheck(report, 'claude-present', 'ok', 'doctor.claude_present.ok');
  assert.equal(c.params.version, '1.2.3');
});

// --- gitignore-node-modules --------------------------------------------------

test('gitignore-node-modules: warns when node_modules/ is not ignored, naming the false refusal it causes', async () => {
  const fx = setup({ gitignore: '' });
  const { report, code } = await doctor(fx, ['--only', 'gitignore-node-modules']);
  const c = assertCheck(report, 'gitignore-node-modules', 'warn', 'doctor.gitignore_node_modules.not_ignored');
  assert.match(c.message, /secrets/);
  assert.match(c.message, /do not exist/);
  assert.equal(code, EXIT.OK);
});

test('gitignore-node-modules: warns when there is no .gitignore at all', async () => {
  const fx = setup({ gitignore: null });
  const { report } = await doctor(fx, ['--only', 'gitignore-node-modules']);
  assertCheck(report, 'gitignore-node-modules', 'warn', 'doctor.gitignore_node_modules.not_ignored');
});

test('gitignore-node-modules: outside a git repository the question has no answer, it warns', async () => {
  const fx = setup({ gitRepo: false });
  const { report } = await doctor(fx, ['--only', 'gitignore-node-modules']);
  assertCheck(report, 'gitignore-node-modules', 'warn', 'doctor.gitignore_node_modules.unknown');
});

test('gitignore-node-modules: passes with node_modules/ ignored, and with the bare name ignored', async () => {
  let fx = setup();
  let r = await doctor(fx, ['--only', 'gitignore-node-modules']);
  assertCheck(r.report, 'gitignore-node-modules', 'ok', 'doctor.gitignore_node_modules.ok');
  fx = setup({ gitignore: 'node_modules\n' });
  r = await doctor(fx, ['--only', 'gitignore-node-modules']);
  assertCheck(r.report, 'gitignore-node-modules', 'ok', 'doctor.gitignore_node_modules.ok');
});

// --- a git whose status and output disagree ----------------------------------
//
// Each check that runs git reads the status AND the output. The real git
// never lets the two disagree, so a check could quietly lean on one alone
// and every test above would stay green. These scripted gits make them
// disagree, one clause at a time. The vault's real path reaches a script
// through the environment, never through the script's text, because it
// carries both quote characters.

function scriptedGit(cases) {
  const lines = ['case "$1 $2" in'];
  for (const [match, body] of Object.entries(cases)) lines.push(`  "${match}") ${body};;`);
  lines.push('esac', 'exit 0');
  return { script: lines.join('\n') };
}

test('default-branch-known: a rev-parse that exits 0 printing no commit is not proof the branch exists', async () => {
  const fx = setup({
    tools: { git: scriptedGit({ 'symbolic-ref -q': 'echo refs/remotes/origin/main; exit 0', 'rev-parse --verify': 'exit 0' }) },
  });
  const { report } = await doctor(fx, ['--only', 'default-branch-known']);
  assertCheck(report, 'default-branch-known', 'warn', 'doctor.default_branch_known.dangling');
});

test('default-branch-known: a rev-parse that prints a commit but exits non-zero is not proof either', async () => {
  const fx = setup({
    tools: { git: scriptedGit({ 'symbolic-ref -q': 'echo refs/remotes/origin/main; exit 0', 'rev-parse --verify': `echo ${'a'.repeat(40)}; exit 1` }) },
  });
  const { report } = await doctor(fx, ['--only', 'default-branch-known']);
  assertCheck(report, 'default-branch-known', 'warn', 'doctor.default_branch_known.dangling');
});

test('hooks-path: a top level printed by a git that exits non-zero is not a repository', async () => {
  const fx = setup({ tools: { git: scriptedGit({ 'rev-parse --show-toplevel': 'printf "%s\\n" "$FAKE_TOP"; exit 128', 'config --type=path': 'echo .githooks; exit 0' }) } });
  const env = { ...fx.env, FAKE_TOP: realpathSync(fx.root) };
  const { report } = await doctor(fx, ['--only', 'hooks-path'], { env });
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.not_a_repo');
});

test('hooks-path: a top level that is not an absolute path is not a repository', async () => {
  const fx = setup({ tools: { git: scriptedGit({ 'rev-parse --show-toplevel': 'echo somewhere; exit 0', 'config --type=path': 'echo .githooks; exit 0' }) } });
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.not_a_repo');
});

test('hooks-path: a core.hooksPath git cannot read (status other than 0 or 1) is not a pass', async () => {
  const fx = setup({ tools: { git: scriptedGit({ 'rev-parse --show-toplevel': 'printf "%s\\n" "$FAKE_TOP"; exit 0', 'config --type=path': 'echo .githooks; exit 2' }) } });
  const env = { ...fx.env, FAKE_TOP: realpathSync(fx.root) };
  const { report } = await doctor(fx, ['--only', 'hooks-path'], { env });
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.unreadable');
});

test('hooks-path: the scripted git answering like the real one passes, so the tests above isolate one clause each', async () => {
  const fx = setup({ tools: { git: scriptedGit({ 'rev-parse --show-toplevel': 'printf "%s\\n" "$FAKE_TOP"; exit 0', 'config --type=path': 'echo .githooks; exit 0' }) } });
  const env = { ...fx.env, FAKE_TOP: realpathSync(fx.root) };
  const { report } = await doctor(fx, ['--only', 'hooks-path'], { env });
  assertCheck(report, 'hooks-path', 'ok', 'doctor.hooks_path.ok');
});

test('gitignore-node-modules: git printing the path back while exiting 1 is not ignored', async () => {
  const fx = setup({ tools: { git: scriptedGit({ 'check-ignore --no-index': 'echo node_modules/; exit 1' }) } });
  const { report } = await doctor(fx, ['--only', 'gitignore-node-modules']);
  assertCheck(report, 'gitignore-node-modules', 'warn', 'doctor.gitignore_node_modules.not_ignored');
});

test('gitignore-node-modules: git printing the path back with exit 0 passes, so the test above isolates the status', async () => {
  const fx = setup({ tools: { git: scriptedGit({ 'check-ignore --no-index': 'echo node_modules/; exit 0' }) } });
  const { report } = await doctor(fx, ['--only', 'gitignore-node-modules']);
  assertCheck(report, 'gitignore-node-modules', 'ok');
});

// --- paths resolved against the working directory ---------------------------
//
// A relative path is resolved against wherever the process happens to be,
// which is how a wrong answer can look right on the one machine that
// tested it. Each test below stands in the one directory where the
// relative reading WOULD match, and requires the check to refuse it anyway.

async function inDirectory(dir, fn) {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

test('machine-valid: a relative canonical_path is refused even from the directory where it would resolve to the real path', async () => {
  const fx = setup({ machine: { canonical_path: VAULT_NAME } });
  const parent = join(realpathSync(fx.root), '..');
  const { report } = await inDirectory(parent, () => doctor(fx, ['--only', 'machine-valid']));
  assertCheck(report, 'machine-valid', 'warn', 'doctor.machine_valid.canonical_differs');
});

test('claude-present: a relative PATH entry does not resolve claude, even from the directory holding one', async () => {
  const fx = setup({ tools: { claude: 'absent' } });
  const here = join(fx.base, 'here');
  mkdirSync(here);
  writeScript(join(here, 'claude'), SCRIPTS.claude.ok);
  const env = { ...fx.env, PATH: `.${delimiter}${delimiter}${fx.toolsDir}` };
  const { report } = await inDirectory(here, () => doctor(fx, ['--only', 'claude-present'], { env }));
  assertCheck(report, 'claude-present', 'warn', 'doctor.claude_present.not_found');
});

// --- the recurring shape -----------------------------------------------------

test('a git that exits 0 printing nothing makes no git-based check ok', async () => {
  const fx = setup({ tools: { git: 'silent' } });
  const { report, code } = await doctor(fx);
  assertCheck(report, 'git-present', 'fail');
  assertCheck(report, 'default-branch-known', 'warn');
  assertCheck(report, 'hooks-path', 'fail');
  assertCheck(report, 'gitignore-node-modules', 'warn');
  assert.equal(code, EXIT.FAILURE);
});

test('a gh and a claude that exit 0 printing nothing are never ok', async () => {
  const fx = setup({ tools: { gh: 'silent', claude: 'silent' } });
  const { report } = await doctor(fx, ['--only', 'gh-present,claude-present']);
  for (const c of report.checks) assert.notEqual(c.status, 'ok', JSON.stringify(c));
});

// --- exit code, --only, --json, usage ---------------------------------------

test('the exit code is 1 when any check fails, and 0 when every check is ok or warn', async () => {
  const warnOnly = setup({ tools: { gh: 'absent' }, originHead: null });
  let r = await doctor(warnOnly);
  assert.ok(r.report.checks.some((c) => c.status === 'warn'));
  assert.ok(r.report.checks.every((c) => c.status !== 'fail'), JSON.stringify(r.report.checks));
  assert.equal(r.code, EXIT.OK);
  const oneFail = setup({ dirMode: 0o755 });
  r = await doctor(oneFail);
  assert.deepEqual(r.report.checks.filter((c) => c.status === 'fail').map((c) => c.id), ['state-dir-mode']);
  assert.equal(r.code, EXIT.FAILURE);
});

test('exitCodeFor: a status it does not know is a failure, and so is an empty list of results', () => {
  assert.equal(exitCodeFor([{ status: 'ok' }, { status: 'warn' }]), EXIT.OK);
  assert.equal(exitCodeFor([{ status: 'ok' }, { status: 'fail' }]), EXIT.FAILURE);
  assert.equal(exitCodeFor([{ status: 'ok' }, { status: 'skipped' }]), EXIT.FAILURE);
  assert.equal(exitCodeFor([{ status: 'ok' }, {}]), EXIT.FAILURE);
  assert.equal(exitCodeFor([]), EXIT.FAILURE);
});

test('a check that throws is reported as a failure of that check, and the others still run', () => {
  const checks = new Map([
    ['first', () => { throw new Error('boom'); }],
    ['second', () => ({ id: 'second', status: 'ok', messageKey: 'doctor.node_version.ok', params: { version: '24.0.0' } })],
  ]);
  const results = runChecks({}, ['first', 'second'], checks);
  assert.equal(results[0].id, 'first');
  assert.equal(results[0].status, 'fail');
  assert.equal(results[0].messageKey, 'doctor.check_crashed');
  assert.match(results[0].params.error, /boom/);
  assert.equal(results[1].status, 'ok');
  assert.equal(exitCodeFor(results), EXIT.FAILURE);
});

test('--only runs exactly the named checks, in table order, accepting a list and a repeated flag', async () => {
  const fx = setup();
  let r = await doctor(fx, ['--only', 'gh-present,node-version']);
  assert.deepEqual(r.report.checks.map((c) => c.id), ['node-version', 'gh-present']);
  r = await doctor(fx, ['--only', 'kit-version', '--only=config-valid']);
  assert.deepEqual(r.report.checks.map((c) => c.id), ['config-valid', 'kit-version']);
});

test('--only with an id no check has is a usage error, never a run of nothing that exits 0', async () => {
  const fx = setup();
  const r = await doctor(fx, ['--only', 'node-version,hooks-pth']);
  assert.equal(r.code, EXIT.USAGE);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /hooks-pth/);
});

test('--only with no value, or an empty one, is a usage error', async () => {
  const fx = setup();
  let f = fakeIo();
  assert.equal(await runDoctor([fx.root, '--only'], f.io, t, { env: fx.env, cwd: fx.root }), EXIT.USAGE);
  assert.match(f.stderr(), /--only needs a comma-separated list/);
  f = fakeIo();
  assert.equal(await runDoctor([fx.root, '--only', ''], f.io, t, { env: fx.env, cwd: fx.root }), EXIT.USAGE);
  f = fakeIo();
  assert.equal(await runDoctor([fx.root, '--only=,'], f.io, t, { env: fx.env, cwd: fx.root }), EXIT.USAGE);
  assert.equal(f.stdout(), '');
});

test('an unknown flag, a missing path, a file, and a directory with no vault are usage errors', async () => {
  const fx = setup();
  let f = fakeIo();
  assert.equal(await runDoctor(['--frobnicate'], f.io, t, { env: fx.env, cwd: fx.root }), EXIT.USAGE);
  f = fakeIo();
  assert.equal(await runDoctor([join(fx.base, 'nowhere')], f.io, t, { env: fx.env, cwd: fx.root }), EXIT.USAGE);
  f = fakeIo();
  assert.equal(await runDoctor([join(fx.root, 'index.md')], f.io, t, { env: fx.env, cwd: fx.root }), EXIT.USAGE);
  f = fakeIo();
  const empty = makeTempDir('brain-kit-doctor-empty-');
  assert.equal(await runDoctor([empty], f.io, t, { env: fx.env, cwd: fx.root }), EXIT.USAGE);
  assert.match(f.stderr(), /brain-kit\.config\.json/);
});

test('with no directory argument the vault is found from the working directory', async () => {
  const fx = setup();
  mkdirSync(join(fx.root, 'notes'));
  const f = fakeIo();
  const code = await runDoctor(['--json', '--only', 'config-valid'], f.io, t, { env: fx.env, cwd: join(fx.root, 'notes') });
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(f.stdout()).vault, fx.root);
});

test('--json prints one parseable object on one line, carrying each check\'s messageKey, params and rendered message', async () => {
  const fx = setup({ tools: { gh: 'absent' } });
  const f = fakeIo();
  const code = await runDoctor([fx.root, '--json'], f.io, t, { env: fx.env, cwd: fx.root, nodeVersion: '24.1.0' });
  const out = f.stdout();
  assert.equal(out.endsWith('\n'), true);
  assert.equal(out.trimEnd().includes('\n'), false, 'exactly one line');
  const report = JSON.parse(out);
  assert.equal(report.version, 'brain-kit.doctor/1');
  assert.equal(report.checks.length, CHECK_IDS.length);
  for (const c of report.checks) {
    assert.deepEqual(Object.keys(c).sort(), ['id', 'message', 'messageKey', 'params', 'status']);
    assert.equal(c.message, t(c.messageKey, c.params));
  }
  assert.deepEqual(report.counts, { ok: CHECK_IDS.length - 1, warn: 1, fail: 0 });
  assert.equal(report.exitCode, code);
});

test('the human report names every check, its status and message, and a summary line', async () => {
  const fx = setup({ tools: { gh: 'absent' } });
  const f = fakeIo();
  const code = await runDoctor([fx.root], f.io, t, { env: fx.env, cwd: fx.root, nodeVersion: '24.1.0' });
  assert.equal(code, EXIT.OK);
  const out = f.stdout();
  assert.ok(out.includes(fx.root));
  for (const id of CHECK_IDS) assert.match(out, new RegExp(`\\b${id}\\b`));
  assert.match(out, /warn\s+gh-present/);
  assert.match(out, /11 ok, 1 warn, 0 fail/);
});

test('the Portuguese pack renders the report', async () => {
  const fx = setup();
  const f = fakeIo();
  await runDoctor([fx.root, '--only', 'gitignore-node-modules'], f.io, createTranslator('pt-BR'), { env: fx.env, cwd: fx.root });
  assert.match(f.stdout(), /node_modules\//);
  assert.doesNotMatch(f.stdout(), /\{[a-z_]+\}/);
});

test('the real binary runs doctor --json against a vault in the hard path and exits with the report\'s code', () => {
  const fx = setup({ tools: { gh: 'absent' } });
  const r = spawnSync(process.execPath, [BIN, 'doctor', fx.root, '--json'], { cwd: fx.base, encoding: 'utf8', env: fx.env });
  const report = JSON.parse(r.stdout);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(report.vault, fx.root);
  assert.equal(report.exitCode, 0);
  assertCheck(report, 'gh-present', 'warn');
  assertCheck(report, 'hooks-path', 'ok');
  const broken = setup({ hook: 'absent' });
  const r2 = spawnSync(process.execPath, [BIN, 'doctor', broken.root], { cwd: broken.base, encoding: 'utf8', env: broken.env });
  assert.equal(r2.status, EXIT.FAILURE, r2.stdout + r2.stderr);
});

test('doctor is listed in the CLI usage', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', env: { ...process.env, BRAIN_KIT_LANG: 'en' } });
  assert.match(r.stdout, /doctor \[dir\] \[--json\] \[--only <id,\.\.\.>\]/);
});
