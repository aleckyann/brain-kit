// The `propose` command: the only way an agent's work reaches a vault, as a
// pull request against the default branch.
//
//   brain-kit propose "<summary>" (--only <path>... | --all [--yes]) [--dry]
//
// It exists because of docs/incidents.md, section "Git and pull requests":
// 10/08/2026 (one variable meant both the branch to return to and the
// branch to target, and pull requests went to yesterday's branch);
// 08/09/2026 (success left the repository on the new branch); 29/07/2026
// (two rounds in one tree at once); 16/09/2026 (a blanket `git add -A`
// nearly swept another session's unfinished files into a pull request).
//
// THE COMMIT IS BUILT WITH GIT PLUMBING, AND HEAD, THE INDEX AND THE
// WORKING TREE NEVER MOVE. The remote default branch's tip, fetched and
// proved, is read into a temporary index (GIT_INDEX_FILE naming a file in
// a private temporary directory); exactly the chosen paths' working-tree
// contents are added to it (`git update-index --add --remove`, so a deleted
// path is removed); the tree is written and committed with that tip as its
// only parent, under the configured agent identity (this command's designed
// author), and the commit is pushed straight to a new remote branch. So:
// a local commit that was never published cannot ride into the pull
// request (the parent is the remote's tip, not HEAD); another session's
// staged or unstaged work is never read, staged or moved (the real index
// is never written); and "return to the origin branch in every outcome" is
// true by construction, because nothing ever left it. No commit hook runs
// (commit-tree runs none); the push runs the vault's pre-push gate as any
// push does.
//
// In order, under the vault's lock (src/guards/lock.mjs), released in
// every outcome:
//
//   1. An operation left half done (rebase, merge, cherry-pick, revert,
//      bisection) postpones the run, exit 75. A vault that is not the top
//      level of its repository is exit 2.
//   2. A clean working tree is exit 0, "nothing to propose", in one line.
//   3. The paths. `--only`: every listed path must be inside the vault and
//      dirty now, or the run refuses naming each one, exit 2; the session
//      snapshot plays no part. `--all`: every dirty path, but a path the
//      session snapshot (src/guards/snapshot.mjs, taken at session or round
//      start by its caller; this command never takes one) recorded as
//      already there is refused, exit 75, naming it, unless `--yes`; with
//      no snapshot, or one taken more than a day ago (or in the future),
//      `--all` requires `--yes`, exit 75.
//   4. `validate` and `lint --base worktree` over the working tree; either
//      failing is exit 1, their report printed.
//   5. origin (the branch checked out, named in messages only) and base
//      (the remote default branch: the one resolver, src/git.mjs
//      defaultBranch, then the upstream it tracks, as sync reads it) are
//      two variables that never share a meaning. A base that cannot be
//      resolved is exit 1.
//   6. `--dry` stops here, prints the plan and exits 0: before any fetch,
//      so it moves no reference at all, the remote-tracking one included.
//   7. The base is fetched and the fetch proved (src/git.mjs, fetch);
//      anything short of a proved tip is exit 1. Every chosen path must
//      then be the same at HEAD as at that tip: an edit made on a version
//      the base does not hold (a branch behind the remote, or a previous
//      round's unmerged commit) would silently revert or carry that
//      difference. Otherwise exit 1, naming the paths.
//   8. The commit is built as above, and the paths it changes against the
//      base tip must be exactly the chosen ones, or exit 1. It is pushed to
//      `<branch_prefix><YYYY-MM-DD-HH-MM-SS>` (UTC), refusing to replace a
//      branch the remote already has, and the remote is asked whether it
//      now holds that commit. A failure here is exit 1: nothing was
//      published, and the working tree still holds everything.
//   9. `gh pr create --base <base> --head <branch> --title <title>
//      --body-file <body>`, then `gh pr view <branch> --json
//      baseRefName,headRefName,url`, which must name the base and the
//      branch. `gh` absent, failing, unauthenticated, unreadable, or
//      reporting another base is exit 3 (a published commit without a
//      confirmed pull request), naming the exact command that finishes by
//      hand; the rendered body is then left on disk for that command.
//
// Declared, not handled: `validate` and `lint` judge the working tree,
// not the proposed tree, so a chosen note that links to a file left out of
// the proposal passes here and is broken in the pull request; a path
// whose name is not valid UTF-8 never gets past `lint`, which cannot scan
// it (paths are still handed to git as the bytes it printed); `gh` chooses the
// repository from the checkout's remotes itself, and only the base and
// head names it reports back are checked.
//
// `deps` hands in the environment, the working directory, the clock, the
// temporary directory and walkVault, for the tests and for src/cli.mjs.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, loadConfig } from '../config.mjs';
import { findVaultRoot } from '../vault.mjs';
import { decodeBytes } from '../io.mjs';
import { run } from '../exec.mjs';
import { KIT_ROOT } from '../version.mjs';
import { PR_BODY_PATH } from '../init/skeleton.mjs';
import { acquireLock } from '../guards/lock.mjs';
import { GuardError } from '../guards/location.mjs';
import { readSnapshot, splitDirty } from '../guards/snapshot.mjs';
import {
  currentBranch, defaultBranch, defaultBranchUpstream, dirtyPathBytes, fetch, gitEnv, isBranchName, operationInProgress, resolveCommit, runGit,
  trackedRemote,
} from '../git.mjs';
import { runValidate } from './validate.mjs';
import { runLint } from './lint.mjs';

const ROOT_INDEX = 'index.md';
const DAY_MS = 24 * 60 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 120000;
const DEFAULT_TITLE = '{{commit_prefix}} {{summary}}';
const GIT_OPTS = { maxBuffer: 256 * 1024 * 1024 };

class Refusal extends Error {
  constructor(exitCode, text) {
    super(text);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const result = { summary: undefined, only: null, all: false, yes: false, dry: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--all') result.all = true;
    else if (arg === '--yes') result.yes = true;
    else if (arg === '--dry') result.dry = true;
    else if (arg === '--only') {
      if (result.only !== null) return { error: 'argument', arg };
      result.only = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) result.only.push(argv[++i]);
    } else if (arg.startsWith('-')) return { error: 'argument', arg };
    else if (result.summary === undefined) result.summary = arg;
    else return { error: 'argument', arg };
  }
  return result;
}

// A value as a person could paste it into a POSIX shell. Only ever
// printed, never run: every command this module runs is an argument array.
function quoted(value) {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

function commandLine(program, args) {
  return [program, ...args].map(quoted).join(' ');
}

// {{name}} placeholders, replaced in ONE pass, so a summary that itself
// contains "{{commit_prefix}}" is carried as written, never expanded.
function render(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (Object.hasOwn(values, key) ? values[key] : match));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function branchStamp(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}`;
}

function detailOf(result) {
  return String(result.stderr || result.stdout || `exit status ${result.status}`).trim().split(/\r?\n/)[0];
}

function git(root, args, env, { index = null, extraEnv = {}, ...options } = {}) {
  const base = gitEnv(env);
  const childEnv = index === null ? { ...base, ...extraEnv } : { ...base, ...extraEnv, GIT_INDEX_FILE: index };
  return run('git', args, { cwd: root, ...GIT_OPTS, ...options, env: childEnv });
}

function gitOrFail(root, args, env, options) {
  const result = git(root, args, env, options);
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? decodeBytes(result.stderr) : String(result.stderr);
    throw new Error(`git ${args.join(' ')} exited with status ${result.status}: ${stderr.trim()}`);
  }
  return result;
}

function captureIo() {
  let text = '';
  const sink = { write: (s) => { text += s; } };
  return { io: { stdout: sink, stderr: sink }, text: () => text };
}

export async function runPropose(argv, io, t, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const walkVault = deps.walkVault;
  const temp = deps.tmpdir ?? tmpdir();
  const parsed = parseArgs(argv);
  if (parsed.error) {
    io.stderr.write(`${t('propose.bad_argument', { arg: parsed.arg })}\n`);
    io.stderr.write(`${t('propose.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.help) {
    io.stdout.write(`${t('propose.usage')}\n`);
    return EXIT.OK;
  }
  const usage = (text) => {
    io.stderr.write(`${text}\n`);
    io.stderr.write(`${t('propose.usage')}\n`);
    return EXIT.USAGE;
  };
  if (parsed.summary === undefined || parsed.summary.trim() === '') return usage(t('propose.no_summary'));
  if ((parsed.only !== null) === parsed.all) return usage(t('propose.mode_required'));
  if (parsed.only !== null && parsed.only.length === 0) return usage(t('propose.only_empty'));
  if (parsed.yes && !parsed.all) return usage(t('propose.yes_without_all'));

  const root = findVaultRoot(cwd);
  if (!root) {
    io.stderr.write(`${t('propose.no_vault', { dir: cwd, config: CONFIG_FILENAME, index: ROOT_INDEX })}\n`);
    return EXIT.USAGE;
  }
  const config = loadConfig(root);

  let lock;
  try {
    lock = acquireLock(root, { command: 'propose', env });
  } catch (error) {
    if (error instanceof GuardError) {
      io.stderr.write(`${t(error.messageKey, error.params)}\n`);
      return error.exitCode;
    }
    throw error;
  }
  // Two private temporary directories: the index, always removed; the
  // rendered body, kept when the run ends degraded, for the finishing
  // command that names it.
  const scratch = { work: null, body: null, keep: false };
  try {
    return await proposeUnderLock({ root, cwd, config, parsed, io, t, env, now, walkVault, scratch, temp });
  } catch (error) {
    if (error instanceof Refusal) {
      io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof GuardError) {
      io.stderr.write(`${t(error.messageKey, error.params)}\n`);
      return error.exitCode;
    }
    io.stderr.write(`${t('propose.git_failed', { detail: error.message })}\n`);
    return EXIT.FAILURE;
  } finally {
    try {
      if (scratch.work !== null) rmSync(scratch.work, { recursive: true, force: true });
      if (scratch.body !== null && !scratch.keep) rmSync(scratch.body, { recursive: true, force: true });
    } finally {
      lock.release();
    }
  }
}

async function proposeUnderLock({ root, cwd, config, parsed, io, t, env, now, walkVault, scratch, temp }) {
  const operation = operationInProgress(root, { env });
  if (operation !== null) throw new Refusal(EXIT.TEMPFAIL, t('propose.operation_in_progress', { operation }));
  const prefix = runGit(root, ['rev-parse', '--show-prefix'], { env });
  if (prefix.status !== 0) throw new Error(`git rev-parse --show-prefix exited with status ${prefix.status}: ${prefix.stderr.trim()}`);
  if (prefix.stdout.replace(/\n$/, '') !== '') {
    throw new Refusal(EXIT.USAGE, t('propose.not_toplevel', { dir: root, prefix: prefix.stdout.trim() }));
  }

  const dirty = dirtyPathBytes(root, { env });
  if (dirty.length === 0) {
    io.stdout.write(`${t('propose.nothing_to_propose')}\n`);
    return EXIT.OK;
  }
  const chosen = parsed.all ? chooseAll(root, dirty, parsed, t, env, now) : chooseOnly(root, cwd, dirty, parsed.only, t);
  const names = chosen.map((path) => decodeBytes(path));

  await gate(root, t, walkVault);

  // origin: where HEAD is, and stays. base: the remote default branch the
  // pull request targets. Never the same variable (docs/incidents.md,
  // 10/08/2026).
  const origin = currentBranch(root, { env }) ?? resolveCommit(root, 'HEAD', { env }) ?? '-';
  const { remote, base } = resolveBase(root, t, env);

  const gitConfig = config.git;
  const title = render(gitConfig.pr_title ?? DEFAULT_TITLE, { commit_prefix: gitConfig.commit_prefix, summary: parsed.summary });
  const branch = `${gitConfig.branch_prefix}${branchStamp(now())}`;
  if (!isBranchName(root, branch, { env }) || branch === base) throw new Refusal(EXIT.FAILURE, t('propose.branch_invalid', { branch }));

  if (parsed.dry) {
    io.stdout.write(`${t('propose.dry_run', { files: names, remote, base, branch, title, origin })}\n`);
    return EXIT.OK;
  }

  const tip = fetchBase(root, t, env, remote, base);
  sameAtHeadAndTip(root, t, env, chosen, tip, base);

  // Everything that can fail on this machine is done before the push: after
  // it, every failure is a published commit without a pull request.
  const files = names.map((name) => `- \`${name}\``).join('\n');
  const body = render(readBodyTemplate(root, config, t), { summary: parsed.summary, files, base, branch });
  scratch.body = realpathSync(mkdtempSync(join(temp, 'brain-kit-propose-body-')));
  const bodyFile = join(scratch.body, 'pr-body.md');
  writeFileSync(bodyFile, body);
  scratch.work = realpathSync(mkdtempSync(join(temp, 'brain-kit-propose-index-')));
  const commit = buildCommit(root, t, env, { chosen, tip, title, identity: gitConfig.agent_identity, index: join(scratch.work, 'index') });
  push(root, t, env, { remote, branch, commit });
  return openPullRequest(root, io, t, env, { program: gitConfig.pr_command, base, branch, title, bodyFile, scratch, count: names.length, origin });
}

// --only: each path is inside the vault and dirty now, or the run refuses
// naming every one that is not.
function chooseOnly(root, cwd, dirty, listed, t) {
  const known = new Map(dirty.map((path) => [path.toString('hex'), path]));
  const outside = [];
  const clean = [];
  const chosen = new Map();
  for (const given of listed) {
    const rel = relative(root, resolve(cwd, given));
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      outside.push(given);
      continue;
    }
    const path = Buffer.from(rel.split(sep).join('/'), 'utf8');
    const key = path.toString('hex');
    if (known.has(key)) chosen.set(key, known.get(key));
    else clean.push(given);
  }
  if (outside.length > 0) throw new Refusal(EXIT.USAGE, t('propose.outside_vault', { paths: outside, dir: root }));
  if (clean.length > 0) throw new Refusal(EXIT.USAGE, t('propose.not_dirty', { paths: clean }));
  return [...chosen.values()].sort(Buffer.compare);
}

// --all: every dirty path, but never one the session snapshot recorded as
// already there, and never without a recent snapshot, unless --yes.
function chooseAll(root, dirty, parsed, t, env, now) {
  if (parsed.yes) return dirty;
  const snapshot = readSnapshot(root, { env });
  if (snapshot === null) throw new Refusal(EXIT.TEMPFAIL, t('propose.no_snapshot'));
  const age = now().getTime() - Date.parse(snapshot.at);
  if (!(age >= 0 && age <= DAY_MS)) throw new Refusal(EXIT.TEMPFAIL, t('propose.stale_snapshot', { at: snapshot.at }));
  const { before } = splitDirty(root, snapshot, { env });
  if (before.length > 0) {
    throw new Refusal(EXIT.TEMPFAIL, t('propose.dirty_before', { files: before.map((path) => decodeBytes(path)), at: snapshot.at }));
  }
  return dirty;
}

// validate, then lint over the working tree. Their report is printed only
// when one fails.
async function gate(root, t, walkVault) {
  const validation = captureIo();
  const validated = await runValidate([root, '--only-problems'], validation.io, t, walkVault);
  if (validated !== EXIT.OK) throw new Refusal(EXIT.FAILURE, `${validation.text()}${t('propose.validate_failed', { code: validated })}`);
  const linting = captureIo();
  const linted = await runLint([root, '--base', 'worktree'], linting.io, t, walkVault);
  if (linted !== EXIT.OK) throw new Refusal(EXIT.FAILURE, `${linting.text()}${t('propose.lint_failed', { code: linted })}`);
}

function configuredRemotes(root, env) {
  const listed = runGit(root, ['remote'], { env });
  if (listed.status !== 0) throw new Error(`git remote exited with status ${listed.status}: ${listed.stderr.trim()}`);
  return listed.stdout.split('\n').filter((name) => name !== '');
}

// The base: the remote and the branch there that the default branch is
// brought level with, as sync reads them.
function resolveBase(root, t, env) {
  const found = defaultBranch(root, { env });
  if (found === null) {
    const remote = trackedRemote(root, { env });
    throw new Refusal(EXIT.FAILURE, t('propose.no_default_branch', { remote, file: CONFIG_FILENAME }));
  }
  if (found.bare === null) throw new Refusal(EXIT.FAILURE, t('propose.default_branch_invalid', { name: found.name, file: CONFIG_FILENAME }));
  const tracked = defaultBranchUpstream(root, found, { env });
  if (tracked.local) {
    const key = `branch.${found.bare}.remote`;
    throw new Refusal(EXIT.FAILURE, t('propose.local_upstream', { branch: found.bare, key }));
  }
  if (!configuredRemotes(root, env).includes(tracked.remote)) {
    throw new Refusal(EXIT.FAILURE, t('propose.no_remote', { remote: tracked.remote, branch: found.bare }));
  }
  return { remote: tracked.remote, base: tracked.branch };
}

// The base's tip, fetched and proved: anything short of that is a refusal,
// never a proposal against a stale or unknown tip.
function fetchBase(root, t, env, remote, base) {
  const fetched = fetch(root, remote, { branch: base, env });
  if (fetched.status === 'fetched') return fetched.sha;
  if (fetched.status === 'absent') throw new Refusal(EXIT.FAILURE, t('propose.remote_has_no_branch', { remote, branch: base }));
  if (fetched.status === 'missing') throw new Refusal(EXIT.FAILURE, t('propose.remote_lacks_branch', { remote, branch: base, published: fetched.branches }));
  if (fetched.status === 'failed') throw new Refusal(EXIT.FAILURE, t('propose.fetch_failed', { remote, branch: base, detail: fetched.detail }));
  throw new Refusal(EXIT.FAILURE, t('propose.fetch_incomplete', { remote, branch: base }));
}

// Every entry of a commit's tree, path (hex) -> "mode type object".
function treeEntries(root, env, commit) {
  const map = new Map();
  if (commit === null) return map;
  const listed = gitOrFail(root, ['ls-tree', '-r', '-z', '--full-tree', commit], env, { encoding: 'buffer' });
  const out = listed.stdout;
  let start = 0;
  while (start < out.length) {
    let end = out.indexOf(0, start);
    if (end === -1) end = out.length;
    const record = out.subarray(start, end);
    start = end + 1;
    const tab = record.indexOf(0x09);
    if (tab === -1) throw new Error(`git ls-tree printed a record of an unknown shape (hex ${record.toString('hex')})`);
    map.set(record.subarray(tab + 1).toString('hex'), record.subarray(0, tab).toString('latin1'));
  }
  return map;
}

// Each chosen path must be the same at HEAD as at the base's tip, so the
// working-tree edit was made on the version the pull request replaces.
function sameAtHeadAndTip(root, t, env, chosen, tip, base) {
  const head = treeEntries(root, env, resolveCommit(root, 'HEAD', { env }));
  const target = treeEntries(root, env, tip);
  const differ = chosen.filter((path) => head.get(path.toString('hex')) !== target.get(path.toString('hex')));
  if (differ.length > 0) {
    throw new Refusal(EXIT.FAILURE, t('propose.base_differs', { files: differ.map((path) => decodeBytes(path)), base, tip: tip.slice(0, 12) }));
  }
}

function readBodyTemplate(root, config, t) {
  const rel = config.git.pr_body ?? PR_BODY_PATH;
  const file = resolve(root, rel);
  const inside = relative(root, file);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Refusal(EXIT.FAILURE, t('propose.body_outside', { file: rel }));
  }
  try {
    return decodeBytes(readFileSync(file));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Refusal(EXIT.FAILURE, t('propose.body_unreadable', { file, detail: error.code ?? error.message }));
  }
  // A vault that predates the template (adopted, or created before it was
  // managed) gets the kit's own, in the vault's language.
  return readFileSync(join(KIT_ROOT, 'lang', config.lang, 'vault', PR_BODY_PATH), 'utf8');
}

// The base's tip plus exactly the chosen paths, in a temporary index, as
// one commit whose only parent is that tip. The real index, HEAD and the
// working tree are never written.
function buildCommit(root, t, env, { chosen, tip, title, identity, index }) {
  gitOrFail(root, ['read-tree', tip], env, { index });
  const input = Buffer.concat(chosen.flatMap((path) => [path, Buffer.from([0])]));
  gitOrFail(root, ['update-index', '--add', '--remove', '-z', '--stdin'], env, { index, input });
  // What the commit will change against the tip must be exactly the chosen
  // paths: one more or one fewer is a proposal of something not given. One
  // fewer is reachable: a path whose change is only staged, its working
  // tree back to HEAD's version, is dirty and yet adds nothing here, since
  // propose reads the working tree and never the index.
  const diff = gitOrFail(root, ['diff-index', '--cached', '--no-renames', '--name-only', '-z', tip], env, { index, encoding: 'buffer' });
  const changed = diff.stdout.length === 0 ? [] : diff.stdout.subarray(0, diff.stdout.at(-1) === 0 ? -1 : undefined).toString('latin1').split('\0');
  const expected = chosen.map((path) => path.toString('latin1'));
  const sortedChanged = [...changed].sort();
  const sortedExpected = [...expected].sort();
  const sameSet = sortedChanged.length === sortedExpected.length && sortedChanged.every((path, i) => path === sortedExpected[i]);
  if (!sameSet) {
    const show = (list) => list.map((path) => decodeBytes(Buffer.from(path, 'latin1')));
    throw new Refusal(EXIT.FAILURE, t('propose.tree_mismatch', { expected: show(expected), actual: show(changed) }));
  }
  const tree = gitOrFail(root, ['write-tree'], env, { index }).stdout.trim();
  const identityEnv = {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
  };
  const commit = gitOrFail(root, ['commit-tree', tree, '-p', tip], env, { extraEnv: identityEnv, input: `${title}\n` }).stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error(`git commit-tree printed no commit: ${commit}`);
  return commit;
}

// The commit, to a branch the remote must not have yet, and proof that the
// remote now holds it there.
function push(root, t, env, { remote, branch, commit }) {
  const ref = `refs/heads/${branch}`;
  const network = { extraEnv: { GIT_TERMINAL_PROMPT: '0' }, timeout: NETWORK_TIMEOUT_MS };
  const pushed = git(root, ['push', '--quiet', `--force-with-lease=${ref}:`, remote, `${commit}:${ref}`], env, network);
  if (pushed.status !== 0) throw new Refusal(EXIT.FAILURE, t('propose.push_failed', { remote, branch, detail: detailOf(pushed) }));
  const listed = git(root, ['ls-remote', remote, ref], env, network);
  const held = listed.status === 0 ? listed.stdout.split('\n').find((line) => line.endsWith(`\t${ref}`)) : undefined;
  if (held === undefined || held.split('\t')[0] !== commit) throw new Refusal(EXIT.FAILURE, t('propose.push_unproved', { remote, branch, commit: commit.slice(0, 12) }));
}

// The pull request, then proof of its base. Every failure from here on is
// exit 3: the commit is published, the pull request is not confirmed.
function openPullRequest(root, io, t, env, { program, base, branch, title, bodyFile, scratch, count, origin }) {
  const ghEnv = { ...gitEnv(env), GH_PROMPT_DISABLED: '1' };
  const createArgs = ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile];
  const degraded = (text) => {
    scratch.keep = true;
    io.stderr.write(`${text}\n`);
    return EXIT.DEGRADED;
  };
  const created = run(program, createArgs, { cwd: root, env: ghEnv, timeout: NETWORK_TIMEOUT_MS });
  if (created.status !== 0) {
    return degraded(t('propose.degraded_create', { branch, detail: detailOf(created), command: commandLine(program, createArgs) }));
  }
  const viewArgs = ['pr', 'view', branch, '--json', 'baseRefName,headRefName,url'];
  const viewed = run(program, viewArgs, { cwd: root, env: ghEnv, timeout: NETWORK_TIMEOUT_MS });
  let pr = null;
  try {
    pr = viewed.status === 0 ? JSON.parse(viewed.stdout) : null;
  } catch {
    pr = null;
  }
  if (pr === null || typeof pr !== 'object' || typeof pr.baseRefName !== 'string') {
    return degraded(t('propose.degraded_view', { branch, detail: detailOf(viewed), command: commandLine(program, viewArgs) }));
  }
  if (pr.baseRefName !== base || pr.headRefName !== branch) {
    const command = commandLine(program, ['pr', 'edit', branch, '--base', base]);
    const found = `${pr.headRefName} -> ${pr.baseRefName}`;
    return degraded(t('propose.degraded_base', { branch, found, base, command }));
  }
  const url = typeof pr.url === 'string' && pr.url !== '' ? pr.url : created.stdout.trim().split('\n').at(-1);
  io.stdout.write(`${t('propose.opened', { url, base, branch, count, origin })}\n`);
  return EXIT.OK;
}
