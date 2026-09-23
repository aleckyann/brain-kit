// `brain-kit init --adopt`: an existing vault brought under the kit by
// writing configuration and state only. What this file proves, each on a
// COPY of a small fictional vault (test/fixtures/adopt/<lang>/, written
// from what a real vault looks like: an index per folder, frontmatter
// with `generated`, a per-type enum under its own name, tables with
// their own headings, a log, notes marked confidential in more than one
// folder):
//
// - the only new paths are brain-kit.config.json and
//   .brain-kit/manifest.json, and every pre-existing file, the .git
//   directory included, is byte for byte what it was;
// - the inferred configuration is schema-valid, and `validate` on the
//   adopted copy reports exactly the findings the fixture was built to
//   contain, while `lint --base all` reports none, because the
//   confidential directories were reconciled with where the marker sits;
// - every inference is printed;
// - a directory with no index.md, one already adopted (configuration or
//   manifest), one inside another vault, a file, an answers file asking
//   for a commit, and a state directory that cannot be used are each
//   refused with exit 2 and nothing written anywhere;
// - a failure after the first write removes everything the run created
//   and touches nothing else.
//
// Example data: the fictional owner Ana, example.com / example.invalid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { KIT_ROOT, kitVersion } from '../src/version.mjs';
import { CONFIG_FILENAME, MACHINE_FILENAME, findMachineOnlyKeys, loadConfig, validateConfig, validateMachine } from '../src/config.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { MANIFEST_PATH, readManifest } from '../src/manifest.mjs';
import { completeDefaults } from '../src/init/config.mjs';
import { inferConfig, monthOffset, readDefaults, writeAdoption } from '../src/init/adopt.mjs';
import { runInit } from '../src/commands/init.mjs';
import { MATCH_REMEDY } from '../src/commands/scan-blobs.mjs';
import { GATE_LINE } from '../src/init/gate.mjs';
import { walkVault } from '../src/vault.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const FIXTURES = join(KIT_ROOT, 'test', 'fixtures', 'adopt');
const ACCENTED = `${String.fromCharCode(0xc1)}rea de notas`;

const ANSWERS = Object.freeze({
  en: Object.freeze({ lang: 'en', name: 'Ana Souza', handle: 'asouza', title: 'Field Notes', repo: null, private: true, timezone: 'Europe/Lisbon' }),
  'pt-BR': Object.freeze({ lang: 'pt-BR', name: 'Ana Lima', handle: 'alima', title: 'Caderno', repo: null, private: true, timezone: 'America/Sao_Paulo' }),
});

const TEST_GIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'Ana Souza',
  GIT_AUTHOR_EMAIL: 'ana@example.invalid',
  GIT_COMMITTER_NAME: 'Ana Souza',
  GIT_COMMITTER_EMAIL: 'ana@example.invalid',
});

// Everything under `root`, dot-entries and .git included: path, kind,
// mode and, for a file, the hash of its bytes, each as one line.
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
      out.push(`${rel} ${st.isFile() ? 'file' : 'link'} ${mode} ${hash}`);
    }
  };
  walk('');
  return out;
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...TEST_GIT_ENV } });
}

// A copy of one fixture at a path with a space, an accented letter and a
// quote in it, optionally committed into its own repository, with a state
// directory and an empty working directory beside it.
function freshCopy(fixture, { repository = true } = {}) {
  const base = makeTempDir('brain-kit-adopt-');
  const vault = join(base, ACCENTED, "Ana's vault");
  cpSync(join(FIXTURES, fixture), vault, { recursive: true });
  if (repository) {
    // No automatic maintenance: git runs it detached after a commit, and a
    // lock file it creates and removes on its own schedule would make the
    // byte-for-byte comparison of .git below race with it.
    const quiet = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'Notes as they were']]) {
      const r = git(vault, [...quiet, ...args]);
      assert.equal(r.status, 0, r.stderr);
    }
    // Every file one second newer than the index records: a git command
    // that refreshes the index as a side effect would now rewrite it.
    const later = new Date(Date.now() + 1000);
    for (const name of ['index.md', 'AGENTS.md']) utimesSync(join(vault, name), later, later);
  }
  const cwd = join(base, 'cwd');
  mkdirSync(cwd);
  return { base, vault, state: join(base, 'state'), cwd };
}

function testEnv(state, extra = {}) {
  return { ...process.env, BRAIN_KIT_LANG: 'en', BRAIN_KIT_STATE_DIR: state, USER: 'ana', LOGNAME: 'ana', TZ: 'UTC', ...TEST_GIT_ENV, ...extra };
}

function brainKit(args, { env, cwd }) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, cwd });
}

function adopt(copy, answers, extra = []) {
  const file = join(copy.base, 'answers.json');
  writeFileSync(file, `${JSON.stringify(answers, null, 2)}\n`);
  return brainKit(['init', '--adopt', copy.vault, '--from-answers', file, ...extra], { env: testEnv(copy.state), cwd: copy.cwd });
}

function findingsOf(result) {
  return JSON.parse(result.stdout).findings.map((f) => [f.ruler ?? 'lint', f.id, f.check, f.file, f.warning === true]);
}

// --- the main run, per fixture and language -----------------------------------

const STALE_PT = ['pendencias/acompanhamentos.md', 'pessoas/bruno-costa.md', 'pessoas/carla-dias.md', 'pessoas/davi-eller.md', 'projetos/boletim.md', 'projetos/horta.md'];

const CASES = [
  {
    fixture: 'en',
    lang: 'en',
    exit: EXIT.FAILURE,
    // What the English fixture was built to contain: one note without a
    // description, one link to a decision that was never written.
    validate: [
      ['house', 'required-fields', 'field-present', 'core/principles.md', false],
      ['house', 'link-target-exists', 'target-exists', 'projects/reading-club.md', false],
    ],
  },
  {
    fixture: 'pt-BR',
    lang: 'pt-BR',
    exit: EXIT.OK,
    // The Portuguese fixture writes stale_after as a plain date, as many
    // real vaults do: one should-level finding per note, each a warning.
    validate: STALE_PT.map((file) => ['spec', 'stale-after-format', 'timestamp-form', file, true]),
  },
  {
    // A vault written in Portuguese, adopted by an English speaker: its
    // confidentiality marker keeps its own spelling.
    fixture: 'pt-BR',
    lang: 'en',
    exit: EXIT.OK,
    validate: STALE_PT.map((file) => ['spec', 'stale-after-format', 'timestamp-form', file, true]),
  },
];

for (const c of CASES) {
  test(`${c.fixture} fixture, adopted in ${c.lang}: only the configuration, the manifest and the gate are new, and every existing byte is kept`, () => {
    const copy = freshCopy(c.fixture);
    const before = snapshot(copy.vault);
    assert.ok(before.length > 40, 'the snapshot must see the repository too');
    assert.ok(before.some((line) => line.startsWith('.git/index ')), 'the snapshot must include the git index');
    const localConfigBefore = git(copy.vault, ['config', '--local', '--list']).stdout;

    const r = adopt(copy, ANSWERS[c.lang]);
    assert.equal(r.status, c.exit, `${r.stdout}\n${r.stderr}`);

    // The one pre-existing file that changes is the repository's own
    // configuration, by exactly one setting: core.hooksPath.
    const after = snapshot(copy.vault);
    const kept = new Set(after);
    assert.deepEqual(before.filter((line) => !kept.has(line)).map((line) => line.split(' ')[0]), ['.git/config'], 'a pre-existing path was changed or removed');
    assert.equal(git(copy.vault, ['config', '--local', '--list']).stdout, `${localConfigBefore}core.hookspath=.githooks\n`);
    const added = after.filter((line) => !before.includes(line)).map((line) => line.split(' ').slice(0, 2).join(' ')).filter((line) => line !== '.git/config file');
    assert.deepEqual(added, ['.brain-kit dir', '.brain-kit/manifest.json file', '.githooks dir', '.githooks/pre-push file', 'brain-kit.config.json file']);

    // The configuration: valid, in the vault's language, completed from
    // these answers, stamped with this kit, free of machine-only keys.
    const config = JSON.parse(readFileSync(join(copy.vault, CONFIG_FILENAME), 'utf8'));
    assert.deepEqual(validateConfig(config), []);
    assert.deepEqual(loadConfig(copy.vault), config);
    assert.deepEqual(findMachineOnlyKeys(config), []);
    assert.equal(config.lang, c.lang);
    assert.equal(config.kit_version, kitVersion());
    assert.equal(config.owner.handle, ANSWERS[c.lang].handle);
    assert.equal(config.actors.human, `human:${ANSWERS[c.lang].handle}`);
    assert.deepEqual(config, completeDefaults(inferConfig(join(FIXTURES, c.fixture), { lang: c.lang }).config, ANSWERS[c.lang], { kitVersion: kitVersion() }));

    // The manifest: every file that was there, each seeded, and the gate,
    // managed; each hash the bytes on disk; nothing under .git.
    const manifest = readManifest(copy.vault);
    const existing = before.filter((line) => / file /.test(line)).map((line) => line.split(' ')[0]).filter((path) => !path.startsWith('.git/'));
    assert.deepEqual(manifest.files.map((f) => f.path).sort(), [...existing, '.githooks/pre-push'].sort());
    assert.ok(manifest.files.length >= 20);
    assert.ok(manifest.files.some((f) => f.path === '.gitignore'), 'a dot-file the vault already has is recorded as the person\'s');
    assert.equal(manifest.lang, c.lang, 'the manifest records the language adopt inferred in');
    for (const entry of manifest.files) {
      assert.equal(entry.class, entry.path === '.githooks/pre-push' ? 'managed' : 'seeded', entry.path);
      assert.equal(entry.sha256, createHash('sha256').update(readFileSync(join(copy.vault, entry.path))).digest('hex'), entry.path);
    }

    // machine.json, outside the vault, private.
    const machinePath = join(copy.state, MACHINE_FILENAME);
    const machine = JSON.parse(readFileSync(machinePath, 'utf8'));
    assert.deepEqual(validateMachine(machine), []);
    assert.equal(machine.canonical_path, realpathSync(copy.vault));
    assert.equal(statSync(machinePath).mode & 0o777, 0o600);
    assert.equal(statSync(copy.state).mode & 0o777, 0o700);

    // The gate: the template, executable, wired; and no commit: the
    // history is the person's.
    const hook = join(copy.vault, '.githooks', 'pre-push');
    assert.deepEqual(readFileSync(hook), readFileSync(join(KIT_ROOT, 'templates', 'githooks', 'pre-push')));
    assert.equal(statSync(hook).mode & 0o777, 0o755);
    assert.equal(git(copy.vault, ['config', 'core.hooksPath']).stdout.trim(), '.githooks');
    assert.equal(git(copy.vault, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
    assert.ok(r.stdout.includes(createTranslator(c.lang)('gate.installed', { hook: join(realpathSync(copy.vault), '.githooks', 'pre-push') })), r.stdout);

    // The verdict on the adopted vault: exactly what the fixture holds.
    const v = brainKit(['validate', copy.vault, '--json'], { env: testEnv(copy.state), cwd: copy.cwd });
    assert.deepEqual(findingsOf(v), c.validate, v.stdout);
    const l = brainKit(['lint', copy.vault, '--base', 'all', '--json'], { env: testEnv(copy.state), cwd: copy.cwd });
    assert.equal(l.status, EXIT.OK, l.stdout + l.stderr);
    assert.deepEqual(JSON.parse(l.stdout).findings, []);

    // Every inference was printed, in the vault's language.
    const { notes } = inferConfig(join(FIXTURES, c.fixture), { lang: c.lang });
    assert.ok(notes.length >= 10, `expected a real list of inferences, got ${notes.length}`);
    const t = createTranslator(c.lang);
    for (const note of notes) assert.ok(r.stdout.includes(`  - ${t(note.messageKey, note.params)}\n`), `not printed: ${note.messageKey}`);
    assert.ok(r.stdout.includes(t('init.adopt_no_commit')));
  });
}

// --- what adopt infers ------------------------------------------------------------

function keysOf(notes) {
  return notes.map((note) => note.messageKey);
}

test('en fixture: collections, domains, per-type enums, tables, the log and the stale policy come from the notes', () => {
  const defaults = readDefaults('en');
  const { config, notes } = inferConfig(join(FIXTURES, 'en'), { lang: 'en' });
  assert.deepEqual(config.taxonomy.collections, {
    core: { type: 'core' },
    decisions: { type: 'decision' },
    pending: { type: 'pending' },
    people: { type: 'person' },
    projects: { type: 'project' },
  });
  assert.deepEqual(config.taxonomy.domains, ['memory']);
  assert.deepEqual(config.frontmatter.extensions, {
    confidential: { type: 'boolean', default: false },
    phase: { type: 'enum', values_by_type: { decision: ['done', 'open'], project: ['active', 'idea'] } },
    relationship: { type: 'enum', values_by_type: { person: ['mentor', 'team'] } },
  });
  assert.equal(config.privacy.confidential_field, 'confidential');
  assert.deepEqual(config.privacy.confidential_dirs, ['people/', 'projects/']);
  assert.deepEqual(config.taxonomy.columns.followups.columns, ['Logged', 'Task', 'Owner', 'Due', 'Next']);
  assert.deepEqual(config.taxonomy.columns.rituals.columns, ['Meeting', 'When', 'Who', 'Feeds']);
  assert.deepEqual(config.taxonomy.columns.promises, defaults.taxonomy.columns.promises);
  assert.equal(config.taxonomy.files.followups, 'pending/follow-ups.md');
  assert.equal(config.taxonomy.files.promises, null);
  assert.equal(config.taxonomy.files.style_guide, null);
  assert.equal(config.taxonomy.log, 'memory/log.md');
  assert.deepEqual(config.stale_policy.months, { 'people/': 6, 'pending/': 3 }, 'no default for organizations/, a folder this vault does not have');
  assert.equal(config.validate.timestamp_deviation, 'forbid', 'every timestamp here carries an offset');
  assert.ok(!keysOf(notes).includes('adopt.note.plain_dates'));
  assert.ok(!keysOf(notes).includes('adopt.note.confidential_field'), 'the field is already this language\'s');
});

test('pt-BR fixture: markers in three folders become three confidential directories, plain dates turn on the deviation, and disagreeing offsets keep the default', () => {
  const { config, notes } = inferConfig(join(FIXTURES, 'pt-BR'), { lang: 'pt-BR' });
  assert.deepEqual(config.privacy.confidential_dirs, ['pessoas/', 'projetos/', 'reunioes/']);
  assert.deepEqual(notes.find((n) => n.messageKey === 'adopt.note.confidential_dirs').params.added, ['projetos/', 'reunioes/']);
  assert.equal(config.validate.timestamp_deviation, 'allow');
  assert.equal(notes.find((n) => n.messageKey === 'adopt.note.plain_dates').params.count, 6);
  assert.deepEqual(config.stale_policy.months, { 'pessoas/': 6, 'pendencias/': 3 });
  assert.deepEqual(notes.filter((n) => n.messageKey === 'adopt.note.stale_inconsistent').map((n) => n.params.dir), ['projetos/']);
  assert.deepEqual(Object.keys(config.frontmatter.extensions), ['confidencial', 'fase', 'vinculo']);
});

test('a vault marking confidentiality in another language keeps its spelling: the field is set, declared boolean, and valid', () => {
  const { config, notes } = inferConfig(join(FIXTURES, 'pt-BR'), { lang: 'en' });
  const field = notes.find((n) => n.messageKey === 'adopt.note.confidential_field');
  assert.deepEqual(field.params, { field: 'confidencial', default: 'confidential' });
  assert.equal(config.privacy.confidential_field, 'confidencial');
  assert.deepEqual(config.frontmatter.extensions.confidencial, { type: 'boolean', default: false });
  assert.deepEqual(config.privacy.confidential_dirs, ['people/', 'pessoas/', 'projetos/', 'reunioes/']);
  assert.equal(config.taxonomy.log, 'memoria/log.md');
  assert.deepEqual(validateConfig(completeDefaults(config, ANSWERS.en, { kitVersion: kitVersion() })), []);
});

// The reconciliation is what keeps the first lint clean: the same adopted
// vault, with the language's default confidential directories put back,
// fails lint with one privacy error per note marked outside them.
test('without the reconciled confidential directories, the adopted vault fails its first lint once per marked note', () => {
  const copy = freshCopy('pt-BR', { repository: false });
  const r = adopt(copy, ANSWERS['pt-BR']);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  const configPath = join(copy.vault, CONFIG_FILENAME);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.privacy.confidential_dirs = readDefaults('pt-BR').privacy.confidential_dirs;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const l = brainKit(['lint', copy.vault, '--base', 'all', '--json'], { env: testEnv(copy.state), cwd: copy.cwd });
  assert.equal(l.status, EXIT.FAILURE, l.stdout);
  assert.deepEqual(findingsOf(l), [
    ['lint', 'privacy', 'confidential-field-outside', 'projetos/boletim.md', false],
    ['lint', 'privacy', 'confidential-field-outside', 'reunioes/2026-09-10-conselho.md', false],
  ]);
});

// A small vault built for one inference at a time.
function tinyVault(files) {
  const root = makeTempDir('brain-kit-adopt-tiny-');
  const all = { 'index.md': '---\nokf_version: "0.2"\n---\n\n# Notes\n', ...files };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function note(type, extra = '', at = '2026-01-10T00:00:00+00:00') {
  return `---\ntype: ${type}\ntitle: A note\ndescription: A note.\n${extra}generated:\n  by: human:ana\n  at: ${at}\n---\n\n# A note\n`;
}

test('a field whose values never repeat, hold a space, or are too many is a free string, not a closed list', () => {
  const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`a/n${i}.md`, note('x', `code: v${i}\ncode2: v${i % 13}\n`)]));
  const root = tinyVault({
    'b/one.md': note('y', 'owner: ana\nmood: very good\nlevel: 3\ndue: 2026-02-01\n'),
    'b/two.md': note('y', 'owner: bruno\nmood: very good\nlevel: 4\ndue: 2026-03-01\n'),
    ...many,
  });
  const { config } = inferConfig(root, { lang: 'en' });
  const ext = config.frontmatter.extensions;
  assert.equal(ext.owner.type, 'string', 'no value repeats');
  assert.equal(ext.mood.type, 'string', 'a value with a space is prose');
  assert.equal(ext.level.type, 'number');
  assert.equal(ext.due.type, 'date');
  assert.equal(ext.code.type, 'string', 'thirteen distinct values');
});

test('a field named like a machine-only setting is left undeclared, so the configuration stays valid', () => {
  const root = tinyVault({ 'cars/one.md': note('car', 'model: sedan\n'), 'cars/two.md': note('car', 'model: sedan\npaths: two\n') });
  const { config, notes } = inferConfig(root, { lang: 'en' });
  assert.equal(config.frontmatter.extensions.model, undefined);
  assert.equal(config.frontmatter.extensions.paths, undefined);
  assert.deepEqual(notes.filter((n) => n.messageKey === 'adopt.note.extension_reserved').map((n) => n.params.field), ['model', 'paths']);
  assert.deepEqual(validateConfig(completeDefaults(config, ANSWERS.en, { kitVersion: kitVersion() })), []);
});

test('a list-valued field is left undeclared, and said so', () => {
  const root = tinyVault({ 'a/one.md': note('x', 'aliases: [one, uno]\n'), 'a/two.md': note('x', 'aliases:\n  - two\n') });
  const { config, notes } = inferConfig(root, { lang: 'en' });
  assert.equal(config.frontmatter.extensions.aliases, undefined);
  assert.deepEqual(notes.filter((n) => n.messageKey === 'adopt.note.extension_skipped').map((n) => n.params.field), ['aliases']);
});

test('with no marker anywhere, the language field is declared boolean, and the configuration is still valid', () => {
  const root = tinyVault({ 'a/one.md': note('x') });
  const { config, notes } = inferConfig(root, { lang: 'pt-BR' });
  const field = readDefaults('pt-BR').privacy.confidential_field;
  assert.equal(config.privacy.confidential_field, field);
  assert.equal(config.frontmatter.extensions[field].type, 'boolean');
  assert.ok(keysOf(notes).includes('adopt.note.confidential_field_unused'));
  assert.deepEqual(config.privacy.confidential_dirs, readDefaults('pt-BR').privacy.confidential_dirs);
  assert.deepEqual(validateConfig(completeDefaults(config, ANSWERS['pt-BR'], { kitVersion: kitVersion() })), []);
});

test('both spellings in one vault: the one the privacy rule does not read on its own is configured, and both are declared', () => {
  const pt = readDefaults('pt-BR').privacy.confidential_field;
  const root = tinyVault({ 'a/one.md': note('x', 'confidential: true\n'), 'b/two.md': note('y', `${pt}: true\n`) });
  const { config } = inferConfig(root, { lang: 'en' });
  assert.equal(config.privacy.confidential_field, pt);
  assert.equal(config.frontmatter.extensions.confidential.type, 'boolean');
  assert.equal(config.frontmatter.extensions[pt].type, 'boolean');
  assert.deepEqual(config.privacy.confidential_dirs, ['people/', 'a/', 'b/']);
});

test('a marker holding something other than true or false is declared boolean anyway, and said so', () => {
  const root = tinyVault({ 'a/one.md': note('x', 'confidential: yes\n'), 'a/two.md': note('x', 'confidential: yes\n') });
  const { config, notes } = inferConfig(root, { lang: 'en' });
  assert.equal(config.frontmatter.extensions.confidential.type, 'boolean');
  assert.ok(keysOf(notes).includes('adopt.note.confidential_not_boolean'));
});

test('the links the new confidential directories make reportable are counted before the first lint reports them', () => {
  const root = tinyVault({ 'a/one.md': note('x', 'confidential: true\n'), 'b/two.md': `${note('y')}\nSee [one](../a/one.md).\n` });
  const { config, notes } = inferConfig(root, { lang: 'en' });
  assert.deepEqual(config.privacy.confidential_dirs, ['people/', 'a/']);
  assert.deepEqual(notes.find((n) => n.messageKey === 'adopt.note.confidential_links').params, { count: 1 });
  assert.ok(!keysOf(inferConfig(join(FIXTURES, 'en'), { lang: 'en' }).notes).includes('adopt.note.confidential_links'));
});

test('a marked note at the vault root is named, not covered by declaring the whole vault confidential', () => {
  const root = tinyVault({ 'secret.md': note('x', 'confidential: true\n'), 'a/one.md': note('x') });
  const { config, notes } = inferConfig(root, { lang: 'en' });
  assert.deepEqual(config.privacy.confidential_dirs, ['people/']);
  assert.deepEqual(notes.find((n) => n.messageKey === 'adopt.note.confidential_uncovered').params.files, ['secret.md']);
});

test('a marked note nested under a directory already confidential adds nothing', () => {
  const root = tinyVault({ 'people/team/one.md': note('person', 'confidential: true\n'), 'people/two.md': note('person', 'confidential: true\n') });
  const { config, notes } = inferConfig(root, { lang: 'en' });
  assert.deepEqual(config.privacy.confidential_dirs, ['people/']);
  assert.ok(!keysOf(notes).includes('adopt.note.confidential_dirs'));
});

test('the log: the default when it exists, the only log.md otherwise, and said so when there is none or several', () => {
  assert.equal(inferConfig(tinyVault({ 'journal/log.md': '# Log\n' }), { lang: 'en' }).config.taxonomy.log, 'journal/log.md');
  const none = inferConfig(tinyVault({ 'a/one.md': note('x') }), { lang: 'en' });
  assert.equal(none.config.taxonomy.log, 'memory/log.md');
  assert.ok(keysOf(none.notes).includes('adopt.note.log_absent'));
  const several = inferConfig(tinyVault({ 'a/log.md': '# Log\n', 'b/log.md': '# Log\n' }), { lang: 'en' });
  assert.equal(several.config.taxonomy.log, 'memory/log.md');
  assert.deepEqual(several.notes.find((n) => n.messageKey === 'adopt.note.log_ambiguous').params.files, ['a/log.md', 'b/log.md']);
});

test('with no stale_after anywhere, a default is kept only for a folder the vault has, and each one kept is said', () => {
  const none = inferConfig(tinyVault({ 'a/one.md': note('x') }), { lang: 'en' });
  assert.deepEqual(none.config.stale_policy, { key: 'path', months: {} });
  assert.ok(keysOf(none.notes).includes('adopt.note.stale_none'));
  const some = inferConfig(tinyVault({ 'people/one.md': note('person'), 'a/one.md': note('x') }), { lang: 'en' });
  assert.deepEqual(some.config.stale_policy.months, { 'people/': 6 });
  assert.deepEqual(some.notes.filter((n) => n.messageKey === 'adopt.note.stale_default_kept').map((n) => n.params), [{ dir: 'people/', months: 6 }]);
  assert.ok(!keysOf(some.notes).includes('adopt.note.stale_none'));
});

test('a folder matching a language-default collection inherits no template and no file-name pattern', () => {
  const root = tinyVault({ 'decisions/move.md': note('decision'), 'templates/template-decision.md': note('decision') });
  const { config } = inferConfig(root, { lang: 'en' });
  assert.deepEqual(config.taxonomy.collections, { decisions: { type: 'decision' } });
});

test('a folder whose notes agree on a whole-month offset sets it; one plain generated.at alone turns on the deviation', () => {
  const root = tinyVault({
    'clients/a.md': note('client', 'stale_after: 2026-05-10T00:00:00+00:00\n', '2026-01-10T00:00:00+00:00'),
    'clients/b.md': note('client', 'stale_after: 2026-07-31T00:00:00+00:00\n', '2026-03-31T00:00:00+00:00'),
    'misc/c.md': note('misc', '', '2026-03-31'),
  });
  const { config, notes } = inferConfig(root, { lang: 'en' });
  assert.equal(config.stale_policy.months['clients/'], 4);
  assert.equal(config.validate.timestamp_deviation, 'allow');
  assert.equal(notes.find((n) => n.messageKey === 'adopt.note.plain_dates').params.count, 1);
});

test('monthOffset counts whole months only, clamping to the end of a shorter month', () => {
  assert.equal(monthOffset('2026-01-31T10:00:00+00:00', '2026-02-28'), 1);
  assert.equal(monthOffset('2024-01-31', '2024-02-29'), 1);
  assert.equal(monthOffset('2024-01-31', '2024-02-28'), null);
  assert.equal(monthOffset('2026-01-10', '2027-01-10'), 12);
  assert.equal(monthOffset('2026-01-10', '2026-04-11'), null);
  assert.equal(monthOffset('2026-01-10', '2026-01-10'), null);
  assert.equal(monthOffset('2026-05-10', '2026-01-10'), null);
  assert.equal(monthOffset('2026-02-30', '2026-05-30'), null);
  assert.equal(monthOffset('not a date', '2026-05-30'), null);
});

// --- refusals: nothing written ------------------------------------------------------

function assertRefused(r, copy, before, pattern) {
  assert.equal(r.status, EXIT.USAGE, `expected exit 2:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, pattern);
  assert.deepEqual(snapshot(copy.vault), before, 'the vault changed');
  assert.equal(existsSync(copy.state), false, 'the state directory was created');
}

test('a directory with no index.md is refused with exit 2 and nothing written', () => {
  const copy = freshCopy('en');
  rmSync(join(copy.vault, 'index.md'));
  const before = snapshot(copy.vault);
  assertRefused(adopt(copy, ANSWERS.en), copy, before, /no index\.md at its root/);
});

test('with no directory given, adopt reads the one it runs in, and an empty one is refused with exit 2 and nothing written', () => {
  const copy = freshCopy('en', { repository: false });
  const before = snapshot(copy.cwd);
  const r = brainKit(['init', '--adopt', '--yes', '--lang', 'en'], { env: testEnv(copy.state), cwd: copy.cwd });
  assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
  assert.match(r.stderr, /no index\.md at its root/);
  assert.deepEqual(snapshot(copy.cwd), before);
  assert.equal(existsSync(copy.state), false);

  const here = brainKit(['init', '--adopt', '--yes', '--lang', 'en'], { env: testEnv(copy.state), cwd: copy.vault });
  assert.equal(here.status, EXIT.FAILURE, 'the fixture holds two house findings');
  assert.ok(existsSync(join(copy.vault, CONFIG_FILENAME)));
});

test('an index.md that is a directory, or a link out of the vault, is not a root index adopt can read', () => {
  const asDir = freshCopy('en', { repository: false });
  rmSync(join(asDir.vault, 'index.md'));
  mkdirSync(join(asDir.vault, 'index.md'));
  const beforeDir = snapshot(asDir.vault);
  assertRefused(adopt(asDir, ANSWERS.en), asDir, beforeDir, /no index\.md at its root/);

  const asLink = freshCopy('en', { repository: false });
  const outside = join(asLink.base, 'outside-index.md');
  writeFileSync(outside, readFileSync(join(asLink.vault, 'index.md')));
  rmSync(join(asLink.vault, 'index.md'));
  symlinkSync(outside, join(asLink.vault, 'index.md'));
  const beforeLink = snapshot(asLink.vault);
  assertRefused(adopt(asLink, ANSWERS.en), asLink, beforeLink, /no index\.md at its root/);
});

test('a directory already adopted, by its configuration or by its manifest alone, is refused with exit 2 and nothing written', () => {
  const withConfig = freshCopy('en');
  writeFileSync(join(withConfig.vault, CONFIG_FILENAME), '{}\n');
  const beforeConfig = snapshot(withConfig.vault);
  assertRefused(adopt(withConfig, ANSWERS.en), withConfig, beforeConfig, /is already adopted/);

  const withManifest = freshCopy('en');
  mkdirSync(join(withManifest.vault, '.brain-kit'));
  writeFileSync(join(withManifest.vault, MANIFEST_PATH), '{"files":[]}\n');
  const beforeManifest = snapshot(withManifest.vault);
  assertRefused(adopt(withManifest, ANSWERS.en), withManifest, beforeManifest, /is already adopted/);

  const secondRun = freshCopy('en');
  assert.equal(adopt(secondRun, ANSWERS.en).status, EXIT.FAILURE, 'the fixture holds two house findings');
  const beforeSecond = snapshot(secondRun.vault);
  const stateBefore = snapshot(secondRun.state);
  const again = adopt(secondRun, ANSWERS.en);
  assert.equal(again.status, EXIT.USAGE, again.stderr);
  // The way back, in the refusal itself: edit the configuration, or
  // remove the three files to adopt from scratch; never `update`, which
  // does not redo an inference.
  assert.match(again.stderr, /edit brain-kit\.config\.json/);
  assert.ok(again.stderr.includes(`remove brain-kit.config.json, .brain-kit/manifest.json and ${join(realpathSync(secondRun.state), MACHINE_FILENAME)}`), again.stderr);
  assert.doesNotMatch(again.stderr, /update/);
  assert.deepEqual(snapshot(secondRun.vault), beforeSecond);
  assert.deepEqual(snapshot(secondRun.state), stateBefore);
});

test('a vault inside another vault is refused with exit 2 and nothing written', () => {
  const copy = freshCopy('en', { repository: false });
  writeFileSync(join(copy.vault, CONFIG_FILENAME), '{}\n');
  const inner = { ...copy, vault: join(copy.vault, 'people') };
  writeFileSync(join(inner.vault, 'index.md'), '# People\n');
  const before = snapshot(copy.vault);
  const r = adopt(inner, ANSWERS.en);
  assert.equal(r.status, EXIT.USAGE, r.stderr);
  assert.match(r.stderr, /inside the brain-kit vault/);
  assert.deepEqual(snapshot(copy.vault), before);
  assert.equal(existsSync(copy.state), false);
});

test('a file, or a path that does not exist, is refused with exit 2 and nothing written', () => {
  const copy = freshCopy('en', { repository: false });
  const before = snapshot(copy.vault);
  for (const target of [join(copy.vault, 'AGENTS.md'), join(copy.vault, 'nowhere')]) {
    const r = adopt({ ...copy, vault: target }, ANSWERS.en);
    assert.equal(r.status, EXIT.USAGE, r.stderr);
    assert.match(r.stderr, /is not a directory/);
  }
  assert.deepEqual(snapshot(copy.vault), before);
  assert.equal(existsSync(copy.state), false);
});

test('an answers file asking adopt for a commit is refused with exit 2 and nothing written', () => {
  const copy = freshCopy('en');
  const before = snapshot(copy.vault);
  assertRefused(adopt(copy, { ...ANSWERS.en, commit: true }), copy, before, /adopt never commits/);
  // "commit": false says nothing adopt would not honour.
  assert.equal(adopt(copy, { ...ANSWERS.en, commit: false }).status, EXIT.FAILURE);
});

test('a state directory inside the vault, or one already holding a machine.json, is refused with exit 2 and nothing written', () => {
  const inside = freshCopy('en');
  const before = snapshot(inside.vault);
  const r = adopt({ ...inside, state: join(inside.vault, '.state') }, ANSWERS.en);
  assert.equal(r.status, EXIT.USAGE, r.stderr);
  assert.match(r.stderr, /is inside the vault/);
  assert.deepEqual(snapshot(inside.vault), before);

  const taken = freshCopy('en');
  mkdirSync(taken.state);
  writeFileSync(join(taken.state, MACHINE_FILENAME), '{}\n');
  const beforeVault = snapshot(taken.vault);
  const beforeState = snapshot(taken.state);
  const t = adopt(taken, ANSWERS.en);
  assert.equal(t.status, EXIT.USAGE, t.stderr);
  assert.match(t.stderr, /already exists, and adopt never overwrites it/);
  assert.deepEqual(snapshot(taken.vault), beforeVault);
  assert.deepEqual(snapshot(taken.state), beforeState);
});

test('with stdin not a terminal and no answers, adopt names the first missing answer and exits 2 with nothing written', () => {
  const copy = freshCopy('en');
  const before = snapshot(copy.vault);
  const r = spawnSync(process.execPath, [BIN, 'init', '--adopt', copy.vault, '--lang', 'en'], {
    encoding: 'utf8', env: testEnv(copy.state), cwd: copy.cwd, input: '', timeout: 10000,
  });
  assertRefused(r, copy, before, /no answer for "name"/);
});

test('a .brain-kit directory the vault already has keeps what is in it, recorded as the person\'s', () => {
  const copy = freshCopy('en', { repository: false });
  mkdirSync(join(copy.vault, '.brain-kit', 'prompts'), { recursive: true });
  writeFileSync(join(copy.vault, '.brain-kit', 'prompts', 'curate.md'), '# Their own prompt\n');
  const before = snapshot(copy.vault);
  assert.equal(adopt(copy, ANSWERS.en).status, EXIT.FAILURE, 'the fixture holds two house findings');
  const after = snapshot(copy.vault);
  assert.deepEqual(before.filter((line) => !after.includes(line)), []);
  assert.deepEqual(after.filter((line) => !before.includes(line)).map((line) => line.split(' ')[0]), ['.brain-kit/manifest.json', 'brain-kit.config.json']);
  const entry = readManifest(copy.vault).files.find((f) => f.path === '.brain-kit/prompts/curate.md');
  assert.equal(entry?.class, 'seeded');
});

// --- a failure after the first write --------------------------------------------------

test('a failure after the first write removes everything adopt created and touches nothing of the vault', { skip: IS_ROOT && 'root ignores permissions' }, () => {
  const copy = freshCopy('en');
  // A .brain-kit directory adopt may not write into: the configuration is
  // written, then the manifest cannot be.
  const brainKitDir = join(copy.vault, '.brain-kit');
  mkdirSync(brainKitDir);
  chmodSync(brainKitDir, 0o500);
  const before = snapshot(copy.vault);
  const r = adopt(copy, ANSWERS.en);
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.match(r.stderr, /Everything this run had created was removed/);
  assert.deepEqual(snapshot(copy.vault), before);
  assert.equal(existsSync(copy.state), false, 'the state directory adopt created was removed');
});

// --- the window between the checks and the writes ------------------------------------

function collector() {
  let text = '';
  return { write(chunk) { text += chunk; return true; }, get text() { return text; } };
}

test('a configuration that appears while the questions are answered is refused just before writing', { timeout: 20000 }, async () => {
  const copy = freshCopy('en');
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = collector();
  const stderr = collector();
  const pending = runInit(['--adopt', copy.vault], { stdin, stdout, stderr }, createTranslator('en'), { walkVault, env: testEnv(copy.state), cwd: copy.cwd });
  stdin.write('en\n');
  for (let i = 0; i < 200 && !stdout.text.includes('First name'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.match(stdout.text, /First name/);
  writeFileSync(join(copy.vault, CONFIG_FILENAME), '{"written": "by something else"}\n');
  const before = snapshot(copy.vault);
  for (const line of ['Ana Souza', 'asouza', 'Field Notes', '', 'y', 'UTC']) stdin.write(`${line}\n`);
  stdin.end();
  const code = await pending;
  assert.equal(code, EXIT.USAGE, stdout.text + stderr.text);
  assert.match(stderr.text, /is already adopted/);
  assert.deepEqual(snapshot(copy.vault), before);
  assert.equal(existsSync(copy.state), false);
});

// The last guard, for a file that arrives after the second check: each
// file adopt writes is created exclusively, so one already there is an
// error, and its bytes are never replaced.
test('writeAdoption never replaces a file already there, the configuration or the manifest', () => {
  for (const existing of [CONFIG_FILENAME, MANIFEST_PATH]) {
    const copy = freshCopy('en', { repository: false });
    mkdirSync(join(copy.vault, '.brain-kit'), { recursive: true });
    writeFileSync(join(copy.vault, existing), 'theirs\n');
    const before = snapshot(copy.vault);
    const ledger = [];
    assert.throws(
      () => writeAdoption(copy.vault, { ledger, configText: '{}\n', manifest: { files: [{ path: 'index.md', sha256: 'a'.repeat(64), class: 'seeded' }] } }),
      /EEXIST/,
    );
    assert.equal(readFileSync(join(copy.vault, existing), 'utf8'), 'theirs\n');
    assert.ok(ledger.every((entry) => entry.path !== join(copy.vault, existing)), 'a file adopt did not create is never in its ledger');
    if (existing === MANIFEST_PATH) assert.ok(ledger.some((entry) => entry.path === join(copy.vault, CONFIG_FILENAME)));
    else assert.deepEqual(snapshot(copy.vault), before);
  }
});

test('writeAdoption refuses a manifest it could not read back before writing anything', () => {
  const copy = freshCopy('en', { repository: false });
  const before = snapshot(copy.vault);
  const ledger = [];
  assert.throws(() => writeAdoption(copy.vault, { ledger, configText: '{}\n', manifest: { files: [] } }), /invalid manifest/);
  assert.deepEqual(ledger, []);
  assert.deepEqual(snapshot(copy.vault), before);
});

test('a directory adopt cannot list is refused with exit 2 and nothing written', { skip: IS_ROOT && 'root ignores permissions' }, () => {
  const copy = freshCopy('en', { repository: false });
  const before = snapshot(copy.vault);
  const mode = statSync(copy.vault).mode & 0o7777;
  // Searchable but not listable: index.md can still be stat'd by name.
  chmodSync(copy.vault, 0o300);
  let r;
  try {
    r = adopt(copy, ANSWERS.en);
  } finally {
    chmodSync(copy.vault, mode);
  }
  assertRefused(r, copy, before, /cannot be listed \(EACCES\)/);
});

test('a folder inside the vault adopt cannot read is refused with exit 2 and nothing written', { skip: IS_ROOT && 'root ignores permissions' }, () => {
  const copy = freshCopy('en', { repository: false });
  const locked = join(copy.vault, 'decisions');
  const mode = statSync(locked).mode & 0o7777;
  const before = snapshot(copy.vault);
  chmodSync(locked, 0o000);
  let r;
  try {
    r = adopt(copy, ANSWERS.en);
  } finally {
    chmodSync(locked, mode);
  }
  assertRefused(r, copy, before, /something inside .* cannot be read \(EACCES\)/);
});

test('a configuration that is a dangling symbolic link is still a configuration, and refused', () => {
  const copy = freshCopy('en', { repository: false });
  symlinkSync(join(copy.base, 'nowhere.json'), join(copy.vault, CONFIG_FILENAME));
  const before = snapshot(copy.vault);
  assertRefused(adopt(copy, ANSWERS.en), copy, before, /is already adopted/);
});

// The refusals that need no answer come before the first question: a
// person is never asked six things about a directory adopt was always
// going to refuse.
test('on a terminal, a directory with no root index.md file is refused before a single question is asked', { timeout: 20000 }, async () => {
  for (const shape of ['absent', 'directory']) {
    const copy = freshCopy('en', { repository: false });
    rmSync(join(copy.vault, 'index.md'));
    if (shape === 'directory') mkdirSync(join(copy.vault, 'index.md'));
    const before = snapshot(copy.vault);
    // A terminal that has already said everything it will say: a question
    // asked here ends the run at once instead of waiting.
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.end();
    const stdout = collector();
    const stderr = collector();
    const code = await runInit(['--adopt', copy.vault], { stdin, stdout, stderr }, createTranslator('en'), { walkVault, env: testEnv(copy.state), cwd: copy.cwd });
    assert.equal(code, EXIT.USAGE, `${shape}: ${stdout.text}${stderr.text}`);
    assert.equal(stdout.text, '', `${shape}: no question may be asked`);
    assert.match(stderr.text, /no index\.md at its root/);
    assert.deepEqual(snapshot(copy.vault), before);
    assert.equal(existsSync(copy.state), false);
  }
});

// A read-only git command may refresh the index file as a side effect;
// the checks adopt runs do so with GIT_OPTIONAL_LOCKS=0, and the setting
// does not outlive them.
test('the checks after adopt run with git\'s optional locks off, and the setting is restored afterwards', async () => {
  const copy = freshCopy('en');
  const seen = [];
  const probe = async () => {
    seen.push(process.env.GIT_OPTIONAL_LOCKS);
    return EXIT.OK;
  };
  const had = Object.hasOwn(process.env, 'GIT_OPTIONAL_LOCKS');
  const saved = process.env.GIT_OPTIONAL_LOCKS;
  process.env.GIT_OPTIONAL_LOCKS = 'outer';
  try {
    const file = join(copy.base, 'answers.json');
    writeFileSync(file, JSON.stringify(ANSWERS.en));
    const stdout = collector();
    const stderr = collector();
    const code = await runInit(['--adopt', copy.vault, '--from-answers', file], { stdin: null, stdout, stderr }, createTranslator('en'), {
      walkVault, env: testEnv(copy.state), cwd: copy.cwd, checks: { validate: probe, lint: probe },
    });
    assert.equal(code, EXIT.OK, stdout.text + stderr.text);
    assert.deepEqual(seen, ['0', '0']);
    assert.equal(process.env.GIT_OPTIONAL_LOCKS, 'outer');
  } finally {
    if (had) process.env.GIT_OPTIONAL_LOCKS = saved;
    else delete process.env.GIT_OPTIONAL_LOCKS;
  }
});

// The exit code is the checks' verdict: a clean adoption of a vault the
// checks fail is still a failure to report, and a degraded check is
// never read as success.
test('adopt exits with the worse of the two checks, never better', async () => {
  for (const [validate, lint, expected] of [[EXIT.OK, EXIT.OK, EXIT.OK], [EXIT.FAILURE, EXIT.OK, EXIT.FAILURE], [EXIT.OK, EXIT.DEGRADED, EXIT.DEGRADED]]) {
    const copy = freshCopy('en', { repository: false });
    const file = join(copy.base, 'answers.json');
    writeFileSync(file, JSON.stringify(ANSWERS.en));
    const code = await runInit(['--adopt', copy.vault, '--from-answers', file], { stdin: null, stdout: collector(), stderr: collector() }, createTranslator('en'), {
      walkVault, env: testEnv(copy.state), cwd: copy.cwd, checks: { validate: async () => validate, lint: async () => lint },
    });
    assert.equal(code, expected, `validate ${validate}, lint ${lint}`);
  }
});

// --- fix round 1 ----------------------------------------------------------------------

// I1: .brain-kit is created through, so a link there would put the
// manifest wherever it points (a confidential folder, outside the vault),
// and a file there would fail the write halfway. Both are refused before
// anything is written, the outside directory included.
test('a .brain-kit that is a symbolic link, to a folder of the vault or outside it, or a file, is refused with exit 2 and nothing written', () => {
  for (const shape of ['link-inside', 'link-outside', 'file']) {
    const copy = freshCopy('en');
    const outside = join(copy.base, 'outside');
    mkdirSync(outside);
    const where = join(copy.vault, '.brain-kit');
    if (shape === 'link-inside') symlinkSync(join(copy.vault, 'people'), where);
    else if (shape === 'link-outside') symlinkSync(outside, where);
    else writeFileSync(where, 'not a directory\n');
    const before = snapshot(copy.vault);
    const beforeOutside = snapshot(outside);
    const r = adopt(copy, ANSWERS.en);
    assertRefused(r, copy, before, /exists and is not a directory/);
    assert.deepEqual(snapshot(outside), beforeOutside, `${shape}: something was written outside the vault`);
  }
});

// I2: a folder or a note type named like a machine-only setting would sit
// at a key position of the configuration, which refuses those names
// anywhere; it is left out, said so, and the rest of the vault adopted.
function reservedVault() {
  return tinyVault({
    'cars/one.md': note('model', 'fuel: gas\n'),
    'cars/two.md': note('model', 'fuel: gas\n'),
    'cars/three.md': note('car', 'fuel: diesel\n'),
    'cars/four.md': note('car', 'fuel: diesel\n'),
    'paths/walk.md': note('trail'),
    'paths/climb.md': note('trail'),
    'state_dir/one.md': note('log-entry'),
  });
}

test('a note type or a first-level folder named like a machine-only setting is left out where it would collide, said so, and the rest adopted', () => {
  const { config, notes } = inferConfig(reservedVault(), { lang: 'en' });
  assert.deepEqual(validateConfig(completeDefaults(config, ANSWERS.en, { kitVersion: kitVersion() })), []);
  assert.deepEqual(config.taxonomy.collections, {}, 'cars/ mixes two types; the other two folders are reserved names');
  assert.deepEqual(config.taxonomy.domains, ['cars']);
  assert.deepEqual(config.frontmatter.extensions.fuel, { type: 'enum', values_by_type: { car: ['diesel'] } });
  assert.deepEqual(notes.filter((n) => n.messageKey === 'adopt.note.collection_reserved').map((n) => n.params.dir), ['paths', 'state_dir']);
  assert.deepEqual(notes.filter((n) => n.messageKey === 'adopt.note.enum_type_reserved').map((n) => n.params), [{ field: 'fuel', type: 'model' }]);
});

test('an enum whose only type is reserved is declared a free string, and the vault is still adopted end to end', () => {
  const only = inferConfig(tinyVault({ 'a/one.md': note('model', 'fuel: gas\n'), 'a/two.md': note('model', 'fuel: gas\n') }), { lang: 'en' });
  assert.deepEqual(only.config.frontmatter.extensions.fuel, { type: 'string' });
  const base = makeTempDir('brain-kit-adopt-reserved-');
  const copy = { base, vault: reservedVault(), state: join(base, 'state'), cwd: base };
  const r = adopt(copy, ANSWERS.en);
  assert.notEqual(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.deepEqual(loadConfig(copy.vault).taxonomy.domains, ['cars']);
  assert.doesNotMatch(r.stderr, /defect in brain-kit/);
});

// I3: the refusal of an invalid configuration still fires, and before
// anything is written, when inference hands it one.
test('an inferred configuration the kit refuses stops adopt with exit 1 before anything is written', async () => {
  const copy = freshCopy('en');
  const before = snapshot(copy.vault);
  const file = join(copy.base, 'answers.json');
  writeFileSync(file, JSON.stringify(ANSWERS.en));
  const invalid = (root, options) => {
    const inferred = inferConfig(root, options);
    inferred.config.frontmatter.extensions.model = { type: 'string' };
    return inferred;
  };
  const stdout = collector();
  const stderr = collector();
  const code = await runInit(['--adopt', copy.vault, '--from-answers', file], { stdin: null, stdout, stderr }, createTranslator('en'), {
    walkVault, env: testEnv(copy.state), cwd: copy.cwd, infer: invalid,
  });
  assert.equal(code, EXIT.FAILURE, stdout.text + stderr.text);
  assert.match(stderr.text, /frontmatter\.extensions\.model: machine-only key/);
  assert.deepEqual(snapshot(copy.vault), before);
  assert.equal(existsSync(copy.state), false);
});

// I3: a file adopt reads only to checksum it (an attachment) is as much a
// refusal as an unreadable note: never recorded with the hash of nothing.
test('an unreadable file that is not a note, tracked or ignored, is refused with exit 2 and never checksummed', { skip: IS_ROOT && 'root ignores permissions' }, () => {
  for (const rel of ['projects/plan.pdf', 'private-scans/scan.pdf']) {
    const copy = freshCopy('en', { repository: false });
    appendFileSync(join(copy.vault, '.gitignore'), 'private-scans/\n');
    mkdirSync(join(copy.vault, rel.split('/')[0]), { recursive: true });
    const target = join(copy.vault, rel);
    writeFileSync(target, '%PDF-1.4 fictional\n');
    const mode = statSync(target).mode & 0o7777;
    const before = snapshot(copy.vault);
    chmodSync(target, 0o000);
    let r;
    try {
      r = adopt(copy, ANSWERS.en);
    } finally {
      chmodSync(target, mode);
    }
    assertRefused(r, copy, before, /cannot be read \(EACCES\)/);
  }
});

// M1: one description per field, the one the configuration ends up with.
test('the confidentiality field is described once, as what it is declared, whatever values it holds', () => {
  const clean = inferConfig(join(FIXTURES, 'en'), { lang: 'en' }).notes;
  const about = (list, field) => list.filter((n) => n.params.field === field && n.messageKey.startsWith('adopt.note.extension'));
  assert.deepEqual(about(clean, 'confidential').map((n) => n.params.kind), ['boolean']);
  const yes = inferConfig(tinyVault({ 'a/one.md': note('x', 'confidential: yes\n'), 'a/two.md': note('x', 'confidential: yes\n') }), { lang: 'en' }).notes;
  assert.deepEqual(about(yes, 'confidential'), [], 'no "string" or "enum" before the boolean it becomes');
  assert.ok(keysOf(yes).includes('adopt.note.confidential_not_boolean'));
});

test('a value the reader cannot read is named with its file, and the field is declared from the notes it can read', () => {
  const root = tinyVault({
    'a/one.md': note('x', 'stage: open\n'),
    'a/two.md': note('x', 'stage: open\n'),
    'a/three.md': note('x', 'stage: done\n\tstill part of it\n'),
    'a/four.md': note('x', 'aliases: [one, uno]\n'),
  });
  const { config, notes } = inferConfig(root, { lang: 'en' });
  assert.deepEqual(notes.find((n) => n.messageKey === 'adopt.note.extension_unreadable').params, { field: 'stage', file: 'a/three.md' });
  assert.deepEqual(config.frontmatter.extensions.stage, { type: 'enum', values_by_type: { x: ['open'] } }, 'declared from the two notes it could read');
  assert.deepEqual(notes.find((n) => n.messageKey === 'adopt.note.extension_skipped').params, { field: 'aliases', file: 'a/four.md' });
  assert.ok(!notes.some((n) => n.messageKey === 'adopt.note.extension_skipped' && n.params.field === 'stage'));
});

test('a template or an index carrying the marker makes no directory confidential, is named, and "nothing marked" is never said', () => {
  const root = tinyVault({
    'templates/template-person.md': note('person', 'confidential: true\n'),
    'notes/index.md': '---\nconfidential: true\n---\n# Notes\n',
    'notes/one.md': note('x'),
  });
  const { config, notes } = inferConfig(root, { lang: 'en' });
  assert.deepEqual(config.privacy.confidential_dirs, ['people/']);
  assert.deepEqual(notes.find((n) => n.messageKey === 'adopt.note.confidential_uncovered').params.files, ['notes/index.md', 'templates/template-person.md']);
  assert.ok(!keysOf(notes).includes('adopt.note.confidential_field_unused'));
  assert.ok(keysOf(notes).includes('adopt.note.confidential_dirs_default'));
});

test('a marked note in a folder and another in its subfolder add the folder once', () => {
  const root = tinyVault({ 'a/one.md': note('x', 'confidential: true\n'), 'a/b/two.md': note('x', 'confidential: true\n') });
  assert.deepEqual(inferConfig(root, { lang: 'en' }).config.privacy.confidential_dirs, ['people/', 'a/']);
});

// M3: a person with an existing vault meets --adopt from the help and from
// init's refusal of that vault.
test('brain-kit --help lists init --adopt, and init refusing an existing vault points to it', () => {
  const copy = freshCopy('en');
  for (const lang of ['en', 'pt-BR']) {
    const help = brainKit(['--help'], { env: testEnv(copy.state, { BRAIN_KIT_LANG: lang }), cwd: copy.cwd });
    assert.match(help.stdout, /init --adopt \[dir\]/, lang);
  }
  const repo = brainKit(['init', copy.vault, '--yes'], { env: testEnv(copy.state), cwd: copy.cwd });
  assert.equal(repo.status, EXIT.USAGE);
  assert.match(repo.stderr, /already a git repository.*brain-kit init --adopt/s);
  const plain = freshCopy('en', { repository: false });
  const full = brainKit(['init', plain.vault, '--yes'], { env: testEnv(plain.state), cwd: plain.cwd });
  assert.equal(full.status, EXIT.USAGE);
  assert.match(full.stderr, /is not empty.*brain-kit init --adopt/s);
});

// M4: after an adoption with findings, the output says the adoption is done
// and to edit the configuration, not to run adopt again; and a machine.json
// left from an earlier adoption is named as something to remove.
test('after an adoption with findings, the way forward is to edit the configuration, and a redo names every file to remove', () => {
  const copy = freshCopy('en');
  const r = adopt(copy, ANSWERS.en);
  assert.equal(r.status, EXIT.FAILURE);
  assert.match(r.stdout, /The adoption is done/);
  assert.match(r.stdout, /edit brain-kit\.config\.json: do not run adopt again/);
  rmSync(join(copy.vault, CONFIG_FILENAME));
  rmSync(join(copy.vault, MANIFEST_PATH));
  const redo = adopt(copy, ANSWERS.en);
  assert.equal(redo.status, EXIT.USAGE);
  assert.match(redo.stderr, /earlier adoption of this vault that you are redoing, remove it too/);
  assert.doesNotMatch(redo.stderr, /no longer exists/);
});

// --- final review of slice 1D: what adopt publishes, and the gate it installs ---

// brain-kit on PATH the way a person has it, through a shim to this
// checkout, in a directory with a space in its name; the only brain-kit a
// hook can find.
function withBrainKitOnPath(base, extra = {}) {
  const shims = join(base, 'a bin dir');
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(shims, 'brain-kit'), `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} "$@"\n`);
  chmodSync(join(shims, 'brain-kit'), 0o755);
  return testEnv(join(base, 'state'), { PATH: `${shims}${delimiter}${process.env.PATH}`, ...extra });
}

function commitAll(cwd, message, paths = ['-A'], env = undefined) {
  for (const args of [['add', ...paths], ['-c', 'maintenance.auto=false', 'commit', '-q', '-m', message]]) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: env ?? { ...process.env, ...TEST_GIT_ENV } });
    assert.equal(r.status, 0, r.stderr);
  }
}

// A hand-made Portuguese vault, as the reviewer built it: .gitignore
// holds .env and privado/, the .env a password, privado/ a third party's
// file; a note left untracked on purpose, and a tracked file deleted
// from the working tree.
function vaultWithIgnoredFiles() {
  const copy = freshCopy('pt-BR', { repository: false });
  appendFileSync(join(copy.vault, '.gitignore'), '.env\nprivado/\n');
  writeFileSync(join(copy.vault, 'anexo.txt'), 'a tracked attachment\n');
  const quiet = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
  assert.equal(git(copy.vault, [...quiet, 'init', '-q', '-b', 'main']).status, 0);
  commitAll(copy.vault, 'Notes as they were');
  assert.equal(git(copy.vault, ['rm', '-q', '--cached', 'anexo.txt']).status, 0);
  assert.equal(git(copy.vault, ['-c', 'maintenance.auto=false', 'commit', '-q', '-m', 'untrack the attachment']).status, 0);
  writeFileSync(join(copy.vault, '.env'), 'DB_PASSWORD=hunter2\n');
  mkdirSync(join(copy.vault, 'privado'));
  writeFileSync(join(copy.vault, 'privado', 'diagnostico-da-carla.txt'), 'fictional\n');
  return copy;
}

const ENV_HASH = createHash('sha256').update('DB_PASSWORD=hunter2\n').digest('hex');

test('C1: adopt records only what git would publish, and neither an ignored file nor an ignored folder reaches a remote through the gate', () => {
  const copy = vaultWithIgnoredFiles();
  const env = withBrainKitOnPath(copy.base);
  const file = join(copy.base, 'answers.json');
  writeFileSync(file, `${JSON.stringify(ANSWERS['pt-BR'], null, 2)}\n`);
  const r = brainKit(['init', '--adopt', copy.vault, '--from-answers', file], { env, cwd: copy.cwd });
  assert.equal(r.status, EXIT.OK, `${r.stdout}\n${r.stderr}`);

  const manifestText = readFileSync(join(copy.vault, MANIFEST_PATH), 'utf8');
  const paths = readManifest(copy.vault).files.map((f) => f.path);
  assert.ok(!paths.includes('.env') && !manifestText.includes('.env"'), 'an ignored file is never named');
  assert.ok(!paths.some((p) => p.startsWith('privado/')) && !manifestText.includes('privado'), 'an ignored folder is never named');
  assert.ok(!manifestText.includes(ENV_HASH), 'an ignored file is never hashed');
  assert.ok(paths.includes('anexo.txt'), 'an untracked file git would add is recorded');
  assert.ok(paths.includes('.gitignore') && paths.includes('index.md'), 'tracked files are recorded');

  // Commit as adopt says, push through the gate it installed.
  commitAll(copy.vault, 'adopt brain-kit', ['brain-kit.config.json', '.brain-kit/manifest.json', '.githooks/pre-push'], { ...env });
  const bare = join(copy.base, 'origin.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(git(copy.vault, ['remote', 'add', 'origin', bare]).status, 0);
  const push = spawnSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: copy.vault, encoding: 'utf8', env });
  assert.equal(push.status, 0, push.stderr);
  assert.match(push.stderr, /brain-kit leak gate ran/, 'the push went through the gate');
  // The remote's files, the manifest it holds, and every byte of its
  // history: no ignored name and no ignored content (the .gitignore itself
  // names both patterns, which is the person's own published file).
  const names = git(bare, ['ls-tree', '-r', '--name-only', 'main']).stdout.split('\n');
  assert.ok(names.includes('.brain-kit/manifest.json'), 'the manifest reached the remote');
  assert.ok(!names.includes('.env') && !names.some((n) => n.startsWith('privado/')));
  const remoteManifest = git(bare, ['show', 'main:.brain-kit/manifest.json']).stdout;
  assert.ok(!remoteManifest.includes('.env"') && !remoteManifest.includes('privado') && !remoteManifest.includes(ENV_HASH), remoteManifest);
  const published = git(bare, ['log', '--all', '-p', '--format=%H %s']).stdout;
  for (const secret of ['diagnostico', 'hunter2', ENV_HASH]) assert.ok(!published.includes(secret), `${secret} reached the remote`);
});

test('C1: outside a repository nothing is ignored, and the vault is walked, dot-files included', () => {
  const copy = freshCopy('pt-BR', { repository: false });
  appendFileSync(join(copy.vault, '.gitignore'), '.env\n');
  writeFileSync(join(copy.vault, '.env'), 'DB_PASSWORD=hunter2\n');
  assert.equal(adopt(copy, ANSWERS['pt-BR']).status, EXIT.OK);
  assert.ok(readManifest(copy.vault).files.some((f) => f.path === '.env'));
});

test('C1: of what git lists, a tracked file deleted from the working tree and a link out of the vault are not recorded', () => {
  const copy = freshCopy('pt-BR');
  const outside = join(copy.base, 'outside.txt');
  writeFileSync(outside, 'not the vault\n');
  symlinkSync(outside, join(copy.vault, 'fora.txt'));
  symlinkSync('nucleo', join(copy.vault, 'atalho'));
  commitAll(copy.vault, 'a link out');
  // A submodule: git lists its directory, which is not a file of this vault.
  const sub = join(copy.vault, 'sub');
  mkdirSync(sub);
  assert.equal(git(sub, ['init', '-q']).status, 0);
  writeFileSync(join(sub, 'x.txt'), 'x\n');
  commitAll(sub, 'sub');
  assert.equal(git(copy.vault, ['add', 'sub']).status, 0);
  assert.equal(git(copy.vault, ['commit', '-q', '-m', 'a gitlink']).status, 0);
  rmSync(join(copy.vault, 'nucleo', 'principios.md'));
  const r = adopt(copy, ANSWERS['pt-BR']);
  assert.notEqual(r.status, EXIT.USAGE, `${r.stdout}${r.stderr}`);
  const paths = readManifest(copy.vault).files.map((f) => f.path);
  assert.ok(!paths.includes('sub') && !paths.some((p) => p.startsWith('sub/')), paths.join(', '));
  assert.ok(!paths.includes('atalho'), 'a link to a directory is not a file');
  assert.ok(!paths.includes('fora.txt'), `${r.stdout}${r.stderr}`);
  assert.ok(!paths.includes('nucleo/principios.md'));
  assert.ok(paths.includes('nucleo/ritmo-semanal.md'));
});

test('C1: a vault in a repository whose git cannot answer is refused with exit 2, never walked', () => {
  const copy = freshCopy('pt-BR');
  const shims = join(copy.base, 'broken git');
  mkdirSync(shims);
  writeFileSync(join(shims, 'git'), '#!/usr/bin/env bash\necho "fatal: broken for this test" >&2\nexit 128\n');
  chmodSync(join(shims, 'git'), 0o755);
  const before = snapshot(copy.vault);
  const file = join(copy.base, 'answers.json');
  writeFileSync(file, `${JSON.stringify(ANSWERS['pt-BR'], null, 2)}\n`);
  const r = brainKit(['init', '--adopt', copy.vault, '--from-answers', file], { env: testEnv(copy.state, { PATH: `${shims}${delimiter}${process.env.PATH}` }), cwd: copy.cwd });
  assertRefused(r, copy, before, /git could not read the repository/);
});

test('I1: an adopted vault refuses a committed credential on push, and the refusal ends with what to do', () => {
  const copy = freshCopy('pt-BR');
  const env = withBrainKitOnPath(copy.base);
  const file = join(copy.base, 'answers.json');
  writeFileSync(file, `${JSON.stringify(ANSWERS['pt-BR'], null, 2)}\n`);
  assert.equal(brainKit(['init', '--adopt', copy.vault, '--from-answers', file], { env, cwd: copy.cwd }).status, EXIT.OK);
  commitAll(copy.vault, 'adopt brain-kit', ['brain-kit.config.json', '.brain-kit/manifest.json', '.githooks/pre-push']);
  const bare = join(copy.base, 'origin.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(git(copy.vault, ['remote', 'add', 'origin', bare]).status, 0);
  const clean = spawnSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: copy.vault, encoding: 'utf8', env });
  assert.equal(clean.status, 0, clean.stderr);
  const pushed = git(bare, ['rev-parse', 'main']).stdout.trim();

  writeFileSync(join(copy.vault, 'chave.txt'), `AWS_ACCESS_KEY_ID=AKIA${'IOSFODNN7EXAMPL3'}\n`);
  commitAll(copy.vault, 'uma chave');
  rmSync(join(copy.vault, 'chave.txt'));
  commitAll(copy.vault, 'sem a chave');
  const leak = spawnSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: copy.vault, encoding: 'utf8', env });
  assert.notEqual(leak.status, 0, 'a committed credential must refuse the push');
  assert.equal(git(bare, ['rev-parse', 'main']).stdout.trim(), pushed, 'nothing reached the remote');
  const lines = leak.stderr.split('\n');
  const verdict = lines.findIndex((line) => /brain-kit push-gate refused/.test(line));
  assert.ok(verdict > 0, leak.stderr);
  assert.equal(lines[verdict - 1], MATCH_REMEDY, 'the last line push-gate prints is the remedy');
});

test('I1: a hook of the person\'s own, a core.hooksPath elsewhere, or hooks in .git/hooks are left exactly as they are, and the line that adds the gate is printed', () => {
  const shapes = {
    'own hook': (vault) => {
      mkdirSync(join(vault, '.githooks'));
      writeFileSync(join(vault, '.githooks', 'pre-push'), '#!/bin/sh\necho mine\n');
      chmodSync(join(vault, '.githooks', 'pre-push'), 0o755);
      assert.equal(git(vault, ['config', 'core.hooksPath', '.githooks']).status, 0);
      return ['gate.hook_present', { hook: join(realpathSync(vault), '.githooks', 'pre-push'), line: GATE_LINE }];
    },
    'own hook, not wired': (vault) => {
      mkdirSync(join(vault, '.githooks'));
      writeFileSync(join(vault, '.githooks', 'pre-push'), '#!/bin/sh\necho mine\n');
      return ['gate.hook_present', { hook: join(realpathSync(vault), '.githooks', 'pre-push'), line: GATE_LINE }];
    },
    'hooksPath elsewhere': (vault) => {
      assert.equal(git(vault, ['config', 'core.hooksPath', '.husky']).status, 0);
      return ['gate.hooks_path_elsewhere', { value: '.husky', hook: join(realpathSync(vault), '.husky', 'pre-push'), line: GATE_LINE }];
    },
    'hook in .git/hooks': (vault) => {
      writeFileSync(join(vault, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(vault, '.git', 'hooks', 'pre-commit'), 0o755);
      const dir = join(realpathSync(vault), '.git', 'hooks');
      return ['gate.default_hooks', { dir, hooks: ['pre-commit'], hook: join(dir, 'pre-push'), line: GATE_LINE }];
    },
    'the template, not wired': (vault) => {
      mkdirSync(join(vault, '.githooks'));
      writeFileSync(join(vault, '.githooks', 'pre-push'), readFileSync(join(KIT_ROOT, 'templates', 'githooks', 'pre-push')));
      return ['gate.unwired', { hook: join(realpathSync(vault), '.githooks', 'pre-push'), command: 'git config core.hooksPath .githooks' }];
    },
  };
  for (const [name, prepare] of Object.entries(shapes)) {
    const copy = freshCopy('pt-BR');
    const [key, params] = prepare(copy.vault);
    const hooksPathBefore = git(copy.vault, ['config', '--local', '--list']).stdout;
    const before = snapshot(copy.vault).filter((line) => line.startsWith('.githooks') || line.startsWith('.git/hooks') || line.startsWith('.git/config '));
    const r = adopt(copy, ANSWERS['pt-BR']);
    assert.equal(r.status, EXIT.OK, `${name}: ${r.stdout}${r.stderr}`);
    const after = snapshot(copy.vault).filter((line) => line.startsWith('.githooks') || line.startsWith('.git/hooks') || line.startsWith('.git/config '));
    assert.deepEqual(after, before, `${name}: a hook or the repository configuration changed`);
    assert.equal(git(copy.vault, ['config', '--local', '--list']).stdout, hooksPathBefore, name);
    assert.ok(!readManifest(copy.vault).files.some((f) => f.path === '.githooks/pre-push' && f.class === 'managed'), `${name}: recorded as the kit's`);
    const line = createTranslator('pt-BR')(key, params);
    assert.ok(r.stdout.split('\n').includes(line), `${name}: expected "${line}" in:\n${r.stdout}`);
  }
});

test('I1: a global core.hooksPath is the person\'s too, and is left as it is', () => {
  const copy = freshCopy('pt-BR');
  const globalConfig = join(copy.base, 'gitconfig');
  writeFileSync(globalConfig, '[core]\n\thooksPath = ~/my-hooks\n');
  const file = join(copy.base, 'answers.json');
  writeFileSync(file, `${JSON.stringify(ANSWERS['pt-BR'], null, 2)}\n`);
  const r = brainKit(['init', '--adopt', copy.vault, '--from-answers', file], { env: testEnv(copy.state, { GIT_CONFIG_GLOBAL: globalConfig }), cwd: copy.cwd });
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  assert.equal(existsSync(join(copy.vault, '.githooks')), false);
  assert.notEqual(git(copy.vault, ['config', '--local', 'core.hooksPath']).status, 0);
  assert.match(r.stdout, /core\.hooksPath/);
});

test('I1: with --no-hook, adopt says no gate was installed and how to install it, and every existing byte is kept', () => {
  const copy = freshCopy('pt-BR');
  const before = snapshot(copy.vault);
  const r = adopt(copy, ANSWERS['pt-BR'], ['--no-hook']);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  const after = snapshot(copy.vault);
  assert.deepEqual(before.filter((line) => !after.includes(line)), []);
  assert.deepEqual(after.filter((line) => !before.includes(line)).map((line) => line.split(' ')[0]), ['.brain-kit', '.brain-kit/manifest.json', 'brain-kit.config.json']);
  assert.ok(r.stdout.includes(createTranslator('pt-BR')('init.adopt_no_hook', { command: 'brain-kit update --install-hook' })), r.stdout);
  const fresh = join(copy.base, 'a new vault');
  const init = brainKit(['init', fresh, '--no-hook', '--yes', '--lang', 'en'], { env: testEnv(join(copy.base, 'other state')), cwd: copy.cwd });
  assert.equal(init.status, EXIT.USAGE, `--no-hook belongs to --adopt only:\n${init.stdout}${init.stderr}`);
  assert.match(init.stderr, /--no-hook/);
  assert.equal(existsSync(fresh), false, 'init wrote nothing');
});

test('I1: a gate that fails to install makes adopt exit at least 3, removes what the step wrote, and says so', () => {
  const copy = freshCopy('pt-BR');
  // A FILE where the hook's directory goes: the hook cannot be written.
  writeFileSync(join(copy.vault, '.githooks'), 'not a directory\n');
  commitAll(copy.vault, 'a file named .githooks');
  const r = adopt(copy, ANSWERS['pt-BR']);
  assert.equal(r.status, EXIT.DEGRADED, r.stdout + r.stderr);
  assert.ok(r.stderr.includes('brain-kit update --install-hook'), r.stderr);
  assert.equal(readFileSync(join(copy.vault, '.githooks'), 'utf8'), 'not a directory\n');
  assert.notEqual(git(copy.vault, ['config', '--local', 'core.hooksPath']).status, 0);
});

test('C1 and I1: with GIT_DIR exported for another repository, adopt lists the vault\'s own files and wires the vault\'s own gate, leaving that repository byte-identical', () => {
  const copy = freshCopy('pt-BR');
  const foreign = join(copy.base, 'foreign');
  mkdirSync(foreign);
  assert.equal(git(foreign, ['init', '-q']).status, 0);
  writeFileSync(join(foreign, 'segredo-alheio.txt'), 'not the vault\n');
  // The other repository tracks a .env; the vault ignores its own. Asked
  // of the wrong repository, git would call the vault's .env tracked.
  writeFileSync(join(foreign, '.env'), 'OTHER=1\n');
  commitAll(foreign, 'foreign');
  appendFileSync(join(copy.vault, '.gitignore'), '.env\n');
  commitAll(copy.vault, 'ignore .env');
  writeFileSync(join(copy.vault, '.env'), 'DB_PASSWORD=hunter2\n');
  const foreignGit = join(foreign, '.git');
  const foreignBefore = snapshot(foreignGit);
  const file = join(copy.base, 'answers.json');
  writeFileSync(file, `${JSON.stringify(ANSWERS['pt-BR'], null, 2)}\n`);
  const r = brainKit(['init', '--adopt', copy.vault, '--from-answers', file], {
    env: testEnv(copy.state, { GIT_DIR: foreignGit, GIT_INDEX_FILE: join(foreignGit, 'index') }), cwd: copy.cwd,
  });
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  assert.deepEqual(snapshot(foreignGit), foreignBefore, 'the other repository changed');
  const paths = readManifest(copy.vault).files.map((f) => f.path);
  assert.ok(!paths.includes('segredo-alheio.txt') && paths.includes('index.md'), paths.join(', '));
  assert.ok(!paths.includes('.env'), 'the vault ignores its .env, whatever another repository tracks');
  assert.equal(git(copy.vault, ['config', '--local', 'core.hooksPath']).stdout.trim(), '.githooks');
});
