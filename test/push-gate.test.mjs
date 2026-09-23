// `brain-kit push-gate`, driven directly: a throwaway repository and bare
// remote, and standard input fed the same reference lines git feeds a
// pre-push hook ("<local ref> <local sha> <remote ref> <remote sha>").
//
// The command is the ONE place a push is enumerated (src/push/records.sh)
// and scanned (the scan-blobs engine). The maintainer's own hook is a
// caller of it (test/pre-push-hook.test.mjs drives that through real
// pushes and must pass unchanged); these tests pin the command's own
// clauses, every one of which decides an exit code:
//
//   - its arguments, where a mistake must stop with usage (2) rather than
//     scan with a pattern list or a remote nobody chose;
//   - the repository check, where "not a repository" must be said, not
//     read as an empty push;
//   - the enumeration's STATUS, read before its stream is parsed, because
//     a stream from a producer that failed is a prefix of the push, and a
//     prefix scans clean;
//   - where the enumeration is read FROM: the copy beside the engine that
//     runs, never a copy the push or the working tree carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const ZERO = '0'.repeat(40);
// A real vault path has a space and an accented letter in it, so every
// fixture here lives under one. Built at runtime: no escape is typed.
const AWKWARD_DIR = `a vault d${String.fromCharCode(0xe9)}j${String.fromCharCode(0xe0)} here`;

function git(cwd, args, env = {}) {
  return spawnSync('git', ['-c', 'user.name=Ana', '-c', 'user.email=ana@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function setup() {
  const root = join(makeTempDir('brain-kit-push-gate-'), AWKWARD_DIR);
  mkdirSync(root, { recursive: true });
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  assert.equal(git(work, ['remote', 'add', 'origin', bare]).status, 0);
  const patterns = join(root, 'patterns.txt');
  writeFileSync(patterns, 'hunter2corp\n');
  return { root, work, bare, patterns };
}

function commit(work, file, content, message) {
  writeFileSync(join(work, file), content);
  assert.equal(git(work, ['add', file]).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', message]).status, 0);
  return git(work, ['rev-parse', 'HEAD']).stdout.trim();
}

function refLine(sha, remoteSha = ZERO) {
  return `refs/heads/main ${sha} refs/heads/main ${remoteSha}\n`;
}

// A null in `env` removes that variable from the child's environment.
function pushGate(cwd, args, input, env = {}) {
  const merged = { ...process.env, BRAIN_KIT_LANG: 'en', ...env };
  for (const [name, value] of Object.entries(merged)) if (value === null) delete merged[name];
  return spawnSync(process.execPath, [BIN, 'push-gate', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: merged,
  });
}

// --- the verdict ----------------------------------------------------------

test('a clean push exits 0 and says, in one line, that the gate ran', () => {
  const { work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /brain-kit leak gate ran: scanned [1-9][0-9]* channel\(s\) across 1 reference\(s\) of this push; nothing matched\./);
  // The stream went to the scanner, not to the person: nothing on stdout.
  assert.equal(r.stdout, '');
});

test('a push carrying a matching blob exits 1 and names the CONTENT channel', () => {
  const { work, bare, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const sha = commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT, at [0-9a-f]{7}\)/);
  assert.doesNotMatch(r.stderr, /hunter2corp/i);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
});

test('the range comes from the remote sha git reports: an already-published leak is not re-scanned', () => {
  // The same enumeration the maintainer's hook ran, not a new one: with a
  // remote sha on the line, only what is new since it is scanned.
  const { work, bare, patterns } = setup();
  const leak = commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');
  const clean = commit(work, 'README.md', 'hello world\n', 'later');
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(clean, leak), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  const full = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(clean), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(full.status, 1, full.stderr);
});

test('a missing patterns file refuses (fail closed), after the enumeration has run', () => {
  const { work, bare } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: join(work, 'nope.txt') });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /leak patterns file not found/);
});

test('an empty standard input says there were no references, and still checks the patterns file', () => {
  const { work, bare, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], '', { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /git listed no references for this push/);
  assert.match(r.stderr, /leak gate ran: scanned 0 channel\(s\) across 0 reference\(s\)/);
  const broken = pushGate(work, ['origin', bare, '--patterns', 'personal'], '', { BRAIN_KIT_LEAK_PATTERNS: join(work, 'nope.txt') });
  assert.equal(broken.status, 1, broken.stderr);
  assert.match(broken.stderr, /leak patterns file not found/);
});

test('scan-blobs, still a command of its own, refuses a missing patterns file even for an empty stream', () => {
  // The maintainer's hook reached this through scan-blobs until push-gate
  // took over; the command still exists, and its fail-closed check must not
  // depend on there being a record to scan it against.
  const { work } = setup();
  const r = spawnSync(process.execPath, [BIN, 'scan-blobs'], {
    cwd: work,
    input: '',
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: join(work, 'nope.txt') },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /leak patterns file not found/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
});

// --- the arguments ----------------------------------------------------------

test('a missing remote exits 2 and says so', () => {
  const { work, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  for (const args of [[], ['--patterns', 'personal'], ['origin', '--patterns', 'personal'], ['', 'url', '--patterns', 'personal']]) {
    const r = pushGate(work, args, refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns });
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stderr}`);
    assert.match(r.stderr, /remote name and the remote URL/, JSON.stringify(args));
    assert.doesNotMatch(r.stderr, /leak gate ran/);
  }
});

test('an unknown --patterns value exits 2 and names it', () => {
  const { work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const r = pushGate(work, ['origin', bare, '--patterns', 'everything'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--patterns "everything" is not a pattern list/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
});

test('--patterns is required, and a --patterns with no value is refused', () => {
  // No default: a default is a pattern list nobody chose.
  const { work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const absent = pushGate(work, ['origin', bare], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(absent.status, 2, absent.stderr);
  assert.match(absent.stderr, /--patterns is required/);
  for (const args of [['origin', bare, '--patterns'], ['origin', bare, '--patterns', '']]) {
    const empty = pushGate(work, args, refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns });
    assert.equal(empty.status, 2, `${JSON.stringify(args)}: ${empty.stderr}`);
    assert.match(empty.stderr, /--patterns is required/, JSON.stringify(args));
  }
});

test('an argument it does not know exits 2', () => {
  const { work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  for (const [args, named] of [
    [['origin', bare, 'extra', '--patterns', 'personal'], 'extra'],
    [['origin', bare, '--force', '--patterns', 'personal'], '--force'],
    // First, where only the flag rule can catch it: taken as a remote name
    // it would be scanned against a remote nobody named.
    [['--force', 'origin', bare, '--patterns', 'personal'], '--force'],
    // Twice is refused rather than resolved: "the last one wins" would let
    // a wrapper that appends its own --patterns replace the caller's.
    [['origin', bare, '--patterns', 'everything', '--patterns', 'personal'], '--patterns'],
  ]) {
    const r = pushGate(work, args, refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns });
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`unrecognized argument "${named}"`), JSON.stringify(args));
    assert.doesNotMatch(r.stderr, /leak gate ran/);
  }
});

test('run outside a repository it exits 2 and says so', () => {
  const { root, patterns } = setup();
  const outside = join(root, 'not a repository');
  mkdirSync(outside);
  const r = pushGate(outside, ['origin', 'origin', '--patterns', 'personal'], refLine('1'.repeat(40)), {
    BRAIN_KIT_LEAK_PATTERNS: patterns,
    GIT_CEILING_DIRECTORIES: root,
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /not inside a git repository/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
});

test('a git that cannot be run at all refuses with 1 and says so, rather than calling the directory not a repository', () => {
  const { root, work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const empty = join(root, 'empty-path');
  mkdirSync(empty);
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns, PATH: empty });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /git could not be run/);
});

test('the scan budget reaches the scanner through push-gate too', () => {
  // A budget below zero makes every scan raise before reading a line, so a
  // push-gate that stopped handing the budget on would scan with none and
  // pass this push.
  const { work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(sha), {
    BRAIN_KIT_LEAK_PATTERNS: patterns,
    BRAIN_KIT_SCAN_BUDGET_MS: '-1',
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /exceeded its deadline/);
});

test('the enumeration reads the real objects, not a git replace stand-in, even when no hook exported anything', () => {
  // The maintainer's hook exports GIT_NO_REPLACE_OBJECTS, so a push through
  // it cannot show whether the enumeration sets it on its own; the gate
  // shipped to other people has no such hook in front of it. Here nothing
  // is exported. The replaced commit adds notes.md, carrying the pattern;
  // its stand-in adds a different, clean file. An enumeration that asked
  // git through the stand-in would list the wrong path, and the push would
  // be refused for a file it does not carry rather than for the one it does.
  const { work, bare, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const dirty = commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');
  assert.equal(git(work, ['reset', '-q', '--hard', 'HEAD~1']).status, 0);
  const stand = commit(work, 'other.md', 'nothing of interest here\n', 'a clean stand-in');
  assert.equal(git(work, ['replace', dirty, stand]).status, 0);
  assert.equal(process.env.GIT_NO_REPLACE_OBJECTS, undefined);
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(dirty), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.doesNotMatch(r.stderr, /other\.md/);
});

test('push-gate speaks English, the language of the gate lines it prints among, whatever BRAIN_KIT_LANG says', () => {
  // A refusal after a partial enumeration: the enumeration's English lines,
  // then push-gate's own. With the default language (pt-BR) or pt-BR asked
  // for, push-gate's line must still be English.
  const { work, bare, patterns } = setup();
  commit(work, 'first.md', 'nothing secret here\n', 'a root commit');
  const rootTree = git(work, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  rmSync(join(work, '.git', 'objects', rootTree.slice(0, 2), rootTree.slice(2)));
  for (const lang of [null, 'pt-BR']) {
    const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns, BRAIN_KIT_LANG: lang });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /could not list the files of/);
    assert.match(r.stderr, /brain-kit push-gate: the push enumeration exited 1/, String(lang));
    assert.doesNotMatch(r.stderr, /enumera\S*o do push/, String(lang));
    const usage = pushGate(work, ['origin', bare, '--patterns', 'everything'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns, BRAIN_KIT_LANG: lang });
    assert.equal(usage.status, 2, usage.stderr);
    assert.match(usage.stderr, /--patterns "everything" is not a pattern list/, String(lang));
    assert.match(usage.stderr, /^Usage: brain-kit push-gate/m, String(lang));
  }
});

test('the Portuguese pack still carries every push-gate sentence, ready for the gate to be translated as one unit', () => {
  const en = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', 'en', 'messages.json'), 'utf8'));
  const pt = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', 'pt-BR', 'messages.json'), 'utf8'));
  const keys = Object.keys(en).filter((key) => key.startsWith('push_gate.'));
  assert.ok(keys.length >= 10, `expected the push_gate keys, found ${keys.length}`);
  for (const key of keys) {
    assert.equal(typeof pt[key], 'string', key);
    assert.notEqual(pt[key], en[key], key);
  }
});

// --- bytes: a reference name that is not UTF-8 ----------------------------

// The ordinary case in a Portuguese vault: a pattern with an accented
// letter, written the ordinary way (UTF-8), and a reference name carrying
// that letter as the single byte Latin-1 gives it. git accepts the name;
// only a gate that keeps every byte as it came, end to end, decodes it to
// the letter the pattern names. Built at runtime; no escape is typed.
const E_ACUTE = String.fromCharCode(0xe9);
const LATIN1_NAME = Buffer.concat([Buffer.from('refs/heads/jos'), Buffer.from([0xe9])]);

function accentedPatterns(root) {
  const file = join(root, 'accented-patterns.txt');
  writeFileSync(file, `jos${E_ACUTE}\n`, 'utf8');
  return file;
}

test('a reference name carrying a Latin-1 byte that matches an accented pattern is refused', () => {
  // A deletion line: the destination name is scanned whatever else the
  // line carries, and a deletion carries nothing else.
  const { root, work, bare } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const line = Buffer.concat([Buffer.from(`(delete) ${ZERO} `), LATIN1_NAME, Buffer.from(` ${sha}\n`)]);
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], line, { BRAIN_KIT_LEAK_PATTERNS: accentedPatterns(root) });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /possible leak in the destination name of reference #1 of this push \(REFERENCE NAME/);
  // The control: the same line with a name that does not match passes, so
  // the refusal above is the name and nothing else.
  const clean = Buffer.concat([Buffer.from(`(delete) ${ZERO} refs/heads/other ${sha}\n`)]);
  const ok = pushGate(work, ['origin', bare, '--patterns', 'personal'], clean, { BRAIN_KIT_LEAK_PATTERNS: accentedPatterns(root) });
  assert.equal(ok.status, 0, ok.stderr);
});

test('the same name, pushed for real through the installed gate, is refused and never reaches the remote', () => {
  const { root, work, bare } = setup();
  const { installed } = installGate(root, work);
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  commit(work, 'README.md', 'hello world\n', 'init');
  const patterns = accentedPatterns(root);
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  // The name goes through bash, which is the one way to put the raw byte in
  // an argument: an argument from here is encoded as UTF-8.
  const make = spawnSync('bash', ['-c', "git update-ref refs/heads/jos$'\\xe9' HEAD"], { cwd: work, encoding: 'utf8' });
  assert.equal(make.status, 0, make.stderr);
  const r = spawnSync('bash', ['-c', "git push -q origin refs/heads/jos$'\\xe9'"], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns },
  });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /REFERENCE NAME/);
  const listed = spawnSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
  assert.equal(listed.stdout.trim(), 'refs/heads/main');
});

// --- the enumeration's status, read before its stream ---------------------

test('an enumeration that fails part way refuses, and its partial stream is never scanned', () => {
  // The dangerous shape: the enumeration carries on past a commit it could
  // not list (so the rest of the push is still examined) and reports the
  // failure in its STATUS. Everything it did list is clean, so a caller
  // that parsed the stream without reading the status first would scan it,
  // find nothing, and exit 0 about a push whose files were never listed.
  const { work, bare, patterns } = setup();
  commit(work, 'first.md', 'nothing secret here\n', 'a root commit');
  const rootTree = git(work, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  rmSync(join(work, '.git', 'objects', rootTree.slice(0, 2), rootTree.slice(2)));
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /could not list the files of [0-9a-f]{40} \(git ls-tree failed\)/);
  assert.match(r.stderr, /the push enumeration exited 1/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
});

test('an enumeration that cannot even start its work list refuses', () => {
  // No scratch directory: the enumeration writes nothing at all and exits
  // non-zero. An empty stream parses perfectly and scans clean, which is
  // exactly why its emptiness must never be the thing that is read.
  const { root, work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(sha), {
    BRAIN_KIT_LEAK_PATTERNS: patterns,
    TMPDIR: join(root, 'no such directory'),
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /could not create a temporary directory/);
  assert.match(r.stderr, /the push enumeration exited 1/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
});

test('an enumeration that cannot be run at all refuses and says why', () => {
  // A PATH with git on it and no bash: the repository check passes, and
  // the enumeration cannot be started.
  const { root, work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const dir = join(root, 'path-without-bash');
  mkdirSync(dir);
  const found = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  assert.equal(found.status, 0);
  symlinkSync(found.stdout.trim(), join(dir, 'git'));
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns, PATH: dir });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /could not run the push enumeration/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
});

test('an enumeration whose stream cannot be handed over refuses rather than handing over nothing', () => {
  // The last thing the enumeration does is copy its work list to the
  // scanner. A copy that fails and is not read is an empty stream with
  // exit 0, which scans clean.
  const { root, work, bare, patterns } = setup();
  const sha = commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');
  const dir = join(root, 'shims-cat');
  mkdirSync(dir);
  writeFileSync(join(dir, 'cat'), '#!/usr/bin/env bash\nexit 1\n');
  chmodSync(join(dir, 'cat'), 0o755);
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(sha), {
    BRAIN_KIT_LEAK_PATTERNS: patterns,
    PATH: `${dir}:${process.env.PATH}`,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /could not hand the scan work list to the scanner/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
});

test('the enumeration refuses, with 2, arguments that are not a remote name and a URL', () => {
  // push-gate never calls it that way; this pins the enumeration's own
  // guard for whatever calls it next.
  const { work } = setup();
  const script = join(KIT_ROOT, 'src', 'push', 'records.sh');
  for (const args of [[], ['origin'], ['', 'url'], ['origin', 'url', 'extra']]) {
    const r = spawnSync('bash', [script, ...args], { cwd: work, input: '', encoding: 'utf8' });
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stderr}`);
    assert.match(r.stderr, /expects exactly two arguments/);
    assert.equal(r.stdout, '');
  }
});

// Drives runPushGate in a process of its own, with the two options the
// command line never passes, to reach a signal and an overflow.
function driveWith(root, work, patterns, options, input) {
  const driver = join(root, 'push-gate-driver.mjs');
  writeFileSync(driver, [
    `import { runPushGate } from ${JSON.stringify(join(KIT_ROOT, 'src', 'commands', 'push-gate.mjs'))};`,
    `import { createTranslator } from ${JSON.stringify(join(KIT_ROOT, 'src', 'lang.mjs'))};`,
    'const io = {',
    '  stdin: process.stdin,',
    '  stdout: { write: (text) => process.stdout.write(text) },',
    '  stderr: { write: (text) => process.stderr.write(text) },',
    '};',
    'const options = JSON.parse(process.env.PUSH_GATE_TEST_OPTIONS);',
    "const status = await runPushGate(['origin', 'origin', '--patterns', 'personal'], io, createTranslator('en'), options);",
    'process.stdout.write(`STATUS:${status}\\n`);',
    '',
  ].join('\n'));
  return spawnSync(process.execPath, [driver], {
    cwd: work,
    input,
    encoding: 'utf8',
    timeout: 20000,
    // The fixture's own list, always: without it the scan would load the
    // default personal list of whoever runs the suite.
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns, PUSH_GATE_TEST_OPTIONS: JSON.stringify(options) },
  });
}

// Clean reference records numbered 1..count (22 bytes each while the
// number is one digit): a stream that parses perfectly and matches
// nothing. `lines` reference lines go on standard input to match, so the
// reference count check is satisfied and only what a test aims at refuses.
function cleanStreamScript(root, name, count, tail) {
  const script = join(root, name);
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'cat > /dev/null',
    `for i in $(seq 1 ${count}); do printf 'ref\\000%s\\000refs/heads/main\\000' "$i"; done`,
    tail,
    '',
  ].join('\n'));
  return script;
}

function lines(count) {
  return 'x\n'.repeat(count);
}

test('an enumeration that writes a clean stream and exits non-zero is refused on its status alone', () => {
  const { root, work, patterns } = setup();
  const script = cleanStreamScript(root, 'clean-then-fail.sh', 3, 'exit 3');
  const r = driveWith(root, work, patterns, { recordsScript: script }, lines(3));
  assert.match(r.stderr, /the push enumeration exited 3/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
  assert.match(r.stdout, /STATUS:1/);
  // The same stream with exit 0 is accepted, so the refusal above is the
  // status and nothing else.
  const ok = driveWith(root, work, patterns, { recordsScript: cleanStreamScript(root, 'clean.sh', 3, 'exit 0') }, lines(3));
  assert.match(ok.stdout, /STATUS:0/, ok.stderr);
  assert.match(ok.stderr, /leak gate ran: scanned 3 channel\(s\) across 3 reference\(s\)/);
});

test('an enumeration stopped by a signal is refused and the signal is named', () => {
  const { root, work, patterns } = setup();
  const script = cleanStreamScript(root, 'killed.sh', 3, 'kill -KILL $$');
  const r = driveWith(root, work, patterns, { recordsScript: script }, lines(3));
  assert.match(r.stderr, /stopped by signal SIGKILL/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
  assert.match(r.stdout, /STATUS:1/);
});

test('a stream larger than the bound is refused as too large, never scanned as the prefix that fit', () => {
  // The bound is two whole records and two lines go in, so what fits is
  // itself a stream that parses, counts right and scans clean: only the
  // overflow check stands between it and exit 0.
  const { root, work, patterns } = setup();
  const script = cleanStreamScript(root, 'large.sh', 50, 'exit 0');
  const r = driveWith(root, work, patterns, { recordsScript: script, maxStreamBytes: 44 }, lines(2));
  assert.match(r.stderr, /listed more than 44 bytes of records/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
  assert.match(r.stdout, /STATUS:1/);
});

test('messages larger than the bound are refused as messages, not reported as records', () => {
  const { root, work, patterns } = setup();
  const script = join(root, 'noisy.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'cat > /dev/null',
    "for i in $(seq 1 50); do echo 'a message about this push' >&2; done",
    "printf 'ref\\0001\\000refs/heads/main\\000'",
    'exit 0',
    '',
  ].join('\n'));
  const r = driveWith(root, work, patterns, { recordsScript: script, maxStreamBytes: 200 }, lines(1));
  assert.match(r.stderr, /wrote more than 200 bytes of messages/);
  assert.doesNotMatch(r.stderr, /bytes of records/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
  assert.match(r.stdout, /STATUS:1/);
});

// --- the stream must answer for every reference git sent ------------------

test('an enumeration that lists fewer references than git sent is refused, naming both counts', () => {
  const { root, work, patterns } = setup();
  const script = cleanStreamScript(root, 'short.sh', 1, 'exit 0');
  const r = driveWith(root, work, patterns, { recordsScript: script }, lines(2));
  assert.match(r.stderr, /git sent 2 reference line\(s\) for this push and the push enumeration listed 1 reference\(s\)/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
  assert.match(r.stdout, /STATUS:1/);
  // And more than git sent is refused the same way.
  const long = driveWith(root, work, patterns, { recordsScript: cleanStreamScript(root, 'long.sh', 3, 'exit 0') }, lines(2));
  assert.match(long.stderr, /git sent 2 reference line\(s\) .* listed 3 reference\(s\)/);
  assert.match(long.stdout, /STATUS:1/);
});

test('references that are not numbered 1..n in order are refused', () => {
  const { root, work, patterns } = setup();
  const script = join(root, 'misnumbered.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'cat > /dev/null',
    "printf 'ref\\0001\\000refs/heads/main\\000ref\\0001\\000refs/heads/main\\000'",
    'exit 0',
    '',
  ].join('\n'));
  const r = driveWith(root, work, patterns, { recordsScript: script }, lines(2));
  assert.match(r.stderr, /did not number its references 1 to 2, in the order git sent them/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
  assert.match(r.stdout, /STATUS:1/);
});

test('a stream that does not parse is refused by the scanner, with its own reason, not counted as a mismatch', () => {
  const { root, work, patterns } = setup();
  const script = join(root, 'malformed.sh');
  writeFileSync(script, ['#!/usr/bin/env bash', 'cat > /dev/null', "printf 'bogus\\000'", 'exit 0', ''].join('\n'));
  const r = driveWith(root, work, patterns, { recordsScript: script }, lines(1));
  assert.match(r.stderr, /record of an unknown kind/);
  assert.doesNotMatch(r.stderr, /reference line\(s\)/);
  assert.match(r.stdout, /STATUS:1/);
});

test('reference lines are counted the way the enumeration reads them', async () => {
  const { countReferenceLines } = await import('../src/commands/push-gate.mjs');
  assert.equal(countReferenceLines(Buffer.from('')), 0);
  assert.equal(countReferenceLines(Buffer.from('a b c d\n')), 1);
  assert.equal(countReferenceLines(Buffer.from('a b c d\ne f g h\n')), 2);
  // An unterminated last line is read, and counted.
  assert.equal(countReferenceLines(Buffer.from('a b c d\ne f g h')), 2);
  // A blank line is a line the loop runs for (and the scanner refuses).
  assert.equal(countReferenceLines(Buffer.from('\n')), 1);
  // An unterminated tail of blanks leaves the first field empty: not read.
  assert.equal(countReferenceLines(Buffer.from('a b c d\n \t ')), 1);
});

test('an installed enumeration emptied to zero bytes can no longer let a leak land', () => {
  // The reviewer's case: bash runs an empty file and exits 0, the hook's
  // presence check passes, and the stream lists nothing at all.
  const { root, work, bare, patterns } = setup();
  const { installed, gateDir } = installGate(root, work);
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');
  truncateSync(join(gateDir, 'engine', 'src', 'push', 'records.sh'), 0);
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /git sent 1 reference line\(s\) for this push and the push enumeration listed 0 reference\(s\)/);
  assert.equal(spawnSync('git', ['--git-dir', bare, 'rev-parse', '-q', '--verify', 'refs/heads/main']).status, 1);
});

// --- git itself -------------------------------------------------------------

test('a git stopped by a signal is not reported as "not a repository"', () => {
  const { root, work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const dir = join(root, 'shims-killed-git');
  mkdirSync(dir);
  writeFileSync(join(dir, 'git'), [
    '#!/usr/bin/env bash',
    'if [ "$1" = rev-parse ] && [ "$2" = --git-dir ]; then kill -KILL $$; fi',
    `exec ${JSON.stringify(real)} "$@"`,
    '',
  ].join('\n'));
  chmodSync(join(dir, 'git'), 0o755);
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(sha), {
    BRAIN_KIT_LEAK_PATTERNS: patterns,
    PATH: `${dir}:${process.env.PATH}`,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /git was stopped by signal SIGKILL/);
  assert.doesNotMatch(r.stderr, /not inside a git repository/);
});

// --- the scanner, factored: the batch option still reaches it -------------

test('the metadata batch reaches the scanner: one git call per commit at a batch of one, and at zero', () => {
  // The companion to the zero-batch test in test/pre-push-hook.test.mjs,
  // which proves the loop terminates but would pass just as well if the
  // option were dropped on the way in and the default batch used. Here the
  // batch is OBSERVED: a git on PATH counts the metadata reads.
  const { root, work, patterns } = setup();
  const shas = [
    commit(work, 'a.md', 'nothing secret here\n', 'a'),
    commit(work, 'b.md', 'nothing secret here\n', 'b'),
    commit(work, 'c.md', 'nothing secret here\n', 'c'),
  ];
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const dir = join(root, 'shims-counting-git');
  mkdirSync(dir);
  const log = join(root, 'batches.log');
  writeFileSync(join(dir, 'git'), [
    '#!/usr/bin/env bash',
    'if [ "$2" = cat-file ] && [ "$3" = --batch ]; then echo batch >> "$BATCH_LOG"; fi',
    `exec ${JSON.stringify(real)} "$@"`,
    '',
  ].join('\n'));
  chmodSync(join(dir, 'git'), 0o755);
  const driver = join(root, 'batch-driver.mjs');
  writeFileSync(driver, [
    `import { runScanBlobs } from ${JSON.stringify(join(KIT_ROOT, 'src', 'commands', 'scan-blobs.mjs'))};`,
    'const io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };',
    'const batch = JSON.parse(process.env.BATCH);',
    'const status = await runScanBlobs([], io, batch === null ? {} : { metadataBatch: batch });',
    'process.stdout.write(`STATUS:${status}\\n`);',
    '',
  ].join('\n'));
  const NUL = String.fromCharCode(0);
  const input = shas.map((sha) => `commit${NUL}${sha}${NUL}`).join('');
  for (const [batch, calls] of [[1, 3], [0, 3], [null, 1]]) {
    rmSync(log, { force: true });
    const r = spawnSync(process.execPath, [driver], {
      cwd: work,
      input,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns, BATCH: JSON.stringify(batch), BATCH_LOG: log, PATH: `${dir}:${process.env.PATH}` },
    });
    assert.match(r.stdout, /STATUS:0/, r.stderr);
    const seen = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
    assert.equal(seen, calls, `batch ${batch}: ${seen} metadata read(s)`);
  }
});

// --- staleness: the enumeration is compared too ---------------------------

test('in the checkout the gate is maintained in, an uncommitted edit to src/push/records.sh makes the snapshot stale', () => {
  // The enumeration used to live inside .githooks/pre-push, whose byte
  // comparison therefore covered it. It is compared on its own now.
  const { root, patterns } = setup();
  const bare = join(root, 'self.git');
  const work = join(root, 'self');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  mkdirSync(join(work, '.githooks'), { recursive: true });
  copyFileSync(join(KIT_ROOT, '.githooks', 'pre-push'), join(work, '.githooks', 'pre-push'));
  copyFileSync(join(KIT_ROOT, '.githooks', 'install-gate'), join(work, '.githooks', 'install-gate'));
  chmodSync(join(work, '.githooks', 'install-gate'), 0o755);
  for (const dir of ['bin', 'src', 'lang', 'schema']) cpSync(join(KIT_ROOT, dir), join(work, dir), { recursive: true });
  copyFileSync(join(KIT_ROOT, 'package.json'), join(work, 'package.json'));
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  assert.equal(git(work, ['remote', 'add', 'origin', bare]).status, 0);
  assert.equal(git(work, ['add', '-A']).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'a brain-kit checkout']).status, 0);
  const installed = spawnSync(join(work, '.githooks', 'install-gate'), [], { cwd: work, encoding: 'utf8' });
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  // The control: nothing changed, nothing announced.
  const quiet = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /gate engine snapshot/);
  // HEAD is still the commit the stamp names and the hook file is
  // untouched, so the edit below is the only signal left.
  appendFileSync(join(work, 'src', 'push', 'records.sh'), '# an uncommitted edit\n');
  const noisy = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(noisy.status, 0, noisy.stderr);
  assert.match(noisy.stderr, /gate engine snapshot: installed /);
  assert.match(noisy.stderr, /refresh it with: /);
});

// --- the destination the push goes to, not the fetch url ------------------

// A remote whose FETCH url already holds a branch carrying a match (a
// private mirror, typically) and whose push goes somewhere that does not.
// The branch is new at the destination, so everything on it is new there,
// and every commit of it must be scanned. The gate is the real installed
// one, pushed through for real.
function setupDivergentRemote() {
  const { root, work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['checkout', '-q', '-b', 'leaky']).status, 0);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');
  assert.equal(git(work, ['checkout', '-q', 'main']).status, 0);
  // The fetch url is seeded by cloning, not by pushing: a push would go
  // through the gate, which is the thing under test.
  const fetchUrl = join(root, 'fetch.git');
  assert.equal(spawnSync('git', ['clone', '-q', '--bare', work, fetchUrl]).status, 0);
  const destination = join(root, 'destination.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', destination]).status, 0);
  assert.equal(git(work, ['remote', 'set-url', 'origin', fetchUrl]).status, 0);
  const { installed } = installGate(root, work);
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  return { root, work, patterns, fetchUrl, destination };
}

function landed(bare, ref) {
  return spawnSync('git', ['--git-dir', bare, 'rev-parse', '-q', '--verify', ref], { encoding: 'utf8' }).status === 0;
}

test('a pushurl that differs from the fetch url: the branch is scanned against the destination and refused', () => {
  const { work, patterns, destination } = setupDivergentRemote();
  assert.equal(git(work, ['config', 'remote.origin.pushurl', destination]).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'leaky'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.equal(landed(destination, 'refs/heads/leaky'), false);
});

test('a second url: the push to it is scanned against it, not against the first, and refused', () => {
  // git runs the hook once per url. The first already has the branch, so
  // git reports nothing to update there; the second does not.
  const { work, patterns, fetchUrl, destination } = setupDivergentRemote();
  assert.equal(git(work, ['remote', 'set-url', '--add', 'origin', destination]).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'leaky'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.equal(landed(destination, 'refs/heads/leaky'), false);
  assert.equal(landed(fetchUrl, 'refs/heads/leaky'), true);
});

test('a pushInsteadOf rewrite: the push is scanned against the rewritten destination and refused', () => {
  const { work, patterns, fetchUrl, destination } = setupDivergentRemote();
  assert.equal(git(work, ['config', `url.${destination}.pushInsteadOf`, fetchUrl]).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'leaky'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.equal(landed(destination, 'refs/heads/leaky'), false);
});

test('the mirror idiom (insteadOf to a mirror, identity pushInsteadOf upstream) is scanned in full and refused', () => {
  // git pushes upstream and hands the hook upstream's url; ls-remote would
  // rewrite that url to the mirror again, and the mirror holds the branch.
  const { work, patterns, fetchUrl: mirror, destination: upstream } = setupDivergentRemote();
  assert.equal(git(work, ['remote', 'set-url', 'origin', upstream]).status, 0);
  assert.equal(git(work, ['config', `url.${mirror}.insteadOf`, upstream]).status, 0);
  assert.equal(git(work, ['config', `url.${upstream}.pushInsteadOf`, upstream]).status, 0);
  // The precondition, measured: asked, ls-remote would go to the mirror.
  assert.equal(git(work, ['ls-remote', '--get-url', upstream]).stdout.trim(), mirror);
  const r = git(work, ['push', '-q', 'origin', 'leaky'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /is rewritten by a url\.<base>\.insteadOf rule when it is asked what it holds/);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.equal(landed(upstream, 'refs/heads/leaky'), false);
  // A clean branch through the same idiom still goes, after a full scan.
  assert.equal(git(work, ['checkout', '-q', '-b', 'tidy', 'main']).status, 0);
  commit(work, 'tidy.md', 'nothing secret here\n', 'tidy');
  const ok = git(work, ['push', '-q', 'origin', 'tidy'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(landed(upstream, 'refs/heads/tidy'), true);
});

test('a chained rewrite (a pushurl mapped to a url that a second insteadOf maps elsewhere) is scanned in full and refused', () => {
  const { root, work, patterns, fetchUrl, destination } = setupDivergentRemote();
  const alias = join(root, 'alias.git');
  assert.equal(git(work, ['config', 'remote.origin.pushurl', alias]).status, 0);
  assert.equal(git(work, ['config', `url.${destination}.insteadOf`, alias]).status, 0);
  assert.equal(git(work, ['config', `url.${fetchUrl}.insteadOf`, destination]).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'leaky'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.equal(landed(destination, 'refs/heads/leaky'), false);
});

test('with no url given, the remote is asked by its name, as it always was', () => {
  // A hook always receives a url; this is the fallback for a caller that
  // passes none. origin already holds a matching commit on main, and a new
  // branch adds one clean commit on top: asked by name, origin's main is
  // excluded and only the new commit is scanned.
  // The remote is NOT called origin, and origin is an empty repository, so
  // asking the wrong name would find nothing to exclude.
  const { root, work, patterns } = setup();
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');
  const seeded = join(root, 'seeded.git');
  assert.equal(spawnSync('git', ['clone', '-q', '--bare', work, seeded]).status, 0);
  assert.equal(git(work, ['remote', 'add', 'mirror', seeded]).status, 0);
  assert.equal(git(work, ['checkout', '-q', '-b', 'feature']).status, 0);
  const sha = commit(work, 'README.md', 'hello world\n', 'later');
  const line = `refs/heads/feature ${sha} refs/heads/feature ${ZERO}\n`;
  const r = pushGate(work, ['mirror', '', '--patterns', 'personal'], line, { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /could not query remote/);
});

test('the hook hands the enumeration the remote NAME git gave it, which is the one its messages use', () => {
  // Invoked directly, as git would, with a url the enumeration cannot ask:
  // git itself only runs the hook once it has reached the destination. The
  // enumeration says so naming the remote it was given, and scans
  // everything.
  const { root, work, patterns } = setup();
  const { installed, gateDir } = installGate(root, work);
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const r = spawnSync(join(gateDir, 'pre-push'), ['mirror', join(root, 'no such remote.git')], {
    cwd: work,
    input: refLine(sha),
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /could not query remote 'mirror' \(git ls-remote failed\)/);
  assert.match(r.stderr, /leak gate ran/);
});

// --- the installed gate, and where the enumeration is read from ----------

// Builds a brain-kit checkout from this one and runs its real installer in
// `work`, exactly as test/pre-push-hook.test.mjs does, so what is pushed
// through below is the installed gate and not an imitation of it.
function installGate(root, work, { mutateKit = () => {} } = {}) {
  const kit = join(root, 'kit');
  mkdirSync(join(kit, '.githooks'), { recursive: true });
  copyFileSync(join(KIT_ROOT, '.githooks', 'pre-push'), join(kit, '.githooks', 'pre-push'));
  copyFileSync(join(KIT_ROOT, '.githooks', 'install-gate'), join(kit, '.githooks', 'install-gate'));
  chmodSync(join(kit, '.githooks', 'install-gate'), 0o755);
  for (const dir of ['bin', 'src', 'lang', 'schema']) {
    cpSync(join(KIT_ROOT, dir), join(kit, dir), { recursive: true });
  }
  copyFileSync(join(KIT_ROOT, 'package.json'), join(kit, 'package.json'));
  mutateKit(kit);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', kit]).status, 0);
  assert.equal(git(kit, ['add', '-A']).status, 0);
  assert.equal(git(kit, ['commit', '-q', '-m', 'a brain-kit checkout']).status, 0);
  const installed = spawnSync(join(kit, '.githooks', 'install-gate'), [], { cwd: work, encoding: 'utf8' });
  return { kit, installed, gateDir: join(work, '.git', 'brain-kit-gate') };
}

const TOOTHLESS_RECORDS = [
  '#!/usr/bin/env bash',
  '# A deliberately toothless enumeration: it lists nothing and succeeds.',
  'cat > /dev/null',
  'exit 0',
  '',
].join('\n');

test('a push carrying its own toothless src/push/records.sh is still refused: the gate runs the snapshot copy', () => {
  // THE TRUST BOUNDARY. The enumeration decides what is scanned at all, so
  // whoever writes the copy the gate runs decides what passes. A branch
  // that rewrites src/push/records.sh to list nothing, committed AND left
  // in the working tree, must change nothing: the installed gate runs the
  // copy in its own snapshot, under the git directory, which no commit
  // and no checkout can reach.
  const { root, work, patterns } = setup();
  const { installed } = installGate(root, work);
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);

  mkdirSync(join(work, 'src', 'push'), { recursive: true });
  commit(work, join('src', 'push', 'records.sh'), TOOTHLESS_RECORDS, 'an enumeration that lists nothing');
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');

  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  // The toothless copy really is in the pushed tip and in the tree, so the
  // refusal above is not the absence of the file it was meant to test.
  assert.equal(git(work, ['show', 'HEAD~1:src/push/records.sh']).stdout, TOOTHLESS_RECORDS);
});

const GATE_FILES = [['src', 'push', 'records.sh'], ['src', 'commands', 'push-gate.mjs']];

test('an installed gate whose snapshot has lost the enumeration or push-gate refuses and names the file', () => {
  for (const parts of GATE_FILES) {
    const { root, work, patterns } = setup();
    const { installed, gateDir } = installGate(root, work);
    assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
    commit(work, 'README.md', 'hello world\n', 'init');
    rmSync(join(gateDir, 'engine', ...parts));
    const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
    assert.notEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`engine snapshot is incomplete \\(.*${parts.join('/').replace(/\./g, '\\.')} is missing\\)`));
  }
});

test('the installer refuses a checkout without the enumeration or push-gate, and leaves no gate behind', () => {
  for (const parts of GATE_FILES) {
    const { root, work } = setup();
    const { installed, gateDir } = installGate(root, work, {
      mutateKit: (kit) => rmSync(join(kit, ...parts)),
    });
    assert.equal(installed.status, 1, `${installed.stdout}${installed.stderr}`);
    assert.match(installed.stderr, new RegExp(`the engine snapshot has no ${parts.join('/').replace(/\./g, '\\.')} in it`));
    assert.equal(existsSync(gateDir), false);
  }
});
