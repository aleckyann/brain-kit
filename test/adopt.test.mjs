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
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT, kitVersion } from '../src/version.mjs';
import { CONFIG_FILENAME, MACHINE_FILENAME, findMachineOnlyKeys, loadConfig, validateConfig, validateMachine } from '../src/config.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { MANIFEST_PATH, readManifest } from '../src/manifest.mjs';
import { completeDefaults } from '../src/init/config.mjs';
import { inferConfig, monthOffset, readDefaults, writeAdoption } from '../src/init/adopt.mjs';
import { runInit } from '../src/commands/init.mjs';
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
  test(`${c.fixture} fixture, adopted in ${c.lang}: only the configuration and the manifest are new, and every existing byte is kept`, () => {
    const copy = freshCopy(c.fixture);
    const before = snapshot(copy.vault);
    assert.ok(before.length > 40, 'the snapshot must see the repository too');
    assert.ok(before.some((line) => line.startsWith('.git/index ')), 'the snapshot must include the git index');

    const r = adopt(copy, ANSWERS[c.lang]);
    assert.equal(r.status, c.exit, `${r.stdout}\n${r.stderr}`);

    const after = snapshot(copy.vault);
    const kept = new Set(after);
    assert.deepEqual(before.filter((line) => !kept.has(line)), [], 'a pre-existing path was changed or removed');
    const added = after.filter((line) => !before.includes(line)).map((line) => line.split(' ').slice(0, 2).join(' '));
    assert.deepEqual(added, ['.brain-kit dir', '.brain-kit/manifest.json file', 'brain-kit.config.json file']);

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

    // The manifest: every file that was there, each seeded, each hash the
    // bytes on disk; nothing under .git.
    const manifest = readManifest(copy.vault);
    const existing = before.filter((line) => / file /.test(line)).map((line) => line.split(' ')[0]).filter((path) => !path.startsWith('.git/'));
    assert.deepEqual(manifest.files.map((f) => f.path).sort(), existing.sort());
    assert.ok(manifest.files.length >= 20);
    assert.ok(manifest.files.some((f) => f.path === '.gitignore'), 'a dot-file the vault already has is recorded as the person\'s');
    for (const entry of manifest.files) {
      assert.equal(entry.class, 'seeded', entry.path);
      assert.equal(entry.sha256, createHash('sha256').update(readFileSync(join(copy.vault, entry.path))).digest('hex'), entry.path);
    }

    // machine.json, outside the vault, private.
    const machinePath = join(copy.state, MACHINE_FILENAME);
    const machine = JSON.parse(readFileSync(machinePath, 'utf8'));
    assert.deepEqual(validateMachine(machine), []);
    assert.equal(machine.canonical_path, realpathSync(copy.vault));
    assert.equal(statSync(machinePath).mode & 0o777, 0o600);
    assert.equal(statSync(copy.state).mode & 0o777, 0o700);

    // No hook, no hooksPath, no commit: the repository is its own.
    assert.equal(existsSync(join(copy.vault, '.githooks')), false);
    assert.notEqual(git(copy.vault, ['config', 'core.hooksPath']).status, 0);
    assert.equal(git(copy.vault, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');

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
    decisions: { type: 'decision', filename_pattern: 'YYYY-MM-<slug>' },
    pending: { type: 'pending' },
    people: { type: 'person' },
    projects: { type: 'project', template: 'templates/template-project.md' },
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
  assert.deepEqual(config.stale_policy.months, { 'people/': 6, 'organizations/': 12, 'pending/': 3 });
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
  assert.deepEqual(config.stale_policy.months, { 'pessoas/': 6, 'organizacoes/': 12, 'pendencias/': 3 });
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
  assert.deepEqual(notes.find((n) => n.messageKey === 'adopt.note.confidential_at_root').params.files, ['secret.md']);
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

test('with no stale_after anywhere, the stale policy is the default one, and said so', () => {
  const { config, notes } = inferConfig(tinyVault({ 'a/one.md': note('x') }), { lang: 'en' });
  assert.deepEqual(config.stale_policy, readDefaults('en').stale_policy);
  assert.ok(keysOf(notes).includes('adopt.note.stale_defaults'));
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
  assertRefused(adopt(withConfig, ANSWERS.en), withConfig, beforeConfig, /already a brain-kit vault/);

  const withManifest = freshCopy('en');
  mkdirSync(join(withManifest.vault, '.brain-kit'));
  writeFileSync(join(withManifest.vault, MANIFEST_PATH), '{"files":[]}\n');
  const beforeManifest = snapshot(withManifest.vault);
  assertRefused(adopt(withManifest, ANSWERS.en), withManifest, beforeManifest, /already a brain-kit vault/);

  const secondRun = freshCopy('en');
  assert.equal(adopt(secondRun, ANSWERS.en).status, EXIT.FAILURE, 'the fixture holds two house findings');
  const beforeSecond = snapshot(secondRun.vault);
  const stateBefore = snapshot(secondRun.state);
  const again = adopt(secondRun, ANSWERS.en);
  assert.equal(again.status, EXIT.USAGE, again.stderr);
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
  assert.match(t.stderr, /already exists, and init never overwrites it/);
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

test('a failure after the first write removes everything adopt created and touches nothing of the vault', () => {
  const copy = freshCopy('en');
  // A file where the manifest's directory would go: the configuration is
  // written, then the manifest cannot be.
  writeFileSync(join(copy.vault, '.brain-kit'), 'not a directory\n');
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
  assert.match(stderr.text, /already a brain-kit vault/);
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
  assertRefused(adopt(copy, ANSWERS.en), copy, before, /already a brain-kit vault/);
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
