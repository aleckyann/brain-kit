import { lstatSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { run } from '../exec.mjs';
import { localGitVarNames, withoutLocalGitVars } from '../git-env.mjs';
import { MANIFEST_PATH, readManifest, serializeManifest } from '../manifest.mjs';
import { HOOK_PATH, TEMPLATE_HOOK, rollback, writeGateHook, writeNew } from './skeleton.mjs';

// installGate: the ONE function that puts the adopter's push gate into a
// vault that already exists. `init --adopt` calls it by default, and
// `brain-kit update --install-hook` calls it for a vault adopted earlier
// (or one whose hook was deleted). `init` itself writes the same hook
// through the same writer (writeGateHook, src/init/skeleton.mjs) into the
// repository it has just created, where there is nothing of the person's
// to leave alone.
//
// What it does, when nothing of the person's is in the way:
//   1. writes .githooks/pre-push from the template, exclusively, and makes
//      it executable;
//   2. sets core.hooksPath to .githooks in the repository's own
//      configuration, when no core.hooksPath is in effect;
//   3. records the hook as `managed` in .brain-kit/manifest.json, so
//      `update` keeps it current.
// A failure at any step undoes the steps before it, and says so.
//
// What it never does is replace or disconnect a hook a person already
// has. Each of these leaves everything exactly as it was and prints the
// one line that adds the gate to the hook git does run:
//   - a .githooks/pre-push already there (anything at that path, a link
//     included), unless it is byte for byte the template and already runs,
//     which is "already installed";
//   - a core.hooksPath in effect that points anywhere else, the person's
//     global configuration included: setting a local one would switch
//     every hook of that directory off for this repository;
//   - no core.hooksPath and a hook in git's own hooks directory
//     (.git/hooks, anything but git's *.sample files): pointing
//     core.hooksPath at .githooks would switch it off.
// Where no gate can run at all (not a repository, or a vault below the
// top of its repository, where the hook would run brain-kit from the top
// level and refuse every push), nothing is written and the line says why.
//
// Every git command runs with the variables that move git to another
// repository removed (src/git-env.mjs) and GIT_OPTIONAL_LOCKS=0.
//
// Returns { outcome, messageKey, params }:
//   installed  the gate was written and wired;
//   already    it was already there and running;
//   left       something of the person's is in the way, left untouched;
//   refused    no gate can run here, nothing written;
//   failed     a step failed, and what it wrote was removed.

export const HOOKS_DIR = dirname(HOOK_PATH);
export const INSTALL_HOOK_COMMAND = 'brain-kit update --install-hook';
export const SET_HOOKS_PATH_COMMAND = `git config core.hooksPath ${HOOKS_DIR}`;
// The line a person adds to a pre-push hook of their own. push-gate reads
// the reference lines git hands the hook on standard input, and git's own
// two arguments.
export const GATE_LINE = 'brain-kit push-gate "$1" "$2" --patterns config';

function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

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

function firstLine(text) {
  return String(text ?? '').trim().split(/\r?\n/)[0] ?? '';
}

function gitEnvFor(env) {
  return { ...withoutLocalGitVars(env, localGitVarNames(env)), GIT_OPTIONAL_LOCKS: '0' };
}

// Reads only. { state, ... } for what installGate would do.
export function inspectGate(root, gitEnv) {
  const git = (args) => run('git', args, { cwd: root, env: gitEnv });
  const top = git(['rev-parse', '--show-toplevel']);
  const topLevel = firstLine(top.stdout);
  if (top.status !== 0 || !isAbsolute(topLevel)) return { state: 'no_repo' };
  if (!samePlace(topLevel, root)) return { state: 'not_top_level', top: topLevel };

  const hook = join(root, HOOK_PATH);
  // The EFFECTIVE value, the one git uses, global configuration included;
  // `--type=path` expands "~/" the way git does when it reads it.
  const cfg = git(['config', '--type=path', '--get', 'core.hooksPath']);
  const value = cfg.status === 0 ? cfg.stdout.replace(/\r?\n$/, '') : '';
  if (cfg.status !== 0 && cfg.status !== 1) return { state: 'unreadable', status: cfg.status };
  const pathSet = value !== '';
  const ours = pathSet && samePlace(resolve(topLevel, value), join(root, HOOKS_DIR));

  if (present(hook)) {
    let isTemplate = false;
    try {
      isTemplate = lstatSync(hook).isFile() && readFileSync(hook).equals(readFileSync(TEMPLATE_HOOK));
    } catch {
      // Unreadable: not something this function can call the template.
    }
    if (isTemplate && ours) return { state: 'already', hook };
    if (isTemplate && !pathSet) return { state: 'unwired', hook };
    return { state: 'hook_present', hook };
  }
  if (pathSet && !ours) return { state: 'hooks_path_elsewhere', value, hook: join(resolve(topLevel, value), 'pre-push') };
  if (!pathSet) {
    const listed = git(['rev-parse', '--git-path', 'hooks']);
    if (listed.status !== 0) return { state: 'unreadable', status: listed.status };
    const dir = resolve(root, firstLine(listed.stdout));
    let names = [];
    try {
      names = readdirSync(dir).filter((name) => !name.endsWith('.sample')).sort();
    } catch (error) {
      if (error.code !== 'ENOENT') return { state: 'unreadable', status: error.code ?? error.message };
    }
    if (names.length > 0) return { state: 'default_hooks', dir, hooks: names, hook: join(dir, 'pre-push') };
  }
  return { state: 'install', setHooksPath: !pathSet, hook };
}

// The manifest with the hook's entry in it, replacing whatever entry the
// path had (a hook deleted since init, say), written the way update
// writes it: to a temporary file beside it, renamed over it.
function recordHook(root, manifest, entry) {
  const files = manifest.files.filter((item) => item.path !== HOOK_PATH);
  files.push(entry);
  const text = serializeManifest({ ...manifest, files });
  const file = join(root, MANIFEST_PATH);
  const mode = statSync(file).mode & 0o7777;
  const tmp = join(dirname(file), `.${basename(file)}.brain-kit-tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  writeNew([], tmp, text, mode);
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone.
    }
    throw error;
  }
}

export function installGate(root, { env = process.env } = {}) {
  const gitEnv = gitEnvFor(env);
  const found = inspectGate(root, gitEnv);
  const line = GATE_LINE;
  switch (found.state) {
    case 'already': return { outcome: 'already', messageKey: 'gate.already', params: { hook: found.hook } };
    case 'unwired': return { outcome: 'left', messageKey: 'gate.unwired', params: { hook: found.hook, command: SET_HOOKS_PATH_COMMAND } };
    case 'hook_present': return { outcome: 'left', messageKey: 'gate.hook_present', params: { hook: found.hook, line } };
    case 'hooks_path_elsewhere': return { outcome: 'left', messageKey: 'gate.hooks_path_elsewhere', params: { value: found.value, hook: found.hook, line } };
    case 'default_hooks': return { outcome: 'left', messageKey: 'gate.default_hooks', params: { dir: found.dir, hooks: found.hooks, hook: found.hook, line } };
    case 'no_repo': return { outcome: 'refused', messageKey: 'gate.no_repo', params: { dir: root, command: INSTALL_HOOK_COMMAND } };
    case 'not_top_level': return { outcome: 'refused', messageKey: 'gate.not_top_level', params: { dir: root, top: found.top, line } };
    case 'unreadable': return { outcome: 'refused', messageKey: 'gate.unreadable', params: { status: found.status } };
    default: break;
  }

  // found.state === 'install'. The manifest is read first: a vault whose
  // manifest cannot be read gets no hook it could not record.
  let manifest;
  try {
    manifest = readManifest(root);
  } catch (error) {
    return { outcome: 'failed', messageKey: 'gate.failed', params: { detail: error.message, command: INSTALL_HOOK_COMMAND } };
  }
  const ledger = [];
  let pathSetHere = false;
  try {
    const entry = writeGateHook(ledger, root);
    if (found.setHooksPath) {
      const set = run('git', ['config', 'core.hooksPath', HOOKS_DIR], { cwd: root, env: gitEnv });
      if (set.status !== 0) throw new Error(`git config core.hooksPath ${HOOKS_DIR}: ${set.stderr.trim()}`);
      pathSetHere = true;
    }
    recordHook(root, manifest, entry);
  } catch (error) {
    if (pathSetHere) run('git', ['config', '--unset', 'core.hooksPath'], { cwd: root, env: gitEnv });
    rollback(ledger);
    return { outcome: 'failed', messageKey: 'gate.failed', params: { detail: error.message, command: INSTALL_HOOK_COMMAND } };
  }
  if (found.setHooksPath) return { outcome: 'installed', messageKey: 'gate.installed', params: { hook: found.hook } };
  return { outcome: 'installed', messageKey: 'gate.installed_path_kept', params: { hook: found.hook } };
}
