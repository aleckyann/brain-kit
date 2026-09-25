// The checks of `brain-kit doctor`: is this machine, and this vault, ready
// for the kit to run here, and is the scheduled curator really running?
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
// control all three), with LC_ALL=C so the output parsed below is never a
// translation of it, and with the variables that move git to another
// repository removed (src/git-env.mjs): with GIT_DIR in the environment,
// every git question below would otherwise be answered about THAT
// repository, and a vault whose push runs no hook would read as gated.
import { accessSync, constants as fsConstants, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { run } from '../exec.mjs';
import { EXIT } from '../exit-codes.mjs';
import { decodeBytes } from '../io.mjs';
import { CONFIG_FILENAME, MACHINE_FILENAME, canonicalPathMatches, findMachineOnlyKeys, validateConfig, validateMachine } from '../config.mjs';
import { STATE_FILES, stateDirFor } from '../state.mjs';
import { kitVersion } from '../version.mjs';
import { localGitVarNames, withoutLocalGitVars } from '../git-env.mjs';
import { loadPatterns } from '../leak.mjs';
import { TEMPLATE_HOOK } from '../init/skeleton.mjs';
import { INSTALL_HOOK_COMMAND } from '../init/gate.mjs';
import { MANIFEST_PATH, readManifest } from '../manifest.mjs';
import { compareVersions } from '../commands/update.mjs';
import { defaultBranch, defaultBranchUpstream, remoteBranches, trackedRemote } from '../git.mjs';
import { checkCli } from '../guards/cli.mjs';
import { buildArgv } from '../harness/claude-code.mjs';
import { addDays, daysBetween, localDay, readWatermark, WatermarkError } from '../guards/watermark.mjs';
// A cycle on purpose: schedule.mjs imports resolveClaude and expandHome
// from this file, and this file asks schedule's own `status`. Neither
// module uses the other's exports while it loads, only inside functions,
// so either may be imported first (test/doctor.test.mjs loads each
// on its own in a fresh process to hold that).
import { installedRoundPath, ROUND_COMMANDS, roundPath, runScheduleSync } from '../commands/schedule.mjs';

export const MINIMUM_NODE_MAJOR = 24;
export const HOOKS_DIR = '.githooks';
export const HOOK_FILE = 'pre-push';
export const SET_HOOKS_PATH_COMMAND = `git config core.hooksPath ${HOOKS_DIR}`;
export const NODE_MODULES_PATTERN = 'node_modules/';
export const STATE_DIR_MODE = 0o700;
export const MACHINE_FILE_MODE = 0o600;

// A probe that hangs (a claude waiting on a network, say) must not hang
// doctor with it; a killed probe comes back non-zero from run(), which
// every check below already reads as "no answer".
const PROBE_TIMEOUT_MS = 15000;

function probe(ctx, command, args, cwd, input) {
  return run(command, args, {
    cwd: cwd ?? ctx.root,
    input: input ?? '',
    env: { ...withoutLocalGitVars(ctx.env, ctx.localGitVars()), LC_ALL: 'C' },
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function git(ctx, args, input) {
  return probe(ctx, 'git', args, ctx.root, input);
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

export function expandHome(path, env) {
  if (path === '~') return env.HOME || homedir();
  if (path.startsWith('~/')) return join(env.HOME || homedir(), path.slice(2));
  return path;
}

// The first executable regular file named `name` in `dirs`. An empty PATH
// entry means "the current directory" to a shell, and a relative entry
// means "from wherever you are"; both are skipped, since a program that
// resolves only from wherever doctor happened to be started is not one a
// hook or a scheduled run can be relied on to find.
export function findExecutable(name, dirs) {
  for (const dir of dirs) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function pathDirs(env) {
  return String(env.PATH ?? '').split(delimiter);
}

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
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
export function buildContext({
  root, env = process.env, nodeVersion = process.versions.node, execPath = process.execPath, engineVersion = kitVersion(), now = new Date(),
}) {
  const memo = new Map();
  const once = (key, compute) => () => {
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key);
  };
  const ctx = { root, env, nodeVersion, execPath, engineVersion, now };
  ctx.localGitVars = once('localGitVars', () => localGitVarNames(env));
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
  // The Node running doctor is not necessarily the one the gate runs: the
  // pre-push hook calls `node` and `brain-kit` from PATH, and brain-kit's
  // own launcher finds its node through PATH too. Run as
  // `node /path/to/brain-kit.mjs doctor`, the answer above is about a Node
  // no push ever uses, so the one on PATH is asked as well.
  const bin = findExecutable('node', pathDirs(ctx.env));
  if (!bin) {
    return { id, status: 'fail', messageKey: 'doctor.node_version.path_missing', params: { version } };
  }
  const r = probe(ctx, bin, ['--version']);
  if (r.status !== 0) {
    return { id, status: 'fail', messageKey: 'doctor.node_version.path_failed', params: { bin, status: r.status } };
  }
  const onPath = /^v((\d+)\.\d+\.\d+)$/.exec(firstLine(r.stdout));
  if (!onPath) {
    return { id, status: 'fail', messageKey: 'doctor.node_version.path_unrecognised', params: { bin, output: firstLine(r.stdout) } };
  }
  const pathVersion = onPath[1];
  if (Number(onPath[2]) < MINIMUM_NODE_MAJOR) {
    return { id, status: 'fail', messageKey: 'doctor.node_version.path_too_old', params: { bin, pathVersion, minimum: MINIMUM_NODE_MAJOR } };
  }
  if (pathVersion !== version.replace(/^v/, '') || realOrSelf(bin) !== realOrSelf(ctx.execPath)) {
    return { id, status: 'ok', messageKey: 'doctor.node_version.ok_path_differs', params: { version, bin, pathVersion } };
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

// Which branch is the default, answered by the ONE resolver (src/git.mjs,
// defaultBranch) that sync and lint's scope use, and that the push gate
// uses for each remote's rung (in its published-only form: the gate never
// takes a local main, and adds every configured remote's answer on a push
// by url, so on a vault whose remote knows nothing yet doctor can answer a
// local main where the gate reads no default branch at all). Reported
// besides its answer, because each makes that answer weaker than it looks:
// a configured vault.default_branch that is no branch name; a <remote>/HEAD
// that exists but was skipped (naming another remote's branch, or a branch
// this repository does not hold); a default branch that tracks a branch of
// this repository; and, asked live when the remote is configured, a remote
// that publishes branches but not this one (a default renamed on the forge,
// a typo, a local master against a remote main), which is what sync refuses
// with exit 1. A remote that cannot be asked is a warning, never an ok.
//
// The remedy for "no default branch known" is the configuration's
// vault.default_branch, which works before the first push, or `git remote
// set-head <remote> --auto` once the remote publishes a branch. It never
// proposes the branch checked out, which on an agent's branch would be the
// agent's branch.
export function setHeadCommand(remote) {
  return `git remote set-head ${remote} --auto`;
}

function defaultBranchKnown(ctx) {
  const id = 'default-branch-known';
  const options = { env: ctx.env };
  const found = defaultBranch(ctx.root, options);
  if (found !== null && found.bare === null) {
    return { id, status: 'warn', messageKey: 'doctor.default_branch_known.config_invalid', params: { file: CONFIG_FILENAME, name: found.name } };
  }
  const remote = found?.remote ?? trackedRemote(ctx.root, options);
  const command = setHeadCommand(remote);
  const prefix = `refs/remotes/${remote}/`;
  const sym = git(ctx, ['symbolic-ref', '-q', `${prefix}HEAD`]);
  if (sym.status === 0) {
    const target = firstLine(sym.stdout);
    if (!target.startsWith(prefix) || target.length === prefix.length) {
      return { id, status: 'warn', messageKey: 'doctor.default_branch_known.unrecognised', params: { remote, output: target, command } };
    }
    // A symbolic ref names its target whether or not the target exists:
    // one left pointing at a deleted branch still reads back fine.
    const branch = target.slice(prefix.length);
    const verify = git(ctx, ['rev-parse', '--verify', '-q', `${target}^{commit}`]);
    if (verify.status !== 0 || !/^[0-9a-f]{40,64}$/.test(firstLine(verify.stdout))) {
      return { id, status: 'warn', messageKey: 'doctor.default_branch_known.dangling', params: { remote, branch, command } };
    }
  }
  if (found === null) {
    return { id, status: 'warn', messageKey: 'doctor.default_branch_known.unset', params: { file: CONFIG_FILENAME, remote, command } };
  }
  const upstream = defaultBranchUpstream(ctx.root, found, options);
  if (upstream.local) {
    const key = `branch.${found.bare}.remote`;
    return { id, status: 'warn', messageKey: 'doctor.default_branch_known.local_upstream', params: { branch: found.bare, key } };
  }
  const remotes = git(ctx, ['remote']);
  const configured = remotes.status === 0 && remotes.stdout.split('\n').includes(upstream.remote);
  if (configured) {
    const listed = remoteBranches(ctx.root, upstream.remote, { env: ctx.env, timeout: PROBE_TIMEOUT_MS });
    if (listed.status !== 'listed') {
      return { id, status: 'warn', messageKey: 'doctor.default_branch_known.remote_unverified', params: { branch: found.bare, remote: upstream.remote, detail: listed.detail } };
    }
    if (listed.heads.size > 0 && !listed.heads.has(upstream.branch)) {
      const published = [...listed.heads.keys()].sort();
      return {
        id, status: 'warn', messageKey: 'doctor.default_branch_known.remote_lacks_branch',
        params: { remote: upstream.remote, branch: upstream.branch, published, head: listed.head ?? '-', file: CONFIG_FILENAME, command: setHeadCommand(upstream.remote) },
      };
    }
  }
  return { id, status: 'ok', messageKey: 'doctor.default_branch_known.ok', params: { branch: found.bare, from: found.from } };
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
    // With no hook to point at, pointing core.hooksPath at the directory
    // only leads to the next failure: the command that installs both is
    // the one named.
    if (!isRegularFile(hook)) {
      return { id, status: 'fail', messageKey: 'doctor.hooks_path.unset_no_hook', params: { hook, command: INSTALL_HOOK_COMMAND } };
    }
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
  // A vault below its repository's top level: git runs the hook, but the
  // hook runs brain-kit from the top level, finds no vault there, and
  // refuses every push. Asked only after the directory matched, so a
  // relative value resolved from the wrong place is still reported as
  // pointing elsewhere.
  if (!samePlace(topLevel, ctx.root)) {
    return { id, status: 'fail', messageKey: 'doctor.hooks_path.not_top_level', params: { dir: ctx.root, top: topLevel } };
  }
  let stats;
  try {
    stats = statSync(hook);
  } catch {
    stats = null;
  }
  if (!stats || !stats.isFile()) {
    return { id, status: 'fail', messageKey: 'doctor.hooks_path.hook_missing', params: { hook, command: INSTALL_HOOK_COMMAND } };
  }
  if (stats.size === 0) {
    return { id, status: 'fail', messageKey: 'doctor.hooks_path.hook_empty', params: { hook } };
  }
  if (!isExecutableFile(hook)) {
    return { id, status: 'fail', messageKey: 'doctor.hooks_path.hook_not_executable', params: { hook } };
  }
  // The file runs; whether it is the gate is a question of its bytes. A
  // hook that differs from the template this engine ships may be a
  // deliberate edit, an older kit's template, or a gate cut down to
  // nothing, and doctor cannot tell which: it warns, and names both files.
  if (!readFileSync(hook).equals(readFileSync(TEMPLATE_HOOK))) {
    return { id, status: 'warn', messageKey: 'doctor.hooks_path.differs', params: { hook, template: TEMPLATE_HOOK } };
  }
  return { id, status: 'ok', messageKey: 'doctor.hooks_path.ok', params: { hook } };
}

// The pre-push hook runs `command -v brain-kit` and refuses the push when
// there is none: every push is refused, and nothing else here would say
// why. The brain-kit found is also asked for its version, because a
// launcher that cannot start (no node on PATH, a half-installed package)
// is found by `command -v` and still refuses every push.
function brainKitOnPath(ctx) {
  const id = 'brain-kit-on-path';
  const running = ctx.engineVersion;
  const bin = findExecutable('brain-kit', pathDirs(ctx.env));
  if (!bin) {
    return { id, status: 'fail', messageKey: 'doctor.brain_kit_on_path.missing', params: {} };
  }
  const r = probe(ctx, bin, ['--version']);
  if (r.status !== 0) {
    return { id, status: 'fail', messageKey: 'doctor.brain_kit_on_path.failed', params: { bin, status: r.status } };
  }
  const match = /^(\d+\.\d+\.\d+\S*)$/.exec(firstLine(r.stdout));
  if (!match) {
    return { id, status: 'fail', messageKey: 'doctor.brain_kit_on_path.unrecognised', params: { bin, output: firstLine(r.stdout) } };
  }
  const unit = roundPathProblem(ctx);
  if (unit !== null) {
    return { id, status: 'fail', messageKey: `doctor.brain_kit_on_path.${unit.kind}`, params: { bin, version: match[1], ...unit.params } };
  }
  if (match[1] !== running) {
    return { id, status: 'warn', messageKey: 'doctor.brain_kit_on_path.other_version', params: { bin, version: match[1], running } };
  }
  return { id, status: 'ok', messageKey: 'doctor.brain_kit_on_path.ok', params: { bin, version: match[1] } };
}

// The scheduled round runs with its own PATH, not the shell's, and its
// `propose` needs brain-kit (the gate) and gh (the pull request) on it
// (final review I1, 24/09/2026). The installed entry's PATH is read back
// from its file; with none installed, the PATH `schedule install` would
// write is computed the same way it does. null when both commands resolve,
// or when there is no scheduled curator to ask about (disabled, or a
// configuration or machine file other checks already report).
function roundPathProblem(ctx) {
  const read = ctx.config();
  if (!read.ok || !isObject(read.value) || read.value.curate?.enabled === false) return null;
  const machine = machineObject(ctx);
  if (machine === null || validateMachine(machine).length > 0) return null;
  const installed = installedRoundPath({ machine, env: ctx.env });
  if (installed !== null) {
    const missing = ROUND_COMMANDS.filter((command) => findExecutable(command, installed.path.split(':')) === null);
    if (missing.length === 0) return null;
    return { kind: 'unit_missing_installed', params: { file: installed.file, path: installed.path, commands: missing.join(', ') } };
  }
  const extra = Array.isArray(machine.path_extra) ? machine.path_extra : [];
  const claude = typeof machine.claude_bin === 'string' ? resolveClaude(machine.claude_bin, extra, ctx.env, ctx.root) : null;
  const computed = roundPath({ extra, claude, node: process.execPath, env: ctx.env });
  if (computed.missing.length === 0) return null;
  return { kind: 'unit_missing_computed', params: { path: computed.dirs.join(':'), commands: computed.missing.join(', ') } };
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
  // The schema accepts any non-empty string as a secret pattern; the
  // scanner compiles each one, and one that does not compile crashes the
  // secrets rule, so lint fails and the gate refuses every push. Each is
  // compiled here exactly the way the scanner does, through loadPatterns.
  const configured = read.value.privacy?.secret_patterns ?? [];
  const patterns = configured.filter((raw) => {
    try {
      loadPatterns({ configPatterns: [raw] });
      return false;
    } catch {
      return true;
    }
  });
  if (patterns.length > 0) {
    return { id, status: 'fail', messageKey: 'doctor.config_valid.pattern', params: { file, patterns } };
  }
  return { id, status: 'ok', messageKey: 'doctor.config_valid.ok', params: { file } };
}

// The states in which `brain-kit update` refuses the vault, said before a
// person runs it: no manifest, or one it cannot read, fails (update has
// nothing to go on, and a vault whose manifest is gone cannot be kept
// current at all); a manifest language that differs from the
// configuration's, or an engine older than the configuration's
// kit_version, warns (update refuses, but every other command works).
function manifestValid(ctx) {
  const id = 'manifest-valid';
  const file = join(ctx.root, MANIFEST_PATH);
  try {
    lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { id, status: 'fail', messageKey: 'doctor.manifest_valid.missing', params: { file } };
  }
  let manifest;
  try {
    manifest = readManifest(ctx.root);
  } catch (error) {
    return { id, status: 'fail', messageKey: 'doctor.manifest_valid.unreadable', params: { file, error: error.message } };
  }
  const read = ctx.config();
  const config = read.ok && read.value !== null && typeof read.value === 'object' ? read.value : null;
  if (config !== null && manifest.lang !== undefined && typeof config.lang === 'string' && manifest.lang !== config.lang) {
    return { id, status: 'warn', messageKey: 'doctor.manifest_valid.lang_differs', params: { recorded: manifest.lang, configured: config.lang } };
  }
  const configured = config?.kit_version;
  if (typeof configured === 'string') {
    const order = compareVersions(ctx.engineVersion, configured);
    if (order === null || order < 0) {
      return { id, status: 'warn', messageKey: 'doctor.manifest_valid.kit_older', params: { configured, running: ctx.engineVersion } };
    }
  }
  return { id, status: 'ok', messageKey: 'doctor.manifest_valid.ok', params: { file } };
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
  if (!canonicalPathMatches(recorded, actual)) {
    return { id, status: 'warn', messageKey: 'doctor.machine_valid.canonical_differs', params: { recorded, actual } };
  }
  return { id, status: 'ok', messageKey: 'doctor.machine_valid.ok', params: { file } };
}

// Carried from the init review. The state directory used to be derived
// from the path a vault was reached by, so through a symbolic link it was
// not the directory init wrote machine.json into. stateDirFor now derives
// it from the vault's real path, whatever path reached it; this check says
// whether that directory holds the machine file.
function stateDirResolves(ctx) {
  const id = 'state-dir-resolves';
  const used = ctx.stateDir;
  if (isRegularFile(join(used, MACHINE_FILENAME))) {
    return { id, status: 'ok', messageKey: 'doctor.state_dir_resolves.ok', params: { dir: used } };
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
  // Absent from PATH is said as absent: "did not answer" reads like a
  // broken gh. The one found is the one asked.
  const bin = findExecutable('gh', pathDirs(ctx.env));
  if (!bin) {
    return { id, status: 'warn', messageKey: 'doctor.gh_present.not_installed', params: {} };
  }
  const r = probe(ctx, bin, ['--version']);
  if (r.status !== 0) {
    return { id, status: 'warn', messageKey: 'doctor.gh_present.missing', params: { status: r.status } };
  }
  const match = /^gh version (\d+\.\d+\.\d+\S*)/.exec(firstLine(r.stdout));
  if (!match) {
    return { id, status: 'warn', messageKey: 'doctor.gh_present.unrecognised', params: { output: firstLine(r.stdout) } };
  }
  return { id, status: 'ok', messageKey: 'doctor.gh_present.ok', params: { version: match[1] } };
}

// The machine's path_extra comes first, because that is what it is for:
// the directories a scheduled run adds to PATH so it finds what a login
// shell would. A value with a slash in it is a path, resolved from the
// vault, never from wherever doctor was started.
export function resolveClaude(bin, extra, env, root) {
  const expanded = expandHome(bin, env);
  if (expanded.includes('/')) {
    const candidate = resolve(root, expanded);
    return isExecutableFile(candidate) ? candidate : null;
  }
  return findExecutable(expanded, [...extra.map((dir) => expandHome(String(dir), env)), ...pathDirs(env)]);
}

// True when the file, or the directory holding it, can be written by
// anyone but its owner: then what it names is not the person's choice
// alone.
function writableByOthers(path) {
  try {
    return (statSync(path).mode & 0o022) !== 0;
  } catch {
    return true;
  }
}

function claudePresent(ctx) {
  const id = 'claude-present';
  const file = ctx.machineFile;
  const read = ctx.machine();
  const machine = read.ok && read.value !== null && typeof read.value === 'object' ? read.value : null;
  const bin = machine?.claude_bin;
  if (typeof bin !== 'string' || bin === '') {
    return { id, status: 'warn', messageKey: 'doctor.claude_present.unknown', params: { file } };
  }
  // This check EXECUTES the file machine.json names. It never does so for
  // a machine.json the kit itself would refuse, or one another local user
  // could have written: that would be running a path someone else chose.
  if (validateMachine(machine).length > 0) {
    return { id, status: 'warn', messageKey: 'doctor.claude_present.machine_invalid', params: { file } };
  }
  if (writableByOthers(file) || writableByOthers(ctx.stateDir)) {
    return { id, status: 'warn', messageKey: 'doctor.claude_present.machine_writable', params: { file } };
  }
  const extra = Array.isArray(machine.path_extra) ? machine.path_extra : [];
  const resolved = resolveClaude(bin, extra, ctx.env, ctx.root);
  if (!resolved) {
    return { id, status: 'warn', messageKey: 'doctor.claude_present.not_found', params: { bin } };
  }
  // Resolving is not running: a package manager can leave a stub where
  // the binary should be, executable and on PATH, that does nothing but
  // fail. Asking it for its version is the proof it runs, and the answer
  // must be shaped like the Claude CLI's own version line: any program
  // prints a version, and `git` or `node` named as claude_bin is not claude.
  const r = probe(ctx, resolved, ['--version']);
  if (r.status !== 0) {
    return { id, status: 'warn', messageKey: 'doctor.claude_present.failed', params: { bin: resolved, status: r.status } };
  }
  const match = /^(\d+\.\d+\.\d+\S*) \(Claude Code\)$/.exec(firstLine(r.stdout));
  if (!match) {
    return { id, status: 'warn', messageKey: 'doctor.claude_present.unrecognised', params: { bin: resolved, output: firstLine(r.stdout) } };
  }
  return { id, status: 'ok', messageKey: 'doctor.claude_present.ok', params: { bin: resolved, version: match[1] } };
}

// Without the quiet flag on purpose: `check-ignore -q` answers only by
// its status, which is exactly the probe-that-prints-nothing this file
// refuses to trust. Asked with `-v`, git prints back the file and the
// line that ignore the path, and that is the proof (`-z`, which git
// accepts only with `--stdin`, keeps a file name with a colon in it
// parseable); `--no-index` asks the ignore rules alone, whatever the
// index happens to hold.
//
// Where the rule lives matters as much as whether it exists. Only a
// .gitignore inside the vault travels with it; `.git/info/exclude` and a
// global excludes file protect this clone alone, and a second clone or a
// CI checkout meets the false refusal the warning describes.
function gitignoreNodeModules(ctx) {
  const id = 'gitignore-node-modules';
  const pattern = NODE_MODULES_PATTERN;
  const r = git(ctx, ['check-ignore', '-v', '-z', '--stdin', '--no-index'], `${pattern}\0`);
  if (r.status === 1) {
    return { id, status: 'warn', messageKey: 'doctor.gitignore_node_modules.not_ignored', params: { pattern } };
  }
  // source NUL line NUL rule NUL path NUL
  const [source, , , path] = r.stdout.split('\0');
  if (r.status !== 0 || path !== pattern || !source) {
    return { id, status: 'warn', messageKey: 'doctor.gitignore_node_modules.unknown', params: { pattern, status: r.status } };
  }
  const where = relative(ctx.realRoot(), resolve(ctx.realRoot(), source));
  if (where.startsWith(`..${sep}`) || basename(where) !== '.gitignore') {
    return { id, status: 'warn', messageKey: 'doctor.gitignore_node_modules.local_only', params: { pattern, source } };
  }
  // Ignoring never untracks: files under node_modules/ that were already
  // committed are still read by the secrets rule, rule or no rule.
  const tracked = git(ctx, ['--literal-pathspecs', 'ls-files', '-z', '--', 'node_modules']);
  if (tracked.status !== 0) {
    return { id, status: 'warn', messageKey: 'doctor.gitignore_node_modules.unknown', params: { pattern, status: tracked.status } };
  }
  const count = tracked.stdout.split('\0').filter((name) => name !== '').length;
  if (count > 0) {
    return { id, status: 'warn', messageKey: 'doctor.gitignore_node_modules.tracked', params: { pattern, count } };
  }
  return { id, status: 'ok', messageKey: 'doctor.gitignore_node_modules.ok', params: { pattern, source } };
}

// --- the scheduled curator's checks (phase 2) --------------------------------
//
// Each one answers a question an unattended round would otherwise answer
// by dying, or worse, by exiting 0 having done nothing (docs/incidents.md,
// 13/09/2026 and 21/08/2026). Each names the command that fixes what it
// finds. With curate.enabled false they have nothing to prove and say so;
// with a configuration doctor cannot read (config-valid says why) they
// cannot ask, and warn.

export const WATERMARK_BEHIND_WARN_DAYS = 3;
// A round that exits 0 in less than this, with no model turn, is dead: the
// 21/08/2026 round died on an expired token in six seconds and its service
// read green.
export const DEAD_ROUND_MS = 20000;
// Exits that say "not now" rather than "broken": degraded (3), network or
// model unavailable (69), postponed (75).
const SOFT_EXITS = Object.freeze([EXIT.DEGRADED, EXIT.UNAVAILABLE, EXIT.TEMPFAIL]);
// A round that ended before the model, legitimately fast.
const NO_MODEL_REASONS = Object.freeze(['up_to_date', 'nothing_to_curate']);
const DEFAULT_TRANSCRIPTS_DIR = '~/.claude/projects';
const INCLUDE_PROJECTS_KEY = 'sources.transcripts.include_projects';
const CURATE_COMMAND = 'brain-kit curate';
const SCHEDULE_INSTALL_COMMAND = 'brain-kit schedule install';
const SCHEDULE_UNINSTALL_COMMAND = 'brain-kit schedule uninstall';
const SET_CLAUDE_COMMAND = 'brain-kit machine set claude_bin <path>';
const SET_TRANSCRIPTS_COMMAND = 'brain-kit machine set transcripts_dir <dir>';
const SET_NOTIFY_COMMAND = 'brain-kit machine set notify_command \'["<program>", "<argument>"]\'';
const UPDATE_CLAUDE_COMMAND = 'claude update';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// DD/MM/YYYY HH:MM on the machine's clock, for a person; '-' when the
// value is not an instant. `schedule status` shows last-run's times the
// same way.
export function shownInstant(iso) {
  const at = typeof iso === 'string' ? new Date(iso) : null;
  if (at === null || Number.isNaN(at.getTime())) return '-';
  return `${pad2(at.getDate())}/${pad2(at.getMonth() + 1)}/${at.getFullYear()} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

function shownDay(day) {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

// { config } | { disabled: true, config } | { result } when the
// configuration cannot be read.
function curateInputs(ctx, id) {
  const read = ctx.config();
  if (!read.ok || !isObject(read.value)) {
    return { result: { id, status: 'warn', messageKey: 'doctor.curate.config_unknown', params: { file: ctx.configFile } } };
  }
  const config = read.value;
  if (config.curate?.enabled === false) return { disabled: true, config };
  return { config };
}

function curateDisabled(ctx, id) {
  return { id, status: 'ok', messageKey: 'doctor.curate.disabled', params: { file: ctx.configFile } };
}

function machineObject(ctx) {
  const read = ctx.machine();
  return read.ok && isObject(read.value) ? read.value : null;
}

// The claude this machine's rounds would run, when doctor may run it:
// the same refusals as claude-present (never a path from a machine file
// the kit would refuse, or one another user could have written), then the
// same resolution the schedule and the round use.
function claudeToRun(ctx, id) {
  const file = ctx.machineFile;
  const machine = machineObject(ctx);
  const bin = machine?.claude_bin;
  if (typeof bin !== 'string' || bin === '') {
    return { result: { id, status: 'warn', messageKey: 'doctor.claude_present.unknown', params: { file } } };
  }
  if (validateMachine(machine).length > 0) {
    return { result: { id, status: 'warn', messageKey: 'doctor.claude_present.machine_invalid', params: { file } } };
  }
  if (writableByOthers(file) || writableByOthers(ctx.stateDir)) {
    return { result: { id, status: 'warn', messageKey: 'doctor.claude_present.machine_writable', params: { file } } };
  }
  const extra = Array.isArray(machine.path_extra) ? machine.path_extra : [];
  const resolved = resolveClaude(bin, extra, ctx.env, ctx.root);
  if (!resolved) {
    return { result: { id, status: 'fail', messageKey: 'doctor.claude_real.not_found', params: { bin, command: SET_CLAUDE_COMMAND } } };
  }
  return { bin: resolved };
}

// docs/incidents.md, 14/09/2026: a reinstall left a launcher of about 500
// bytes where the CLI should be, and --version printed error text. The
// round's own guard (src/guards/cli.mjs) is what is asked here, so doctor
// and the round cannot disagree on what a real CLI is.
function claudeReal(ctx) {
  const id = 'claude-real';
  const inputs = curateInputs(ctx, id);
  if (inputs.result) return inputs.result;
  if (inputs.disabled) return curateDisabled(ctx, id);
  const target = claudeToRun(ctx, id);
  if (target.result) return target.result;
  const bin = target.bin;
  const cli = checkCli(bin, { env: { ...withoutLocalGitVars(ctx.env, ctx.localGitVars()), LC_ALL: 'C' }, timeoutMs: PROBE_TIMEOUT_MS });
  if (cli.problem === 'missing') {
    return { id, status: 'fail', messageKey: 'doctor.claude_real.not_found', params: { bin, command: SET_CLAUDE_COMMAND } };
  }
  if (cli.problem === 'stub') {
    return { id, status: 'fail', messageKey: 'doctor.claude_real.stub', params: { bin, bytes: cli.params.bytes } };
  }
  if (!cli.ok) {
    return { id, status: 'fail', messageKey: 'doctor.claude_real.version', params: { bin, output: cli.params.output } };
  }
  return { id, status: 'ok', messageKey: 'doctor.claude_real.ok', params: { bin, version: cli.version } };
}

// Every option buildArgv can put on a round's command line, derived from
// buildArgv itself so this list cannot fall behind it: since phase 3 that
// includes --disable-slash-commands and --tools, which pin the round's
// built-in tools and keep every skill out. A value is not an option: the
// empty string after --setting-sources and the tool list after --tools
// are left out by the filter.
export function roundFlags() {
  return buildArgv({ model: 'm', maxTurns: 1, budgetUsd: 1, allowed: ['Read(./**)'], disallowed: ['WebFetch'] })
    .filter((arg) => /^--?[A-Za-z]/.test(arg));
}

// Flags a round passes that the CLI's own --help does not list, measured
// to work anyway: Claude Code 2.1.281 hides --max-turns from its help, and
// every spike run of 24/09/2026 used it. `--version` cannot stand in as a
// probe: the CLI prints its version and exits 0 whatever other flag it is
// given, an unknown one included.
export const HIDDEN_FLAGS = Object.freeze(['--max-turns']);

function listsFlag(help, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,\\[(])${escaped}(?=$|[\\s,=<\\[\\])])`, 'm').test(help);
}

// The isolation of a round is a set of flags (src/harness/claude-code.mjs);
// a CLI that does not know one of them either refuses the whole command
// line or, worse, a later version drops a flag and the round runs with the
// person's own settings. The installed CLI's own --help is asked for every
// flag the round uses.
function claudeIsolationFlags(ctx) {
  const id = 'claude-isolation-flags';
  const inputs = curateInputs(ctx, id);
  if (inputs.result) return inputs.result;
  if (inputs.disabled) return curateDisabled(ctx, id);
  const target = claudeToRun(ctx, id);
  if (target.result) return target.result;
  const bin = target.bin;
  const r = probe(ctx, bin, ['--help']);
  if (r.status !== 0) {
    return { id, status: 'fail', messageKey: 'doctor.claude_isolation_flags.failed', params: { bin, status: r.status } };
  }
  const flags = roundFlags().filter((flag) => !HIDDEN_FLAGS.includes(flag));
  const missing = flags.filter((flag) => !listsFlag(r.stdout, flag));
  if (missing.length > 0) {
    return { id, status: 'fail', messageKey: 'doctor.claude_isolation_flags.missing', params: { bin, missing, command: UPDATE_CLAUDE_COMMAND } };
  }
  return { id, status: 'ok', messageKey: 'doctor.claude_isolation_flags.ok', params: { bin, count: flags.length, hidden: HIDDEN_FLAGS } };
}

// The transcripts source reads only the projects the configuration lists
// (src/sources/transcripts-claude-code.mjs): an empty list, or one naming
// directories that are not there, makes every round refuse or read less
// than the person thinks. A listed project that cannot be read makes the
// round exit 4; one that is missing is a warning in the round, and here.
function includeProjects(ctx) {
  const id = 'include-projects';
  const inputs = curateInputs(ctx, id);
  if (inputs.result) return inputs.result;
  if (inputs.disabled) return curateDisabled(ctx, id);
  const { config } = inputs;
  const file = ctx.configFile;
  const key = INCLUDE_PROJECTS_KEY;
  const sources = [...(config.curate?.sources?.required ?? []), ...(config.curate?.sources?.best_effort ?? [])];
  if (!sources.includes('transcripts')) {
    return { id, status: 'ok', messageKey: 'doctor.include_projects.not_used', params: { file } };
  }
  const listed = config.sources?.transcripts?.include_projects;
  const projects = [...new Set(Array.isArray(listed) ? listed.filter((p) => typeof p === 'string' && p !== '') : [])];
  const configured = machineObject(ctx)?.transcripts_dir;
  const root = expandHome(typeof configured === 'string' && configured !== '' ? configured : DEFAULT_TRANSCRIPTS_DIR, ctx.env);
  if (projects.length === 0) {
    return { id, status: 'fail', messageKey: 'doctor.include_projects.empty', params: { file, key, root } };
  }
  if (!isDirectory(root)) {
    return { id, status: 'fail', messageKey: 'doctor.include_projects.root_missing', params: { root, command: SET_TRANSCRIPTS_COMMAND } };
  }
  let names;
  try {
    names = new Set(readdirSync(root));
  } catch (error) {
    return { id, status: 'fail', messageKey: 'doctor.include_projects.root_unreadable', params: { root, error: error.code ?? error.message } };
  }
  const missing = [];
  const unreadable = [];
  for (const project of projects) {
    const dir = join(root, project);
    if (!names.has(project) || !isDirectory(dir)) {
      missing.push(project);
      continue;
    }
    try {
      readdirSync(dir);
    } catch {
      unreadable.push(project);
    }
  }
  if (unreadable.length > 0) {
    return { id, status: 'fail', messageKey: 'doctor.include_projects.unreadable', params: { projects: unreadable, root } };
  }
  if (missing.length === projects.length) {
    return { id, status: 'fail', messageKey: 'doctor.include_projects.all_missing', params: { projects: missing, root, file, key } };
  }
  if (missing.length > 0) {
    return { id, status: 'warn', messageKey: 'doctor.include_projects.some_missing', params: { projects: missing, root, file, key } };
  }
  return { id, status: 'ok', messageKey: 'doctor.include_projects.ok', params: { count: projects.length, root } };
}

// Per source: the last day a round swept, and how far behind yesterday it
// is. Rounds catch up oldest first, a few days at a time, so a mark more
// than WATERMARK_BEHIND_WARN_DAYS behind says rounds are not closing days.
function watermarkCheck(ctx) {
  const id = 'watermark';
  const inputs = curateInputs(ctx, id);
  if (inputs.result) return inputs.result;
  if (inputs.disabled) return curateDisabled(ctx, id);
  const { config } = inputs;
  const timezone = config.vault?.timezone;
  let yesterday;
  try {
    yesterday = addDays(localDay(ctx.now, timezone), -1);
  } catch {
    return { id, status: 'warn', messageKey: 'doctor.watermark.bad_timezone', params: { timezone: String(timezone), file: ctx.configFile } };
  }
  let mark;
  try {
    mark = readWatermark(ctx.stateDir);
  } catch (error) {
    if (!(error instanceof WatermarkError)) throw error;
    return { id, status: 'fail', messageKey: 'doctor.watermark.unreadable', params: { file: error.file, detail: error.detail } };
  }
  const required = Array.isArray(config.curate?.sources?.required) ? config.curate.sources.required : [];
  const ids = [...new Set([...required, ...Object.keys(mark.sources)])].sort();
  const future = ids.filter((source) => mark.sources[source] !== undefined && mark.sources[source] > yesterday);
  if (future.length > 0) {
    const source = future[0];
    const command = `brain-kit watermark reopen ${source} ${yesterday}`;
    return { id, status: 'fail', messageKey: 'doctor.watermark.future', params: { source, day: shownDay(mark.sources[source]), command } };
  }
  const unset = ids.filter((source) => mark.sources[source] === undefined);
  const marks = ids.filter((source) => mark.sources[source] !== undefined)
    .map((source) => `${source} ${shownDay(mark.sources[source])} (${daysBetween(mark.sources[source], yesterday)})`);
  const behind = ids.filter((source) => mark.sources[source] !== undefined && daysBetween(mark.sources[source], yesterday) > WATERMARK_BEHIND_WARN_DAYS);
  if (behind.length > 0) {
    return { id, status: 'warn', messageKey: 'doctor.watermark.behind', params: { sources: behind, marks, limit: WATERMARK_BEHIND_WARN_DAYS, command: CURATE_COMMAND } };
  }
  if (ids.length === 0 || unset.length > 0) {
    return { id, status: 'warn', messageKey: 'doctor.watermark.unset', params: { sources: unset.length > 0 ? unset : ['-'], command: CURATE_COMMAND } };
  }
  return { id, status: 'ok', messageKey: 'doctor.watermark.ok', params: { marks } };
}

// The last round, as last-run.json records it (src/commands/curate.mjs,
// step 18). A green round that took seconds and never gave the model a
// turn is dead, whatever its exit code says (docs/incidents.md, 21/08/2026).
function lastRunCheck(ctx) {
  const id = 'last-run';
  const inputs = curateInputs(ctx, id);
  if (inputs.result) return inputs.result;
  if (inputs.disabled) return curateDisabled(ctx, id);
  const file = join(ctx.stateDir, STATE_FILES.LAST_RUN);
  const logs = join(ctx.stateDir, STATE_FILES.LOG_DIR);
  const read = readJsonFile(file);
  if (!read.ok && read.missing) {
    return { id, status: 'warn', messageKey: 'doctor.last_run.none', params: { file, command: CURATE_COMMAND } };
  }
  if (!read.ok) {
    return { id, status: 'fail', messageKey: 'doctor.last_run.unreadable', params: { file, error: read.error } };
  }
  const run = read.value;
  if (!isObject(run) || !Number.isInteger(run.exit)) {
    return { id, status: 'fail', messageKey: 'doctor.last_run.no_exit', params: { file } };
  }
  const at = shownInstant(run.at);
  const exit = run.exit;
  const seconds = Number.isFinite(run.durationMs) ? Math.round(run.durationMs / 1000) : '-';
  const reason = typeof run.reason === 'string' && run.reason !== '' ? run.reason : '-';
  const turns = Number.isInteger(run.numTurns) ? run.numTurns : 0;
  const cost = typeof run.costUsd === 'number' && Number.isFinite(run.costUsd) ? run.costUsd : '-';
  if (exit === EXIT.OK) {
    const modelRound = !NO_MODEL_REASONS.includes(run.reasonCode);
    if (modelRound && Number.isFinite(run.durationMs) && run.durationMs < DEAD_ROUND_MS && turns === 0) {
      return { id, status: 'fail', messageKey: 'doctor.last_run.dead', params: { at, seconds, logs, command: `${CURATE_COMMAND} --keep-stream` } };
    }
    return { id, status: 'ok', messageKey: 'doctor.last_run.ok', params: { at, seconds, turns, cost, reason } };
  }
  if (SOFT_EXITS.includes(exit)) {
    return { id, status: 'warn', messageKey: 'doctor.last_run.soft', params: { at, exit, seconds, reason, logs } };
  }
  return { id, status: 'fail', messageKey: 'doctor.last_run.failed', params: { at, exit, seconds, reason, logs } };
}

// `brain-kit schedule status`, asked in process with a translator that
// records what status said instead of saying it: the check answers from
// the same code, never from a second reading of the scheduler.
function scheduleCheck(ctx) {
  const id = 'schedule';
  const inputs = curateInputs(ctx, id);
  if (inputs.result) return inputs.result;
  const said = [];
  const record = (key, params = {}) => {
    said.push({ key, params });
    return key;
  };
  const quiet = { write: () => {} };
  let code;
  try {
    code = runScheduleSync(['status', ctx.root], { stdout: quiet, stderr: quiet }, record, { env: ctx.env, cwd: ctx.root, now: ctx.now });
  } catch (error) {
    return { id, status: 'warn', messageKey: 'doctor.schedule.unknown', params: { error: error.message } };
  }
  const saidKey = (key) => said.find((entry) => entry.key === key) ?? null;
  const active = saidKey('schedule.status_active');
  const outdated = saidKey('schedule.status_outdated');
  const inactive = saidKey('schedule.status_inactive');
  const installed = active ?? outdated ?? inactive;
  if (inputs.disabled) {
    if (installed === null) return curateDisabled(ctx, id);
    const { name, platform } = installed.params;
    return { id, status: 'warn', messageKey: 'doctor.schedule.disabled_installed', params: { name, platform, file: ctx.configFile, command: SCHEDULE_UNINSTALL_COMMAND } };
  }
  if (active !== null && code === EXIT.OK) {
    const { name, platform } = active.params;
    const times = saidKey('schedule.status_next')?.params.times ?? [];
    return { id, status: 'ok', messageKey: 'doctor.schedule.ok', params: { name, platform, times } };
  }
  if (inactive !== null) {
    const { name, platform, detail } = inactive.params;
    return { id, status: 'fail', messageKey: 'doctor.schedule.inactive', params: { name, platform, detail, command: SCHEDULE_INSTALL_COMMAND } };
  }
  if (outdated !== null) {
    const { name, platform } = outdated.params;
    return { id, status: 'warn', messageKey: 'doctor.schedule.outdated', params: { name, platform, command: SCHEDULE_INSTALL_COMMAND } };
  }
  const elsewhere = saidKey('schedule.found_elsewhere');
  if (elsewhere !== null) {
    const { name, platform, platforms } = elsewhere.params;
    return { id, status: 'warn', messageKey: 'doctor.schedule.elsewhere', params: { name, platform, platforms } };
  }
  const absent = saidKey('schedule.status_not_installed');
  if (absent !== null) {
    const { name, platform } = absent.params;
    return { id, status: 'warn', messageKey: 'doctor.schedule.not_installed', params: { name, platform, command: SCHEDULE_INSTALL_COMMAND } };
  }
  // Status refused before it could look (claude not found, an overnight
  // window, a vault that moved...): its own first complaint, in its own
  // words, which already name what to change.
  const first = said[0];
  if (first !== undefined) return { id, status: 'fail', messageKey: first.key, params: first.params };
  return { id, status: 'fail', messageKey: 'doctor.schedule.unknown', params: { error: String(code) } };
}

// Where a failed round is announced. Without a notify command a failure
// is only in the log and last-run.json, which nobody reads until the
// vault has gone quiet for days (docs/incidents.md, 13/09/2026). The
// command is found, never run: running it would send a notification.
function notifyCheck(ctx) {
  const id = 'notify';
  const inputs = curateInputs(ctx, id);
  if (inputs.result) return inputs.result;
  if (inputs.disabled) return curateDisabled(ctx, id);
  const machine = machineObject(ctx);
  const logs = join(ctx.stateDir, STATE_FILES.LOG_DIR);
  const argv = machine?.notify_command;
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string' || argv[0] === '') {
    return { id, status: 'warn', messageKey: 'doctor.notify.unset', params: { logs, command: SET_NOTIFY_COMMAND } };
  }
  const program = argv[0];
  const extra = Array.isArray(machine.path_extra) ? machine.path_extra : [];
  const resolved = resolveClaude(program, extra, ctx.env, ctx.root);
  if (!resolved) {
    return { id, status: 'warn', messageKey: 'doctor.notify.not_found', params: { program, logs, command: SET_NOTIFY_COMMAND } };
  }
  return { id, status: 'ok', messageKey: 'doctor.notify.ok', params: { program: resolved } };
}

// id -> check, in the order the report prints them.
export const CHECKS = new Map([
  ['node-version', nodeVersion],
  ['git-present', gitPresent],
  ['default-branch-known', defaultBranchKnown],
  ['hooks-path', hooksPath],
  ['brain-kit-on-path', brainKitOnPath],
  ['config-valid', configValid],
  ['manifest-valid', manifestValid],
  ['machine-valid', machineValid],
  ['state-dir-resolves', stateDirResolves],
  ['state-dir-mode', stateDirMode],
  ['kit-version', kitVersionCheck],
  ['gh-present', ghPresent],
  ['claude-present', claudePresent],
  ['gitignore-node-modules', gitignoreNodeModules],
  ['claude-real', claudeReal],
  ['claude-isolation-flags', claudeIsolationFlags],
  ['include-projects', includeProjects],
  ['watermark', watermarkCheck],
  ['last-run', lastRunCheck],
  ['schedule', scheduleCheck],
  ['notify', notifyCheck],
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
