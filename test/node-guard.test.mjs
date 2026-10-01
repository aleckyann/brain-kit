// The Node guard (the first stranger's m13, 01/10/2026). `engines` says Node
// 24, but nothing said so to a person on an older one: bin/brain-kit.mjs
// imported the whole CLI statically, so a Node 20 or 22 died with a
// SyntaxError or a TypeError and a stack trace from somewhere inside src/,
// before a single word of the kit. The launcher now imports ONLY the guard
// (src/node-guard.mjs: no imports, and no syntax an old Node cannot parse),
// asks it, and loads the CLI with a dynamic import() only when it passes.
//
// An old Node is not assumed to exist where the suite runs, so what is proved
// is: the decision (a table of versions), the message in both languages, the
// `hook` exception (a Claude Code hook must never break a session), the shape
// of the two files that keeps the guard able to run on an old Node, through a
// preload that makes process.versions.node say another number, the real
// launcher refusing and still working, and, against a copy of the launcher
// that came before the guard, that it ends the process with the same exit
// code as that one did, whatever the CLI's main() does (fix round 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT, kitVersion } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { resolveLang } from '../src/lang.mjs';
import { MINIMUM_NODE_MAJOR } from '../src/doctor/checks.mjs';
import { checkNodeVersion } from '../src/node-guard.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const GUARD = join(KIT_ROOT, 'src', 'node-guard.mjs');
const EN = (version) => `brain-kit needs Node 24 or newer; this machine has Node ${version}. Install Node 24 from https://nodejs.org and run it again.`;
const PT = (version) => `brain-kit precisa do Node 24 ou mais novo; esta m${String.fromCharCode(0xe1)}quina tem o Node ${version}. Instale o Node 24 em https://nodejs.org e rode de novo.`;

// --- the decision -------------------------------------------------------------

test('a Node of 24 or newer is let through, whatever shape its version string has', () => {
  for (const version of ['24.0.0', '24.18.0', '25.1.0', '30.2.1', '100.0.0', 'v24.0.0', '24.0.0-nightly20260101abcdef', '24.0.0-rc.1', 'v25.0.0-pre', '24', 'v24', '24.1']) {
    assert.equal(checkNodeVersion(version, 'doctor', {}), null, version);
  }
});

test('a Node older than 24 is refused, the major compared as a number and never as text', () => {
  for (const version of ['23.9.0', '23.99.99', '22.12.0', '20.11.1', '18.19.0', '16.20.2', '12.22.12', '9.11.2', '8.0.0', '4.9.1', '0.12.18', 'v22.11.0', '22.0.0-nightly20240101abc', '22', 'v22', '22.12']) {
    const refusal = checkNodeVersion(version, 'doctor', {});
    assert.notEqual(refusal, null, version);
    assert.equal(refusal.exitCode, EXIT.USAGE, version);
  }
});

test('a version it cannot read is never a reason to refuse: only a version it can read below 24 blocks', () => {
  // A major followed by a dot, or by the end of the text, is a version it can read.
  for (const version of ['garbage', '', ' ', ' 22.12.0', 'x24.0.0', 'node', '--', '2x.0.0', 'v', '.', '-22.0.0', undefined, null, {}, [], true]) {
    assert.equal(checkNodeVersion(version, 'doctor', {}), null, String(version));
  }
});

test('the exit code is the kit\'s usage error code, 2', () => {
  assert.equal(EXIT.USAGE, 2);
  assert.equal(checkNodeVersion('22.12.0', 'validate', {}).exitCode, EXIT.USAGE);
  // Every command is refused alike, --version and --help included.
  for (const first of ['init', 'doctor', 'validate', 'propose', 'push-gate', '--version', '--help', '-C', '', undefined]) {
    assert.equal(checkNodeVersion('20.11.1', first, {}).exitCode, 2, String(first));
  }
});

// The guard repeats a number three other places state: package.json's `engines`,
// and the Node check of `doctor`. Raise one without the others and a Node that
// the guard lets through is one doctor fails, or the other way round.
test('the guard\'s minimum is the one in package.json engines and in the doctor\'s node-version check', () => {
  const engines = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8')).engines.node;
  assert.equal(engines, `>=${MINIMUM_NODE_MAJOR}`);
  assert.equal(checkNodeVersion(`${MINIMUM_NODE_MAJOR}.0.0`, 'doctor', {}), null);
  assert.notEqual(checkNodeVersion(`${MINIMUM_NODE_MAJOR - 1}.99.99`, 'doctor', {}), null);
  assert.ok(checkNodeVersion(`${MINIMUM_NODE_MAJOR - 1}.0.0`, 'doctor', {}).message.includes(`Node ${MINIMUM_NODE_MAJOR} `), 'and the message names that number');
});

// --- the message ---------------------------------------------------------------

test('the message is one line of two sentences naming the Node found and where to get Node 24, in English by default', () => {
  const refusal = checkNodeVersion('22.12.0', 'doctor', {});
  assert.equal(refusal.message, EN('22.12.0'));
  assert.equal(refusal.message.includes('\n'), false);
  assert.equal(refusal.message.split('. ').length, 2, 'two sentences');
  assert.deepEqual(Object.keys(refusal).sort(), ['exitCode', 'message']);
  // A leading v is not printed twice.
  assert.equal(checkNodeVersion('v20.11.1', 'doctor', {}).message, EN('20.11.1'));
  assert.equal(checkNodeVersion('18.19.0', 'doctor', undefined).message, EN('18.19.0'), 'no environment at all is English');
});

test('the message is in Portuguese when the person\'s language is, with the accent a Brazilian writes', () => {
  assert.equal(checkNodeVersion('22.12.0', 'doctor', { LANG: 'pt_BR.UTF-8' }).message, PT('22.12.0'));
  assert.equal(checkNodeVersion('20.11.1', 'doctor', { BRAIN_KIT_LANG: 'pt-BR', LC_ALL: 'C' }).message, PT('20.11.1'));
  assert.ok(checkNodeVersion('1.2.3', 'doctor', { LANG: 'pt_BR' }).message.includes(`m${String.fromCharCode(0xe1)}quina`), 'the accent is in the message itself');
});

// The guard cannot import the kit's language resolver (it would defeat its
// purpose), so it repeats the decision, and this table is lang.test.mjs's own
// for resolveLang, held against it so the two cannot drift.
test('the language is chosen as resolveLang chooses it: BRAIN_KIT_LANG, then LC_ALL, LC_MESSAGES and LANG', () => {
  const cases = [
    { BRAIN_KIT_LANG: 'en', LC_ALL: 'pt_BR.UTF-8', LANG: 'pt_BR.UTF-8' },
    { BRAIN_KIT_LANG: 'pt-BR', LC_ALL: 'C' },
    { BRAIN_KIT_LANG: 'fr', LANG: 'pt_BR.UTF-8' },
    { BRAIN_KIT_LANG: 'pt_PT', LANG: 'en_US.UTF-8' },
    { BRAIN_KIT_LANG: 'PT-BR', LANG: 'en_US.UTF-8' },
    { LC_ALL: 'pt_BR.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
    { LC_ALL: 'C', LANG: 'pt_BR.UTF-8' },
    { LC_ALL: 'POSIX', LANG: 'pt_BR.UTF-8' },
    { LC_MESSAGES: 'pt_PT.UTF-8', LANG: 'en_US.UTF-8' },
    { LC_MESSAGES: 'C.UTF-8', LANG: 'pt_BR.UTF-8' },
    { LANG: 'pt_BR.UTF-8' },
    { LANG: 'PT_BR' },
    { LANG: 'pt' },
    { LANG: 'en_GB.UTF-8' },
    { LANG: 'fr_FR.UTF-8' },
    { BRAIN_KIT_LANG: '', LC_ALL: '', LC_MESSAGES: '', LANG: 'pt_BR.UTF-8' },
    { LC_ALL: 42, LANG: 'pt_BR.UTF-8' },
    {},
  ];
  for (const env of cases) {
    const expected = resolveLang(env) === 'pt-BR' ? PT('22.12.0') : EN('22.12.0');
    assert.equal(checkNodeVersion('22.12.0', 'doctor', env).message, expected, JSON.stringify(env));
  }
});

// --- the hook exception ----------------------------------------------------------

test('a hook is never refused: the same one line, and exit code 0, so a session is never broken', () => {
  for (const [env, message] of [[{}, EN('22.12.0')], [{ LANG: 'pt_BR.UTF-8' }, PT('22.12.0')]]) {
    assert.deepEqual(checkNodeVersion('22.12.0', 'hook', env), { message, exitCode: 0 });
  }
  assert.equal(checkNodeVersion('24.0.0', 'hook', {}), null, 'a Node that is new enough has nothing to say to a hook either');
  // Only the exact word, as the hooks file spells it; anything else is an ordinary command.
  for (const first of ['hooks', 'Hook', 'HOOK', ' hook', 'hook ', 'hook\n', '-C', 'stop', 'session-start']) {
    assert.equal(checkNodeVersion('22.12.0', first, {}).exitCode, 2, JSON.stringify(first));
  }
});

// --- the shape of the two files that must run on an old Node -------------------------

// Comments are left out of what is scanned: they describe the syntax this
// file keeps out, and may name it. Only whole-line comments exist in these
// two files, so a URL in a string is never cut.
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
}

test('the guard imports nothing and uses only syntax an old Node parses', () => {
  const text = code(readFileSync(GUARD, 'utf8'));
  assert.ok(text.length > 200, 'the scan must read the guard, not an empty file');
  const forbidden = [
    [/\bimport\b/, 'an import (the guard must stand alone)'],
    [/\brequire\b/, 'a require'],
    [/\?\./, 'optional chaining'],
    [/\?\?/, 'the nullish coalescing operator'],
    [/(\|\||&&|\?\?)=/, 'logical assignment'],
    [/(^|[^\w$'"])#\w/m, 'a private field'],
    [/\basync\b|\bawait\b/, 'async or await'],
    [/`/, 'a template literal'],
    [/\.\.\./, 'spread or rest'],
    [/\bclass\b/, 'a class'],
    [/\d_\d/, 'a numeric separator'],
    [/\b\d+n\b/, 'a bigint'],
    [/\bcatch\s*\{/, 'an optional catch binding'],
  ];
  for (const [pattern, what] of forbidden) assert.doesNotMatch(text, pattern, `src/node-guard.mjs uses ${what}, which an old Node cannot parse`);
  assert.match(text, /export function checkNodeVersion\(/);
});

test('the launcher imports the guard statically and the CLI only dynamically, after the guard has been asked', () => {
  const text = code(readFileSync(BIN, 'utf8'));
  const staticImports = [...text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual(staticImports, ['../src/node-guard.mjs'], 'the launcher\'s only static import is the guard');
  assert.doesNotMatch(text, /^\s*import\s+['"]/m, 'no bare import either');
  assert.doesNotMatch(text, /\brequire\b/);
  const asked = text.indexOf('checkNodeVersion(');
  const loaded = text.indexOf("import('../src/cli.mjs')");
  assert.ok(asked !== -1, 'the launcher asks the guard');
  assert.ok(loaded !== -1, 'the launcher loads the CLI with a dynamic import');
  assert.ok(asked < loaded, 'and asks it BEFORE loading the CLI');
  assert.equal(text.indexOf('src/cli.mjs'), loaded + "import('../".length, 'the CLI is named once, in the dynamic import');
  assert.equal(text.lastIndexOf('src/cli.mjs'), text.indexOf('src/cli.mjs'), 'and named nowhere else');
  // The whole path is awaited at the top level, as the launcher always did: a
  // main() whose promise never settles then ends the process with exit code 13
  // (unsettled top-level await), where a promise chain ends it with 0 and the
  // push gate and the scheduled rounds read that as success (fix round 1).
  assert.match(text, /=\s*await import\('\.\.\/src\/cli\.mjs'\)/, 'the CLI is loaded with an awaited import');
  assert.match(text, /process\.exitCode\s*=\s*await main\(/, 'and its main() is awaited into the exit code');
  assert.doesNotMatch(text, /\.then\(|\.catch\(|\.finally\(/, 'no promise chain, which loses the exit code of a promise that never settles');
  assert.doesNotMatch(text, /\?\.|\?\?/);
});

// --- the real launcher -------------------------------------------------------------------

// A preload that makes the running Node say it is `version`: the only way to
// reach the launcher's refusal on a machine that has the right Node.
function preload(version) {
  const file = join(makeTempDir('brain-kit-node-guard-'), `node-${version}.mjs`);
  writeFileSync(file, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)}, configurable: true, enumerable: true, writable: false });\n`);
  return file;
}

function launch(args, { version = null, env = {}, input = '' } = {}) {
  const base = makeTempDir('brain-kit-node-guard-run-');
  return spawnSync(process.execPath, [...(version === null ? [] : ['--import', preload(version)]), BIN, ...args], {
    cwd: base,
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: base, BRAIN_KIT_STATE_DIR: join(base, 'state'), ...env },
  });
}

test('the real launcher still works on the Node that runs this suite: --version prints the kit\'s version', () => {
  const r = launch(['--version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${kitVersion()}\n`);
  assert.equal(r.stderr, '');
});

test('the real launcher, on a Node below 24, prints the one line to stderr, exits 2, and loads nothing of the CLI', () => {
  for (const version of ['22.11.0', '20.11.1', '23.99.0']) {
    const en = launch(['--version'], { version, env: { LC_ALL: 'C' } });
    assert.equal(en.status, EXIT.USAGE, en.stdout + en.stderr);
    assert.equal(en.stdout, '', 'the CLI did not run: --version printed nothing');
    assert.equal(en.stderr, `${EN(version)}\n`);
    const pt = launch(['doctor'], { version, env: { LANG: 'pt_BR.UTF-8' } });
    assert.equal(pt.status, EXIT.USAGE);
    assert.equal(pt.stdout, '');
    assert.equal(pt.stderr, `${PT(version)}\n`);
  }
});

test('the real launcher, on a Node below 24, lets a hook finish with exit 0 and the same line on stderr', () => {
  for (const event of ['stop', 'session-start']) {
    const r = launch(['hook', event], { version: '22.11.0', env: { LANG: 'C' }, input: JSON.stringify({ cwd: KIT_ROOT }) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, '', 'nothing a session could read as the hook\'s answer');
    assert.equal(r.stderr, `${EN('22.11.0')}\n`);
  }
});

// What an old Node does to the CLI is fail to parse it. A copy of the launcher
// and the guard beside a cli.mjs that is not valid JavaScript stands in for
// that: the refusal must come out all the same, which only a launcher that has
// not loaded the CLI yet can give, and on a Node that passes the guard the
// broken file is reached, so the stand-in really is in the way.
test('a CLI that cannot be parsed is never reached when the guard refuses, and is when it does not', () => {
  const base = makeTempDir('brain-kit-node-guard-copy-');
  mkdirSync(join(base, 'bin'));
  mkdirSync(join(base, 'src'));
  copyFileSync(BIN, join(base, 'bin', 'brain-kit.mjs'));
  copyFileSync(GUARD, join(base, 'src', 'node-guard.mjs'));
  writeFileSync(join(base, 'src', 'cli.mjs'), 'export const main = async () => { this is not javascript ?. ?? # };\n');
  const run = (version) => spawnSync(process.execPath, [...(version === null ? [] : ['--import', preload(version)]), join(base, 'bin', 'brain-kit.mjs'), 'doctor'], {
    cwd: base, encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C' },
  });
  const refused = run('18.19.0');
  assert.equal(refused.status, EXIT.USAGE, refused.stdout + refused.stderr);
  assert.equal(refused.stderr, `${EN('18.19.0')}\n`, 'a sentence, not a SyntaxError and a stack');
  const reached = run(null);
  assert.notEqual(reached.status, 0);
  assert.match(reached.stderr, /SyntaxError/, 'on a Node the guard lets through, the broken CLI is what runs');
});

test('the real launcher, on exactly Node 24.0.0, runs the CLI as usual', () => {
  const r = launch(['--version'], { version: '24.0.0' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${kitVersion()}\n`);
  const hook = launch(['hook', 'nope'], { version: '24.0.0', input: '{}' });
  assert.equal(hook.status, EXIT.USAGE, 'a hook on a good Node is the CLI\'s own, unknown event and all');
  assert.match(hook.stderr, /nope/);
});

// --- the launcher ends the process as the one before the guard did (fix round 1) ----------
//
// Before the guard the launcher was `process.exitCode = await main(...)` at the top
// level of the file. That await is also a net: a main() whose promise never settles
// (a stream that never ends, a lock nobody releases) lets the event loop empty
// with the await still pending, and Node ends the process with exit code 13,
// "unsettled top-level await". The pre-push hook reads exit 0 of `validate`, `lint`
// and `push-gate` as a pass and a scheduled round's exit 0 as a success, so that 13
// is the difference between a push refused and a push let through. A promise chain
// in the launcher (the first version of the guard's) ended the same process with 0,
// silently. The copy of the launcher below is the one that came before the guard,
// verbatim, held here so that nothing depends on the history being present.

const LAUNCHER_BEFORE_THE_GUARD = [
  '#!/usr/bin/env node',
  "import { main } from '../src/cli.mjs';",
  '',
  'process.exitCode = await main(process.argv.slice(2), {',
  '  stdin: process.stdin,',
  '  stdout: process.stdout,',
  '  stderr: process.stderr,',
  '});',
  '',
].join('\n');

// A launcher, the current one or the one before the guard, in a directory of its
// own, with `source` as the CLI it loads. Returns the launcher's path.
function launcherWith(kind, source) {
  const base = makeTempDir('brain-kit-launcher-');
  mkdirSync(join(base, 'bin'));
  mkdirSync(join(base, 'src'));
  if (kind === 'before') {
    writeFileSync(join(base, 'bin', 'brain-kit.mjs'), LAUNCHER_BEFORE_THE_GUARD);
  } else {
    copyFileSync(BIN, join(base, 'bin', 'brain-kit.mjs'));
    copyFileSync(GUARD, join(base, 'src', 'node-guard.mjs'));
  }
  writeFileSync(join(base, 'src', 'cli.mjs'), source);
  return join(base, 'bin', 'brain-kit.mjs');
}

function runLauncher(file, { version = null, args = ['one', '--two'] } = {}) {
  return spawnSync(process.execPath, [...(version === null ? [] : ['--import', preload(version)]), file, ...args], {
    cwd: join(file, '..', '..'), input: '', encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, LC_ALL: 'C' },
  });
}

// What main() does, the exit code the launcher before the guard gave, and what
// stderr must show (a pattern, or null for nothing).
const WHAT_MAIN_DOES = [
  ['returns 0', 'export async function main() { return 0; }', 0, null],
  ['returns 1', 'export async function main() { return 1; }', 1, null],
  ['returns 2', 'export async function main() { return 2; }', 2, null],
  ['returns 75', 'export async function main() { return 75; }', 75, null],
  ['returns nothing', 'export async function main() {}', 0, null],
  ['returns a code after a delay', 'export async function main() { await new Promise((done) => setTimeout(done, 80)); return 3; }', 3, null],
  ['returns its code from a plain function, not a promise', 'export function main() { return 4; }', 4, null],
  ['rejects', "export async function main() { throw new Error('the command broke'); }", 1, /the command broke/],
  ['never settles', 'export function main() { return new Promise(() => {}); }', 13, /unsettled top-level await/i],
  ['is handed the arguments and the three streams of the process',
    "export async function main(argv, io) { io.stdout.write(JSON.stringify([argv, io.stdin === process.stdin, io.stdout === process.stdout, io.stderr === process.stderr]) + '\\n'); return 5; }", 5, null],
  ['cannot be loaded (a SyntaxError in the CLI)', 'export async function main() { this is not javascript ?. ?? # }\n', 1, /SyntaxError/],
];

for (const [what, source, expected, stderr] of WHAT_MAIN_DOES) {
  test(`the launcher ends the process as the one before the guard did when main() ${what}`, () => {
    const before = runLauncher(launcherWith('before', source));
    const now = runLauncher(launcherWith('now', source));
    // The reference itself: what the launcher before the guard does on this Node.
    assert.equal(before.status, expected, `the launcher before the guard: ${before.stdout}${before.stderr}`);
    // The launcher now does the same: the same exit code, never a signal, the same stdout.
    assert.equal(now.status, before.status, `the launcher now: ${now.stdout}${now.stderr}`);
    assert.equal(now.signal, before.signal);
    assert.equal(now.stdout, before.stdout);
    if (stderr === null) {
      assert.equal(now.stderr, '');
      assert.equal(before.stderr, '');
    } else {
      assert.match(before.stderr, stderr);
      assert.match(now.stderr, stderr);
    }
  });
}

test('the launcher fails closed when main() never settles: not 0, whatever the Node says it is, and the guard\'s refusal does not wait for the CLI', () => {
  const hung = 'export function main() { return new Promise(() => {}); }';
  const now = runLauncher(launcherWith('now', hung));
  assert.notEqual(now.status, 0, 'a gate command that hangs must not read as a pass');
  assert.equal(now.status, 13);
  // A refusal comes out at once, and never loads the CLI that would hang.
  const refused = runLauncher(launcherWith('now', hung), { version: '20.11.1' });
  assert.equal(refused.status, EXIT.USAGE, refused.stdout + refused.stderr);
  assert.equal(refused.stderr, `${EN('20.11.1')}\n`);
  const hook = runLauncher(launcherWith('now', hung), { version: '20.11.1', args: ['hook', 'stop'] });
  assert.equal(hook.status, 0, hook.stdout + hook.stderr);
  assert.equal(hook.stderr, `${EN('20.11.1')}\n`);
});
