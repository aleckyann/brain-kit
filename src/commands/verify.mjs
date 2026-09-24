// The `verify` command: the owner confirms merged work.
//
//   brain-kit verify --pr <n> [dir]
//   brain-kit verify --files <path>...
//
// It exists because of docs/incidents.md, 22/07/2026 "who is allowed to
// write to the default branch": the agent proposes, the owner merges, and
// the merge is both the approval and the verification. This command writes
// that verification where the Open Knowledge Format looks for it (section
// 5.2): `verified: { by: <actors.human>, at: <now> }` on every note the
// merged pull request changed, through the one frontmatter writer
// (src/frontmatter-write.mjs), which changes nothing but that key. The
// agent never verifies its own work, so the first refusal is the agent's
// own identity.
//
// In order, under the vault's lock (src/guards/lock.mjs), released in every
// outcome, and with nothing written before the last check has passed:
//
//   1. An operation left half done (a merge would be concluded by the
//      commit) or a dirty working tree postpones the run, exit 75, naming
//      it.
//   2. The run must be on the default branch (src/git.mjs, defaultBranch,
//      the one resolver): anywhere else, or none known, is exit 1.
//   3. The identity the commit would carry, author and committer as git
//      itself resolves them (`git var`), must not be the agent's
//      (git.agent_identity: the same name or the same e-mail), exit 1.
//      verify never supplies an identity: the commit is the person's own.
//   4. With --pr: `gh pr view <n> --repo <host/owner/name> --json
//      state,baseRefName,files,mergeCommit`, the repository read from the
//      URL of the remote the default branch tracks (fix round 1, I3: gh
//      otherwise picks its own base repository, preferring a remote named
//      `upstream`); a URL that names no GitHub repository is exit 1. The
//      state must be MERGED and the base the default branch, or exit 1. A
//      merged pull request listing no file is exit 1, not "nothing to do"
//      (the recurring shape: success read about nothing); so is one
//      listing 100 files or more, since gh lists at most the first 100 of
//      a pull request's files and the rest would be skipped in silence.
//      Then the default branch is fetched from what it tracks and the
//      fetch proved, and the pull request's merge commit must be an
//      ancestor of the local default branch (`git merge-base
//      --is-ancestor`): held by the fetched branch only, it is exit 1
//      naming `brain-kit sync`; held by neither, it is not this history's
//      merge and is exit 1, never stamped. A local default branch behind
//      the fetched one is exit 1 too: without the merge in this checkout,
//      a note the pull request added is not here and would be skipped as
//      deleted, and the others would be stamped on content before it.
//   5. Each file becomes a vault-relative path (gh names paths from the
//      repository's top, the vault may be a folder below it). A note is a
//      markdown file the vault's own walk returns (validate.ignore_paths
//      honoured), a regular file tracked by git, not index.md or log.md
//      (reserved, section 3.1) and not under taxonomy.templates_dir. With
//      --pr, a file that is no longer here, outside the vault or not a
//      note is skipped and named; with --files, each is exit 2. A note
//      that is there but cannot be read (a permission) is exit 1 naming
//      it, never skipped as gone.
//   6. Every note is stamped in memory first. A note that is not UTF-8, or
//      whose frontmatter the writer refuses (none at all, a `verified` in
//      a shape the reader cannot see), is exit 1 naming it, and NOTHING is
//      written, in any note.
//   7. Each note is replaced through a temporary file beside it, only if
//      its bytes are still the ones read; then one commit of exactly those
//      paths, with a message naming the pull request. A write or a commit
//      that fails puts every note back as it was, exit 1. The commit is
//      proved: one new commit on the default branch, changing exactly the
//      stamped paths, the tree clean after it.
//   8. It prints the push command. Pushing is the owner's (out of scope).
//
// Declared, not handled: the repository handed to gh is the remote's URL
// as configured (before insteadOf rewriting), host included, so a GitHub
// Enterprise host works and an SSH alias host (`git@work:ana/brain`) is
// passed as that alias, which gh will not know. A second run over the same pull request adds a second event, which the
// format allows (independent confirmations). A person who sets GIT_AUTHOR_*
// or GIT_COMMITTER_* to someone else's identity is who git says.
//
// `deps` hands in the environment, the working directory, the clock, gh's
// timeout and a call made just before each note is replaced, for the
// tests. Production passes nothing.
import { existsSync, lstatSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { run } from '../exec.mjs';
import { CONFIG_FILENAME, loadConfig } from '../config.mjs';
import { createTranslator } from '../lang.mjs';
import { findVaultRoot, isUnderPath, walkVault } from '../vault.mjs';
import { acquireLock } from '../guards/lock.mjs';
import { GuardError } from '../guards/location.mjs';
import { isoStamp } from '../init/skeleton.mjs';
import { REFUSAL, StampRefused, stampVerified } from '../frontmatter-write.mjs';
import {
  aheadBehind, currentBranch, defaultBranch, defaultBranchUpstream, dirtyPaths, fetch, gitEnv, operationInProgress, resolveCommit, runGit,
} from '../git.mjs';

const ROOT_INDEX = 'index.md';
const RESERVED = Object.freeze(['index.md', 'log.md']);
const GH_FILE_LIMIT = 100;
// A gh that hangs (no network, a prompt nobody answers) is given up on.
const GH_TIMEOUT_MS = 120000;
const TMP_MARK = '.brain-kit-tmp-';
const short = (sha) => sha.slice(0, 12);

// Each sentence is a literal key at its call site, so the test that holds
// every key to both language packs can see it.
function refusalLine(t, reason, path) {
  if (reason === REFUSAL.NO_FRONTMATTER) return t('verify.refused_no_frontmatter', { path });
  if (reason === REFUSAL.DUPLICATE) return t('verify.refused_duplicate', { path });
  if (reason === REFUSAL.INCOMPLETE) return t('verify.refused_incomplete', { path });
  if (reason === REFUSAL.BAD_VALUE) return t('verify.refused_bad_value', { path });
  return t('verify.refused_unreadable', { path });
}

function fileLine(t, kind, path) {
  if (kind === 'outside') return t('verify.file_outside', { path });
  if (kind === 'gone') return t('verify.file_gone', { path });
  return t('verify.file_not_note', { path });
}

function skippedLine(t, kind, path) {
  if (kind === 'outside') return t('verify.skipped_outside', { path });
  if (kind === 'gone') return t('verify.skipped_gone', { path });
  return t('verify.skipped_not_note', { path });
}

// The commit message, in the vault's own language (`t` is the vault's
// translator here, not the person's).
function commitSubject(t, { pr, branch, count, by }) {
  if (pr === null) return t('verify.commit_files', { count, by });
  return t('verify.commit_pr', { pr, branch, count, by });
}

function parseArgs(argv) {
  const result = { mode: null, pr: null, files: [], dir: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--pr' || arg === '--files') {
      if (result.mode !== null) return { error: 'both' };
      result.mode = arg.slice(2);
      if (arg === '--pr') {
        i += 1;
        if (i >= argv.length) return { error: 'pr', value: '' };
        result.pr = argv[i];
      }
    } else if (arg.startsWith('-')) {
      return { error: 'argument', arg };
    } else if (result.mode === 'files') {
      result.files.push(arg);
    } else if (result.dir === undefined) {
      result.dir = arg;
    } else {
      return { error: 'argument', arg };
    }
  }
  if (result.help) return result;
  if (result.mode === null) return { error: 'mode' };
  if (result.mode === 'pr' && !/^[1-9][0-9]{0,9}$/.test(result.pr)) return { error: 'pr', value: result.pr };
  if (result.mode === 'files' && result.files.length === 0) return { error: 'no_files' };
  return result;
}

export async function runVerify(argv, io, t, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? new Date();
  const beforeWrite = deps.beforeWrite ?? (() => {});
  const ghTimeout = deps.ghTimeout ?? GH_TIMEOUT_MS;
  const parsed = parseArgs(argv);
  if (parsed.error) {
    if (parsed.error === 'argument') io.stderr.write(`${t('verify.bad_argument', { arg: parsed.arg })}\n`);
    else if (parsed.error === 'both') io.stderr.write(`${t('verify.both_modes')}\n`);
    else if (parsed.error === 'pr') io.stderr.write(`${t('verify.bad_pr', { value: parsed.value })}\n`);
    else if (parsed.error === 'no_files') io.stderr.write(`${t('verify.no_files')}\n`);
    else io.stderr.write(`${t('verify.no_mode')}\n`);
    io.stderr.write(`${t('verify.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.help) {
    io.stdout.write(`${t('verify.usage')}\n`);
    return EXIT.OK;
  }

  let startDir = cwd;
  if (parsed.dir !== undefined) {
    startDir = resolve(cwd, parsed.dir);
    if (!existsSync(startDir) || !statSync(startDir).isDirectory()) {
      io.stderr.write(`${t('verify.path_not_a_directory', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
  }
  const root = findVaultRoot(startDir);
  if (!root) {
    io.stderr.write(`${t('verify.no_vault', { dir: startDir, config: CONFIG_FILENAME, index: ROOT_INDEX })}\n`);
    return EXIT.USAGE;
  }
  const config = loadConfig(root);

  let lock;
  try {
    lock = acquireLock(root, { command: 'verify', env });
  } catch (error) {
    if (error instanceof GuardError) {
      io.stderr.write(`${t(error.messageKey, error.params)}\n`);
      return error.exitCode;
    }
    throw error;
  }
  try {
    return verifyUnderLock({ root, config, parsed, io, t, env, cwd, now, beforeWrite, ghTimeout });
  } catch (error) {
    io.stderr.write(`${t('verify.failed', { detail: error.message })}\n`);
    return EXIT.FAILURE;
  } finally {
    lock.release();
  }
}

function verifyUnderLock({ root, config, parsed, io, t, env, cwd, now, beforeWrite, ghTimeout }) {
  const operation = operationInProgress(root, { env });
  if (operation !== null) {
    io.stderr.write(`${t('verify.operation_in_progress', { operation })}\n`);
    return EXIT.TEMPFAIL;
  }
  const dirty = dirtyPaths(root, { env });
  if (dirty.length > 0) {
    io.stderr.write(`${t('verify.dirty', { files: dirty })}\n`);
    return EXIT.TEMPFAIL;
  }

  const found = defaultBranch(root, { env });
  if (found === null) {
    io.stderr.write(`${t('verify.no_default_branch', { file: CONFIG_FILENAME })}\n`);
    return EXIT.FAILURE;
  }
  if (found.bare === null) {
    io.stderr.write(`${t('verify.default_branch_invalid', { name: found.name, file: CONFIG_FILENAME })}\n`);
    return EXIT.FAILURE;
  }
  const branch = found.bare;
  const current = currentBranch(root, { env });
  if (current !== branch) {
    if (current === null) io.stderr.write(`${t('verify.detached', { branch })}\n`);
    else io.stderr.write(`${t('verify.not_on_default', { branch, current })}\n`);
    return EXIT.FAILURE;
  }

  const agent = config.git.agent_identity;
  for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const ident = runGit(root, ['var', variable], { env });
    const parts = /^(.*) <([^<>]*)> \d+ [+-]\d{4}$/.exec(ident.stdout.replace(/\n$/, ''));
    if (ident.status !== 0 || parts === null) {
      io.stderr.write(`${t('verify.identity_unknown', { detail: firstLine(ident.stderr || ident.stdout) })}\n`);
      return EXIT.FAILURE;
    }
    const [, name, email] = parts;
    if (name.trim().toLowerCase() === agent.name.trim().toLowerCase() || email.trim().toLowerCase() === agent.email.trim().toLowerCase()) {
      io.stderr.write(`${t('verify.agent_identity', { name, email, file: CONFIG_FILENAME })}\n`);
      return EXIT.FAILURE;
    }
  }

  const upstream = defaultBranchUpstream(root, found, { env });
  const remote = upstream.local ? found.remote : upstream.remote;
  const notes = noteSet(root, config);
  const prefix = vaultPrefix(root, env);
  const stamped = [];
  const skipped = [];
  if (parsed.mode === 'pr') {
    if (upstream.local) {
      io.stderr.write(`${t('verify.local_upstream', { branch })}\n`);
      return EXIT.FAILURE;
    }
    // gh is told which repository to ask: the one the default branch's
    // remote names, so it cannot answer about another remote it prefers.
    const url = remoteUrl(root, upstream.remote, env);
    const repo = githubRepoOf(url);
    if (repo === null) {
      io.stderr.write(`${t('verify.remote_not_github', { remote: upstream.remote, url: withoutCredentials(url ?? '') })}\n`);
      return EXIT.FAILURE;
    }
    const listed = readPullRequest(root, parsed.pr, branch, repo, io, t, env, ghTimeout);
    if (typeof listed === 'number') return listed;
    const proved = proveMergeIsHere(root, found, upstream, { pr: parsed.pr, repo, merge: listed.merge }, io, t, env);
    if (proved !== null) return proved;
    for (const path of listed.paths) {
      const rel = prefix === '' || path.startsWith(prefix) ? path.slice(prefix.length) : null;
      const kind = rel === null ? 'outside' : classify(root, rel, notes);
      if (kind === 'note' || kind === 'unreadable') stamped.push(rel);
      else skipped.push({ path, kind });
    }
  } else {
    for (const given of parsed.files) {
      const abs = resolve(cwd, given);
      const rel = relative(root, abs).split(sep).join('/');
      const kind = classify(root, rel, notes);
      if (kind !== 'note' && kind !== 'unreadable') {
        io.stderr.write(`${fileLine(t, kind, given)}\n`);
        return EXIT.USAGE;
      }
      if (!stamped.includes(rel)) stamped.push(rel);
    }
  }
  const tracked = trackedAmong(root, stamped, env);
  for (const rel of [...stamped]) {
    if (tracked.has(rel)) continue;
    if (parsed.mode === 'files') {
      io.stderr.write(`${t('verify.file_not_note', { path: rel })}\n`);
      return EXIT.USAGE;
    }
    stamped.splice(stamped.indexOf(rel), 1);
    skipped.push({ path: `${prefix}${rel}`, kind: 'not_note' });
  }

  for (const { path, kind } of skipped) io.stdout.write(`${skippedLine(t, kind, path)}\n`);
  if (stamped.length === 0) {
    io.stdout.write(`${t('verify.nothing_to_stamp', { pr: parsed.pr })}\n`);
    return EXIT.OK;
  }

  // Everything in memory before a single byte is written.
  const by = config.actors.human;
  const at = isoStamp(now);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const plans = [];
  let refused = false;
  for (const rel of stamped) {
    const abs = join(root, rel);
    let original;
    try {
      original = readFileSync(abs);
    } catch (error) {
      io.stderr.write(`${t('verify.unreadable', { path: rel, detail: error.code ?? error.message })}\n`);
      refused = true;
      continue;
    }
    let text;
    try {
      text = decoder.decode(original);
    } catch {
      io.stderr.write(`${t('verify.refused_encoding', { path: rel })}\n`);
      refused = true;
      continue;
    }
    try {
      plans.push({ rel, abs, original, bytes: Buffer.from(stampVerified(text, { by, at }), 'utf8'), mode: lstatSync(abs).mode & 0o7777 });
    } catch (error) {
      if (!(error instanceof StampRefused)) throw error;
      io.stderr.write(`${refusalLine(t, error.reason, rel)}\n`);
      refused = true;
    }
  }
  if (refused) {
    io.stderr.write(`${t('verify.nothing_written')}\n`);
    return EXIT.FAILURE;
  }

  const startSha = resolveCommit(root, 'HEAD', { env });
  const written = [];
  for (const plan of plans) {
    try {
      beforeWrite(plan.rel);
      if (!replaceIfUnchanged(plan.abs, plan.bytes, plan.mode, plan.original)) {
        restore(written, io, t);
        io.stderr.write(`${t('verify.changed_underneath', { path: plan.rel })}\n`);
        return EXIT.FAILURE;
      }
    } catch (error) {
      restore(written, io, t);
      io.stderr.write(`${t('verify.write_failed', { path: plan.rel, detail: error.message })}\n`);
      return EXIT.FAILURE;
    }
    written.push(plan);
  }

  const vaultT = createTranslator(config.lang, { warn: (message) => io.stderr.write(`${message}\n`) });
  const subject = commitSubject(vaultT, { pr: parsed.mode === 'pr' ? parsed.pr : null, branch, count: stamped.length, by });
  const rels = plans.map((plan) => plan.rel);
  const commit = runGit(root, ['--literal-pathspecs', 'commit', '-q', '-m', subject, '-m', rels.join('\n'), '--', ...rels], { env });
  if (commit.status !== 0) {
    restore(written, io, t);
    io.stderr.write(`${t('verify.commit_failed', { detail: firstLine(commit.stderr || commit.stdout) })}\n`);
    return EXIT.FAILURE;
  }

  const head = resolveCommit(root, 'HEAD', { env });
  const parent = resolveCommit(root, 'HEAD^', { env });
  const changed = runGit(root, ['diff-tree', '-r', '-z', '--no-commit-id', '--no-renames', '--name-only', 'HEAD^', 'HEAD'], { env });
  const changedPaths = changed.stdout.split('\0').filter((path) => path !== '').sort();
  const expected = rels.map((rel) => `${prefix}${rel}`).sort();
  const endBranch = currentBranch(root, { env });
  if (head === null || head === startSha || parent !== startSha || endBranch !== branch
    || changed.status !== 0 || JSON.stringify(changedPaths) !== JSON.stringify(expected) || dirtyPaths(root, { env }).length > 0) {
    const current = endBranch ?? `HEAD ${short(head ?? '')}`;
    io.stderr.write(`${t('verify.commit_unproven', { branch, current })}\n`);
    return EXIT.FAILURE;
  }

  for (const rel of rels) io.stdout.write(`${t('verify.stamped', { path: rel, by, at })}\n`);
  io.stdout.write(`${t('verify.committed', { count: rels.length, sha: short(head), branch })}\n`);
  const command = `git push ${remote} ${branch}`;
  io.stdout.write(`${t('verify.push_hint', { command })}\n`);
  return EXIT.OK;
}

// `gh pr view`, read and checked. Returns the list of paths, or an exit
// code after saying why.
function readPullRequest(root, pr, branch, repo, io, t, env, timeout) {
  const ghEnv = gitEnv(env);
  delete ghEnv.GH_REPO;
  const result = run('gh', ['pr', 'view', pr, '--repo', repo, '--json', 'state,baseRefName,files,mergeCommit'], { cwd: root, env: ghEnv, timeout });
  if (result.status !== 0) {
    io.stderr.write(`${t('verify.gh_failed', { pr, detail: firstLine(result.stderr || result.stdout) })}\n`);
    return EXIT.FAILURE;
  }
  let view;
  try {
    view = JSON.parse(result.stdout);
  } catch (error) {
    io.stderr.write(`${t('verify.gh_unreadable', { pr, detail: error.message })}\n`);
    return EXIT.FAILURE;
  }
  if (view === null || typeof view !== 'object' || typeof view.state !== 'string' || typeof view.baseRefName !== 'string'
    || !Array.isArray(view.files) || view.files.some((file) => file === null || typeof file !== 'object' || typeof file.path !== 'string' || file.path === '')) {
    io.stderr.write(`${t('verify.gh_unreadable', { pr, detail: firstLine(result.stdout) })}\n`);
    return EXIT.FAILURE;
  }
  if (view.state !== 'MERGED') {
    io.stderr.write(`${t('verify.pr_not_merged', { pr, state: view.state })}\n`);
    return EXIT.FAILURE;
  }
  if (view.baseRefName !== branch) {
    io.stderr.write(`${t('verify.pr_wrong_base', { pr, base: view.baseRefName, branch })}\n`);
    return EXIT.FAILURE;
  }
  if (view.files.length === 0) {
    io.stderr.write(`${t('verify.pr_no_files', { pr })}\n`);
    return EXIT.FAILURE;
  }
  if (view.files.length >= GH_FILE_LIMIT) {
    io.stderr.write(`${t('verify.pr_too_many_files', { pr, count: view.files.length, limit: GH_FILE_LIMIT })}\n`);
    return EXIT.FAILURE;
  }
  const merge = view.mergeCommit;
  if (merge === null || typeof merge !== 'object' || typeof merge.oid !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(merge.oid)) {
    io.stderr.write(`${t('verify.gh_unreadable', { pr, detail: firstLine(result.stdout) })}\n`);
    return EXIT.FAILURE;
  }
  return { paths: [...new Set(view.files.map((file) => file.path))], merge: merge.oid };
}

// The merge is in this checkout: the pull request's merge commit is an
// ancestor of the local default branch (fix round 1, I3: a pull request gh
// reports as merged but absent from this history is never stamped), and
// the default branch, fetched from what it tracks and the fetch proved, is
// not ahead of the local one. null when proved, else an exit code after
// saying why.
function proveMergeIsHere(root, found, upstream, { pr, repo, merge }, io, t, env) {
  const fetched = fetch(root, upstream.remote, { branch: upstream.branch, env });
  if (fetched.status !== 'fetched') {
    io.stderr.write(`${t('verify.remote_unproven', { remote: upstream.remote, branch: upstream.branch, detail: fetched.detail ?? fetched.status })}\n`);
    return EXIT.FAILURE;
  }
  const local = `refs/heads/${found.bare}`;
  const tracking = `${upstream.remote}/${upstream.branch}`;
  if (!isAncestor(root, merge, local, env)) {
    const tip = short(resolveCommit(root, local, { env }) ?? '');
    if (isAncestor(root, merge, fetched.ref, env)) {
      io.stderr.write(`${t('verify.merge_not_pulled', { pr, sha: short(merge), branch: found.bare, tip, upstream: tracking })}\n`);
    } else {
      io.stderr.write(`${t('verify.merge_not_here', { pr, repo, sha: short(merge), branch: found.bare, tip, upstream: tracking })}\n`);
    }
    return EXIT.FAILURE;
  }
  const { behind } = aheadBehind(root, local, fetched.ref, { env });
  if (behind > 0) {
    io.stderr.write(`${t('verify.behind', { branch: found.bare, upstream: tracking, behind })}\n`);
    return EXIT.FAILURE;
  }
  return null;
}

// The notes the vault's own walk returns, less the reserved files and the
// templates.
function noteSet(root, config) {
  const templates = config.taxonomy?.templates_dir;
  return new Set(walkVault(root, config).filter((rel) => !RESERVED.includes(posix.basename(rel))
    && !(typeof templates === 'string' && templates !== '' && isUnderPath(rel, templates))));
}

function classify(root, rel, notes) {
  if (rel.split('/').some((segment) => segment === '..' || segment === '')) return 'outside';
  let st;
  try {
    st = lstatSync(join(root, rel));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'gone';
    return 'unreadable'; // EACCES and the rest: there, but not readable here
  }
  return st.isFile() && notes.has(rel) ? 'note' : 'not_note';
}

// `a` is `b` or an ancestor of it. Anything but a yes (not an ancestor,
// an object this repository does not have, a git that fails) is a no.
function isAncestor(root, a, b, env) {
  return runGit(root, ['merge-base', '--is-ancestor', a, b], { env }).status === 0;
}

// remote.<name>.url as written in the configuration (before any insteadOf
// rewriting), or null.
function remoteUrl(root, remote, env) {
  const result = runGit(root, ['config', '--get', `remote.${remote}.url`], { env });
  const url = result.stdout.replace(/\n$/, '');
  return result.status === 0 && url !== '' ? url : null;
}

// "host/owner/name", the form `gh --repo` takes, from a remote URL:
// https://host/owner/name(.git), ssh://[user@]host[:port]/owner/name(.git),
// git://..., or scp-like [user@]host:owner/name(.git). null for anything
// else (a local path, a file:// URL, a path with more or fewer segments).
const REPO_PART = '[A-Za-z0-9_][A-Za-z0-9._-]*?';
const URL_FORMS = [
  new RegExp(`^(?:https?|ssh|git)://(?:[^@/]+@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::\\d+)?/(${REPO_PART})/(${REPO_PART})(?:\\.git)?/?$`),
  new RegExp(`^(?:[^@/:]+@)?([A-Za-z0-9][A-Za-z0-9.-]*):(${REPO_PART})/(${REPO_PART})(?:\\.git)?/?$`),
];
function githubRepoOf(url) {
  if (typeof url !== 'string') return null;
  for (const form of URL_FORMS) {
    const match = form.exec(url);
    if (match) return `${match[1].toLowerCase()}/${match[2]}/${match[3]}`;
  }
  return null;
}

// A URL with any user or token before "@" removed, for naming it.
function withoutCredentials(url) {
  return url.replace(/^([a-z+]+:\/\/)[^@/]*@/i, '$1');
}

// The vault's path inside the repository ("" at its top, "sub/" below).
function vaultPrefix(root, env) {
  const result = runGit(root, ['rev-parse', '--show-prefix'], { env });
  if (result.status !== 0) throw new Error(`git rev-parse --show-prefix exited with status ${result.status}: ${firstLine(result.stderr)}`);
  return result.stdout.replace(/\n$/, '');
}

// Which of `rels` git tracks.
function trackedAmong(root, rels, env) {
  if (rels.length === 0) return new Set();
  const result = runGit(root, ['--literal-pathspecs', 'ls-files', '-z', '--', ...rels], { env });
  if (result.status !== 0) throw new Error(`git ls-files exited with status ${result.status}: ${firstLine(result.stderr)}`);
  return new Set(result.stdout.split('\0').filter((path) => path !== ''));
}

// Writes `bytes` to a temporary file beside `abs` and renames it over
// `abs`, only if `abs` is still a regular file holding `original`. True
// when replaced; the temporary file is removed either way.
function replaceIfUnchanged(abs, bytes, mode, original) {
  const tmp = join(dirname(abs), `.${basename(abs)}${TMP_MARK}${process.pid}-${randomBytes(4).toString('hex')}`);
  writeFileSync(tmp, bytes, { flag: 'wx', mode });
  try {
    chmodSync(tmp, mode);
    const st = lstatSync(abs);
    if (!st.isFile() || !readFileSync(abs).equals(original)) {
      unlinkSync(tmp);
      return false;
    }
    renameSync(tmp, abs);
    return true;
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone: the rename happened, or nothing was created.
    }
    throw error;
  }
}

// Puts every written note back as it was read, and names any that could
// not be (changed again since verify wrote it).
function restore(written, io, t) {
  const left = [];
  for (const plan of written) {
    try {
      if (!replaceIfUnchanged(plan.abs, plan.original, plan.mode, plan.bytes)) left.push(plan.rel);
    } catch {
      left.push(plan.rel);
    }
  }
  if (left.length > 0) io.stderr.write(`${t('verify.restore_failed', { files: left })}\n`);
}

function firstLine(text) {
  return String(text ?? '').trim().split(/\r?\n/)[0] ?? '';
}
