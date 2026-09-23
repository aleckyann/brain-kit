// The `sync` command: bring the vault's default branch up to date with its
// remote before anything is written.
//
//   brain-kit sync [dir]
//
// It exists because of docs/incidents.md, 17/08/2026: a round started
// writing four commits behind the remote and collided in the log; and
// 25/08/2026: the ahead and behind counts are the first thing a round must
// learn, and two histories are never reconciled in silence. `curate` calls
// it first (phase 2); a person can run it by hand.
//
// In order, under the vault's lock (src/guards/lock.mjs), released in
// every outcome:
//
//   1. An operation left half done (a rebase, a merge, a cherry-pick, a
//      revert, a bisection) postpones the run, exit 75: checking out
//      another branch in the middle of one strands it.
//   2. A dirty working tree (anything `git status` reports but an ignored
//      file) postpones the run, exit 75, naming every file, before any
//      fetch: nothing at all is moved.
//   3. The default branch comes from the one resolver (src/git.mjs,
//      defaultBranch). None, or a configured name that is no branch name,
//      is exit 1.
//   4. The upstream is what the default branch tracks (branch.<default>.remote
//      and branch.<default>.merge), else the remote the resolver read and
//      the same-named branch there. A remote that is not configured is
//      exit 1.
//   5. The branch is fetched and the fetch proved (src/git.mjs, fetch). A
//      remote that cannot be reached, or a fetch that reached nothing, is
//      exit 1, and never read as "up to date". A remote reached that has
//      no such branch yet (before the first push) is said, exit 0.
//   6. With no local branch of that name, exit 1, naming the command that
//      creates one: sync moves an existing branch, it never invents one.
//   7. The ahead and behind counts decide, and every outcome states them:
//      level is exit 0; ahead only is exit 0 with nothing moved; diverged
//      is exit 1 with nothing moved; behind only is fast-forwarded.
//   8. A file git ignores that the fast-forward would overwrite (it is in
//      the fetched tip's tree, or in the default branch's when that has to
//      be checked out first) postpones the run, exit 75, naming it: git
//      replaces an ignored file without a word, and an ignored file is
//      where another session keeps a draft.
//   9. The fast-forward checks out the default branch when the run did not
//      start on it, runs `git merge --ff-only`, proves the branch now
//      points at the fetched tip, and returns to the branch (or detached
//      commit) the run started from, proving that too. A failure at any
//      step still returns, and is exit 1; a return that fails is exit 1
//      naming where the repository was left (docs/incidents.md,
//      08/09/2026).
//
// The only references a run moves are the remote-tracking reference the
// fetch writes and, when behind only, the default branch itself. Every git
// call runs with the caller's git environment removed (src/git-env.mjs,
// through src/git.mjs), so a GIT_DIR naming another repository moves
// nothing there.
//
// `deps` hands in the environment and the working directory, for the
// tests. Production passes nothing.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME } from '../config.mjs';
import { findVaultRoot } from '../vault.mjs';
import { acquireLock } from '../guards/lock.mjs';
import { GuardError } from '../guards/location.mjs';
import {
  aheadBehind, currentBranch, defaultBranch, dirtyPaths, fetch, ignoredInTheWay, operationInProgress, resolveCommit, runGit, trackedRemote, upstreamOfBranch,
} from '../git.mjs';

const ROOT_INDEX = 'index.md';
const short = (sha) => sha.slice(0, 12);

function parseArgs(argv) {
  const result = { dir: undefined, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg.startsWith('-')) return { error: 'argument', arg };
    else if (result.dir === undefined) result.dir = arg;
    else return { error: 'argument', arg };
  }
  return result;
}

export async function runSync(argv, io, t, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const parsed = parseArgs(argv);
  if (parsed.error) {
    io.stderr.write(`${t('sync.bad_argument', { arg: parsed.arg })}\n`);
    io.stderr.write(`${t('sync.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.help) {
    io.stdout.write(`${t('sync.usage')}\n`);
    return EXIT.OK;
  }

  // The same refusal to climb from a path that is not real as doctor's.
  let startDir = cwd;
  if (parsed.dir !== undefined) {
    startDir = resolve(cwd, parsed.dir);
    if (!existsSync(startDir)) {
      io.stderr.write(`${t('sync.path_not_found', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
    if (!statSync(startDir).isDirectory()) {
      io.stderr.write(`${t('sync.path_not_a_directory', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
  }
  const root = findVaultRoot(startDir);
  if (!root) {
    io.stderr.write(`${t('sync.no_vault', { dir: startDir, config: CONFIG_FILENAME, index: ROOT_INDEX })}\n`);
    return EXIT.USAGE;
  }

  let lock;
  try {
    lock = acquireLock(root, { command: 'sync', env });
  } catch (error) {
    if (error instanceof GuardError) {
      io.stderr.write(`${t(error.messageKey, error.params)}\n`);
      return error.exitCode;
    }
    throw error;
  }
  try {
    return syncUnderLock(root, io, t, env);
  } catch (error) {
    io.stderr.write(`${t('sync.git_failed', { detail: error.message })}\n`);
    return EXIT.FAILURE;
  } finally {
    lock.release();
  }
}

function syncUnderLock(root, io, t, env) {
  const operation = operationInProgress(root, { env });
  if (operation !== null) {
    io.stderr.write(`${t('sync.operation_in_progress', { operation })}\n`);
    return EXIT.TEMPFAIL;
  }
  const dirty = dirtyPaths(root, { env });
  if (dirty.length > 0) {
    io.stderr.write(`${t('sync.dirty', { files: dirty })}\n`);
    return EXIT.TEMPFAIL;
  }

  const found = defaultBranch(root, { env });
  if (found === null) {
    const remote = trackedRemote(root, { env });
    io.stderr.write(`${t('sync.no_default_branch', { remote, file: CONFIG_FILENAME })}\n`);
    return EXIT.FAILURE;
  }
  if (found.bare === null) {
    io.stderr.write(`${t('sync.default_branch_invalid', { name: found.name, file: CONFIG_FILENAME })}\n`);
    return EXIT.FAILURE;
  }
  const branch = found.bare;
  // What the default branch itself tracks (its remote and the branch
  // there), else the remote the resolver read and the same-named branch.
  const tracked = upstreamOfBranch(root, branch, { env });
  const remote = tracked.remote ?? found.remote;
  const remoteBranch = tracked.branch ?? branch;
  if (!configuredRemotes(root, env).includes(remote)) {
    io.stderr.write(`${t('sync.no_remote', { remote, branch })}\n`);
    return EXIT.FAILURE;
  }
  const upstream = `${remote}/${remoteBranch}`;

  const fetched = fetch(root, remote, { branch: remoteBranch, env });
  if (fetched.status === 'absent') {
    io.stdout.write(`${t('sync.remote_has_no_branch', { remote, branch: remoteBranch })}\n`);
    return EXIT.OK;
  }
  if (fetched.status === 'failed') {
    io.stderr.write(`${t('sync.fetch_failed', { remote, branch: remoteBranch, detail: fetched.detail })}\n`);
    return EXIT.FAILURE;
  }
  if (fetched.status !== 'fetched') {
    io.stderr.write(`${t('sync.fetch_incomplete', { remote, branch: remoteBranch, upstream, sha: short(fetched.announced) })}\n`);
    return EXIT.FAILURE;
  }

  const localRef = `refs/heads/${branch}`;
  const from = resolveCommit(root, localRef, { env });
  if (from === null) {
    const command = `git branch --track ${branch} ${upstream}`;
    io.stderr.write(`${t('sync.no_local_branch', { branch, upstream, command })}\n`);
    return EXIT.FAILURE;
  }
  const { ahead, behind } = aheadBehind(root, localRef, fetched.ref, { env });
  if (ahead > 0 && behind > 0) {
    io.stderr.write(`${t('sync.diverged', { branch, upstream, ahead, behind })}\n`);
    return EXIT.FAILURE;
  }
  if (behind === 0) {
    if (ahead > 0) io.stdout.write(`${t('sync.ahead', { branch, upstream, ahead })}\n`);
    else io.stdout.write(`${t('sync.up_to_date', { branch, upstream })}\n`);
    return EXIT.OK;
  }
  // What the fast-forward would write: the default branch's own tree when
  // it has to be checked out first, and the fetched tip's. An ignored file
  // in the way is replaced by git without a word, so it postpones the run.
  const onDefault = currentBranch(root, { env }) === branch;
  const inTheWay = ignoredInTheWay(root, onDefault ? [fetched.sha] : [from, fetched.sha], { env });
  if (inTheWay.length > 0) {
    io.stderr.write(`${t('sync.ignored_in_the_way', { branch, upstream, files: inTheWay })}\n`);
    return EXIT.TEMPFAIL;
  }
  return fastForward(root, io, t, env, { branch, upstream, behind, from, to: fetched.sha, ref: fetched.ref });
}

// Checkout, fast-forward, prove, return, prove. Every failure still tries
// to return to where the run started before it reports.
function fastForward(root, io, t, env, { branch, upstream, behind, from, to, ref }) {
  const startBranch = currentBranch(root, { env });
  const startCommit = resolveCommit(root, 'HEAD', { env });
  const onDefault = startBranch === branch;
  let failure = null;

  if (!onDefault) {
    const checkout = runGit(root, ['checkout', '-q', branch, '--'], { env });
    if (checkout.status !== 0 || currentBranch(root, { env }) !== branch) {
      failure = t('sync.checkout_failed', { branch, detail: detailOf(checkout) });
    }
  }
  if (failure === null) {
    const merge = runGit(root, ['merge', '--ff-only', '-q', ref], { env });
    if (merge.status !== 0 || resolveCommit(root, `refs/heads/${branch}`, { env }) !== to) {
      failure = t('sync.fast_forward_failed', { branch, upstream, detail: detailOf(merge) });
    }
  }
  if (failure === null) {
    io.stdout.write(`${t('sync.fast_forwarded', { branch, upstream, behind, from: short(from), to: short(to) })}\n`);
  } else {
    io.stderr.write(`${failure}\n`);
  }
  if (!onDefault) {
    const start = startBranch ?? short(startCommit);
    if (!returnTo(root, env, startBranch, startCommit)) {
      const now = currentBranch(root, { env });
      const current = now ?? short(resolveCommit(root, 'HEAD', { env }) ?? '');
      io.stderr.write(`${t('sync.return_failed', { start, current })}\n`);
      return EXIT.FAILURE;
    }
    if (failure === null) io.stdout.write(`${t('sync.back_on', { start })}\n`);
  }
  return failure === null ? EXIT.OK : EXIT.FAILURE;
}

// Back to the branch, or the detached commit, the run started from, and
// true only when HEAD is provably there. The checkout always runs: onto
// the branch already checked out it changes nothing, and asking first
// would be one more answer to trust.
function returnTo(root, env, startBranch, startCommit) {
  if (startBranch !== null) {
    runGit(root, ['checkout', '-q', startBranch, '--'], { env });
    return currentBranch(root, { env }) === startBranch;
  }
  // A detached HEAD always names a commit, so startCommit is one here.
  runGit(root, ['checkout', '-q', '--detach', startCommit, '--'], { env });
  return currentBranch(root, { env }) === null && resolveCommit(root, 'HEAD', { env }) === startCommit;
}

function configuredRemotes(root, env) {
  const listed = runGit(root, ['remote'], { env });
  if (listed.status !== 0) throw new Error(`git remote exited with status ${listed.status}: ${listed.stderr.trim()}`);
  return listed.stdout.split('\n').filter((name) => name !== '');
}

function detailOf(result) {
  return String(result.stderr || result.stdout || `exit status ${result.status}`).trim().split(/\r?\n/)[0];
}
