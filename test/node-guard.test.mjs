// The Node guard (the first stranger's m13, 01/10/2026). `engines` names the oldest
// Node the kit supports, but nothing said so to a person on an older one:
// bin/brain-kit.mjs imported the whole CLI statically, so a Node too old for
// some syntax or built-in in src/ would die with a SyntaxError or a TypeError and a
// stack trace from somewhere inside src/, before a single word of the kit. The
// launcher now imports ONLY the guard (src/node-guard.mjs: no imports, and no
// syntax an old Node cannot parse), asks it, and loads the CLI with a dynamic
// import() only when it passes.
//
// The minimum is 22 (0.0.9, task G4): the whole suite was run on a real Node
// 22.22.1 and only the version policy itself failed. test/node-minimum.test.mjs
// holds that number to every other place that states it.
//
// An old Node cannot be run here, so what is proved is: the decision (a
// table of versions), the message in both languages, the `hook` exception
// (a Claude Code hook must never break a session), the shape of the two
// files that keeps the guard able to run on an old Node, and, through a
// preload that makes process.versions.node say another number, the real
// launcher refusing and still working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT, kitVersion } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { resolveLang } from '../src/lang.mjs';
import { MINIMUM_NODE_MAJOR, checkNodeVersion } from '../src/node-guard.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const GUARD = join(KIT_ROOT, 'src', 'node-guard.mjs');
const EN = (version) => `brain-kit needs Node 22 or newer; this machine has Node ${version}. Install Node 24 (the current LTS) from https://nodejs.org and run it again.`;
const PT = (version) => `brain-kit precisa do Node 22 ou mais novo; esta m${String.fromCharCode(0xe1)}quina tem o Node ${version}. Instale o Node 24 (a vers${String.fromCharCode(0xe3)}o LTS atual) em https://nodejs.org e rode de novo.`;

// --- the decision -------------------------------------------------------------

// The minimum is 22 and it was measured, not planned: a real Node 22.22.1 ran
// the whole suite. The floor itself and the versions around it are listed by
// hand, so that a guard comparing against another number fails here by name.
test('a Node of 22 or newer is let through, whatever shape its version string has', () => {
  for (const version of ['22.0.0', '22.12.0', '22.22.1', '23.0.0', '23.11.0', '24.0.0', '24.18.0', '25.1.0', '30.2.1', '100.0.0', 'v22.0.0', 'v24.0.0', '22.0.0-nightly20260101abcdef', '22.0.0-rc.1', 'v25.0.0-pre', '22', 'v22', '22.1']) {
    assert.equal(checkNodeVersion(version, 'doctor', {}), null, version);
  }
});

test('a Node older than 22 is refused, the major compared as a number and never as text', () => {
  for (const version of ['21.7.3', '21.99.99', '20.11.1', '18.19.0', '16.20.2', '12.22.12', '9.11.2', '8.0.0', '4.9.1', '0.12.18', 'v21.0.0', 'v20.11.1', '21.0.0-nightly20240101abc', '21', 'v21', '21.7']) {
    const refusal = checkNodeVersion(version, 'doctor', {});
    assert.notEqual(refusal, null, version);
    assert.equal(refusal.exitCode, EXIT.USAGE, version);
  }
});

test('a version it cannot read is never a reason to refuse: only a version it can read below 22 blocks', () => {
  // A major followed by a dot, or by the end of the text, is a version it can read.
  for (const version of ['garbage', '', ' ', ' 20.11.1', 'x20.0.0', 'x24.0.0', 'node', '--', '2x.0.0', 'v', '.', '-20.0.0', undefined, null, {}, [], true]) {
    assert.equal(checkNodeVersion(version, 'doctor', {}), null, String(version));
  }
});

test('the exit code is the kit\'s usage error code, 2', () => {
  assert.equal(EXIT.USAGE, 2);
  assert.equal(checkNodeVersion('21.7.3', 'validate', {}).exitCode, EXIT.USAGE);
  // Every command is refused alike, --version and --help included.
  for (const first of ['init', 'doctor', 'validate', 'propose', 'push-gate', '--version', '--help', '-C', '', undefined]) {
    assert.equal(checkNodeVersion('20.11.1', first, {}).exitCode, 2, String(first));
  }
});

// The guard's number is the one package.json's `engines` states and the one the
// refusal names; the doctor and the documents are held to it by
// test/node-minimum.test.mjs. Raise it here without package.json and a Node that
// npm accepts is one the launcher refuses, or the other way round.
test('the guard\'s minimum is a whole major, the one in package.json engines, and the floor of its own decision', () => {
  const engines = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8')).engines.node;
  assert.ok(Number.isInteger(MINIMUM_NODE_MAJOR), 'a major, not a version string');
  assert.equal(engines, `>=${MINIMUM_NODE_MAJOR}`);
  assert.equal(checkNodeVersion(`${MINIMUM_NODE_MAJOR}.0.0`, 'doctor', {}), null);
  assert.notEqual(checkNodeVersion(`${MINIMUM_NODE_MAJOR - 1}.99.99`, 'doctor', {}), null);
  assert.ok(checkNodeVersion(`${MINIMUM_NODE_MAJOR - 1}.0.0`, 'doctor', {}).message.includes(`Node ${MINIMUM_NODE_MAJOR} or newer`), 'and the message names that number');
});

// --- the message ---------------------------------------------------------------

test('the message is one line of two sentences naming the minimum, the Node found and the Node to install, in English by default', () => {
  const refusal = checkNodeVersion('20.11.1', 'doctor', {});
  assert.equal(refusal.message, EN('20.11.1'));
  assert.equal(refusal.message.includes('\n'), false);
  assert.equal(refusal.message.split('. ').length, 2, 'two sentences');
  assert.deepEqual(Object.keys(refusal).sort(), ['exitCode', 'message']);
  // A leading v is not printed twice.
  assert.equal(checkNodeVersion('v20.11.1', 'doctor', {}).message, EN('20.11.1'));
  assert.equal(checkNodeVersion('18.19.0', 'doctor', undefined).message, EN('18.19.0'), 'no environment at all is English');
});

test('the message is in Portuguese when the person\'s language is, with the accent a Brazilian writes', () => {
  assert.equal(checkNodeVersion('20.11.1', 'doctor', { LANG: 'pt_BR.UTF-8' }).message, PT('20.11.1'));
  assert.equal(checkNodeVersion('18.19.0', 'doctor', { BRAIN_KIT_LANG: 'pt-BR', LC_ALL: 'C' }).message, PT('18.19.0'));
  assert.ok(checkNodeVersion('1.2.3', 'doctor', { LANG: 'pt_BR' }).message.includes(`m${String.fromCharCode(0xe1)}quina`), 'the accent is in the message itself');
});

// The Node it asks for and the Node it sends a person to install are two numbers
// on purpose: 22 is what runs the kit, 24 is the one worth installing today.
test('the message asks for the minimum, 22, but sends the person to Node 24, the current LTS', () => {
  for (const [locale, text] of [[{}, EN('20.11.1')], [{ LANG: 'pt_BR.UTF-8' }, PT('20.11.1')]]) {
    const message = checkNodeVersion('20.11.1', 'doctor', locale).message;
    assert.equal(message, text);
    assert.match(message, /Node 22 (or newer|ou mais novo)/);
    assert.match(message, /Instale o Node 24 \(a vers\u00e3o LTS atual\)|Install Node 24 \(the current LTS\)/);
    assert.match(message, /https:\/\/nodejs\.org/);
    assert.doesNotMatch(message, /Node 24 (or newer|ou mais novo)/, 'Node 24 is advice, no longer the minimum');
  }
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
    const expected = resolveLang(env) === 'pt-BR' ? PT('20.11.1') : EN('20.11.1');
    assert.equal(checkNodeVersion('20.11.1', 'doctor', env).message, expected, JSON.stringify(env));
  }
});

// --- the hook exception ----------------------------------------------------------

test('a hook is never refused: the same one line, and exit code 0, so a session is never broken', () => {
  for (const [env, message] of [[{}, EN('20.11.1')], [{ LANG: 'pt_BR.UTF-8' }, PT('20.11.1')]]) {
    assert.deepEqual(checkNodeVersion('20.11.1', 'hook', env), { message, exitCode: 0 });
  }
  assert.equal(checkNodeVersion('22.0.0', 'hook', {}), null, 'a Node that is new enough has nothing to say to a hook either');
  // Only the exact word, as the hooks file spells it; anything else is an ordinary command.
  for (const first of ['hooks', 'Hook', 'HOOK', ' hook', 'hook ', 'hook\n', '-C', 'stop', 'session-start']) {
    assert.equal(checkNodeVersion('20.11.1', first, {}).exitCode, 2, JSON.stringify(first));
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
  // The launcher itself must parse on an old Node, so it has no top-level await.
  assert.doesNotMatch(text, /\bawait\b/);
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

test('the real launcher, on a Node below 22, prints the one line to stderr, exits 2, and loads nothing of the CLI', () => {
  for (const version of ['21.7.3', '20.11.1', '18.19.0']) {
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

test('the real launcher, on a Node below 22, lets a hook finish with exit 0 and the same line on stderr', () => {
  for (const event of ['stop', 'session-start']) {
    const r = launch(['hook', event], { version: '20.11.1', env: { LANG: 'C' }, input: JSON.stringify({ cwd: KIT_ROOT }) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, '', 'nothing a session could read as the hook\'s answer');
    assert.equal(r.stderr, `${EN('20.11.1')}\n`);
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

// The floor itself, and the Node 22 the suite was measured on: neither is a
// reason to refuse, and neither prints a word before the CLI's own output.
test('the real launcher, on exactly Node 22.0.0 and on 22.22.1, runs the CLI as usual', () => {
  for (const version of ['22.0.0', '22.22.1']) {
    const r = launch(['--version'], { version });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${kitVersion()}\n`);
    assert.equal(r.stderr, '', version);
    const hook = launch(['hook', 'nope'], { version, input: '{}' });
    assert.equal(hook.status, EXIT.USAGE, 'a hook on a good Node is the CLI\'s own, unknown event and all');
    assert.match(hook.stderr, /nope/);
  }
});
