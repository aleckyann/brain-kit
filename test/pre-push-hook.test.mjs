import { test } from 'node:test';
import { makeTempDir } from './helpers/tmp.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, cpSync, chmodSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const HOOK = join(KIT_ROOT, '.githooks', 'pre-push');
// The hook runs `brain-kit scan-blobs` from the TOOLCHAIN IT EXTRACTS OUT OF
// THE COMMIT BEING PUSHED (seventh round, (i)), not from the working tree, so
// a scratch repository has to CARRY the package in its history rather than
// merely have it on disk: bin/, src/, lang/ and schema/ plus package.json are
// committed by setup() below as the repository's first commit. cli.mjs's own
// command map imports every built-in command eagerly (hook, validate, lint,
// scan-blobs), so even running scan-blobs alone drags in validate's and
// lint's dependency graph, and createTranslator reads lang/ before any
// command dispatches at all; schema/ and package.json follow the same
// package. Copying the package wholesale, at test time, from this real
// checkout is what keeps this fixture from drifting out of sync with
// whatever src/ actually contains.
const KIT_DIRS_TO_MIRROR = ['bin', 'src', 'lang', 'schema'];
const TOOLCHAIN_PATHS = [...KIT_DIRS_TO_MIRROR, 'package.json'];

function git(cwd, args, env = {}) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

// `publishToolchain: false` leaves the first commit unpushed, so a test that
// needs a ROOT commit inside the range it pushes (there is one: the
// unlistable-tree case) can still have one.
function setup({ publishToolchain = true } = {}) {
  const root = makeTempDir('brain-kit-prepush-');
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  mkdirSync(join(work, '.githooks'));
  copyFileSync(HOOK, join(work, '.githooks', 'pre-push'));
  chmodSync(join(work, '.githooks', 'pre-push'), 0o755);
  for (const dir of KIT_DIRS_TO_MIRROR) {
    cpSync(join(KIT_ROOT, dir), join(work, dir), { recursive: true });
  }
  copyFileSync(join(KIT_ROOT, 'package.json'), join(work, 'package.json'));
  assert.equal(git(work, ['add', ...TOOLCHAIN_PATHS]).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'the toolchain this gate runs']).status, 0);
  git(work, ['remote', 'add', 'origin', bare]);
  // Pushed BEFORE core.hooksPath points at the hook, so seeding the remote
  // neither runs the gate nor bypasses it with --no-verify.
  if (publishToolchain) {
    assert.equal(git(work, ['push', '-q', 'origin', 'main']).status, 0);
  }
  git(work, ['config', 'core.hooksPath', '.githooks']);
  const patterns = join(root, 'patterns.txt');
  writeFileSync(patterns, 'hunter2corp\nsecret[- ]partner\n');
  return { root, work, bare, patterns };
}

function commit(work, file, content, message, env = {}) {
  writeFileSync(join(work, file), content);
  git(work, ['add', file], env);
  assert.equal(git(work, ['commit', '-q', '-m', message], env).status, 0);
}

// A directory of stand-in executables, to be PREPENDED to PATH so one
// command the hook runs can be replaced for exactly one test. A test that
// needs a command to be MISSING instead builds a directory of its own and
// passes it as the whole PATH.
//
// One thing to know before reaching for this: it cannot replace `git` for
// a hook that git itself invoked, because git puts its own exec directory,
// which holds a `git` of its own, at the front of a hook's PATH. A git
// stand-in only works when the hook is invoked directly, the way the two
// raw-output tests below do it.
function shimDir(root, name, shims) {
  const dir = join(root, `shims-${name}`);
  mkdirSync(dir, { recursive: true });
  for (const [command, body] of Object.entries(shims)) {
    const file = join(dir, command);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
  return dir;
}

function realPath(command) {
  const found = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
  assert.equal(found.status, 0, `${command} must be on PATH for this test`);
  return found.stdout.trim();
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
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
});

test('a private key header blocks the push even without a personal pattern', () => {
  const { work, patterns } = setup();
  // Header assembled at runtime so the repository's own leak gate does not trip on this fixture.
  commit(work, 'key.pem', ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ') + '\nabc\n', 'key');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in key\.pem \(CONTENT/);
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
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
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
  // NUL-separated work list handed to it on stdin is empty.
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
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
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
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
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
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
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
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
});

test('the unknown-range fallback never excludes by the local tracking refs', () => {
  // The single edit a reviewer found that makes this gate pass something it
  // should refuse with the rest of the suite green: teaching the fallback at
  // the heart of the third lesson to exclude `--not --remotes=<remote>`,
  // which is the SECOND lesson's already-defeated design reinstated in the
  // one branch the second lesson's own test does not reach. This is that
  // branch, with a tracking ref that lies about the leak commit already
  // being published.
  const { work, bare, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  const published = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  const leakSha = git(work, ['rev-parse', 'HEAD']).stdout.trim();

  // A commit made INSIDE the bare repository, so this clone has never seen
  // the object: the push negotiation will report it as the remote's tip and
  // `rev-list <it>..<local>` cannot compute, which is what fires the
  // fallback.
  const tree = git(bare, ['rev-parse', `${published}^{tree}`]).stdout.trim();
  const unknown = git(bare, ['commit-tree', tree, '-p', published, '-m', 'made inside the bare repository']).stdout.trim();
  assert.match(unknown, /^[0-9a-f]{40}$/);
  assert.equal(git(bare, ['update-ref', 'refs/heads/main', unknown]).status, 0);

  // The lie: the local cache claims the remote already holds the leak.
  assert.equal(git(work, ['update-ref', 'refs/remotes/origin/main', leakSha]).status, 0);

  const r = git(work, ['push', '--force', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /unknown to this clone/);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
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
  assert.match(r.stderr, /possible leak in shared notes\.txt \(CONTENT/);
  // `-m` lists the path once per parent it differs from; it is scanned once.
  // The space in the file name makes this cover the dedupe's NUL discipline
  // too: `sort -zu` must keep the separation that `-z` produced.
  assert.equal(r.stderr.match(/possible leak in shared notes\.txt \(CONTENT/g).length, 1);
});

test('a blob with a NUL byte is scanned instead of skipped as binary', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  // The NUL byte up front is what makes git and grep call this blob binary;
  // the personal pattern sits on a later line.
  commit(work, 'payload.bin', 'HDR \u0000\nMeeting with Hunter2Corp tomorrow\n', 'binary leak');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in payload\.bin \(CONTENT/);
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
  assert.match(r.stderr, /possible leak in link \(CONTENT/);
});

test('a blob whose object is missing refuses the push instead of passing', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  // An ordinary file whose blob object is then removed from the object
  // database. `git show <commit>:ghost.md` exits 128 on it, so the scan
  // reads nothing at all: that must refuse, not pass. This is the REFUSING
  // side of the skip rule, the gitlink below being the skipping side.
  commit(work, 'ghost.md', 'nothing secret here\n', 'ghost');
  const blob = git(work, ['rev-parse', 'HEAD:ghost.md']).stdout.trim();
  rmSync(join(work, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not read ghost\.md/);
  assert.match(r.stderr, /git show exited 128/);
});

test('a gitlink is skipped out loud instead of refusing every push of the repository', () => {
  // A submodule entry (mode 160000) whose commit this repository does not
  // have, which is the ordinary state of a gitlink. It used to make `git
  // show` exit 128 and the gate refuse every push of such a repository
  // permanently, with --no-verify as the only way out. There was never
  // anything HERE to read: the content lives in another repository.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  const missing = '1'.repeat(40);
  assert.equal(git(work, ['update-index', '--add', '--cacheinfo', `160000,${missing},subm`]).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'gitlink']).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /skipping subm/);
  assert.match(r.stderr, /gitlink \(mode 160000\)/);
});

test('a gitlink whose PATH carries a pattern is still refused', () => {
  // Skipping a gitlink's content is not skipping the gitlink: its path is
  // still a name this push publishes.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  const missing = '1'.repeat(40);
  assert.equal(git(work, ['update-index', '--add', '--cacheinfo', `160000,${missing},hunter2corp-vendor`]).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'vendored']).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /\(PATH, the name itself is withheld\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('a commit whose tree object cannot be listed refuses the push instead of scanning nothing', () => {
  // A root commit (no parent) is listed with `git ls-tree -r -z`, not `git
  // diff-tree`: corrupt exactly that path by deleting the commit's own tree
  // object from the object database, which is not a shape any ordinary push
  // can produce, but proves the status check this hook has always made still
  // refuses rather than silently treating an unlistable commit as one with
  // nothing to scan. The root commit here is the toolchain commit, left
  // unpushed so it falls inside the range, and the TIP is a later commit
  // whose own tree is intact, so the toolchain can still be extracted from
  // it and the refusal under test is the one being aimed at.
  const { work, patterns } = setup({ publishToolchain: false });
  const rootTree = git(work, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  commit(work, 'README.md', 'hello world\n', 'init');
  rmSync(join(work, '.git', 'objects', rootTree.slice(0, 2), rootTree.slice(2)));

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  // Both listing branches are hit by this one corruption, and each is
  // asserted on its own: the root commit cannot be listed with ls-tree, and
  // the commit on top of it cannot be diffed against it either. Asserting
  // only the shared half of the message let either status check be deleted
  // while the other covered for it.
  assert.match(r.stderr, /could not list the files of [0-9a-f]{40} \(git ls-tree failed\)/);
  assert.match(r.stderr, /could not list the files of [0-9a-f]{40} \(git diff-tree failed\)/);
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

// --- the four channels that are not blob content -------------------------

test('a file NAME carrying a pattern is refused, and the name itself is never printed', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  // Content entirely clean. In a vault, a note named after a client is
  // exactly the artefact this gate exists to stop, and the name is the only
  // place the name appears.
  commit(work, 'hunter2corp-contract.md', 'nothing in here at all\n', 'add a note');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in a file name at [0-9a-f]{7} \(PATH, the name itself is withheld\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('a COMMIT MESSAGE carrying a pattern is refused', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  commit(work, 'notes.md', 'nothing secret here\n', 'notes from the Hunter2Corp meeting');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in the message of commit [0-9a-f]{7} \(COMMIT MESSAGE\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('an AUTHOR identity carrying a pattern is refused', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  writeFileSync(join(work, 'notes.md'), 'nothing secret here\n');
  git(work, ['add', 'notes.md']);
  assert.equal(spawnSync('git', ['-c', 'user.name=Hunter2Corp Admin', '-c', 'user.email=hunter2corp@example.invalid', 'commit', '-q', '-m', 'a clean message'], { cwd: work, encoding: 'utf8' }).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in the author of commit [0-9a-f]{7} \(AUTHOR IDENTITY\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('a COMMITTER identity carrying a pattern is refused even when the author is clean', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  writeFileSync(join(work, 'notes.md'), 'nothing secret here\n');
  git(work, ['add', 'notes.md']);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'a clean message'], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'A Human', GIT_AUTHOR_EMAIL: 'human@example.invalid',
      GIT_COMMITTER_NAME: 'Hunter2Corp Admin', GIT_COMMITTER_EMAIL: 'hunter2corp@example.invalid',
    },
  }).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in the committer of commit [0-9a-f]{7} \(COMMITTER IDENTITY\)/);
  assert.doesNotMatch(r.stderr, /possible leak in the author of/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('an annotated TAG MESSAGE carrying a pattern is refused even when every commit it points at is published', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(git(work, ['tag', '-a', 'v2', '-m', 'cut for Hunter2Corp']).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'v2'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in the message of tag object [0-9a-f]{7} \(TAG MESSAGE\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('a TAGGER identity carrying a pattern is refused', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=Hunter2Corp Admin', '-c', 'user.email=hunter2corp@example.invalid', 'tag', '-a', 'v3', '-m', 'an ordinary release'], { cwd: work, encoding: 'utf8' }).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'v3'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in the tagger of tag object [0-9a-f]{7} \(TAGGER IDENTITY\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

// --- the toolchain the gate runs -----------------------------------------

test('an uncommitted edit to the scanner does not weaken the gate', () => {
  // The gate extracts bin/ and src/ (and lang/, schema/, package.json) from
  // the commit being pushed and runs THAT copy. Before it did, one unstaged
  // edit to any module the scanner loads was enough to walk a leak straight
  // through with exit 0, which is a thing an implementer mid-task does by
  // accident, not an attack.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  writeFileSync(join(work, 'src', 'commands', 'scan-blobs.mjs'), [
    '// A deliberately toothless stand-in, left UNCOMMITTED in the working tree.',
    'export function parseEntries() { return []; }',
    'export async function runScanBlobs() { return 0; }',
    '',
  ].join('\n'));
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
});

test('a commit with no toolchain in it refuses the push rather than running someone else', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  assert.equal(git(work, ['checkout', '-q', '--orphan', 'unrelated']).status, 0);
  assert.equal(git(work, ['rm', '-r', '-q', '--cached', '.']).status, 0);
  writeFileSync(join(work, 'only.md'), 'nothing secret here\n');
  assert.equal(git(work, ['add', 'only.md']).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'an unrelated root']).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'unrelated'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not extract the committed toolchain/);
});

test('a commit whose toolchain has no brain-kit.mjs in it refuses the push', () => {
  const { work, patterns } = setup();
  assert.equal(git(work, ['rm', '-q', 'bin/brain-kit.mjs']).status, 0);
  mkdirSync(join(work, 'bin'), { recursive: true });
  writeFileSync(join(work, 'bin', 'keep.txt'), 'bin/ still exists, the entry point does not\n');
  assert.equal(git(work, ['add', 'bin/keep.txt']).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'remove the entry point']).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not contain bin\/brain-kit\.mjs/);
});

// --- the machine the hook runs on ----------------------------------------

test('no node on PATH refuses the push', () => {
  const { root, work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  // A PATH with nothing on it but bash, which /usr/bin/env needs to start
  // the hook at all. The node check is the hook's first statement, so it is
  // reached before anything needs git.
  const dir = join(root, 'path-without-node');
  mkdirSync(dir, { recursive: true });
  symlinkSync(realPath('bash'), join(dir, 'bash'));
  const r = spawnSync(HOOK, ['origin', 'origin'], {
    cwd: work,
    input: '',
    encoding: 'utf8',
    env: { ...process.env, PATH: dir, BRAIN_KIT_LEAK_PATTERNS: patterns },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /node is required/);
});

test('a sort that produces nothing out of something falls back to the undeduped list', () => {
  // The dedupe is an optimisation, never a safety property. A `sort` that
  // exits 0 and prints nothing (this shim; in the wild, a broken userland or
  // a locale surprise) would otherwise empty the work list for that commit
  // and let every blob in it through unscanned, with exit 0.
  const { root, work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');

  const dir = shimDir(root, 'silent-sort', { sort: '#!/usr/bin/env bash\nexit 0\n' });
  const r = git(work, ['push', '-q', 'origin', 'main'], {
    BRAIN_KIT_LEAK_PATTERNS: patterns,
    PATH: `${dir}:${process.env.PATH}`,
  });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
});

test('a work list that cannot be created refuses the push', () => {
  // The scratch file every record is written to, unwritable from the start.
  // Without the status check the whole push scans an empty work list, finds
  // nothing in it, and exits 0 with every blob unexamined.
  const { root, work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');

  const scratch = join(root, 'unwritable-scratch');
  const dir = shimDir(root, 'mktemp', {
    mktemp: [
      '#!/usr/bin/env bash',
      'mkdir -p "$BRAIN_KIT_TEST_SCRATCH"',
      'printf "" > "$BRAIN_KIT_TEST_SCRATCH/pairs"',
      'chmod 0444 "$BRAIN_KIT_TEST_SCRATCH/pairs"',
      'printf "%s\\n" "$BRAIN_KIT_TEST_SCRATCH"',
      '',
    ].join('\n'),
  });
  const r = git(work, ['push', '-q', 'origin', 'main'], {
    BRAIN_KIT_LEAK_PATTERNS: patterns,
    BRAIN_KIT_TEST_SCRATCH: scratch,
    PATH: `${dir}:${process.env.PATH}`,
  });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /could not create the scan work list/);
});

test('a work list that stops accepting records refuses the push instead of scanning the prefix', () => {
  // The dangerous half of the same clause: the list is created, the first
  // records land, and then writing stops (a full disk, a quota). Truncated
  // at a record boundary it parses perfectly, so `scan-blobs` scans what it
  // was given, finds nothing, and the push is accepted with every blob past
  // the truncation never examined. The shim makes the file unwritable
  // exactly when the hook starts listing a commit's files, which is after
  // the first records are already in.
  const { root, work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');

  // The hook sorts each commit's entry list immediately before appending
  // them, so a `sort` that also makes the work list read-only lands the
  // freeze exactly between the records that got in and the ones that do
  // not. (It has to be `sort` rather than `git`: git puts its own exec
  // directory, which contains a `git` of its own, at the front of a hook's
  // PATH, so a git shim never sees a hook's git calls.)
  const scratch = join(root, 'freezing-scratch');
  mkdirSync(scratch, { recursive: true });
  const dir = shimDir(root, 'freezing-sort', {
    sort: [
      '#!/usr/bin/env bash',
      'for d in "$TMPDIR"/brain-kit-prepush.*; do',
      '  [ -f "$d/pairs" ] && chmod 0444 "$d/pairs"',
      'done',
      `exec ${JSON.stringify(realPath('sort'))} "$@"`,
      '',
    ].join('\n'),
  });
  const r = git(work, ['push', '-q', 'origin', 'main'], {
    BRAIN_KIT_LEAK_PATTERNS: patterns,
    TMPDIR: scratch,
    PATH: `${dir}:${process.env.PATH}`,
  });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /could not write the scan work list/);
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

// Records, in the wire shape .githooks/pre-push writes: every field is
// NUL-terminated, and a blob record carries the tree entry's mode.
function blobRecord(sha, path, mode = '100644') {
  return `blob\u0000${sha}\u0000${mode}\u0000${path}\u0000`;
}

function scanBlobs(work, input, env = {}) {
  return spawnSync(process.execPath, [BRAIN_KIT_BIN(), 'scan-blobs'], {
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

  const r = scanBlobs(work, blobRecord(sha, 'clean.md') + blobRecord(sha, 'dirty.md'), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in dirty\.md \(CONTENT/);
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

  const r = scanBlobs(work, blobRecord(sha, 'a.md') + blobRecord(sha, 'b.md'), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('scan-blobs surfaces truncation rather than silently capping at its print limit', () => {
  const { work, patterns } = setup();
  // Eight hits of the same personal pattern on eight separate lines, well
  // past leak.mjs's own five-per-scan print cap: a caller that destructures
  // only `matches` out of scanText's return and drops `truncated`/`total`
  // would report five and say nothing about the other three (leak.mjs's own
  // header names this exact mistake for a sibling caller).
  const lines = Array.from({ length: 8 }, () => 'Meeting with Hunter2Corp tomorrow').join('\n') + '\n';
  writeFileSync(join(work, 'busy.md'), lines);
  git(work, ['add', 'busy.md']);
  assert.equal(git(work, ['commit', '-q', '-m', 'busy']).status, 0);
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();

  const r = scanBlobs(work, blobRecord(sha, 'busy.md'), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in busy\.md \(CONTENT/);
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

  const r = scanBlobs(work, blobRecord(missing, 'no-such-blob.md') + blobRecord(sha, 'README.md') + blobRecord(sha2, 'dirty.md'), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not read no-such-blob\.md/);
  assert.match(r.stderr, /possible leak in dirty\.md \(CONTENT/);
});

test('scan-blobs refuses a work list it cannot parse rather than scanning nothing', () => {
  // A record whose fields ran out, and a kind this version does not know.
  // Both mean the work list that got scanned is not the work list the
  // producer described, which is a push examined in part at best.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();

  const truncated = scanBlobs(work, `blob\u0000${sha}\u0000100644\u0000`, { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(truncated.status, 0);
  assert.match(truncated.stderr, /refusing to guess how to complete it/);

  const unknown = scanBlobs(work, `tree\u0000${sha}\u0000`, { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown kind/);
});

test('scan-blobs refuses when git cannot be run at all', () => {
  // The reader's own "git could not even be started" branch: an empty PATH,
  // with node reached by its absolute path. Treating that as an empty blob
  // would call every file in the push clean.
  const { root, work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const empty = join(root, 'empty-path');
  mkdirSync(empty, { recursive: true });

  const r = scanBlobs(work, blobRecord(sha, 'README.md'), { BRAIN_KIT_LEAK_PATTERNS: patterns, PATH: empty });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not read README\.md/);
  assert.match(r.stderr, /git show could not be run/);
});

test('scan-blobs names a path it cannot hand to git rather than blaming git for losing it', () => {
  // A file name carrying a byte that is not valid UTF-8. Node can only put
  // UTF-8 in an argument list, so this one cannot be handed to git at all;
  // it used to be passed over with a replacement character in it and the
  // push refused with "git show exited 128", which sends whoever reads it
  // to debug git. Fails closed either way; only the diagnosis changes.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();

  // 0xE9 on its own is 'e with an acute accent' in latin1 and is not valid
  // UTF-8 in any sequence, so this fixture is built as BYTES, which is what
  // the hook writes and what this command reads.
  const input = Buffer.concat([
    Buffer.from(`blob\u0000${sha}\u0000100644\u0000caf`, 'latin1'),
    Buffer.from([0xe9]),
    Buffer.from('-notes.md\u0000', 'latin1'),
  ]);
  const r = scanBlobs(work, input, { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is not valid UTF-8/);
  assert.doesNotMatch(r.stderr, /git show exited/);
});

test('a UTF-8 file name still round-trips through the scanner', () => {
  // The other side of the same decision: a path that IS valid UTF-8, accents
  // and all, must reach git unchanged and its content must still be read.
  const { work, patterns } = setup();
  const name = 'reuni\u00e3o.md';
  writeFileSync(join(work, name), 'Meeting with Hunter2Corp tomorrow\n');
  git(work, ['add', name]);
  assert.equal(git(work, ['commit', '-q', '-m', 'accented']).status, 0);
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();

  // The path arrives on standard input as the BYTES git produced, which is
  // how the hook writes it, so the fixture is a Buffer of those same bytes.
  const r = scanBlobs(work, Buffer.from(`blob\u0000${sha}\u0000100644\u0000${name}\u0000`, 'utf8'), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /\(CONTENT, at [0-9a-f]{7}\)/);
  assert.doesNotMatch(r.stderr, /is not valid UTF-8/);
});

test('a scan that cannot finish refuses the push instead of reporting nothing', () => {
  // The deadline, reachable in milliseconds through its documented
  // override instead of in twenty seconds. Two things are pinned here at
  // once: that this command passes a deadline at all (without the argument
  // the library default applies and nothing raises), and that a scan which
  // raises refuses the push rather than printing a line and carrying on.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();

  const r = scanBlobs(work, blobRecord(sha, 'README.md'), {
    BRAIN_KIT_LEAK_PATTERNS: patterns,
    BRAIN_KIT_SCAN_BUDGET_MS: '-1',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not scan/);
  assert.match(r.stderr, /exceeded its deadline/);
});

test('a scan budget that is not a number refuses the push', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();

  const r = scanBlobs(work, blobRecord(sha, 'README.md'), {
    BRAIN_KIT_LEAK_PATTERNS: patterns,
    BRAIN_KIT_SCAN_BUDGET_MS: 'soon',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /BRAIN_KIT_SCAN_BUDGET_MS/);
});

test('a push that only deletes a ref still enforces the patterns file, and passes when it is sound', () => {
  // Nothing is added, so there is nothing to scan, and nothing is the right
  // answer. It is arrived at deliberately: `scan-blobs` still runs (its
  // fail-closed check on the patterns file is not scoped to "only when
  // something was found to scan"), and the toolchain it runs still has to
  // come from a commit, which for a push that carries no tip of its own is
  // HEAD.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(git(work, ['checkout', '-q', '-b', 'doomed']).status, 0);
  assert.equal(git(work, ['push', '-q', 'origin', 'doomed'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(git(work, ['checkout', '-q', 'main']).status, 0);

  const broken = git(work, ['push', '-q', 'origin', ':doomed'], { BRAIN_KIT_LEAK_PATTERNS: join(work, 'nope.txt') });
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /leak patterns file not found/);

  const fine = git(work, ['push', '-q', 'origin', ':doomed'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(fine.status, 0, fine.stderr);
});

test('a stray field in the raw diff output refuses loudly instead of mis-pairing entries', () => {
  // Some git versions print the commit id as a field of its own despite
  // --no-commit-id. Every following field would then be read as the wrong
  // half of a record: a path scanned as a mode, a mode scanned as a path.
  // The hook is invoked the way git invokes it, rather than through `git
  // push`, because git puts its own exec directory at the front of a hook's
  // PATH and a stand-in named `git` would never be reached from there.
  const { root, work, bare, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const localSha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const ZERO = '0'.repeat(40);
  const dir = shimDir(root, 'stray-field-git', {
    git: [
      '#!/usr/bin/env bash',
      'case " $* " in',
      '  *" diff-tree "*)',
      '    printf "%s\\0" 1111111111111111111111111111111111111111',
      '    ;;',
      'esac',
      `exec ${JSON.stringify(realPath('git'))} "$@"`,
      '',
    ].join('\n'),
  });
  const r = spawnSync(HOOK, ['origin', bare], {
    cwd: work,
    input: `refs/heads/main ${localSha} refs/heads/main ${ZERO}\n`,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /produced a field that is not a tree entry/);
});

test('raw diff output that ends mid-entry refuses instead of scanning part of the commit', () => {
  // The other half of the same parse: a well-formed info field with no path
  // after it. Pairing is positional, so a work list built from it would be
  // one field out from there on; the entries already read are a PREFIX of
  // the commit, and a prefix scanned clean is not a commit scanned clean.
  const { root, work, bare, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const localSha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const ZERO = '0'.repeat(40);
  const dir = shimDir(root, 'half-entry-git', {
    git: [
      '#!/usr/bin/env bash',
      `${JSON.stringify(realPath('git'))} "$@"`,
      'status=$?',
      'case " $* " in',
      '  *" diff-tree "*)',
      '    printf ":100644 100644 %s %s M\\0" 0000000000000000000000000000000000000000 1111111111111111111111111111111111111111',
      '    ;;',
      'esac',
      'exit $status',
      '',
    ].join('\n'),
  });
  const r = spawnSync(HOOK, ['origin', bare], {
    cwd: work,
    input: `refs/heads/main ${localSha} refs/heads/main ${ZERO}\n`,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /ended in the middle of an entry/);
});

test('a commit whose scanner predates this hook refuses the push in one line', () => {
  // The hook comes out of the working tree, because that is where git runs
  // a hook from; the scanner comes out of the commit being pushed. They are
  // two halves of one record protocol and they can be different ages. An
  // older scanner reads every field one place out and refuses over hundreds
  // of paths that never existed, which is fail closed and says nothing
  // true. It is a compatibility check, not a security one: a COMMITTED
  // scanner that does understand the protocol is still the one that runs,
  // weakened or not.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  writeFileSync(join(work, 'src', 'commands', 'scan-blobs.mjs'), [
    '// A scanner of an older era: it reads pairs, not kinded records, and',
    '// would call this whole push clean.',
    'export function parseEntries() { return []; }',
    'export async function runScanBlobs() { return 0; }',
    '',
  ].join('\n'));
  writeFileSync(join(work, 'notes.md'), 'Meeting with Hunter2Corp tomorrow\n');
  assert.equal(git(work, ['add', 'src/commands/scan-blobs.mjs', 'notes.md']).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'an older scanner and a leak']).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /does not understand the work list this hook writes/);
});
