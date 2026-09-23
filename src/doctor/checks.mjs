// The phase 1 checks of `brain-kit doctor`: is this machine, and this
// vault, ready for the kit to run here?
//
// Each check is named by what it prevents, and returns one result:
// { id, status, messageKey, params }, where status is 'ok', 'warn' or
// 'fail'. A result carries a message key and its parameters, never a
// formed sentence; the command renders it through the language pack.
//
// THE RULE THIS FILE IS BUILT ON. A check reported `ok` tells a person
// their gate is running, their machine file is where the kit will look,
// their tools answer. Wrongly `ok` is the one answer this command must
// never give, so `ok` is only ever the LAST line of a check, reached after
// every way of being wrong has been ruled out, and never a default. Every
// check that runs a program reads its status AND checks that its output
// means what the check claims: the recurring shape of this project is a
// probe that exits 0 printing nothing, and a git, a gh or a claude that
// does exactly that is not a git, a gh or a claude. Where a probe's
// answer cannot be read, the check says so (warn or fail by its own
// severity), never `ok`.
//
// Every external program runs through src/exec.mjs's run(), with an
// argument array and the environment the command was handed (so PATH,
// HOME and git's own configuration are the caller's, and a test can
// control all three), and with LC_ALL=C so the output parsed below is
// never a translation of it.
import { accessSync, constants as fsConstants, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { run } from '../exec.mjs';
import { EXIT } from '../exit-codes.mjs';
import { decodeBytes } from '../io.mjs';
import { CONFIG_FILENAME, MACHINE_FILENAME, findMachineOnlyKeys, validateConfig, validateMachine } from '../config.mjs';
import { stateDirFor } from '../state.mjs';
import { kitVersion } from '../version.mjs';

export const MINIMUM_NODE_MAJOR = 24;
export const HOOKS_DIR = '.githooks';
export const HOOK_FILE = 'pre-push';
export const SET_HEAD_COMMAND = 'git remote set-head origin --auto';
export const SET_HOOKS_PATH_COMMAND = `git config core.hooksPath ${HOOKS_DIR}`;
export const NODE_MODULES_PATTERN = 'node_modules/';
export const STATE_DIR_MODE = 0o700;
export const MACHINE_FILE_MODE = 0o600;

// A probe that hangs (a claude waiting on a network, say) must not hang
// doctor with it; a killed probe comes back non-zero from run(), which
// every check below already reads as "no answer".
const PROBE_TIMEOUT_MS = 15000;

function probe(ctx, command, args, cwd) {
  return run(command, args, {
    cwd: cwd ?? ctx.root,
    env: { ...ctx.env, LC_ALL: 'C' },
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function git(ctx, args) {
  return probe(ctx, 'git', args, ctx.root);
}

function octal(mode) {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function firstLine(text) {
  return String(text ?? '').trim().split(/\r?\n/)[0] ?? '';
}

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(path) {
  if (!isRegularFile(path)) return false;
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Two paths name the same place when their real paths match; when one of
// them does not exist there is no real path to compare, and the lexical
// comparison is the only honest answer left.
function samePlace(a, b) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

// { ok: true, value } | { ok: false, missing, error }
function readJsonFile(file) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    return { ok: false, missing: error.code === 'ENOENT', error: error.message };
  }
  try {
    return { ok: true, value: JSON.parse(decodeBytes(bytes)) };
  } catch (error) {
    return { ok: false, missing: false, error: error.message };
  }
}

// The facts several checks share, each computed once and only when a
// check asks for it, so `--only node-version` reads no file at all.
//
// `root` is the vault's path AS THE PERSON REACHED IT, possibly through a
// symbolic link: the kit derives a vault's state directory from that
// path, so that is the derivation every check that reads the state
// directory uses. The real path is a separate fact, used where the
// question is about the real path.
export function buildContext({ root, env = process.env, nodeVersion = process.versions.node, engineVersion = kitVersion() }) {
  const memo = new Map();
  const once = (key, compute) => () => {
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key);
  };
  const ctx = { root, env, nodeVersion, engineVersion };
  ctx.realRoot = once('realRoot', () => realpathSync(root));
  ctx.configFile = join(root, CONFIG_FILENAME);
  ctx.config = once('config', () => readJsonFile(ctx.configFile));
  ctx.stateDir = stateDirFor(root, env);
  ctx.machineFile = join(ctx.stateDir, MACHINE_FILENAME);
  ctx.machine = once('machine', () => readJsonFile(ctx.machineFile));
  return ctx;
}

// --- the checks, in table order ---------------------------------------------

function nodeVersion(ctx) {
  const id = 'node-version';
  const version = String(ctx.nodeVersion ?? '');
  const match = /^v?(\d+)\.\d+\.\d+/.exec(version);
  if (!match) {
    return { id, status: 'fail', messageKey: 'doctor.node_version.unreadable', params: { version } };
  }
  if (Number(match[1]) < MINIMUM_NODE_MAJOR) {
    return { id, status: 'fail', messageKey: 'doctor.node_version.too_old', params: { version, minimum: MINIMUM_NODE_MAJOR } };
  }
  return { id, status: 'ok', messageKey: 'doctor.node_version.ok', params: { version } };
}

function gitPresent(ctx) {
  const id = 'git-present';
  const r = probe(ctx, 'git', ['--version']);
  if (r.status !== 0) {
    return { id, status: 'fail', messageKey: 'doctor.git_present.missing', params: { status: r.status } };
  }
  const match = /^git version (\d+\.\d+\S*)/.exec(firstLine(r.stdout));
  if (!match) {
    return { id, status: 'fail', messageKey: 'doctor.git_present.unrecognised', params: { output: firstLine(r.stdout) } };
  }
  return { id, status: 'ok', messageKey: 'doctor.git_present.ok', params: { version: match[1] } };
}

function defaultBranchKnown(ctx) {
  const id = 'default-branch-known';
  const command = SET_HEAD_COMMAND;
  const sym = git(ctx, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  if (sym.status !== 0) {
    return { id, status: 'warn', messageKey: 'doctor.default_branch_known.unset', params: { command } };
  }
  const target = firstLine(sym.stdout);
  const match = /^refs\/remotes\/origin\/(\S+)$/.exec(target);
  if (!match) {
    return { id, status: 'warn', messageKey: 'doctor.default_branch_known.unrecognised', params: { output: target, command } };
  }
  const branch = match[1];
  // A symbolic ref names its target whether or not the target exists: an
  // origin/HEAD left pointing at a deleted branch still reads back fine,
  // and answers about a branch nothing can be compared against.
  const verify = git(ctx, ['rev-parse', '--verify', '-q', `${target}^{commit}`]);
  if (verify.status !== 0 || !/^[0-9a-f]{40,64}$/.test(firstLine(verify.stdout))) {
    return { id, status: 'warn', messageKey: 'doctor.default_branch_known.dangling', params: { branch, command } };
  }
  return { id, status: 'ok', messageKey: 'doctor.default_branch_known.ok', params: { branch } };
}

// What this proves, and what it does not: that git will run an executable,
// non-empty file at the vault's own .githooks/pre-push on every push. It
// does not read that file's content, so a hook edited down to "exit 0"
// passes; the ok message says the file runs, never that it is the gate.
function hooksPath(ctx) {
  const id = 'hooks-path';
  const expected = join(ctx.root, HOOKS_DIR);
  const hook = join(expected, HOOK_FILE);
  const top = git(ctx, ['rev-parse', '--show-toplevel']);
  const topLevel = firstLine(top.stdout);
  if (top.status !== 0 || !isAbsolute(topLevel)) {
    return { id, status: 'fail', messageKey: 'doctor.hooks_path.not_a_repo', params: { dir: ctx.root } };
  }
  // The EFFECTIVE value, the one git will use: a core.hooksPath set only
  // in a person's global configuration moves every repository's hooks,
  // this one's included. `--type=path` expands a leading "~/" the way git
  // itself does when it reads the value.
  const cfg = git(ctx, ['config', '--type=path', '--get', 'core.hooksPath']);
  const value = cfg.status === 0 ? cfg.stdout.replace(/\r?\n$/, '') : '';
  if (cfg.status === 1 || (cfg.status === 0 && value === '')) {
    return { id, status: 'fail', messageKey: 'doctor.hooks_path.unset', params: { expected, command: SET_HOOKS_PATH_COMMAND } };
  }
  if (cfg.status !== 0) {
    return { id, status: 'fail', messageKey: 'doctor.hooks_path.unreadable', params: { status: cfg.status } };
  }
  // A relative core.hooksPath is resolved from the top of the working
  // tree, which is where git runs hooks from.
  const configured = resolve(topLevel, value);
  if (!samePlace(configured, expected)) {
    return { id, status: 'fail', messageKey: 'doctor.hooks_path.elsewhere', params: { value, expected } };
  }
  let stats;
  try {
    stats = statSync(hook);
  } catch {
    stats = null;
  }
  if (!stats || !stats.isFile()) {
    return { id, status: 'fail', messageKey: 'doctor.hooks_path.hook_missing', params: { hook } };
  }
  if (stats.size === 0) {
    return { id, status: 'fail', messageKey: 'doctor.hooks_path.hook_empty', params: { hook } };
  }
  if (!isExecutableFile(hook)) {
    return { id, status: 'fail', messageKey: 'doctor.hooks_path.hook_not_executable', params: { hook } };
  }
  return { id, status: 'ok', messageKey: 'doctor.hooks_path.ok', params: { hook } };
}

function configValid(ctx) {
  const id = 'config-valid';
  const file = ctx.configFile;
  const read = ctx.config();
  if (!read.ok) {
    return { id, status: 'fail', messageKey: 'doctor.config_valid.unreadable', params: { file, error: read.error } };
  }
  const keys = findMachineOnlyKeys(read.value);
  if (keys.length > 0) {
    return { id, status: 'fail', messageKey: 'doctor.config_valid.machine_key', params: { file, keys } };
  }
  const errors = validateConfig(read.value);
  if (errors.length > 0) {
    return { id, status: 'fail', messageKey: 'doctor.config_valid.invalid', params: { file, errors } };
  }
  return { id, status: 'ok', messageKey: 'doctor.config_valid.ok', params: { file } };
}

function machineValid(ctx) {
  const id = 'machine-valid';
  const file = ctx.machineFile;
  const read = ctx.machine();
  if (!read.ok && read.missing) {
    return { id, status: 'fail', messageKey: 'doctor.machine_valid.missing', params: { file } };
  }
  if (!read.ok) {
    return { id, status: 'fail', messageKey: 'doctor.machine_valid.unreadable', params: { file, error: read.error } };
  }
  const errors = validateMachine(read.value);
  if (errors.length > 0) {
    return { id, status: 'fail', messageKey: 'doctor.machine_valid.invalid', params: { file, errors } };
  }
  const recorded = read.value.canonical_path;
  const actual = ctx.realRoot();
  if (!isAbsolute(recorded) || resolve(recorded) !== actual) {
    return { id, status: 'warn', messageKey: 'doctor.machine_valid.canonical_differs', params: { recorded, actual } };
  }
  return { id, status: 'ok', messageKey: 'doctor.machine_valid.ok', params: { file } };
}

// Carried from the init review. The kit derives a vault's state directory
// from the path it was reached by; reached through a symbolic link, that
// is a different directory from the one init wrote machine.json into
// (init records the real path). Every later command run through the link
// would then find no machine file, while the file sits one derivation
// away. This names the path that finds it.
function stateDirResolves(ctx) {
  const id = 'state-dir-resolves';
  const used = ctx.stateDir;
  if (isRegularFile(join(used, MACHINE_FILENAME))) {
    return { id, status: 'ok', messageKey: 'doctor.state_dir_resolves.ok', params: { dir: used } };
  }
  const path = ctx.realRoot();
  const canonical = stateDirFor(path, ctx.env);
  if (isRegularFile(join(canonical, MACHINE_FILENAME))) {
    return { id, status: 'fail', messageKey: 'doctor.state_dir_resolves.use_canonical', params: { path, dir: canonical, used } };
  }
  return { id, status: 'fail', messageKey: 'doctor.state_dir_resolves.none', params: { dir: used } };
}

function stateDirMode(ctx) {
  const id = 'state-dir-mode';
  const dir = ctx.stateDir;
  const file = ctx.machineFile;
  let dirStats;
  try {
    dirStats = statSync(dir);
  } catch {
    dirStats = null;
  }
  if (!dirStats || !dirStats.isDirectory()) {
    return { id, status: 'fail', messageKey: 'doctor.state_dir_mode.dir_missing', params: { dir } };
  }
  if ((dirStats.mode & 0o777) !== STATE_DIR_MODE) {
    return { id, status: 'fail', messageKey: 'doctor.state_dir_mode.dir_mode', params: { dir, mode: octal(dirStats.mode), expected: octal(STATE_DIR_MODE) } };
  }
  let fileStats;
  try {
    fileStats = statSync(file);
  } catch {
    fileStats = null;
  }
  if (!fileStats || !fileStats.isFile()) {
    return { id, status: 'fail', messageKey: 'doctor.state_dir_mode.file_missing', params: { file } };
  }
  if ((fileStats.mode & 0o777) !== MACHINE_FILE_MODE) {
    return { id, status: 'fail', messageKey: 'doctor.state_dir_mode.file_mode', params: { file, mode: octal(fileStats.mode), expected: octal(MACHINE_FILE_MODE) } };
  }
  return { id, status: 'ok', messageKey: 'doctor.state_dir_mode.ok', params: { dir } };
}

function kitVersionCheck(ctx) {
  const id = 'kit-version';
  const running = ctx.engineVersion;
  const read = ctx.config();
  const configured = read.ok && read.value !== null && typeof read.value === 'object' ? read.value.kit_version : undefined;
  if (typeof configured !== 'string' || configured === '') {
    return { id, status: 'warn', messageKey: 'doctor.kit_version.unknown', params: { file: ctx.configFile, running } };
  }
  if (configured !== running) {
    return { id, status: 'warn', messageKey: 'doctor.kit_version.differs', params: { configured, running } };
  }
  return { id, status: 'ok', messageKey: 'doctor.kit_version.ok', params: { version: running } };
}

function ghPresent(ctx) {
  const id = 'gh-present';
  const r = probe(ctx, 'gh', ['--version']);
  if (r.status !== 0) {
    return { id, status: 'warn', messageKey: 'doctor.gh_present.missing', params: { status: r.status } };
  }
  const match = /^gh version (\d+\.\d+\.\d+\S*)/.exec(firstLine(r.stdout));
  if (!match) {
    return { id, status: 'warn', messageKey: 'doctor.gh_present.unrecognised', params: { output: firstLine(r.stdout) } };
  }
  return { id, status: 'ok', messageKey: 'doctor.gh_present.ok', params: { version: match[1] } };
}

function expandHome(path, env) {
  if (path === '~') return env.HOME || homedir();
  if (path.startsWith('~/')) return join(env.HOME || homedir(), path.slice(2));
  return path;
}

// The machine's path_extra comes first, because that is what it is for:
// the directories a scheduled run adds to PATH so it finds what a login
// shell would. An empty PATH entry means "the current directory" to a
// shell, and a relative entry means "from wherever you are"; both are
// skipped here, since a claude that resolves only from wherever doctor
// happened to be started is not one a scheduled run finds.
function resolveExecutable(bin, extra, env, root) {
  const expanded = expandHome(bin, env);
  if (expanded.includes('/')) {
    const candidate = resolve(root, expanded);
    return isExecutableFile(candidate) ? candidate : null;
  }
  const dirs = [...extra.map((dir) => expandHome(String(dir), env)), ...String(env.PATH ?? '').split(delimiter)];
  for (const dir of dirs) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, expanded);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function claudePresent(ctx) {
  const id = 'claude-present';
  const read = ctx.machine();
  const machine = read.ok && read.value !== null && typeof read.value === 'object' ? read.value : null;
  const bin = machine?.claude_bin;
  if (typeof bin !== 'string' || bin === '') {
    return { id, status: 'warn', messageKey: 'doctor.claude_present.unknown', params: { file: ctx.machineFile } };
  }
  const extra = Array.isArray(machine.path_extra) ? machine.path_extra : [];
  const resolved = resolveExecutable(bin, extra, ctx.env, ctx.root);
  if (!resolved) {
    return { id, status: 'warn', messageKey: 'doctor.claude_present.not_found', params: { bin } };
  }
  // Resolving is not running: a package manager can leave a stub where
  // the binary should be, executable and on PATH, that does nothing but
  // fail. Asking it for its version is the proof it runs.
  const r = probe(ctx, resolved, ['--version']);
  if (r.status !== 0) {
    return { id, status: 'warn', messageKey: 'doctor.claude_present.failed', params: { bin: resolved, status: r.status } };
  }
  const match = /(\d+\.\d+\.\d+)/.exec(firstLine(r.stdout));
  if (!match) {
    return { id, status: 'warn', messageKey: 'doctor.claude_present.unrecognised', params: { bin: resolved, output: firstLine(r.stdout) } };
  }
  return { id, status: 'ok', messageKey: 'doctor.claude_present.ok', params: { bin: resolved, version: match[1] } };
}

// Without the quiet flag on purpose: `check-ignore -q` answers only by
// its status, which is exactly the probe-that-prints-nothing this file
// refuses to trust. Asked plainly, git prints the path back when it is
// ignored, and that printed path is the proof. `--no-index` asks the
// ignore rules alone, whatever the index happens to hold.
function gitignoreNodeModules(ctx) {
  const id = 'gitignore-node-modules';
  const pattern = NODE_MODULES_PATTERN;
  const r = git(ctx, ['check-ignore', '--no-index', pattern]);
  if (r.status === 0 && r.stdout.split(/\r?\n/).includes(pattern)) {
    return { id, status: 'ok', messageKey: 'doctor.gitignore_node_modules.ok', params: { pattern } };
  }
  if (r.status === 1) {
    return { id, status: 'warn', messageKey: 'doctor.gitignore_node_modules.not_ignored', params: { pattern } };
  }
  return { id, status: 'warn', messageKey: 'doctor.gitignore_node_modules.unknown', params: { pattern, status: r.status } };
}

// id -> check, in the order the report prints them.
export const CHECKS = new Map([
  ['node-version', nodeVersion],
  ['git-present', gitPresent],
  ['default-branch-known', defaultBranchKnown],
  ['hooks-path', hooksPath],
  ['config-valid', configValid],
  ['machine-valid', machineValid],
  ['state-dir-resolves', stateDirResolves],
  ['state-dir-mode', stateDirMode],
  ['kit-version', kitVersionCheck],
  ['gh-present', ghPresent],
  ['claude-present', claudePresent],
  ['gitignore-node-modules', gitignoreNodeModules],
]);

export const CHECK_IDS = Object.freeze([...CHECKS.keys()]);

// Runs the named checks in the order given. A check that throws is a
// defect in the check, not a pass: it is reported as that check's
// failure, with the error, and the checks after it still run.
export function runChecks(ctx, ids = CHECK_IDS, checks = CHECKS) {
  return ids.map((id) => {
    try {
      return checks.get(id)(ctx);
    } catch (error) {
      return { id, status: 'fail', messageKey: 'doctor.check_crashed', params: { error: error.message } };
    }
  });
}

// 0 when every check is ok or warn, 1 when any fails. A status this file
// does not know is a failure (the tool cannot vouch for what it cannot
// read), and so is a run that produced no results at all: zero checks
// proves nothing, and an exit 0 would say it proved everything.
export function exitCodeFor(results) {
  if (results.length === 0) return EXIT.FAILURE;
  const clean = results.every((result) => result.status === 'ok' || result.status === 'warn');
  return clean ? EXIT.OK : EXIT.FAILURE;
}
