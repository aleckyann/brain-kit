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

// Reference lines whose destination is the one the scripts list.
function lines(count) {
  return `refs/heads/main ${ZERO} refs/heads/main ${ZERO}\n`.repeat(count);
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

test('a gap in the numbering balanced by an extra reference (1 and 3 for two lines) is refused', () => {
  const { root, work, patterns } = setup();
  const script = join(root, 'gapped.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'cat > /dev/null',
    "printf 'ref\\0001\\000refs/heads/main\\000ref\\0003\\000refs/heads/main\\000'",
    'exit 0',
    '',
  ].join('\n'));
  const r = driveWith(root, work, patterns, { recordsScript: script }, lines(2));
  assert.match(r.stderr, /did not number its references 1 to 2/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
  assert.match(r.stdout, /STATUS:1/);
});

test('a standard input that fails part way is refused, not read as the push', () => {
  // Driven in process, with a stream that delivers one clean reference line
  // and then fails: what arrived is a prefix, and a prefix scans clean.
  const { root, work, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const driver = join(root, 'broken-stdin-driver.mjs');
  writeFileSync(driver, [
    "import { PassThrough } from 'node:stream';",
    `import { runPushGate } from ${JSON.stringify(join(KIT_ROOT, 'src', 'commands', 'push-gate.mjs'))};`,
    `import { createTranslator } from ${JSON.stringify(join(KIT_ROOT, 'src', 'lang.mjs'))};`,
    'const stdin = new PassThrough();',
    'const io = { stdin, stdout: process.stdout, stderr: process.stderr };',
    `setImmediate(() => { stdin.write(${JSON.stringify(refLine(sha))}); setImmediate(() => stdin.destroy(new Error('the pipe broke'))); });`,
    "const status = await runPushGate(['origin', 'origin', '--patterns', 'personal'], io, createTranslator('en'));",
    'process.stdout.write(`STATUS:${status}\\n`);',
    '',
  ].join('\n'));
  const r = spawnSync(process.execPath, [driver], { cwd: work, encoding: 'utf8', timeout: 20000, env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns } });
  assert.match(r.stderr, /could not be read to the end \(the pipe broke\)/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
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
  // The verdict, not the sentence: an empty script exits without reading
  // its standard input, so push-gate's write to it may meet EPIPE and
  // refuse as "could not run the push enumeration" before the count
  // mismatch is ever reached. Either way it refuses and nothing lands.
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /git sent 1 reference line\(s\) for this push and the push enumeration listed 0 reference\(s\)|could not run the push enumeration/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
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

// A url beginning with a dash cannot reach a hook through git 2.55, which
// refuses it first, and push-gate refuses an argument beginning with `--`
// as an unknown flag. The enumeration is run directly here, the way
// another caller could run it. Without `--` before the url, ls-remote
// reads it as an option.
test('the enumeration never runs a url that looks like --upload-pack=<command>', () => {
  const { work, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const marker = join(makeTempDir('brain-kit-dash-'), 'ran');
  const url = `--upload-pack=touch ${marker}`;
  const r = spawnSync('bash', [join(KIT_ROOT, 'src', 'push', 'records.sh'), 'origin', url], {
    cwd: work,
    input: refLine(sha),
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(marker), false, 'ls-remote ran the url as a command');
  assert.match(r.stderr, /could not query remote 'origin' \(git ls-remote failed\)/);
});

test('a url that looks like -q is not answered for the default remote', () => {
  // origin already holds a matching commit on main; a new branch adds one
  // clean commit on top. Asked about `-q` without `--`, ls-remote answers
  // for origin, main is excluded, and the matching commit is never read.
  // The push is not going to origin, so everything must be scanned.
  const { root, work, patterns } = setup();
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');
  const seeded = join(root, 'seeded.git');
  assert.equal(spawnSync('git', ['clone', '-q', '--bare', work, seeded]).status, 0);
  assert.equal(git(work, ['remote', 'set-url', 'origin', seeded]).status, 0);
  assert.equal(git(work, ['checkout', '-q', '-b', 'feature']).status, 0);
  const sha = commit(work, 'README.md', 'hello world\n', 'later');
  const line = `refs/heads/feature ${sha} refs/heads/feature ${ZERO}\n`;
  const r = pushGate(work, ['origin', '-q', '--patterns', 'personal'], line, { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /could not query remote 'origin' \(git ls-remote failed\)/);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
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

// --- a source expression with a space in it -------------------------------

// git writes the source expression of a push exactly as typed, spaces
// included, as the first field of the reference line. A gate reading the
// line from the left took the second word of it for the pushed commit.
function setupSpaced() {
  const { root, work, bare, patterns } = setup();
  const { installed } = installGate(root, work);
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  return { root, work, bare, patterns };
}

test('a source expression with a space (:/wip main) is scanned as the commit it names, and refused', () => {
  const { work, bare, patterns } = setupSpaced();
  assert.equal(git(work, ['checkout', '-q', '-b', 'side']).status, 0);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'wip main notes');
  assert.equal(git(work, ['checkout', '-q', 'main']).status, 0);
  const r = git(work, ['push', '-q', 'origin', ':/wip main:refs/heads/tidy'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.equal(landed(bare, 'refs/heads/tidy'), false);
});

test('behind a spaced source expression, a destination name that matches is refused and never printed', () => {
  const { work, bare, patterns } = setupSpaced();
  assert.equal(git(work, ['checkout', '-q', '-b', 'side']).status, 0);
  commit(work, 'tidy.md', 'nothing secret here\n', 'wip main notes');
  assert.equal(git(work, ['checkout', '-q', 'main']).status, 0);
  const r = git(work, ['push', '-q', 'origin', ':/wip main:refs/heads/hunter2corp'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /possible leak in the destination name of reference #1 of this push \(REFERENCE NAME/);
  // git itself names the ref it failed to push; every line the GATE wrote
  // (they all begin pre-push:) withholds it.
  const gateLines = r.stderr.split('\n').filter((line) => line.startsWith('pre-push:') || line.startsWith('brain-kit'));
  assert.ok(gateLines.length > 0, r.stderr);
  for (const line of gateLines) assert.doesNotMatch(line, /hunter2corp/i);
  assert.equal(landed(bare, 'refs/heads/hunter2corp'), false);
});

test('ordinary spaced source expressions still push when clean', () => {
  const { work, bare, patterns } = setupSpaced();
  assert.equal(git(work, ['checkout', '-q', '-b', 'side']).status, 0);
  commit(work, 'tidy.md', 'nothing secret here\n', 'wip main notes');
  assert.equal(git(work, ['checkout', '-q', 'main']).status, 0);
  const found = git(work, ['push', '-q', 'origin', ':/wip main:refs/heads/copy'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(landed(bare, 'refs/heads/copy'), true);
  const dated = git(work, ['push', '-q', 'origin', 'main@{0 minutes ago}:refs/heads/dated'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(dated.status, 0, dated.stderr);
  assert.equal(landed(bare, 'refs/heads/dated'), true);
});

test('a reference line whose object ids are not object ids is refused without being printed', () => {
  const { work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  for (const line of [
    `refs/heads/x hunter2corp refs/heads/y ${ZERO}\n`,
    `refs/heads/x ${sha} refs/heads/y ${'0'.repeat(39)}\n`,
    `refs/heads/x ${sha.toUpperCase()} refs/heads/y ${ZERO}\n`,
    `refs/heads/x ${sha} refs/heads/y\n`,
    'refs/heads/x hunter2corp\n',
  ]) {
    const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], line, { BRAIN_KIT_LEAK_PATTERNS: patterns });
    assert.equal(r.status, 1, `${line}: ${r.stderr}`);
    assert.match(r.stderr, /reference #1 of this push is not a line git would write/, line);
    assert.doesNotMatch(r.stderr, /hunter2corp/i);
  }
  // A 64-character id, the length a SHA-256 repository writes, is an id.
  const long = pushGate(work, ['origin', bare, '--patterns', 'personal'], `refs/heads/x ${'a'.repeat(64)} refs/heads/y ${ZERO}\n`, { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.doesNotMatch(long.stderr, /not a line git would write/);
});

test('push-gate refuses a stream whose reference name is not the destination git sent on that line', () => {
  const { root, work, patterns } = setup();
  const script = join(root, 'renamed.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'cat > /dev/null',
    "printf 'ref\\0001\\000refs/heads/other\\000'",
    'exit 0',
    '',
  ].join('\n'));
  const r = driveWith(root, work, patterns, { recordsScript: script }, lines(1));
  assert.match(r.stderr, /destination name the push enumeration listed for reference #1 of this push is not the one git sent/);
  assert.doesNotMatch(r.stderr, /refs\/heads\/other|leak gate ran/);
  assert.match(r.stdout, /STATUS:1/);
});

test('push-gate reads a spaced source expression from the right, the way the enumeration does', () => {
  const { work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'wip main');
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], `:/wip main ${sha} refs/heads/copy ${ZERO}\n`, { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /leak gate ran: .* across 1 reference\(s\)/);
});

test('an unterminated tail of blanks is not a reference, to the enumeration or to push-gate', () => {
  const { work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], `refs/heads/main ${sha} refs/heads/main ${ZERO}\n \t `, { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /across 1 reference\(s\)/);
});

test('destination names are read from each line as the enumeration reads them', async () => {
  const { referenceDestinations } = await import('../src/commands/push-gate.mjs');
  const z = ZERO;
  assert.deepEqual(referenceDestinations(Buffer.from(`refs/heads/a ${z} refs/heads/b ${z}\n`)), ['refs/heads/b']);
  assert.deepEqual(referenceDestinations(Buffer.from(`:/wip main now ${z} refs/heads/c ${z}\n`)), ['refs/heads/c']);
  // Truncated lines: split on blanks, the third field or nothing.
  assert.deepEqual(referenceDestinations(Buffer.from(`refs/heads/x ${z}`)), ['']);
  assert.deepEqual(referenceDestinations(Buffer.from('a\tb\tc\n')), ['c']);
  assert.deepEqual(referenceDestinations(Buffer.from(`a b c ${z}\nd e f ${z}`)), ['c', 'f']);
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

// --- before a second caller: standard input, the zero id, a url's token ---
//
// The gate an adopting vault installs calls this command too
// (templates/githooks/pre-push). These are the clauses a second caller
// starts to lean on, each pinned by the case that lands a leak without it.

test('a standard input that arrives in more than one chunk is read whole: the matching reference last is refused', () => {
  // In process, with a stream of exactly two chunks: a clean deletion line,
  // then a deletion line whose destination name matches. Keeping only the
  // first chunk is a push of one clean reference, which parses, counts and
  // scans perfectly.
  const { root, work, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const driver = join(root, 'two-chunk-driver.mjs');
  writeFileSync(driver, [
    "import { Readable } from 'node:stream';",
    "import { Buffer } from 'node:buffer';",
    `import { runPushGate } from ${JSON.stringify(join(KIT_ROOT, 'src', 'commands', 'push-gate.mjs'))};`,
    `import { createTranslator } from ${JSON.stringify(join(KIT_ROOT, 'src', 'lang.mjs'))};`,
    `const chunks = [Buffer.from(${JSON.stringify(`(delete) ${ZERO} refs/heads/tidy ${sha}\n`)}), Buffer.from(${JSON.stringify(`(delete) ${ZERO} refs/heads/hunter2corp ${sha}\n`)})];`,
    'const stdin = Readable.from(chunks, { objectMode: false });',
    'let seen = 0;',
    "stdin.on('data', () => { seen += 1; });",
    'const io = { stdin, stdout: process.stdout, stderr: process.stderr };',
    "const status = await runPushGate(['origin', 'origin', '--patterns', 'personal'], io, createTranslator('en'));",
    'process.stdout.write(`CHUNKS:${seen}\\nSTATUS:${status}\\n`);',
    '',
  ].join('\n'));
  const r = spawnSync(process.execPath, [driver], { cwd: work, encoding: 'utf8', timeout: 20000, env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns } });
  // The precondition: the stream really did deliver two chunks.
  assert.match(r.stdout, /CHUNKS:2/, r.stderr);
  assert.match(r.stdout, /STATUS:1/, r.stderr);
  assert.match(r.stderr, /possible leak in the destination name of reference #2 of this push \(REFERENCE NAME/);
});

test('a standard input larger than one pipe read is read whole: the 1500th reference is still scanned', () => {
  // The same, through the real process and a real pipe, where node reads
  // at most 64 KiB at a time. Deletion lines keep it cheap: each is a
  // destination name and nothing else.
  const { work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const lines = [];
  for (let i = 1; i < 1500; i += 1) lines.push(`(delete) ${ZERO} refs/heads/tidy-${String(i).padStart(4, '0')} ${sha}\n`);
  lines.push(`(delete) ${ZERO} refs/heads/late-hunter2corp ${sha}\n`);
  const input = lines.join('');
  assert.ok(Buffer.byteLength(input) > 2 * 64 * 1024, 'the input must span more than one pipe read');
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], input, { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 1, r.stderr.slice(-2000));
  assert.match(r.stderr, /possible leak in the destination name of reference #1500 of this push \(REFERENCE NAME/);
});

test('a standard input that closes without ending or failing is refused, even by a caller that does not wait at top level', () => {
  // The promise is awaited inside a function here, not at the top level of
  // a module: left pending, node would simply exit 0 with no STATUS line.
  const { root, work, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const driver = join(root, 'closed-stdin-driver.mjs');
  writeFileSync(driver, [
    "import { PassThrough } from 'node:stream';",
    `import { runPushGate } from ${JSON.stringify(join(KIT_ROOT, 'src', 'commands', 'push-gate.mjs'))};`,
    `import { createTranslator } from ${JSON.stringify(join(KIT_ROOT, 'src', 'lang.mjs'))};`,
    'const stdin = new PassThrough();',
    'const io = { stdin, stdout: process.stdout, stderr: process.stderr };',
    `setImmediate(() => { stdin.write(${JSON.stringify(refLine(sha))}); setImmediate(() => stdin.destroy()); });`,
    "runPushGate(['origin', 'origin', '--patterns', 'personal'], io, createTranslator('en'))",
    '  .then((status) => { process.stdout.write(`STATUS:${status}\\n`); });',
    '',
  ].join('\n'));
  const r = spawnSync(process.execPath, [driver], { cwd: work, encoding: 'utf8', timeout: 20000, env: { ...process.env, BRAIN_KIT_LEAK_PATTERNS: patterns } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /STATUS:1/, r.stderr);
  assert.match(r.stderr, /could not be read to the end \(the stream closed before it ended\)/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
});

test('the mirror idiom pushed BY URL is scanned in full and refused, like the same push by remote name', () => {
  // git hands the hook the url as typed for its name, and the same url as
  // the destination: the two arguments are equal, which no push by name
  // produces.
  const { work, patterns, fetchUrl: mirror, destination: upstream } = setupDivergentRemote();
  assert.equal(git(work, ['config', `url.${mirror}.insteadOf`, upstream]).status, 0);
  assert.equal(git(work, ['config', `url.${upstream}.pushInsteadOf`, upstream]).status, 0);
  assert.equal(git(work, ['ls-remote', '--get-url', upstream]).stdout.trim(), mirror);
  const r = git(work, ['push', '-q', upstream, 'leaky'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /is rewritten by a url\.<base>\.insteadOf rule when it is asked what it holds/);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.equal(landed(upstream, 'refs/heads/leaky'), false);
});

// A repository using SHA-256 writes its all-zeros id with 64 characters.
function setupSha256() {
  const root = join(makeTempDir('brain-kit-push-gate-sha256-'), AWKWARD_DIR);
  mkdirSync(root, { recursive: true });
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', '--object-format=sha256', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', '--object-format=sha256', work]).status, 0);
  assert.equal(git(work, ['remote', 'add', 'origin', bare]).status, 0);
  const patterns = join(root, 'patterns.txt');
  writeFileSync(patterns, 'hunter2corp\n');
  const { installed } = installGate(root, work);
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  return { root, work, bare, patterns };
}

test('in a SHA-256 repository a new ref is asked of the remote, not scanned as an update from an unknown commit', () => {
  const { work, bare, patterns } = setupSha256();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['rev-parse', 'HEAD']).stdout.trim().length, 64, 'the precondition: a SHA-256 repository');
  const first = git(work, ['push', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stderr, /unknown to this clone/);
  assert.equal(landed(bare, 'refs/heads/main'), true);
  // And a leak on a new branch is still refused.
  assert.equal(git(work, ['checkout', '-q', '-b', 'leaky']).status, 0);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'a clean message');
  const leak = git(work, ['push', 'origin', 'leaky'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(leak.status, 0, leak.stderr);
  assert.doesNotMatch(leak.stderr, /unknown to this clone/);
  assert.match(leak.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.equal(landed(bare, 'refs/heads/leaky'), false);
});

test('in a SHA-256 repository a deletion is a deletion: its name is scanned and nothing is read behind it', () => {
  const { work, bare, patterns } = setupSha256();
  commit(work, 'README.md', 'hello world\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main', 'main:refs/heads/old'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  assert.equal(landed(bare, 'refs/heads/old'), true);
  const r = git(work, ['push', 'origin', ':refs/heads/old'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /this push deletes that reference/);
  assert.match(r.stderr, /leak gate ran/);
  assert.equal(landed(bare, 'refs/heads/old'), false);
});

// A url typed with a token in it reaches the enumeration as the remote's
// name, and the fallback sentences print that name. Each is reached here
// without the network: GIT_ALLOW_PROTOCOL makes every non-file transport
// refuse at once, which reads as a remote that cannot be asked.
const TOKEN = 'tok3nzz91';

test('a url carrying a token is printed without it when the remote cannot be asked', () => {
  const { work, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  for (const [typed, shown] of [
    [`https://ana:${TOKEN}@example.invalid/vault.git`, 'https://example.invalid/vault.git'],
    [`https://ana:${TOKEN}@with@example.invalid/vault.git`, 'https://example.invalid/vault.git'],
    [`ssh://ana:${TOKEN}@example.invalid:22/vault.git`, 'ssh://example.invalid:22/vault.git'],
    [`ana:${TOKEN}@example.invalid:vault.git`, 'example.invalid:vault.git'],
  ]) {
    const r = pushGate(work, [typed, typed, '--patterns', 'personal'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns, GIT_ALLOW_PROTOCOL: 'file' });
    assert.equal(r.status, 0, `${typed}: ${r.stderr}`);
    assert.ok(r.stderr.includes(`could not query remote '${shown}' (git ls-remote failed)`), `${typed}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, new RegExp(TOKEN), typed);
  }
  // A local path, and a url with no userinfo, are printed as they are.
  for (const typed of ['https://example.invalid/vaults/ana@example.invalid', join(work, 'no such remote@example.invalid')]) {
    const r = pushGate(work, [typed, typed, '--patterns', 'personal'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns, GIT_ALLOW_PROTOCOL: 'file' });
    assert.equal(r.status, 0, `${typed}: ${r.stderr}`);
    assert.ok(r.stderr.includes(`could not query remote '${typed}' (git ls-remote failed)`), `${typed}: ${r.stderr}`);
  }
});

test('a url carrying a token is printed without it when the url is rewritten', () => {
  const { root, work, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const typed = `https://ana:${TOKEN}@example.invalid/vault.git`;
  const elsewhere = join(root, 'elsewhere.git');
  assert.equal(git(work, ['config', `url.${elsewhere}.insteadOf`, typed]).status, 0);
  const r = pushGate(work, [typed, typed, '--patterns', 'personal'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes("for remote 'https://example.invalid/vault.git' is rewritten"), r.stderr);
  assert.doesNotMatch(r.stderr, new RegExp(TOKEN));
});

// --- --patterns config: the adopting vault's own patterns -------------------
//
// The template gate's real pushes are in test/pre-push-template.test.mjs.
// These drive the command directly, for the cases a push cannot reach
// cheaply: where the patterns come from when the default branch's copy of
// the configuration is missing, malformed or not a file, and what refuses.

const CONFIG_LITERAL = `zqx${'acmewidgets'}`;

function setupVault({ patterns = ['ghp_[A-Za-z0-9]{20,}', CONFIG_LITERAL] } = {}) {
  const root = join(makeTempDir('brain-kit-push-gate-config-'), AWKWARD_DIR);
  mkdirSync(root, { recursive: true });
  const bare = join(root, 'origin.git');
  const work = join(root, 'vault');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  assert.equal(git(work, ['remote', 'add', 'origin', bare]).status, 0);
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  config.privacy.secret_patterns = patterns;
  writeFileSync(join(work, 'brain-kit.config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(work, 'index.md'), '# Welcome\n');
  assert.equal(git(work, ['add', '-A']).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'init']).status, 0);
  const personal = join(root, 'personal.txt');
  writeFileSync(personal, 'zqxpersonalmark\n');
  return { root, work, bare, config, personal };
}

// origin/HEAD -> origin/main, pointing at `sha`, as a fetch would leave it.
function knowDefaultBranch(work, sha) {
  assert.equal(git(work, ['update-ref', 'refs/remotes/origin/main', sha]).status, 0);
  assert.equal(git(work, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']).status, 0);
}

function configGate(work, bare, input, env = {}) {
  return pushGate(work, ['origin', bare, '--patterns', 'config'], input, env);
}

test('--patterns config outside a vault exits 2 and says what it looked for', () => {
  const { work, bare, patterns } = setup();
  const sha = commit(work, 'README.md', 'hello world\n', 'init');
  const r = configGate(work, bare, refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--patterns config reads this vault's brain-kit\.config\.json, and no vault was found/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
});

test('--patterns config never reads the personal list: its pattern does not refuse, and its absence does not either', () => {
  const { work, bare, personal } = setupVault();
  const sha = commit(work, 'notes.md', 'zqxpersonalmark\n', 'a note');
  const listed = configGate(work, bare, refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stderr, /leak gate ran/);
  const missing = configGate(work, bare, refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: join(work, 'no such list.txt') });
  assert.equal(missing.status, 0, missing.stderr);
  assert.doesNotMatch(missing.stderr, /leak patterns file/);
  // And the same content under --patterns personal is refused, so the
  // difference above is the list, not the content.
  const personalGate = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(personalGate.status, 1, personalGate.stderr);
});

test('--patterns config refuses a match of the working tree\'s own pattern', () => {
  const { work, bare, personal } = setupVault();
  const sha = commit(work, 'notes.md', `A call with ${CONFIG_LITERAL}.\n`, 'a note');
  const r = configGate(work, bare, refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
  assert.match(r.stderr, /no default branch of remote 'origin' is known to this repository/);
});

test('the default branch\'s patterns are added to the working tree\'s, not substituted for them', () => {
  // The default branch declares a second literal the working tree does not.
  const other = `zqx${'globexcorp'}`;
  const { work, bare, config, personal } = setupVault();
  const withBoth = { ...config, privacy: { ...config.privacy, secret_patterns: [CONFIG_LITERAL, other] } };
  writeFileSync(join(work, 'brain-kit.config.json'), JSON.stringify(withBoth, null, 2));
  const merged = commit(work, 'brain-kit.config.json', JSON.stringify(withBoth, null, 2), 'both');
  knowDefaultBranch(work, merged);
  writeFileSync(join(work, 'brain-kit.config.json'), JSON.stringify(config, null, 2));
  const tip = commit(work, 'brain-kit.config.json', JSON.stringify(config, null, 2), 'only one again');
  for (const [word, file] of [[CONFIG_LITERAL, 'a.md'], [other, 'b.md']]) {
    const sha = commit(work, file, `Mentions ${word}.\n`, 'a note');
    const r = configGate(work, bare, `refs/heads/main ${sha} refs/heads/main ${tip}\n`, { BRAIN_KIT_LEAK_PATTERNS: personal });
    assert.equal(r.status, 1, `${word}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`possible leak in ${file.replace('.', '\\.')} \\(CONTENT`), word);
    assert.match(r.stderr, /and from the default branch as this repository knows it \(origin\/main\)/);
  }
});

test('a default branch whose configuration is not JSON, or not a file, says so and scans with the working tree\'s patterns', () => {
  const { work, bare, personal } = setupVault();
  const good = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  // Built with plumbing, as a merged commit would be: nothing is checked out.
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: work, input: '{ not json', encoding: 'utf8' }).stdout.trim();
  const broken = spawnSync('git', ['mktree'], { cwd: work, input: `100644 blob ${blob}\tbrain-kit.config.json\n`, encoding: 'utf8' }).stdout.trim();
  const inner = spawnSync('git', ['mktree'], { cwd: work, input: '', encoding: 'utf8' }).stdout.trim();
  const asTree = spawnSync('git', ['mktree'], { cwd: work, input: `040000 tree ${inner}\tbrain-kit.config.json\n`, encoding: 'utf8' }).stdout.trim();
  for (const [tree, said, file] of [[broken, /brain-kit\.config\.json on origin\/main, a default branch as this repository knows it, could not be used \(.+\)/, 'notes.md'], [asTree, /could not be used \(it is a tree, not a file\)/, 'more.md']]) {
    const merged = git(work, ['commit-tree', tree, '-m', 'merged']).stdout.trim();
    knowDefaultBranch(work, merged);
    const sha = commit(work, file, `A call with ${CONFIG_LITERAL}.\n`, 'a note');
    const r = configGate(work, bare, `refs/heads/main ${sha} refs/heads/main ${good}\n`, { BRAIN_KIT_LEAK_PATTERNS: personal });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, said);
    assert.match(r.stderr, /it adds no patterns to this push/);
    assert.doesNotMatch(r.stderr, /from the default branch as this repository knows it/);
    assert.match(r.stderr, new RegExp(`possible leak in ${file.replace('.', '\\.')} \\(CONTENT`));
  }
});

test('a remote HEAD that points outside that remote\'s own branches is not a default branch', () => {
  const { work, bare, personal } = setupVault();
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(git(work, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/main']).status, 0);
  const r = configGate(work, bare, refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no default branch of remote 'origin' is known to this repository/);
});

test('a working tree configuration that does not load refuses, before anything is scanned', () => {
  const { work, bare, personal } = setupVault();
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  writeFileSync(join(work, 'brain-kit.config.json'), '{ "kit_version": ');
  const r = configGate(work, bare, refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the working tree's brain-kit\.config\.json could not be loaded/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
});

test('a pattern on the default branch that does not compile refuses, like one in the working tree', () => {
  const { work, bare, config, personal } = setupVault();
  const bad = { ...config, privacy: { ...config.privacy, secret_patterns: ['([unclosed'] } };
  const good = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const merged = commit(work, 'brain-kit.config.json', JSON.stringify(bad, null, 2), 'bad pattern');
  knowDefaultBranch(work, merged);
  writeFileSync(join(work, 'brain-kit.config.json'), JSON.stringify(config, null, 2));
  const r = configGate(work, bare, refLine(good), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 1, r.stderr);
  // It names where the pattern lives, and the way out: a person who looks
  // at their working tree finds nothing wrong there.
  assert.match(r.stderr, /a pattern in the brain-kit\.config\.json on origin\/main, the default branch as this repository knows it, does not compile/);
  assert.match(r.stderr, /fix it through the host's own interface/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
});

test('the configuration file\'s content is read for credential shapes only, at the vault root and nowhere else', () => {
  const { work, bare, config, personal } = setupVault();
  // Its own declaration, and the literal in another of its fields: neither
  // refuses, because the file is where the patterns are declared.
  const edited = { ...config, vault: { ...config.vault, title: `Notes on ${CONFIG_LITERAL}` } };
  const sha = commit(work, 'brain-kit.config.json', JSON.stringify(edited, null, 2), 'retitle');
  const own = configGate(work, bare, refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(own.status, 0, own.stderr);
  // A credential shape in it still refuses.
  const keyed = { ...config, curate: { ...config.curate, signature: `AKIA${'IOSFODNN7EXAMPL2'}` } };
  const key = commit(work, 'brain-kit.config.json', JSON.stringify(keyed, null, 2), 'a key');
  const shaped = configGate(work, bare, refLine(key, sha), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(shaped.status, 1, shaped.stderr);
  assert.match(shaped.stderr, /possible leak in brain-kit\.config\.json \(CONTENT/);
  // A copy one directory down is an ordinary file.
  mkdirSync(join(work, 'copy'));
  const copy = commit(work, join('copy', 'brain-kit.config.json'), JSON.stringify(config, null, 2), 'a copy');
  const copied = configGate(work, bare, refLine(copy, key), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(copied.status, 1, copied.stderr);
  assert.match(copied.stderr, /possible leak in copy\/brain-kit\.config\.json \(CONTENT/);
  // And the commit that carries the root file is read in full: its message.
  writeFileSync(join(work, 'brain-kit.config.json'), JSON.stringify(config, null, 2));
  const said = commit(work, 'brain-kit.config.json', JSON.stringify({ ...config, lang: 'en' }, null, 2), `about ${CONFIG_LITERAL}`);
  const message = configGate(work, bare, refLine(said, copy), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(message.status, 1, message.stderr);
  assert.match(message.stderr, /COMMIT MESSAGE/);
});

test('the maintainer\'s gate reads its own configuration file like any other', () => {
  // --patterns personal has no exemption: a personal pattern in a file
  // called brain-kit.config.json refuses.
  const { work, bare, personal } = setupVault();
  const sha = commit(work, 'brain-kit.config.json', '{ "note": "zqxpersonalmark" }\n', 'a file of that name');
  const r = pushGate(work, ['origin', bare, '--patterns', 'personal'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /possible leak in brain-kit\.config\.json \(CONTENT/);
});

test('--patterns config still carries the generic credential shapes, whatever the configuration lists', () => {
  // A configuration that lists nothing at all.
  const { work, bare, personal } = setupVault({ patterns: [] });
  const sha = commit(work, 'notes.md', `aws_access_key_id = AKIA${'IOSFODNN7EXAMPL2'}\n`, 'a note');
  const r = configGate(work, bare, refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
});

test('a configuration on the default branch that git cannot read refuses rather than scanning without it', () => {
  // The tree names a blob this repository does not hold: the path resolves,
  // the object does not.
  const { work, bare, personal } = setupVault();
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const ghost = spawnSync('git', ['hash-object', '--stdin'], { cwd: work, input: '{"never":"written"}', encoding: 'utf8' }).stdout.trim();
  const tree = spawnSync('git', ['mktree', '--missing'], { cwd: work, input: `100644 blob ${ghost}\tbrain-kit.config.json\n`, encoding: 'utf8' });
  assert.equal(tree.status, 0, tree.stderr);
  const merged = git(work, ['commit-tree', tree.stdout.trim(), '-m', 'merged']);
  assert.equal(merged.status, 0, merged.stderr);
  knowDefaultBranch(work, merged.stdout.trim());
  const r = configGate(work, bare, refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /could not read the brain-kit\.config\.json on origin\/main, a default branch as this repository knows it/);
  assert.doesNotMatch(r.stderr, /leak gate ran/);
});

test('a vault in a subdirectory of the repository: its configuration is found at that path, on the default branch and in the push', () => {
  const root = join(makeTempDir('brain-kit-push-gate-subdir-'), AWKWARD_DIR);
  mkdirSync(join(root, 'repo', 'my vault'), { recursive: true });
  const repo = join(root, 'repo');
  const vault = join(repo, 'my vault');
  const bare = join(root, 'origin.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', repo]).status, 0);
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  config.privacy.secret_patterns = [CONFIG_LITERAL];
  writeFileSync(join(vault, 'brain-kit.config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(vault, 'index.md'), '# Welcome\n');
  assert.equal(git(repo, ['add', '-A']).status, 0);
  assert.equal(git(repo, ['commit', '-q', '-m', 'init']).status, 0);
  const base = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  knowDefaultBranch(repo, base);
  // The working tree drops the pattern; the default branch still has it.
  const dropped = { ...config, privacy: { ...config.privacy, secret_patterns: [] } };
  writeFileSync(join(vault, 'brain-kit.config.json'), JSON.stringify(dropped, null, 2));
  // Its own declaration, edited, is read for shapes only.
  const retitled = { ...dropped, vault: { ...dropped.vault, title: `On ${CONFIG_LITERAL}` } };
  const edit = commit(repo, join('my vault', 'brain-kit.config.json'), JSON.stringify(retitled, null, 2), 'retitle');
  const personal = join(root, 'personal.txt');
  writeFileSync(personal, 'zqxpersonalmark\n');
  const own = pushGate(vault, ['origin', bare, '--patterns', 'config'], refLine(edit, base), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stderr, /from the default branch as this repository knows it \(origin\/main\)/);
  const leak = commit(repo, join('my vault', 'notes.md'), `About ${CONFIG_LITERAL}.\n`, 'a note');
  const r = pushGate(vault, ['origin', bare, '--patterns', 'config'], refLine(leak, edit), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /possible leak in my vault\/notes\.md \(CONTENT/);
});

test('a repository inside a vault, whose configuration no commit of it can hold, says so and scans with the working tree\'s patterns', () => {
  const root = join(makeTempDir('brain-kit-push-gate-outside-'), AWKWARD_DIR);
  const vault = join(root, 'vault');
  const repo = join(vault, 'inner');
  mkdirSync(repo, { recursive: true });
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  config.privacy.secret_patterns = [CONFIG_LITERAL];
  writeFileSync(join(vault, 'brain-kit.config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(vault, 'index.md'), '# Welcome\n');
  const bare = join(root, 'origin.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', repo]).status, 0);
  const sha = commit(repo, 'notes.md', `About ${CONFIG_LITERAL}.\n`, 'a note');
  const personal = join(root, 'personal.txt');
  writeFileSync(personal, 'zqxpersonalmark\n');
  const r = pushGate(repo, ['origin', bare, '--patterns', 'config'], refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /this vault's brain-kit\.config\.json is outside the repository being pushed/);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
});

test('a remote HEAD that names a branch this repository no longer has is not a default branch, and the gate says so', () => {
  const { work, bare, personal } = setupVault();
  const sha = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(git(work, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone']).status, 0);
  const r = configGate(work, bare, refLine(sha), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no default branch of remote 'origin' is known to this repository/);
});

// --- fix round 1: the sources, their failures, and the remedies ------------

test('a default branch configuration that fails the schema is not reported as read, and says why', () => {
  const { work, bare, config, personal } = setupVault();
  const good = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const bad = { ...config, privacy: { ...config.privacy, secret_patterns: CONFIG_LITERAL } };
  const merged = commit(work, 'brain-kit.config.json', JSON.stringify(bad, null, 2), 'a string, not a list');
  knowDefaultBranch(work, merged);
  writeFileSync(join(work, 'brain-kit.config.json'), JSON.stringify(config, null, 2));
  const r = configGate(work, bare, refLine(good), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /on origin\/main, a default branch as this repository knows it, could not be used \(it does not match the configuration schema: /);
  assert.doesNotMatch(r.stderr, /from the default branch as this repository knows it/);
});

test('a default branch configuration with a byte-order mark is read', () => {
  const { work, bare, config, personal } = setupVault();
  const base = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const bom = String.fromCharCode(0xfeff);
  const merged = commit(work, 'brain-kit.config.json', `${bom}${JSON.stringify(config, null, 2)}`, 'saved by an editor that writes a BOM');
  knowDefaultBranch(work, merged);
  // The pushed branch drops the pattern and uses it.
  assert.equal(git(work, ['checkout', '-q', '-b', 'drop-it', base]).status, 0);
  const dropped = { ...config, privacy: { ...config.privacy, secret_patterns: [] } };
  commit(work, 'brain-kit.config.json', JSON.stringify(dropped, null, 2), 'drop');
  const tip = commit(work, 'notes.md', `A call with ${CONFIG_LITERAL}.\n`, 'use');
  const r = configGate(work, bare, `refs/heads/drop-it ${tip} refs/heads/drop-it ${ZERO}\n`, { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /from the default branch as this repository knows it \(origin\/main\)/);
  assert.match(r.stderr, /possible leak in notes\.md \(CONTENT/);
});

test('a pushed tip whose configuration pattern does not compile refuses, naming the reference', () => {
  const { work, bare, config, personal } = setupVault();
  const bad = { ...config, privacy: { ...config.privacy, secret_patterns: ['([unclosed'] } };
  const tip = commit(work, 'brain-kit.config.json', JSON.stringify(bad, null, 2), 'bad');
  writeFileSync(join(work, 'brain-kit.config.json'), JSON.stringify(config, null, 2));
  const r = configGate(work, bare, refLine(tip), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /a pattern in the brain-kit\.config\.json at reference #1 of this push does not compile/);
});

test('a pushed tip that is a deletion, or names a tree, adds no configuration and refuses nothing', async () => {
  const { pushedTips } = await import('../src/commands/push-gate.mjs');
  const sha = 'a'.repeat(40);
  assert.deepEqual(pushedTips(Buffer.from(`(delete) ${ZERO} refs/heads/x ${sha}\nrefs/heads/y ${sha} refs/heads/y ${ZERO}\n:/a b ${'b'.repeat(64)} refs/heads/z ${ZERO}`)), [
    { sha, number: 2 },
    { sha: 'b'.repeat(64), number: 3 },
  ]);
  // A configuration with nothing configured, so the tree tip, which is
  // scanned as an object with every pattern, has nothing to match.
  const { work, bare, personal } = setupVault({ patterns: [] });
  const tree = git(work, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const r = configGate(work, bare, `refs/heads/t ${tree} refs/tags/t ${ZERO}\n`, { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /at reference #1 of this push/);
});

test('a remedy naming a path is quoted the way a shell reads it', async () => {
  const { quotedForShell } = await import('../src/commands/push-gate.mjs');
  assert.equal(quotedForShell('origin'), 'origin');
  assert.equal(quotedForShell('https://example.invalid/vault.git'), 'https://example.invalid/vault.git');
  assert.equal(quotedForShell("/tmp/a vault d'Ana"), "'/tmp/a vault d'\\''Ana'");
});

test('by url with configured remotes that know no default branch, the remedy is git fetch --all, and it works', () => {
  const { work, bare, config, personal } = setupVault();
  const base = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(spawnSync('git', ['--git-dir', bare, 'fetch', '-q', work, 'main:main']).status, 0);
  assert.equal(spawnSync('git', ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']).status, 0);
  const dropped = { ...config, privacy: { ...config.privacy, secret_patterns: [] } };
  assert.equal(git(work, ['checkout', '-q', '-b', 'drop-it']).status, 0);
  commit(work, 'brain-kit.config.json', JSON.stringify(dropped, null, 2), 'drop');
  const tip = commit(work, 'notes.md', `A call with ${CONFIG_LITERAL}.\n`, 'use');
  const line = `refs/heads/drop-it ${tip} refs/heads/drop-it ${ZERO}\n`;
  const before = pushGate(work, [bare, bare, '--patterns', 'config'], line, { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stderr, /is not the name of a remote, and no configured remote \(origin\) has a default branch .* To add them, run: git fetch --all/);
  assert.equal(git(work, ['fetch', '--all', '-q']).status, 0);
  const after = pushGate(work, [bare, bare, '--patterns', 'config'], line, { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(after.status, 1, after.stderr);
  assert.match(after.stderr, /from the default branch as this repository knows it \(origin\/main\)/);
  void base;
});

test('with no remote configured, the remedy adds one and fetches it, and it works', () => {
  const { work, bare, config, personal } = setupVault();
  assert.equal(spawnSync('git', ['--git-dir', bare, 'fetch', '-q', work, 'main:main']).status, 0);
  assert.equal(spawnSync('git', ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']).status, 0);
  assert.equal(git(work, ['remote', 'remove', 'origin']).status, 0);
  const dropped = { ...config, privacy: { ...config.privacy, secret_patterns: [] } };
  assert.equal(git(work, ['checkout', '-q', '-b', 'drop-it']).status, 0);
  commit(work, 'brain-kit.config.json', JSON.stringify(dropped, null, 2), 'drop');
  const tip = commit(work, 'notes.md', `A call with ${CONFIG_LITERAL}.\n`, 'use');
  const line = `refs/heads/drop-it ${tip} refs/heads/drop-it ${ZERO}\n`;
  const before = pushGate(work, [bare, bare, '--patterns', 'config'], line, { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(before.status, 0, before.stderr);
  const said = before.stderr.match(/has no remote configured, .* To add one, run: (.+)$/m);
  assert.ok(said, before.stderr);
  // Run exactly as printed, the way a person pastes it into a shell: the
  // path has a space and an accented letter in it.
  const ran = spawnSync('bash', ['-c', said[1]], { cwd: work, encoding: 'utf8' });
  assert.equal(ran.status, 0, `${said[1]}: ${ran.stderr}`);
  const after = pushGate(work, [bare, bare, '--patterns', 'config'], line, { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(after.status, 1, after.stderr);
  assert.match(after.stderr, /from the default branch as this repository knows it \(origin\/main\)/);
});

test('the master rung: a remote whose default branch is master is read through origin/master', () => {
  const { work, bare, config, personal } = setupVault();
  const base = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(git(work, ['update-ref', 'refs/remotes/origin/master', base]).status, 0);
  const dropped = { ...config, privacy: { ...config.privacy, secret_patterns: [] } };
  commit(work, 'brain-kit.config.json', JSON.stringify(dropped, null, 2), 'drop');
  const tip = commit(work, 'notes.md', `A call with ${CONFIG_LITERAL}.\n`, 'use');
  const r = configGate(work, bare, refLine(tip, base), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /from the default branch as this repository knows it \(origin\/master\)/);
});

test('the HEAD rung: a default branch with another name is read through origin/HEAD, before main', () => {
  const { work, bare, config, personal } = setupVault();
  const base = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  // origin/main exists too, and declares nothing: HEAD must win.
  const empty = { ...config, privacy: { ...config.privacy, secret_patterns: [] } };
  const other = commit(work, 'brain-kit.config.json', JSON.stringify(empty, null, 2), 'an old main');
  assert.equal(git(work, ['update-ref', 'refs/remotes/origin/main', other]).status, 0);
  assert.equal(git(work, ['update-ref', 'refs/remotes/origin/trunk', base]).status, 0);
  assert.equal(git(work, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']).status, 0);
  const tip = commit(work, 'notes.md', `A call with ${CONFIG_LITERAL}.\n`, 'use');
  const r = configGate(work, bare, refLine(tip, base), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /from the default branch as this repository knows it \(origin\/trunk\)/);
});

test('JSON at the configuration path that is not an object is an ordinary file', () => {
  const { work, bare, personal } = setupVault();
  const base = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  for (const [content, file] of [[JSON.stringify([`the ${CONFIG_LITERAL} deal`]), 'a'], [JSON.stringify(`the ${CONFIG_LITERAL} deal`), 'b']]) {
    const sha = commit(work, 'brain-kit.config.json', content, `not an object ${file}`);
    // The working tree keeps a real configuration; only the commit holds
    // the lookalike.
    assert.equal(git(work, ['checkout', '-q', base, '--', 'brain-kit.config.json']).status, 0);
    const r = configGate(work, bare, refLine(sha, base), { BRAIN_KIT_LEAK_PATTERNS: personal });
    assert.equal(r.status, 1, `${content}: ${r.stderr}`);
    assert.match(r.stderr, /possible leak in brain-kit\.config\.json \(CONTENT/, content);
  }
});

test('a configuration saved with a byte-order mark is still read for credential shapes only', () => {
  // It declares the literal, as every configuration of this vault does;
  // with the mark it must still be recognised as the configuration, or its
  // own declaration refuses the push.
  const { work, bare, config, personal } = setupVault();
  const base = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  const bom = String.fromCharCode(0xfeff);
  const sha = commit(work, 'brain-kit.config.json', `${bom}${JSON.stringify({ ...config, lang: 'en' }, null, 4)}`, 'saved with a BOM');
  assert.equal(git(work, ['checkout', '-q', base, '--', 'brain-kit.config.json']).status, 0);
  const r = configGate(work, bare, refLine(sha, base), { BRAIN_KIT_LEAK_PATTERNS: personal });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /leak gate ran/);
});
