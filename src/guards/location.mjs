// Where the guards live: the lock in the vault's git common directory, the
// session snapshot in the git directory of the working tree it describes.
//
// The first version kept the lock and the snapshot in the vault's state
// directory, and the review ran four live holders on one vault at once: one
// with BRAIN_KIT_STATE_DIR pinned, two with different XDG_STATE_HOME values,
// one through a symbolic link. A state directory is chosen by the caller's
// environment, and a systemd unit and a desktop session do not share one by
// default; the incidents these guards exist for (docs/incidents.md,
// 29/07/2026 and 16/09/2026) are exactly a scheduled round against a live
// session. What every environment, every symbolic link and every linked
// worktree of one repository agrees on is the repository itself, so the lock
// lives in `git rev-parse --git-common-dir`: one lock for every working tree
// of a repository, since they share its objects, its refs and its index of
// branches. The snapshot is about one working tree, so it lives in that
// tree's own `git rev-parse --git-dir`: two linked worktrees, each with a
// session of its own, keep two snapshots instead of overwriting one.
//
// Every writing command in this slice needs a repository, so outside one
// the guards refuse, with exit 2 (usage: not a vault this command can work
// in), rather than falling back to some other place a second writer would
// not look.
//
// git is asked with the caller's git environment removed (src/git-env.mjs):
// a GIT_DIR in the environment would otherwise name some other repository's
// directory, and the lock would be taken there.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { run } from '../exec.mjs';
import { EXIT } from '../exit-codes.mjs';
import { localGitVarNames, withoutLocalGitVars } from '../git-env.mjs';

// LOCK and LOCK_RECLAIM live in the git common directory, SNAPSHOT in the
// working tree's own git directory (the same directory for the main
// working tree). LOCK_RECLAIM is the marker a
// process creates, exclusively, to earn the right to replace a stale LOCK
// (src/guards/lock.mjs says why a rename needs it). LOCK, LOCK_RECLAIM and
// SNAPSHOT are each written through a transient sibling named
// `<name>.<pid>.<12 hex>.tmp`, never under their own name.
export const GUARD_FILES = Object.freeze({
  LOCK: 'brain-kit.lock',
  LOCK_RECLAIM: 'brain-kit.lock.reclaim',
  SNAPSHOT: 'brain-kit-snapshot.json',
});

// An error the command layer can translate: `messageKey` and `params` name a
// message in both language packs, `code` is for programs, `exitCode` is
// what the command exits with. `message` is English, for a stack trace.
export class GuardError extends Error {
  constructor({ code, exitCode, messageKey, params, message }) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
    this.exitCode = exitCode;
    this.messageKey = messageKey;
    this.params = params;
  }
}

// The environment every guard runs git with: the caller's git variables
// removed, no optional lock taken (a `git status` would otherwise refresh
// and rewrite the index another live session may be using), and git's own
// messages untranslated, so "not a git repository" can be recognised.
export function gitEnvFor(env) {
  return { ...withoutLocalGitVars(env, localGitVarNames(env)), GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}

const GIT_OPTS = { maxBuffer: 256 * 1024 * 1024 };

export function git(root, args, gitEnv, { encoding = 'utf8' } = {}) {
  return run('git', args, { cwd: root, env: gitEnv, encoding, ...GIT_OPTS });
}

export function gitFailed(root, args, result) {
  const detail = String(result.stderr).trim() || `exit status ${result.status}`;
  return new GuardError({
    code: 'GUARD_GIT_FAILED',
    exitCode: EXIT.FAILURE,
    messageKey: 'guard.git_failed', params: { dir: root, detail },
    message: `git ${args.join(' ')} failed in ${root}: ${detail}`,
  });
}

// git prints a path followed by one newline; only that newline is removed,
// never other white space, which a path may end with.
function printedPath(stdout) {
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
}

// The repository `root` is in: its git common directory, the git directory
// of the working tree `root` belongs to, and that tree's top level, all as
// real paths. Refuses, with
// exit 2, a directory that is not inside a working tree (no repository at
// all, a bare repository, the inside of a .git directory). "Not a
// repository" is concluded only when git says exactly that: git missing,
// or a repository git refuses to read (safe.directory), is a failure, never
// read as "no repository here".
export function locateRepository(root, env = process.env) {
  const gitEnv = gitEnvFor(env);
  const inside = git(root, ['rev-parse', '--is-inside-work-tree'], gitEnv);
  const notInWorkTree = inside.status === 0
    ? inside.stdout.trim() !== 'true'
    : /not a git repository/i.test(inside.stderr);
  if (notInWorkTree) {
    throw new GuardError({
      code: 'GUARD_NOT_A_REPOSITORY',
      exitCode: EXIT.USAGE,
      messageKey: 'guard.not_a_repository', params: { dir: root },
      message: `${root} is not inside a git working tree`,
    });
  }
  if (inside.status !== 0) throw gitFailed(root, ['rev-parse', '--is-inside-work-tree'], inside);
  const askFor = (flag) => {
    const result = git(root, ['rev-parse', flag], gitEnv);
    if (result.status !== 0 || printedPath(result.stdout) === '') throw gitFailed(root, ['rev-parse', flag], result);
    return realpathSync(resolve(root, printedPath(result.stdout)));
  };
  return { commonDir: askFor('--git-common-dir'), gitDir: askFor('--git-dir'), topLevel: askFor('--show-toplevel') };
}
