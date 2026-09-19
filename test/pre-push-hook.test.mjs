import { test } from 'node:test';
import { makeTempDir } from './helpers/tmp.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, cpSync, chmodSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const HOOK_SOURCE = join(KIT_ROOT, '.githooks', 'pre-push');
const INSTALLER = join(KIT_ROOT, '.githooks', 'install-gate');
// BOTH HALVES OF THE GATE LIVE OUTSIDE THE WORKING TREE (eighth round, (l)),
// installed under the git directory by `.githooks/install-gate` and reached
// through core.hooksPath. So a scratch repository does NOT carry the package
// in its history, and does not need to: nothing is read out of the pushed
// tip except the objects being scanned. The two earlier designs both needed
// a fixture of their own (a working tree holding the package, then a history
// carrying it) and each of those fixtures existed because the gate read its
// own code from somewhere the push could reach.
//
// `installGate` below runs the real installer against a scratch repository,
// pointed at this checkout as its source, so what the tests exercise is the
// installed gate and not a hand-assembled imitation of one.
const KIT_DIRS_TO_MIRROR = ['bin', 'src', 'lang', 'schema'];

function git(cwd, args, env = {}) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

// Builds a brain-kit checkout of its own (the installer copies FROM a
// checkout) and runs the installer in the scratch repository with that
// checkout's .githooks on hand. The scratch repository itself stays empty
// of kit files, which is the point: the gate no longer depends on what the
// repository being pushed happens to contain.
//
// `hookSource` lets one test install a DIFFERENT hook file (the shim tests
// need the hook itself to see a stand-in PATH), and every other caller gets
// the real one.
function installGate(work, root, { hookSource = HOOK_SOURCE } = {}) {
  const kit = join(root, 'kit');
  mkdirSync(join(kit, '.githooks'), { recursive: true });
  copyFileSync(hookSource, join(kit, '.githooks', 'pre-push'));
  copyFileSync(INSTALLER, join(kit, '.githooks', 'install-gate'));
  chmodSync(join(kit, '.githooks', 'install-gate'), 0o755);
  for (const dir of KIT_DIRS_TO_MIRROR) {
    cpSync(join(KIT_ROOT, dir), join(kit, dir), { recursive: true });
  }
  copyFileSync(join(KIT_ROOT, 'package.json'), join(kit, 'package.json'));
  // The installer resolves its source from `git rev-parse --show-toplevel`,
  // so the checkout it copies from has to be a repository. It is a plain
  // one with a single commit; nothing about it is pushed anywhere.
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', kit]).status, 0);
  assert.equal(git(kit, ['add', '-A']).status, 0);
  assert.equal(git(kit, ['commit', '-q', '-m', 'a brain-kit checkout']).status, 0);
  const installed = spawnSync(join(kit, '.githooks', 'install-gate'), [], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  const gateDir = join(work, '.git', 'brain-kit-gate');
  return { kit, gateDir, installedHook: join(gateDir, 'pre-push'), install: installed };
}

function setup({ hookSource = HOOK_SOURCE } = {}) {
  const root = makeTempDir('brain-kit-prepush-');
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  git(work, ['remote', 'add', 'origin', bare]);
  const { kit, gateDir, installedHook } = installGate(work, root, { hookSource });
  const patterns = join(root, 'patterns.txt');
  writeFileSync(patterns, 'hunter2corp\nsecret[- ]partner\n');
  return { root, work, bare, patterns, kit, gateDir, installedHook };
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
  const { work, patterns, installedHook } = setup();
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
  const r = spawnSync(installedHook, [bogusRemote, bogusRemote], {
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
  // nothing to scan. The root commit is made here and left unpushed so it
  // falls inside the range, and the TIP is a later commit whose own tree is
  // intact, so the refusal under test is the one being aimed at.
  const { work, patterns } = setup();
  commit(work, 'first.md', 'nothing secret here\n', 'a root commit');
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

// --- the identity channel's one exemption --------------------------------
//
// Every other channel has a remedy: edit the file, rename it, rewrite the
// message. An AUTHOR IDENTITY match has none for the person it is about,
// because any rewrite re-authors the commit as the same person. A
// maintainer whose own name is in their own pattern list, which is the most
// likely name for somebody protecting household data to put there, would
// have every push refused forever with two exits: delete their own name
// from the list, or --no-verify. So an EXACT match of the identity the push
// is being made under is exempt, and nothing wider is.

// The harness `git` helper forces `-c user.name=t`, which is the wrong
// thing here: these tests need the push and the commit to be made under the
// SAME configured identity, and that identity is the subject under test.
function gitAs(cwd, args, env = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

function setupSelfNamedMaintainer() {
  const fixture = setup();
  assert.equal(gitAs(fixture.work, ['config', 'user.name', 'Hunter2Corp Admin']).status, 0);
  assert.equal(gitAs(fixture.work, ['config', 'user.email', 'hunter2corp-admin@example.invalid']).status, 0);
  return fixture;
}

test('a maintainer whose own name is in their own pattern list can still push their own clean commit, and is told an exemption applied', () => {
  const { work, patterns } = setupSelfNamedMaintainer();
  writeFileSync(join(work, 'README.md'), 'hello world\n');
  assert.equal(gitAs(work, ['add', 'README.md']).status, 0);
  assert.equal(gitAs(work, ['commit', '-q', '-m', 'a clean message']).status, 0);

  const r = gitAs(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /the author of commit [0-9a-f]{7} \(AUTHOR IDENTITY\) matches a pattern, but it is exactly the identity this push is being made under/);
  // The whole reason it is exempt is that it matched, so it is still never
  // printed.
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('the exemption is EXACT: somebody else matching the same pattern is still refused, on the same push', () => {
  // The case the channel exists for. One commit authored by the pushing
  // identity (exempt) and one authored by a DIFFERENT person whose name
  // matches the same pattern (refused), in the same push, so the exemption
  // cannot be a blanket one hiding behind a passing test.
  const { work, patterns } = setupSelfNamedMaintainer();
  writeFileSync(join(work, 'README.md'), 'hello world\n');
  assert.equal(gitAs(work, ['add', 'README.md']).status, 0);
  assert.equal(gitAs(work, ['commit', '-q', '-m', 'a clean message']).status, 0);

  writeFileSync(join(work, 'notes.md'), 'nothing secret here\n');
  assert.equal(gitAs(work, ['add', 'notes.md']).status, 0);
  assert.equal(gitAs(work, ['commit', '-q', '-m', 'a clean message'], {
    GIT_AUTHOR_NAME: 'Hunter2Corp Bot', GIT_AUTHOR_EMAIL: 'hunter2corp-bot@example.invalid',
  }).status, 0);

  const r = gitAs(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the author of commit [0-9a-f]{7} \(AUTHOR IDENTITY\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('the exemption does not widen to a near miss: a different spelling of the same identity is still refused', () => {
  // Exact means exact. A case difference, a changed address, a name that
  // merely CONTAINS the configured one: none of these is a thing the
  // pushing person cannot rewrite, so none of them is exempt.
  const { work, patterns } = setupSelfNamedMaintainer();
  writeFileSync(join(work, 'README.md'), 'hello world\n');
  assert.equal(gitAs(work, ['add', 'README.md']).status, 0);
  assert.equal(gitAs(work, ['commit', '-q', '-m', 'a clean message'], {
    GIT_AUTHOR_NAME: 'hunter2corp admin', GIT_AUTHOR_EMAIL: 'hunter2corp-admin@example.invalid',
  }).status, 0);

  const r = gitAs(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the author of commit [0-9a-f]{7} \(AUTHOR IDENTITY\)/);
});

test('the exemption covers the COMMITTER channel on the same terms', () => {
  const { work, patterns } = setupSelfNamedMaintainer();
  writeFileSync(join(work, 'README.md'), 'hello world\n');
  assert.equal(gitAs(work, ['add', 'README.md']).status, 0);
  // Authored by a clean third party, committed by the pushing identity:
  // the author is scanned and passes, the committer matches and is exempt.
  assert.equal(gitAs(work, ['commit', '-q', '-m', 'a clean message'], {
    GIT_AUTHOR_NAME: 'A Human', GIT_AUTHOR_EMAIL: 'human@example.invalid',
  }).status, 0);

  const r = gitAs(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /the committer of commit [0-9a-f]{7} \(COMMITTER IDENTITY\) matches a pattern, but it is exactly the identity this push is being made under/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('an exempt identity says nothing at all when it matches no pattern, so an ordinary push stays quiet', () => {
  // The exemption is announced only when it FIRES. Announcing it on every
  // commit of every push would put a line per commit into the output of a
  // hundred-commit push and teach whoever reads it to stop reading.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /exempt/);
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

// --- the tag CHAIN: a tag object can name another tag object -------------
//
// `git tag -a <new> <existing annotated tag>` builds one of these every
// time somebody re-tags, and `git push --tags` sends the whole chain, so
// this is ordinary traffic. Following only the first level is a ONE LINE
// edit (`sha = tag.target` becoming `sha = null`) that puts the inner tag's
// message on the remote in plaintext, which is why all three properties
// below have a test of their own.

test('a tag object wrapping another tag object is followed past the first level, so the inner message is scanned', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  // The OUTER message is clean, so nothing at the first level of the chain
  // refuses: only following it to the inner tag finds anything.
  assert.equal(git(work, ['tag', '-a', 'inner', '-m', 'contract with Hunter2Corp']).status, 0);
  assert.equal(git(work, ['tag', '-a', 'outer', '-m', 'a perfectly ordinary release', 'inner']).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'outer'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the message of tag object [0-9a-f]{7} \(TAG MESSAGE\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('every tag message on the way down a chain is scanned, not only the innermost one', () => {
  // The other direction: the pattern is in the OUTER message and the inner
  // one is clean. A chain follower that scanned only the object the chain
  // finally names would miss this, and a chain follower that scanned only
  // the first level would miss the test above; both are needed to pin
  // "every level".
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(git(work, ['tag', '-a', 'inner2', '-m', 'a perfectly ordinary release']).status, 0);
  assert.equal(git(work, ['tag', '-a', 'outer2', '-m', 'contract with Hunter2Corp', 'inner2']).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'outer2'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the message of tag object [0-9a-f]{7} \(TAG MESSAGE\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('a chain the gate follows to its end reaches the commit, so a leak in the tagged COMMIT is still found through it', () => {
  // The chain is followed in order to arrive somewhere, not only to read
  // the tags on the way: the object it finally names is a commit, and that
  // commit's own content is what the rest of the push machinery scans.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');
  assert.equal(git(work, ['tag', '-a', 'inner3', '-m', 'a perfectly ordinary release']).status, 0);
  assert.equal(git(work, ['tag', '-a', 'outer3', '-m', 'also ordinary', 'inner3']).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'outer3'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
});

test('a chain longer than the depth bound REFUSES rather than stopping quietly partway down it', () => {
  // The bound exists so a malformed chain cannot spin forever. What it must
  // not do is double as a silent pass: stopping at the bound means there is
  // more chain, unread, and this module's own rule is that something which
  // should have been readable and was not refuses. Twelve tag objects, two
  // past the bound of ten, with the leak in the innermost one where a quiet
  // stop would never reach it.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  assert.equal(git(work, ['tag', '-a', 'deep0', '-m', 'contract with Hunter2Corp']).status, 0);
  let previous = 'deep0';
  for (let level = 1; level <= 11; level += 1) {
    assert.equal(git(work, ['tag', '-a', `deep${level}`, '-m', 'a perfectly ordinary release', previous]).status, 0);
    previous = `deep${level}`;
  }

  const r = git(work, ['push', '-q', 'origin', previous], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /chain of more than 10 tag objects/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('a chain exactly at the depth bound is followed to its end and still passes when it is clean', () => {
  // The other side of the bound, so it cannot be tightened into refusing
  // ordinary traffic without a test noticing: ten levels, all clean, must
  // push.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  assert.equal(git(work, ['tag', '-a', 'ok0', '-m', 'a perfectly ordinary release']).status, 0);
  let previous = 'ok0';
  for (let level = 1; level <= 9; level += 1) {
    assert.equal(git(work, ['tag', '-a', `ok${level}`, '-m', 'a perfectly ordinary release', previous]).status, 0);
    previous = `ok${level}`;
  }

  const r = git(work, ['push', '-q', 'origin', previous], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
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

// --- the whole HEADER BLOCK ----------------------------------------------
//
// The six channels before this one were each found by naming a FIELD, and
// the naming was wrong twice: the round that added the reference name
// discovered, inside itself, that an annotated tag records the name it was
// created under inside the object, so renaming on the way out (the remedy
// that round recommended) passed the reference-name channel and published
// the bad name anyway. These pin the block scan that replaces the list.

test('a tag created under a matching NAME is refused even when it is pushed to a clean destination name', () => {
  // The exact shape that got through before this channel existed: the
  // reference-name channel sees only "v9", which is clean, and the tag
  // object carries "Hunter2Corp-release" in its own `tag` header, which
  // lands on the remote where cat-file prints it.
  const { work, patterns, bare } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(git(work, ['tag', '-a', 'Hunter2Corp-release', '-m', 'an ordinary release']).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'refs/tags/Hunter2Corp-release:refs/tags/v9'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the header block of tag object [0-9a-f]{7} \(OBJECT HEADER\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
  // And nothing reached the remote under either name.
  const listed = spawnSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
  assert.equal(listed.status, 0);
  assert.doesNotMatch(listed.stdout, /v9|Hunter2Corp/i);
});

test('an unenumerated commit header carrying a pattern is refused, which is the point of scanning the block rather than a list of fields', () => {
  // `encoding` is a real header git itself writes, and it was not on the
  // list of fields this gate used to read. Nothing about the fix depends on
  // it being THIS header: it stands in for every header nobody enumerated.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  const parent = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const tree = git(work, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const object = [
    `tree ${tree}`,
    `parent ${parent}`,
    'author t <t@example.com> 1700000000 +0000',
    'committer t <t@example.com> 1700000000 +0000',
    'encoding Hunter2Corp-1',
    '',
    'a perfectly ordinary message',
    '',
  ].join('\n');
  const written = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], { cwd: work, input: object, encoding: 'utf8' });
  assert.equal(written.status, 0, written.stderr);
  const sha = written.stdout.trim();

  const r = git(work, ['push', '-q', 'origin', `${sha}:refs/heads/side`], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the header block of commit [0-9a-f]{7} \(OBJECT HEADER\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('the block scan does not deadlock the maintainer whose own name is in their own pattern list', () => {
  // The exemption round two built lives on the AUTHOR and COMMITTER
  // channels, and an identity line sits INSIDE the header block, so a naive
  // whole-block scan would see the pushing identity in every commit and
  // refuse every push forever with no remedy but --no-verify. The block
  // scans the RESIDUE: the exact text those channels already scanned is
  // taken out of it first, so the exemption still decides that case and
  // still says so.
  const { work, patterns } = setupSelfNamedMaintainer();
  writeFileSync(join(work, 'README.md'), 'hello world\n');
  assert.equal(gitAs(work, ['add', 'README.md']).status, 0);
  assert.equal(gitAs(work, ['commit', '-q', '-m', 'a clean message']).status, 0);
  const r = gitAs(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /the author of commit [0-9a-f]{7} \(AUTHOR IDENTITY\) matches a pattern, but it is exactly the identity this push is being made under/);
  assert.doesNotMatch(r.stderr, /OBJECT HEADER/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('an identity that is NOT the pushing one is reported once, by the channel that names the remedy, and not a second time by the block', () => {
  // Every byte of the object is scanned exactly once, by the most specific
  // channel that covers it. Two findings for one leak would train whoever
  // reads the output to skim it, and the vaguer of the two says less about
  // what to do.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'a clean message', {
    GIT_AUTHOR_NAME: 'Hunter2Corp Admin', GIT_AUTHOR_EMAIL: 'admin@example.invalid',
  });
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the author of commit [0-9a-f]{7} \(AUTHOR IDENTITY\)/);
  assert.doesNotMatch(r.stderr, /OBJECT HEADER/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('a leak in the MESSAGE is reported by the message channel only, because the block ends where the message begins', () => {
  // The other half of scanning each byte once. The block runs to the first
  // empty line and the message starts after it, so the two are disjoint by
  // construction; a block that ran to the end of the object would report
  // every message leak twice, under a channel that says less about what to
  // do than the one that already covers it.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'cut for Hunter2Corp');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the message of commit [0-9a-f]{7} \(COMMIT MESSAGE\)/);
  assert.doesNotMatch(r.stderr, /OBJECT HEADER/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('the identity is removed only from the header line that declares it, so the same text elsewhere in the block is still scanned', () => {
  // The narrow edge of the removal, and the only construction that tells
  // an anchored removal from an unanchored one. The pushing identity is
  // exempt on the AUTHOR channel because no rewrite can change who
  // authored a commit. A header that merely CONTAINS the same text is not
  // that: it is ordinary content, it is rewritable, and it is owed no
  // exemption. An unanchored removal would take it out of the block on the
  // strength of a match elsewhere and the push would pass in silence.
  const { work, patterns } = setupSelfNamedMaintainer();
  writeFileSync(join(work, 'README.md'), 'hello world\n');
  assert.equal(gitAs(work, ['add', 'README.md']).status, 0);
  assert.equal(gitAs(work, ['commit', '-q', '-m', 'a clean message']).status, 0);
  assert.equal(gitAs(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  const identity = 'Hunter2Corp Admin <hunter2corp-admin@example.invalid>';
  const parent = gitAs(work, ['rev-parse', 'HEAD']).stdout.trim();
  const tree = gitAs(work, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const object = [
    `tree ${tree}`,
    `parent ${parent}`,
    `author ${identity} 1700000000 +0000`,
    `committer ${identity} 1700000000 +0000`,
    `encoding ${identity}`,
    '',
    'a perfectly ordinary message',
    '',
  ].join('\n');
  const written = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], { cwd: work, input: object, encoding: 'utf8' });
  assert.equal(written.status, 0, written.stderr);

  const r = gitAs(work, ['push', '-q', 'origin', `${written.stdout.trim()}:refs/heads/edge`], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the header block of commit [0-9a-f]{7} \(OBJECT HEADER\)/);
  // And the author line itself is still exempt, so this is the edge and
  // not the exemption quietly ceasing to work.
  assert.match(r.stderr, /\(AUTHOR IDENTITY\) matches a pattern, but it is exactly the identity this push is being made under/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('a mergetag, whose continuation lines embed a whole tag object, is inside the block and is scanned', () => {
  // The case built to break the "headers end at the first empty line"
  // contract. A mergetag embeds an entire tag object, message and all, and
  // a tag object has a blank line before its message; if that blank line
  // reached the block splitter as a blank line, the header block would be
  // cut short and everything after it read as the commit message instead.
  // It does not, because git prefixes every continuation line with a
  // space, so the "blank" line inside a mergetag is a line with one space
  // on it. This is that contract measured rather than assumed, with the
  // pattern past the point where a wrong split would have stopped.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  const parent = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const tree = git(work, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const object = [
    `tree ${tree}`,
    `parent ${parent}`,
    'author t <t@example.com> 1700000000 +0000',
    'committer t <t@example.com> 1700000000 +0000',
    'mergetag object 0000000000000000000000000000000000000000',
    ' type commit',
    ' tag Hunter2Corp-cut',
    ' tagger t <t@example.com> 1700000000 +0000',
    ' ',
    ' an ordinary release',
    '',
    'an ordinary merge',
    '',
  ].join('\n');
  const written = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], { cwd: work, input: object, encoding: 'utf8' });
  assert.equal(written.status, 0, written.stderr);

  const r = git(work, ['push', '-q', 'origin', `${written.stdout.trim()}:refs/heads/merged`], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the header block of commit [0-9a-f]{7} \(OBJECT HEADER\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('a tag object with no header block at all REFUSES rather than passing with nothing to scan', () => {
  // Every tag object git writes opens with `object`, `type` and `tag`, so
  // an empty block is not a tag with empty headers, it is a tag this module
  // failed to read, and reading nothing is the one thing this gate must
  // never call clean. Built with --literally because git will not write one
  // of these on its own.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  const written = spawnSync('git', ['hash-object', '-t', 'tag', '-w', '--stdin', '--literally'], {
    cwd: work, input: '\n\na message with no headers before it\n', encoding: 'utf8',
  });
  assert.equal(written.status, 0, written.stderr);
  const sha = written.stdout.trim();

  const r = git(work, ['push', '-q', 'origin', `${sha}:refs/tags/broken`], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /has no header block at all/);
});

test('an ordinary annotated tag and an ordinary commit still push, so the block scan is a scanner and not a ban on headers', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['tag', '-a', 'v1', '-m', 'an ordinary release']).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'main', 'v1'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /OBJECT HEADER/);
});

// --- what the gate ASKS, and whether git answers about the right object ---

test('a replaced object does not let the gate scan one commit while the remote receives another', () => {
  // `git replace` installs a ref under refs/replace/ and every ordinary git
  // read then reports the replacement wherever the original was asked
  // about; `git push` sends the object that is really there. So the gate
  // scanned a clean stand-in and the remote received the real thing, with
  // exit 0 and no output, using one ordinary command and no edit to the
  // gate at all. Both halves pass --no-replace-objects now, and this is the
  // measurement that says so.
  const { work, patterns, bare } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');
  const dirty = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(git(work, ['reset', '-q', '--hard', 'HEAD~1']).status, 0);
  commit(work, 'notes.md', 'nothing of interest here\n', 'a clean message');
  const stand = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(git(work, ['reset', '-q', '--hard', dirty]).status, 0);
  assert.equal(git(work, ['replace', dirty, stand]).status, 0);
  // The replacement really is in force for an ordinary read, or this test
  // would pass for the wrong reason.
  assert.match(git(work, ['show', `${dirty}:notes.md`]).stdout, /nothing of interest/);

  const r = git(work, ['push', '-q', 'origin', `${dirty}:refs/heads/side`], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
  const listed = spawnSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
  assert.doesNotMatch(listed.stdout, /side/);
});

test('a replaced object whose stand-in changes NOTHING is still scanned, which only the hook half can save', () => {
  // The scanner's own --no-replace-objects cannot save this one, because
  // the scanner is never asked. The HOOK is what runs diff-tree to decide
  // which files a commit changed, and under a replacement whose stand-in
  // changes nothing at all, diff-tree lists nothing, the work list is
  // empty, and an empty work list is a clean push. So the hook's own
  // export is load-bearing on its own, and this is the shape that says so.
  const { work, patterns, bare } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  const base = git(work, ['rev-parse', 'HEAD']).stdout.trim();

  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');
  const dirty = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(git(work, ['reset', '-q', '--hard', base]).status, 0);
  // An EMPTY commit on the same parent: same tree as the base, so
  // diff-tree against its parent produces no entries at all.
  assert.equal(git(work, ['commit', '-q', '--allow-empty', '-m', 'a clean message']).status, 0);
  const stand = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(git(work, ['replace', dirty, stand]).status, 0);
  assert.equal(git(work, ['diff-tree', '-r', '--name-only', '--no-commit-id', dirty]).stdout.trim(), '');

  const r = git(work, ['push', '-q', 'origin', `${dirty}:refs/heads/quiet`], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
  const listed = spawnSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
  assert.doesNotMatch(listed.stdout, /quiet/);
});

test('a replaced TAG object does not hide the name the tag was really created under', () => {
  // The same trick aimed at the channel this round added: replace the
  // dirty tag object with a clean one so cat-file reports clean headers,
  // and push the dirty one.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(git(work, ['tag', '-a', 'Hunter2Corp-cut', '-m', 'an ordinary release']).status, 0);
  assert.equal(git(work, ['tag', '-a', 'ordinary-cut', '-m', 'an ordinary release']).status, 0);
  const dirty = git(work, ['rev-parse', 'refs/tags/Hunter2Corp-cut']).stdout.trim();
  const stand = git(work, ['rev-parse', 'refs/tags/ordinary-cut']).stdout.trim();
  assert.equal(git(work, ['replace', dirty, stand]).status, 0);

  const r = git(work, ['push', '-q', 'origin', `${dirty}:refs/tags/v10`], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the header block of tag object [0-9a-f]{7} \(OBJECT HEADER\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

// --- the toolchain the gate runs -----------------------------------------

test('an uncommitted edit to the scanner does not weaken the gate', () => {
  // The engine the gate runs is the installed SNAPSHOT, outside the working
  // tree. Before it was, one unstaged edit to any module the scanner loads
  // was enough to walk a leak straight through with exit 0, which is a
  // thing an implementer mid-task does by accident, not an attack. The
  // toothless copy goes into the working tree where a reader would expect
  // the scanner to be found, and is never reached.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  mkdirSync(join(work, 'src', 'commands'), { recursive: true });
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

test('an uncommitted edit to the hook file in the working tree does not weaken the gate either', () => {
  // The half of the gate that decides WHAT to scan (the commit range, the
  // diff filter, merge handling, the exclusions, whether the engine is
  // called at all) used to run from the working tree, because that is where
  // git runs a hook from. Emptying .githooks/pre-push there, with nothing
  // committed, pushed a matching file to the remote with exit 0 and no
  // output. Installed outside the tree, the file in the tree is inert: it
  // is a source to install FROM, not a thing git runs.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  mkdirSync(join(work, '.githooks'), { recursive: true });
  writeFileSync(join(work, '.githooks', 'pre-push'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(work, '.githooks', 'pre-push'), 0o755);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
});

test('the pushed tip cannot choose the code that judges it', () => {
  // THE HOLE THIS ROUND EXISTS TO CLOSE. When the gate extracted its
  // toolchain from the commit being pushed, a branch carrying its own
  // bin/brain-kit.mjs was accepted with the hook intact, a correct pattern
  // list and no --no-verify: the push chose its own judge, and the code it
  // carried ran with the hook's environment, which names the private
  // pattern list. The tip here carries exactly that: an entry point that
  // writes a witness file, reads BRAIN_KIT_LEAK_PATTERNS and exits zero,
  // next to a file matching an active pattern.
  const { root, work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  const witness = join(root, 'witness.txt');
  mkdirSync(join(work, 'bin'), { recursive: true });
  mkdirSync(join(work, 'src', 'commands'), { recursive: true });
  writeFileSync(join(work, 'bin', 'brain-kit.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(witness)}, String(process.env.BRAIN_KIT_LEAK_PATTERNS ?? 'no patterns variable'));`,
    'process.exit(0);',
    '',
  ].join('\n'));
  writeFileSync(join(work, 'src', 'commands', 'scan-blobs.mjs'), [
    '// Carries the record protocol token, so a version check that greps for',
    '// it would be satisfied by a file it never executes.',
    "export const RECORD_PROTOCOL = 'brain-kit-scan-blobs-records-v2';",
    'export async function runScanBlobs() { return 0; }',
    '',
  ].join('\n'));
  writeFileSync(join(work, 'notes.md'), 'Meeting with Hunter2Corp tomorrow\n');
  assert.equal(git(work, ['add', 'bin/brain-kit.mjs', 'src/commands/scan-blobs.mjs', 'notes.md']).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'a judge of my own and a leak']).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.equal(existsSync(witness), false, 'the pushed tip\'s own code was executed by the gate');
  // And the leak really did not reach the remote.
  const onRemote = spawnSync('git', ['--git-dir', join(root, 'origin.git'), 'cat-file', '-e', 'refs/heads/main:notes.md'], { encoding: 'utf8' });
  assert.notEqual(onRemote.status, 0, 'the leaking blob reached the remote');
});

test('an orphan branch carrying no package at all is SCANNED, not refused', () => {
  // The extraction design had to refuse this outright (no package in the
  // tip, no scanner to run), with --no-verify as the only way out. That is
  // not a safe state: a gate whose ordinary escape is the bypass flag
  // teaches the bypass flag. With the engine installed outside the tree
  // there is no tip that cannot be scanned, so an orphan branch is an
  // ordinary push and its content is examined like any other.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  assert.equal(git(work, ['checkout', '-q', '--orphan', 'unrelated']).status, 0);
  assert.equal(git(work, ['rm', '-r', '-q', '--cached', '.']).status, 0);
  writeFileSync(join(work, 'only.md'), 'nothing secret here\n');
  assert.equal(git(work, ['add', 'only.md']).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'an unrelated root']).status, 0);

  const clean = git(work, ['push', '-q', 'origin', 'unrelated'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(clean.status, 0, clean.stderr);

  // And the scanning really happened: the same orphan branch with a leak on
  // it is refused, which an unconditional accept would not do either.
  writeFileSync(join(work, 'only.md'), 'Meeting with Hunter2Corp tomorrow\n');
  assert.equal(git(work, ['add', 'only.md']).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'an orphan leak']).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'unrelated'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in only\.md \(CONTENT/);
});

test('an install with a hook but no engine snapshot refuses and names the command that fixes it', () => {
  // The half-done install: the hook is in place and core.hooksPath points
  // at it, and the engine beside it is gone (a partly deleted gate, a moved
  // git directory, a copied hook). Failing silently here would be a push
  // judged by nothing; failing without naming the fix is how a gate teaches
  // people to skip it.
  const { work, patterns, gateDir } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  rmSync(join(gateDir, 'engine'), { recursive: true, force: true });

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /engine snapshot is incomplete/);
  assert.match(r.stderr, /install-gate/);
});

test('an install whose snapshot stamp is missing refuses, so a gate that cannot say what it is never runs', () => {
  // The stamp is what the gate prints on every push so a stale snapshot is
  // visible rather than silent. The installer writes it LAST, so its
  // absence means the install did not finish.
  const { work, patterns, gateDir } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  rmSync(join(gateDir, 'SNAPSHOT'));

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /engine snapshot is incomplete/);
  assert.match(r.stderr, /install-gate/);
});

test('the gate refuses to run from inside the working tree, however core.hooksPath is pointed at it', () => {
  // The old activation line was `git config core.hooksPath .githooks`,
  // which put the deciding half of the gate back where a checkout replaces
  // it and an uncommitted edit empties it. It does not quietly work any
  // more: it stops, and says which command installs the gate properly.
  const { work, patterns, kit } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  mkdirSync(join(work, '.githooks'), { recursive: true });
  copyFileSync(join(kit, '.githooks', 'pre-push'), join(work, '.githooks', 'pre-push'));
  chmodSync(join(work, '.githooks', 'pre-push'), 0o755);
  assert.equal(git(work, ['config', 'core.hooksPath', '.githooks']).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /not from its installed copy/);
  assert.match(r.stderr, /install-gate/);
});

// --- when the snapshot announcement prints, and when it stays quiet -----
//
// It used to print on EVERY push. The honesty behind that is right (the
// snapshot goes stale by design and nothing else says so) and the delivery
// was wrong: two unconditional lines on stderr, the same stream the
// findings use, on every successful push, are two lines people stop
// reading within a week, and they were competing with the messages that
// matter. On a refusal both print, always. On a clean push they print only
// when the snapshot is actually stale, and stale is decided mechanically.

test('every refusal prints which engine snapshot it ran and how to refresh it', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  const refused = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /gate engine snapshot: installed \d\d\/\d\d\/\d{4} \d\d:\d\d from commit /);
  assert.match(refused.stderr, /refresh it with: .*install-gate/);
});

test('a refusal that comes from the hook half, not from the scanner, prints them too', () => {
  // The two lines are printed from an EXIT trap reading the shell's own
  // status, precisely so that a refusal leaving from somewhere nobody
  // enumerated still carries them. This one leaves from the work-list
  // branch: a commit whose files cannot be listed.
  const { root, work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  // A SECOND commit, so the commit loop reaches diff-tree at all: a root
  // commit has no parent and is listed with ls-tree instead.
  commit(work, 'more.md', 'nothing secret here\n', 'more');
  const fake = shimDir(root, 'difftree', {
    git: `#!/bin/sh\nif [ "$1" = "diff-tree" ]; then exit 3; fi\nexec ${realPath('git')} "$@"\n`,
  });
  // Invoked directly, because git puts its own exec directory ahead of a
  // shim on a hook's PATH (see shimDir's own note).
  const r = spawnSync(join(work, '.git', 'brain-kit-gate', 'pre-push'), ['origin', join(root, 'origin.git')], {
    cwd: work,
    encoding: 'utf8',
    input: `refs/heads/main ${git(work, ['rev-parse', 'HEAD']).stdout.trim()} refs/heads/main ${'0'.repeat(40)}\n`,
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns, PATH: `${fake}:${process.env.PATH}` },
  });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /gate engine snapshot: installed /);
  assert.match(r.stderr, /refresh it with: /);
});

test('a clean push against a fresh snapshot says nothing about the snapshot at all', () => {
  // The scratch repository is not a brain-kit checkout and the kit it was
  // installed from was committed clean, so nothing about this snapshot is
  // stale and there is nothing to announce.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const clean = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stderr, /gate engine snapshot/);
  assert.doesNotMatch(clean.stderr, /refresh it with/);
});

test('a snapshot taken from a DIRTY source tree announces itself on a clean push', () => {
  // The first of the three staleness signals, and the one that needs no
  // knowledge of what the gate ought to be: the stamp itself records that
  // the tree it was copied from did not match the commit it names, so the
  // snapshot may be anything, including a half-edited gate.
  const root = makeTempDir('brain-kit-prepush-');
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  git(work, ['remote', 'add', 'origin', bare]);
  const { kit } = installGate(work, root);
  // Dirty the kit checkout and re-install, so the stamp records it.
  writeFileSync(join(kit, 'uncommitted.txt'), 'anything\n');
  assert.equal(spawnSync(join(kit, '.githooks', 'install-gate'), [], { cwd: work, encoding: 'utf8' }).status, 0);
  const patterns = join(root, 'patterns.txt');
  writeFileSync(patterns, 'hunter2corp\n');

  commit(work, 'README.md', 'hello world\n', 'init');
  const clean = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stderr, /gate engine snapshot: installed .*working tree dirty/);
  assert.match(clean.stderr, /refresh it with: /);
});

// The other two staleness signals apply only where this hook can tell what
// the gate OUGHT to be: a repository that is itself the brain-kit checkout
// the gate is maintained in, which is the real deployment and the one the
// maintainer pushes from every day. So the fixture is that repository:
// the kit, committed, with the gate installed out of its own working tree.
function setupSelfHosted() {
  const root = makeTempDir('brain-kit-selfhosted-');
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  mkdirSync(join(work, '.githooks'), { recursive: true });
  copyFileSync(HOOK_SOURCE, join(work, '.githooks', 'pre-push'));
  copyFileSync(INSTALLER, join(work, '.githooks', 'install-gate'));
  chmodSync(join(work, '.githooks', 'install-gate'), 0o755);
  for (const dir of KIT_DIRS_TO_MIRROR) cpSync(join(KIT_ROOT, dir), join(work, dir), { recursive: true });
  copyFileSync(join(KIT_ROOT, 'package.json'), join(work, 'package.json'));
  git(work, ['remote', 'add', 'origin', bare]);
  assert.equal(git(work, ['add', '-A']).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'a brain-kit checkout']).status, 0);
  const installed = spawnSync(join(work, '.githooks', 'install-gate'), [], { cwd: work, encoding: 'utf8' });
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  const patterns = join(root, 'patterns.txt');
  writeFileSync(patterns, 'hunter2corp\n');
  return { root, work, bare, patterns };
}

test('in the checkout the gate is maintained in, a clean push right after installing says nothing', () => {
  // The control for the two tests below: HEAD is the commit the stamp
  // names and .githooks/pre-push is byte for byte the installed hook, so
  // nothing is stale and nothing is announced.
  const { work, patterns } = setupSelfHosted();
  const clean = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stderr, /gate engine snapshot/);
});

test('a commit made since the install makes the snapshot stale and it says so', () => {
  const { work, patterns } = setupSelfHosted();
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  commit(work, 'ordinary.md', 'nothing secret here\n', 'a later commit');
  const clean = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stderr, /gate engine snapshot: installed /);
  assert.match(clean.stderr, /refresh it with: /);
});

test('an UNCOMMITTED edit to the gate source makes the snapshot stale, which no commit comparison could see', () => {
  // The ordinary way a gate change is made and tested. It is a byte
  // comparison against the installed copy, and the file is COMPARED,
  // never run: the leak below is still refused, by the installed hook,
  // while the edited one in the tree does nothing at all.
  const { work, patterns } = setupSelfHosted();
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  writeFileSync(join(work, '.githooks', 'pre-push'), '#!/usr/bin/env bash\nexit 0\n');
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a leak');
  const refused = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(refused.status, 0, refused.stderr);
  assert.match(refused.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.match(refused.stderr, /gate engine snapshot: installed /);
});

test('the installed gate records a REPOSITORY-RELATIVE refresh command, never an absolute path', () => {
  // The hook prints this string on stderr, the same stream the findings
  // use, so an absolute path here is a home directory travelling into
  // every log and pasted transcript a push appears in. On a project whose
  // subject is not disclosing that sort of thing, the gate must not be
  // what discloses it.
  const { work, patterns } = setupSelfHosted();
  const recorded = readFileSync(join(work, '.git', 'brain-kit-gate', 'INSTALLER'), 'utf8').trim();
  assert.equal(recorded, '.githooks/install-gate');
  assert.doesNotMatch(recorded, /^\//);

  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a leak');
  const refused = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refresh it with: \.githooks\/install-gate/);
  assert.doesNotMatch(refused.stderr, /refresh it with: \//);
});

test('re-running the installer refreshes the snapshot, and only re-running it does', () => {
  // The documented way to pick up a change to the gate, and the ONLY way:
  // nothing refreshes automatically, because an automatic refresh would
  // read the gate back out of the working tree on every push and hand back
  // the hole this whole design exists to close.
  const { work, patterns, kit, gateDir } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');

  const before = readFileSync(join(gateDir, 'engine', 'src', 'commands', 'scan-blobs.mjs'), 'utf8');
  assert.ok(!before.includes('A MARKER FROM THE CHECKOUT'));

  // Change the engine in the CHECKOUT the gate was installed from. The
  // installed snapshot must not notice until the installer is re-run.
  const kitScanner = join(kit, 'src', 'commands', 'scan-blobs.mjs');
  writeFileSync(kitScanner, `// A MARKER FROM THE CHECKOUT\n${readFileSync(kitScanner, 'utf8')}`);
  const stillOld = readFileSync(join(gateDir, 'engine', 'src', 'commands', 'scan-blobs.mjs'), 'utf8');
  assert.ok(!stillOld.includes('A MARKER FROM THE CHECKOUT'), 'the snapshot changed without the installer being re-run');

  const again = spawnSync(join(kit, '.githooks', 'install-gate'), [], { cwd: work, encoding: 'utf8' });
  assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
  const after = readFileSync(join(gateDir, 'engine', 'src', 'commands', 'scan-blobs.mjs'), 'utf8');
  assert.ok(after.includes('A MARKER FROM THE CHECKOUT'), 're-running the installer did not refresh the snapshot');

  // And the refreshed gate still works.
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
});

// --- the machine the hook runs on ----------------------------------------

test('no node on PATH refuses the push', () => {
  const { root, work, patterns, installedHook } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  // A PATH with nothing on it but bash, which /usr/bin/env needs to start
  // the hook at all. The node check is the hook's first statement, so it is
  // reached before anything needs git.
  const dir = join(root, 'path-without-node');
  mkdirSync(dir, { recursive: true });
  symlinkSync(realPath('bash'), join(dir, 'bash'));
  const r = spawnSync(installedHook, ['origin', 'origin'], {
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

function tipRecord(sha) {
  return `tip\u0000${sha}\u0000`;
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

test('scan-blobs refuses a replaced object on its own, without the hook having exported anything', () => {
  // The two halves each carry this guarantee. The hook exports
  // GIT_NO_REPLACE_OBJECTS, which the scanner would inherit as a child, so
  // a test that goes through the hook cannot tell whether the scanner's
  // own --no-replace-objects does anything. This one invokes the scanner
  // directly, with nothing exported, which is also the real case of an
  // engine snapshot newer or older than the hook beside it.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'dirty');
  const dirty = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(git(work, ['reset', '-q', '--hard', 'HEAD~1']).status, 0);
  commit(work, 'notes.md', 'nothing of interest here\n', 'a clean stand-in');
  const stand = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(git(work, ['replace', dirty, stand]).status, 0);
  assert.match(git(work, ['show', `${dirty}:notes.md`]).stdout, /nothing of interest/);

  // Nothing exported: this process never set GIT_NO_REPLACE_OBJECTS, so
  // the only thing standing between the scanner and the stand-in is the
  // flag on its own git calls.
  assert.equal(process.env.GIT_NO_REPLACE_OBJECTS, undefined);
  const r = scanBlobs(work, blobRecord(dirty, 'notes.md'), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
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
  // answer. It is arrived at deliberately: `scan-blobs` still runs, because
  // its fail-closed check on the patterns file is not scoped to "only when
  // something was found to scan". The deletion is also the skipping side of
  // this gate's own rule (there was never anything here to read, as opposed
  // to something it could not read), so it is announced rather than passed
  // in silence: a silent skip reads exactly like a scan that found nothing.
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
  assert.match(fine.stderr, /skipping the objects of reference #1 of this push/);
  // The skip is about OBJECTS only. The destination name of the same
  // deletion is a channel of its own and is scanned; the message says so,
  // because a reader who took "nothing here to read" to cover the name
  // would be reading the old, weaker gate.
  assert.match(fine.stderr, /destination name is still scanned/);
  // And the message names the reference by NUMBER, never by text. This
  // assertion is the redaction contract for this channel: the hook half
  // cannot scan, so it must not print a name it has not had scanned.
  assert.doesNotMatch(fine.stderr, /doomed/);
});

test('a stray field in the raw diff output refuses loudly instead of mis-pairing entries', () => {
  // Some git versions print the commit id as a field of its own despite
  // --no-commit-id. Every following field would then be read as the wrong
  // half of a record: a path scanned as a mode, a mode scanned as a path.
  // The hook is invoked the way git invokes it, rather than through `git
  // push`, because git puts its own exec directory at the front of a hook's
  // PATH and a stand-in named `git` would never be reached from there.
  const { root, work, bare, patterns, installedHook } = setup();
  // TWO commits, so the tip has a parent and is therefore listed with `git
  // diff-tree`: a root commit is listed with `git ls-tree` instead, and the
  // parse under test here is diff-tree's.
  commit(work, 'first.md', 'nothing secret here\n', 'a root commit');
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
  const r = spawnSync(installedHook, ['origin', bare], {
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
  const { root, work, bare, patterns, installedHook } = setup();
  // TWO commits, so the tip has a parent and is therefore listed with `git
  // diff-tree`: a root commit is listed with `git ls-tree` instead, and the
  // parse under test here is diff-tree's.
  commit(work, 'first.md', 'nothing secret here\n', 'a root commit');
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
  const r = spawnSync(installedHook, ['origin', bare], {
    cwd: work,
    input: `refs/heads/main ${localSha} refs/heads/main ${ZERO}\n`,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /ended in the middle of an entry/);
});


// --- the metadata batch has a lower bound, and the loop always advances ---
//
// Commit metadata is read in batches of METADATA_BATCH with `at += batch`.
// At a batch of zero that never advances: the loop spins forever, asking
// git about an empty slice each time round, and the push neither passes nor
// fails. MAX_TAG_DEPTH has had a bound since it was written and this did
// not. A gate that HANGS is worse than one that refuses and worse than one
// that accepts, because both of those say what happened.

test('metadataBatchSize refuses to return a batch that would stall the loop', async () => {
  const { metadataBatchSize, METADATA_BATCH } = await import('../src/commands/scan-blobs.mjs');
  // Zero is the one that hangs; the rest are the neighbourhood it lives in,
  // each of which would either hang or advance backwards.
  for (const stalling of [0, -1, -256, 0.5, 1.5, NaN, Infinity, -Infinity, undefined, null, '256', '0']) {
    assert.equal(metadataBatchSize(stalling), 1, `metadataBatchSize(${String(stalling)}) must be a batch the loop can advance by`);
  }
  // And a usable value is passed through untouched, so the bound is a
  // floor and not a replacement for the constant.
  assert.equal(metadataBatchSize(1), 1);
  assert.equal(metadataBatchSize(7), 7);
  assert.equal(metadataBatchSize(METADATA_BATCH), METADATA_BATCH);
  assert.ok(Number.isInteger(METADATA_BATCH) && METADATA_BATCH >= 1, 'the shipped constant must itself be a batch the loop can advance by');
});

test('a metadata batch of zero terminates instead of hanging, and still scans every commit', () => {
  // THE CASE BUILT TO BREAK THE CONTRACT, not a restatement of it. The
  // stalling value is driven all the way through runScanBlobs, in a CHILD
  // process with a timeout: a spinning `at += 0` loop is synchronous
  // between git calls and never yields, so a test runner's own timeout,
  // which shares the event loop with the test, could not interrupt it. Only
  // something outside the process can. If the bound were removed this test
  // reports a killed child rather than hanging the suite.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  commit(work, 'notes.md', 'nothing secret here\n', 'Meeting with Hunter2Corp tomorrow');
  const leakSha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const firstSha = git(work, ['rev-parse', 'HEAD~1']).stdout.trim();

  const driver = join(work, '..', 'zero-batch-driver.mjs');
  writeFileSync(driver, [
    `import { runScanBlobs } from ${JSON.stringify(join(KIT_ROOT, 'src', 'commands', 'scan-blobs.mjs'))};`,
    'const io = {',
    '  stdin: process.stdin,',
    '  stdout: { write: (text) => process.stdout.write(text) },',
    '  stderr: { write: (text) => process.stderr.write(text) },',
    '};',
    'const status = await runScanBlobs([], io, { metadataBatch: 0 });',
    'process.stdout.write(`STATUS:${status}\\n`);',
    '',
  ].join('\n'));

  const NUL = String.fromCharCode(0);
  const result = spawnSync(process.execPath, [driver], {
    cwd: work,
    input: `commit${NUL}${firstSha}${NUL}commit${NUL}${leakSha}${NUL}`,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns },
  });

  assert.equal(result.signal, null, `the child was killed (${result.signal}); the metadata loop did not advance`);
  // It terminated AND it did the work: the leak is in the second commit's
  // MESSAGE, so a loop that stopped early would report nothing.
  assert.match(result.stderr, /possible leak in the message of commit [0-9a-f]{7} \(COMMIT MESSAGE\)/);
  assert.match(result.stdout, /STATUS:1/);
  assert.doesNotMatch(result.stderr, /hunter2corp/i);
});

test('a tag object that names no object refuses, rather than ending the chain quietly', () => {
  // The case built to break the "git never produces this" contract, rather
  // than a restatement of it: `git hash-object --literally` writes the tag
  // object git's own fsck refuses to write, with a tagger and a message but
  // no `object` header. The chain then ends somewhere other than where the
  // tag says it does, and whatever it pointed at went unread, which is the
  // refusing side of this module's own skip rule.
  //
  // Driven through `scan-blobs` directly rather than through `git push`,
  // and that is a finding of its own worth writing down: a push carrying
  // such a tag is ALREADY refused one step earlier, because `git rev-list`
  // on it fails and the hook refuses rather than scanning nothing. So this
  // clause is the second of two fail-closed checks on the same shape, and
  // it is reachable only through this command's own interface. It is
  // defended anyway, because the hook's check is about listing commits and
  // this one is about following the chain, and a later round that changes
  // one has no reason to look at the other.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');

  const body = join(work, '..', 'malformed-tag-body.txt');
  writeFileSync(body, ['type commit', 'tag broken', 'tagger A Human <human@example.invalid> 1 +0000', '', 'an ordinary message', ''].join('\n'));
  const written = git(work, ['hash-object', '-t', 'tag', '-w', '--literally', body]);
  assert.equal(written.status, 0, written.stderr);
  const tagSha = written.stdout.trim();
  assert.equal(git(work, ['cat-file', '-t', tagSha]).stdout.trim(), 'tag');

  const r = scanBlobs(work, tipRecord(tagSha), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /names no object/);
});

test('a push from a LINKED WORKTREE finds the one gate the repository has', () => {
  // The gate lives under the git directory, and a linked worktree has two
  // of those: `--git-dir` gives it its own private .git/worktrees/<name>,
  // while `--git-common-dir` gives the shared one the gate was installed
  // into. core.hooksPath is a single setting for the whole repository, so
  // git runs the installed hook from the worktree too; reading the
  // per-worktree directory instead would send the hook looking for an
  // installation that is not there, and it would refuse EVERY push made
  // from ANY worktree. That fails closed rather than open, but a gate that
  // refuses ordinary work is how a repository learns --no-verify, which is
  // the failure this whole slice keeps coming back to. So both directions
  // are asserted: clean work from a worktree goes through, and a leak from
  // a worktree does not.
  const { root, work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  const side = join(root, 'side');
  assert.equal(git(work, ['worktree', 'add', '-q', '-b', 'side', side]).status, 0);

  writeFileSync(join(side, 'ordinary.md'), 'nothing secret here\n');
  assert.equal(git(side, ['add', 'ordinary.md']).status, 0);
  assert.equal(git(side, ['commit', '-q', '-m', 'a clean message']).status, 0);
  const clean = git(side, ['push', '-q', 'origin', 'side'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(clean.status, 0, clean.stderr);

  writeFileSync(join(side, 'notes.md'), 'Meeting with Hunter2Corp tomorrow\n');
  assert.equal(git(side, ['add', 'notes.md']).status, 0);
  assert.equal(git(side, ['commit', '-q', '-m', 'a clean message']).status, 0);
  const leaking = git(side, ['push', '-q', 'origin', 'side'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(leaking.status, 0, leaking.stderr);
  assert.match(leaking.stderr, /possible leak in notes\.md \(CONTENT/);
  // The gate the linked worktree found is the one the repository has, and
  // it names itself on the refusal.
  assert.match(leaking.stderr, /gate engine snapshot: installed /);
});

// --- the snapshot must be a COPY, not a link (ninth round) ---------------
//
// `cp -R` does not dereference a symbolic link, so a link in the engine
// source was installed AS a link and the gate executed whatever it pointed
// at, which stayed writable after the install and could live anywhere. A
// reviewer pointed src/leak.mjs outside the repository, replaced the
// target with a module keeping every export and blunting only the scan,
// and pushed a leak with exit 0 and no re-install. That is the working
// tree reaching the gate again, through a file the installer believed it
// had copied, and nothing in this suite could see it: nothing planted a
// symlink and the harness's own cpSync does not dereference either.
//
// The installer refuses instead of dereferencing, because this project's
// engine has no symbolic links in it: one appearing means the tree is not
// what the installer thinks it is, and refusing says which path.

function kitCheckout(root, name = 'kit') {
  const kit = join(root, name);
  mkdirSync(join(kit, '.githooks'), { recursive: true });
  copyFileSync(HOOK_SOURCE, join(kit, '.githooks', 'pre-push'));
  copyFileSync(INSTALLER, join(kit, '.githooks', 'install-gate'));
  chmodSync(join(kit, '.githooks', 'install-gate'), 0o755);
  for (const dir of KIT_DIRS_TO_MIRROR) cpSync(join(KIT_ROOT, dir), join(kit, dir), { recursive: true });
  copyFileSync(join(KIT_ROOT, 'package.json'), join(kit, 'package.json'));
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', kit]).status, 0);
  assert.equal(git(kit, ['add', '-A']).status, 0);
  assert.equal(git(kit, ['commit', '-q', '-m', 'a brain-kit checkout']).status, 0);
  return kit;
}

test('the installer REFUSES a symbolic link in the engine source, and names the path', () => {
  const root = makeTempDir('brain-kit-symlink-');
  const work = join(root, 'work');
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  const kit = kitCheckout(root, 'kit');
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  copyFileSync(join(kit, 'src', 'leak.mjs'), join(outside, 'leak.mjs'));
  unlinkSync(join(kit, 'src', 'leak.mjs'));
  symlinkSync(join(outside, 'leak.mjs'), join(kit, 'src', 'leak.mjs'));

  const installed = spawnSync(join(kit, '.githooks', 'install-gate'), [], { cwd: work, encoding: 'utf8' });
  assert.notEqual(installed.status, 0, installed.stdout);
  assert.match(installed.stderr, /symbolic link/);
  assert.match(installed.stderr, /src\/leak\.mjs/);
  // Refusing must not leave a half-built gate behind, nor point
  // core.hooksPath at one that was never finished.
  assert.equal(existsSync(join(work, '.git', 'brain-kit-gate')), false);
  assert.equal(existsSync(join(work, '.git', 'brain-kit-gate.installing')), false);
  assert.equal(git(work, ['config', '--get', 'core.hooksPath']).stdout.trim(), '');
});

test('a symbolic link DEEP in the engine source is refused too, not only one at the top', () => {
  const root = makeTempDir('brain-kit-symlink-deep-');
  const work = join(root, 'work');
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  const kit = kitCheckout(root, 'kit');
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  copyFileSync(join(kit, 'src', 'commands', 'scan-blobs.mjs'), join(outside, 'scan-blobs.mjs'));
  unlinkSync(join(kit, 'src', 'commands', 'scan-blobs.mjs'));
  symlinkSync(join(outside, 'scan-blobs.mjs'), join(kit, 'src', 'commands', 'scan-blobs.mjs'));

  const installed = spawnSync(join(kit, '.githooks', 'install-gate'), [], { cwd: work, encoding: 'utf8' });
  assert.notEqual(installed.status, 0, installed.stdout);
  assert.match(installed.stderr, /symbolic link/);
  assert.match(installed.stderr, /src\/commands\/scan-blobs\.mjs/);
});

test('a symbolic link pointing INSIDE the repository being pushed is refused on the same terms', () => {
  // The sharpest shape of it: the link target is an uncommitted file in
  // the working tree, which is hole (i) restored exactly.
  const root = makeTempDir('brain-kit-symlink-inside-');
  const work = join(root, 'work');
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  const kit = kitCheckout(root, 'kit');
  mkdirSync(join(work, 'vendor'), { recursive: true });
  copyFileSync(join(kit, 'src', 'leak.mjs'), join(work, 'vendor', 'leak.mjs'));
  unlinkSync(join(kit, 'src', 'leak.mjs'));
  symlinkSync(join(work, 'vendor', 'leak.mjs'), join(kit, 'src', 'leak.mjs'));

  const installed = spawnSync(join(kit, '.githooks', 'install-gate'), [], { cwd: work, encoding: 'utf8' });
  assert.notEqual(installed.status, 0, installed.stdout);
  assert.match(installed.stderr, /symbolic link/);
});

test('an ordinary engine source, with no links in it, still installs', () => {
  // The control: the refusal above must be about links, not about the
  // installer having become unable to install anything.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(existsSync(join(work, '.git', 'brain-kit-gate', 'engine', 'src', 'leak.mjs')), true);
});

// --- a refresh never leaves the clone ungated (ninth round) --------------

test('a REFRESH keeps a working gate at every step, and a failed one leaves the old gate in place', () => {
  // The installer used to delete the live gate and then move the staged
  // one in. Between those two statements core.hooksPath named a directory
  // that did not exist, and git skips a missing hook in silence, so the
  // failure mode of a refresh was no gate at all with no output. A
  // reviewer proved it by deleting the directory and pushing a leak.
  //
  // Here the second rename is made to fail (the destination is replaced
  // by a file the staged directory cannot be renamed onto is not portable,
  // so the staged directory is removed underneath the installer instead,
  // by making it unreadable is not portable either; the portable shape is
  // to let the installer run and then assert the gate survives a refresh
  // that could not complete, which is what the interrupted case leaves).
  const { work, patterns, kit, gateDir } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  // A refresh that cannot finish: the engine is gone from the source, so
  // the installer refuses BEFORE it touches the installed gate.
  rmSync(join(kit, 'src'), { recursive: true, force: true });
  const failed = spawnSync(join(kit, '.githooks', 'install-gate'), [], { cwd: work, encoding: 'utf8' });
  assert.notEqual(failed.status, 0);

  // The gate that was there is still there, and still refuses a leak.
  assert.equal(existsSync(join(gateDir, 'pre-push')), true);
  assert.equal(existsSync(join(gateDir, 'engine', 'src', 'leak.mjs')), true);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
});

test('the installer never leaves a "previous" directory behind after a successful refresh', () => {
  const { work, kit } = setup();
  const previous = join(work, '.git', 'brain-kit-gate.previous');
  assert.equal(spawnSync(join(kit, '.githooks', 'install-gate'), [], { cwd: work, encoding: 'utf8' }).status, 0);
  assert.equal(existsSync(previous), false);
  assert.equal(existsSync(join(work, '.git', 'brain-kit-gate.installing')), false);
});

test('a gate directory that vanished is the one failure the hook cannot report, so the installer must never create it', () => {
  // Not a test of the hook: it is a test of the ONLY thing that can
  // prevent this state, which is the installer's ordering. This asserts
  // the consequence, so that a future reader sees why the ordering is
  // written the way it is: with core.hooksPath set and the directory
  // gone, a leaking push is accepted in total silence.
  const { work, patterns, gateDir } = setup();
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  rmSync(gateDir, { recursive: true, force: true });
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, 'git really does skip a missing hook without a word');
  assert.doesNotMatch(r.stderr, /pre-push/);
});

// --- a bare or mirror clone: refused, with the true reason ---------------

test('a bare clone is told it has no working tree, not that it is not a repository', () => {
  const root = makeTempDir('brain-kit-bare-');
  const bare = join(root, 'mirror.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  const kit = kitCheckout(root, 'kit');
  const r = spawnSync(join(kit, '.githooks', 'install-gate'), [], { cwd: bare, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no working tree/);
  assert.match(r.stderr, /bare or mirror clone/);
  assert.doesNotMatch(r.stderr, /not inside a git repository/);
});

test('somewhere that really is not a repository still says so', () => {
  const root = makeTempDir('brain-kit-norepo-');
  const kit = kitCheckout(root, 'kit');
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  const r = spawnSync(join(kit, '.githooks', 'install-gate'), [], {
    cwd: outside,
    encoding: 'utf8',
    // GIT_CEILING_DIRECTORIES stops git walking up into whatever
    // repository the temporary directory may happen to sit inside.
    env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not inside a git repository/);
});

// --- a pushed ref that does not peel to a commit (ninth round) -----------
//
// `git rev-list` on a non-commit exits ZERO and prints nothing, which the
// hook read as an empty range, and the tip handler broke out of its loop
// on any type it did not recognise. Three shapes reached a bare remote
// with exit 0 and no output at all.

test('a raw BLOB pushed to an arbitrary ref is scanned, not waved through', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  const written = spawnSync('git', ['-C', work, 'hash-object', '-w', '--stdin'], {
    input: 'secret partner list: Hunter2Corp\n', encoding: 'utf8',
  });
  assert.equal(written.status, 0, written.stderr);
  const sha = written.stdout.trim();
  const r = git(work, ['push', '-q', 'origin', `${sha}:refs/leaks/one`], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the blob [0-9a-f]{7} this push points a ref at \(CONTENT\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('a CLEAN blob pushed to an arbitrary ref still pushes: the ref is scanned, not banned', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  const written = spawnSync('git', ['-C', work, 'hash-object', '-w', '--stdin'], {
    input: 'nothing secret here\n', encoding: 'utf8',
  });
  assert.equal(written.status, 0);
  const r = git(work, ['push', '-q', 'origin', `${written.stdout.trim()}:refs/notes/ordinary`], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
});

test('an annotated tag naming a BLOB is followed to the blob and the blob is scanned', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  const written = spawnSync('git', ['-C', work, 'hash-object', '-w', '--stdin'], {
    input: 'secret partner list: Hunter2Corp\n', encoding: 'utf8',
  });
  assert.equal(written.status, 0);
  assert.equal(git(work, ['tag', '-a', 'leaktag', '-m', 'an innocent message', written.stdout.trim()]).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'refs/tags/leaktag'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the blob [0-9a-f]{7} this push points a ref at \(CONTENT\)/);
});

test('an annotated tag naming a TREE has that tree\'s paths and contents scanned', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  mkdirSync(join(work, 'leakdir'), { recursive: true });
  writeFileSync(join(work, 'leakdir', 'Hunter2Corp-notes.md'), 'nothing secret in the body\n');
  assert.equal(git(work, ['add', 'leakdir']).status, 0);
  const tree = git(work, ['write-tree']);
  assert.equal(tree.status, 0, tree.stderr);
  assert.equal(git(work, ['tag', '-a', 'treetag', '-m', 'an innocent message', tree.stdout.trim()]).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'refs/tags/treetag'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in a file name in the tree [0-9a-f]{7} \(PATH/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('a tree whose PATHS are clean still has its blob CONTENTS read', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  mkdirSync(join(work, 'ordinary'), { recursive: true });
  writeFileSync(join(work, 'ordinary', 'notes.md'), 'Meeting with Hunter2Corp tomorrow\n');
  assert.equal(git(work, ['add', 'ordinary']).status, 0);
  const tree = git(work, ['write-tree']);
  assert.equal(tree.status, 0);
  assert.equal(git(work, ['tag', '-a', 'treetag2', '-m', 'an innocent message', tree.stdout.trim()]).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'refs/tags/treetag2'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in ordinary\/notes\.md \(CONTENT, in the tree [0-9a-f]{7}\)/);
});

test('the hook says out loud that a ref naming no commit has no commit range, rather than passing in silence', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  const written = spawnSync('git', ['-C', work, 'hash-object', '-w', '--stdin'], {
    input: 'nothing secret here\n', encoding: 'utf8',
  });
  const r = git(work, ['push', '-q', 'origin', `${written.stdout.trim()}:refs/notes/said-so`], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /does not point at a commit \(it names a blob\)/);
});

// --- the exemption's containment DIRECTION (ninth round) -----------------

test('the exemption is exact in BOTH directions: an author whose name CONTAINS the pushing identity is refused', () => {
  // The three narrowness tests above all vary the CANDIDATE and none
  // varies the direction, so what they actually pin is "a different
  // string is not exempt", not "only an equal string is exempt".
  // Widening `===` to `.includes()` is one token, it walks a real leak
  // onto a remote, and the suite did not move. This is the test that
  // moves.
  const { work, patterns } = setupSelfNamedMaintainer();
  writeFileSync(join(work, 'README.md'), 'hello world\n');
  assert.equal(gitAs(work, ['add', 'README.md']).status, 0);
  // The pushing identity is `Hunter2Corp Admin <hunter2corp-admin@example.invalid>`.
  // This author string CONTAINS it, byte for byte, with a prefix.
  assert.equal(gitAs(work, ['commit', '-q', '-m', 'a clean message'], {
    GIT_AUTHOR_NAME: 'Not Really Hunter2Corp Admin',
    GIT_AUTHOR_EMAIL: 'hunter2corp-admin@example.invalid',
  }).status, 0);

  const r = gitAs(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the author of commit [0-9a-f]{7} \(AUTHOR IDENTITY\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('an author string the pushing identity is a suffix of is refused too', () => {
  const { work, patterns } = setupSelfNamedMaintainer();
  writeFileSync(join(work, 'README.md'), 'hello world\n');
  assert.equal(gitAs(work, ['add', 'README.md']).status, 0);
  assert.equal(gitAs(work, ['commit', '-q', '-m', 'a clean message'], {
    GIT_AUTHOR_NAME: 'Hunter2Corp Admin and a friend',
    GIT_AUTHOR_EMAIL: 'hunter2corp-admin@example.invalid',
  }).status, 0);
  const r = gitAs(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the author of commit [0-9a-f]{7} \(AUTHOR IDENTITY\)/);
});

// --- the exemption cannot be chosen on the command line (ninth round) ----

test('`git -c user.name=... push` cannot hand itself the identity exemption', () => {
  // `git -c` propagates through GIT_CONFIG_PARAMETERS into every git call
  // a hook makes, so the identity the exemption is keyed on used to be
  // choosable per invocation, by a flag, leaving no trace in any file. It
  // disabled exactly one channel and left the other four working, which
  // reads as a gate that is on. The identity is read from the
  // configuration FILES now, which is also where the author of a commit
  // git makes comes from, so nothing legitimate is lost.
  const { work, patterns } = setup();
  writeFileSync(join(work, 'README.md'), 'hello world\n');
  assert.equal(git(work, ['add', 'README.md']).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'a clean message'], {
    GIT_AUTHOR_NAME: 'Hunter2Corp Ltd', GIT_AUTHOR_EMAIL: 'hunter2corp-ops@example.invalid',
  }).status, 0);

  const r = gitAs(work, [
    '-c', 'user.name=Hunter2Corp Ltd',
    '-c', 'user.email=hunter2corp-ops@example.invalid',
    'push', '-q', 'origin', 'main',
  ], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the author of commit [0-9a-f]{7} \(AUTHOR IDENTITY\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('the GIT_CONFIG_COUNT form of the same override cannot either', () => {
  const { work, patterns } = setup();
  writeFileSync(join(work, 'README.md'), 'hello world\n');
  assert.equal(git(work, ['add', 'README.md']).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'a clean message'], {
    GIT_AUTHOR_NAME: 'Hunter2Corp Ltd', GIT_AUTHOR_EMAIL: 'hunter2corp-ops@example.invalid',
  }).status, 0);
  const r = gitAs(work, ['push', '-q', 'origin', 'main'], {
    BRAIN_KIT_LEAK_PATTERNS: patterns,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Hunter2Corp Ltd',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'hunter2corp-ops@example.invalid',
  });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the author of commit [0-9a-f]{7} \(AUTHOR IDENTITY\)/);
});

test('the exemption a maintainer really needs still works, read from the configuration files', () => {
  // The control for the two above: closing the flag channel must not
  // close the deadlock the exemption exists for.
  const { work, patterns } = setupSelfNamedMaintainer();
  writeFileSync(join(work, 'README.md'), 'hello world\n');
  assert.equal(gitAs(work, ['add', 'README.md']).status, 0);
  assert.equal(gitAs(work, ['commit', '-q', '-m', 'a clean message']).status, 0);
  const r = gitAs(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /\(AUTHOR IDENTITY\) matches a pattern, but it is exactly the identity/);
});

// --- a commit message is read as an OBJECT, not as a formatted field -----

test('a commit message carrying a NUL byte is scanned past the NUL, not truncated at it', () => {
  // `git show -s --format=%B` stops at a NUL, so everything after one was
  // never scanned: a raw commit object whose message was "harmless", a
  // NUL, and then a pattern pushed with exit 0 and the text in plaintext
  // on the remote. The guards that were built for this defended a field
  // shift that does not happen, because git truncated first.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  const tree = git(work, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const parent = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const object = Buffer.concat([
    Buffer.from(`tree ${tree}\nparent ${parent}\n`
      + 'author A Human <human@example.invalid> 1700000000 +0000\n'
      + 'committer A Human <human@example.invalid> 1700000000 +0000\n\n', 'utf8'),
    Buffer.from('harmless', 'utf8'),
    Buffer.from([0]),
    Buffer.from('Meeting with Hunter2Corp tomorrow\n', 'utf8'),
  ]);
  const written = spawnSync('git', ['-C', work, 'hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], {
    input: object, encoding: 'utf8',
  });
  assert.equal(written.status, 0, written.stderr);
  assert.equal(git(work, ['update-ref', 'refs/heads/main', written.stdout.trim()]).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the message of commit [0-9a-f]{7} \(COMMIT MESSAGE\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
});

test('an ordinary multi-line commit message is still read whole, message and identities alike', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  commit(work, 'more.md', 'nothing secret here\n', 'a subject\n\na body line\nand another mentioning Hunter2Corp\n');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the message of commit [0-9a-f]{7} \(COMMIT MESSAGE\)/);
});

// --- the gate directory comparison is EXACT, not a prefix (ninth round) --

test('a hook run from a subdirectory OF the gate directory is refused, so the comparison cannot widen to a prefix', () => {
  // `[ "$HOOK_DIR" != "$GATE_DIR" ]` widened to a prefix match survives
  // the whole suite otherwise. It is low severity on its own, because
  // reaching it needs somebody who can already write under the gate
  // directory, but an exactness nothing pins is an exactness that will be
  // relaxed by the next person who finds it inconvenient.
  const { work, patterns, gateDir } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const nested = join(gateDir, 'nested');
  mkdirSync(nested, { recursive: true });
  copyFileSync(join(gateDir, 'pre-push'), join(nested, 'pre-push'));
  chmodSync(join(nested, 'pre-push'), 0o755);
  assert.equal(git(work, ['config', 'core.hooksPath', nested]).status, 0);

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /not from its installed copy/);
});

test('when the swap itself fails, the gate that was already installed is put back', () => {
  // The load-bearing half of the ordering: the old gate is moved aside,
  // not deleted, so there is something to restore. Proved by making the
  // second rename fail, which is the only step between "old gate moved
  // aside" and "new gate in place".
  const { root, work, patterns, kit, gateDir } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  const realMv = realPath('mv');
  const fake = shimDir(root, 'mv', {
    mv: `#!/bin/sh\ncase "$1" in\n  *brain-kit-gate.installing) exit 1 ;;\nesac\nexec ${realMv} "$@"\n`,
  });
  const failed = spawnSync(join(kit, '.githooks', 'install-gate'), [], {
    cwd: work, encoding: 'utf8', env: { ...process.env, PATH: `${fake}:${process.env.PATH}` },
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /has been put back/);

  assert.equal(existsSync(join(gateDir, 'pre-push')), true);
  assert.equal(existsSync(join(gateDir, 'engine', 'src', 'leak.mjs')), true);
  assert.equal(existsSync(join(work, '.git', 'brain-kit-gate.previous')), false);

  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
});

test('a SOURCE HOOK that is a symbolic link is refused too, not only an engine file', () => {
  const root = makeTempDir('brain-kit-symlink-hook-');
  const work = join(root, 'work');
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  const kit = kitCheckout(root, 'kit');
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  copyFileSync(join(kit, '.githooks', 'pre-push'), join(outside, 'pre-push'));
  unlinkSync(join(kit, '.githooks', 'pre-push'));
  symlinkSync(join(outside, 'pre-push'), join(kit, '.githooks', 'pre-push'));

  const r = spawnSync(join(kit, '.githooks', 'install-gate'), [], { cwd: work, encoding: 'utf8' });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /is a symbolic link/);
  assert.equal(existsSync(join(work, '.git', 'brain-kit-gate')), false);
});

test('an uncommitted gate edit alone makes the snapshot stale, with HEAD unchanged', () => {
  // Isolates the byte comparison from the HEAD comparison: nothing is
  // committed here, so HEAD still equals the commit the stamp names, and
  // only the edited file can be what makes this stale. Without this the
  // comparison could be deleted and the suite would not move, because
  // every other stale case also moves HEAD.
  const { work, patterns } = setupSelfHosted();
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  // A ref to push that does not move HEAD.
  assert.equal(git(work, ['branch', 'side']).status, 0);

  const quiet = git(work, ['push', '-q', 'origin', 'side'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /gate engine snapshot/);

  writeFileSync(join(work, '.githooks', 'pre-push'), '#!/usr/bin/env bash\nexit 0\n');
  assert.equal(git(work, ['branch', 'side2']).status, 0);
  const noisy = git(work, ['push', '-q', 'origin', 'side2'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(noisy.status, 0, noisy.stderr);
  assert.match(noisy.stderr, /gate engine snapshot: installed /);
});

// The terminal-object handler's last clause, a refusal on a type this
// gate does not know, is left UNDEFENDED on purpose and the attempt is
// recorded rather than the conclusion. The case designed to break it
// cannot be built: git 2.55 refuses `hash-object -t <anything> --literally`
// for a type it does not know ("fatal: invalid object type"), so there is
// no object to push and no test to write. It stays because a default that
// refuses costs nothing and a default that falls through is how this
// whole finding happened; it is declared because a clause no test can
// reach is a clause a later reader may delete believing it is dead.

test('a ref pointing at an EMPTY tree is skipped OUT LOUD, never in silence', () => {
  // The fourth appearance on this gate of "a command succeeded with empty
  // output, so there was nothing to do", and the first in code this round
  // wrote. Accepting it is right; saying nothing is not, because a skip
  // nobody can see reads exactly like a scan that found nothing.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  const empty = spawnSync('git', ['-C', work, 'hash-object', '-t', 'tree', '-w', '--stdin'], {
    input: '', encoding: 'utf8',
  });
  assert.equal(empty.status, 0, empty.stderr);
  const r = git(work, ['push', '-q', 'origin', `${empty.stdout.trim()}:refs/trees/empty`], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /skipping the tree [0-9a-f]{7} .*git lists no entries in it/);
});

// --- the commit read's own framing checks, reached for real -------------

function scanBlobsDirect(work, gateDir, records, patterns) {
  return spawnSync(process.execPath, [join(gateDir, 'engine', 'bin', 'brain-kit.mjs'), 'scan-blobs'], {
    cwd: work, encoding: 'utf8', input: records,
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns },
  });
}

test('a commit record naming an object that is not a commit refuses, rather than being read as one', () => {
  const { work, patterns, gateDir } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const blob = spawnSync('git', ['-C', work, 'hash-object', '-w', '--stdin'], {
    input: 'nothing secret here\n', encoding: 'utf8',
  });
  assert.equal(blob.status, 0);
  const r = scanBlobsDirect(work, gateDir, `commit\0${blob.stdout.trim()}\0`, patterns);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /is a blob, not a commit/);
});

test('a commit record naming an object this clone does not have refuses', () => {
  const { work, patterns, gateDir } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const r = scanBlobsDirect(work, gateDir, `commit\0${'0'.repeat(39)}1\0`, patterns);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /instead of an object header/);
});

test('two commit records are matched to their own objects, not to each other\'s', () => {
  // The id check, reached with a real batch: the whole point of reading
  // objects by declared length is that record N is record N.
  const { work, patterns, gateDir } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  commit(work, 'notes.md', 'nothing secret here\n', 'mentions Hunter2Corp');
  const first = git(work, ['rev-parse', 'HEAD~1']).stdout.trim();
  const second = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const r = scanBlobsDirect(work, gateDir, `commit\0${first}\0commit\0${second}\0`, patterns);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`the message of commit ${second.slice(0, 7)} \\(COMMIT MESSAGE\\)`));
  assert.doesNotMatch(r.stderr, new RegExp(`the message of commit ${first.slice(0, 7)} \\(COMMIT MESSAGE\\)`));
});

test('a commit record that does not name its object exactly refuses, rather than being quietly resolved', () => {
  // `git cat-file --batch` echoes the object name it RESOLVED, not the
  // string it was given, so a record carrying an abbreviation or a
  // symbolic name comes back as something else. Refusing keeps the
  // records this command reports on identical to the records it was
  // handed: a finding names the commit the hook listed, never one this
  // module resolved on its own.
  const { work, patterns, gateDir } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const short = git(work, ['rev-parse', '--short', 'HEAD']).stdout.trim();
  const r = scanBlobsDirect(work, gateDir, `commit\0${short}\0`, patterns);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /returned the object [0-9a-f]{40} where/);
});

// --- (q) THE REFERENCE NAME, THE SIXTH CHANNEL --------------------------
//
// Five channels were scanned and the name of the reference itself was not
// one of them: a branch named after an active pattern pushed with exit 0
// and the name sat on the remote, readable by anyone who can list
// references. The tests below are the reproduction, the control that the
// channel bans nothing it should not, the two shapes this round had to get
// right (a deletion, and a name that is not ASCII), and the case built to
// defeat the redaction rather than to confirm it.

// Only the gate's own lines. Git prints the source refspec in its own
// progress output, which is git talking to the person at the terminal
// about the command they just typed; the never-print contract is about
// what THIS gate writes.
function gateLines(stderr) {
  return stderr.split('\n').filter((line) => line.startsWith('pre-push:')).join('\n');
}

test('a branch named after a pattern is refused, and the name never reaches the remote', () => {
  const { root, work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(git(work, ['checkout', '-q', '-b', 'hunter2corp-migration']).status, 0);
  commit(work, 'notes.md', 'nothing unusual in here at all\n', 'an ordinary commit');

  const r = git(work, ['push', '-q', 'origin', 'hunter2corp-migration'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the destination name of reference #1 of this push \(REFERENCE NAME, the name itself is withheld\)/);
  const refs = spawnSync('git', ['--git-dir', join(root, 'origin.git'), 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
  assert.doesNotMatch(refs.stdout, /hunter2corp/, 'the reference name reached the remote');
});

test('the content and the commit of a badly named branch are clean, so the NAME is the only thing refusing it', () => {
  // Without this, the test above would pass just as well if the gate were
  // refusing that push for some entirely different reason.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(git(work, ['checkout', '-q', '-b', 'hunter2corp-migration']).status, 0);
  commit(work, 'notes.md', 'nothing unusual in here at all\n', 'an ordinary commit');

  const r = git(work, ['push', '-q', 'origin', 'hunter2corp-migration'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  const findings = r.stderr.split('\n').filter((line) => line.includes('possible leak in'));
  assert.equal(findings.length, 1, r.stderr);
  assert.match(findings[0], /REFERENCE NAME/);
});

test('an ordinary branch name still pushes: the channel scans names, it does not restrict them', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['checkout', '-q', '-b', 'feature/some-ordinary-work']).status, 0);
  commit(work, 'notes.md', 'nothing unusual in here at all\n', 'an ordinary commit');
  const r = git(work, ['push', '-q', 'origin', 'feature/some-ordinary-work'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
});

test('the DESTINATION name is what is scanned, so renaming on the way out is still a remedy', () => {
  // The source name never crosses the wire, and refusing it would take
  // away the exact fix this channel's own finding asks a person to make.
  const { root, work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['checkout', '-q', '-b', 'hunter2corp-migration']).status, 0);
  commit(work, 'notes.md', 'nothing unusual in here at all\n', 'an ordinary commit');

  const r = git(work, ['push', '-q', 'origin', 'hunter2corp-migration:refs/heads/migration'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  const refs = spawnSync('git', ['--git-dir', join(root, 'origin.git'), 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
  assert.match(refs.stdout, /refs\/heads\/migration/);
  assert.doesNotMatch(refs.stdout, /hunter2corp/);
  // And the gate did not print the source name either: it can be the same
  // text as a destination name that matched.
  assert.doesNotMatch(gateLines(r.stderr), /hunter2corp/);
});

test('a DELETION is refused on its name too: it carries no objects but it still publishes the name', () => {
  // Measured, not assumed: git does not require the reference to exist on
  // the remote first. A deletion of a name that was never there is
  // accepted, with a warning, and the name reaches the receiving end all
  // the same, which makes this the cheapest leak the gate covers.
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  const r = git(work, ['push', '-q', 'origin', ':refs/heads/hunter2corp-ghost'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the destination name of reference #1 of this push/);
  assert.doesNotMatch(gateLines(r.stderr), /ghost/);
});

test('an ordinary deletion still passes, and says the skip is about objects and not about the name', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(git(work, ['push', '-q', 'origin', 'main:refs/heads/spare'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  const r = git(work, ['push', '-q', 'origin', ':refs/heads/spare'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /skipping the objects of reference #1 of this push/);
  assert.match(r.stderr, /destination name is still scanned/);
});

test('a reference name that is not ASCII is decoded the way every other channel decodes bytes', () => {
  // A reference name can carry any byte above 0x7f. The hook writes those
  // bytes through unchanged and the engine decodes its whole standard
  // input as latin1, the same decoding a file name gets, so a pattern
  // written against those bytes matches here exactly as it does there. If
  // this channel ever grew a decoding of its own, this is the test that
  // would go red.
  const { root, work } = setup();
  const patterns = join(root, 'byte-patterns.txt');
  // The branch name's two non-ASCII bytes are 0xc3 0xa7 (the UTF-8 of
  // U+00E7, which is what git will carry). Decoded as latin1 those are the
  // two characters below, and the patterns file is read as UTF-8, so
  // writing them here puts exactly those two bytes in front of the
  // scanner.
  writeFileSync(patterns, 'caf\u00c3\u00a7\n');
  commit(work, 'README.md', 'hello world\n', 'init');
  const branch = 'caf\u00e7-notes';
  assert.equal(git(work, ['checkout', '-q', '-b', branch]).status, 0);

  const r = git(work, ['push', '-q', 'origin', branch], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the destination name of reference #1 of this push/);
  const refs = spawnSync('git', ['--git-dir', join(root, 'origin.git'), 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
  assert.doesNotMatch(refs.stdout, /caf/);
});

test('a push carrying several references scans every one of them, and one bad name refuses all of it', () => {
  // Git offers the whole push to one hook run. A refusal is a refusal of
  // all of it, so a clean reference travelling beside a bad one does not
  // land either; and every reference is still scanned, so the maintainer
  // learns about all of them in one go instead of one per attempt.
  const { root, work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  for (const name of ['aaa-tidy', 'hunter2corp-one', 'bbb-tidy', 'hunter2corp-two']) {
    assert.equal(git(work, ['checkout', '-q', '-b', name, 'main']).status, 0);
  }
  const r = git(work, ['push', '-q', 'origin', 'aaa-tidy', 'hunter2corp-one', 'bbb-tidy', 'hunter2corp-two'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  const findings = r.stderr.split('\n').filter((line) => line.includes('REFERENCE NAME'));
  assert.equal(findings.length, 2, r.stderr);
  // Numbered, so two findings are two references rather than one reported
  // twice, and the numbers are the positions git listed them in.
  assert.match(findings[0], /reference #2 of this push/);
  assert.match(findings[1], /reference #4 of this push/);
  const refs = spawnSync('git', ['--git-dir', join(root, 'origin.git'), 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
  assert.doesNotMatch(refs.stdout, /tidy/, 'a clean reference landed although the push was refused');
});

test('the reference NUMBER is checked before it is printed, because it is the one field always printed', () => {
  // THE CASE BUILT TO DEFEAT THE REDACTION. Every other field of a
  // reference record is withheld the moment it matches, so a name that
  // wanted to be printed would have to travel in the field that is never
  // withheld. It cannot: a number field that is not a number refuses, and
  // the refusal does not echo the field.
  const { work, patterns, gateDir } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const r = scanBlobsDirect(work, gateDir, 'ref\u0000Hunter2Corp\u0000refs/heads/main\u0000', patterns);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /something other than a reference number in its number field/);
  assert.doesNotMatch(r.stderr, /Hunter2Corp/i);
});

test('a reference record with no destination name refuses, rather than scanning an empty string clean', () => {
  // An empty destination is the refusing side of the skip rule: the field
  // that decides where everything else lands should have been readable
  // and was not.
  const { work, patterns, gateDir } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const r = scanBlobsDirect(work, gateDir, 'ref\u00007\u0000\u0000', patterns);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /reference #7 of this push has no destination name/);
});

test('a reference record takes exactly two fields, and a truncated one refuses', () => {
  const { work, patterns, gateDir } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const r = scanBlobsDirect(work, gateDir, 'ref\u00001\u0000', patterns);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /"ref" record with 1 field\(s\) instead of 2/);
});

// --- the fifth "empty means nothing to do", found by looking ------------

test('a final line with no newline after it is still a reference, not a reference to skip', () => {
  // `while read ...; do` stops on a final unterminated line AFTER
  // assigning the fields it read, so that reference used to be dropped
  // entirely: not one channel of it, all six, with exit 0 and no output.
  // Git terminates its own lines, so this is latent rather than live, and
  // it is guarded anyway, because "the producer always does that" is what
  // every one of the four earlier findings of this shape assumed about
  // something.
  const { work, patterns, installedHook, bare } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const r = spawnSync(installedHook, ['origin', bare], {
    cwd: work,
    input: `refs/heads/x ${sha} refs/heads/hunter2corp-last ${sha}`,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns },
  });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the destination name of reference #1 of this push/);
});

test('an unterminated line that is also truncated refuses, rather than being read as a whole one', () => {
  // The guard runs the body one last time for a partial line, and a
  // partial line leaves the later fields empty. An empty destination is
  // refused outright, so a truncation cannot become a reference that
  // passes.
  const { work, patterns, installedHook, bare } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const r = spawnSync(installedHook, ['origin', bare], {
    cwd: work,
    input: `refs/heads/x ${sha}`,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns },
  });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /reference #1 of this push has no destination name/);
});

test('an unterminated DELETION line does not spin the loop forever', () => {
  // The loop body reaches `continue` from several places, and the guard
  // has to terminate from every one of them. A deletion is the earliest.
  const { work, patterns, installedHook, bare } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const zero = '0'.repeat(40);
  const r = spawnSync(installedHook, ['origin', bare], {
    cwd: work,
    input: `refs/heads/x ${zero} refs/heads/an-ordinary-name ${zero}`,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns },
  });
  assert.equal(r.signal, null, 'the hook did not terminate');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /skipping the objects of reference #1 of this push/);
});

test('a push git describes with no references at all says so, instead of passing in silence', () => {
  // Nothing is updated, so nothing is published and nothing is the right
  // answer. It is said out loud anyway: every other time this gate let an
  // empty result stand in silence, the empty result turned out to be
  // standing in for something.
  const { work, patterns, installedHook, bare } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const r = spawnSync(installedHook, ['origin', bare], {
    cwd: work,
    input: '',
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /git listed no references for this push/);
});

test('a push with no references at all still enforces the patterns file', () => {
  const { root, work, installedHook, bare } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const r = spawnSync(installedHook, ['origin', bare], {
    cwd: work,
    input: '',
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: join(root, 'no-such-file.txt') },
  });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /leak patterns file not found/);
});
