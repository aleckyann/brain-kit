// The vault skeleton and default configuration each language ships
// (lang/<code>/vault/ and lang/<code>/config.defaults.json), which `init`
// copies and completes. What this file proves, per language: the skeleton,
// with its defaults completed by a fixed set of example answers through
// the one merge that exists (src/init/config.mjs), is a vault that
// `brain-kit validate` passes with no finding of any tier and that
// `brain-kit lint --base all` passes with EVERY rule raised to `error`.
// The skeleton's structural parity across languages (same roles, same
// file count per role, same column count per table) is test/lang.test.mjs's,
// beside the parity of the two message packs.
//
// Both commands run for real, through bin/brain-kit.mjs, in a vault whose
// path carries a space and an accented letter, because that is what a
// vault path on a real machine looks like. And both runs are checked for
// having looked at something, not only for having found nothing: a
// command that exits zero having read no note is the most common way a
// test like this one passes while proving nothing. So each run's JSON
// report must name as many notes as the skeleton holds, and a broken copy
// of the same skeleton must make each command fail.
//
// Example data: the fictional owner Ana, example.com, and the actor
// human:ana, per this project's rule against household data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT, kitVersion } from '../src/version.mjs';
import { CONFIG_FILENAME, validateConfig } from '../src/config.mjs';
import { SUPPORTED_LANGS } from '../src/lang.mjs';
import { LINT_RULES } from '../src/rules/lint.mjs';
import { GENERIC_PATTERNS } from '../src/leak.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { PLACEHOLDERS, completeDefaults } from '../src/init/config.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const LANGS = ['en', 'pt-BR'];

const ANSWERS = Object.freeze({
  en: {
    lang: 'en',
    name: 'Ana',
    handle: 'ana',
    email: 'ana@example.com',
    title: "Ana's Second Brain",
    repo: 'ana/brain',
    timezone: 'UTC',
  },
  'pt-BR': {
    lang: 'pt-BR',
    name: 'Ana',
    handle: 'ana',
    email: 'ana@example.com',
    title: 'Segundo c' + String.fromCharCode(0xe9) + 'rebro da Ana',
    repo: 'ana/brain',
    timezone: 'America/Sao_Paulo',
  },
});

function defaultsPath(lang) {
  return join(KIT_ROOT, 'lang', lang, 'config.defaults.json');
}

function readDefaults(lang) {
  return JSON.parse(readFileSync(defaultsPath(lang), 'utf8'));
}

function skeletonDir(lang) {
  return join(KIT_ROOT, 'lang', lang, 'vault');
}

function listFiles(root, rel = '') {
  const out = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(root, path));
    else out.push(path);
  }
  return out;
}

// Every lint rule raised to `error`, keeping each rule's own settings
// (a rule configured as an object keeps its object, with `severity` set).
function everyRuleAtError(config) {
  const lint = { ...config.lint };
  for (const { settingKey } of LINT_RULES) {
    const current = lint[settingKey];
    lint[settingKey] = current !== null && typeof current === 'object' ? { ...current, severity: 'error' } : 'error';
  }
  return { ...config, lint };
}

// A directory whose path has a space and an accented letter in it,
// built at runtime so this file stays ASCII.
function vaultPath(lang) {
  const accented = String.fromCharCode(0xe9);
  return join(makeTempDir(`brain-kit-skeleton-${lang}-`), `R${accented}sum${accented} notes`, 'vault');
}

function materialise(lang, config) {
  const dir = vaultPath(lang);
  cpSync(skeletonDir(lang), dir, { recursive: true });
  writeFileSync(join(dir, CONFIG_FILENAME), `${JSON.stringify(config, null, 2)}\n`);
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  return dir;
}

function brainKit(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, BRAIN_KIT_LANG: 'en' } });
}

function completedConfig(lang) {
  const config = completeDefaults(readDefaults(lang), ANSWERS[lang]);
  assert.deepEqual(validateConfig(config), [], `the completed ${lang} defaults must be schema-valid`);
  return everyRuleAtError(config);
}

function markdownCount(lang) {
  return listFiles(skeletonDir(lang)).filter((file) => file.endsWith('.md')).length;
}

for (const lang of LANGS) {
  test(`${lang}: the skeleton passes validate with no finding of any tier`, () => {
    const dir = materialise(lang, completedConfig(lang));
    const result = brainKit(['validate', dir, '--json']);
    assert.equal(result.status, EXIT.OK, `validate exited ${result.status}\n${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.stale, []);
    for (const [tier, count] of Object.entries(report.counts)) assert.equal(count, 0, `${tier} count must be 0`);
  });

  test(`${lang}: the skeleton passes lint --base all with every rule at error, having read every note`, () => {
    const config = completedConfig(lang);
    for (const { settingKey } of LINT_RULES) {
      const setting = config.lint[settingKey];
      assert.equal(typeof setting === 'string' ? setting : setting.severity, 'error', `lint.${settingKey} must be at error for this run`);
    }
    const dir = materialise(lang, config);
    const result = brainKit(['lint', dir, '--base', 'all', '--json']);
    assert.equal(result.status, EXIT.OK, `lint exited ${result.status}\n${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.skipped, []);
    assert.equal(report.scope.files, markdownCount(lang), 'lint must have judged every note of the skeleton');
    assert.equal(report.secrets.ran, true);
    // Every skeleton file plus the configuration itself: the configuration
    // is scanned against the credential shapes its own
    // privacy.secret_patterns lists, and must not flag itself.
    assert.equal(report.secrets.scanned, markdownCount(lang) + 1);
  });

  test(`${lang}: a broken copy of the skeleton fails both commands, so the clean runs above can fail`, () => {
    const config = completedConfig(lang);
    const dir = materialise(lang, config);
    const followups = config.taxonomy.files.followups;
    const [firstHeading] = config.taxonomy.columns.followups.columns;
    const original = readFileSync(join(dir, followups), 'utf8');
    writeFileSync(join(dir, followups), original.replace(`| ${firstHeading} |`, '| Renamed |'));
    const lint = brainKit(['lint', dir, '--base', 'all', '--json']);
    assert.equal(lint.status, EXIT.FAILURE);
    assert.deepEqual(JSON.parse(lint.stdout).findings.map((finding) => finding.id), ['columns'], lint.stdout);

    writeFileSync(join(dir, followups), original.replace(/^type: .*\n/m, ''));
    const validate = brainKit(['validate', dir, '--json']);
    assert.equal(validate.status, EXIT.FAILURE);
    assert.ok(JSON.parse(validate.stdout).findings.some((finding) => finding.id === 'type-required'), validate.stdout);
  });

  // Slice D, task 3 review (I2), end to end in each language: a note
  // outside the confidential directory, marked with the field this
  // language's defaults name, fails lint. The Portuguese vault's marking
  // used to pass in silence.
  test(`${lang}: a note marked confidential outside the confidential directory fails lint, in the field this language names`, () => {
    const config = completedConfig(lang);
    const field = config.privacy.confidential_field;
    assert.equal(field, lang === 'en' ? 'confidential' : 'confidencial');
    assert.equal(config.frontmatter.extensions[field]?.type, 'boolean', `${field} must be this language's own boolean extension`);
    const dir = materialise(lang, config);
    const projects = Object.keys(config.taxonomy.collections).find((key) => config.taxonomy.collections[key].type === 'project');
    const note = `${projects}/leaky.md`;
    writeFileSync(join(dir, note), `---\ntype: project\ntitle: Leaky\ndescription: A note marked confidential in the wrong place.\n${field}: true\ngenerated:\n  by: human:ana\n  at: 2026-09-22T00:00:00+00:00\n---\n\n# Leaky\n`);
    const index = join(dir, projects, 'index.md');
    writeFileSync(index, `${readFileSync(index, 'utf8')}\n- [Leaky](leaky.md)\n`);
    const result = brainKit(['lint', dir, '--base', 'all', '--json']);
    assert.equal(result.status, EXIT.FAILURE, result.stdout);
    const findings = JSON.parse(result.stdout).findings;
    assert.deepEqual(findings.map((finding) => [finding.id, finding.check, finding.file, finding.params.field]), [['privacy', 'confidential-field-outside', note, field]]);
  });

  test(`${lang}: the defaults name every lint rule, carry no trace of an example owner, and track the kit`, () => {
    const defaults = readDefaults(lang);
    assert.equal(defaults.lang, lang);
    assert.ok(SUPPORTED_LANGS.includes(lang));
    assert.equal(defaults.kit_version, kitVersion());
    for (const { settingKey } of LINT_RULES) {
      assert.ok(Object.hasOwn(defaults.lint, settingKey), `lint.${settingKey} must be present in the ${lang} defaults`);
    }
    // The style rule reports "nothing configured" when it is named with no
    // forbidden character, so naming it means configuring it.
    assert.ok(defaults.lint.style.forbidden_chars.length > 0);
    assert.equal(defaults.lint.style.forbidden_chars[0], String.fromCharCode(0x2014));
    // The generic credential shapes, exactly, so the list a person extends
    // starts from what the scanner already applies; each is a regular
    // expression that does not match its own text, which the lint run
    // above proves by scanning this very file.
    assert.deepEqual(defaults.privacy.secret_patterns, [...GENERIC_PATTERNS]);

    const raw = readFileSync(defaultsPath(lang), 'utf8');
    assert.doesNotMatch(raw, /\bana\b/i, 'the example owner must not appear in the defaults');
    assert.doesNotMatch(raw, /example\.com/);
    for (const token of Object.values(PLACEHOLDERS)) {
      assert.ok(raw.includes(token), `placeholder ${token} is filled by completeDefaults but absent from the ${lang} defaults`);
    }
    assert.ok(!raw.includes(String.fromCharCode(0x2014)), 'the defaults spell the forbidden character as a JSON escape, never the literal byte');
  });

  test(`${lang}: the skeleton itself carries no trace of an example owner`, () => {
    for (const file of listFiles(skeletonDir(lang))) {
      const text = readFileSync(join(skeletonDir(lang), file), 'utf8');
      assert.doesNotMatch(text, /\bana\b|example\.com|human:[a-z]/i, `${file} must be generic`);
    }
  });
}

// --- completeDefaults ------------------------------------------------------

test('completeDefaults fills the owner, vault and actor fields and leaves the defaults untouched', () => {
  const defaults = readDefaults('en');
  const before = JSON.stringify(defaults);
  const config = completeDefaults(defaults, ANSWERS.en);
  assert.equal(JSON.stringify(defaults), before, 'the defaults object must not be mutated');
  assert.equal(config.owner.name, 'Ana');
  assert.equal(config.owner.handle, 'ana');
  assert.equal(config.owner.email, 'ana@example.com');
  assert.equal(config.vault.title, "Ana's Second Brain");
  assert.equal(config.vault.repo, 'ana/brain');
  assert.equal(config.vault.timezone, 'UTC');
  assert.equal(config.actors.human, 'human:ana');
  assert.equal(config.git.agent_identity.name, "Ana's Second Brain (curator)");
  assert.deepEqual(config.sources.calendar.calendars, ['ana@example.com']);
  assert.equal(config.briefing.calendar_id, 'ana@example.com');
  assert.deepEqual(validateConfig(config), []);
});

test('completeDefaults keeps the agent identity suffix in the vault language', () => {
  const config = completeDefaults(readDefaults('pt-BR'), ANSWERS['pt-BR']);
  assert.equal(config.git.agent_identity.name, `${ANSWERS['pt-BR'].title} (curador)`);
});

test('completeDefaults reads a skipped email or repository as none, and the result still validates', () => {
  for (const skipped of [undefined, null, '']) {
    const config = completeDefaults(readDefaults('en'), { ...ANSWERS.en, email: skipped, repo: skipped });
    assert.equal(config.owner.email, null);
    assert.equal(config.vault.repo, null);
    assert.deepEqual(config.sources.calendar.calendars, []);
    assert.equal(config.briefing.calendar_id, null);
    assert.deepEqual(validateConfig(config), []);
  }
});

test('completeDefaults refuses answers for another language than its defaults', () => {
  assert.throws(() => completeDefaults(readDefaults('en'), ANSWERS['pt-BR']), /answers are for "pt-BR" but the defaults are for "en"/);
});

test('completeDefaults refuses a required answer that is not a string, since "human:undefined" would pass the schema', () => {
  for (const key of ['lang', 'name', 'handle', 'title', 'timezone']) {
    const answers = { ...ANSWERS.en };
    delete answers[key];
    assert.throws(() => completeDefaults(readDefaults('en'), answers), new RegExp(`answer "${key}" must be a string`));
  }
});

test('completeDefaults refuses to return a configuration with a placeholder left unfilled, which the schema would accept', () => {
  const defaults = readDefaults('en');
  defaults.owner.role = PLACEHOLDERS.ownerName;
  assert.throws(() => completeDefaults(defaults, ANSWERS.en), /placeholders left unfilled:\n {2}\$\.owner\.role: <owner-name>/);
});

test('completeDefaults finds an unfilled placeholder inside a list and inside a longer string too', () => {
  const inList = readDefaults('en');
  inList.sources.transcripts.include_projects = [`-home-${PLACEHOLDERS.ownerHandle}-brain`];
  assert.throws(() => completeDefaults(inList, ANSWERS.en), /\$\.sources\.transcripts\.include_projects\[0\]: <owner-handle>/);
});

test('completeDefaults inserts a title literally, with no replacement pattern expanded', () => {
  const config = completeDefaults(readDefaults('en'), { ...ANSWERS.en, title: "Ana's $& $' brain" });
  assert.equal(config.git.agent_identity.name, "Ana's $& $' brain (curator)");
});
