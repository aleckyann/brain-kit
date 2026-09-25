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
  chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeTempDir } from './helpers/tmp.mjs';
import { KIT_ROOT, kitVersion } from '../src/version.mjs';
import { createTranslator } from '../src/lang.mjs';
import { stateDirFor } from '../src/state.mjs';
import { renderMessage, runDoctor } from '../src/commands/doctor.mjs';
import { CHECK_IDS, exitCodeFor, roundFlags, runChecks } from '../src/doctor/checks.mjs';
import { runScheduleSync } from '../src/commands/schedule.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { LOCAL_GIT_VARS, localGitVarNames } from '../src/git-env.mjs';
import { TEMPLATE_HOOK as SHIPPED_HOOK } from '../src/init/skeleton.mjs';
import { ROUND_TOOLS } from '../src/harness/claude-code.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const PACK_KEYWORDS = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', 'en', 'config.defaults.json'), 'utf8')).privacy.third_party_keywords;
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

// A claude stand-in that is a real CLI to every check: `--version` answers
// in the Claude CLI's own shape, `--help` lists the flags `help` names (by
// default every flag a round passes, from buildArgv itself), and the file
// is padded past the 2 KB stub fingerprint.
function claudeScript({ help = roundFlags(), pad = 2400, helpExit = 0, version = 'echo "1.2.3 (Claude Code)"', before = '' } = {}) {
  const lines = help.map((flag) => `'  ${flag} <value>'`).join(' ');
  const body = `${before}case "$1" in\n  --help) printf '%s\\n' 'Usage: claude [options]' ${lines}; exit ${helpExit} ;;\n  *) ${version} ;;\nesac`;
  return `${body}\n# ${'x'.repeat(pad)}`;
}
const CLAUDE_OK = claudeScript();

// The stand-ins. `silent` is the recurring shape: status 0, no output.
const SCRIPTS = {
  gh: {
    ok: 'echo "gh version 2.40.1 (2026-01-01)"\necho "https://example.invalid/releases/v2.40.1"',
    silent: 'exit 0',
    broken: 'echo "gh: something went wrong" >&2\nexit 3',
  },
  claude: {
    // Above the 2 KB stub threshold (src/guards/cli.mjs), and answering
    // --help with every flag a round passes, so the curator's checks pass.
    ok: CLAUDE_OK,
    silent: 'exit 0',
    broken: 'echo "stub: postinstall never ran" >&2\nexit 1',
  },
  git: {
    silent: 'exit 0',
  },
  node: {
    newer: 'echo v25.0.0',
    old: 'echo v22.11.0',
    silent: 'exit 0',
    broken: 'echo "node: cannot start" >&2\nexit 1',
  },
  brainKit: {
    other: 'echo 9.9.9',
    junk: 'echo "hello"',
    silent: 'exit 0',
    broken: 'echo "brain-kit: cannot start" >&2\nexit 1',
  },
};

// Builds a tools directory: `git` is a link to the real one unless told
// otherwise, `gh` and `claude` are stand-ins in the state asked for, and
// `absent` leaves a tool out altogether. `git: { script }` puts a scripted
// git on PATH, one that answers each subcommand the way a test needs, to
// reach the clauses the real git never exercises (a status and an output
// that disagree).
// `node` is a link to the Node running the suite and `brain-kit` a link to
// this checkout's own launcher, which finds that node through PATH exactly
// as the installed hook's brain-kit would.
function makeTools({ git = 'real', gh = 'ok', claude = 'ok', node = 'real', brainKit = 'real', systemctl = 'ok' } = {}) {
  const dir = join(makeTempDir('brain-kit-doctor-tools-'), 'bin');
  mkdirSync(dir);
  if (git === 'real') symlinkSync(REAL_GIT, join(dir, 'git'));
  else if (typeof git === 'object') writeScript(join(dir, 'git'), git.script);
  else if (git !== 'absent') writeScript(join(dir, 'git'), SCRIPTS.git[git]);
  if (gh !== 'absent') writeScript(join(dir, 'gh'), SCRIPTS.gh[gh]);
  if (claude !== 'absent') writeScript(join(dir, 'claude'), SCRIPTS.claude[claude]);
  if (node === 'real') symlinkSync(process.execPath, join(dir, 'node'));
  else if (node !== 'absent') writeScript(join(dir, 'node'), SCRIPTS.node[node]);
  if (brainKit === 'real') symlinkSync(BIN, join(dir, 'brain-kit'));
  else if (brainKit !== 'absent') writeScript(join(dir, 'brain-kit'), SCRIPTS.brainKit[brainKit]);
  // A user systemd that answers every question with success, logging what
  // it was asked; and the program machine.json's notify_command names.
  if (systemctl !== 'absent') writeScript(join(dir, 'systemctl'), `echo "$*" >> "${join(dir, 'systemctl.log')}"\n${systemctl === 'inactive' ? 'case "$2" in is-active) echo inactive; exit 3 ;; esac\n' : ''}exit 0`);
  writeScript(join(dir, 'notify'), 'exit 0');
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

// The fixture configuration, made ready for phase 3: the connector sources
// are off on purpose (the fixture's calendar lists a calendar with no
// `enabled`, the upgrade case a round reports as half configured), and the
// privacy keywords are the en pack's.
function baseConfig() {
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  config.kit_version = kitVersion();
  config.sources.calendar.enabled = false;
  config.sources.meeting_notes.enabled = false;
  config.privacy.third_party_keywords = [...PACK_KEYWORDS];
  return config;
}

// A ready vault: a git repository whose core.hooksPath points at its own
// .githooks holding the template hook, an origin/HEAD that resolves,
// node_modules/ ignored, a valid configuration, and a valid machine.json
// in the state directory derived from the vault's path, with the modes
// init gives them. Every option breaks exactly one of those.
function setup({
  gitRepo = true,
  nested = false,
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
  manifest = 'valid',
  curator = true,
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
  // The manifest init or adopt writes: 'valid' records index.md in the
  // configuration's language, a string is written as the file's text, and
  // null writes nothing.
  if (manifest !== null) {
    mkdirSync(join(root, '.brain-kit'));
    const text = manifest === 'valid'
      ? JSON.stringify({ lang: config.lang, files: [{ path: 'index.md', class: 'seeded' }, { path: '.githooks/pre-push', sha256: 'a'.repeat(64), class: 'managed' }] }, null, 2)
      : manifest;
    writeFileSync(join(root, '.brain-kit', 'manifest.json'), text);
  }
  if (hook !== 'absent') {
    mkdirSync(join(root, '.githooks'));
    const hookFile = join(root, '.githooks', 'pre-push');
    if (hook === 'template') copyFileSync(TEMPLATE_HOOK, hookFile);
    else if (hook === 'empty') writeFileSync(hookFile, '');
    chmodSync(hookFile, hookMode);
  }
  // `nested`: the repository's top level is the vault's parent directory,
  // so the vault sits one level below it.
  const gitTop = nested ? join(root, '..') : root;
  if (gitRepo) {
    fixtureGit(gitTop, ['init', '-q', '-b', 'main', '.'], home);
    if (hooksPath !== null) fixtureGit(gitTop, ['config', 'core.hooksPath', hooksPath], home);
    fixtureGit(gitTop, ['commit', '-q', '--allow-empty', '-m', 'init'], home);
    if (originHead !== null) {
      fixtureGit(gitTop, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], home);
      fixtureGit(gitTop, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${originHead}`], home);
    }
  }
  const toolsDir = makeTools(tools);
  // What a scheduled round's propose runs from PATH (brain-kit for the
  // gate, gh for the pull request), in a directory of machine.json's
  // path_extra: the unit PATH then reaches both whatever the shell's PATH
  // holds, so a tool left out of the shell's PATH below tests that check
  // alone, on any machine (a CI runner has a gh in /usr/bin, this one may not).
  const roundTools = join(base, 'round-tools');
  mkdirSync(roundTools);
  for (const name of ['brain-kit', 'gh']) writeScript(join(roundTools, name), 'exit 0');
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
    chmodSync(stateDir, 0o700);
    const value = {
      vault_id: 'ana-brain',
      canonical_path: realpathSync(root),
      claude_bin: 'claude',
      state_dir: stateDir,
      paths: { watermark: 'watermark.json', last_run: 'last-run.json', log_dir: 'logs' },
      notify_command: ['notify', 'brain-kit'],
      path_extra: [roundTools],
      ...machine,
    };
    writeFileSync(machineFile, machineText ?? JSON.stringify(value, null, 2));
    chmodSync(machineFile, fileMode);
    if (curator) readyCurator({ root, home, env, stateDir });
    // Last, so a directory mode without the owner's write bit (0577) is
    // still reached with the file already in it.
    chmodSync(stateDir, dirMode);
  }
  return { base, home, root, gitTop, env, stateDir, machineFile, toolsDir, roundTools };
}

// Yesterday as a YYYY-MM-DD day in UTC, the fixture configuration's zone.
function utcDay(offsetDays, now = new Date()) {
  return new Date(now.getTime() + offsetDays * 86400000).toISOString().slice(0, 10);
}

// A scheduled curator in working order: the configured project under the
// default transcripts directory, a mark at yesterday, a last round that
// ran the model for two minutes, and the timer installed through the
// kit's own `schedule install` (against the systemctl stand-in).
function readyCurator({ root, home, env, stateDir }) {
  mkdirSync(join(home, '.claude', 'projects', '-home-ana-brain'), { recursive: true });
  writeFileSync(join(stateDir, 'watermark.json'), JSON.stringify({ sources: { transcripts: utcDay(-1) } }));
  writeFileSync(join(stateDir, 'last-run.json'), JSON.stringify(lastRun()));
  const sink = { write: () => {} };
  try {
    runScheduleSync(['install', root, '--platform', 'systemd'], { stdout: sink, stderr: sink }, createTranslator('en'), { env });
  } catch {
    // A fixture whose configuration or machine file is broken on purpose
    // has no schedule to install; the checks under test say why.
  }
}

function lastRun(overrides = {}) {
  return {
    at: new Date().toISOString(), durationMs: 120000, exit: 0, reasonCode: 'proposed', reason: 'Proposed 2 file(s) on brain-kit/curate-x.', numTurns: 12, costUsd: 0.42, ...overrides,
  };
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

async function doctor(fixture, argv = [], { nodeVersion = process.versions.node, env = fixture.env, cwd = fixture.root, now, probeTimeoutMs } = {}) {
  const f = fakeIo();
  const code = await runDoctor(['--json', ...argv, fixture.root], f.io, t, {
    env, cwd, nodeVersion, ...(now ? { now } : {}), ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {}),
  });
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
  // Every check in table order; connectors says one line per connector
  // source the configuration lists, both off here.
  assert.deepEqual(report.checks.map((c) => c.id), CHECK_IDS.flatMap((id) => (id === 'connectors' ? [id, id] : [id])));
  for (const c of report.checks) assert.equal(c.status, 'ok', JSON.stringify(c));
  assert.equal(code, EXIT.OK);
  assert.equal(report.vault, fx.root);
  assert.deepEqual(report.counts, { ok: CHECK_IDS.length + 1, warn: 0, fail: 0 });
});

test('the check table is exactly the phase 1, 2 and 3 set, each named by what it prevents', () => {
  assert.deepEqual(CHECK_IDS, [
    'node-version', 'git-present', 'default-branch-known', 'hooks-path', 'brain-kit-on-path', 'config-valid', 'manifest-valid', 'machine-valid',
    'state-dir-resolves', 'state-dir-mode', 'kit-version', 'gh-present', 'claude-present', 'gitignore-node-modules', 'privacy-keywords',
    'claude-real', 'claude-isolation-flags', 'round-scope', 'include-projects', 'connectors', 'watermark', 'last-run', 'schedule', 'notify',
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
  // The node on PATH is the same binary but reports another version than
  // the one injected here, so it is named.
  assertCheck(r.report, 'node-version', 'ok', 'doctor.node_version.ok_path_differs');
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

test('node-version: the node on PATH is the running one, reported plainly', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'node-version']);
  assertCheck(report, 'node-version', 'ok', 'doctor.node_version.ok');
});

test('node-version: names the node the hook would find on PATH when it is another Node', async () => {
  const fx = setup({ tools: { node: 'newer' } });
  const { report, code } = await doctor(fx, ['--only', 'node-version']);
  const c = assertCheck(report, 'node-version', 'ok', 'doctor.node_version.ok_path_differs');
  assert.equal(c.params.bin, join(fx.toolsDir, 'node'));
  assert.equal(c.params.pathVersion, '25.0.0');
  assert.equal(code, EXIT.OK);
});

test('node-version: the same version at another path is still named', async () => {
  const fx = setup({ tools: { node: 'absent' } });
  const elsewhere = join(fx.base, 'other node');
  mkdirSync(elsewhere);
  writeScript(join(elsewhere, 'node'), `echo v${process.versions.node}`);
  const env = { ...fx.env, PATH: `${elsewhere}${delimiter}${fx.toolsDir}` };
  const { report } = await doctor(fx, ['--only', 'node-version'], { env });
  const c = assertCheck(report, 'node-version', 'ok', 'doctor.node_version.ok_path_differs');
  assert.equal(c.params.bin, join(elsewhere, 'node'));
});

test('node-version: fails when the node on PATH is below 24, even if the running one is not', async () => {
  const fx = setup({ tools: { node: 'old' } });
  const { report, code } = await doctor(fx, ['--only', 'node-version']);
  const c = assertCheck(report, 'node-version', 'fail', 'doctor.node_version.path_too_old');
  assert.equal(c.params.pathVersion, '22.11.0');
  assert.equal(code, EXIT.FAILURE);
});

test('node-version: a node on PATH whose answer only contains a version somewhere is not proof', async () => {
  const fx = setup({ tools: { node: 'absent' } });
  writeScript(join(fx.toolsDir, 'node'), 'echo "Welcome to v25.0.0"');
  const { report } = await doctor(fx, ['--only', 'node-version']);
  assertCheck(report, 'node-version', 'fail', 'doctor.node_version.path_unrecognised');
});

test('node-version: fails when there is no node on PATH for the hook to run', async () => {
  const fx = setup({ tools: { node: 'absent' } });
  const { report } = await doctor(fx, ['--only', 'node-version']);
  assertCheck(report, 'node-version', 'fail', 'doctor.node_version.path_missing');
});

test('node-version: a node on PATH that prints nothing, or will not run, is not proof', async () => {
  let fx = setup({ tools: { node: 'silent' } });
  let r = await doctor(fx, ['--only', 'node-version']);
  assertCheck(r.report, 'node-version', 'fail', 'doctor.node_version.path_unrecognised');
  fx = setup({ tools: { node: 'broken' } });
  r = await doctor(fx, ['--only', 'node-version']);
  assertCheck(r.report, 'node-version', 'fail', 'doctor.node_version.path_failed');
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

// Slice C: doctor asks the ONE resolver (src/git.mjs, defaultBranch), so
// "unknown" means what it means to sync and lint: no configured
// vault.default_branch, no <remote>/HEAD, main or master, and no local main
// or master. The remedy is the configuration, which works before the first
// push; `git remote set-head --auto` fails until a branch is published.
// The configuration as the remote's default branch carries it: committed
// and made origin/main, since the resolver reads vault.default_branch from
// there whenever the remote publishes a default branch.
function commitConfig(fx) {
  fixtureGit(fx.gitTop, ['add', 'brain-kit.config.json'], fx.home);
  fixtureGit(fx.gitTop, ['commit', '-q', '-m', 'configuration'], fx.home);
  fixtureGit(fx.gitTop, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], fx.home);
}

test('default-branch-known: warns, naming vault.default_branch and set-head and never the branch checked out, when nothing names a default branch', async () => {
  const fx = setup({ originHead: null });
  fixtureGit(fx.root, ['branch', '-m', 'main', 'curator/today'], fx.home);
  const { report, code } = await doctor(fx, ['--only', 'default-branch-known']);
  const c = assertCheck(report, 'default-branch-known', 'warn', 'doctor.default_branch_known.unset');
  assert.deepEqual(c.params, { file: 'brain-kit.config.json', remote: 'origin', command: 'git remote set-head origin --auto' });
  assert.match(c.message, /vault\.default_branch/);
  assert.doesNotMatch(c.message, /curator/);
  assert.equal(code, EXIT.OK, 'a warning alone never fails the run');
});

test('default-branch-known: before the first push, a local main is the answer, read from refs/heads/main', async () => {
  const fx = setup({ originHead: null });
  const { report } = await doctor(fx, ['--only', 'default-branch-known']);
  const c = assertCheck(report, 'default-branch-known', 'ok', 'doctor.default_branch_known.ok');
  assert.deepEqual(c.params, { branch: 'main', from: 'refs/heads/main' });
});

test('default-branch-known: vault.default_branch is read from the working tree before anything is published, and from the remote\'s default branch after', async () => {
  const config = baseConfig();
  config.vault.default_branch = 'trunk';
  const before = setup({ originHead: null, config });
  fixtureGit(before.root, ['branch', '-m', 'main', 'work'], before.home);
  const first = assertCheck((await doctor(before, ['--only', 'default-branch-known'])).report, 'default-branch-known', 'ok', 'doctor.default_branch_known.ok');
  assert.deepEqual(first.params, { branch: 'trunk', from: 'brain-kit.config.json vault.default_branch in the working tree' });
  const after = setup({ config });
  commitConfig(after);
  const second = assertCheck((await doctor(after, ['--only', 'default-branch-known'])).report, 'default-branch-known', 'ok', 'doctor.default_branch_known.ok');
  assert.deepEqual(second.params, { branch: 'trunk', from: 'brain-kit.config.json vault.default_branch at origin/main' });
  const uncommitted = setup({ config });
  assertCheck((await doctor(uncommitted, ['--only', 'default-branch-known'])).report, 'default-branch-known', 'ok', 'doctor.default_branch_known.ok');
  assert.equal(check((await doctor(uncommitted, ['--only', 'default-branch-known'])).report, 'default-branch-known').params.branch, 'main',
    'a working-tree value the remote\'s default branch does not carry decides nothing');
});

test('default-branch-known: a vault.default_branch that is not a branch name warns and names it', async () => {
  const config = baseConfig();
  config.vault.default_branch = '--upload-pack=x';
  const fx = setup({ config });
  commitConfig(fx);
  const c = assertCheck((await doctor(fx, ['--only', 'default-branch-known'])).report, 'default-branch-known', 'warn', 'doctor.default_branch_known.config_invalid');
  assert.deepEqual(c.params, { file: 'brain-kit.config.json', name: '--upload-pack=x' });
});

// A real remote on this machine, publishing `branches` (each at the
// vault's commit), added as origin. Built as a bare clone rather than by
// pushing, since the vault's own gate runs on a push.
function withRemote(fx, branches, head = branches[0]) {
  const bare = join(fx.base, 'remote.git');
  fixtureGit(fx.base, ['clone', '-q', '--bare', fx.gitTop, bare], fx.home);
  for (const branch of branches) fixtureGit(bare, ['branch', '-f', branch, 'main'], fx.home);
  fixtureGit(bare, ['symbolic-ref', 'HEAD', `refs/heads/${head}`], fx.home);
  if (!branches.includes('main')) fixtureGit(bare, ['branch', '-D', 'main'], fx.home);
  fixtureGit(fx.gitTop, ['remote', 'add', 'origin', bare], fx.home);
  return bare;
}

test('default-branch-known: a remote that publishes branches but not the default one warns, as sync refuses, never ok', async () => {
  const fx = setup();
  withRemote(fx, ['trunk']);
  const c = assertCheck((await doctor(fx, ['--only', 'default-branch-known'])).report, 'default-branch-known', 'warn', 'doctor.default_branch_known.remote_lacks_branch');
  assert.deepEqual(c.params, {
    remote: 'origin', branch: 'main', published: ['trunk'], head: 'trunk', file: 'brain-kit.config.json', command: 'git remote set-head origin --auto',
  });
});

test('default-branch-known: a remote that publishes the default branch, or nothing yet, is ok', async () => {
  const fx = setup();
  withRemote(fx, ['main', 'trunk']);
  assertCheck((await doctor(fx, ['--only', 'default-branch-known'])).report, 'default-branch-known', 'ok', 'doctor.default_branch_known.ok');
  const empty = setup();
  fixtureGit(empty.base, ['init', '-q', '--bare', '-b', 'main', join(empty.base, 'empty.git')], empty.home);
  fixtureGit(empty.gitTop, ['remote', 'add', 'origin', join(empty.base, 'empty.git')], empty.home);
  assertCheck((await doctor(empty, ['--only', 'default-branch-known'])).report, 'default-branch-known', 'ok', 'doctor.default_branch_known.ok');
});

test('default-branch-known: a remote that cannot be asked warns, never ok', async () => {
  const fx = setup();
  fixtureGit(fx.gitTop, ['remote', 'add', 'origin', join(fx.base, 'gone.git')], fx.home);
  const c = assertCheck((await doctor(fx, ['--only', 'default-branch-known'])).report, 'default-branch-known', 'warn', 'doctor.default_branch_known.remote_unverified');
  assert.equal(c.params.branch, 'main');
  assert.equal(c.params.remote, 'origin');
  assert.match(c.params.detail, /^fatal: /);
});

test('default-branch-known: a default branch tracking a branch of this repository warns, as sync refuses', async () => {
  const fx = setup();
  fixtureGit(fx.gitTop, ['config', 'branch.main.remote', '.'], fx.home);
  fixtureGit(fx.gitTop, ['config', 'branch.main.merge', 'refs/heads/trunk'], fx.home);
  const c = assertCheck((await doctor(fx, ['--only', 'default-branch-known'])).report, 'default-branch-known', 'warn', 'doctor.default_branch_known.local_upstream');
  assert.deepEqual(c.params, { branch: 'main', key: 'branch.main.remote' });
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
  assert.deepEqual(c.params, { branch: 'main', from: 'refs/remotes/origin/HEAD' });
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

test('hooks-path: fails when the hook itself is absent, and names the command that installs it', async () => {
  const fx = setup({ hook: 'absent' });
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  const c = assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.hook_missing');
  assert.equal(c.params.command, 'brain-kit update --install-hook');
  assert.ok(c.message.endsWith('Run: brain-kit update --install-hook'), c.message);
});

test('hooks-path: with neither core.hooksPath nor a hook, the remedy is the command that installs both, not a hooksPath that leads to the next failure', async () => {
  const fx = setup({ hook: 'absent', hooksPath: null });
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  const c = assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.unset_no_hook');
  assert.equal(c.params.command, 'brain-kit update --install-hook');
});

// --- manifest-valid -----------------------------------------------------------

test('manifest-valid: fails when the manifest is missing, and when it cannot be read, the states update refuses', async () => {
  let fx = setup({ manifest: null });
  let r = await doctor(fx, ['--only', 'manifest-valid']);
  assertCheck(r.report, 'manifest-valid', 'fail', 'doctor.manifest_valid.missing');
  assert.equal(r.code, EXIT.FAILURE);
  for (const text of ['', 'not json', '{"files": []}', '{"lang": "en", "files": [{"path": "../x", "sha256": "0", "class": "managed"}]}']) {
    fx = setup({ manifest: text });
    r = await doctor(fx, ['--only', 'manifest-valid']);
    assertCheck(r.report, 'manifest-valid', 'fail', 'doctor.manifest_valid.unreadable');
    assert.equal(r.code, EXIT.FAILURE, text);
  }
  fx = setup({ manifest: null });
  mkdirSync(join(fx.root, '.brain-kit', 'manifest.json'), { recursive: true });
  r = await doctor(fx, ['--only', 'manifest-valid']);
  assertCheck(r.report, 'manifest-valid', 'fail', 'doctor.manifest_valid.unreadable');
});

test('manifest-valid: accepts the shape init and adopt write (no hash on a seeded entry) and an older one with seeded hashes, and fails a managed entry with none', async () => {
  let fx = setup();
  let r = await doctor(fx, ['--only', 'manifest-valid']);
  assertCheck(r.report, 'manifest-valid', 'ok', 'doctor.manifest_valid.ok');
  fx = setup({ manifest: JSON.stringify({ lang: 'en', files: [{ path: 'index.md', sha256: 'b'.repeat(64), class: 'seeded' }] }) });
  r = await doctor(fx, ['--only', 'manifest-valid']);
  assertCheck(r.report, 'manifest-valid', 'ok', 'doctor.manifest_valid.ok');
  fx = setup({ manifest: JSON.stringify({ lang: 'en', files: [{ path: '.githooks/pre-push', class: 'managed' }] }) });
  r = await doctor(fx, ['--only', 'manifest-valid']);
  assertCheck(r.report, 'manifest-valid', 'fail', 'doctor.manifest_valid.unreadable');
});

test('manifest-valid: warns when the manifest language differs from the configuration\'s, or the engine is older than kit_version', async () => {
  const other = JSON.stringify({ lang: 'pt-BR', files: [{ path: 'index.md', class: 'seeded' }] });
  let fx = setup({ manifest: other });
  let r = await doctor(fx, ['--only', 'manifest-valid']);
  const c = assertCheck(r.report, 'manifest-valid', 'warn', 'doctor.manifest_valid.lang_differs');
  assert.deepEqual(c.params, { recorded: 'pt-BR', configured: 'en' });
  assert.equal(r.code, EXIT.OK);
  fx = setup({ config: { ...baseConfig(), kit_version: '999.0.0' } });
  r = await doctor(fx, ['--only', 'manifest-valid']);
  assertCheck(r.report, 'manifest-valid', 'warn', 'doctor.manifest_valid.kit_older');
  fx = setup({ config: { ...baseConfig(), kit_version: 'not-a-version' } });
  r = await doctor(fx, ['--only', 'manifest-valid']);
  assertCheck(r.report, 'manifest-valid', 'warn', 'doctor.manifest_valid.kit_older');
  // An engine NEWER than kit_version is what update fixes, not a refusal.
  fx = setup({ config: { ...baseConfig(), kit_version: '0.0.0' } });
  r = await doctor(fx, ['--only', 'manifest-valid']);
  assertCheck(r.report, 'manifest-valid', 'ok', 'doctor.manifest_valid.ok');
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

test('config-valid: fails on an allow rule that grants a scoped tool with no scope, naming the setting and each rule; an explicit scope passes', async () => {
  for (const [extra, rules] of [[['Read'], 'Read'], [['Bash(*)', 'Edit()'], 'Bash(*), Edit()'], [['Write(./**),Grep'], 'Grep']]) {
    const config = baseConfig();
    config.curate.allowed_tools_extra = extra;
    const fx = setup({ config });
    const { report, code } = await doctor(fx, ['--only', 'config-valid']);
    const c = assertCheck(report, 'config-valid', 'fail', 'doctor.config_valid.unscoped_tool');
    assert.deepEqual([c.params.setting, c.params.rules], ['curate.allowed_tools_extra', rules]);
    assert.match(c.message, /curate refuses to start/);
    assert.equal(code, EXIT.FAILURE);
  }
  const config = baseConfig();
  config.curate.allowed_tools_extra = ['Read(//**)', 'mcp__x__y'];
  const { report } = await doctor(setup({ config }), ['--only', 'config-valid']);
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

test('machine-valid: fails on a transcripts_dir holding a character no read rule can carry, naming it', async () => {
  const fx = setup({ machine: { transcripts_dir: '~/Sessões (cópia)' } });
  const { report } = await doctor(fx, ['--only', 'machine-valid']);
  const c = assertCheck(report, 'machine-valid', 'fail', 'doctor.machine_valid.invalid');
  assert.match(JSON.stringify(c.params), /transcripts_dir: must not hold \( \)/);
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

// The vault reached through a symbolic link. `linkState` is where the
// state directory used to be derived from the linked path (the vault
// directory's name and a hash of the path as given); stateDirFor now
// derives it from the real path, whatever path reached the vault.
function setupThroughLink({ machineUnder }) {
  const fx = setup({ writeMachine: false });
  const link = join(fx.base, 'link to brain');
  symlinkSync(fx.root, link);
  const real = realpathSync(fx.root);
  const linkState = join(fx.env.XDG_STATE_HOME, 'brain-kit', `link to brain-${createHash('sha256').update(link).digest('hex').slice(0, 8)}`);
  const realState = stateDirFor(real, fx.env);
  assert.equal(stateDirFor(link, fx.env), realState, 'through the link, the state directory is the real path\'s');
  assert.notEqual(linkState, realState, 'the old derivation must differ for this test to mean anything');
  const target = machineUnder === 'real' ? realState : linkState;
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o700);
  const file = join(target, 'machine.json');
  writeFileSync(file, JSON.stringify({
    vault_id: 'ana-brain', canonical_path: real, claude_bin: 'claude',
    paths: { watermark: 'watermark.json', last_run: 'last-run.json', log_dir: 'logs' },
  }));
  chmodSync(file, 0o600);
  return { ...fx, root: link, real, linkState, realState };
}

test('state-dir-resolves: passes through a symlink, because the state directory is derived from the real path', async () => {
  const fx = setupThroughLink({ machineUnder: 'real' });
  const { report } = await doctor(fx, ['--only', 'state-dir-resolves,machine-valid']);
  const c = assertCheck(report, 'state-dir-resolves', 'ok', 'doctor.state_dir_resolves.ok');
  assert.equal(c.params.dir, fx.realState);
  assertCheck(report, 'machine-valid', 'ok');
});

test('state-dir-resolves: a machine.json under the directory the linked path alone would name is not where anything looks', async () => {
  const fx = setupThroughLink({ machineUnder: 'link' });
  const { report, code } = await doctor(fx, ['--only', 'state-dir-resolves']);
  const c = assertCheck(report, 'state-dir-resolves', 'fail', 'doctor.state_dir_resolves.none');
  assert.equal(c.params.dir, fx.realState);
  assert.equal(code, EXIT.FAILURE);
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
    paths: { watermark: 'watermark.json', last_run: 'last-run.json', log_dir: 'logs' },
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

test('state-dir-mode: fails when the state directory is 0750, open to its group', async () => {
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

test('gh-present: warns when gh is absent, saying plainly that it is not installed, because propose will need it', async () => {
  const fx = setup({ tools: { gh: 'absent' } });
  const { report, code } = await doctor(fx, ['--only', 'gh-present']);
  const c = assertCheck(report, 'gh-present', 'warn', 'doctor.gh_present.not_installed');
  assert.match(c.message, /gh is not installed/);
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

// A case that git feeds on standard input reads it all first, as the real
// git does, with the shell's own `read` (PATH holds no `cat`): a script
// that exits without reading can make the writer see a broken pipe, and
// the answer would then depend on timing.
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
  const fx = setup({ tools: { git: scriptedGit({ 'check-ignore -v': "while IFS= read -r _; do :; done; printf '%s\\000%s\\000%s\\000%s\\000' .gitignore 1 node_modules/ node_modules/; exit 1" }) } });
  const { report } = await doctor(fx, ['--only', 'gitignore-node-modules']);
  assertCheck(report, 'gitignore-node-modules', 'warn', 'doctor.gitignore_node_modules.not_ignored');
});

test('gitignore-node-modules: git printing the path back with exit 0 passes, so the test above isolates the status', async () => {
  const fx = setup({ tools: { git: scriptedGit({ 'check-ignore -v': "while IFS= read -r _; do :; done; printf '%s\\000%s\\000%s\\000%s\\000' .gitignore 1 node_modules/ node_modules/; exit 0" }) } });
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

// --- fix round 1 ---------------------------------------------------------------

test('every git probe ignores GIT_DIR: a vault with no hooksPath is not reported gated by another repository\'s', async () => {
  const fx = setup({ hooksPath: null });
  // Another repository, configured the way every brain-kit vault is.
  const other = join(fx.base, 'other repo');
  mkdirSync(other);
  fixtureGit(other, ['init', '-q', '-b', 'main', '.'], fx.home);
  fixtureGit(other, ['config', 'core.hooksPath', '.githooks'], fx.home);
  const env = { ...fx.env, GIT_DIR: join(other, '.git') };
  const { report, code } = await doctor(fx, ['--only', 'hooks-path,default-branch-known'], { env });
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.unset');
  assertCheck(report, 'default-branch-known', 'ok');
  assert.equal(code, EXIT.FAILURE);
});

test('localGitVarNames adds what the installed git lists to the fixed list, and keeps the fixed list when git cannot answer', () => {
  const dir = join(makeTempDir('brain-kit-doctor-gitenv-'), 'bin');
  mkdirSync(dir);
  writeScript(join(dir, 'git'), 'printf "GIT_DIR\\nGIT_SOMETHING_NEWER\\nnot-a-variable\\n"');
  const names = localGitVarNames({ PATH: dir });
  assert.ok(names.includes('GIT_SOMETHING_NEWER'));
  assert.ok(!names.includes('not-a-variable'));
  for (const name of LOCAL_GIT_VARS) assert.ok(names.includes(name), name);
  const empty = join(makeTempDir('brain-kit-doctor-gitenv-'), 'bin');
  mkdirSync(empty);
  assert.deepEqual(localGitVarNames({ PATH: empty }), [...LOCAL_GIT_VARS]);
});

test('the template doctor compares against is the one init installs', () => {
  assert.equal(SHIPPED_HOOK, TEMPLATE_HOOK);
});

test('every git probe ignores GIT_WORK_TREE and GIT_CONFIG_PARAMETERS too', async () => {
  const fx = setup({ hooksPath: null });
  const env = { ...fx.env, GIT_CONFIG_PARAMETERS: "'core.hookspath'='.githooks'", GIT_WORK_TREE: fx.base };
  const { report } = await doctor(fx, ['--only', 'hooks-path'], { env });
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.unset');
});

test('hooks-path: a vault one level below the top level with core.hooksPath .githooks points elsewhere, and fails the run', async () => {
  const fx = setup({ nested: true });
  assert.notEqual(realpathSync(fx.gitTop), realpathSync(fx.root));
  const { report, code } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.elsewhere');
  assert.equal(code, EXIT.FAILURE);
});

test('hooks-path: a nested vault whose hooksPath points into the vault is not a working gate, and says why', async () => {
  const fx = setup({ nested: true, hooksPath: `${VAULT_NAME}/.githooks` });
  const { report, code } = await doctor(fx, ['--only', 'hooks-path']);
  const c = assertCheck(report, 'hooks-path', 'fail', 'doctor.hooks_path.not_top_level');
  assert.equal(c.params.top, realpathSync(fx.gitTop));
  assert.match(c.message, /refuses every push/);
  assert.equal(code, EXIT.FAILURE);
});

test('hooks-path: warns when the installed hook differs from the template this kit ships', async () => {
  const fx = setup();
  writeFileSync(join(fx.root, '.githooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
  const { report, code } = await doctor(fx, ['--only', 'hooks-path']);
  const c = assertCheck(report, 'hooks-path', 'warn', 'doctor.hooks_path.differs');
  assert.equal(c.params.template, TEMPLATE_HOOK);
  assert.equal(code, EXIT.OK);
});

test('hooks-path: one byte of difference from the template is a difference', async () => {
  const fx = setup();
  writeFileSync(join(fx.root, '.githooks', 'pre-push'), `${readFileSync(TEMPLATE_HOOK, 'utf8')}\n`);
  const { report } = await doctor(fx, ['--only', 'hooks-path']);
  assertCheck(report, 'hooks-path', 'warn', 'doctor.hooks_path.differs');
});

test('brain-kit-on-path: fails when there is no brain-kit on PATH, since the hook then refuses every push', async () => {
  const fx = setup({ tools: { brainKit: 'absent' } });
  const { report, code } = await doctor(fx);
  assertCheck(report, 'brain-kit-on-path', 'fail', 'doctor.brain_kit_on_path.missing');
  assert.deepEqual(report.checks.filter((c) => c.status === 'fail').map((c) => c.id), ['brain-kit-on-path']);
  assert.equal(code, EXIT.FAILURE);
});

test('brain-kit-on-path: a brain-kit that will not run, or answers with no version, fails', async () => {
  let fx = setup({ tools: { brainKit: 'broken' } });
  let r = await doctor(fx, ['--only', 'brain-kit-on-path']);
  assertCheck(r.report, 'brain-kit-on-path', 'fail', 'doctor.brain_kit_on_path.failed');
  fx = setup({ tools: { brainKit: 'silent' } });
  r = await doctor(fx, ['--only', 'brain-kit-on-path']);
  assertCheck(r.report, 'brain-kit-on-path', 'fail', 'doctor.brain_kit_on_path.unrecognised');
  fx = setup({ tools: { brainKit: 'junk' } });
  r = await doctor(fx, ['--only', 'brain-kit-on-path']);
  assertCheck(r.report, 'brain-kit-on-path', 'fail', 'doctor.brain_kit_on_path.unrecognised');
});

test('brain-kit-on-path: the real launcher on PATH with no node on PATH cannot start, and fails', async () => {
  const fx = setup({ tools: { node: 'absent' } });
  const { report } = await doctor(fx, ['--only', 'brain-kit-on-path']);
  assertCheck(report, 'brain-kit-on-path', 'fail', 'doctor.brain_kit_on_path.failed');
});

test('brain-kit-on-path: warns when the brain-kit on PATH is another version than the one running', async () => {
  const fx = setup({ tools: { brainKit: 'other' } });
  const { report, code } = await doctor(fx, ['--only', 'brain-kit-on-path']);
  const c = assertCheck(report, 'brain-kit-on-path', 'warn', 'doctor.brain_kit_on_path.other_version');
  assert.equal(c.params.version, '9.9.9');
  assert.equal(code, EXIT.OK);
});

test('brain-kit-on-path: passes with this checkout\'s launcher on PATH, naming it', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'brain-kit-on-path']);
  const c = assertCheck(report, 'brain-kit-on-path', 'ok', 'doctor.brain_kit_on_path.ok');
  assert.equal(c.params.bin, join(fx.toolsDir, 'brain-kit'));
  assert.equal(c.params.version, kitVersion());
});

// Final review I1: the scheduled round runs with the unit's PATH, not the
// shell's, and its propose needs brain-kit and gh on it.
test('brain-kit-on-path: the installed round\'s PATH that reaches neither brain-kit nor gh fails, naming the unit file, its PATH and both commands', async () => {
  const fx = setup();
  const service = join(fx.home, '.config', 'systemd', 'user', 'brain-kit-curate-ana-brain.service');
  const text = readFileSync(service, 'utf8');
  assert.match(text, /^Environment="PATH=/m, 'the fixture installed the unit');
  writeFileSync(service, text.replace(/^Environment="PATH=.*"$/m, 'Environment="PATH=/nonexistent-dir:/another-nonexistent-dir"'));
  const { report } = await doctor(fx, ['--only', 'brain-kit-on-path']);
  const c = assertCheck(report, 'brain-kit-on-path', 'fail', 'doctor.brain_kit_on_path.unit_missing_installed');
  assert.equal(c.params.file, service);
  assert.equal(c.params.path, '/nonexistent-dir:/another-nonexistent-dir');
  assert.equal(c.params.commands, 'brain-kit, gh');
});

test('brain-kit-on-path: the installed round\'s PATH is read back as systemd wrote it, quoting undone, and passes when it reaches both', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'brain-kit-on-path']);
  assertCheck(report, 'brain-kit-on-path', 'ok', 'doctor.brain_kit_on_path.ok');
  // A directory with a percent sign (doubled by the renderer) still resolves.
  const odd = join(fx.base, 'odd 100% dir');
  mkdirSync(odd);
  for (const name of ['brain-kit', 'gh']) writeScript(join(odd, name), 'exit 0');
  const service = join(fx.home, '.config', 'systemd', 'user', 'brain-kit-curate-ana-brain.service');
  writeFileSync(service, readFileSync(service, 'utf8').replace(/^Environment="PATH=.*"$/m, `Environment="PATH=${odd.replace(/%/g, '%%')}"`));
  assertCheck((await doctor(fx, ['--only', 'brain-kit-on-path'])).report, 'brain-kit-on-path', 'ok', 'doctor.brain_kit_on_path.ok');
});

const SYSTEM_GH = [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].some((dir) => existsSync(join(dir, 'gh')));
test('brain-kit-on-path: with no round installed, a gh found neither on the PATH schedule install would write nor on the shell\'s fails, naming the PATH', { skip: SYSTEM_GH && 'this machine has a gh in node\'s or a system directory, which the unit PATH always holds' }, async () => {
  const fx = setup({ tools: { gh: 'absent' }, machine: { path_extra: [] } });
  const { report } = await doctor(fx, ['--only', 'brain-kit-on-path,schedule']);
  assertCheck(report, 'schedule', 'warn', 'doctor.schedule.not_installed');
  const c = assertCheck(report, 'brain-kit-on-path', 'fail', 'doctor.brain_kit_on_path.unit_missing_computed');
  assert.equal(c.params.commands, 'gh');
  assert.ok(c.params.path.split(':').includes(fx.toolsDir), c.params.path);
});

test('state-dir-mode: a state directory at 0577 is not 0700, even though it is numerically below it', async () => {
  const fx = setup({ dirMode: 0o577 });
  const { report, code } = await doctor(fx, ['--only', 'state-dir-mode']);
  const c = assertCheck(report, 'state-dir-mode', 'fail', 'doctor.state_dir_mode.dir_mode');
  assert.equal(c.params.mode, '0577');
  assert.equal(code, EXIT.FAILURE);
});

test('state-dir-mode: a machine.json at 0577 is not 0600, even though it is numerically below it', async () => {
  const fx = setup({ fileMode: 0o577 });
  const { report, code } = await doctor(fx, ['--only', 'state-dir-mode']);
  const c = assertCheck(report, 'state-dir-mode', 'fail', 'doctor.state_dir_mode.file_mode');
  assert.equal(c.params.mode, '0577');
  assert.equal(code, EXIT.FAILURE);
});

test('claude-present: claude_bin naming git or node answers with a version but is not claude', async () => {
  for (const name of ['git', 'node']) {
    const fx = setup({ machine: { claude_bin: name } });
    const { report } = await doctor(fx, ['--only', 'claude-present']);
    assertCheck(report, 'claude-present', 'warn', 'doctor.claude_present.unrecognised');
  }
});

// A claude stand-in that leaves a mark when it is executed, so a test can
// prove it was NOT.
function markingClaude(fx) {
  const mark = join(fx.base, 'claude-was-run');
  const bin = join(fx.base, 'marking bin');
  mkdirSync(bin);
  writeScript(join(bin, 'claude'), `: > "$CLAUDE_MARK"\necho "1.2.3 (Claude Code)"`);
  const env = { ...fx.env, CLAUDE_MARK: mark, PATH: `${bin}${delimiter}${fx.toolsDir}` };
  return { mark, env };
}

test('claude-present: the marking stand-in is run when machine.json is valid and private, so the tests below mean something', async () => {
  const fx = setup({ tools: { claude: 'absent' } });
  const { mark, env } = markingClaude(fx);
  const { report } = await doctor(fx, ['--only', 'claude-present'], { env });
  assertCheck(report, 'claude-present', 'ok');
  assert.equal(existsSync(mark), true);
});

test('claude-present: never executes claude_bin from a machine.json the kit would refuse', async () => {
  const fx = setup({ tools: { claude: 'absent' }, machine: { vault_id: 'Not Valid' } });
  const { mark, env } = markingClaude(fx);
  const { report } = await doctor(fx, ['--only', 'claude-present'], { env });
  assertCheck(report, 'claude-present', 'warn', 'doctor.claude_present.machine_invalid');
  assert.equal(existsSync(mark), false);
});

test('claude-present: never executes claude_bin when machine.json can be written by group or others', async () => {
  for (const fileMode of [0o620, 0o602]) {
    const fx = setup({ tools: { claude: 'absent' }, fileMode });
    const { mark, env } = markingClaude(fx);
    const { report } = await doctor(fx, ['--only', 'claude-present'], { env });
    assertCheck(report, 'claude-present', 'warn', 'doctor.claude_present.machine_writable');
    assert.equal(existsSync(mark), false);
  }
});

test('claude-present: never executes claude_bin when the state directory can be written by group or others', async () => {
  const fx = setup({ tools: { claude: 'absent' }, dirMode: 0o770 });
  const { mark, env } = markingClaude(fx);
  const { report } = await doctor(fx, ['--only', 'claude-present'], { env });
  assertCheck(report, 'claude-present', 'warn', 'doctor.claude_present.machine_writable');
  assert.equal(existsSync(mark), false);
});

test('claude-present: a relative claude_bin with a slash is resolved from the vault, not from the working directory', async () => {
  const fx = setup({ tools: { claude: 'absent' }, machine: { claude_bin: 'tools/claude' } });
  mkdirSync(join(fx.root, 'tools'));
  writeScript(join(fx.root, 'tools', 'claude'), SCRIPTS.claude.ok);
  const { report } = await doctor(fx, ['--only', 'claude-present']);
  const c = assertCheck(report, 'claude-present', 'ok', 'doctor.claude_present.ok');
  assert.equal(c.params.bin, join(fx.root, 'tools', 'claude'));
});

test('config-valid: a secret pattern that does not compile fails, naming it', async () => {
  const config = baseConfig();
  config.privacy.secret_patterns = ['acme-[0-9]{8}', '(unclosed'];
  const fx = setup({ config });
  const { report, code } = await doctor(fx, ['--only', 'config-valid']);
  const c = assertCheck(report, 'config-valid', 'fail', 'doctor.config_valid.pattern');
  assert.deepEqual(c.params.patterns, ['(unclosed']);
  assert.match(c.message, /\(unclosed/);
  assert.equal(code, EXIT.FAILURE);
});

test('config-valid: secret patterns that all compile pass', async () => {
  const config = baseConfig();
  config.privacy.secret_patterns = ['acme-[0-9]{8}'];
  const fx = setup({ config });
  const { report } = await doctor(fx, ['--only', 'config-valid']);
  assertCheck(report, 'config-valid', 'ok');
});

test('default-branch-known: an origin/HEAD pointing at another remote\'s branch is not origin\'s default', async () => {
  const fx = setup({ originHead: null });
  fixtureGit(fx.root, ['update-ref', 'refs/remotes/upstream/main', 'HEAD'], fx.home);
  fixtureGit(fx.root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/upstream/main'], fx.home);
  const { report } = await doctor(fx, ['--only', 'default-branch-known']);
  assertCheck(report, 'default-branch-known', 'warn', 'doctor.default_branch_known.unrecognised');
});

test('default-branch-known: an origin/HEAD whose branch names a blob, not a commit, is dangling', async () => {
  const fx = setup({ originHead: null });
  writeFileSync(join(fx.base, 'blob.txt'), 'not a commit\n');
  const blob = fixtureGit(fx.root, ['hash-object', '-w', join(fx.base, 'blob.txt')], fx.home).stdout.trim();
  fixtureGit(fx.root, ['update-ref', 'refs/remotes/origin/main', blob], fx.home);
  fixtureGit(fx.root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], fx.home);
  const { report } = await doctor(fx, ['--only', 'default-branch-known']);
  assertCheck(report, 'default-branch-known', 'warn', 'doctor.default_branch_known.dangling');
});

test('gitignore-node-modules: ignored only in .git/info/exclude warns that the protection does not travel', async () => {
  const fx = setup({ gitignore: '' });
  writeFileSync(join(fx.root, '.git', 'info', 'exclude'), 'node_modules/\n');
  const { report, code } = await doctor(fx, ['--only', 'gitignore-node-modules']);
  const c = assertCheck(report, 'gitignore-node-modules', 'warn', 'doctor.gitignore_node_modules.local_only');
  assert.equal(c.params.source, '.git/info/exclude');
  assert.equal(code, EXIT.OK);
});

test('gitignore-node-modules: a global excludes file named .gitignore, outside the vault, does not travel either', async () => {
  const fx = setup({ gitignore: '' });
  const global = join(fx.home, '.gitignore');
  writeFileSync(global, 'node_modules/\n');
  writeFileSync(fx.env.GIT_CONFIG_GLOBAL, `[core]\n\texcludesFile = ${global}\n`);
  const { report } = await doctor(fx, ['--only', 'gitignore-node-modules']);
  assertCheck(report, 'gitignore-node-modules', 'warn', 'doctor.gitignore_node_modules.local_only');
});

test('gitignore-node-modules: a valid-looking answer from a git that exits 2 is not proof', async () => {
  const fx = setup({ tools: { git: scriptedGit({ 'check-ignore -v': "while IFS= read -r _; do :; done; printf '%s\\000%s\\000%s\\000%s\\000' .gitignore 1 node_modules/ node_modules/; exit 2" }) } });
  const { report } = await doctor(fx, ['--only', 'gitignore-node-modules']);
  assertCheck(report, 'gitignore-node-modules', 'warn', 'doctor.gitignore_node_modules.unknown');
});

test('gitignore-node-modules: node_modules/ in .gitignore with files under it already committed still warns, since ignoring does not untrack', async () => {
  const fx = setup({ gitignore: '' });
  mkdirSync(join(fx.root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(fx.root, 'node_modules', 'pkg', 'index.js'), 'x\n');
  fixtureGit(fx.root, ['add', 'node_modules'], fx.home);
  fixtureGit(fx.root, ['commit', '-q', '-m', 'deps'], fx.home);
  writeFileSync(join(fx.root, '.gitignore'), 'node_modules/\n');
  const { report, code } = await doctor(fx, ['--only', 'gitignore-node-modules']);
  const c = assertCheck(report, 'gitignore-node-modules', 'warn', 'doctor.gitignore_node_modules.tracked');
  assert.equal(c.params.count, 1);
  assert.equal(code, EXIT.OK);
});

test('gitignore-node-modules: a git that cannot list the index is not proof nothing is tracked', async () => {
  const fx = setup({ tools: { git: scriptedGit({
    'check-ignore -v': "while IFS= read -r _; do :; done; printf '%s\\000%s\\000%s\\000%s\\000' .gitignore 1 node_modules/ node_modules/; exit 0",
    '--literal-pathspecs ls-files': 'exit 128',
  }) } });
  const { report } = await doctor(fx, ['--only', 'gitignore-node-modules']);
  assertCheck(report, 'gitignore-node-modules', 'warn', 'doctor.gitignore_node_modules.unknown');
});

test('gitignore-node-modules: an answer naming another path, or no source, is not proof', async () => {
  let fx = setup({ tools: { git: scriptedGit({ 'check-ignore -v': "while IFS= read -r _; do :; done; printf '%s\\000%s\\000%s\\000%s\\000' .gitignore 1 node_modules/ elsewhere/; exit 0" }) } });
  let r = await doctor(fx, ['--only', 'gitignore-node-modules']);
  assertCheck(r.report, 'gitignore-node-modules', 'warn', 'doctor.gitignore_node_modules.unknown');
  fx = setup({ tools: { git: scriptedGit({ 'check-ignore -v': "while IFS= read -r _; do :; done; printf '%s\\000%s\\000%s\\000%s\\000' '' 1 node_modules/ node_modules/; exit 0" }) } });
  r = await doctor(fx, ['--only', 'gitignore-node-modules']);
  assertCheck(r.report, 'gitignore-node-modules', 'warn', 'doctor.gitignore_node_modules.unknown');
  fx = setup({ tools: { git: scriptedGit({ 'check-ignore -v': "while IFS= read -r _; do :; done; printf '%s\\000%s\\000%s\\000%s\\000' .gitignore 1 node_modules/ node_modules/; exit 0" }) } });
  r = await doctor(fx, ['--only', 'gitignore-node-modules']);
  assertCheck(r.report, 'gitignore-node-modules', 'ok', 'doctor.gitignore_node_modules.ok');
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
  assert.deepEqual([...new Set(report.checks.map((c) => c.id))], CHECK_IDS);
  for (const c of report.checks) {
    assert.deepEqual(Object.keys(c).sort(), ['id', 'message', 'messageKey', 'params', 'status']);
    assert.equal(c.message, renderMessage(t, c.messageKey, c.params));
  }
  assert.deepEqual(report.counts, { ok: report.checks.length - 1, warn: 1, fail: 0 });
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
  // connectors says one line per connector source listed, two here.
  assert.match(out, new RegExp(`${CHECK_IDS.length} ok, 1 warn, 0 fail`));
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

// --- the scheduled curator (phase 2) -----------------------------------------

const CURATOR_IDS = ['claude-real', 'claude-isolation-flags', 'include-projects', 'watermark', 'last-run', 'schedule', 'notify'];

// A fixture whose claude stand-in is replaced by `script`.
function withClaude(fx, script) {
  writeScript(join(fx.toolsDir, 'claude'), script);
  return fx;
}

function editJson(file, edit) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  edit(value);
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function configWith(edit) {
  const config = baseConfig();
  edit(config);
  return config;
}

test('curator: roundFlags is every option buildArgv puts on a round, the isolation flags, --disable-slash-commands and --tools among them', () => {
  assert.deepEqual(roundFlags(), [
    '-p', '--verbose', '--output-format', '--permission-mode', '--permission-prompts', '--setting-sources', '--strict-mcp-config',
    '--disable-slash-commands', '--tools',
    '--no-session-persistence', '--model', '--max-turns', '--max-budget-usd', '--allowedTools', '--disallowedTools',
    // connector mode (phase 3) adds one: the JSON after it is a value.
    '--settings',
  ]);
});

test('curator: with curate.enabled false every curator check says so and passes, and an installed timer is still named', async () => {
  const fx = setup({ config: configWith((c) => { c.curate.enabled = false; }), tools: { claude: 'absent' } });
  let r = await doctor(fx, ['--only', CURATOR_IDS.join(',')]);
  for (const id of CURATOR_IDS) assertCheck(r.report, id, 'ok', 'doctor.curate.disabled');
  assert.equal(r.code, EXIT.OK);
  // Enabled long enough to install, then disabled again: the timer still
  // starts rounds, and doctor says so.
  const ready = setup();
  editJson(join(ready.root, 'brain-kit.config.json'), (c) => { c.curate.enabled = false; });
  r = await doctor(ready, ['--only', 'schedule']);
  const c = assertCheck(r.report, 'schedule', 'warn', 'doctor.schedule.disabled_installed');
  assert.equal(c.params.command, 'brain-kit schedule uninstall');
});

test('curator: a configuration doctor cannot read leaves every curator check unable to ask, a warning each', async () => {
  const fx = setup({ configText: '{ not json' });
  const { report } = await doctor(fx, ['--only', CURATOR_IDS.join(',')]);
  for (const id of CURATOR_IDS) assertCheck(report, id, 'warn', 'doctor.curate.config_unknown');
});

// --- claude-real -------------------------------------------------------------

test('claude-real: passes for a CLI above the stub size that answers its version', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'claude-real']);
  const c = assertCheck(report, 'claude-real', 'ok', 'doctor.claude_real.ok');
  assert.equal(c.params.version, '1.2.3');
  assert.equal(c.params.bin, join(fx.toolsDir, 'claude'));
});

test('claude-real: a launcher under 2 KB is the 14/09/2026 stub, and fails even when it answers a version', async () => {
  const fx = withClaude(setup(), claudeScript({ pad: 0 }));
  const { report, code } = await doctor(fx, ['--only', 'claude-real']);
  const c = assertCheck(report, 'claude-real', 'fail', 'doctor.claude_real.stub');
  assert.ok(c.params.bytes < 2048, JSON.stringify(c.params));
  assert.equal(code, EXIT.FAILURE);
});

test('claude-real: a CLI whose --version prints error text, or fails, is not usable', async () => {
  let fx = withClaude(setup(), claudeScript({ version: 'echo "Error: native binary not installed"' }));
  let r = await doctor(fx, ['--only', 'claude-real']);
  const c = assertCheck(r.report, 'claude-real', 'fail', 'doctor.claude_real.version');
  assert.match(c.params.output, /native binary not installed/);
  fx = withClaude(setup(), claudeScript({ version: 'echo "1.2.3 (Claude Code)"; exit 1' }));
  r = await doctor(fx, ['--only', 'claude-real']);
  assertCheck(r.report, 'claude-real', 'fail', 'doctor.claude_real.version');
});

test('claude-real: no claude to run fails and names the machine set command', async () => {
  const fx = setup({ tools: { claude: 'absent' } });
  const { report } = await doctor(fx, ['--only', 'claude-real']);
  const c = assertCheck(report, 'claude-real', 'fail', 'doctor.claude_real.not_found');
  assert.equal(c.params.command, 'brain-kit machine set claude_bin <path>');
});

test('claude-real and claude-isolation-flags never execute claude_bin from a machine file others can write, or the kit would refuse', async () => {
  for (const options of [{ fileMode: 0o666 }, { machine: { vault_id: 'Not Valid' } }]) {
    const fx = setup({ tools: { claude: 'absent' }, ...options });
    const mark = join(fx.base, 'claude-was-run');
    writeScript(join(fx.toolsDir, 'claude'), claudeScript({ before: `: > "${mark}"\n` }));
    const { report } = await doctor(fx, ['--only', 'claude-real,claude-isolation-flags']);
    for (const id of ['claude-real', 'claude-isolation-flags']) assert.equal(check(report, id).status, 'warn', JSON.stringify(check(report, id)));
    assert.equal(existsSync(mark), false, JSON.stringify(options));
  }
});

// --- claude-isolation-flags --------------------------------------------------

test('claude-isolation-flags: a CLI whose --help lacks one flag a round passes fails, naming it and the update command', async () => {
  const fx = withClaude(setup(), claudeScript({ help: roundFlags().filter((f) => f !== '--setting-sources') }));
  const { report, code } = await doctor(fx, ['--only', 'claude-isolation-flags']);
  const c = assertCheck(report, 'claude-isolation-flags', 'fail', 'doctor.claude_isolation_flags.missing');
  assert.deepEqual(c.params.missing, ['--setting-sources']);
  assert.equal(c.params.command, 'claude update');
  assert.equal(code, EXIT.FAILURE);
});

test('claude-isolation-flags: a longer flag that starts like one a round passes does not count as it', async () => {
  const help = [...roundFlags().filter((f) => f !== '--setting-sources' && f !== '-p'), '--setting-sources-extra', '-print'];
  const fx = withClaude(setup(), claudeScript({ help }));
  const { report } = await doctor(fx, ['--only', 'claude-isolation-flags']);
  const c = assertCheck(report, 'claude-isolation-flags', 'fail', 'doctor.claude_isolation_flags.missing');
  assert.deepEqual(c.params.missing, ['-p', '--setting-sources']);
});

test('claude-isolation-flags: a flag glued to other text is not listed', async () => {
  const help = [...roundFlags().filter((f) => f !== '-p'), '(implies-p)'];
  const fx = withClaude(setup(), claudeScript({ help }));
  const { report } = await doctor(fx, ['--only', 'claude-isolation-flags']);
  const c = assertCheck(report, 'claude-isolation-flags', 'fail', 'doctor.claude_isolation_flags.missing');
  assert.deepEqual(c.params.missing, ['-p']);
});

test('claude-isolation-flags: flags written the way the CLI prints them, short form first or with a value, are found', async () => {
  const lines = ['-p, --print', '--allowedTools, --allowed-tools <tools...>', '--model=<model>', ...roundFlags().filter((f) => !['-p', '--allowedTools', '--model'].includes(f))];
  const fx = withClaude(setup(), claudeScript({ help: lines }));
  const { report } = await doctor(fx, ['--only', 'claude-isolation-flags']);
  const c = assertCheck(report, 'claude-isolation-flags', 'ok', 'doctor.claude_isolation_flags.ok');
  assert.equal(c.params.count, roundFlags().length - 1);
});

test('claude-isolation-flags: --max-turns, hidden from the help of 2.1.281 and measured to work, is not required; --setting-sources is', async () => {
  let fx = withClaude(setup(), claudeScript({ help: roundFlags().filter((f) => f !== '--max-turns') }));
  let r = await doctor(fx, ['--only', 'claude-isolation-flags']);
  const c = assertCheck(r.report, 'claude-isolation-flags', 'ok', 'doctor.claude_isolation_flags.ok');
  assert.deepEqual(c.params.hidden, ['--max-turns']);
  assert.match(c.message, /--max-turns/);
  fx = withClaude(setup(), claudeScript({ help: roundFlags().filter((f) => f !== '--max-turns' && f !== '--setting-sources') }));
  r = await doctor(fx, ['--only', 'claude-isolation-flags']);
  const failed = assertCheck(r.report, 'claude-isolation-flags', 'fail', 'doctor.claude_isolation_flags.missing');
  assert.deepEqual(failed.params.missing, ['--setting-sources']);
});

test('claude-isolation-flags: a CLI whose --help lacks --disable-slash-commands or --tools fails naming it; --max-turns stays exempt', async () => {
  for (const flag of ['--disable-slash-commands', '--tools']) {
    const fx = withClaude(setup(), claudeScript({ help: roundFlags().filter((f) => f !== flag && f !== '--max-turns') }));
    const { report, code } = await doctor(fx, ['--only', 'claude-isolation-flags']);
    const c = assertCheck(report, 'claude-isolation-flags', 'fail', 'doctor.claude_isolation_flags.missing');
    assert.deepEqual(c.params.missing, [flag]);
    assert.equal(code, EXIT.FAILURE);
  }
  // --allowed-tools, printed by the CLI beside --allowedTools, is not --tools.
  const help = [...roundFlags().filter((f) => f !== '--tools'), '--allowed-tools', '--disallowed-tools'];
  const fx = withClaude(setup(), claudeScript({ help }));
  const { report } = await doctor(fx, ['--only', 'claude-isolation-flags']);
  assert.deepEqual(assertCheck(report, 'claude-isolation-flags', 'fail', 'doctor.claude_isolation_flags.missing').params.missing, ['--tools']);
});

test('claude-isolation-flags: a --help that fails, or exits 0 printing nothing, is never ok', async () => {
  let fx = withClaude(setup(), claudeScript({ helpExit: 2 }));
  let r = await doctor(fx, ['--only', 'claude-isolation-flags']);
  assertCheck(r.report, 'claude-isolation-flags', 'fail', 'doctor.claude_isolation_flags.failed');
  fx = withClaude(setup(), claudeScript({ help: [], before: 'if [ "$1" = --help ]; then exit 0; fi\n' }));
  r = await doctor(fx, ['--only', 'claude-isolation-flags']);
  const c = assertCheck(r.report, 'claude-isolation-flags', 'fail', 'doctor.claude_isolation_flags.missing');
  assert.deepEqual(c.params.missing, roundFlags().filter((f) => f !== '--max-turns'));
});

// --- include-projects --------------------------------------------------------

test('include-projects: passes when every listed project is under the default transcripts directory', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'include-projects']);
  const c = assertCheck(report, 'include-projects', 'ok', 'doctor.include_projects.ok');
  assert.equal(c.params.root, join(fx.home, '.claude', 'projects'));
  assert.equal(c.params.count, 1);
});

test('include-projects: an empty list fails, since a round then reads nothing and refuses', async () => {
  const fx = setup({ config: configWith((c) => { c.sources.transcripts.include_projects = []; }) });
  const { report, code } = await doctor(fx, ['--only', 'include-projects']);
  const c = assertCheck(report, 'include-projects', 'fail', 'doctor.include_projects.empty');
  assert.equal(c.params.key, 'sources.transcripts.include_projects');
  assert.equal(code, EXIT.FAILURE);
});

test('include-projects: a transcripts directory that does not exist fails and names machine set transcripts_dir', async () => {
  const fx = setup({ machine: { transcripts_dir: '~/nowhere' } });
  const { report } = await doctor(fx, ['--only', 'include-projects']);
  const c = assertCheck(report, 'include-projects', 'fail', 'doctor.include_projects.root_missing');
  assert.equal(c.params.root, join(fx.home, 'nowhere'));
  assert.equal(c.params.command, 'brain-kit machine set transcripts_dir <dir>');
});

test('include-projects: transcripts_dir with ~ is read from HOME', async () => {
  const fx = setup({ machine: { transcripts_dir: '~/sessions' } });
  mkdirSync(join(fx.home, 'sessions', '-home-ana-brain'), { recursive: true });
  const { report } = await doctor(fx, ['--only', 'include-projects']);
  const c = assertCheck(report, 'include-projects', 'ok', 'doctor.include_projects.ok');
  assert.equal(c.params.root, join(fx.home, 'sessions'));
});

test('include-projects: every listed project missing fails; some missing warns, naming only those', async () => {
  let fx = setup({ config: configWith((c) => { c.sources.transcripts.include_projects = ['-home-ana-other']; }) });
  let r = await doctor(fx, ['--only', 'include-projects']);
  assertCheck(r.report, 'include-projects', 'fail', 'doctor.include_projects.all_missing');
  fx = setup({ config: configWith((c) => { c.sources.transcripts.include_projects = ['-home-ana-brain', '-home-ana-other']; }) });
  r = await doctor(fx, ['--only', 'include-projects']);
  const c = assertCheck(r.report, 'include-projects', 'warn', 'doctor.include_projects.some_missing');
  assert.deepEqual(c.params.projects, ['-home-ana-other']);
  assert.equal(r.code, EXIT.OK);
});

test('include-projects: a listed project that cannot be read fails, since the round exits 4 on it', { skip: process.getuid?.() === 0 ? 'root reads any directory' : false }, async () => {
  const fx = setup({ config: configWith((c) => { c.sources.transcripts.include_projects = ['-home-ana-brain', '-home-ana-locked']; }) });
  const locked = join(fx.home, '.claude', 'projects', '-home-ana-locked');
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const { report } = await doctor(fx, ['--only', 'include-projects']);
    const c = assertCheck(report, 'include-projects', 'fail', 'doctor.include_projects.unreadable');
    assert.deepEqual(c.params.projects, ['-home-ana-locked']);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test('include-projects: with transcripts in no curate source there is nothing to check', async () => {
  const fx = setup({
    config: configWith((c) => {
      c.curate.sources.required = [];
      c.curate.sources.best_effort = ['calendar'];
      c.sources.transcripts.include_projects = [];
    }),
  });
  const { report } = await doctor(fx, ['--only', 'include-projects']);
  assertCheck(report, 'include-projects', 'ok', 'doctor.include_projects.not_used');
});

// --- watermark ---------------------------------------------------------------

function markAt(fx, day) {
  writeFileSync(join(fx.stateDir, 'watermark.json'), JSON.stringify({ sources: { transcripts: day } }));
}

test('watermark: a mark at yesterday passes and shows the day as DD/MM/YYYY with 0 days behind', async () => {
  const fx = setup();
  const now = new Date('2026-09-24T15:00:00Z');
  markAt(fx, '2026-09-23');
  const { report } = await doctor(fx, ['--only', 'watermark'], { now });
  const c = assertCheck(report, 'watermark', 'ok', 'doctor.watermark.ok');
  assert.deepEqual(c.params.marks, ['transcripts 23/09/2026 (0)']);
});

test('watermark: three days behind still passes; four days behind warns and names curate', async () => {
  const fx = setup();
  const now = new Date('2026-09-24T15:00:00Z');
  markAt(fx, '2026-09-20');
  let r = await doctor(fx, ['--only', 'watermark'], { now });
  assertCheck(r.report, 'watermark', 'ok', 'doctor.watermark.ok');
  markAt(fx, '2026-09-19');
  r = await doctor(fx, ['--only', 'watermark'], { now });
  const c = assertCheck(r.report, 'watermark', 'warn', 'doctor.watermark.behind');
  assert.deepEqual(c.params.sources, ['transcripts']);
  assert.deepEqual(c.params.marks, ['transcripts 19/09/2026 (4)']);
  assert.equal(c.params.command, 'brain-kit curate');
});

test('watermark: yesterday is counted in the vault time zone, not in UTC', async () => {
  const fx = setup({ config: configWith((c) => { c.vault.timezone = 'America/Argentina/Buenos_Aires'; }) });
  // 02:00 UTC on 24/09 is still 23/09 at UTC-3, so yesterday there is 22/09.
  const now = new Date('2026-09-24T02:00:00Z');
  markAt(fx, '2026-09-22');
  const { report } = await doctor(fx, ['--only', 'watermark'], { now });
  const c = assertCheck(report, 'watermark', 'ok', 'doctor.watermark.ok');
  assert.deepEqual(c.params.marks, ['transcripts 22/09/2026 (0)']);
});

test('watermark: a mark on a day that has not ended fails and names the reopen command', async () => {
  const fx = setup();
  const now = new Date('2026-09-24T15:00:00Z');
  markAt(fx, '2026-09-24');
  const { report, code } = await doctor(fx, ['--only', 'watermark'], { now });
  const c = assertCheck(report, 'watermark', 'fail', 'doctor.watermark.future');
  assert.equal(c.params.command, 'brain-kit watermark reopen transcripts 2026-09-23');
  assert.equal(code, EXIT.FAILURE);
});

test('watermark: no mark yet warns; a mark file that cannot be read fails', async () => {
  const fx = setup();
  rmSync(join(fx.stateDir, 'watermark.json'));
  let r = await doctor(fx, ['--only', 'watermark']);
  const c = assertCheck(r.report, 'watermark', 'warn', 'doctor.watermark.unset');
  assert.deepEqual(c.params.sources, ['transcripts']);
  writeFileSync(join(fx.stateDir, 'watermark.json'), '{ nope');
  r = await doctor(fx, ['--only', 'watermark']);
  assertCheck(r.report, 'watermark', 'fail', 'doctor.watermark.unreadable');
});

test('watermark: a source the mark holds but the configuration no longer requires is still reported', async () => {
  const fx = setup();
  const now = new Date('2026-09-24T15:00:00Z');
  writeFileSync(join(fx.stateDir, 'watermark.json'), JSON.stringify({ sources: { transcripts: '2026-09-23', calendar: '2026-09-10' } }));
  const { report } = await doctor(fx, ['--only', 'watermark'], { now });
  const c = assertCheck(report, 'watermark', 'warn', 'doctor.watermark.behind');
  assert.deepEqual(c.params.sources, ['calendar']);
});

// --- last-run ----------------------------------------------------------------

function writeLastRun(fx, value) {
  writeFileSync(join(fx.stateDir, 'last-run.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

test('last-run: a round that ran the model passes, with its time as DD/MM/YYYY HH:MM, duration, turns and cost', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'last-run']);
  const c = assertCheck(report, 'last-run', 'ok', 'doctor.last_run.ok');
  assert.match(c.params.at, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  assert.equal(c.params.seconds, 120);
  assert.equal(c.params.turns, 12);
  assert.equal(c.params.cost, 0.42);
});

test('last-run: exit 0 in under 20 seconds with no model turn is the dead round of 21/08/2026, and fails', async () => {
  const fx = setup();
  for (const run of [
    lastRun({ durationMs: 6000, numTurns: 0, reasonCode: 'nothing_proposed' }),
    lastRun({ durationMs: 19999, numTurns: null, costUsd: null, reasonCode: 'proposed' }),
    lastRun({ durationMs: 6000, numTurns: 0, reasonCode: undefined }),
  ]) {
    writeLastRun(fx, run);
    const { report, code } = await doctor(fx, ['--only', 'last-run']);
    const c = assertCheck(report, 'last-run', 'fail', 'doctor.last_run.dead');
    assert.equal(c.params.command, 'brain-kit curate --keep-stream');
    assert.equal(code, EXIT.FAILURE);
  }
});

test('last-run: at 20 seconds, with a model turn, or ended before the model on purpose, a fast round is not dead', async () => {
  const fx = setup();
  for (const run of [
    lastRun({ durationMs: 20000, numTurns: 0 }),
    lastRun({ durationMs: 6000, numTurns: 1 }),
    lastRun({ durationMs: 300, numTurns: null, reasonCode: 'up_to_date' }),
    lastRun({ durationMs: 900, numTurns: null, reasonCode: 'nothing_to_curate' }),
  ]) {
    writeLastRun(fx, run);
    const { report } = await doctor(fx, ['--only', 'last-run']);
    assertCheck(report, 'last-run', 'ok', 'doctor.last_run.ok');
  }
});

test('last-run: a postponed, degraded or unavailable round warns; any other non-zero exit fails, with its reason', async () => {
  const fx = setup();
  for (const exit of [EXIT.DEGRADED, EXIT.UNAVAILABLE, EXIT.TEMPFAIL]) {
    writeLastRun(fx, lastRun({ exit, reason: 'the reason' }));
    const { report } = await doctor(fx, ['--only', 'last-run']);
    const c = assertCheck(report, 'last-run', 'warn', 'doctor.last_run.soft');
    assert.equal(c.params.exit, exit);
  }
  for (const exit of [EXIT.FAILURE, EXIT.USAGE, EXIT.SOURCE_UNREAD]) {
    writeLastRun(fx, lastRun({ exit, reason: 'transcripts (0/1) was not read.' }));
    const { report, code } = await doctor(fx, ['--only', 'last-run']);
    const c = assertCheck(report, 'last-run', 'fail', 'doctor.last_run.failed');
    assert.equal(c.params.reason, 'transcripts (0/1) was not read.');
    assert.equal(c.params.logs, join(fx.stateDir, 'logs'));
    assert.equal(code, EXIT.FAILURE);
  }
});

test('last-run: no record yet warns and names curate; a record that cannot be read, or holds no exit, fails', async () => {
  const fx = setup();
  rmSync(join(fx.stateDir, 'last-run.json'));
  let r = await doctor(fx, ['--only', 'last-run']);
  const c = assertCheck(r.report, 'last-run', 'warn', 'doctor.last_run.none');
  assert.equal(c.params.command, 'brain-kit curate');
  writeLastRun(fx, '{ nope');
  r = await doctor(fx, ['--only', 'last-run']);
  assertCheck(r.report, 'last-run', 'fail', 'doctor.last_run.unreadable');
  writeLastRun(fx, { at: new Date().toISOString(), exit: '0' });
  r = await doctor(fx, ['--only', 'last-run']);
  assertCheck(r.report, 'last-run', 'fail', 'doctor.last_run.no_exit');
});

// --- schedule ----------------------------------------------------------------

function unitDir(fx) {
  return join(fx.home, '.config', 'systemd', 'user');
}

test('schedule: an installed, current and enabled timer passes with its next three fire times', async () => {
  const fx = setup();
  const now = new Date(2026, 8, 24, 15, 0);
  const { report } = await doctor(fx, ['--only', 'schedule'], { now });
  const c = assertCheck(report, 'schedule', 'ok', 'doctor.schedule.ok');
  assert.equal(c.params.platform, 'systemd');
  assert.equal(c.params.name, 'brain-kit-curate-ana-brain');
  assert.deepEqual(c.params.times, ['24/09/2026 20:00', '25/09/2026 09:30', '25/09/2026 14:00']);
});

test('schedule: nothing installed warns and names schedule install', async () => {
  const fx = setup();
  rmSync(unitDir(fx), { recursive: true });
  const { report, code } = await doctor(fx, ['--only', 'schedule']);
  const c = assertCheck(report, 'schedule', 'warn', 'doctor.schedule.not_installed');
  assert.equal(c.params.command, 'brain-kit schedule install');
  assert.equal(code, EXIT.OK);
});

test('schedule: installed but not active fails, since no round starts', async () => {
  const fx = setup({ tools: { systemctl: 'inactive' } });
  const { report, code } = await doctor(fx, ['--only', 'schedule']);
  const c = assertCheck(report, 'schedule', 'fail', 'doctor.schedule.inactive');
  assert.match(c.params.detail, /inactive/);
  assert.equal(code, EXIT.FAILURE);
});

test('schedule: a timer that differs from what install would write now warns', async () => {
  const fx = setup();
  const timer = join(unitDir(fx), 'brain-kit-curate-ana-brain.timer');
  writeFileSync(timer, readFileSync(timer, 'utf8').replace('OnCalendar=*-*-* 14:00:00', 'OnCalendar=*-*-* 15:00:00'));
  const { report } = await doctor(fx, ['--only', 'schedule']);
  assertCheck(report, 'schedule', 'warn', 'doctor.schedule.outdated');
});

test('schedule: when status itself refuses, the check fails with status\'s own message', async () => {
  const fx = setup({ tools: { claude: 'absent' } });
  const { report } = await doctor(fx, ['--only', 'schedule']);
  const c = assertCheck(report, 'schedule', 'fail', 'schedule.claude_not_found');
  assert.equal(c.params.bin, 'claude');
});

// --- notify ------------------------------------------------------------------

test('notify: a notify_command that resolves passes, and doctor never runs it', async () => {
  const fx = setup();
  const mark = join(fx.base, 'notified');
  writeScript(join(fx.toolsDir, 'notify'), `: > "${mark}"`);
  const { report } = await doctor(fx, ['--only', 'notify']);
  const c = assertCheck(report, 'notify', 'ok', 'doctor.notify.ok');
  assert.equal(c.params.program, join(fx.toolsDir, 'notify'));
  assert.equal(existsSync(mark), false);
});

test('notify: none configured warns that failures are only in the log; one that does not resolve warns too', async () => {
  let fx = setup({ machine: { notify_command: undefined } });
  let r = await doctor(fx, ['--only', 'notify']);
  let c = assertCheck(r.report, 'notify', 'warn', 'doctor.notify.unset');
  assert.equal(c.params.logs, join(fx.stateDir, 'logs'));
  assert.match(c.params.command, /^brain-kit machine set notify_command /);
  fx = setup({ machine: { notify_command: [] } });
  r = await doctor(fx, ['--only', 'notify']);
  assertCheck(r.report, 'notify', 'warn', 'doctor.notify.unset');
  fx = setup({ machine: { notify_command: ['no-such-notifier', 'x'] } });
  r = await doctor(fx, ['--only', 'notify']);
  c = assertCheck(r.report, 'notify', 'warn', 'doctor.notify.not_found');
  assert.equal(c.params.program, 'no-such-notifier');
});

// --- phase 3: privacy-keywords, round-scope, connectors and --probe ----------

const CAL_PREFIX = 'mcp__claude_ai_Google_Calendar__';
const DRIVE_PREFIX = 'mcp__claude_ai_Google_Drive__';
const CAL_TOOLS = ['list_events', 'get_event', 'list_calendars'].map((tool) => CAL_PREFIX + tool);
const DRIVE_TOOLS = ['search_files', 'read_file_content', 'get_file_metadata'].map((tool) => DRIVE_PREFIX + tool);
const CAL_SERVER = 'claude.ai Google Calendar';
const DRIVE_SERVER = 'claude.ai Google Drive';
const REAL_CAT = findOnPath('cat');
const REAL_SLEEP = findOnPath('sleep');

// Both connector sources on, as a person turns them on (docs/connectors.md):
// the calendar with the owner's main calendar, the meeting notes with the en
// pack's literal and the three tools the source needs.
function connectorConfig(edit = () => {}) {
  return configWith((c) => {
    c.sources.calendar.enabled = true;
    c.sources.calendar.calendars = ['primary'];
    c.sources.calendar.tool_suffixes = ['list_events', 'get_event', 'list_calendars'];
    c.sources.meeting_notes.enabled = true;
    c.sources.meeting_notes.search_title_contains = 'Notes by Gemini';
    c.sources.meeting_notes.tool_suffixes = ['search_files', 'read_file_content', 'get_file_metadata'];
    edit(c);
  });
}

// A scratch CLAUDE_CONFIG_DIR holding the user settings a round in
// connector mode would load; never the machine's own.
function userSettings(fx, settings) {
  const dir = join(fx.base, 'claude-config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  return { ...fx.env, CLAUDE_CONFIG_DIR: dir };
}

// A last round with these fields laid over a healthy one.
function writeRoundWith(fx, fields) {
  writeLastRun(fx, lastRun(fields));
}

function connectorLines(report) {
  return report.checks.filter((c) => c.id === 'connectors');
}

function byKey(report, messageKey) {
  const found = connectorLines(report).filter((c) => c.messageKey === messageKey);
  assert.equal(found.length, 1, `${messageKey}: ${JSON.stringify(connectorLines(report))}`);
  return found[0];
}

function lineFor(report, source, messageKey) {
  const found = connectorLines(report).filter((c) => c.params.source === source && (messageKey === undefined || c.messageKey === messageKey));
  assert.equal(found.length, 1, `${source} ${messageKey}: ${JSON.stringify(connectorLines(report))}`);
  return found[0];
}

test('privacy-keywords: the fixture\'s list passes, naming how many keywords lint refuses on added lines', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'privacy-keywords']);
  const c = assertCheck(report, 'privacy-keywords', 'ok', 'doctor.privacy_keywords.ok');
  assert.deepEqual(c.params, { count: PACK_KEYWORDS.length, setting: 'privacy.third_party_keywords' });
});

test('privacy-keywords: no list, an empty one, or only blank entries warns and names the list the vault\'s language pack ships', async () => {
  for (const keywords of [undefined, [], ['   ', '']]) {
    const config = configWith((c) => {
      if (keywords === undefined) delete c.privacy.third_party_keywords;
      else c.privacy.third_party_keywords = keywords;
    });
    const fx = setup({ config });
    const { report, code } = await doctor(fx, ['--only', 'privacy-keywords']);
    const c = assertCheck(report, 'privacy-keywords', 'warn', 'doctor.privacy_keywords.none');
    assert.deepEqual(c.params, { setting: 'privacy.third_party_keywords', file: 'brain-kit.config.json', defaults: join(KIT_ROOT, 'lang', 'en', 'config.defaults.json') });
    assert.equal(code, EXIT.OK, 'a warning, never a failure');
  }
  const pt = setup({ config: configWith((c) => { c.lang = 'pt-BR'; c.privacy.third_party_keywords = []; }) });
  const c = check((await doctor(pt, ['--only', 'privacy-keywords'])).report, 'privacy-keywords');
  assert.equal(c.params.defaults, join(KIT_ROOT, 'lang', 'pt-BR', 'config.defaults.json'));
  const broken = setup({ configText: '{ not json' });
  assertCheck((await doctor(broken, ['--only', 'privacy-keywords'])).report, 'privacy-keywords', 'warn', 'doctor.curate.config_unknown');
});

test('round-scope: with nothing added, a round reaches nothing beyond the vault and its plan', async () => {
  const fx = setup();
  const { report } = await doctor(fx, ['--only', 'round-scope']);
  assertCheck(report, 'round-scope', 'ok', 'doctor.round_scope.ok');
});

test('round-scope: every allow rule the vault adds that reads or writes outside the vault, or runs a command, is named', async () => {
  const fx = setup();
  const inside = ['Read(./**)', 'Read(notes/**)', 'Glob(**)', 'Grep(*.md)', 'Edit(./drafts/**)', `Read(//${fx.root.slice(1)}/notes/**)`, 'ToolSearch', 'WebSearch', 'WebFetch(//example.com/**)'];
  const beyond = ['Read(//**)', 'Read(~/notes/**)', 'Grep(/etc/**)', 'Read(../other/**)', 'Read(notes/*/../../../etc/**)', 'Glob({a,b}/**)', 'Edit(//tmp/elsewhere/**)', 'Write(~/x.md)', 'Bash(cat:*)', `Read(//${fx.root.slice(1)}*)`];
  editJson(join(fx.root, 'brain-kit.config.json'), (c) => {
    c.curate.allowed_tools_extra = [...inside, ...beyond.slice(0, -2), `${beyond.at(-2)} ${beyond.at(-1)}`];
  });
  const { report, code } = await doctor(fx, ['--only', 'round-scope']);
  const c = assertCheck(report, 'round-scope', 'warn', 'doctor.round_scope.extra');
  assert.deepEqual(c.params, { setting: 'curate.allowed_tools_extra', file: 'brain-kit.config.json', rules: beyond });
  assert.equal(code, EXIT.OK);
});

test('round-scope: in connector mode a user read rule the round records instead of denying is named, with the settings file', async () => {
  const fx = setup({ config: connectorConfig() });
  const env = userSettings(fx, { permissions: { allow: ['Read(//etc/**)', 'Bash(rtk curl *)'] } });
  let { report } = await doctor(fx, ['--only', 'round-scope'], { env });
  const c = assertCheck(report, 'round-scope', 'warn', 'doctor.round_scope.user_reads');
  assert.deepEqual(c.params, { rules: ['Read(//etc/**)'], files: [join(env.CLAUDE_CONFIG_DIR, 'settings.json')] });
  // Connector mode refused (a bare Bash): the round runs isolated, and the
  // read rule reaches nothing.
  const refused = userSettings(fx, { permissions: { allow: ['Read(//etc/**)', 'Bash'] } });
  ({ report } = await doctor(fx, ['--only', 'round-scope'], { env: refused }));
  assertCheck(report, 'round-scope', 'ok', 'doctor.round_scope.ok');
  // No connector source on: the user settings are never read.
  const off = setup();
  ({ report } = await doctor(off, ['--only', 'round-scope'], { env: userSettings(off, { permissions: { allow: ['Read(//etc/**)'] } }) }));
  assertCheck(report, 'round-scope', 'ok', 'doctor.round_scope.ok');
});

test('connectors: no connector source listed in curate.sources is one ok line', async () => {
  const fx = setup({ config: configWith((c) => { c.curate.sources.best_effort = []; }) });
  const { report } = await doctor(fx, ['--only', 'connectors']);
  assert.equal(connectorLines(report).length, 1);
  assertCheck(report, 'connectors', 'ok', 'doctor.connectors.none');
});

test('connectors: a source off on purpose passes; one half configured warns naming its problems and the setting; a required one that is off fails', async () => {
  let fx = setup();
  let r = await doctor(fx, ['--only', 'connectors']);
  assert.deepEqual(connectorLines(r.report).map((c) => [c.params.source, c.status, c.messageKey]), [
    ['calendar', 'ok', 'doctor.connectors.off'], ['meeting_notes', 'ok', 'doctor.connectors.off'],
  ]);
  // The fixture's own calendar: a calendar listed, no `enabled` (a vault
  // made before phase 3).
  fx = setup({ config: configWith((c) => { delete c.sources.calendar.enabled; }) });
  r = await doctor(fx, ['--only', 'connectors']);
  const half = lineFor(r.report, 'calendar', 'doctor.connectors.half');
  assert.equal(half.status, 'warn');
  assert.deepEqual(half.params, { source: 'calendar', problems: 'not_enabled (1)', setting: 'sources.calendar' });
  assert.equal(r.code, EXIT.OK);
  fx = setup({ config: configWith((c) => { c.curate.sources.required = ['transcripts', 'calendar']; }) });
  r = await doctor(fx, ['--only', 'connectors']);
  const required = lineFor(r.report, 'calendar', 'doctor.connectors.required_off');
  assert.equal(required.status, 'fail');
  assert.equal(required.params.problems, 'not_enabled (1)');
  assert.equal(r.code, EXIT.FAILURE);
});

test('connectors: a source on that no round has seen yet warns and names --probe', async () => {
  const fx = setup({ config: connectorConfig() });
  const { report } = await doctor(fx, ['--only', 'connectors']);
  for (const source of ['calendar', 'meeting_notes']) {
    const c = lineFor(report, source, 'doctor.connectors.unseen');
    assert.equal(c.status, 'warn');
    assert.equal(c.params.file, join(fx.stateDir, 'last-run.json'));
    assert.match(c.message, /doctor --probe/);
  }
});

test('connectors: the last round\'s state per source, with the round\'s day as DD/MM/YYYY in the vault\'s zone', async () => {
  const fx = setup({ config: connectorConfig((c) => { c.vault.timezone = 'America/Argentina/Buenos_Aires'; }) });
  const at = '2026-09-24T02:30:00.000Z';
  writeRoundWith(fx, { at, connectorStates: { calendar: { state: 'connected', at }, meeting_notes: { state: 'needs_auth', at } } });
  const { report, code } = await doctor(fx, ['--only', 'connectors']);
  const calendar = lineFor(report, 'calendar', 'doctor.connectors.connected');
  assert.equal(calendar.status, 'ok');
  assert.equal(calendar.message, `calendar: ${CAL_SERVER} connected in the round of 23/09/2026, with the tools the source needs under ${CAL_PREFIX}`);
  const notes = lineFor(report, 'meeting_notes', 'doctor.connectors.state');
  assert.equal(notes.status, 'warn');
  assert.equal(notes.params.state, 'needs_auth');
  assert.match(notes.message, /^meeting_notes: needs_auth in the round of 23\/09\/2026\. claude\.ai Google Drive needs authentication/);
  assert.match(notes.message, /docs\/connectors\.md/);
  assert.equal(code, EXIT.OK, 'a best-effort source that is not connected is a warning');
});

test('connectors: a state other than connected fails only for a source in curate.sources.required', async () => {
  const fx = setup({ config: connectorConfig((c) => { c.curate.sources.required = ['transcripts', 'meeting_notes']; }) });
  const at = new Date().toISOString();
  writeRoundWith(fx, { at, connectorStates: { calendar: { state: 'absent', at }, meeting_notes: { state: 'failed', at } } });
  const { report, code } = await doctor(fx, ['--only', 'connectors']);
  assert.equal(lineFor(report, 'calendar').status, 'warn');
  assert.match(lineFor(report, 'calendar').message, /disabled for Claude Code/);
  assert.equal(lineFor(report, 'meeting_notes').status, 'fail');
  assert.equal(code, EXIT.FAILURE);
});

test('connectors: tools seen under another prefix name both prefixes and the setting; a prefix from an older round is not taken for this state', async () => {
  const fx = setup({ config: connectorConfig() });
  const at = new Date().toISOString();
  writeRoundWith(fx, {
    at,
    connectorStates: { calendar: { state: 'tools_missing', at }, meeting_notes: { state: 'tools_missing', at: '2026-09-20T12:00:00.000Z' } },
    sources: { calendar: { state: 'tools_missing', observedPrefix: 'mcp__claude_ai_Calendar__' }, meeting_notes: { state: 'pending', observedPrefix: 'mcp__other__' } },
  });
  const { report } = await doctor(fx, ['--only', 'connectors']);
  const calendar = lineFor(report, 'calendar', 'doctor.connectors.prefix');
  assert.equal(calendar.status, 'warn');
  assert.deepEqual({ observed: calendar.params.observed, prefix: calendar.params.prefix, setting: calendar.params.setting }, { observed: 'mcp__claude_ai_Calendar__', prefix: CAL_PREFIX, setting: 'sources.calendar.tool_prefix' });
  assert.match(calendar.message, /set sources\.calendar\.tool_prefix to that prefix/);
  const notes = lineFor(report, 'meeting_notes', 'doctor.connectors.state');
  assert.equal(notes.params.state, 'tools_missing');
  assert.match(notes.message, /20\/09\/2026/);
});

test('connectors: a carried blocked_by_user_rules, and a state this version does not know, are said as such', async () => {
  const fx = setup({ config: connectorConfig() });
  const at = new Date().toISOString();
  writeRoundWith(fx, { at, connectorStates: { calendar: { state: 'blocked_by_user_rules', at }, meeting_notes: { state: 'sleeping', at } } });
  const { report } = await doctor(fx, ['--only', 'connectors']);
  assert.match(lineFor(report, 'calendar').message, /refused connector mode in that round/);
  assert.match(lineFor(report, 'meeting_notes').message, /does not know that state/);
  assert.equal(lineFor(report, 'meeting_notes').status, 'warn');
});

test('connectors: a user rule that refuses connector mode is named with its file, once for every source, and no state is shown for them', async () => {
  const fx = setup({ config: connectorConfig() });
  const env = userSettings(fx, { permissions: { allow: ['Bash'] } });
  const at = new Date().toISOString();
  writeRoundWith(fx, { at, connectorStates: { calendar: { state: 'connected', at }, meeting_notes: { state: 'connected', at } } });
  let r = await doctor(fx, ['--only', 'connectors'], { env });
  const lines = connectorLines(r.report);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  const [blocked] = lines;
  assert.equal(blocked.messageKey, 'doctor.connectors.blocked');
  assert.equal(blocked.status, 'warn');
  assert.deepEqual(blocked.params.sources, ['calendar', 'meeting_notes']);
  assert.deepEqual(blocked.params.detail, { messageKey: 'curate.user_rules.covers_kit', params: { rule: 'Bash', file: join(env.CLAUDE_CONFIG_DIR, 'settings.json') } });
  assert.match(blocked.message, /refused for calendar, meeting_notes .*The rule Bash in .*settings\.json lets the model run every command/);
  assert.equal(r.code, EXIT.OK);
  const required = setup({ config: connectorConfig((c) => { c.curate.sources.required = ['transcripts', 'calendar']; }) });
  r = await doctor(required, ['--only', 'connectors'], { env: userSettings(required, { permissions: { allow: ['Bash'] } }) });
  assertCheck(r.report, 'connectors', 'fail', 'doctor.connectors.blocked');
});

test('connectors: a user rule for a source\'s whole server is named for that source only', async () => {
  const fx = setup({ config: connectorConfig() });
  const env = userSettings(fx, { permissions: { allow: ['mcp__claude_ai_Google_Calendar'] } });
  const { report } = await doctor(fx, ['--only', 'connectors'], { env });
  const denied = lineFor(report, 'calendar', 'doctor.connectors.denied');
  assert.equal(denied.status, 'warn');
  assert.equal(denied.params.detail.messageKey, 'curate.user_rules.denies_source');
  assert.equal(denied.params.detail.params.rules, 'mcp__claude_ai_Google_Calendar');
  assert.match(denied.message, /^calendar is not read by any round \(blocked_by_user_rules\)\. The user allow rule mcp__claude_ai_Google_Calendar covers the tools of claude\.ai Google Calendar/);
  lineFor(report, 'meeting_notes', 'doctor.connectors.unseen');
});

test('connectors: other people\'s calendars without the recorded consent are named, with how many', async () => {
  const fx = setup({ config: connectorConfig((c) => { c.sources.calendar.team_calendars = ['team@example.com', 'ana@example.com']; }) });
  const { report } = await doctor(fx, ['--only', 'connectors']);
  const consent = lineFor(report, 'calendar', 'doctor.connectors.consent');
  assert.equal(consent.status, 'warn');
  assert.deepEqual(consent.params.detail, { messageKey: 'sources.calendar.other_calendars_without_consent', params: { count: '2' } });
  assert.match(consent.message, /team_calendars_consent_noted is true/);
  const consented = setup({ config: connectorConfig((c) => { c.sources.calendar.team_calendars = ['team@example.com']; c.sources.calendar.team_calendars_consent_noted = true; }) });
  assert.equal(connectorLines((await doctor(consented, ['--only', 'connectors'])).report).filter((c) => c.messageKey === 'doctor.connectors.consent').length, 0);
});

test('connectors: curate.enabled false passes; a configuration doctor cannot read warns', async () => {
  let fx = setup({ config: connectorConfig((c) => { c.curate.enabled = false; }) });
  const disabled = (await doctor(fx, ['--only', 'connectors,round-scope'])).report;
  assertCheck(disabled, 'connectors', 'ok', 'doctor.curate.disabled');
  assertCheck(disabled, 'round-scope', 'ok', 'doctor.curate.disabled');
  fx = setup({ configText: '{ not json' });
  const { report } = await doctor(fx, ['--only', 'connectors,round-scope']);
  assertCheck(report, 'connectors', 'warn', 'doctor.curate.config_unknown');
  assertCheck(report, 'round-scope', 'warn', 'doctor.curate.config_unknown');
});

test('connectors: the Portuguese pack renders every connector line with nothing left unfilled', async () => {
  const fx = setup({ config: connectorConfig((c) => { c.sources.calendar.team_calendars = ['team@example.com']; }) });
  const at = new Date().toISOString();
  writeRoundWith(fx, { at, connectorStates: { calendar: { state: 'connected', at }, meeting_notes: { state: 'needs_auth', at } } });
  const f = fakeIo();
  await runDoctor([fx.root, '--only', 'connectors'], f.io, createTranslator('pt-BR'), { env: fx.env, cwd: fx.root });
  assert.match(f.stdout(), /conectado na rodada de/);
  assert.match(f.stdout(), /needs_auth na rodada de/);
  assert.doesNotMatch(f.stdout(), /\{[a-z_]+\}|\[object Object\]/);
});

// --- --probe ------------------------------------------------------------------

// An init event as Claude Code 2.1.281 printed one in connector mode on
// 24/09/2026, reduced to the fields the kit reads, with neutral servers.
function initLine({ calendar = 'connected', drive = 'connected', tools = [...ROUND_TOOLS, ...CAL_TOOLS, ...DRIVE_TOOLS], extra = {} } = {}) {
  const servers = [{ name: 'plugin:example:tasks', status: 'connected' }];
  if (calendar !== null) servers.push({ name: CAL_SERVER, status: calendar });
  if (drive !== null) servers.push({ name: DRIVE_SERVER, status: drive });
  return JSON.stringify({ type: 'system', subtype: 'init', session_id: '00000000-0000-4000-8000-000000000000', permissionMode: 'dontAsk', tools, mcp_servers: servers, ...extra });
}

const HOOK_LINE = JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', session_id: '00000000-0000-4000-8000-000000000000' });

// A claude stand-in for the probe: a real CLI to claude-real and
// claude-isolation-flags, and, launched with -p, it records its pid, its
// arguments one per line, the two memory switches of its environment and
// its standard input, prints `lines`, then waits 60 s to be killed (or
// exits with `exitCode`).
function probeClaude(fx, { lines = [initLine()], exitCode = null } = {}) {
  const dir = join(fx.base, 'probe');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stream.jsonl'), lines.map((line) => `${line}\n`).join(''));
  const flags = roundFlags().map((flag) => `'  ${flag} <value>'`).join(' ');
  const body = [
    'case "$1" in',
    `  --help) printf '%s\\n' 'Usage: claude [options]' ${flags}; exit 0 ;;`,
    '  --version) echo "1.2.3 (Claude Code)"; exit 0 ;;',
    'esac',
    `echo $ > "${join(dir, 'pid')}"`,
    `for a in "$@"; do printf '%s\\n' "$a"; done > "${join(dir, 'argv')}"`,
    `printf '%s|%s\\n' "$CLAUDE_CODE_DISABLE_AUTO_MEMORY" "$CLAUDE_CODE_DISABLE_CLAUDE_MDS" > "${join(dir, 'env')}"`,
    `printf '%s\\n%s\\n' "$PATH" "$GIT_DIR" > "${join(dir, 'paths')}"`,
    `pwd -P > "${join(dir, 'cwd')}"`,
    `"${REAL_CAT}" > "${join(dir, 'stdin')}"`,
    `"${REAL_CAT}" "${join(dir, 'stream.jsonl')}"`,
    exitCode === null ? `exec "${REAL_SLEEP}" 60` : `exit ${exitCode}`,
  ].join('\n');
  writeScript(join(fx.toolsDir, 'claude'), `${body}\n# ${'x'.repeat(2400)}`);
  return {
    dir,
    launched: () => existsSync(join(dir, 'pid')),
    pid: () => Number(readFileSync(join(dir, 'pid'), 'utf8').trim()),
    argv: () => readFileSync(join(dir, 'argv'), 'utf8').split('\n').slice(0, -1),
    env: () => readFileSync(join(dir, 'env'), 'utf8').trim(),
    paths: () => readFileSync(join(dir, 'paths'), 'utf8').split('\n'),
    cwd: () => readFileSync(join(dir, 'cwd'), 'utf8').trim(),
    stdin: () => readFileSync(join(dir, 'stdin'), 'utf8'),
  };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stateSnapshot(fx) {
  return Object.fromEntries(readdirSync(fx.stateDir).sort().map((name) => {
    const path = join(fx.stateDir, name);
    return [name, statSync(path).isFile() ? readFileSync(path, 'utf8') : 'dir'];
  }));
}

// The values after each occurrence of a flag.
function valuesAfter(argv, flag) {
  const out = [];
  argv.forEach((arg, i) => {
    if (arg !== flag) return;
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  });
  return out;
}

test('--probe: launches the round\'s own connector mode, kills it at the init event, and reports each source\'s state from that event, writing nothing', async () => {
  const fx = setup({ config: connectorConfig() });
  const probe = probeClaude(fx, { lines: [initLine({ drive: 'needs-auth' }), JSON.stringify({ type: 'assistant', message: { content: [] } })] });
  const before = stateSnapshot(fx);
  const started = Date.now();
  const { report, code } = await doctor(fx, ['--only', 'connectors', '--probe'], { env: { ...fx.env, GIT_DIR: join(fx.base, 'elsewhere.git') } });
  assert.ok(Date.now() - started < 15000, 'killed at init, not waited out');
  assert.equal(isAlive(probe.pid()), false, 'the stand-in is dead once doctor returns');
  const calendar = lineFor(report, 'calendar', 'doctor.connectors.connected');
  assert.equal(calendar.params.when.messageKey, 'doctor.connectors.when_probe');
  assert.match(calendar.message, /connected now \(brain-kit doctor --probe\)/);
  const notes = lineFor(report, 'meeting_notes', 'doctor.connectors.state');
  assert.equal(notes.params.state, 'needs_auth');
  assert.equal(notes.status, 'warn');
  assert.equal(code, EXIT.OK);
  // The argv is connector mode's, bounded, with the round's lists.
  const argv = probe.argv();
  assert.deepEqual(argv.slice(0, 16), ['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--tools', ROUND_TOOLS.join(','), '--no-session-persistence']);
  assert.ok(!argv.includes('--strict-mcp-config'));
  assert.deepEqual(valuesAfter(argv, '--max-turns'), ['1']);
  assert.deepEqual(valuesAfter(argv, '--max-budget-usd'), ['0.1']);
  const allowed = valuesAfter(argv, '--allowedTools');
  for (const tool of [...CAL_TOOLS, ...DRIVE_TOOLS]) assert.ok(allowed.includes(tool), tool);
  const denied = valuesAfter(argv, '--disallowedTools');
  for (const tool of [`${CAL_PREFIX}create_event`, `${CAL_PREFIX}delete_event`, `${DRIVE_PREFIX}share_file`, `${DRIVE_PREFIX}download_file_content`]) assert.ok(denied.includes(tool), tool);
  assert.equal(argv.at(-1), '--');
  assert.equal(probe.env(), '1|1', 'the memory switches every round runs with');
  const [path, movedTo] = probe.paths();
  assert.ok(path.startsWith(`${fx.roundTools}:`), `machine.path_extra comes first, as for a round: ${path}`);
  assert.equal(movedTo, '', 'no variable that moves git elsewhere reaches the CLI');
  assert.equal(probe.cwd(), realpathSync(fx.root), 'launched in the vault, as a round is');
  assert.equal(probe.stdin(), t('doctor.connectors.probe_prompt'));
  assert.deepEqual(stateSnapshot(fx), before, 'no last-run.json, no log, no mark');
});

test('--probe: the tools of a connected server under another prefix name the prefix to set', async () => {
  const fx = setup({ config: connectorConfig() });
  probeClaude(fx, { lines: [initLine({ tools: [...ROUND_TOOLS, ...CAL_TOOLS.map((tool) => tool.replace(CAL_PREFIX, 'mcp__claude_ai_Calendar__')), ...DRIVE_TOOLS] })] });
  const { report } = await doctor(fx, ['--only', 'connectors', '--probe']);
  const c = lineFor(report, 'calendar', 'doctor.connectors.prefix');
  assert.equal(c.params.observed, 'mcp__claude_ai_Calendar__');
  assert.match(c.message, /now \(brain-kit doctor --probe\)/);
  lineFor(report, 'meeting_notes', 'doctor.connectors.connected');
});

test('--probe: a hook event before the init event, or a built-in tool beyond the pinned set, would stop every round in connector mode, and fails', async () => {
  let fx = setup({ config: connectorConfig() });
  const hooked = probeClaude(fx, { lines: [HOOK_LINE] });
  const started = Date.now();
  let r = await doctor(fx, ['--only', 'connectors', '--probe']);
  assert.ok(Date.now() - started < 15000, 'killed at the hook event, not waited out');
  assert.equal(isAlive(hooked.pid()), false);
  const hooks = byKey(r.report, 'doctor.connectors.probe_isolation');
  assert.equal(hooks.status, 'fail');
  assert.deepEqual(hooks.params.problems.map((p) => p.code), ['hooks']);
  assert.equal(byKey(r.report, 'doctor.connectors.probe_no_init').status, 'warn');
  assert.equal(r.code, EXIT.FAILURE);
  fx = setup({ config: connectorConfig() });
  probeClaude(fx, { lines: [initLine({ tools: [...ROUND_TOOLS, 'Task', ...CAL_TOOLS, ...DRIVE_TOOLS] })] });
  r = await doctor(fx, ['--only', 'connectors', '--probe']);
  const tools = byKey(r.report, 'doctor.connectors.probe_isolation');
  assert.deepEqual(tools.params.problems.map((p) => p.code), ['builtin_tools']);
  assert.match(tools.message, /Task/);
  lineFor(r.report, 'calendar', 'doctor.connectors.connected');
  assert.equal(r.code, EXIT.FAILURE);
});

test('--probe: a CLI that prints no init event, exits or hangs, is a warning (a failure for a required source), and the last round\'s states are still said', async () => {
  let fx = setup({ config: connectorConfig() });
  const at = new Date().toISOString();
  writeRoundWith(fx, { at, connectorStates: { calendar: { state: 'connected', at } } });
  probeClaude(fx, { lines: [], exitCode: 1 });
  let r = await doctor(fx, ['--only', 'connectors', '--probe']);
  const none = byKey(r.report, 'doctor.connectors.probe_no_init');
  assert.equal(none.status, 'warn');
  assert.equal(none.params.code, '1');
  assert.equal(none.params.bin, join(fx.toolsDir, 'claude'));
  lineFor(r.report, 'calendar', 'doctor.connectors.connected');
  lineFor(r.report, 'meeting_notes', 'doctor.connectors.unseen');
  assert.equal(r.code, EXIT.OK);
  fx = setup({ config: connectorConfig((c) => { c.curate.sources.required = ['transcripts', 'calendar']; }) });
  const hung = probeClaude(fx, { lines: [] });
  const started = Date.now();
  r = await doctor(fx, ['--only', 'connectors', '--probe'], { probeTimeoutMs: 800 });
  assert.ok(Date.now() - started < 15000);
  assert.equal(isAlive(hung.pid()), false);
  assert.equal(byKey(r.report, 'doctor.connectors.probe_no_init').status, 'fail');
});

test('--probe: nothing is launched when no connector source is on, or when a user rule refuses connector mode, as a round would launch nothing', async () => {
  let fx = setup();
  let probe = probeClaude(fx);
  let r = await doctor(fx, ['--only', 'connectors', '--probe']);
  assert.equal(probe.launched(), false);
  assert.equal(byKey(r.report, 'doctor.connectors.probe_nothing').status, 'ok');
  fx = setup({ config: connectorConfig() });
  probe = probeClaude(fx);
  r = await doctor(fx, ['--only', 'connectors', '--probe'], { env: userSettings(fx, { permissions: { allow: ['Edit(//**)'] } }) });
  assert.equal(probe.launched(), false);
  assert.equal(byKey(r.report, 'doctor.connectors.probe_blocked').status, 'ok');
  assert.equal(byKey(r.report, 'doctor.connectors.blocked').status, 'warn');
  assert.equal(byKey(r.report, 'doctor.connectors.blocked').params.detail.messageKey, 'curate.user_rules.covers_vault');
  fx = setup({ config: configWith((c) => { c.curate.sources.best_effort = []; }) });
  probe = probeClaude(fx);
  r = await doctor(fx, ['--only', 'connectors', '--probe']);
  assert.equal(probe.launched(), false);
  assert.deepEqual(connectorLines(r.report).map((c) => c.messageKey), ['doctor.connectors.none', 'doctor.connectors.probe_nothing']);
});

test('--probe: a claude doctor may not run is never launched, and says why', async () => {
  const fx = setup({ config: connectorConfig(), tools: { claude: 'absent' } });
  const { report, code } = await doctor(fx, ['--only', 'connectors', '--probe']);
  assertCheck(report, 'connectors', 'fail', 'doctor.claude_real.not_found');
  assert.equal(code, EXIT.FAILURE);
});

test('--probe with --only that leaves connectors out is a usage error, and nothing is launched', async () => {
  const fx = setup({ config: connectorConfig() });
  const probe = probeClaude(fx);
  const r = await doctor(fx, ['--only', 'node-version', '--probe']);
  assert.equal(r.code, EXIT.USAGE);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /--probe feeds the connectors check/);
  assert.equal(probe.launched(), false);
});

test('the real binary runs doctor --probe, and the usage names --probe', () => {
  const fx = setup({ config: connectorConfig() });
  probeClaude(fx);
  const r = spawnSync(process.execPath, [BIN, 'doctor', fx.root, '--only', 'connectors', '--probe', '--json'], { cwd: fx.base, encoding: 'utf8', env: fx.env, timeout: 30000 });
  assert.equal(r.status, EXIT.OK, r.stderr);
  const report = JSON.parse(r.stdout);
  lineFor(report, 'calendar', 'doctor.connectors.connected');
  lineFor(report, 'meeting_notes', 'doctor.connectors.connected');
  const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', env: { ...process.env, BRAIN_KIT_LANG: 'en' } });
  assert.match(help.stdout, /doctor \[dir\] \[--json\] \[--only <id,\.\.\.>\] \[--probe\]/);
});

test('renderMessage renders a message given as a parameter, and a list of them, in place', () => {
  const nested = { messageKey: 'doctor.connectors.when_round', params: { date: '24/09/2026' } };
  assert.equal(renderMessage(t, 'doctor.connectors.connected', { source: 'calendar', connector: CAL_SERVER, when: nested, prefix: CAL_PREFIX }), `calendar: ${CAL_SERVER} connected in the round of 24/09/2026, with the tools the source needs under ${CAL_PREFIX}`);
  const problems = [{ messageKey: 'harness.isolation.hooks', params: { count: 1 } }, { messageKey: 'harness.isolation.memory', params: { paths: '/x' } }];
  const text = renderMessage(t, 'doctor.connectors.probe_isolation', { bin: 'claude', problems });
  assert.ok(text.includes(`${t('harness.isolation.hooks', { count: 1 })} ${t('harness.isolation.memory', { paths: '/x' })}`), text);
  assert.equal(renderMessage(t, 'doctor.node_version.ok', { version: ['24', '1'] }), 'Node 24, 1');
});

test('runChecks reports a check that returns an empty list as that check\'s failure, and flattens a list in order', () => {
  const checks = new Map([
    ['empty', () => []],
    ['many', () => [{ id: 'many', status: 'ok', messageKey: 'doctor.node_version.ok', params: { version: '1' } }, { id: 'many', status: 'warn', messageKey: 'doctor.node_version.ok', params: { version: '2' } }]],
  ]);
  const results = runChecks({}, ['empty', 'many'], checks);
  assert.deepEqual(results.map((r) => [r.id, r.status]), [['empty', 'fail'], ['many', 'ok'], ['many', 'warn']]);
  assert.equal(results[0].messageKey, 'doctor.check_crashed');
});

// --- load order --------------------------------------------------------------

test('checks.mjs, schedule.mjs and curate.mjs import each other in a cycle and load whichever comes first', () => {
  for (const file of ['src/doctor/checks.mjs', 'src/commands/schedule.mjs', 'src/commands/curate.mjs', 'src/commands/doctor.mjs']) {
    const url = new URL(`../${file}`, import.meta.url).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${file}: ${r.stderr}`);
  }
});
