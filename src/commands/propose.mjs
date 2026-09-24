// The `propose` command: the only way an agent's work reaches a vault, as a
// pull request against the default branch.
//
//   brain-kit propose "<summary>" (--only <path>... | --all [--yes]) [--dry] [-- <argument>...]
//
// It exists because of docs/incidents.md, section "Git and pull requests":
// 10/08/2026 (one variable meant both the branch to return to and the
// branch to target, and pull requests went to yesterday's branch);
// 08/09/2026 (success left the repository on the new branch); 29/07/2026
// (two rounds in one tree at once); 16/09/2026 (a blanket `git add -A`
// nearly swept another session's unfinished files into a pull request);
// and the addendum of 22/09/2026 in "Headless runs" (the remote that was
// asked was not the one pushed to).
//
// THE COMMIT IS BUILT WITH GIT PLUMBING, AND HEAD, THE INDEX AND THE
// WORKING TREE NEVER MOVE. The remote default branch's tip, fetched and
// proved, is read into a temporary index (GIT_INDEX_FILE naming a file in
// a private temporary directory); exactly the chosen paths' working-tree
// contents are added to it (`git update-index --add --remove`, so a deleted
// path is removed); the tree is written and committed with that tip as its
// only parent, under the configured agent identity (this command's designed
// author). So a local commit that was never published cannot ride into the
// pull request (the parent is the remote's tip, not HEAD); another
// session's staged or unstaged work is never read, staged or moved (the
// real index is never written); and "return to the origin branch in every
// outcome" is true by construction, because nothing ever left it. No commit
// hook runs (commit-tree runs none); the push runs the vault's pre-push
// gate as any push does.
//
// THE PUSH GOES TO THE PUSH DESTINATION, BY URL, AND IS PROVED THERE. The
// destination is what `git push <remote>` would use: every url `git remote
// get-url --push --all` prints (a pushurl, several, pushInsteadOf applied).
// Each is pushed to by url, never by remote name, so no remote-tracking
// reference is written, and each is asked with `git ls-remote` whether it
// now holds the commit. Both calls run with an identity url rewrite for
// that url (url.<u>.insteadOf and pushInsteadOf, read before any rule of the
// person's, see pinnedConfig), so a mirror's insteadOf can never send the
// push or the question somewhere else, and `ls-remote --get-url` proves the
// pin first.
//
// In order, under the vault's lock (src/guards/lock.mjs), released in
// every outcome:
//
//   1. An operation left half done (rebase, merge, cherry-pick, revert,
//      bisection) postpones the run, exit 75. A vault that is not the top
//      level of its repository is exit 2.
//   2. A proposal an earlier run published without a confirmed pull request
//      (its record in the git directory, below) is checked with `gh pr
//      view`: confirmed, the record is removed; otherwise its finishing
//      command is printed again. Not in `--dry`.
//   3. A clean working tree is exit 0, "nothing to propose", in one line.
//   4. The paths. `--only`: every listed path must be inside the vault and
//      dirty now, or the run refuses naming each one, exit 2; the session
//      snapshot plays no part. `--all`: every dirty path, but a path the
//      session snapshot (src/guards/snapshot.mjs, taken at session or round
//      start by its caller; this command never takes one) recorded as
//      already there is refused, naming it, unless `--yes`; with no
//      snapshot, or one taken more than a day ago (or in the future),
//      `--all` requires `--yes`. Each of those refusals is exit 2: the run
//      lacks the confirmation it needs. A submodule pointer or an untracked
//      nested repository is refused in phase 1, naming it, exit 2.
//   5. origin (the branch checked out, named in messages only) and base
//      (the remote default branch: the one resolver, src/git.mjs
//      defaultBranch, then the upstream it tracks, as sync reads it) are
//      two variables that never share a meaning. A base that cannot be
//      resolved, or a remote with no push url, is exit 1.
//   6. `--dry` stops here, prints the plan and exits 0: before any fetch,
//      so it moves no reference and writes no object.
//   7. The base is fetched and the fetch proved (src/git.mjs, fetch);
//      anything short of a proved tip is exit 1. Every chosen path must
//      then be the same at HEAD as at that tip, present or absent on both:
//      an edit made on a version the base does not hold (a branch behind
//      the remote, a previous round's unmerged commit, or a new file where
//      the owner merged one of the same name) would silently revert or
//      carry that difference. Otherwise exit 1, naming the paths.
//   8. The tree is built as above, and the paths it changes against the tip
//      must be exactly the chosen ones, or exit 1. That tree, the one the
//      pull request will hold, is extracted into a temporary repository
//      (its objects borrowed through alternates, HEAD at the tip) and
//      `validate` and `lint --base worktree` run THERE; either failing is
//      exit 1, their report printed.
//   9. The branch is `<branch_prefix><YYYY-MM-DD-HH-MM-SS>` (UTC), with
//      `-2` to `-9` appended when a push url already holds that name. The
//      rendered body is written to the git directory, the commit is made,
//      and pushed to every push url with a lease that refuses to replace a
//      branch there. No url holding it, every url answering: exit 1,
//      nothing published. Some urls holding it, or one not answering: exit
//      3 naming which, with the commands that finish by hand.
//  10. With every url holding it, a record of the published branch is
//      written to the git directory BEFORE `gh` is called, so a run killed
//      from here on is reported by the next one (step 2). Then `gh pr
//      create --base <base> --head <branch> --title <title> --body-file
//      <body>` and `gh pr view <branch> --json baseRefName,headRefName,url`,
//      which must name the base and the branch. `gh` absent, failing,
//      unauthenticated, unreadable, or reporting another base or head is
//      exit 3, naming the exact command that finishes by hand; the body and
//      the record stay in the git directory for it. Confirmed, both are
//      removed and the run exits 0.
//
// INSIDE A ROUND. The lock is taken with joinOrAcquire: a scheduled round
// holds the vault's lock and hands its token to the model as
// BRAIN_KIT_ROUND_TOKEN, and the `propose` the model runs joins that lock
// instead of being refused by it (src/guards/lock.mjs says when a join is
// allowed). Joined, and only once a commit is proved on at least one push
// url (the pull request opened, or the run degraded with the commit held
// there), the run appends its entry to the round record
// `<git dir>/brain-kit-round-<token>.json`, private to its owner:
// `{ "format": 1, "proposals": [ { opened, remote, branch, commit, paths },
// ... ] }`, one entry per proposal the round made, `paths` being exactly
// the vault-relative paths that commit changed. A round may propose more
// than once, so the record is merged, never overwritten: under a guard file
// created exclusively beside it (`.lock`, held for the read and the write
// only), the existing record is read and validated, the entry appended,
// and the whole written to a private temporary file renamed into place.
// The round reads it to bring those files back to the default branch's
// content, so the next round does not stop on its own proposals as a dirty
// tree. A pushed commit no url could be asked about is not recorded: the
// round then leaves its files alone and says so, the safe direction, since
// they may be the only copy. An existing record that does not validate is
// left exactly as it is and the run is exit 3 (the round then finds the
// files still dirty and fails loudly); a record that cannot be read or
// written is exit 3 too, said with its directory and the error code. Not
// joined, nothing is written and nothing else changes. The token is never
// printed, and it is removed from the environment of everything this
// command runs (git, its hooks, gh).
//
// `gh` runs with the caller's git environment removed, GIT_TERMINAL_PROMPT=0
// and GH_PROMPT_DISABLED=1.
//
// Declared, not handled: a submodule the proposed tree already holds (not
// one being proposed) is extracted as the empty directory git leaves for it
// and judged as such; a process that does not take the lock can still edit
// a chosen file between the gate and the commit; `gh` chooses the
// repository from the checkout's remotes itself, and only the base and head
// names it reports back are checked.
//
// `deps` hands in the environment, the working directory, the clock, the
// temporary directory and walkVault, for the tests and for src/cli.mjs.
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, loadConfig } from '../config.mjs';
import { findVaultRoot } from '../vault.mjs';
import { decodeBytes } from '../io.mjs';
import { run } from '../exec.mjs';
import { KIT_ROOT } from '../version.mjs';
import { PR_BODY_PATH } from '../init/skeleton.mjs';
import { joinOrAcquire } from '../guards/lock.mjs';
import { GuardError, locateRepository } from '../guards/location.mjs';
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
// Where a published proposal without a confirmed pull request is recorded,
// with its rendered body: in the repository's git common directory, beside
// the lock, so every working tree and every environment sees one place.
export const PROPOSALS_DIR = 'brain-kit-proposals';
const MAX_SUFFIX = 9;
const GITLINK_MODE = '160000';
const ROUND_RECORD_FORMAT = 1;

// Where a joined run records what it pushed for the round holding the lock:
// in the working tree's own git directory, named by the round's token.
const roundRecordName = (token) => `brain-kit-round-${token}.json`;

export function roundRecordPath(root, token, env = process.env) {
  return join(locateRepository(root, env).gitDir, roundRecordName(token));
}

// How long a joined run waits for another joined run of the same round to
// finish its read and write of the record (they hold its guard for a few
// system calls; a guard older than that was left by a run that died).
const RECORD_GUARD_WAIT_MS = 5000;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ENTRY_KEYS = ['branch', 'commit', 'opened', 'paths', 'remote'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameKeys(value, keys) {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, i) => key === keys[i]);
}

function isEntry(entry) {
  return isPlainObject(entry) && sameKeys(entry, ENTRY_KEYS)
    && typeof entry.opened === 'boolean'
    && typeof entry.remote === 'string' && entry.remote !== ''
    && typeof entry.branch === 'string' && entry.branch !== ''
    && typeof entry.commit === 'string' && COMMIT_ID.test(entry.commit)
    && Array.isArray(entry.paths) && entry.paths.length > 0 && entry.paths.every((path) => typeof path === 'string' && path !== '');
}

// A round record's text as the round reads it: `{ format: 1, proposals:
// [entry, ...] }` with every entry well formed and nothing else, or null.
export function parseRoundRecord(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || !sameKeys(value, ['format', 'proposals'])) return null;
  if (value.format !== ROUND_RECORD_FORMAT || !Array.isArray(value.proposals)) return null;
  return value.proposals.every(isEntry) ? value : null;
}

class Refusal extends Error {
  constructor(exitCode, text) {
    super(text);
    this.exitCode = exitCode;
  }
}

// The summary comes first; --only takes every argument after it up to the
// next option; `--` ends options, and what follows it fills the summary if
// it is still missing, then the --only list.
function parseArgs(argv) {
  const result = { summary: undefined, only: null, all: false, yes: false, dry: false, help: false };
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (rest) {
      if (result.summary === undefined) result.summary = arg;
      else if (result.only !== null) result.only.push(arg);
      else return { error: 'argument', arg };
    } else if (arg === '--') rest = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
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

// The configuration that makes git use exactly each push url: an identity
// rewrite (insteadOf and pushInsteadOf) per url, as the longest possible
// match. git breaks a tie between equally long rewrites in favour of the one
// it read FIRST, and a mirror's insteadOf naming the whole url ties with it,
// so the identity rules go in a global configuration file of their own that
// then includes the system and global files the person has: read before the
// repository's configuration and before theirs, the pin wins, and every
// credential helper and transport setting still applies. Returns the
// environment that selects that file.
function pinnedConfig(root, env, dir, urls) {
  const escape = (text) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = [];
  for (const url of urls) {
    lines.push(`[url "${escape(url)}"]`, `\tinsteadOf = "${escape(url)}"`, `\tpushInsteadOf = "${escape(url)}"`);
  }
  const included = [];
  if (!env.GIT_CONFIG_NOSYSTEM) {
    const listed = git(root, ['config', '--system', '--list', '--show-origin'], env);
    if (listed.status === 0) {
      for (const line of listed.stdout.split('\n')) {
        const origin = /^file:([^\t]+)\t/.exec(line);
        if (origin !== null && !included.includes(origin[1])) included.push(origin[1]);
      }
    }
  }
  const home = env.HOME ?? '';
  const globals = env.GIT_CONFIG_GLOBAL !== undefined
    ? [env.GIT_CONFIG_GLOBAL]
    : [join(env.XDG_CONFIG_HOME || join(home, '.config'), 'git', 'config'), join(home, '.gitconfig')];
  for (const file of globals) {
    try {
      if (statSync(file).isFile()) included.push(file);
    } catch {
      // Absent, or no regular file: nothing to include.
    }
  }
  if (included.length > 0) lines.push('[include]', ...included.map((file) => `\tpath = "${escape(file)}"`));
  const file = join(dir, 'pinned.gitconfig');
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

function captureIo() {
  let text = '';
  const sink = { write: (s) => { text += s; } };
  return { io: { stdout: sink, stderr: sink }, text: () => text };
}

function ghEnvOf(env) {
  return { ...gitEnv(env), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
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
    lock = joinOrAcquire(root, { command: 'propose', env });
  } catch (error) {
    if (error instanceof GuardError) {
      io.stderr.write(`${t(error.messageKey, error.params)}\n`);
      return error.exitCode;
    }
    throw error;
  }
  // The temporary index and the extracted tree live in a private temporary
  // directory, always removed. The body and the record live in the git
  // directory and are removed unless the run ends degraded.
  const scratch = { work: null, kept: [], keep: false };
  try {
    const round = lock.joined ? { token: lock.token, guardWaitMs: deps.recordGuardWaitMs ?? RECORD_GUARD_WAIT_MS } : null;
    // The round's token goes no further than this command: git, the hooks
    // a push runs and gh get the environment without it.
    const { BRAIN_KIT_ROUND_TOKEN: _token, ...childEnv } = env;
    return await proposeUnderLock({ root, cwd, config, parsed, io, t, env: childEnv, now, walkVault, scratch, temp, round });
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
      if (!scratch.keep) for (const file of scratch.kept) rmSync(file, { force: true });
    } finally {
      lock.release();
    }
  }
}

async function proposeUnderLock({ root, cwd, config, parsed, io, t, env, now, walkVault, scratch, temp, round }) {
  const operation = operationInProgress(root, { env });
  if (operation !== null) throw new Refusal(EXIT.TEMPFAIL, t('propose.operation_in_progress', { operation }));
  const prefix = runGit(root, ['rev-parse', '--show-prefix'], { env });
  if (prefix.status !== 0) throw new Error(`git rev-parse --show-prefix exited with status ${prefix.status}: ${prefix.stderr.trim()}`);
  if (prefix.stdout.replace(/\n$/, '') !== '') {
    throw new Refusal(EXIT.USAGE, t('propose.not_toplevel', { dir: root, prefix: prefix.stdout.trim() }));
  }
  const gitConfig = config.git;
  const commonDir = realpathSync(resolve(root, gitOrFail(root, ['rev-parse', '--git-common-dir'], env).stdout.replace(/\n$/, '')));
  const proposals = join(commonDir, PROPOSALS_DIR);
  if (!parsed.dry) checkEarlierProposals(root, io, t, env, proposals, gitConfig.pr_command);

  const dirty = dirtyPathBytes(root, { env });
  if (dirty.length === 0) {
    io.stdout.write(`${t('propose.nothing_to_propose')}\n`);
    return EXIT.OK;
  }
  const chosen = parsed.all ? chooseAll(root, dirty, parsed, t, env, now) : chooseOnly(root, cwd, dirty, parsed.only, t);
  const head = treeEntries(root, env, resolveCommit(root, 'HEAD', { env }));
  refuseNested(root, t, chosen, head);
  const names = chosen.map((path) => decodeBytes(path));

  // origin: where HEAD is, and stays. base: the remote default branch the
  // pull request targets. Never the same variable (docs/incidents.md,
  // 10/08/2026).
  const origin = currentBranch(root, { env }) ?? resolveCommit(root, 'HEAD', { env }) ?? '-';
  const { remote, base } = resolveBase(root, t, env);
  scratch.work = realpathSync(mkdtempSync(join(temp, 'brain-kit-propose-')));
  const { urls, pinned } = pushUrls(root, t, env, remote, scratch.work);

  const title = render(gitConfig.pr_title ?? DEFAULT_TITLE, { commit_prefix: gitConfig.commit_prefix, summary: parsed.summary });
  const stamped = `${gitConfig.branch_prefix}${branchStamp(now())}`;
  if (!isBranchName(root, stamped, { env }) || stamped === base) throw new Refusal(EXIT.FAILURE, t('propose.branch_invalid', { branch: stamped }));

  if (parsed.dry) {
    io.stdout.write(`${t('propose.dry_run', { files: names, urls, base, branch: stamped, title, origin })}\n`);
    return EXIT.OK;
  }

  const tip = fetchBase(root, t, env, remote, base);
  const target = treeEntries(root, env, tip);
  sameAtHeadAndTip(t, chosen, head, target, base, tip);

  const tree = buildTree(root, t, env, { chosen, tip, index: join(scratch.work, 'index') });
  await gate(root, t, env, walkVault, { tree, tip, commonDir, dir: join(scratch.work, 'proposed') });

  const branch = freeBranch(root, t, env, stamped, urls, pinned);
  const files = names.map((name) => `- \`${name}\``).join('\n');
  const body = render(readBodyTemplate(root, config, t), { summary: parsed.summary, files, base, branch });
  mkdirSync(proposals, { recursive: true, mode: 0o700 });
  const slug = branch.replace(/[^A-Za-z0-9._-]/g, '-');
  const bodyFile = join(proposals, `${slug}.md`);
  const recordFile = join(proposals, `${slug}.json`);
  scratch.kept.push(bodyFile, recordFile);
  writeFileSync(bodyFile, body);
  const commit = commitTree(root, env, { tree, tip, title, identity: gitConfig.agent_identity });

  const program = gitConfig.pr_command;
  const createCommand = commandLine(program, ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile]);
  const published = publish(root, env, { urls, pinned, branch, commit });
  const record = (command) => writeFileSync(recordFile, `${JSON.stringify({ branch, base, commit, urls, bodyFile, command }, null, 2)}\n`);
  // Nothing published is said only when every url answered that it does
  // not hold the commit.
  if (published.held.length === 0 && published.unknown.length === 0) {
    if (published.failed !== null) throw new Refusal(EXIT.FAILURE, t('propose.push_failed', { branch, urls, detail: published.failed }));
    throw new Refusal(EXIT.FAILURE, t('propose.push_unproved', { branch, urls, commit: commit.slice(0, 12) }));
  }
  if (published.held.length !== urls.length) {
    const missing = urls.filter((url) => !published.held.includes(url));
    const pushes = missing.map((url) => commandLine('git', ['push', url, `${commit}:refs/heads/${branch}`]));
    const command = [...pushes, createCommand].join(' && ');
    record(command);
    scratch.keep = true;
    io.stderr.write(`${t('propose.partial_publish', { branch, held: published.held.length > 0 ? published.held : '-', missing, command })}\n`);
    // The result is not needed here: this run is exit 3 whether or not the
    // entry is recorded, and a failure has already been said.
    if (round !== null && published.held.length > 0) recordRound(root, io, t, env, round, { opened: false, remote, branch, commit, paths: names });
    return EXIT.DEGRADED;
  }
  record(createCommand);
  const code = openPullRequest(root, io, t, env, { program, base, branch, title, bodyFile, scratch, count: names.length, origin, createCommand });
  if (round !== null && !recordRound(root, io, t, env, round, { opened: code === EXIT.OK, remote, branch, commit, paths: names })) return EXIT.DEGRADED;
  return code;
}

// The round record as it is now: undefined when there is none, null when
// what is there is not a record this version reads (not a regular file, a
// symbolic link, or text that does not validate), the record otherwise.
// Opened without following a link and without blocking on a FIFO.
function readRoundRecord(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.code === 'ELOOP') return null;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    return parseRoundRecord(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

// The guard two joined runs of one round take around their read and write
// of the record, so neither loses the other's entry: a file created
// exclusively, retried until `waitMs` has passed. True once taken.
function takeRecordGuard(path, waitMs) {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(path, 'wx', 0o600));
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (Date.now() >= deadline) return false;
    Atomics.wait(cell, 0, 0, 20);
  }
}

// This proposal's entry, appended to the round record: under the guard,
// the existing record is read and validated, and the whole is written in
// full to a private file created exclusively beside it and renamed into
// place, so the round never reads half of one and no entry is ever lost.
// True when the entry is in place. A record that does not validate is left
// exactly as it is. Every failure is said with the directory and at most
// an error code, never an error's own text, which names the file and so
// the token; the run then ends degraded (the commit is pushed, the round
// will find its files still dirty and report them).
function recordRound(root, io, t, env, round, entry) {
  const dir = locateRepository(root, env).gitDir;
  const file = join(dir, roundRecordName(round.token));
  const guard = `${file}.lock`;
  const failed = (code) => {
    io.stderr.write(`${t('propose.round_record_failed', { branch: entry.branch, dir, code })}\n`);
    return false;
  };
  const codeOf = (error) => (typeof error.code === 'string' ? error.code : 'error');
  try {
    if (!takeRecordGuard(guard, round.guardWaitMs)) return failed('EBUSY');
  } catch (error) {
    return failed(codeOf(error));
  }
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const existing = readRoundRecord(file);
    if (existing === null) {
      io.stderr.write(`${t('propose.round_record_invalid', { branch: entry.branch, dir })}\n`);
      return false;
    }
    const proposals = existing === undefined ? [] : existing.proposals;
    const text = `${JSON.stringify({ format: ROUND_RECORD_FORMAT, proposals: [...proposals, entry] }, null, 2)}\n`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    return true;
  } catch (error) {
    rmSync(tmp, { force: true });
    return failed(codeOf(error));
  } finally {
    rmSync(guard, { force: true });
  }
}

// A proposal an earlier run published and never saw confirmed: removed
// once gh confirms its pull request, reported with its finishing command
// otherwise. A record that cannot be read is named, never deleted.
function checkEarlierProposals(root, io, t, env, dir, program) {
  let entries;
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of entries) {
    const file = join(dir, name);
    let record;
    try {
      record = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      record = null;
    }
    if (record === null || typeof record.branch !== 'string' || typeof record.base !== 'string' || typeof record.command !== 'string') {
      io.stderr.write(`${t('propose.pending_unreadable', { file })}\n`);
      continue;
    }
    const pr = viewPullRequest(root, env, program, record.branch);
    if (pr !== null && pr.baseRefName === record.base && pr.headRefName === record.branch) {
      rmSync(file, { force: true });
      if (typeof record.bodyFile === 'string') rmSync(record.bodyFile, { force: true });
      continue;
    }
    const command = pr !== null ? commandLine(program, ['pr', 'edit', record.branch, '--base', record.base]) : record.command;
    io.stderr.write(`${t('propose.pending', { branch: record.branch, command })}\n`);
  }
}

// --only: each path is inside the vault and dirty now, or the run refuses
// naming every one that is not. A directory git lists with a slash (an
// untracked nested repository) matches its name without one, so it is
// refused for what it is.
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
    const posix = rel.split(sep).join('/');
    const key = Buffer.from(posix, 'utf8').toString('hex');
    const dirKey = Buffer.from(`${posix}/`, 'utf8').toString('hex');
    if (known.has(key)) chosen.set(key, known.get(key));
    else if (known.has(dirKey)) chosen.set(dirKey, known.get(dirKey));
    else clean.push(given);
  }
  if (outside.length > 0) throw new Refusal(EXIT.USAGE, t('propose.outside_vault', { paths: outside, dir: root }));
  if (clean.length > 0) throw new Refusal(EXIT.USAGE, t('propose.not_dirty', { paths: clean }));
  return [...chosen.values()].sort(Buffer.compare);
}

// --all: every dirty path, but never one the session snapshot recorded as
// already there, and never without a recent snapshot, unless --yes. Each
// refusal is exit 2: what the run lacks is the person's confirmation.
function chooseAll(root, dirty, parsed, t, env, now) {
  if (parsed.yes) return dirty;
  const snapshot = readSnapshot(root, { env });
  if (snapshot === null) throw new Refusal(EXIT.USAGE, t('propose.no_snapshot'));
  const age = now().getTime() - Date.parse(snapshot.at);
  if (!(age >= 0 && age <= DAY_MS)) throw new Refusal(EXIT.USAGE, t('propose.stale_snapshot', { at: snapshot.at }));
  const { before } = splitDirty(root, snapshot, { env });
  if (before.length > 0) {
    throw new Refusal(EXIT.USAGE, t('propose.dirty_before', { files: before.map((path) => decodeBytes(path)), at: snapshot.at }));
  }
  return dirty;
}

// Phase 1 proposes files only: a submodule pointer (a directory in the
// working tree, or a gitlink at HEAD for one deleted) and an untracked
// nested repository (git lists it as "dir/") are refused, naming them.
function refuseNested(root, t, chosen, head) {
  const nested = chosen.filter((path) => {
    if (path.at(-1) === 0x2f) return true;
    let st = null;
    try {
      st = lstatSync(Buffer.concat([Buffer.from(`${root}/`), path]));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (st !== null) return st.isDirectory();
    return (head.get(path.toString('hex')) ?? '').startsWith(`${GITLINK_MODE} `);
  });
  if (nested.length > 0) throw new Refusal(EXIT.USAGE, t('propose.nested_repository', { paths: nested.map((path) => decodeBytes(path)) }));
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

// The RAW push destination(s), exactly as configured, never as any command
// that applies url rewriting would resolve them: `remote.<remote>.pushurl`
// (every value, in order), or `remote.<remote>.url` when no pushurl is set
// (git's own fallback, matching an ordinary push). `git config --get-all`
// never applies `url.*.insteadOf` or `pushInsteadOf`: it reads the stored
// string, so this is immune to a rewrite rule anywhere, on this machine or
// in this repository, by construction, rather than by outrunning one.
//
// This exists because of a live leak found in this round's own review, on
// this branch's own unmutated code: `git remote get-url --push --all`,
// which the first version of this function trusted, already applies
// `pushInsteadOf`, and does that with the CALLER'S ambient configuration,
// before any protection this module builds can exist to guard it. A
// `pushInsteadOf` rule in the person's OWN global gitconfig, naming this
// vault's origin url for a reason that has nothing to do with brain-kit
// (a personal mirror, a corporate proxy, anything), silently retargeted
// every proposal to wherever that rule pointed: the run still reported
// success, the commit was real, and it was never on the vault's own
// remote. No flag, no `--only`/`--all` choice, nothing the person did in
// this run caused it or could have caught it.
function rawPushUrls(root, env, remote) {
  const pushurl = git(root, ['config', '--get-all', `remote.${remote}.pushurl`], env);
  const source = pushurl.status === 0 ? pushurl.stdout : git(root, ['config', '--get-all', `remote.${remote}.url`], env).stdout;
  return [...new Set(source.split('\n').filter((url) => url !== ''))];
}

// Where the branch is actually sent: the raw destination(s) above, each
// proved to stay itself when pinned. A REPOSITORY-level `insteadOf` or
// `pushInsteadOf` (the vault's own, deliberate: the mirror idiom, a
// literal `pushurl`) is honoured, because rawPushUrls already reads past
// it to the value it rewrites FROM, and this pin only ever maps that
// value to itself. What is refused is a SECOND, unrelated rule (anywhere:
// this machine's global or system configuration, or a stray repository
// rule) matching this exact string once it is handed to `git` a second
// time, at the literal push and at its proof.
function pushUrls(root, t, env, remote, dir) {
  const urls = rawPushUrls(root, env, remote);
  if (urls.length === 0) throw new Refusal(EXIT.FAILURE, t('propose.no_push_url', { remote }));
  const pinned = pinnedConfig(root, env, dir, urls);
  for (const url of urls) {
    const asked = git(root, ['ls-remote', '--get-url', url], env, { extraEnv: pinned });
    if (asked.status !== 0 || asked.stdout.replace(/\n$/, '') !== url) throw new Refusal(EXIT.FAILURE, t('propose.url_rewritten', { url, got: asked.stdout.trim() }));
  }
  return { urls, pinned };
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

// Each chosen path must be the same at HEAD as at the base's tip, present
// with the same content or absent on both sides, so the working-tree edit
// was made on the version the pull request replaces.
function sameAtHeadAndTip(t, chosen, head, target, base, tip) {
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
// one tree. The real index, HEAD and the working tree are never written.
function buildTree(root, t, env, { chosen, tip, index }) {
  gitOrFail(root, ['read-tree', tip], env, { index });
  const input = Buffer.concat(chosen.flatMap((path) => [path, Buffer.from([0])]));
  gitOrFail(root, ['update-index', '--add', '--remove', '-z', '--stdin'], env, { index, input });
  // What the tree changes against the tip must be exactly the chosen paths:
  // one more or one fewer is a proposal of something not given. One fewer
  // is reachable: a path whose change is only staged, its working tree back
  // to HEAD's version, is dirty and yet adds nothing here, since propose
  // reads the working tree and never the index.
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
  return gitOrFail(root, ['write-tree'], env, { index }).stdout.trim();
}

// validate, then lint, over the tree the pull request will hold: extracted
// into a throwaway repository that borrows the vault's objects, with HEAD at
// the base tip and that tree in its index and working tree, so lint's
// worktree scope is exactly what the pull request changes. Their report is
// printed only when one fails.
async function gate(root, t, env, walkVault, { tree, tip, commonDir, dir }) {
  gitOrFail(root, ['init', '-q', '--template=', dir], env);
  writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), `${join(commonDir, 'objects')}\n`);
  gitOrFail(dir, ['update-ref', 'HEAD', tip], env);
  gitOrFail(dir, ['read-tree', tree], env);
  gitOrFail(dir, ['checkout-index', '-a'], env);
  const validation = captureIo();
  const validated = await runValidate([dir, '--only-problems'], validation.io, t, walkVault);
  if (validated !== EXIT.OK) throw new Refusal(EXIT.FAILURE, `${validation.text()}${t('propose.validate_failed', { code: validated })}`);
  const linting = captureIo();
  const linted = await runLint([dir, '--base', 'worktree'], linting.io, t, walkVault);
  if (linted !== EXIT.OK) throw new Refusal(EXIT.FAILURE, `${linting.text()}${t('propose.lint_failed', { code: linted })}`);
}

// What every push url holds at refs/heads/<branch>: the object id, null
// when the branch is not there, or undefined when the url did not answer.
function heldAt(root, env, pinned, url, ref) {
  const listed = git(root, ['ls-remote', url, ref], env, { extraEnv: pinned, timeout: NETWORK_TIMEOUT_MS });
  if (listed.status !== 0) return undefined;
  const line = listed.stdout.split('\n').find((entry) => entry.endsWith(`\t${ref}`));
  return line === undefined ? null : line.split('\t')[0];
}

// The stamped name, or the first of `-2` to `-9` appended that no push url
// holds: a rerun within the same second gets a name of its own.
function freeBranch(root, t, env, stamped, urls, pinned) {
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const branch = n === 1 ? stamped : `${stamped}-${n}`;
    let free = true;
    for (const url of urls) {
      const held = heldAt(root, env, pinned, url, `refs/heads/${branch}`);
      if (held === undefined) throw new Refusal(EXIT.FAILURE, t('propose.destination_unreadable', { url }));
      if (held !== null) free = false;
    }
    if (free) return branch;
  }
  throw new Refusal(EXIT.FAILURE, t('propose.branch_exhausted', { branch: stamped }));
}

function commitTree(root, env, { tree, tip, title, identity }) {
  const identityEnv = {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
  };
  const commit = gitOrFail(root, ['commit-tree', tree, '-p', tip], env, { extraEnv: identityEnv, input: `${title}\n` }).stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error(`git commit-tree printed no commit: ${commit}`);
  return commit;
}

// The commit to every push url, each with a lease refusing to replace a
// branch there, then each url asked what it holds: `held` (the commit),
// `unknown` (no answer), and the first push failure's detail, if any.
function publish(root, env, { urls, pinned, branch, commit }) {
  const ref = `refs/heads/${branch}`;
  let failed = null;
  for (const url of urls) {
    const pushed = git(root, ['push', '--quiet', `--force-with-lease=${ref}:`, url, `${commit}:${ref}`], env, { extraEnv: pinned, timeout: NETWORK_TIMEOUT_MS });
    if (pushed.status !== 0 && failed === null) failed = `${url}: ${detailOf(pushed)}`;
  }
  const held = [];
  const unknown = [];
  for (const url of urls) {
    const at = heldAt(root, env, pinned, url, ref);
    if (at === undefined) unknown.push(url);
    else if (at === commit) held.push(url);
  }
  return { held, unknown, failed };
}

// What gh says of the pull request whose head is `branch`, or null.
function viewPullRequest(root, env, program, branch) {
  const viewed = run(program, ['pr', 'view', branch, '--json', 'baseRefName,headRefName,url'], { cwd: root, env: ghEnvOf(env), timeout: NETWORK_TIMEOUT_MS });
  if (viewed.status !== 0) return null;
  try {
    const pr = JSON.parse(viewed.stdout);
    return pr !== null && typeof pr === 'object' && typeof pr.baseRefName === 'string' ? pr : null;
  } catch {
    return null;
  }
}

// The pull request, then proof of its base. Every failure from here on is
// exit 3: the commit is published, the pull request is not confirmed.
function openPullRequest(root, io, t, env, { program, base, branch, title, bodyFile, scratch, count, origin, createCommand }) {
  const ghEnv = ghEnvOf(env);
  const createArgs = ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile];
  const degraded = (text) => {
    scratch.keep = true;
    io.stderr.write(`${text}\n`);
    return EXIT.DEGRADED;
  };
  const created = run(program, createArgs, { cwd: root, env: ghEnv, timeout: NETWORK_TIMEOUT_MS });
  if (created.status !== 0) {
    return degraded(t('propose.degraded_create', { branch, detail: detailOf(created), command: createCommand }));
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
