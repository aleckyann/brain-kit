import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT, kitVersion } from '../src/version.mjs';
import { createTranslator, loadMessages, interpolate, REFERENCE_LANG, SUPPORTED_LANGS } from '../src/lang.mjs';

const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));

function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

test('kitVersion matches package.json', () => {
  assert.equal(kitVersion(), pkg.version);
});

test('every supported pack has the same keys as the reference pack', () => {
  const reference = loadMessages(REFERENCE_LANG);
  for (const lang of SUPPORTED_LANGS) {
    const pack = loadMessages(lang);
    assert.deepEqual(Object.keys(pack).sort(), Object.keys(reference).sort(), `key set differs in ${lang}`);
    for (const key of Object.keys(reference)) {
      assert.equal(typeof pack[key], 'string', `${lang}.${key} must be a string`);
      assert.ok(pack[key].length > 0, `${lang}.${key} must not be empty`);
      assert.deepEqual(placeholders(pack[key]), placeholders(reference[key]), `placeholders differ for ${lang}.${key}`);
    }
  }
});

test('pt-BR values contain no em dash and no emoji', () => {
  for (const [key, value] of Object.entries(loadMessages('pt-BR'))) {
    assert.doesNotMatch(value, /\u2014/, `${key} contains an em dash`);
    assert.doesNotMatch(value, /\p{Extended_Pictographic}/u, `${key} contains an emoji`);
  }
});

test('interpolate replaces known placeholders and keeps unknown ones', () => {
  assert.equal(interpolate('a {x} b {y}', { x: 1 }), 'a 1 b {y}');
});

// An array param joins with ", ": the one list-formatting decision this
// module owns so no rule module has to make it (src/rules/house.mjs's
// type-enum and extension-fields rules used to call `.join(', ')`
// themselves before passing an already-formed string; they now pass
// the array through and this is where it becomes text).
test('interpolate joins an array param with ", ", but stringifies a non-array value plainly', () => {
  assert.equal(interpolate('allowed: {list}', { list: ['a', 'b', 'c'] }), 'allowed: a, b, c');
  assert.equal(interpolate('allowed: {list}', { list: [] }), 'allowed: ');
  assert.equal(interpolate('count: {n}', { n: 3 }), 'count: 3');
});

test('translator returns the requested language', () => {
  const t = createTranslator('en');
  assert.match(t('cli.unknown_command', { command: 'zzz' }), /zzz/);
});

test('translator falls back to the reference pack and warns once', () => {
  const warnings = [];
  const packs = {
    'pt-BR': { 'lang.fallback_warning': 'fallback {key} {lang} {reference}', 'only.here': 'so em pt-BR', 'shared': 'compartilhado' },
    en: { 'lang.fallback_warning': 'fallback {key} {lang} {reference}', shared: 'shared' },
  };
  const t = createTranslator('en', { warn: (m) => warnings.push(m), packs });
  assert.equal(t('only.here'), 'so em pt-BR');
  assert.equal(t('only.here'), 'so em pt-BR');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /only\.here/);
});

test('translator throws on an unknown key', () => {
  const t = createTranslator('pt-BR');
  assert.throws(() => t('does.not.exist'), /Unknown message key/);
});

test('unsupported language falls back to the reference pack with a warning', () => {
  const warnings = [];
  const t = createTranslator('xx', { warn: (m) => warnings.push(m) });
  assert.match(t('cli.unknown_command', { command: 'q' }), /q/);
  assert.equal(warnings.length, 1);
});

// --- the vault skeletons: parity across languages ----------------------------
//
// Each language ships a vault skeleton (lang/<code>/vault/) that `init`
// copies, with folder names from that language's own taxonomy. The two
// must be the same vault in two languages: the same roles, the same
// number of files in each role, and tables of the same width, or a person
// who picks Portuguese gets a different product from one who picks
// English. test/skeleton.test.mjs proves each skeleton valid on its own;
// this proves the two agree with each other.
//
// Every directory of a skeleton must be a role named here, so a directory
// added to one language and not mapped here fails this test instead of
// being silently left out of the comparison.
const SKELETON_ROLES = Object.freeze({
  root: { en: '', 'pt-BR': '' },
  core: { en: 'core', 'pt-BR': 'nucleo' },
  people: { en: 'people', 'pt-BR': 'pessoas' },
  organizations: { en: 'organizations', 'pt-BR': 'organizacoes' },
  projects: { en: 'projects', 'pt-BR': 'projetos' },
  decisions: { en: 'decisions', 'pt-BR': 'decisoes' },
  reflections: { en: 'reflections', 'pt-BR': 'reflexoes' },
  references: { en: 'references', 'pt-BR': 'referencias' },
  books: { en: 'references/books', 'pt-BR': 'referencias/livros' },
  pending: { en: 'pending', 'pt-BR': 'pendencias' },
  memory: { en: 'memory', 'pt-BR': 'memoria' },
  attachments: { en: 'attachments', 'pt-BR': 'anexos' },
  templates: { en: 'templates', 'pt-BR': 'templates' },
});

function skeletonFiles(lang, rel = '') {
  const root = join(KIT_ROOT, 'lang', lang, 'vault');
  const out = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...skeletonFiles(lang, path));
    else out.push(path);
  }
  return out;
}

function roleOf(lang, file) {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  return Object.keys(SKELETON_ROLES).find((role) => SKELETON_ROLES[role][lang] === dir);
}

// The width of every markdown table in `text`: a header row followed by a
// delimiter row. Cells are counted on an unescaped "|".
function tableWidths(text) {
  const lines = text.split('\n');
  const widths = [];
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (/^\s*\|/.test(lines[i]) && /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(lines[i + 1])) widths.push(cells(lines[i]).length);
  }
  return widths;
}

// One line per file, with nothing a translation changes: its frontmatter
// `type`, how many headings of each level it has, how many links, and the
// width of each table. The profile of a role is the sorted list of its
// files' lines, so two languages agree only when each role holds files of
// the same kinds with the same sections (review I3: dropping one section
// from one language, or retyping one note, used to pass).
function fileShape(text) {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const type = frontmatter ? (/^type:[ \t]*(.+)$/m.exec(frontmatter[1])?.[1].trim() ?? '(no type)') : '(no frontmatter)';
  const body = frontmatter ? text.slice(frontmatter[0].length) : text;
  const headings = [1, 2, 3, 4].map((level) => body.split('\n').filter((line) => line.startsWith(`${'#'.repeat(level)} `)).length);
  const links = (body.match(/\]\(/g) ?? []).length;
  return JSON.stringify({ type, headings, links, tables: tableWidths(text) });
}

function skeletonProfile(lang) {
  const profile = Object.fromEntries(Object.keys(SKELETON_ROLES).map((role) => [role, { files: 0, tables: [], shapes: [] }]));
  for (const file of skeletonFiles(lang)) {
    const role = roleOf(lang, file);
    assert.ok(role, `${lang} skeleton: ${file} is in a directory no role maps`);
    const text = readFileSync(join(KIT_ROOT, 'lang', lang, 'vault', file), 'utf8');
    profile[role].files += 1;
    profile[role].tables.push(...tableWidths(text));
    profile[role].shapes.push(fileShape(text));
  }
  for (const entry of Object.values(profile)) {
    entry.tables.sort((a, b) => a - b);
    entry.shapes.sort();
  }
  return profile;
}

test('every supported language ships a vault skeleton with the same roles, file counts and table widths as the reference', () => {
  const reference = skeletonProfile(REFERENCE_LANG);
  // Not an empty comparison: every role holds at least its index, and the
  // pending and core roles hold the three configured tables.
  for (const [role, entry] of Object.entries(reference)) assert.ok(entry.files > 0, `${REFERENCE_LANG} skeleton: role ${role} holds no file`);
  assert.ok(reference.pending.tables.length >= 2 && reference.core.tables.length >= 1, 'the reference skeleton must carry its configured tables');
  for (const lang of SUPPORTED_LANGS) {
    assert.deepEqual(skeletonProfile(lang), reference, `${lang} skeleton differs from ${REFERENCE_LANG}`);
  }
});

test('each skeleton table is as wide as the column contract its language configures', () => {
  for (const lang of SUPPORTED_LANGS) {
    const defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
    for (const [key, contract] of Object.entries(defaults.taxonomy.columns)) {
      const file = defaults.taxonomy.files[key];
      const widths = tableWidths(readFileSync(join(KIT_ROOT, 'lang', lang, 'vault', file), 'utf8'));
      assert.ok(widths.length > 0, `${lang}: ${file} holds no table`);
      for (const width of widths) assert.equal(width, contract.columns.length, `${lang}: a table in ${file} is not ${contract.columns.length} columns wide`);
    }
  }
});

test('the two default configurations have the same shape, differing only in names a language owns', () => {
  // Paths whose KEYS are language vocabulary (a collection's folder, an
  // extension field's name, a stale policy's folder) are compared by
  // count; everything else by its full key path.
  const byCount = new Set(['$.taxonomy.collections', '$.frontmatter.extensions', '$.stale_policy.months']);
  function shape(value, path = '$') {
    if (Array.isArray(value) || value === null || typeof value !== 'object') return [path];
    if (byCount.has(path)) return [`${path}#${Object.keys(value).length}`];
    return Object.entries(value).flatMap(([key, sub]) => shape(sub, `${path}.${key}`));
  }
  const load = (lang) => JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
  const reference = shape(load(REFERENCE_LANG)).sort();
  for (const lang of SUPPORTED_LANGS) assert.deepEqual(shape(load(lang)).sort(), reference, `${lang} defaults differ in shape`);
});

// The same note in each language, file by file. A note's path is its
// role's folder plus its own name, and the names below are the ones a
// translation changes; every other name (index.md, log.md, the root
// files) is the same in every language. Comparing per pair rather than
// per role catches what a per-role profile cannot: one note replaced by a
// different one of the same shape (review I3: values replaced by a goals
// note, with its index updated).
const SKELETON_NOTE_NAMES = Object.freeze([
  { en: 'identity.md', 'pt-BR': 'identidade.md' },
  { en: 'values.md', 'pt-BR': 'valores.md' },
  { en: 'response-guidelines.md', 'pt-BR': 'diretrizes-de-resposta.md' },
  { en: 'decision-frameworks.md', 'pt-BR': 'frameworks-de-decisao.md' },
  { en: 'weekly-rhythm.md', 'pt-BR': 'ritmo-semanal.md' },
  { en: 'follow-ups.md', 'pt-BR': 'acompanhamentos.md' },
  { en: 'promises.md', 'pt-BR': 'promessas.md' },
  { en: 'template-person.md', 'pt-BR': 'modelo-pessoa.md' },
  { en: 'template-organization.md', 'pt-BR': 'modelo-organizacao.md' },
  { en: 'template-project.md', 'pt-BR': 'modelo-projeto.md' },
  { en: 'template-decision.md', 'pt-BR': 'modelo-decisao.md' },
  { en: 'template-reflection.md', 'pt-BR': 'modelo-reflexao.md' },
  { en: 'template-book.md', 'pt-BR': 'modelo-livro.md' },
]);

function translatePath(file, from, to) {
  const role = roleOf(from, file);
  const base = file.slice(file.lastIndexOf('/') + 1);
  const name = SKELETON_NOTE_NAMES.find((entry) => entry[from] === base)?.[to] ?? base;
  const dir = SKELETON_ROLES[role][to];
  return dir === '' ? name : `${dir}/${name}`;
}

test('every note of the reference skeleton has its counterpart in each language, with the same shape', () => {
  const referenceFiles = skeletonFiles(REFERENCE_LANG);
  assert.ok(referenceFiles.length >= 30, `the reference skeleton holds only ${referenceFiles.length} files`);
  for (const lang of SUPPORTED_LANGS) {
    const files = skeletonFiles(lang).sort();
    const translated = referenceFiles.map((file) => translatePath(file, REFERENCE_LANG, lang));
    assert.deepEqual([...translated].sort(), files, `${lang} skeleton does not hold the same notes as ${REFERENCE_LANG}`);
    referenceFiles.forEach((file, index) => {
      const read = (l, f) => readFileSync(join(KIT_ROOT, 'lang', l, 'vault', f), 'utf8');
      assert.equal(fileShape(read(lang, translated[index])), fileShape(read(REFERENCE_LANG, file)), `${lang} ${translated[index]} differs in shape from ${REFERENCE_LANG} ${file}`);
    });
  }
});
