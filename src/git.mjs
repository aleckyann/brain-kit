// The git reader: what a change actually touched.
//
// Two later lint rules (style, secrets) judge only lines a change ADDED,
// never a line the vault already carried before this kit's rules existed.
// A vault that adopts this kit arrives with years of prose written under no
// such rule, and a linter that reports every old line on its first run is a
// linter someone switches off in its first minute. So those two rules read
// only what a diff says is new, and this module is what decides which lines
// that is.
//
// This module produces raw material, not the scope contract itself. The
// shape `runLintRules` actually consumes, `{ files, addedLines(relPath) ->
// Set<number> | null }`, is built by the command (src/commands/lint.mjs, a
// later task), because that is where the vault's markdown file list already
// lives from the one `walkVault` call. This module has no notion of a
// vault, a rule, or a config; it only knows how to ask git questions.
//
// A deliberate limitation: `root` is assumed to be the top level of the git
// working tree, exactly like every fixture in this codebase's own tests
// builds it. A vault nested inside a larger repository is out of scope for
// this task; slice C, which extends this reader for the propose loop, is
// where that would need to be handled if it ever comes up.
//
// THE SEQUEL TO PHASE 0'S LESSON. Moving to Node removed the unread status
// and nothing else. Checking a status is not, by itself, enough: every hole
// found in review here had status ZERO, a command that succeeded while
// printing something the parser could not read, or a reference that was
// valid and pointed somewhere wrong. A diff of a file git decides is binary
// exits 0 and prints "Binary files ... differ" with no hunk at all; a
// `.gitattributes` line turning diffs off for markdown does the same
// silently, vault-wide. A merge-base against a branch that turns out to be
// the branch you are already on exits 0 with an empty range. So the rule
// for this module is stronger than "check the status": WHEN A COMMAND
// SUCCEEDS AND RETURNS NOTHING, PROVE THAT NOTHING IS THE RIGHT ANSWER
// BEFORE BELIEVING IT. Every place below that could see an empty result
// either forces text treatment (`--text`), reads a status that would
// reveal an unusable reference before trusting it, or names, in a comment,
// why an empty result there is known-correct rather than merely observed.
//
// THE SCOPE IS A UNION, NEVER A CHOICE BETWEEN BASES. The first version of
// `auto` picked exactly one of worktree/merge-base/all by asking "is the
// tree dirty". An untracked scratch file counts as dirty, so leaving one
// lying around flipped the choice to `worktree` (diff against HEAD), which
// sees nothing on a branch whose real work is already committed: a secret
// added today left the scope, in the default setting, because of an
// unrelated file. An either/or is what let one file hide the rest. `auto`
// now always unions what the branch has committed since the default branch
// with what the current worktree differs from that same point, in one
// diff (anchor..worktree, never anchor..HEAD..worktree as two separate
// line-number spaces that could disagree), plus whatever is untracked. A
// union can only over-include, and over-including is this project's
// stated direction when in doubt.
//
// Every external command's status is checked. A probe whose non-zero
// status is itself the answer (is this a repository, does this branch
// exist, is this path tracked, is there a common ancestor at all) uses the
// non-throwing `run`. A command that must succeed once its preconditions
// are known to hold (the diff itself, once a base has resolved to concrete
// refs) uses `runOrThrow`, which raises naming the command and the
// captured error rather than returning empty.
import { isUtf8 } from 'node:buffer';
import { run, runOrThrow } from './exec.mjs';
import { decodeBytes } from './io.mjs';

// Exported (task 6, src/commands/lint.mjs): the lint command validates a
// requested --base itself, before ever calling resolveBase, so a bad value
// is a usage error (exit 2) with a translated message rather than the raw,
// unlocalised Error resolveBase throws below. Reusing THIS array for that
// check, rather than a second hand-typed list in the command, is the same
// no-second-copy discipline this module's own header already states for
// every other fact a caller could otherwise restate and let drift.
export const KNOWN_BASES = Object.freeze(['all', 'worktree', 'merge-base', 'auto']);

// Line numbers come from the hunk header ("@@ -a,b +c,d @@", with either
// count omitted when it is 1), never from counting lines in the body: a
// file whose hunks touch is exactly where counting drifts, and git has
// already done the arithmetic correctly. Anchored at the start of the
// line: with -U0, an ADDED line is content, not a header, and content can
// itself contain the literal text "@@ -1 +1 @@" (a note documenting diff
// syntax, say); without the anchor that text would be mistaken for a real
// hunk header wherever it appeared in the string, not only at the start of
// the line where an actual header always is.
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// A generous but explicit ceiling on captured stdout. Node's own default
// (spawnSync's implicit maxBuffer) is small enough that an ordinary vault
// with a large note or a wide rename set could exceed it; hitting even
// this raised ceiling still surfaces as a normal non-zero `run` result
// (see exec.mjs), never a silent truncation.
const GIT_OPTS = { maxBuffer: 64 * 1024 * 1024 };

// `--literal-pathspecs` (a global git flag, placed before the subcommand)
// disables glob interpretation of every path argument for the rest of the
// invocation. Without it, a real file named with a character git's
// pathspec syntax treats as a wildcard or a character class (a literal
// "[" or "?" or "*" in the name) is read as a PATTERN instead of a path,
// and a diff restricted to "notes[1].md" can silently return the combined
// hunks of every file the pattern happens to match, concatenated with no
// way to tell them apart. Every git call in this module carries it.
function gitArgs(...args) {
  return ['--literal-pathspecs', ...args];
}

function git(root, args) {
  return run('git', gitArgs(...args), { cwd: root, ...GIT_OPTS });
}

function gitOrThrow(root, args) {
  return runOrThrow('git', gitArgs(...args), { cwd: root, ...GIT_OPTS });
}

export function isGitRepo(root) {
  const result = git(root, ['rev-parse', '--is-inside-work-tree']);
  // A BARE repository (no working tree at all) also answers this command
  // with status 0, printing "false" rather than failing; the stdout check
  // is what tells the two apart, not the status alone.
  return result.status === 0 && result.stdout.trim() === 'true';
}

// False for a repository with no commit at all (a freshly `git init`ed
// vault, before its first commit): HEAD is a symbolic ref to a branch
// that does not yet point at any object. Every base but `all` needs a
// real HEAD to diff against or to compute a merge-base from; asking git
// to diff against an unborn HEAD does not return an empty result, it
// exits non-zero ("fatal: bad revision 'HEAD'"), which is exactly the
// kind of surprising failure this module's callers should never see.
function hasAnyCommit(root) {
  return git(root, ['rev-parse', '--verify', '-q', 'HEAD']).status === 0;
}

// The branch HEAD points at, even before the first commit exists: an
// "unborn" branch still has a symbolic HEAD, and `git symbolic-ref` reads
// that name without needing a commit to resolve it to. `null` on a
// detached HEAD, where there is no branch name to give.
function currentBranchName(root) {
  const result = git(root, ['symbolic-ref', '--short', 'HEAD']);
  return result.status === 0 ? result.stdout.trim() : null;
}

// The branch a merge-base or an auto choice compares against, as a name
// git can resolve directly, NOT stripped to a bare branch name. Tried in
// order:
//   1. The remote's own notion of its default branch, via the
//      refs/remotes/origin/HEAD symref, kept QUALIFIED ("origin/main").
//      Stripping this to "main" was the bug: a real clone (the shape a
//      continuous-integration checkout produces) commonly carries the
//      remote-tracking ref but never creates a same-named LOCAL branch at
//      all, so the stripped name resolves to nothing and the merge-base
//      call throws on a perfectly good repository.
//   2. A local branch named "main" or "master".
//   3. A remote-tracking branch named "origin/main" or "origin/master",
//      for a clone that fetched those refs without ever pointing
//      refs/remotes/origin/HEAD at either of them.
// `null` when none of these resolve, which happens on a repository this
// reader cannot identify a default branch for at all: a single-branch
// clone of a branch that is not the default carries none of the three
// signals above, and there is no local information left to try; asking
// the remote live is the only way to learn more, and this module never
// makes a network call.
// The remote whose notion of a default branch this ladder should read.
//
// Fix round 3 (finding F): this ladder and the one in
// templates/githooks/pre-push are the same three steps written twice,
// and they had already drifted on exactly this field. The template takes
// the remote from git itself, which hands a pre-push hook the remote
// being pushed to as its first argument; this module hardcoded
// "origin". The TEMPLATE is the one that was right, because a remote
// called something else is an ordinary thing and neither copy should
// assume otherwise. This module has no push to read a remote from, so it
// reads the one this checkout actually tracks -- the current branch's
// upstream remote -- and falls back to "origin" only when there is no
// upstream to ask. Both copies now say the same thing: the remote this
// context names, and "origin" only as a last resort.
function remoteNameFor(root) {
  const branch = currentBranchName(root);
  if (branch !== null) {
    const configured = git(root, ['config', '--get', `branch.${branch}.remote`]);
    if (configured.status === 0) {
      const name = configured.stdout.trim();
      if (name !== '') return name;
    }
  }
  return 'origin';
}

// Returns `{ name, ref, bare }`, or null: `name` is what a person reads
// and what this module has always returned ("origin/main", "main"),
// `ref` is the full reference git is asked about, and `bare` is the
// branch name alone, with the remote's own name and its slash removed by
// the rung that KNOWS which remote it read (final fix round 2). The
// same-branch guard below compares `bare`, and it used to derive it by
// stripping everything before the first slash of `name`, which is wrong
// the moment a remote's own name contains a slash: git accepts a remote
// called "team/up", whose default branch then read as a branch called
// "up/main", never the branch checked out, and the guard answered "not the
// same branch" about the same branch, which is the empty range at status
// zero it exists to refuse. The symbolic reference is read in full, not
// with --short, because --short shortens to whatever is unambiguous and
// grows a "remotes/" prefix when a local branch shares the name, which no
// fixed strip can undo.
function findDefaultBranch(root) {
  const remote = remoteNameFor(root);
  const remotePrefix = `refs/remotes/${remote}/`;
  const symref = git(root, ['symbolic-ref', `${remotePrefix}HEAD`]);
  if (symref.status === 0) {
    const target = symref.stdout.trim();
    if (target.startsWith(remotePrefix)) {
      const bare = target.slice(remotePrefix.length);
      return { name: `${remote}/${bare}`, ref: target, bare };
    }
    // git itself only ever points this at a branch under the same remote,
    // but a person can point it at a local branch, and that still has a
    // bare name to compare. Anything else has none, so the guard cannot
    // run and the caller degrades rather than trusting a range it cannot
    // check.
    if (target.startsWith('refs/heads/')) {
      const bare = target.slice('refs/heads/'.length);
      return { name: bare, ref: target, bare };
    }
    return { name: target, ref: target, bare: null };
  }
  for (const candidate of ['main', 'master']) {
    if (git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]).status === 0) {
      return { name: candidate, ref: `refs/heads/${candidate}`, bare: candidate };
    }
  }
  for (const candidate of ['main', 'master']) {
    if (git(root, ['show-ref', '--verify', '--quiet', `${remotePrefix}${candidate}`]).status === 0) {
      return { name: `${remote}/${candidate}`, ref: `${remotePrefix}${candidate}`, bare: candidate };
    }
  }
  return null;
}

// Whether `defaultBranchRef` and `currentBranch` name the SAME branch,
// comparing bare names so a qualified "origin/main" still matches a
// current branch called "main". This is the guard against the third real
// clone shape found in review: some checkout tools set
// refs/remotes/origin/HEAD to whatever branch they just fetched, not the
// remote's true default, so a pull request checkout can have its "default
// branch" resolve to the exact branch it is already on. Diffing a branch
// against itself is not an error git reports, it is an empty range
// reported with complete confidence, which is precisely the kind of
// status-zero wrong answer this module exists to catch before a caller
// believes it.
// The bare name is the one findDefaultBranch computed from the remote it
// actually read, never a strip of the qualified name: see that
// function's own comment for the remote whose name holds a slash, which
// defeated both the literal "origin/" strip this used to do and the
// strip-to-the-first-slash that replaced it.
function branchNamesMatch(defaultBranch, currentBranch) {
  if (currentBranch === null) return false;
  return defaultBranch.bare === currentBranch;
}

// The merge-base of HEAD and `ref`, or `null` when none exists. A missing
// merge base is not a malformed request, it is an ordinary outcome on an
// orphan branch (created with `git checkout --orphan`, sharing no history
// with anything) and on the shallow clone a continuous-integration job
// commonly uses (a depth-1 fetch has no ancestor to find at all). `git
// merge-base` reports this with a plain non-zero status, not a fatal
// error, so it is read with the non-throwing probe and turned into `null`
// rather than allowed to raise: a module that promises to fall back to
// the widest scope when a reference cannot be resolved has to keep that
// promise here too, not only for a reference that fails to exist at all.
function tryMergeBase(root, ref) {
  const result = git(root, ['merge-base', 'HEAD', ref]);
  return result.status === 0 ? result.stdout.trim() : null;
}

// Resolves an explicit `merge-base` request (used directly, and by `auto`
// once it has decided a merge-base comparison is safe). Degrades to `all`
// rather than raising whenever the comparison would be meaningless or
// impossible: no default branch identifiable, the default branch turning
// out to be the branch already checked out, or no common ancestor at all.
function resolveMergeBase(root, requested, reason) {
  const defaultBranch = findDefaultBranch(root);
  if (defaultBranch === null || defaultBranch.bare === null) {
    return { kind: 'all', requested, reason: 'merge-base-unavailable' };
  }
  if (branchNamesMatch(defaultBranch, currentBranchName(root))) {
    return { kind: 'all', requested, reason: 'merge-base-same-as-current' };
  }
  const mergeBaseSha = tryMergeBase(root, defaultBranch.ref);
  if (mergeBaseSha === null) {
    return { kind: 'all', requested, reason: 'merge-base-unavailable' };
  }
  return { kind: 'merge-base', requested, reason, defaultBranch: defaultBranch.name, mergeBaseSha };
}

// Resolves a requested base ("all" | "worktree" | "merge-base" | "auto")
// into the concrete decision `changedPaths` and `addedLines` consume.
//
// `all` is every markdown file and every line. `worktree` is what differs
// from HEAD (the current worktree compared to the last commit), which is
// what a session about to propose cares about. `merge-base` is what
// differs, commit to commit, between the merge base with the repository's
// default branch and HEAD, which is what a pull request cares about: a
// PR's diff is its committed content, not whatever is still sitting
// uncommitted in someone's worktree.
//
// `auto` is a UNION, not a choice: it always includes whatever is
// untracked, and it diffs the current worktree directly against the
// earliest point it can safely anchor to (the merge base with the default
// branch, when one is safely identifiable; HEAD otherwise). Anchoring
// directly at the merge base, rather than diffing branch-to-HEAD and
// HEAD-to-worktree separately and merging two different line-number
// spaces, is what lets committed branch work and uncommitted worktree
// work show up together correctly even when a file carries both.
//
// One exception, fix round 2: on the default branch, with a clean tree
// and nothing untracked, `auto` resolves to `all` rather than a real but
// EMPTY union. A union with nothing in it is not a narrower answer than
// "everything", it is the SAME failure the union was built to fix, one
// step removed: a vault whose only note already carries a committed
// secret, checked from a clean default-branch checkout (a person's first
// run), has nothing left to union over, and reporting that honestly as
// "nothing changed" is indistinguishable on screen from a genuine clean
// bill of health. Where there is no change to scope to, the honest scope
// is everything, because that is what "lint my vault" means when there
// is nothing more specific to mean. A real uncommitted edit or a new
// untracked note on the default branch is still a genuine, narrower
// change, and stays a real `auto` union exactly as before; only the
// truly-nothing-to-union case widens.
//
// A repository with no commit yet, and a repository this reader cannot
// even confirm is a git repository, both degrade to `all`, never an
// error: a vault is markdown first and a repository second. `reason` is a
// short, machine-readable code, not a formed sentence: this module has no
// notion of the language packs, and the command that prints "which base
// was chosen and why" (a later task) is the one that owns turning
// `reason` into a message key.
export function resolveBase(root, requested) {
  if (!KNOWN_BASES.includes(requested)) {
    const error = new Error(`unknown base: ${requested} (expected one of ${KNOWN_BASES.join(', ')})`);
    error.code = 'unknown-base';
    throw error;
  }
  if (!isGitRepo(root)) {
    return { kind: 'all', requested, reason: 'outside-repo' };
  }
  if (requested === 'all') {
    return { kind: 'all', requested, reason: 'all-explicit' };
  }
  if (!hasAnyCommit(root)) {
    return { kind: 'all', requested, reason: 'no-commits' };
  }
  if (requested === 'worktree') {
    return { kind: 'worktree', requested, reason: 'worktree-explicit' };
  }
  if (requested === 'merge-base') {
    return resolveMergeBase(root, requested, 'merge-base-explicit');
  }
  // auto: union. The merge-base component is included only when it is
  // both identifiable and not degenerate; otherwise the union simply has
  // one fewer term, never a different STRATEGY.
  const found = findDefaultBranch(root);
  // A default branch whose bare name could not be read cannot be compared
  // against the branch checked out, so it is treated as no default branch
  // at all: the union anchors at HEAD, and says why.
  const defaultBranch = found !== null && found.bare !== null ? found : null;
  const current = currentBranchName(root);
  if (defaultBranch !== null && !branchNamesMatch(defaultBranch, current)) {
    const mergeBaseSha = tryMergeBase(root, defaultBranch.ref);
    if (mergeBaseSha !== null) {
      return { kind: 'auto', requested, reason: 'auto-since-merge-base', anchor: mergeBaseSha, defaultBranch: defaultBranch.name };
    }
    return { kind: 'auto', requested, reason: 'auto-merge-base-unavailable', anchor: 'HEAD' };
  }
  if (defaultBranch === null) {
    return { kind: 'auto', requested, reason: 'auto-no-default-branch', anchor: 'HEAD' };
  }
  // Genuinely on the default branch (not merely a checkout tool's
  // mis-set symref claiming so, per the guard above). Fix round 2:
  // measured against a vault whose only note carried an access key,
  // committed on the default branch with a clean tree and nothing
  // untracked. `auto` used to answer this exactly like every other
  // "on the default branch" state, diffing HEAD against the worktree
  // and finding nothing, because there WAS nothing left to diff: the
  // secret was already fully committed. It reported that honestly
  // ("checking what differs from HEAD, plus any untracked file") and
  // the honesty was the problem, not the accuracy: a person's first run
  // is exactly this shape, on their own main branch with nothing
  // uncommitted, and a tool that answers "I checked nothing" to "lint my
  // vault" is useless however truthfully it says so. Where there is no
  // change to scope TO, the honest scope is everything, because that is
  // what the question means. This is checked directly, not inferred from
  // "on the default branch" alone: a real uncommitted edit or a new
  // untracked note on the default branch is still a real, narrower
  // change worth scoping to exactly as before, and stays `auto`.
  const nothingChanged = diffNameOnly(root, ['HEAD']).length === 0 && untrackedPaths(root).length === 0;
  if (nothingChanged) {
    return { kind: 'all', requested, reason: 'auto-on-default-branch-clean' };
  }
  return { kind: 'auto', requested, reason: 'auto-on-default-branch', anchor: 'HEAD' };
}

// The de-duplicated, sorted union of several path lists, used wherever a
// union of sources is combined into one file list.
function unionOf(lists) {
  return Array.from(new Set(lists.flat())).sort();
}

// `git diff --name-only` for the given ref arguments (one ref, compared
// against the current worktree, or two refs, compared commit to commit),
// filtered to the paths that survive it. `--diff-filter=d` (lower case)
// excludes only deletions and keeps every other kind of change,
// additions, modifications, typechanges, copies and renames included; an
// allow-list of change kinds is a blind spot by construction, see
// .githooks/pre-push's own fourth lesson. `-M` makes rename detection
// explicit rather than dependent on the running machine's `diff.renames`
// config.
//
// No `--text` here, unlike the per-file diff below: a name-only listing
// prints the path whether git calls its content binary or not (verified
// directly against git, not assumed), so forcing text treatment would
// change nothing this function could ever be shown to depend on. Adding
// a flag that cannot be proven to matter is exactly the kind of clause
// this project's own review process flags as undefended; `addedLines`,
// which actually reads hunks, is where `--text` earns its place.
// `--relative` (fix round 3, finding H): the paths come back relative to
// the directory git was run in, which is the VAULT root, not the
// repository root. Without it, a vault nested inside a larger repository
// got repository-relative paths here while every other path in the scope
// contract, and every path a rule ever sees, is vault-relative. The two
// agreed only for a vault that happens to BE the repository root, which
// is every fixture in this suite and most real vaults, which is exactly
// how a mismatch like this survives. `git ls-files` (untrackedPaths
// below) already printed paths relative to its own cwd, so this flag is
// also what makes the two halves of the `auto` union agree with each
// other.
function diffNameOnly(root, refArgs) {
  const result = gitOrThrow(root, ['diff', '--name-only', '--relative', '-z', '--diff-filter=d', '-M', ...refArgs]);
  return result.stdout.split('\0').filter((path) => path.length > 0);
}

// The VAULT-relative paths a resolved base considers changed. `null` for
// the `all` base: the caller's own vault walk is the file list. For
// `auto`, the union also includes every untracked path, for the same
// reason `addedLines` treats an untracked file as entirely in scope: a
// file git has never seen is exactly the kind of change a scratch file
// must never be allowed to hide.
export function changedPaths(root, base) {
  if (base.kind === 'all') return null;
  if (base.kind === 'merge-base') {
    return diffNameOnly(root, [base.mergeBaseSha, 'HEAD']);
  }
  const anchor = base.kind === 'worktree' ? 'HEAD' : base.anchor;
  const changed = diffNameOnly(root, [anchor]);
  if (base.kind === 'auto') {
    return unionOf([changed, untrackedPaths(root)]);
  }
  return changed;
}

// True when git has never seen `relPath` at all (a brand new, unstaged
// file). Deliberately distinct from "changed": an untracked path has no
// diff to read, so `addedLines` short-circuits before ever calling git
// diff on it.
function isUntracked(root, relPath) {
  return git(root, ['ls-files', '--error-unmatch', '--', relPath]).status !== 0;
}

// If `relPath` is the destination of a detected rename within the ref
// range `refArgs` covers, the path it was renamed FROM; otherwise `null`.
// Needed because a diff restricted to a single pathspec cannot detect a
// rename at all: git can only recognise a rename by comparing the OLD
// path's content against the NEW path's, and a pathspec that excludes the
// old path excludes exactly the evidence needed. Without this, a vault
// reorganisation (every note kept byte-for-byte, only moved) would report
// every line of every moved note as newly added, which is precisely the
// adoption failure this module's own opening comment exists to prevent.
//
// `--name-status -z` is used rather than the human patch format: its
// fields are NUL-separated and never quoted, so a path with a space or an
// accented character never has to be reconstructed from an ambiguous
// "a/X b/Y" header line, and a rename record is unambiguously three
// fields (status, from, to) versus an ordinary record's two.
function findRenameSource(root, refArgs, relPath) {
  const result = gitOrThrow(root, ['diff', '--name-status', '-M', '-z', ...refArgs]);
  const tokens = result.stdout.split('\0').filter((token) => token.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (status.startsWith('R')) {
      const [, from, to] = tokens.slice(i, i + 3);
      if (to === relPath) return from;
      i += 3;
    } else {
      i += 2;
    }
  }
  return null;
}

// The ref arguments a resolved base's diff runs against: one ref, meaning
// "compared against the current worktree", for `worktree` and `auto`; two
// refs, meaning "compared commit to commit, worktree state irrelevant",
// for `merge-base`.
function refArgsFor(base) {
  if (base.kind === 'merge-base') return [base.mergeBaseSha, 'HEAD'];
  return [base.kind === 'worktree' ? 'HEAD' : base.anchor];
}

// The lines a resolved base considers ADDED in `relPath`, with their
// text, in file order. `null` for the `all` base and for an untracked
// path: in both cases every line of the file is in scope, not merely the
// ones a diff would enumerate.
//
// Parsed from `-M -U0 --no-color --text` output. With zero context lines,
// every line inside a hunk body is either a removal (present only in the
// old file, so it never advances the new-file line counter) or an
// addition (present in the new file, at exactly the position the running
// counter says, since git already computed that position in the hunk
// header and this reader never recomputes it by counting). The counter is
// reset to "not yet in a hunk" not only once at the start of the output
// but at the start of EVERY "diff --git" section: a typechange (a symlink
// replaced by a regular file, say) emits two complete sections for the
// same single path, one deleting the old type and one adding the new one,
// and without this reset the second section's own "+++ b/path" header
// line, which also starts with a bare "+", gets read as an added line at
// whatever position the FIRST section's last hunk happened to leave the
// counter, typically zero.
export function addedLines(root, base, relPath) {
  if (base.kind === 'all') return null;
  if (isUntracked(root, relPath)) return null;
  const refArgs = refArgsFor(base);
  const renameSource = findRenameSource(root, refArgs, relPath);
  const pathArgs = renameSource !== null ? [renameSource, relPath] : [relPath];
  const result = gitOrThrow(root, ['diff', '-M', '-U0', '--no-color', '--text', ...refArgs, '--', ...pathArgs]);
  const added = [];
  let currentLine = null;
  for (const rawLine of result.stdout.split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      currentLine = null;
      continue;
    }
    const hunk = HUNK_HEADER.exec(rawLine);
    if (hunk) {
      currentLine = Number(hunk[1]);
      continue;
    }
    if (currentLine === null) continue; // still in a section's own header, before its first hunk
    if (rawLine.startsWith('+')) {
      // A trailing carriage return (a CRLF file) is not part of the line's
      // content by this project's own convention; context.readFile strips
      // it too (see src/vault.mjs's header), so the text captured here
      // must agree with what a rule actually reads.
      added.push({ line: currentLine, text: rawLine.slice(1).replace(/\r$/, '') });
      currentLine += 1;
    }
    // A '-' line is consumed only from the old file; the new-file line
    // pointer does not move for it.
  }
  return added;
}

// Splits git's NUL-terminated `-z` output, held as BYTES, into its fields,
// each still bytes: a path is decoded only once it is known to be valid
// UTF-8 (see publishablePaths), never before.
function splitNulFields(bytes) {
  const fields = [];
  let start = 0;
  for (let at = bytes.indexOf(0, start); at !== -1; at = bytes.indexOf(0, start)) {
    if (at > start) fields.push(bytes.subarray(start, at));
    start = at + 1;
  }
  if (start < bytes.length) fields.push(bytes.subarray(start));
  return fields;
}

// EVERY FILE A PUSH FROM THIS VAULT COULD PUBLISH, as git itself answers
// it (final fix round 2): what git tracks under `root`, plus what `git add
// -A` would add, which is every untracked file git does not ignore. This
// is the set the `secrets` lint rule reads inside a repository, and the
// question it answers is deliberately git's, not the vault walk's:
//
//   - DOT-PATHS ARE IN IT. `.env`, `.aws/credentials`, a workflow file, a
//     note-taking app's plugin settings: the walk skips every one of them
//     by design, and they are the most likely places in a vault for a
//     credential to be. A committed `.env` used to pass with exit 0.
//   - IGNORED FILES ARE NOT. A local file git will never push used to
//     refuse every push of a clean branch, telling the owner to rotate a
//     credential that never left the machine.
//   - `.git` NEVER IS: git does not list its own directory.
//
// Four kinds of entry are returned apart from `files`, because none of
// them is a file whose bytes this vault publishes, and each must be SAID
// rather than dropped:
//
//   - `gitlinks`: a submodule (mode 160000). What the push publishes is a
//     commit id in another repository; there is nothing here to read.
//   - `embedded`: an untracked directory holding a repository of its own,
//     which git lists as the directory itself (with a trailing slash)
//     rather than its files; `git add -A` would add it as a gitlink.
//   - `undecodable`: a path whose bytes are not valid UTF-8, which Node
//     cannot hand to the filesystem by name. It exists, and it is
//     published, so the caller must refuse rather than pass it; each is
//     given here in the one decoding every scanner shares, for display.
//
// `null` outside a repository. A git call that fails raises, naming the
// command, like every other must-succeed call in this module.
export function publishablePaths(root) {
  if (!isGitRepo(root)) return null;
  const options = { cwd: root, ...GIT_OPTS, encoding: 'buffer' };
  const staged = runOrThrow('git', gitArgs('ls-files', '-z', '--stage'), options).stdout;
  const others = runOrThrow('git', gitArgs('ls-files', '-z', '--others', '--exclude-standard'), options).stdout;

  const files = new Set();
  const gitlinks = new Set();
  const embedded = new Set();
  const undecodable = new Set();
  const place = (pathBytes, into) => {
    if (!isUtf8(pathBytes)) {
      undecodable.add(decodeBytes(pathBytes));
      return;
    }
    into.add(pathBytes.toString('utf8'));
  };

  // `--stage` prints "<mode> <object> <stage>\t<path>". An unmerged path
  // appears once per stage; the sets fold the repeats.
  for (const record of splitNulFields(staged)) {
    const tab = record.indexOf(0x09);
    if (tab === -1) throw new Error('git ls-files --stage produced a record with no path in it');
    const mode = record.subarray(0, record.indexOf(0x20)).toString('latin1');
    place(record.subarray(tab + 1), mode === '160000' ? gitlinks : files);
  }
  for (const record of splitNulFields(others)) {
    if (record[record.length - 1] === 0x2f) {
      place(record.subarray(0, record.length - 1), embedded);
    } else {
      place(record, files);
    }
  }
  const sorted = (set) => [...set].sort();
  return { files: sorted(files), gitlinks: sorted(gitlinks), embedded: sorted(embedded), undecodable: sorted(undecodable) };
}

// The vault-relative paths git has never seen at all (`git ls-files`
// prints relative to the directory it runs in, which is the vault root): not in the index, not
// in any commit. `--exclude-standard` honours .gitignore, so an ignored
// file (a build artifact, an editor's scratch file) is never treated as
// vault content. `[]` outside a repository, without ever invoking git:
// there is no tracked/untracked distinction to make there.
export function untrackedPaths(root) {
  if (!isGitRepo(root)) return [];
  const result = gitOrThrow(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return result.stdout.split('\0').filter((path) => path.length > 0);
}
