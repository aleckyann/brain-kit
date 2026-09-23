// `brain-kit init`: the one command that gives a person who is not the
// maintainer a working vault. What this file proves, each on a temporary
// directory:
//
// - both languages produce, from an answers file, a vault on which
//   `validate` and `lint --base all` exit 0, and init itself exits 0;
// - a directory that is not empty, one that is a repository, one that is
//   a vault, and an empty directory INSIDE a vault are each refused with
//   exit 2 and NOTHING written, proved by listing the directory (names,
//   modes and content hashes) before and after, and by the state
//   directory not existing afterwards;
// - with stdin closed or never closed, and no --yes or --from-answers,
//   init does not wait: it exits 2 within a second naming the first
//   missing answer;
// - --yes uses every default and says so;
// - a target path with a space, an accented letter and a single quote
//   works end to end, including the installed hook refusing a push of a
//   committed credential;
// - machine.json lands in the state directory with mode 0600, the state
//   directory has mode 0700, and neither is inside the vault;
// - the versioned configuration carries no machine-only key.
//
// Example data: the fictional owner Ana, example.com / example.invalid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join, relative, isAbsolute } from 'node:path';
import { KIT_ROOT, kitVersion } from '../src/version.mjs';
import { CONFIG_FILENAME, MACHINE_FILENAME, findMachineOnlyKeys, validateConfig, validateMachine } from '../src/config.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator, LANG_VARIABLES } from '../src/lang.mjs';
import { LINT_RULES } from '../src/rules/lint.mjs';
import { walkVault } from '../src/vault.mjs';
import { splitFrontmatter, readMapping } from '../src/frontmatter.mjs';
import { completeDefaults } from '../src/init/config.mjs';
import { resolveClaudeBin, defaultAnswers, invalidAnswer } from '../src/init/answers.mjs';
import { ROOT_CONTRACT_FILES, HOOK_PATH, isInside, stampGenerated, writeVault } from '../src/init/skeleton.mjs';
import { runInit, worseExit } from '../src/commands/init.mjs';
import { MANIFEST_PATH, readManifest } from '../src/manifest.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const TEMPLATE_HOOK = join(KIT_ROOT, 'templates', 'githooks', 'pre-push');
const SEED_STAMP = '2026-09-22T00:00:00+00:00';

// Independent answers: no answer is derivable from another, so a field
// filled from the wrong answer cannot pass by coincidence.
const ANSWERS = Object.freeze({
  en: Object.freeze({
    lang: 'en',
    name: 'Ana Souza',
    handle: 'asouza',
    title: 'Field Notes',
    repo: 'acme-notes/vault',
    private: true,
    timezone: 'Europe/Lisbon',
  }),
  'pt-BR': Object.freeze({
    lang: 'pt-BR',
    name: 'Ana Lima',
    handle: 'alima',
    title: 'Anota' + String.fromCharCode(0xe7) + String.fromCharCode(0xf5) + 'es',
    repo: null,
    private: true,
    timezone: 'America/Sao_Paulo',
  }),
});

// A fictional identity for the commits these tests make in their own
// throwaway repositories; never this repository's.
const TEST_GIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'Ana Souza',
  GIT_AUTHOR_EMAIL: 'ana@example.invalid',
  GIT_COMMITTER_NAME: 'Ana Souza',
  GIT_COMMITTER_EMAIL: 'ana@example.invalid',
});

function skeletonFiles(lang) {
  return listFiles(join(KIT_ROOT, 'lang', lang, 'vault'));
}

function listFiles(root, rel = '') {
  const out = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(root, path));
    else out.push(path);
  }
  return out.sort();
}

// Everything under `root`, dot-entries and .git included: path, kind,
// mode and, for a file, the hash of its bytes. Two equal listings mean
// nothing was created, removed, rewritten or re-permissioned.
function snapshot(root) {
  if (!existsSync(root)) return ['<absent>'];
  const out = [];
  const walk = (rel) => {
    const abs = rel === '' ? root : join(root, rel);
    const st = lstatSync(abs);
    const mode = (st.mode & 0o7777).toString(8);
    if (st.isDirectory()) {
      out.push(`${rel || '.'} dir ${mode}`);
      for (const name of readdirSync(abs).sort()) walk(rel === '' ? name : `${rel}/${name}`);
    } else {
      const hash = st.isFile() ? createHash('sha256').update(readFileSync(abs)).digest('hex') : 'link';
      out.push(`${rel} file ${mode} ${hash}`);
    }
  };
  walk('');
  return out;
}

// Every run gets its own scratch area: the target, a state directory
// beside it, and an EMPTY working directory, also beside it, that the
// command runs from. No test ever runs init from the kit's own checkout,
// so a regression that loses the directory argument writes into this
// scratch directory, where a listing sees it, instead of into the
// repository the suite runs from.
function freshTarget(prefix = 'brain-kit-init-') {
  const base = makeTempDir(prefix);
  const cwd = join(base, 'cwd');
  mkdirSync(cwd);
  return { base, vault: join(base, 'vault'), state: join(base, 'state'), cwd };
}

function testEnv(state, extra = {}) {
  return { ...process.env, BRAIN_KIT_LANG: 'en', BRAIN_KIT_STATE_DIR: state, USER: 'ana', LOGNAME: 'ana', TZ: 'UTC', ...TEST_GIT_ENV, ...extra };
}

function brainKit(args, { env, cwd = makeTempDir('brain-kit-init-cwd-'), stdio } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, cwd, stdio });
}

function writeAnswers(base, answers, name = 'answers.json') {
  const file = join(base, name);
  writeFileSync(file, `${JSON.stringify(answers, null, 2)}\n`);
  return file;
}

function git(cwd, args, env = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...TEST_GIT_ENV, ...env } });
}

function readConfig(vault) {
  return JSON.parse(readFileSync(join(vault, CONFIG_FILENAME), 'utf8'));
}

function collector() {
  let text = '';
  return { write(chunk) { text += chunk; return true; }, get text() { return text; } };
}

// A stdin that claims to be a terminal and replays `lines`, then ends, so
// the interactive path can be driven without a real terminal.
function fakeTty(lines, { end = true } = {}) {
  const stream = new PassThrough();
  stream.isTTY = true;
  for (const line of lines) stream.write(`${line}\n`);
  if (end) stream.end();
  return stream;
}

async function initDirect(argv, { stdin = fakeTty([], { end: true }), env, checks, cwd = makeTempDir('brain-kit-init-cwd-') } = {}) {
  const stdout = collector();
  const stderr = collector();
  const code = await runInit(argv, { stdin, stdout, stderr }, createTranslator('en'), { walkVault, env, checks, cwd });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

// --- the main run, per language ----------------------------------------------

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: init --from-answers builds a vault that validate and lint --base all pass, and exits 0`, () => {
    const { base, vault, state } = freshTarget();
    const file = writeAnswers(base, ANSWERS[lang]);
    const before = Date.now();
    const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
    const after = Date.now();
    assert.equal(r.status, EXIT.OK, `init failed:\n${r.stdout}\n${r.stderr}`);

    // validate and lint, run again on their own, pass, having read every note.
    const v = brainKit(['validate', vault, '--json'], { env: testEnv(state) });
    assert.equal(v.status, EXIT.OK, v.stdout + v.stderr);
    const l = brainKit(['lint', vault, '--base', 'all', '--json'], { env: testEnv(state) });
    assert.equal(l.status, EXIT.OK, l.stdout + l.stderr);

    // Every skeleton file landed, and nothing of the skeleton is missing.
    const written = listFiles(vault).filter((p) => !p.startsWith('.git/'));
    for (const file of skeletonFiles(lang)) assert.ok(written.includes(file), `${file} not written`);
    assert.ok(skeletonFiles(lang).length >= 25, 'the skeleton listing must be non-trivial');

    // The configuration: completed from THESE answers, stamped with this
    // kit's version, valid, and free of machine-only keys.
    const config = readConfig(vault);
    const defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
    assert.deepEqual(config, completeDefaults(defaults, ANSWERS[lang], { kitVersion: kitVersion() }));
    assert.equal(config.kit_version, kitVersion());
    assert.deepEqual(validateConfig(config), []);
    assert.deepEqual(findMachineOnlyKeys(config), []);
    assert.equal(config.owner.email, null, 'init does not ask for an e-mail, so none is written');

    // Every note's generated.at is the moment of init, not the seed's.
    let stamped = 0;
    for (const file of skeletonFiles(lang).filter((p) => p.endsWith('.md'))) {
      const { frontmatter } = splitFrontmatter(readFileSync(join(vault, file), 'utf8'));
      const generated = frontmatter === null ? null : readMapping(frontmatter, 'generated');
      if (!generated) continue;
      assert.notEqual(generated.at, SEED_STAMP, `${file} kept the seed timestamp`);
      const at = Date.parse(generated.at);
      assert.ok(at >= Math.floor(before / 1000) * 1000 && at <= after, `${file}: ${generated.at} is not the moment of init`);
      assert.match(generated.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
      stamped++;
    }
    const seededWithGenerated = skeletonFiles(lang).filter((p) => p.endsWith('.md') && /^generated:/m.test(readFileSync(join(KIT_ROOT, 'lang', lang, 'vault', p), 'utf8')));
    assert.equal(stamped, seededWithGenerated.length);
    assert.ok(stamped >= 15, `expected at least 15 stamped notes, found ${stamped}`);

    // The manifest: the hook, .gitignore and the root contract files
    // managed, every other skeleton file seeded, each hash the bytes on
    // disk NOW. The configuration is the person's, and not recorded.
    const manifest = readManifest(vault);
    const byPath = new Map(manifest.files.map((f) => [f.path, f]));
    assert.equal(manifest.files.length, skeletonFiles(lang).length + 2);
    assert.equal(byPath.get(HOOK_PATH).class, 'managed');
    assert.equal(byPath.get('.gitignore').class, 'managed');
    assert.equal(byPath.has(CONFIG_FILENAME), false);
    for (const file of ROOT_CONTRACT_FILES) assert.equal(byPath.get(file)?.class, 'managed', file);
    for (const file of skeletonFiles(lang)) {
      if (!ROOT_CONTRACT_FILES.includes(file)) assert.equal(byPath.get(file)?.class, 'seeded', file);
    }
    for (const entry of manifest.files) {
      assert.equal(entry.sha256, createHash('sha256').update(readFileSync(join(vault, entry.path))).digest('hex'), entry.path);
    }

    // The hook, byte for byte, executable; the repository, pointed at it;
    // and no commit, because the first commit is the person's.
    assert.deepEqual(readFileSync(join(vault, HOOK_PATH)), readFileSync(TEMPLATE_HOOK));
    assert.equal(statSync(join(vault, HOOK_PATH)).mode & 0o111, 0o111);
    assert.ok(existsSync(join(vault, '.git')));
    assert.equal(git(vault, ['config', 'core.hooksPath']).stdout.trim(), '.githooks');
    assert.notEqual(git(vault, ['rev-parse', '--verify', '-q', 'HEAD']).status, 0, 'no commit by default');
    assert.match(r.stdout, /commit/i);

    // .gitignore: dependencies and the machine-local classes, commented.
    const ignore = readFileSync(join(vault, '.gitignore'), 'utf8').split('\n');
    assert.ok(ignore.includes('node_modules/'));
    assert.ok(ignore.includes('.env'));
    assert.ok(ignore.filter((line) => line.startsWith('# ')).length >= 3);
  });
}

// --- refusals: nothing written --------------------------------------------------

function assertRefusedUntouched(r, watched, pattern) {
  assert.equal(r.status ?? r.code, EXIT.USAGE, `expected exit 2:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, pattern);
  for (const [dir, before] of watched) assert.deepEqual(snapshot(dir), before, `${dir} changed`);
}

test('a directory that is not empty is refused with exit 2, and nothing is written', () => {
  const { base, vault, state } = freshTarget();
  mkdirSync(vault);
  writeFileSync(join(vault, 'thesis.txt'), 'a person\'s file\n');
  const file = writeAnswers(base, ANSWERS.en);
  const watched = [[vault, snapshot(vault)], [state, snapshot(state)]];
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
  assertRefusedUntouched(r, watched, /not empty/);
});

test('a directory holding only a dot-file is not empty, and is refused', () => {
  const { base, vault, state } = freshTarget();
  mkdirSync(vault);
  writeFileSync(join(vault, '.env'), 'X=1\n');
  const file = writeAnswers(base, ANSWERS.en);
  const watched = [[vault, snapshot(vault)], [state, snapshot(state)]];
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
  assertRefusedUntouched(r, watched, /not empty/);
});

test('a directory that is already a repository is refused with exit 2, and nothing is written', () => {
  const { base, vault, state } = freshTarget();
  assert.equal(spawnSync('git', ['init', '-q', vault]).status, 0);
  const file = writeAnswers(base, ANSWERS.en);
  const watched = [[vault, snapshot(vault)], [state, snapshot(state)]];
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
  assertRefusedUntouched(r, watched, /already a git repository/);
});

test('a directory that is already a vault is refused with exit 2, and nothing is written', () => {
  const { base, vault, state } = freshTarget();
  const file = writeAnswers(base, ANSWERS.en);
  assert.equal(brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) }).status, 0);
  const secondState = join(base, 'state-2');
  const watched = [[vault, snapshot(vault)], [state, snapshot(state)], [secondState, snapshot(secondState)]];
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(secondState) });
  assertRefusedUntouched(r, watched, /already a brain-kit vault/);
});

test('a vault that is not yet a repository, with only its configuration, is refused as a vault', () => {
  const { base, vault, state } = freshTarget();
  mkdirSync(vault);
  writeFileSync(join(vault, CONFIG_FILENAME), '{}\n');
  const file = writeAnswers(base, ANSWERS.en);
  const watched = [[vault, snapshot(vault)], [state, snapshot(state)]];
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
  assertRefusedUntouched(r, watched, /already a brain-kit vault/);
});

test('an empty directory, or a new one, INSIDE a vault is refused with exit 2, and nothing is written', () => {
  const { base, vault, state } = freshTarget();
  const file = writeAnswers(base, ANSWERS.en);
  assert.equal(brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) }).status, 0);
  mkdirSync(join(vault, 'drafts'));
  for (const target of [join(vault, 'drafts'), join(vault, 'drafts', 'new', 'deeper')]) {
    const secondState = join(base, `state-${target.length}`);
    const watched = [[vault, snapshot(vault)], [secondState, snapshot(secondState)]];
    const r = brainKit(['init', target, '--from-answers', file], { env: testEnv(secondState) });
    assertRefusedUntouched(r, watched, /inside the brain-kit vault/);
  }
});

test('a target that is a file is refused with exit 2, and the file is untouched', () => {
  const { base, state } = freshTarget();
  const target = join(base, 'notes.md');
  writeFileSync(target, '# mine\n');
  const file = writeAnswers(base, ANSWERS.en);
  const watched = [[base, snapshot(base)]];
  const r = brainKit(['init', target, '--from-answers', file], { env: testEnv(state) });
  assertRefusedUntouched(r, watched, /not a directory/);
});

test('a target that is a dangling symbolic link, or lies under one, is refused with exit 2', () => {
  const { base, state } = freshTarget();
  symlinkSync(join(base, 'nowhere'), join(base, 'dangling'));
  const file = writeAnswers(base, ANSWERS.en);
  for (const target of [join(base, 'dangling'), join(base, 'dangling', 'vault')]) {
    const watched = [[base, snapshot(base)]];
    const r = brainKit(['init', target, '--from-answers', file], { env: testEnv(state) });
    assertRefusedUntouched(r, watched, /not a directory/);
  }
});

test('a state directory that already holds a machine.json is refused, and neither it nor the vault is written', () => {
  const { base, vault, state } = freshTarget();
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(state, MACHINE_FILENAME), '{"claude_bin": "/opt/mine/claude"}\n', { mode: 0o600 });
  const file = writeAnswers(base, ANSWERS.en);
  const watched = [[vault, snapshot(vault)], [state, snapshot(state)]];
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
  assertRefusedUntouched(r, watched, /machine\.json/);
});

test('a state directory inside the target vault is refused, and nothing is written', () => {
  const { base, vault } = freshTarget();
  const state = join(vault, '.state');
  const file = writeAnswers(base, ANSWERS.en);
  const watched = [[vault, snapshot(vault)]];
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
  assertRefusedUntouched(r, watched, /state directory/);
});

test('a state directory that IS the target vault is refused, and nothing is written', () => {
  const { base, vault } = freshTarget();
  const file = writeAnswers(base, ANSWERS.en);
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(vault) });
  assertRefusedUntouched(r, [[vault, ['<absent>']]], /state directory/);
});

test('a directory holding only a brain-kit manifest is already a vault, and is refused', () => {
  const { base, vault, state } = freshTarget();
  mkdirSync(join(vault, '.brain-kit'), { recursive: true });
  writeFileSync(join(vault, MANIFEST_PATH), '{"files": []}\n');
  const file = writeAnswers(base, ANSWERS.en);
  const watched = [[vault, snapshot(vault)], [state, snapshot(state)]];
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
  assertRefusedUntouched(r, watched, /already a brain-kit vault/);
});

test('without git on PATH, init exits 1 before writing anything', () => {
  const { base, vault, state } = freshTarget();
  const empty = join(base, 'empty-path');
  mkdirSync(empty);
  const file = writeAnswers(base, ANSWERS.en);
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state, { PATH: empty }) });
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.match(r.stderr, /git is not available/);
  assert.equal(existsSync(vault), false);
  assert.equal(existsSync(state), false);
});

test('a first commit that fails leaves the vault written, says so, and exits 3', () => {
  const { base, vault, state } = freshTarget();
  const file = writeAnswers(base, { ...ANSWERS.en, commit: true });
  // A global configuration that forbids guessing an identity, and none
  // given: the commit must fail. (Not GIT_CONFIG_COUNT: init removes the
  // repository-local git variables from what its git commands see.)
  const globalConfig = join(base, 'gitconfig');
  writeFileSync(globalConfig, '[user]\n\tuseConfigOnly = true\n');
  const env = testEnv(state, { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' });
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete env[key];
  const r = brainKit(['init', vault, '--from-answers', file], { env });
  assert.equal(r.status, EXIT.DEGRADED, r.stdout + r.stderr);
  assert.match(r.stderr, /the first commit failed/);
  assert.ok(existsSync(join(vault, CONFIG_FILENAME)));
  assert.notEqual(spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: vault, env }).status, 0);
});

// --- answers: never wait, never guess ------------------------------------------

function spawnTimed(args, env, stdinMode) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: [stdinMode, 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('close', (status) => {
      clearTimeout(killer);
      resolvePromise({ status, stdout, stderr, elapsed: Date.now() - started });
    });
    // A pipe opened and never written to or closed: a person's stdin
    // when a scheduler or another program runs init.
    if (stdinMode === 'pipe') child.stdin.on('error', () => {});
  });
}

for (const stdinMode of ['pipe', 'ignore']) {
  test(`stdin ${stdinMode === 'pipe' ? 'open and never closed' : 'closed'}, no --yes or --from-answers: exits 2 within a second naming the first missing answer`, async () => {
    const { vault, state } = freshTarget();
    const r = await spawnTimed(['init', vault], testEnv(state), stdinMode);
    assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
    assert.ok(r.elapsed < 1000 + 500, `took ${r.elapsed} ms`);
    assert.match(r.stderr, /"lang"/);
    assert.equal(existsSync(vault), false);
    assert.equal(existsSync(state), false);

    const withLang = await spawnTimed(['init', vault, '--lang', 'en'], testEnv(state), stdinMode);
    assert.equal(withLang.status, EXIT.USAGE);
    assert.match(withLang.stderr, /"name"/);
    assert.equal(existsSync(vault), false);
  });
}

test('an answers file missing an answer, with no terminal and no --yes, is refused naming that answer', () => {
  const { base, vault, state } = freshTarget();
  const { timezone, ...partial } = ANSWERS.en;
  const file = writeAnswers(base, partial);
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state), stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(r.status, EXIT.USAGE);
  assert.match(r.stderr, /"timezone"/);
  assert.equal(existsSync(vault), false);
  assert.equal(existsSync(state), false);
});

const BAD_FILES = [
  ['an unknown key', { ...ANSWERS.en, comit: true }, /unknown key "comit"/],
  ['a handle that is not a handle', { ...ANSWERS.en, handle: 'Ana S' }, /handle/],
  ['a time zone that does not exist', { ...ANSWERS.en, timezone: 'Mars/Olympus' }, /Mars\/Olympus/],
  ['a repository that is not owner/name', { ...ANSWERS.en, repo: 'vault' }, /repo/],
  ['an unsupported language', { ...ANSWERS.en, lang: 'fr' }, /fr/],
  ['an empty name', { ...ANSWERS.en, name: '' }, /name/],
  ['private declined', { ...ANSWERS.en, private: false }, /private/],
  ['private as a string', { ...ANSWERS.en, private: 'yes' }, /private/],
  ['commit as a string', { ...ANSWERS.en, commit: 'yes' }, /commit/],
  ['an array', [], /object/],
  ['null', null, /object/],
  ['an e-mail that is not one', { ...ANSWERS.en, email: 'not-an-email' }, /"email"/],
  ['a blank title', { ...ANSWERS.en, title: '   ' }, /"title"/],
];

for (const [name, answers, pattern] of BAD_FILES) {
  test(`an answers file with ${name} is refused with exit 2, and nothing is written`, () => {
    const { base, vault, state } = freshTarget();
    const file = writeAnswers(base, answers);
    const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
    assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
    assert.match(r.stderr, pattern);
    assert.equal(existsSync(vault), false);
    assert.equal(existsSync(state), false);
  });
}

test('an answers file that is not JSON, or does not exist, is refused with exit 2', () => {
  const { base, vault, state } = freshTarget();
  const broken = join(base, 'broken.json');
  writeFileSync(broken, '{ lang: en');
  for (const file of [broken, join(base, 'absent.json')]) {
    const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
    assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
    assert.equal(existsSync(vault), false);
  }
});

test('--lang that disagrees with the answers file is refused', () => {
  const { base, vault, state } = freshTarget();
  const file = writeAnswers(base, ANSWERS.en);
  const r = brainKit(['init', vault, '--lang', 'pt-BR', '--from-answers', file], { env: testEnv(state) });
  assert.equal(r.status, EXIT.USAGE);
  assert.equal(existsSync(vault), false);
});

test('an unknown option, or a flag without its value, is a usage error that writes nothing', () => {
  const { vault, state, cwd } = freshTarget();
  const cwdBefore = snapshot(cwd);
  for (const args of [
    ['init', vault, '--force'], ['init', vault, '--lang'], ['init', vault, '--from-answers'], ['init', vault, '--yes', '--from-answers'],
    ['init', vault, '--lang', 'fr', '--yes'], ['init', vault, 'second', '--yes'],
  ]) {
    const r = brainKit(args, { env: testEnv(state), cwd });
    assert.equal(r.status, EXIT.USAGE, `${args.join(' ')}\n${r.stderr}`);
    assert.equal(existsSync(vault), false);
    assert.deepEqual(snapshot(cwd), cwdBefore, `${args.join(' ')} wrote where init runs`);
    assert.equal(existsSync(join(cwd, 'second')), false);
  }
});

test('an unsupported --lang is named as such', () => {
  const { vault, state } = freshTarget();
  const r = brainKit(['init', vault, '--lang', 'fr', '--yes'], { env: testEnv(state) });
  assert.equal(r.status, EXIT.USAGE);
  assert.match(r.stderr, /"fr" is not a supported language/);
});

test('an argument that looks like an option is never taken for the directory', () => {
  const { state, cwd } = freshTarget();
  const before = snapshot(cwd);
  const r = brainKit(['init', '--force', '--yes'], { env: testEnv(state), cwd });
  assert.equal(r.status, EXIT.USAGE);
  assert.deepEqual(snapshot(cwd), before);
});

// The working directory is empty and the state directory is outside it,
// so a refusal skipped here would write a vault into it: nothing else
// masks the guard under test.
test('an unknown option is refused with exit 2 and nothing is written where init runs', () => {
  const { state, cwd } = freshTarget();
  const before = snapshot(cwd);
  const r = brainKit(['init', '--force', '--yes'], { env: testEnv(state), cwd });
  assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
  assert.match(r.stderr, /unexpected argument "--force"/);
  assert.deepEqual(snapshot(cwd), before);
  assert.equal(existsSync(state), false);
});

test('on a terminal, a flag missing its value and an unknown option are refused before any question, writing nothing', async () => {
  const lines = ['en', 'Ana Souza', 'asouza', 'Field Notes', '', 'y', 'UTC'];
  for (const argv of [['--from-answers'], ['elsewhere', '--from-answers'], ['--lang'], ['--force'], ['elsewhere', '--force']]) {
    const { state, cwd } = freshTarget();
    const before = snapshot(cwd);
    const r = await initDirect(argv, { stdin: fakeTty(lines), env: testEnv(state), cwd });
    assert.equal(r.code, EXIT.USAGE, `${argv.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '', `${argv.join(' ')}: no question may be asked`);
    assert.match(r.stderr, argv.includes('--force') ? /unexpected argument "--force"/ : /needs a value/);
    assert.deepEqual(snapshot(cwd), before, `${argv.join(' ')} wrote where init runs`);
    assert.equal(existsSync(join(cwd, 'elsewhere')), false);
    assert.equal(existsSync(state), false);
  }
});

test('--yes uses every default and says so, and makes no commit', () => {
  const { vault, state } = freshTarget();
  const r = brainKit(['init', vault, '--yes'], { env: testEnv(state), stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  const expected = defaultAnswers({ lang: 'en', env: testEnv(state) });
  assert.match(r.stdout, /--yes: using every default/);
  for (const key of ['lang', 'name', 'handle', 'title', 'repo', 'private', 'timezone']) {
    assert.match(r.stdout, new RegExp(`^  ${key}: `, 'm'), `the defaults line for ${key}`);
  }
  const config = readConfig(vault);
  assert.equal(expected.handle, 'ana');
  assert.equal(config.owner.handle, 'ana');
  assert.equal(config.owner.name, expected.name);
  assert.equal(config.vault.title, expected.title);
  assert.equal(config.vault.repo, null);
  assert.equal(config.vault.timezone, 'UTC');
  assert.equal(config.lang, 'en');
  assert.notEqual(git(vault, ['rev-parse', '--verify', '-q', 'HEAD']).status, 0);

  // An answer given on the command line is not a default, and is not listed as one.
  const other = freshTarget();
  const withLang = brainKit(['init', other.vault, '--yes', '--lang', 'pt-BR'], { env: testEnv(other.state), stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(withLang.status, EXIT.OK, withLang.stdout + withLang.stderr);
  assert.doesNotMatch(withLang.stdout, /^  lang: /m);
  assert.match(withLang.stdout, /^  handle: ana$/m);
  assert.equal(readConfig(other.vault).lang, 'pt-BR');
});

test('an answers file with commit: true makes exactly one commit, under the configured identity', () => {
  const { base, vault, state } = freshTarget();
  const file = writeAnswers(base, { ...ANSWERS.en, commit: true });
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  assert.equal(git(vault, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
  assert.equal(git(vault, ['log', '-1', '--format=%an <%ae>']).stdout.trim(), 'Ana Souza <ana@example.invalid>');
  assert.equal(git(vault, ['status', '--porcelain']).stdout, '', 'everything init wrote is in the commit');
});

// --- the interactive path ----------------------------------------------------

test('on a terminal, the questions come one at a time in order, a blank line takes the default, and a bad answer is asked again', async () => {
  const { vault, state } = freshTarget();
  const stdin = fakeTty(['en', 'Ana Souza', 'Ana S', 'asouza', 'Field Notes', '', '', 'Mars/Olympus', 'Europe/Lisbon']);
  const r = await initDirect([vault], { stdin, env: testEnv(state) });
  assert.equal(r.code, EXIT.OK, r.stdout + r.stderr);
  const order = ['Language', 'First name', 'Handle', 'Vault title', 'GitHub repository', 'private', 'Time zone'];
  let at = -1;
  for (const label of order) {
    const index = r.stdout.indexOf(label, at + 1);
    assert.ok(index > at, `${label} asked out of order`);
    at = index;
  }
  assert.match(r.stdout, /people\/ and other personal directories/);
  const config = readConfig(vault);
  assert.equal(config.owner.handle, 'asouza');
  assert.equal(config.vault.repo, null);
  assert.equal(config.vault.private, true);
  assert.equal(config.vault.timezone, 'Europe/Lisbon');
  assert.equal((r.stdout + r.stderr).match(/Handle/g).length, 2, 'the bad handle is asked again');
});

test('on a terminal, declining the private repository refuses with exit 2 and writes nothing', async () => {
  const { vault, state } = freshTarget();
  const stdin = fakeTty(['en', 'Ana Souza', 'asouza', 'Field Notes', '', 'n', 'UTC']);
  const r = await initDirect([vault], { stdin, env: testEnv(state) });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.stderr, /must be private/);
  assert.equal(existsSync(vault), false);
  assert.equal(existsSync(state), false);
});

test('on a terminal, stdin ending before the last answer refuses with exit 2 naming it, and writes nothing', async () => {
  const { vault, state } = freshTarget();
  const stdin = fakeTty(['en', 'Ana Souza', 'asouza']);
  const r = await initDirect([vault], { stdin, env: testEnv(state) });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.stderr, /input ended before "title"/);
  assert.equal(existsSync(vault), false);
  assert.equal(existsSync(state), false);
});

test('on a terminal, a directory that is not empty is refused before a single question is asked', async () => {
  const { vault, state } = freshTarget();
  mkdirSync(vault);
  writeFileSync(join(vault, 'thesis.txt'), 'mine\n');
  const before = snapshot(vault);
  const r = await initDirect([vault], { stdin: fakeTty(['en']), env: testEnv(state) });
  assert.equal(r.code, EXIT.USAGE);
  assert.equal(r.stdout, '', 'no question may be asked');
  assert.deepEqual(snapshot(vault), before);
});

test('a directory that fills up while the questions are answered is refused just before writing', async () => {
  const { vault, state } = freshTarget();
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = collector();
  const stderr = collector();
  const pending = runInit([vault], { stdin, stdout, stderr }, createTranslator('en'), { walkVault, env: testEnv(state) });
  stdin.write('en\n');
  for (let i = 0; i < 200 && !stdout.text.includes('First name'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.match(stdout.text, /First name/);
  mkdirSync(vault);
  writeFileSync(join(vault, 'arrived.txt'), 'written by something else\n');
  const before = snapshot(vault);
  for (const line of ['Ana Souza', 'asouza', 'Field Notes', '', 'y', 'UTC']) stdin.write(`${line}\n`);
  stdin.end();
  const code = await pending;
  assert.equal(code, EXIT.USAGE, stdout.text + stderr.text);
  assert.match(stderr.text, /not empty/);
  assert.deepEqual(snapshot(vault), before);
  assert.equal(existsSync(state), false);
});

// --- the adversarial path, end to end ------------------------------------------

test('a target path with a space, an accented letter and a single quote works end to end, and its hook refuses a committed credential', () => {
  const accented = String.fromCharCode(0xe9);
  const base = makeTempDir('brain-kit-init-e2e-');
  const vault = join(base, `Ana's R${accented}sum${accented} notes`, 'vault');
  const state = join(base, `st${accented}te 'dir'`);
  const shims = join(base, 'shims');
  mkdirSync(shims);
  writeFileSync(join(shims, 'brain-kit'), `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} "$@"\n`);
  chmodSync(join(shims, 'brain-kit'), 0o755);
  const env = testEnv(state, { PATH: `${shims}${delimiter}${process.env.PATH}` });

  const file = writeAnswers(base, { ...ANSWERS['pt-BR'], commit: true });
  const r = brainKit(['init', vault, '--from-answers', file], { env });
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  const machine = JSON.parse(readFileSync(join(state, MACHINE_FILENAME), 'utf8'));
  assert.equal(machine.canonical_path, realpathSync(vault));

  const bare = join(base, `origin 'bare'.git`);
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(git(vault, ['remote', 'add', 'origin', bare], env).status, 0);
  const clean = git(vault, ['push', '-q', 'origin', 'HEAD'], env);
  assert.equal(clean.status, 0, `a clean vault must push:\n${clean.stderr}`);
  const pushedHead = git(bare, ['rev-parse', 'HEAD'], env).stdout.trim();

  // The environment file, force-added past the generated .gitignore.
  const fakeKey = `AKIA${'IOSFODNN7EXAMPL2'}`;
  writeFileSync(join(vault, '.env'), `AWS_ACCESS_KEY_ID=${fakeKey}\n`);
  assert.equal(git(vault, ['add', '-f', '.env'], env).status, 0);
  assert.equal(git(vault, ['commit', '-q', '-m', 'add env'], env).status, 0);
  const leak = git(vault, ['push', '-q', 'origin', 'HEAD'], env);
  // Deliberately no assertion on the hook's own wording: the template is
  // replaced by another task, and what init owns is that the hook it
  // installed runs and refuses, which the exit status and the remote show.
  assert.notEqual(leak.status, 0, 'a committed credential must refuse the push');
  assert.equal(git(bare, ['rev-parse', 'HEAD'], env).stdout.trim(), pushedHead, 'the credential never reached the remote');
});

// --- the agent guard, final review of slice 1D (I2) -----------------------------

test('I2: both shipped defaults switch the agent guard on', () => {
  for (const lang of ['en', 'pt-BR']) {
    const defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
    assert.equal(defaults.git.forbid_agent_push_to_default, true, lang);
  }
});

test('I2: in a vault init made, a push to the default branch under the agent identity is refused, and one to its own branch is not', () => {
  const base = makeTempDir('brain-kit-init-guard-');
  const vault = join(base, 'vault');
  const state = join(base, 'state');
  const shims = join(base, 'shims');
  mkdirSync(shims);
  writeFileSync(join(shims, 'brain-kit'), `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} "$@"\n`);
  chmodSync(join(shims, 'brain-kit'), 0o755);
  const env = testEnv(state, { PATH: `${shims}${delimiter}${process.env.PATH}` });
  const file = writeAnswers(base, { ...ANSWERS.en, commit: true });
  const r = brainKit(['init', vault, '--from-answers', file], { env });
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  const agent = readConfig(vault).git.agent_identity.email;
  const branch = git(vault, ['branch', '--show-current'], env).stdout.trim();
  const bare = join(base, 'origin.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(git(vault, ['remote', 'add', 'origin', bare], env).status, 0);
  assert.equal(git(vault, ['config', 'user.email', 'ana@example.invalid'], env).status, 0);
  const human = git(vault, ['push', '-q', 'origin', `HEAD:${branch}`], env);
  assert.equal(human.status, 0, human.stderr);
  const pushed = git(bare, ['rev-parse', branch], env).stdout.trim();

  assert.equal(git(vault, ['config', 'user.email', agent], env).status, 0);
  assert.equal(git(vault, ['commit', '-q', '--allow-empty', '-m', 'curate: an agent commit'], env).status, 0);
  const direct = git(vault, ['push', '-q', 'origin', `HEAD:${branch}`], env);
  assert.notEqual(direct.status, 0, 'an agent push to the default branch must be refused');
  assert.match(direct.stderr, /refusing a push to the default branch/);
  assert.equal(git(bare, ['rev-parse', branch], env).stdout.trim(), pushed, 'the default branch did not move');
  const own = git(vault, ['push', '-q', 'origin', 'HEAD:refs/heads/bot/proposal'], env);
  assert.equal(own.status, 0, own.stderr);
});

// --- the machine file ------------------------------------------------------

test('machine.json lands in the state directory with mode 0600, the directory with 0700, neither inside the vault', () => {
  const { base, vault, state } = freshTarget();
  const file = writeAnswers(base, ANSWERS.en);
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  const machinePath = join(state, MACHINE_FILENAME);
  assert.equal(statSync(machinePath).mode & 0o777, 0o600);
  assert.equal(statSync(state).mode & 0o777, 0o700);
  for (const path of [state, machinePath]) {
    const rel = relative(vault, path);
    assert.ok(rel.startsWith('..') || isAbsolute(rel), `${path} is inside the vault`);
  }
  assert.equal(listFiles(vault).some((p) => p.endsWith(MACHINE_FILENAME)), false);
  const machine = JSON.parse(readFileSync(machinePath, 'utf8'));
  assert.deepEqual(validateMachine(machine), []);
  assert.equal(machine.canonical_path, realpathSync(vault));
  assert.equal(machine.state_dir, state);
  assert.match(machine.vault_id, /^vault-[0-9a-f]{8}$/);
  assert.equal(machine.paths.lock, join(state, 'lock'));
  assert.equal(machine.paths.log_dir, join(state, 'logs'));
  assert.equal(typeof machine.claude_bin, 'string');
  assert.ok(machine.claude_bin.length > 0);
  // The versioned configuration carries none of it.
  const configText = readFileSync(join(vault, CONFIG_FILENAME), 'utf8');
  assert.deepEqual(findMachineOnlyKeys(JSON.parse(configText)), []);
  assert.equal(configText.includes(state), false);
});

test('claude_bin resolves from PATH to an absolute executable, or is the literal claude when absent', () => {
  const base = makeTempDir('brain-kit-init-claude-');
  const withClaude = join(base, 'with');
  const withoutExec = join(base, 'noexec');
  const empty = join(base, 'empty');
  for (const dir of [withClaude, withoutExec, empty]) mkdirSync(dir);
  writeFileSync(join(withClaude, 'claude'), '#!/bin/sh\n');
  chmodSync(join(withClaude, 'claude'), 0o755);
  writeFileSync(join(withoutExec, 'claude'), 'not executable\n');
  chmodSync(join(withoutExec, 'claude'), 0o644);
  mkdirSync(join(empty, 'claude'));
  assert.equal(resolveClaudeBin({ PATH: [empty, withoutExec, withClaude].join(delimiter) }), join(withClaude, 'claude'));
  assert.equal(resolveClaudeBin({ PATH: [empty, withoutExec].join(delimiter) }), 'claude');
  assert.equal(resolveClaudeBin({ PATH: '' }), 'claude');
  assert.equal(resolveClaudeBin({}), 'claude');
});

// --- the exit code -----------------------------------------------------------

test('worseExit picks the worse of two exit codes, in either order', () => {
  const cases = [
    [EXIT.OK, EXIT.OK, EXIT.OK],
    [EXIT.OK, EXIT.FAILURE, EXIT.FAILURE],
    [EXIT.FAILURE, EXIT.OK, EXIT.FAILURE],
    [EXIT.OK, EXIT.DEGRADED, EXIT.DEGRADED],
    [EXIT.DEGRADED, EXIT.FAILURE, EXIT.FAILURE],
    [EXIT.FAILURE, EXIT.DEGRADED, EXIT.FAILURE],
    [EXIT.FAILURE, EXIT.USAGE, EXIT.USAGE],
    [EXIT.USAGE, EXIT.OK, EXIT.USAGE],
    [EXIT.OK, 7, 7],
    [7, EXIT.OK, 7],
  ];
  for (const [a, b, expected] of cases) assert.equal(worseExit(a, b), expected, `${a} vs ${b}`);
});

for (const [validateCode, lintCode, expected] of [[1, 0, 1], [0, 1, 1], [0, 3, 3], [2, 0, 2], [0, 0, 0]]) {
  test(`init exits with the worse of validate (${validateCode}) and lint (${lintCode}): ${expected}`, async () => {
    const { base, vault, state } = freshTarget();
    const file = writeAnswers(base, ANSWERS.en);
    const calls = [];
    const checks = {
      validate: async (argv) => { calls.push(['validate', ...argv]); return validateCode; },
      lint: async (argv) => { calls.push(['lint', ...argv]); return lintCode; },
    };
    const r = await initDirect([vault, '--from-answers', file], { env: testEnv(state), checks });
    assert.equal(r.code, expected, r.stdout + r.stderr);
    assert.deepEqual(calls, [['validate', vault], ['lint', vault, '--base', 'all']]);
  });
}

// --- completeDefaults, extended ------------------------------------------------

test('completeDefaults stamps kit_version when given one, and keeps the defaults\' own otherwise', () => {
  const defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', 'en', 'config.defaults.json'), 'utf8'));
  const answers = { ...ANSWERS.en };
  assert.equal(completeDefaults(defaults, answers, { kitVersion: '9.8.7' }).kit_version, '9.8.7');
  assert.equal(completeDefaults(defaults, answers).kit_version, defaults.kit_version);
  assert.throws(() => completeDefaults(defaults, answers, { kitVersion: 3 }), TypeError);
});

// --- stamping ------------------------------------------------------------------

test('stampGenerated replaces only generated.at in the frontmatter, and throws on a form it cannot stamp', () => {
  const stamp = '2030-01-02T03:04:05+00:00';
  const note = `---\ntype: guide\ngenerated:\n  by: process:brain-kit-init\n  at: ${SEED_STAMP}\n---\n\nat: ${SEED_STAMP}\n`;
  assert.equal(stampGenerated(note, stamp), note.replace(`  at: ${SEED_STAMP}`, `  at: ${stamp}`));
  assert.equal(stampGenerated('# Log\n\nat: x\n', stamp), '# Log\n\nat: x\n');
  assert.throws(() => stampGenerated(`---\ntype: guide\ngenerated: { by: human:ana, at: ${SEED_STAMP} }\n---\n`, stamp));
});

test('invalidAnswer refuses a key it does not know', () => {
  assert.equal(invalidAnswer('comit', true), 'comit');
});

// writeVault's exclusive creates are the last layer under inspectTarget:
// a file that appears between the check and the write is never replaced.
for (const [name, rel] of [['a skeleton note', 'index.md'], ['the hook', HOOK_PATH], ['the manifest', MANIFEST_PATH]]) {
  test(`writeVault never replaces ${name} that already exists`, () => {
    const target = join(makeTempDir('brain-kit-init-excl-'), 'vault');
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    writeFileSync(join(target, rel), 'a person\'s own bytes\n');
    assert.throws(() => writeVault(target, { lang: 'en', stamp: '2030-01-02T03:04:05+00:00', files: {} }));
    assert.equal(readFileSync(join(target, rel), 'utf8'), 'a person\'s own bytes\n');
  });
}

// A git that answers --version but fails a later step: init must not
// report success over a vault with no repository or no hook path.
function realGit() {
  for (const dir of String(process.env.PATH).split(delimiter)) {
    const candidate = join(dir, 'git');
    if (dir !== '' && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error('git not found on PATH');
}

// A git shim that answers --version and passes everything through except
// the one subcommand under test, which fails after running `before`.
function failingGit(base, failing, before = '') {
  const shims = join(base, 'shims');
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(shims, 'git'), `#!/usr/bin/env bash\nif [ "$1" = ${JSON.stringify(failing)} ]; then ${before} echo "refused by the test" >&2; exit 1; fi\nexec ${JSON.stringify(realGit())} "$@"\n`);
  chmodSync(join(shims, 'git'), 0o755);
  return `${shims}${delimiter}${process.env.PATH}`;
}

for (const failing of ['init', 'config']) {
  test(`a failing git ${failing} rolls back everything init created, says so, and exits 1`, () => {
    const { base, vault, state } = freshTarget();
    const file = writeAnswers(base, ANSWERS.en);
    const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state, { PATH: failingGit(base, failing) }) });
    assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`git ${failing}[^\\n]* failed: refused by the test`));
    assert.match(r.stderr, /Everything this run had created was removed/);
    assert.equal(existsSync(vault), false, 'the half vault is gone');
    assert.equal(existsSync(state), false, 'the state directory init made is gone');
    // And nothing stops the next run, as a half vault would.
    const again = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
    assert.equal(again.status, EXIT.OK, again.stdout + again.stderr);
  });
}

test('a failing git init under two directory levels init itself made removes both levels', () => {
  const { base, state } = freshTarget();
  const vault = join(base, 'new parent', 'vault');
  const file = writeAnswers(base, ANSWERS.en);
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state, { PATH: failingGit(base, 'init') }) });
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.match(r.stderr, /Everything this run had created was removed/);
  assert.equal(existsSync(join(base, 'new parent')), false);
});

for (const failing of ['init', 'config']) {
  test(`a failing git ${failing} into an EXISTING empty directory leaves it empty, .git included, as it was found`, () => {
    const { base, vault, state } = freshTarget();
    mkdirSync(vault, { mode: 0o750 });
    chmodSync(vault, 0o750);
    const before = snapshot(vault);
    const file = writeAnswers(base, ANSWERS.en);
    const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state, { PATH: failingGit(base, failing) }) });
    assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
    assert.deepEqual(snapshot(vault), before);
  });
}

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

test('an unwritable state home is found before a byte of the vault is written, and exits 1 with a sentence', { skip: IS_ROOT && 'root ignores permissions' }, () => {
  const { base, vault } = freshTarget();
  const xdg = join(base, 'xdg');
  mkdirSync(xdg);
  chmodSync(xdg, 0o500);
  try {
    const file = writeAnswers(base, ANSWERS.en);
    // A git that leaves a mark whenever it is asked to create a
    // repository: the state is proved before the vault, so it never is.
    const marker = join(base, 'git-init-ran');
    const shims = join(base, 'marking-shims');
    mkdirSync(shims);
    writeFileSync(join(shims, 'git'), `#!/usr/bin/env bash\nif [ "$1" = init ]; then : > ${JSON.stringify(marker)}; fi\nexec ${JSON.stringify(realGit())} "$@"\n`);
    chmodSync(join(shims, 'git'), 0o755);
    const env = testEnv('', { XDG_STATE_HOME: xdg, PATH: `${shims}${delimiter}${process.env.PATH}` });
    delete env.BRAIN_KIT_STATE_DIR;
    const r = brainKit(['init', vault, '--from-answers', file], { env });
    assert.equal(existsSync(marker), false, 'git init ran before the state directory was proved writable');
    assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot create the state directory or write machine\.json/);
    assert.match(r.stderr, /nothing was written into the vault/);
    assert.equal(existsSync(vault), false);
    assert.deepEqual(readdirSync(xdg), []);
  } finally {
    chmodSync(xdg, 0o700);
  }
});

test('a write failing midway (a file-size limit standing in for a full disk) rolls back everything, and exits 1', () => {
  const { base, vault, state } = freshTarget();
  const file = writeAnswers(base, ANSWERS.en);
  // 8 KiB: the skeleton notes fit, the configuration (about 9 KiB) does not.
  const r = spawnSync('bash', ['-c', 'ulimit -f 8; exec "$0" "$@"', process.execPath, BIN, 'init', vault, '--from-answers', file], {
    encoding: 'utf8', env: testEnv(state), cwd: base,
  });
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.match(r.stderr, /EFBIG/);
  assert.match(r.stderr, /Everything this run had created was removed/);
  assert.equal(existsSync(vault), false);
  assert.equal(existsSync(state), false);
});

test('a write failing midway into an EXISTING empty directory removes even the file cut short, leaving it as found', () => {
  const { base, vault, state } = freshTarget();
  mkdirSync(vault);
  const before = snapshot(vault);
  const file = writeAnswers(base, ANSWERS.en);
  const r = spawnSync('bash', ['-c', 'ulimit -f 8; exec "$0" "$@"', process.execPath, BIN, 'init', vault, '--from-answers', file], {
    encoding: 'utf8', env: testEnv(state), cwd: base,
  });
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.deepEqual(snapshot(vault), before, 'brain-kit.config.json, cut short at the limit, must not survive');
});

test('when the rollback itself fails, init names what it left behind', { skip: IS_ROOT && 'root ignores permissions' }, () => {
  const { base, vault, state } = freshTarget();
  const file = writeAnswers(base, ANSWERS.en);
  // git init runs inside the new vault; the shim locks core/ first, so
  // the notes in it cannot be removed.
  const PATH = failingGit(base, 'init', 'chmod 0500 core;');
  try {
    const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state, { PATH }) });
    assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
    assert.match(r.stderr, /Removing what this run had created failed for: /);
    assert.ok(r.stderr.includes(join(vault, 'core', 'identity.md')), r.stderr);
    assert.doesNotMatch(r.stderr, /Everything this run had created was removed/);
  } finally {
    if (existsSync(join(vault, 'core'))) chmodSync(join(vault, 'core'), 0o755);
  }
});

// --- the real validate and lint, not injected ----------------------------------

const KEY_TITLE = `Notes ${'AKIA'}${'IOSFODNN7EXAMPL2'}`;

test('a credential-shaped answer makes init exit 1 through the REAL lint, naming the configuration', () => {
  const { base, vault, state } = freshTarget();
  const file = writeAnswers(base, { ...ANSWERS.en, title: KEY_TITLE });
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.match(r.stdout, /brain-kit\.config\.json:\d+ {2}secrets\b/);
});

test('the first commit, when asked for, is not made over a vault that fails lint, and the output says why', () => {
  const { base, vault, state } = freshTarget();
  const file = writeAnswers(base, { ...ANSWERS.en, title: KEY_TITLE, commit: true });
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.match(r.stderr, /The first commit was not made, because validate or lint found a problem/);
  assert.notEqual(git(vault, ['rev-parse', '--verify', '-q', 'HEAD']).status, 0, 'nothing reached history');
});

// validate through the REAL wiring. No answer reaches a note, so the only
// way to make validate fail on what init writes, with lint still clean,
// is the clock the notes are stamped from: a year past 9999 has no
// four-digit ISO form, and validate (not lint) judges timestamps.
test('a vault that fails the REAL validate, with lint clean, makes init exit 1', async () => {
  const { base, vault, state } = freshTarget();
  const file = writeAnswers(base, ANSWERS.en);
  const stdout = collector();
  const stderr = collector();
  const code = await runInit([vault, '--from-answers', file], { stdin: fakeTty([]), stdout, stderr }, createTranslator('en'), {
    walkVault, env: testEnv(state), cwd: base, now: () => new Date('+010000-01-01T00:00:00Z'),
  });
  assert.equal(code, EXIT.FAILURE, stdout.text + stderr.text);
  assert.match(stdout.text, /findings above \(guidance or house rules\) block this run/);
  assert.match(stdout.text, /Totals: 0 error\(s\), 0 warning\(s\)/, 'lint itself was clean');
});

// Every lint rule raised to error, each keeping its own settings.
function everyRuleAtError(config) {
  const lint = { ...config.lint };
  for (const { settingKey } of LINT_RULES) {
    const current = lint[settingKey];
    lint[settingKey] = current !== null && typeof current === 'object' ? { ...current, severity: 'error' } : 'error';
  }
  return { ...config, lint };
}

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: what init writes passes lint --base all with every rule at error, and validate`, () => {
    const { base, vault, state } = freshTarget();
    const file = writeAnswers(base, ANSWERS[lang]);
    assert.equal(brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) }).status, EXIT.OK);
    writeFileSync(join(vault, CONFIG_FILENAME), `${JSON.stringify(everyRuleAtError(readConfig(vault)), null, 2)}\n`);
    const v = brainKit(['validate', vault, '--json'], { env: testEnv(state) });
    assert.equal(v.status, EXIT.OK, v.stdout + v.stderr);
    const l = brainKit(['lint', vault, '--base', 'all', '--json'], { env: testEnv(state) });
    assert.equal(l.status, EXIT.OK, l.stdout + l.stderr);
    const report = JSON.parse(l.stdout);
    assert.deepEqual(report.findings, [], JSON.stringify(report.findings));
    assert.deepEqual(report.counts, { error: 0, warn: 0, defect: 0, skipped: 0 });
    assert.equal(report.scope.base, 'all');
    assert.equal(report.scope.files, skeletonFiles(lang).filter((p) => p.endsWith('.md')).length, 'every note was read');
  });
}

// --- the inside check, the privacy question, unreadable and closed ---------------

test('isInside: the same path and a first segment starting with ".." are inside; a sibling and the parent are not', () => {
  const vault = join(makeTempDir('brain-kit-inside-'), 'vault');
  assert.equal(isInside(vault, vault), true);
  assert.equal(isInside(join(vault, '..state'), vault), true);
  assert.equal(isInside(join(vault, '..state', 'x'), vault), true);
  assert.equal(isInside(join(dirname(vault), 'state'), vault), false);
  assert.equal(isInside(dirname(vault), vault), false);
});

test('a state directory inside the vault whose name starts with ".." is refused', () => {
  const { base, vault } = freshTarget();
  const file = writeAnswers(base, ANSWERS.en);
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(join(vault, '..state')) });
  assertRefusedUntouched(r, [[vault, ['<absent>']]], /state directory/);
});

test('on a terminal, a garbled answer to the private-repository question is asked again, never read as yes', async () => {
  const { vault, state } = freshTarget();
  const stdin = fakeTty(['en', 'Ana Souza', 'asouza', 'Field Notes', '', 'maybe', 'n', 'UTC']);
  const r = await initDirect([vault], { stdin, env: testEnv(state) });
  assert.equal(r.code, EXIT.USAGE, 'the second answer, "n", decides: refused');
  assert.equal(r.stdout.match(/Confirm it will be private/g).length, 2);
  assert.match(r.stdout, /not a valid answer for "private"/);
  assert.equal(existsSync(vault), false);
});

test('a target init cannot list is a translated refusal with exit 2', { skip: IS_ROOT && 'root ignores permissions' }, () => {
  const { base, vault, state } = freshTarget();
  mkdirSync(vault);
  chmodSync(vault, 0o300);
  try {
    const file = writeAnswers(base, ANSWERS.en);
    const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
    assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot be listed \(EACCES\)/);
    assert.equal(existsSync(state), false);
  } finally {
    chmodSync(vault, 0o700);
  }
  assert.deepEqual(readdirSync(vault), []);
});

test('a genuinely closed stdin (descriptor 0 closed, not /dev/null) exits 2 at once, naming the first missing answer', () => {
  const { vault, state } = freshTarget();
  const started = Date.now();
  const r = spawnSync('bash', ['-c', 'exec "$0" "$@" <&-', process.execPath, BIN, 'init', vault], {
    encoding: 'utf8', env: testEnv(state), cwd: makeTempDir('brain-kit-init-cwd-'),
  });
  assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
  assert.ok(Date.now() - started < 1500);
  assert.match(r.stderr, /"lang"/);
  assert.equal(existsSync(vault), false);
});

// --- the language, from one function for the CLI and the default --------------

function localeEnv(state, vars) {
  const env = testEnv(state);
  for (const name of LANG_VARIABLES) delete env[name];
  return { ...env, ...vars };
}

for (const [vars, lang] of [
  [{ LANG: 'pt_BR.UTF-8' }, 'pt-BR'],
  [{ LANG: 'en_US.UTF-8' }, 'en'],
  [{ LC_ALL: 'C', LANG: 'pt_BR.UTF-8' }, 'en'],
  [{ LC_MESSAGES: 'pt_PT.UTF-8', LANG: 'en_US.UTF-8' }, 'pt-BR'],
  [{}, 'en'],
]) {
  test(`with ${JSON.stringify(vars)}, init --yes asks nothing in one language and defaults to another: both are ${lang}`, () => {
    const { vault, state } = freshTarget();
    const r = brainKit(['init', vault, '--yes'], { env: localeEnv(state, vars), stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
    assert.equal(readConfig(vault).lang, lang);
    assert.match(r.stdout, lang === 'pt-BR' ? /^--yes: usando o padr/m : /^--yes: using every default/m);
  });
}

test('the CLI\'s own messages follow the same resolution as init\'s default', () => {
  const pt = brainKit(['nope'], { env: localeEnv('', { LANG: 'pt_BR.UTF-8' }) });
  const en = brainKit(['nope'], { env: localeEnv('', { LC_ALL: 'POSIX', LANG: 'pt_BR.UTF-8' }) });
  assert.equal(pt.status, EXIT.USAGE);
  assert.equal(en.status, EXIT.USAGE);
  assert.match(en.stderr, /unknown command/);
  assert.doesNotMatch(pt.stderr, /unknown command/);
  assert.match(pt.stderr, /^Uso: brain-kit/m, 'the Portuguese usage text');
});

// --- nested inside another repository ------------------------------------------

test('an empty target inside another repository is accepted, with one line naming that repository', () => {
  const { base, state } = freshTarget();
  const outer = join(base, 'dotfiles');
  assert.equal(spawnSync('git', ['init', '-q', outer]).status, 0);
  const vault = join(outer, 'notes', 'vault');
  const file = writeAnswers(base, ANSWERS.en);
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state) });
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  const lines = r.stdout.split('\n').filter((line) => line.includes('nested inside another git repository'));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(realpathSync(outer)), lines[0]);

  const alone = freshTarget();
  const r2 = brainKit(['init', alone.vault, '--from-answers', writeAnswers(alone.base, ANSWERS.en)], { env: testEnv(alone.state) });
  assert.equal(r2.status, EXIT.OK);
  assert.doesNotMatch(r2.stdout, /nested inside another git repository/);
});

// --- fix round 2 --------------------------------------------------------------

function refsOf(gitDir) {
  const r = spawnSync('git', ['--git-dir', gitDir, 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8', env: withoutGitVars() });
  return `${r.stdout}|${readFileSync(join(gitDir, 'HEAD'), 'utf8')}`;
}

function withoutGitVars() {
  const env = { ...process.env, ...TEST_GIT_ENV };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  return env;
}

test('with GIT_DIR (and GIT_INDEX_FILE) exported for another repository, init leaves that repository byte-identical and gives the vault its own .git', () => {
  const { base, vault, state } = freshTarget();
  const foreign = join(base, 'dotfiles');
  assert.equal(spawnSync('git', ['init', '-q', foreign], { env: withoutGitVars() }).status, 0);
  writeFileSync(join(foreign, 'a'), 'tracked by the other repository\n');
  assert.equal(git(foreign, ['add', 'a'], withoutGitVars()).status, 0);
  assert.equal(git(foreign, ['commit', '-q', '-m', 'theirs'], withoutGitVars()).status, 0);
  assert.equal(git(foreign, ['config', 'core.hooksPath', '.husky'], withoutGitVars()).status, 0);
  const foreignGit = join(foreign, '.git');
  const before = { config: readFileSync(join(foreignGit, 'config')), index: readFileSync(join(foreignGit, 'index')), refs: refsOf(foreignGit) };

  const file = writeAnswers(base, { ...ANSWERS.en, commit: true });
  const r = brainKit(['init', vault, '--from-answers', file], {
    env: testEnv(state, { GIT_DIR: foreignGit, GIT_INDEX_FILE: join(foreignGit, 'index') }),
  });
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);

  assert.deepEqual(readFileSync(join(foreignGit, 'config')), before.config, 'the other repository\'s config is untouched');
  assert.deepEqual(readFileSync(join(foreignGit, 'index')), before.index, 'its index is untouched');
  assert.equal(refsOf(foreignGit), before.refs, 'its refs are untouched');
  assert.ok(statSync(join(vault, '.git')).isDirectory(), 'the vault has its own repository');
  const own = { ...withoutGitVars() };
  assert.equal(spawnSync('git', ['config', 'core.hooksPath'], { cwd: vault, encoding: 'utf8', env: own }).stdout.trim(), '.githooks');
  assert.equal(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: vault, encoding: 'utf8', env: own }).stdout.trim(), '1');
  assert.doesNotMatch(r.stdout, /nested inside another git repository/);
  // init's own lint read the vault's repository, not the other one (whose
  // tracked file `a` does not exist here).
  assert.doesNotMatch(r.stdout, /missing from the working tree/);
});

test('a file another process writes into a directory init created is never removed by the rollback, and is named', () => {
  const { base, vault, state } = freshTarget();
  const file = writeAnswers(base, ANSWERS.en);
  const PATH = failingGit(base, 'init', 'echo theirs > core/foreign.txt;');
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state, { PATH }) });
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.equal(readFileSync(join(vault, 'core', 'foreign.txt'), 'utf8'), 'theirs\n');
  assert.match(r.stderr, /Removing what this run had created failed for: /);
  assert.ok(r.stderr.includes(join(vault, 'core')), r.stderr);
  assert.deepEqual(listFiles(vault), ['core/foreign.txt'], 'everything init wrote is gone, the foreign file is not');
  assert.equal(existsSync(state), false);
});

// A git that, on the rev-parse init makes after its second check, runs
// `action` first: another process acting in the gap between the check
// and the first write.
function gapGit(base, action) {
  const shims = join(base, 'gap-shims');
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(shims, 'git'), `#!/usr/bin/env bash\nif [ "$1" = rev-parse ] && [ "$2" = --show-toplevel ]; then ${action} fi\nexec ${JSON.stringify(realGit())} "$@"\n`);
  chmodSync(join(shims, 'git'), 0o755);
  return `${shims}${delimiter}${process.env.PATH}`;
}

test('a repository another process makes in the target during the gap is never claimed or removed', () => {
  const { base, vault, state } = freshTarget();
  mkdirSync(vault);
  const file = writeAnswers(base, ANSWERS.en);
  const theirs = join(vault, '.git');
  const PATH = gapGit(base, `mkdir -p ${JSON.stringify(join(theirs, 'objects'))}; echo 'ref: refs/heads/theirs' > ${JSON.stringify(join(theirs, 'HEAD'))};`);
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state, { PATH }) });
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.equal(readFileSync(join(theirs, 'HEAD'), 'utf8'), 'ref: refs/heads/theirs\n');
  assert.deepEqual(listFiles(vault), ['.git/HEAD'], 'only the other process\'s repository is left');
});

test('a machine.json another run writes between the check and init\'s exclusive open is neither recorded nor removed', () => {
  const { base, vault, state } = freshTarget();
  const file = writeAnswers(base, ANSWERS.en);
  const theirs = join(state, MACHINE_FILENAME);
  const PATH = gapGit(base, `mkdir -p ${JSON.stringify(state)}; echo '{"other":"run"}' > ${JSON.stringify(theirs)};`);
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state, { PATH }) });
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.match(r.stderr, /EEXIST/);
  assert.equal(readFileSync(theirs, 'utf8'), '{"other":"run"}\n');
  assert.equal(existsSync(vault), false);
});

test('a state directory that already existed, holding a file, keeps the file and its own mode when init fails', () => {
  const { base, vault } = freshTarget();
  const state = join(base, 'mystate');
  mkdirSync(state);
  chmodSync(state, 0o755);
  writeFileSync(join(state, 'notes.txt'), 'mine\n');
  const before = snapshot(state);
  const file = writeAnswers(base, ANSWERS.en);
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state, { PATH: failingGit(base, 'init') }) });
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.match(r.stderr, /Everything this run had created was removed/);
  assert.deepEqual(snapshot(state), before, 'the directory, its mode and its file are as they were');
});

test('on success, init says in one line that it tightened an existing state directory to 0700', () => {
  const { base, vault } = freshTarget();
  const state = join(base, 'mystate');
  mkdirSync(state);
  chmodSync(state, 0o755);
  const r = brainKit(['init', vault, '--from-answers', writeAnswers(base, ANSWERS.en)], { env: testEnv(state) });
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.equal(r.stdout.split('\n').filter((line) => /already existed with mode 755; init set it to 700/.test(line)).length, 1);

  const fresh = freshTarget();
  const r2 = brainKit(['init', fresh.vault, '--from-answers', writeAnswers(fresh.base, ANSWERS.en)], { env: testEnv(fresh.state) });
  assert.equal(r2.status, EXIT.OK);
  assert.doesNotMatch(r2.stdout, /already existed with mode/);
});

test('a state directory reached through a symbolic link into the vault is refused, and nothing is written', () => {
  const { base, vault } = freshTarget();
  mkdirSync(vault);
  symlinkSync(vault, join(base, 'link'));
  const file = writeAnswers(base, { ...ANSWERS.en, commit: true });
  const watched = [[vault, snapshot(vault)], [base, snapshot(base)]];
  const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(join(base, 'link', 'st')) });
  assertRefusedUntouched(r, watched, /state directory/);
});

for (const [signal, status] of [['INT', 130], ['TERM', 143]]) {
  test(`SIG${signal} during init rolls everything back, says so, and exits ${status}`, () => {
    const { base, vault, state } = freshTarget();
    const file = writeAnswers(base, ANSWERS.en);
    // What a Ctrl-C (or a service manager) does: the signal reaches init
    // and the git it is running.
    const PATH = failingGit(base, 'init', `kill -${signal} $PPID; exit ${status};`);
    const r = brainKit(['init', vault, '--from-answers', file], { env: testEnv(state, { PATH }) });
    assert.equal(r.status, status, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`interrupted by SIG${signal}`));
    assert.match(r.stderr, /Everything this run had created was removed/);
    assert.equal(existsSync(vault), false);
    assert.equal(existsSync(state), false);
  });
}

test('BRAIN_KIT_LANG set to an unsupported value is reported once, and the locale decides', () => {
  const env = localeEnv('', { BRAIN_KIT_LANG: 'fr', LANG: 'C.UTF-8' });
  const r = brainKit(['nope'], { env });
  assert.equal(r.status, EXIT.USAGE);
  assert.equal(r.stderr.split('\n').filter((line) => line.includes('BRAIN_KIT_LANG=fr is not a supported language')).length, 1);
  assert.match(r.stderr, /unknown command/);
  const supported = brainKit(['nope'], { env: localeEnv('', { BRAIN_KIT_LANG: 'en', LANG: 'pt_BR.UTF-8' }) });
  assert.doesNotMatch(supported.stderr, /not a supported language/);
});
