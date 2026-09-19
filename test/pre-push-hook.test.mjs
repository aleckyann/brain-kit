import { test } from 'node:test';
import { makeTempDir } from './helpers/tmp.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, chmodSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const HOOK = join(KIT_ROOT, '.githooks', 'pre-push');
// The hook now calls `brain-kit scan-blobs` (bin/brain-kit.mjs, dispatched
// through src/cli.mjs) rather than importing src/leak.mjs directly, so the
// scratch repo needs a working copy of the whole package, not just that one
// module: cli.mjs's own command map imports every built-in command eagerly
// (hook, validate, lint, scan-blobs), so even running scan-blobs alone drags
// in validate's and lint's own dependency graph (schema/, lang/, config.mjs,
// vault.mjs, and the rest of src/). Copying the package wholesale, at test
// time, from this real checkout is what keeps this fixture from drifting out
// of sync with whatever src/ actually contains.
const KIT_DIRS_TO_MIRROR = ['bin', 'src', 'lang', 'schema'];

function git(cwd, args, env = {}) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

function setup() {
  const root = makeTempDir('brain-kit-prepush-');
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  mkdirSync(join(work, '.githooks'));
  copyFileSync(HOOK, join(work, '.githooks', 'pre-push'));
  chmodSync(join(work, '.githooks', 'pre-push'), 0o755);
  // Mirror the whole package (see KIT_DIRS_TO_MIRROR's own comment above),
  // plus package.json, which src/version.mjs's kitVersion() reads relative
  // to KIT_ROOT. None of this is ever `git add`ed by the commit() helper
  // below (it only stages the one file it is given), so it never reaches a
  // commit or a push; it only has to be present on disk for `brain-kit
  // scan-blobs` to run.
  for (const dir of KIT_DIRS_TO_MIRROR) {
    cpSync(join(KIT_ROOT, dir), join(work, dir), { recursive: true });
  }
  copyFileSync(join(KIT_ROOT, 'package.json'), join(work, 'package.json'));
  git(work, ['config', 'core.hooksPath', '.githooks']);
  git(work, ['remote', 'add', 'origin', bare]);
  const patterns = join(root, 'patterns.txt');
  writeFileSync(patterns, 'hunter2corp\nsecret[- ]partner\n');
  return { work, bare, patterns };
}

function commit(work, file, content, message) {
  writeFileSync(join(work, file), content);
  git(work, ['add', file]);
  assert.equal(git(work, ['commit', '-q', '-m', message]).status, 0);
}

test('clean content pushes', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
});

test('a personal pattern blocks the push, case-insensitively, naming the file', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in notes\.md/);
});

test('a private key header blocks the push even without a personal pattern', () => {
  const { work, patterns } = setup();
  // Header assembled at runtime so the repository's own leak gate does not trip on this fixture.
  commit(work, 'key.pem', ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ') + '\nabc\n', 'key');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in key\.pem/);
});

test('a missing patterns file refuses the push (fail closed)', () => {
  const { work } = setup();
  commit(work, 'README.md', 'hello\n', 'init');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: join(work, 'nope.txt') });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /leak patterns file not found/);
});

test('a leak buried in an intermediate commit still blocks the push, even after a later commit removes it', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  const leakSha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  commit(work, 'notes.md', 'Meeting with a partner tomorrow\n', 'scrub');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in notes\.md/);
  assert.match(r.stderr, new RegExp(leakSha.slice(0, 7)));
});

test('a tag pointing at already-pushed commits is allowed', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(git(work, ['tag', '-a', 'v1', '-m', 'v1']).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'v1'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
});

test('a push with nothing new to scan still enforces the patterns file', () => {
  // Same shape as the tag test above (a ref update that resolves to an
  // EMPTY commit range, nothing genuinely new to read), but with a patterns
  // file that cannot do its job. `brain-kit scan-blobs` is called exactly
  // once per push regardless of whether anything ended up in its input
  // (.githooks/pre-push's own sixth-round comment): loadPatterns' own
  // fail-closed check must still run, and still refuse, even though the
  // NUL-separated pairs file handed to it on stdin is empty.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(git(work, ['tag', '-a', 'v1', '-m', 'v1']).status, 0);
  const missingPatterns = join(work, '..', 'missing-patterns.txt');
  const r = git(work, ['push', '-q', 'origin', 'v1'], { BRAIN_KIT_LEAK_PATTERNS: missingPatterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /leak patterns file not found/);
});

test('a new branch is still scanned for its own commits', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(git(work, ['checkout', '-q', '-b', 'feature']).status, 0);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  const r = git(work, ['push', '-q', 'origin', 'feature'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in notes\.md/);
});

test('a stale-ahead tracking ref does not hide an unpublished commit', () => {
  const { work, bare, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  const commit1 = git(work, ['rev-parse', 'HEAD^']).stdout.trim();
  const commit2 = git(work, ['rev-parse', 'HEAD']).stdout.trim();

  // Simulate another clone pushing main forward to commit2 without this
  // hook installed (--no-verify), so the objects genuinely land on the
  // remote and this work tree's own refs/remotes/origin/main tracking ref
  // advances to commit2 the normal way, via a successful push through the
  // named remote, no fetch involved.
  assert.equal(git(work, ['push', '--no-verify', '-q', 'origin', 'main']).status, 0);
  assert.equal(git(work, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim(), commit2);

  // The remote maintainer (or a raw ref update from elsewhere) then rewinds
  // the remote straight back to commit1, bypassing this work tree entirely.
  // Nobody here ever fetches, so the local tracking ref is left stale-ahead,
  // still claiming the remote has commit2.
  assert.equal(git(bare, ['update-ref', 'refs/heads/main', commit1]).status, 0);

  // The remote really only has commit1 now. The cache still claims commit2.
  // Push a brand new ref that reaches commit2: the old `--not
  // --remotes=origin` logic would exclude commit2 via the stale cache and
  // let the leak through unscanned.
  assert.equal(git(work, ['tag', 'leak-tag', commit2]).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'leak-tag'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in notes\.md/);
});

test('the remote being unreachable makes the hook scan everything', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  const localSha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const bogusRemote = join(work, 'does-not-exist.git');
  const ZERO = '0'.repeat(40);

  // A real `git push` to a genuinely unreachable remote never gets as far as
  // invoking pre-push: git needs a live ref advertisement from the remote to
  // compute remote_sha before the hook runs at all, so an unreachable remote
  // fails at that negotiation with git's own fatal error, not the hook's.
  // Invoke the hook the way git would for a brand new ref reaching this
  // commit, so the fallback branch (git ls-remote itself failing) is what
  // gets exercised, deterministically.
  const r = spawnSync(HOOK, [bogusRemote, bogusRemote], {
    cwd: work,
    input: `refs/heads/main ${localSha} refs/heads/main ${ZERO}\n`,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in notes\.md/);
  assert.match(r.stderr, /could not query remote/);
});

test('an existing ref whose remote_sha is unknown to this clone still gets scanned', () => {
  const { work, bare, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  // A second clone of the same bare remote pushes a commit that this work
  // tree never fetches, so its object database genuinely lacks it, not just
  // a stale cache: `remote_sha` (live, from the push negotiation below) will
  // name a commit `work` has never seen.
  const other = join(dirname(bare), 'other');
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', other]).status, 0);
  git(other, ['remote', 'add', 'origin', bare]);
  assert.equal(git(other, ['fetch', '-q', 'origin']).status, 0);
  assert.equal(git(other, ['checkout', '-q', '-b', 'main', 'origin/main']).status, 0);
  commit(other, 'other.md', 'unrelated change from another clone\n', 'other clone commit');
  assert.equal(git(other, ['push', '-q', 'origin', 'main']).status, 0);

  // Back in the original work tree, which never fetched, diverge with a
  // commit carrying a personal pattern, then force-push over the remote's
  // tip, a commit `work` does not have. `remote_sha..local_sha` is an
  // invalid range for this clone: it must fall back to a full scan and
  // catch the leak, not treat the failed range as "nothing to scan".
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  const r = git(work, ['push', '--force', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in notes\.md/);
});

test('a merge commit whose resolution introduces a leak is refused', () => {
  const { work, patterns } = setup();
  commit(work, 'shared notes.txt', 'base\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  // Two branches touch the same line, so the merge stops on a conflict and a
  // human types the resolution.
  assert.equal(git(work, ['checkout', '-q', '-b', 'side']).status, 0);
  commit(work, 'shared notes.txt', 'side branch line\n', 'side');
  assert.equal(git(work, ['checkout', '-q', 'main']).status, 0);
  commit(work, 'shared notes.txt', 'main branch line\n', 'main change');
  assert.notEqual(git(work, ['merge', 'side']).status, 0);

  // The resolution introduces a personal pattern that exists in NEITHER
  // parent, so nothing but the merge commit itself carries it.
  commit(work, 'shared notes.txt', 'Meeting with Hunter2Corp tomorrow\n', 'merge side');
  assert.equal(git(work, ['rev-list', '--parents', '-n', '1', 'HEAD']).stdout.trim().split(' ').length, 3);

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in shared notes\.txt/);
  // `-m` lists the path once per parent it differs from; it is scanned once.
  // The space in the file name makes this cover the dedupe's NUL discipline
  // too: `sort -zu` must keep the separation that `-z` produced.
  assert.equal(r.stderr.match(/possible leak in shared notes\.txt/g).length, 1);
});

test('a blob with a NUL byte is scanned instead of skipped as binary', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  // The NUL byte up front is what makes git and grep call this blob binary;
  // the personal pattern sits on a later line.
  commit(work, 'payload.bin', 'HDR \n\nMeeting with Hunter2Corp tomorrow\n', 'binary leak');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in payload\.bin/);
});

test('a patterns file that cannot do its job refuses the push', () => {
  // Readable but empty: it contributes no personal pattern at all, which used
  // to look exactly like a clean scan. src/leak.mjs's own
  // readPersonalPatternLines treats "empty" and "only comments and blanks"
  // as the same failure (see its own header), so both are covered by this
  // one message.
  {
    const { work } = setup();
    const empty = join(work, '..', 'empty-patterns.txt');
    writeFileSync(empty, '');
    commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
    const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: empty });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /leak patterns file has no usable pattern/);
    // Refused before a single blob is read: loadPatterns is called before
    // standard input is even consumed (see scan-blobs.mjs's own header), so
    // the leaked notes.md never gets a chance to be named at all here.
    assert.doesNotMatch(r.stderr, /notes\.md/);
  }
  // An invalid regular expression in the personal list: src/leak.mjs's own
  // compilePattern raises immediately, naming the FILE and the LINE the bad
  // pattern is on, never the pattern's own text (a personal pattern's text
  // is never printed, compile failure or not). This refuses the push before
  // any blob is read, unlike the old shell version, which only discovered
  // the broken regex the first time grep actually ran against a blob.
  {
    const { work } = setup();
    const broken = join(work, '..', 'broken-patterns.txt');
    writeFileSync(broken, 'hunter2corp\n[unclosed\n');
    commit(work, 'README.md', 'nothing secret here\n', 'clean');
    const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: broken });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /could not compile the personal leak pattern on line 2 of/);
    assert.doesNotMatch(r.stderr, /README\.md/);
  }
});

test('a typechange from symlink to regular file is scanned', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  symlinkSync('README.md', join(work, 'link'));
  assert.equal(git(work, ['add', 'link']).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'symlink']).status, 0);
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  // Replace the symlink with a regular file carrying a personal pattern. Git
  // records this as T, a typechange, which an A/M allow-list drops.
  unlinkSync(join(work, 'link'));
  commit(work, 'link', 'Meeting with Hunter2Corp tomorrow\n', 'typechange');
  assert.match(git(work, ['diff-tree', '-r', '--no-commit-id', '--name-status', 'HEAD']).stdout, /^T\s+link/m);

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in link/);
});

test('a blob that cannot be read refuses the push instead of passing', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  // A gitlink (mode 160000) whose commit this clone does not have, which is
  // the ordinary state of a submodule entry. `git show <sha>:subm` exits 128
  // on it, so the scan reads nothing at all: that must refuse, not pass.
  const missing = '1'.repeat(40);
  assert.equal(git(work, ['update-index', '--add', '--cacheinfo', `160000,${missing},subm`]).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'gitlink']).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not read subm/);
  assert.match(r.stderr, /git show exited 128/);
});

test('a commit whose tree object cannot be listed refuses the push instead of scanning nothing', () => {
  // A root commit (no parent) is listed with `git ls-tree -r -z --name-only
  // "$commit"`, not `git diff-tree`: corrupt exactly that path by deleting
  // the commit's own tree object from the object database, which is not a
  // shape any ordinary push can produce, but proves the `list_status -ne 0`
  // check this hook has always made (unchanged by the sixth round: this is
  // still bash asking git a question about a commit's shape, never blob
  // content) still refuses rather than silently treating an unlistable
  // commit as one with nothing to scan.
  const { work, patterns } = setup();
  writeFileSync(join(work, 'README.md'), 'hello world\n');
  git(work, ['add', 'README.md']);
  assert.equal(git(work, ['commit', '-q', '-m', 'init']).status, 0);
  const treeSha = git(work, ['cat-file', '-p', 'HEAD']).stdout.split('\n')[0].split(' ')[1];
  const objectPath = join(work, '.git', 'objects', treeSha.slice(0, 2), treeSha.slice(2));
  unlinkSync(objectPath);

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not list the files of/);
});

test('a patterns file that is a directory refuses the push (fail closed)', () => {
  const { work } = setup();
  const asDir = join(work, '..', 'patterns-dir');
  mkdirSync(asDir);
  commit(work, 'README.md', 'nothing secret here\n', 'clean');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: asDir });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /leak patterns file is not a regular file/);
  assert.doesNotMatch(r.stderr, /README\.md/);
});

// --- brain-kit scan-blobs, called directly ------------------------------
//
// The gate above only ever exercises `brain-kit scan-blobs` through a real
// `git push`, which is right for proving the GATE never lets a leak
// through, but the subcommand is its own interface (see
// src/commands/scan-blobs.mjs's own header) and deserves its own direct
// coverage of the contract task-7-brief.md names: it refuses a blob
// carrying a pattern and accepts one that does not, over a stdin protocol
// bash itself has to produce correctly. This never bypasses the live gate
// to test it (it does not touch .githooks/pre-push, and never pushes
// anything to the bare remote); it tests the one piece the gate delegates
// to, the same way the gate itself will be run for real.
const BRAIN_KIT_BIN = () => join(KIT_ROOT, 'bin', 'brain-kit.mjs');

function scanBlobs(work, pairs, env = {}) {
  const input = pairs.map(([sha, path]) => `${sha}\0${path}\0`).join('');
  return spawnSync('node', [BRAIN_KIT_BIN(), 'scan-blobs'], {
    cwd: work,
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('scan-blobs refuses a blob carrying a pattern and accepts one that does not, in the same run', () => {
  const { work, patterns } = setup();
  commit(work, 'clean.md', 'nothing secret here\n', 'clean');
  writeFileSync(join(work, 'dirty.md'), 'Meeting with Hunter2Corp tomorrow\n');
  git(work, ['add', 'dirty.md']);
  assert.equal(git(work, ['commit', '-q', '-m', 'dirty']).status, 0);
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();

  const r = scanBlobs(work, [[sha, 'clean.md'], [sha, 'dirty.md']], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in dirty\.md/);
  assert.doesNotMatch(r.stderr, /possible leak in clean\.md/);
  // NEVER PRINT WHAT IT FOUND (leak.mjs's own contract): the personal
  // pattern's own matched text never reaches this output.
  assert.doesNotMatch(r.stderr, /Hunter2Corp/i);
});

test('scan-blobs accepts a push where every blob is clean, printing nothing', () => {
  const { work, patterns } = setup();
  commit(work, 'a.md', 'nothing secret here\n', 'a');
  commit(work, 'b.md', 'also nothing secret\n', 'b');
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();

  const r = scanBlobs(work, [[sha, 'a.md'], [sha, 'b.md']], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('scan-blobs surfaces truncation rather than silently capping at its print limit', () => {
  const { work, patterns } = setup();
  // Eight hits of the same personal pattern on eight separate lines, well
  // past the five-per-blob print cap (src/commands/scan-blobs.mjs's own
  // MAX_MATCHES_PER_BLOB): a caller that destructures only `matches` out
  // of scanText's return and drops `truncated`/`total` would report five
  // and say nothing about the other three (leak.mjs's own header names
  // this exact mistake for a sibling caller).
  const lines = Array.from({ length: 8 }, () => 'Meeting with Hunter2Corp tomorrow').join('\n') + '\n';
  writeFileSync(join(work, 'busy.md'), lines);
  git(work, ['add', 'busy.md']);
  assert.equal(git(work, ['commit', '-q', '-m', 'busy']).status, 0);
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();

  const r = scanBlobs(work, [[sha, 'busy.md']], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in busy\.md/);
  assert.match(r.stderr, /and 3 more match\(es\)/);
});

test('scan-blobs continues past an unreadable blob and still reports a later leak', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  writeFileSync(join(work, 'dirty.md'), 'Meeting with Hunter2Corp tomorrow\n');
  git(work, ['add', 'dirty.md']);
  assert.equal(git(work, ['commit', '-q', '-m', 'dirty']).status, 0);
  const sha2 = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const missing = '2'.repeat(40);

  const r = scanBlobs(work, [[missing, 'no-such-blob.md'], [sha, 'README.md'], [sha2, 'dirty.md']], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not read no-such-blob\.md/);
  assert.match(r.stderr, /possible leak in dirty\.md/);
});
