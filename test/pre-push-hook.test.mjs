import { test } from 'node:test';
import { makeTempDir } from './helpers/tmp.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const HOOK = join(KIT_ROOT, '.githooks', 'pre-push');
const LEAK_MODULE = join(KIT_ROOT, 'src', 'leak.mjs');

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
  // The hook reads its generic patterns from src/leak.mjs, sibling to
  // .githooks/ in a real brain-kit checkout, rather than carrying its own
  // copy: mirror that one relevant file here so the scratch repo resolves
  // it exactly as the maintainer's real clone does.
  mkdirSync(join(work, 'src'));
  copyFileSync(LEAK_MODULE, join(work, 'src', 'leak.mjs'));
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
  // to look exactly like a clean scan.
  {
    const { work } = setup();
    const empty = join(work, '..', 'empty-patterns.txt');
    writeFileSync(empty, '');
    commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
    const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: empty });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /leak patterns file is empty/);
  }
  // A regex grep cannot compile: grep exits above 1, having said nothing at
  // all about the content, so the push must be refused, not waved through.
  {
    const { work } = setup();
    const broken = join(work, '..', 'broken-patterns.txt');
    writeFileSync(broken, 'hunter2corp\n[unclosed\n');
    commit(work, 'README.md', 'nothing secret here\n', 'clean');
    const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: broken });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /could not scan README\.md/);
    assert.match(r.stderr, /grep exited [2-9]/);
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
