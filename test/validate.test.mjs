// The `validate` command: the one piece that actually walks a vault and
// hands src/rules/spec.mjs and src/rules/house.mjs the shared { files,
// context } their own tests only ever built by hand. Driven mostly
// through the real binary (spawnSync), per this project's own standing
// rule that a command's tests exercise the thing a person actually
// runs, not only the function underneath it.
//
// Fix round 1 rewrote most of this file. The stub audit from round 0
// proved the wrong thing: a fully emptied module had zero survivors,
// and yet four contract clauses (the single walk, the link checker's
// full path set, the reader's normalisation, and the read cache) had NO
// test at all, because gutting a whole function is not the same as
// perturbing one clause of it. This round replaces that instrument:
// each of those four clauses gets its own test, built so that mutating
// exactly that clause (and nothing else) in a copy of the tree makes a
// NAMED test fail. Which test catches which mutation is recorded in
// .superpowers/sdd/2026-09-18-phase-1a-vault-core-and-validate/task-6-report.md,
// "Fix round 1", since the mutation itself is never committed here.
//
// A few tests below are deliberately unit-level (importing runValidate,
// buildReport, partitionFindings or makeReadFile directly) rather than
// spawning the real binary: counting an internal call, or forcing a
// finding shape no real rule currently produces, needs in-process
// access that a child process's exit code and stdout alone cannot give.
// Every other test still drives bin/brain-kit.mjs for real.
//
// Example data: the fictional owner Ana and example.com throughout, and
// the actor human:ana, per this project's own standing rule against real
// personal or company names leaking through a fixture built to test the
// public engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { walkVault } from '../src/vault.mjs';
import { runValidate, buildReport, partitionFindings, makeReadFile, computeStale } from '../src/commands/validate.mjs';
import { makeVault } from './helpers/vault-fixture.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');

// --- fixture content ---------------------------------------------------------

const CLEAN_LOG = [
  '## 2026-09-18',
  '',
  'Second entry, most recent.',
  '',
  'Example of what a log entry looks like, shown for documentation,',
  'never read as a real heading or a real date:',
  '',
  '```',
  '## not a real heading, just an example',
  '## 2099-01-01',
  '```',
  '',
  '## 2026-09-17',
  '',
  'First entry.',
  '',
].join('\n');

const INDEX = '# Welcome\n';

const CLEAN_PERSON = [
  '---',
  'type: person',
  'description: an example person',
  'generated: { by: human:ana, at: 2026-09-18T09:30:00Z }',
  '---',
  '# Ana',
  '',
  'An example person, with no links, so none of the link rules have anything to say.',
  '',
].join('\n');

// One spec-must finding (type is missing) and one house finding
// (timestamp is forbidden by the default fixture config), and nothing
// else: description and generated are both present and well formed, so
// neither required-fields nor generated-actor has anything to add.
const BROKEN_PERSON = [
  '---',
  'description: a person missing its type',
  'generated: { by: human:ana, at: 2026-09-18T09:30:00Z }',
  'timestamp: 2026-09-18T09:30:00Z',
  '---',
  '# Broken',
  '',
].join('\n');

// Missing only its type, no forbidden field: used where a lone must
// finding is wanted without a house finding riding along.
const MISSING_TYPE_ONLY = [
  '---',
  'description: a person missing its type, for the deviation test',
  'generated: { by: human:ana, at: 2026-09-18T09:30:00Z }',
  '---',
  '# Missing type',
  '',
].join('\n');

// Otherwise clean, past its declared stale_after (2020, always in the past).
const STALE_OLD = [
  '---',
  'type: person',
  'description: an example person whose note is overdue for review',
  'generated: { by: human:ana, at: 2020-01-01T00:00:00Z }',
  'stale_after: 2020-06-01T00:00:00Z',
  '---',
  '# Old note',
  '',
].join('\n');

// The paired positive for STALE_OLD: same shape, but its stale_after is
// far in the future, so it must never appear in the stale report.
const FRESH_FUTURE = [
  '---',
  'type: person',
  'description: an example person whose note is not due for review yet',
  'generated: { by: human:ana, at: 2026-09-18T09:30:00Z }',
  'stale_after: 2099-01-01T00:00:00Z',
  '---',
  '# Fresh note',
  '',
].join('\n');

// stale_after as a plain date (no UTC offset): a should-level,
// timestamp-deviation-eligible finding (spec.mjs's stale-after-format),
// with no must finding riding along.
const MIGRATING_DATE = [
  '---',
  'type: person',
  'description: a note mid migration off plain dates',
  'generated: { by: human:ana, at: 2026-09-18T09:30:00Z }',
  'stale_after: 2026-12-18',
  '---',
  '# Migrating',
  '',
].join('\n');

// A note whose only content is a file-relative link to a real,
// non-markdown attachment. Clean under every house setting EXCEPT
// link-target-exists, which is exactly the one this fixture exists to
// exercise: the target only resolves if context.all carries every file
// the walk found, attachments included, not only the markdown subset.
const LINKS_TO_ATTACHMENT = [
  '---',
  'type: person',
  'description: an example person with one link to a real attachment',
  'generated: { by: human:ana, at: 2026-09-18T09:30:00Z }',
  '---',
  '# Ana',
  '',
  'See [the diagram](../attachments/diagram.png) for context.',
  '',
].join('\n');

// A log whose one heading is deliberately not a date: with CRLF line
// endings and a leading byte-order mark. Correctly normalised, spec.mjs's
// log-format rule reads "## Notes" as a real heading and reports it
// should-level, not-a-date. Read the CRLF and the BOM raw (unnormalised),
// and `/^## (.+)$/` never matches that line at all (the trailing \r a
// bare `$` cannot cross, the BOM sitting where `#` must be), so the
// heading is never even seen: the SAME real defect the note has goes
// unreported, silently, which is the failure this clause exists to
// prevent. String.fromCharCode keeps this source file itself ASCII-only.
const BOM = String.fromCharCode(0xfeff);
const CRLF_LOG_WITH_UNRECOGNISED_HEADING = BOM + ['## Notes', '', 'Free text, not a dated entry on purpose.', ''].join('\r\n');

function fakeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (s) => { stdout += s; } },
      stderr: { write: (s) => { stderr += s; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

// BRAIN_KIT_LANG is set to English by default purely so this test file's
// own assertions can match stable English substrings for the errors that
// happen BEFORE a vault (and therefore a vault language) is known. Once
// a vault is found, the report itself follows config.lang, never this
// variable; several tests below deliberately set it to something else
// to prove exactly that.
function run(args, { cwd, input = '', env } = {}) {
  return spawnSync(process.execPath, [BIN, 'validate', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LANG: 'en', ...env },
  });
}

function noVaultDir() {
  return mkdtempSync(join(tmpdir(), 'brain-kit-validate-novault-'));
}

// --- outside a vault, paired with the same directory once it is one --------

test('validate outside a vault exits 2 naming what is missing, never a stack trace; the same directory, once it is a vault, exits 0', () => {
  const outside = noVaultDir();
  const outsideResult = run([outside]);
  assert.equal(outsideResult.status, EXIT.USAGE);
  assert.equal(outsideResult.stdout, '');
  assert.match(outsideResult.stderr, /no brain-kit vault/);
  assert.doesNotMatch(outsideResult.stderr, /at Object|\.mjs:\d+:\d+/); // no stack trace

  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON }, config: { lang: 'en' } });
  const insideResult = run([root]);
  assert.equal(insideResult.status, EXIT.OK);
  assert.match(insideResult.stdout, /no findings/i);
});

// --- a path argument that names no real scope, paired with real ones -------

test('a path argument that does not exist exits 2 naming it; a real subdirectory of the same vault still climbs to that vault', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON }, config: { lang: 'en' } });

  const typo = join(root, 'people', 'this-directory-does-not-exist');
  const missing = run([typo]);
  assert.equal(missing.status, EXIT.USAGE);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /does not exist/);

  const realSubdir = run([join(root, 'people')]);
  assert.equal(realSubdir.status, EXIT.OK);
});

test('a path argument that is a file, not a directory, exits 2 naming it, rather than silently climbing to the enclosing vault', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON }, config: { lang: 'en' } });
  const result = run([join(root, 'people', 'ana.md')]);
  assert.equal(result.status, EXIT.USAGE);
  assert.match(result.stderr, /not a directory/);
});

// --- resolving from the working directory ------------------------------------

test('validate with no directory argument resolves the vault from the working directory', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON }, config: { lang: 'en' } });
  const result = run([], { cwd: root });
  assert.equal(result.status, EXIT.OK);
  assert.match(result.stdout, /no findings/i);
});

// --- a conforming vault --------------------------------------------------

test('a conforming vault exits 0 and says so', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON }, config: { lang: 'en' } });
  const result = run([root]);
  assert.equal(result.status, EXIT.OK);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /no findings/i);
  assert.match(result.stdout, /Specification, must/);
  assert.match(result.stdout, /Specification, should/);
  assert.match(result.stdout, /House rules/);
});

// --- one spec finding and one house finding, each under its own heading ----

test('a vault with one spec finding and one house finding exits 1 and names both under their own headings, in must, should, house order', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/broken.md': BROKEN_PERSON }, config: { lang: 'en' } });
  const result = run([root]);
  assert.equal(result.status, EXIT.FAILURE);

  const mustAt = result.stdout.indexOf('Specification, must');
  const shouldAt = result.stdout.indexOf('Specification, should');
  const houseAt = result.stdout.indexOf('House rules');
  assert.ok(mustAt >= 0 && shouldAt > mustAt && houseAt > shouldAt, result.stdout);

  const mustSection = result.stdout.slice(mustAt, shouldAt);
  const houseSection = result.stdout.slice(houseAt);
  assert.match(mustSection, /people\/broken\.md[\d:-]*\s{2}type-required/);
  assert.match(houseSection, /people\/broken\.md:[\d-]+ {2}forbidden-fields/);
  assert.doesNotMatch(mustSection, /forbidden-fields/);
  assert.doesNotMatch(houseSection, /type-required/);
  // the verdict must not claim conformance above a red build
  assert.match(result.stdout, /not conformant to the format/);
});

// --- a finding's own text is rendered through the pack, in the vault's language ----

// Neither of the two rules involved here builds an English string
// itself (src/rules/spec.mjs and src/rules/house.mjs's own headers): a
// finding carries a messageKey and params, and src/commands/validate.mjs
// is the one place that turns them into a sentence, through the
// translator built from THIS vault's own config.lang. This is the
// direct proof of that, on a real finding's own body, not only on the
// section headings around it: the same BROKEN_PERSON fixture as the
// test above, once in English and once in pt-BR, each showing the
// finding's own message in that language, not the other one, and never
// the bare key name a rendering bug that skipped the pack would leak
// (a raw "spec.type_required.no_frontmatter" is not a sentence in
// either language).
test('a finding\'s own message text is rendered through the vault\'s pack, not left as a bare key and not stuck in one language', () => {
  const enRoot = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/broken.md': BROKEN_PERSON }, config: { lang: 'en' } });
  const enResult = run([enRoot]);
  assert.match(enResult.stdout, /type is required but missing/);
  assert.match(enResult.stdout, /is forbidden by this vault's own configuration but is present/);
  assert.doesNotMatch(enResult.stdout, /spec\.type_required/);
  assert.doesNotMatch(enResult.stdout, /house\.forbidden_fields/);

  const ptRoot = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/broken.md': BROKEN_PERSON }, config: { lang: 'pt-BR' } });
  const ptResult = run([ptRoot]);
  assert.match(ptResult.stdout, /type é obrigatório, mas está ausente/);
  assert.match(ptResult.stdout, /é proibido pela própria configuração deste vault, mas está presente/);
  assert.doesNotMatch(ptResult.stdout, /type is required but missing/);
  assert.doesNotMatch(ptResult.stdout, /spec\.type_required/);
});

// --- --json carries the same counts as the text report, plus `blocking` ----

test('--json prints one object with findings, stale, counts, parserLimits, blocking and the two ruler names, matching the text report', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/broken.md': BROKEN_PERSON }, config: { lang: 'en' } });
  const textResult = run([root]);
  const jsonResult = run([root, '--json']);
  assert.equal(jsonResult.status, textResult.status);
  assert.equal(jsonResult.status, EXIT.FAILURE);

  assert.doesNotThrow(() => JSON.parse(jsonResult.stdout));
  const parsed = JSON.parse(jsonResult.stdout);
  assert.equal(parsed.counts.must, 1);
  assert.equal(parsed.counts.should, 0);
  assert.equal(parsed.counts.house, 1);
  assert.equal(parsed.counts.unexpected, 0);
  assert.equal(parsed.blocking, true);
  assert.equal(parsed.findings.length, 2);
  assert.ok(parsed.findings.some((f) => f.ruler === 'spec' && f.id === 'type-required' && f.level === 'must'));
  assert.ok(parsed.findings.some((f) => f.ruler === 'house' && f.id === 'forbidden-fields'));
  assert.deepEqual(parsed.stale, []);
  assert.ok(Array.isArray(parsed.parserLimits) && parsed.parserLimits.length > 0);
  assert.deepEqual(parsed.rulers, ['spec', 'house']);
});

test('--json prints nothing else on stdout', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON }, config: { lang: 'en' } });
  const result = run([root, '--json']);
  assert.equal(result.status, EXIT.OK);
  const lines = result.stdout.split('\n');
  assert.equal(lines.length, 2); // the object's line, then the trailing empty string after the final \n
  assert.equal(lines[1], '');
  assert.doesNotThrow(() => JSON.parse(lines[0]));
  assert.equal(JSON.parse(lines[0]).blocking, false);
});

// --- staleness is informational and never affects the exit code ------------

test('a note past its stale_after date exits 0 and lists it as informational; a note not yet due is never listed', () => {
  const root = makeVault({
    files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/old.md': STALE_OLD, 'people/fresh.md': FRESH_FUTURE },
    config: { lang: 'en' },
  });
  const result = run([root]);
  assert.equal(result.status, EXIT.OK); // staleness never affects the exit code
  assert.match(result.stdout, /people\/old\.md.*2020-06-01T00:00:00Z/);
  assert.doesNotMatch(result.stdout, /people\/fresh\.md/);

  const jsonResult = run([root, '--json']);
  const parsed = JSON.parse(jsonResult.stdout);
  assert.equal(jsonResult.status, EXIT.OK);
  assert.equal(parsed.blocking, false);
  assert.deepEqual(parsed.findings, []);
  assert.equal(parsed.stale.length, 1);
  assert.equal(parsed.stale[0].file, 'people/old.md');
  assert.equal(parsed.stale[0].staleAfter, '2020-06-01T00:00:00Z');
});

// --- --only-problems omits the clean groups and an empty stale section -----

test('--only-problems omits the clean groups; without it, a clean group is still shown and says so', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/broken.md': BROKEN_PERSON }, config: { lang: 'en' } });

  const full = run([root]);
  assert.match(full.stdout, /Specification, should/);
  assert.match(full.stdout, /No findings in this group/);

  const onlyProblems = run([root, '--only-problems']);
  assert.equal(onlyProblems.status, EXIT.FAILURE);
  assert.doesNotMatch(onlyProblems.stdout, /Specification, should/);
  assert.match(onlyProblems.stdout, /Specification, must/);
  assert.match(onlyProblems.stdout, /House rules/);
});

test('--only-problems also omits an empty staleness section; a non-empty one is shown either way', () => {
  const cleanRoot = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/broken.md': BROKEN_PERSON }, config: { lang: 'en' } });
  const full = run([cleanRoot]);
  assert.match(full.stdout, /stale_after/i);
  const onlyProblems = run([cleanRoot, '--only-problems']);
  assert.doesNotMatch(onlyProblems.stdout, /stale_after/i);

  const staleRoot = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/old.md': STALE_OLD }, config: { lang: 'en' } });
  const staleOnlyProblems = run([staleRoot, '--only-problems']);
  assert.match(staleOnlyProblems.stdout, /people\/old\.md/); // shown even under --only-problems, since it is not empty
});

// --- timestamp_deviation: downgrades should, never touches must ------------

test('validate.timestamp_deviation "allow" downgrades a should-level timestamp finding to a warning that does not affect the exit code; "forbid" (the default) does not', () => {
  const files = { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/migrating.md': MIGRATING_DATE };

  const forbidRoot = makeVault({ files, config: { lang: 'en' } }); // default: validate.timestamp_deviation is "forbid"
  const forbidResult = run([forbidRoot, '--json']);
  assert.equal(forbidResult.status, EXIT.FAILURE);
  const forbidParsed = JSON.parse(forbidResult.stdout);
  assert.equal(forbidParsed.findings.length, 1);
  assert.equal(forbidParsed.findings[0].warning, undefined);
  assert.equal(forbidParsed.blocking, true);

  const allowRoot = makeVault({ files, config: { lang: 'en', validate: { timestamp_deviation: 'allow' } } });
  const allowResult = run([allowRoot, '--json']);
  assert.equal(allowResult.status, EXIT.OK); // the only finding is now a warning
  const allowParsed = JSON.parse(allowResult.stdout);
  assert.equal(allowParsed.findings.length, 1);
  assert.equal(allowParsed.findings[0].warning, true);
  assert.equal(allowParsed.counts.warnings, 1);
  assert.equal(allowParsed.blocking, false);
});

test('a must finding is untouched by timestamp_deviation "allow" even in the same run as a downgraded should finding', () => {
  const root = makeVault({
    files: {
      'index.md': INDEX,
      'memory/log.md': CLEAN_LOG,
      'people/migrating.md': MIGRATING_DATE,
      'people/missing-type.md': MISSING_TYPE_ONLY,
    },
    config: { lang: 'en', validate: { timestamp_deviation: 'allow' } },
  });
  const result = run([root, '--json']);
  assert.equal(result.status, EXIT.FAILURE); // the must finding still counts
  const parsed = JSON.parse(result.stdout);
  const must = parsed.findings.find((f) => f.id === 'type-required');
  const should = parsed.findings.find((f) => f.id === 'stale-after-format');
  assert.ok(must, 'expected the must finding to survive');
  assert.equal(must.warning, undefined);
  assert.ok(should, 'expected the downgraded should finding to survive');
  assert.equal(should.warning, true);
  assert.equal(parsed.blocking, true);
});

// --- bad usage / --help, paired with the same flags used correctly ---------

test('an unrecognized argument exits 2 with usage on stderr; the same vault with real flags exits cleanly', () => {
  const bad = run(['--not-a-real-flag']);
  assert.equal(bad.status, EXIT.USAGE);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /--not-a-real-flag/);

  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON }, config: { lang: 'en' } });
  const good = run([root, '--only-problems', '--json']);
  assert.equal(good.status, EXIT.OK);
  assert.doesNotThrow(() => JSON.parse(good.stdout));
});

test('--help exits 0 and prints usage, rather than the 2 an unrecognized flag gets', () => {
  const help = run(['--help']);
  assert.equal(help.status, EXIT.OK);
  assert.match(help.stdout, /brain-kit validate/);

  const bad = run(['--nope']);
  assert.equal(bad.status, EXIT.USAGE);
});

// --- every user-facing string follows the vault's OWN config.lang ----------

test('the report follows the vault\'s config.lang, never the operator\'s BRAIN_KIT_LANG', () => {
  const enRoot = makeVault({
    files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON },
    config: { lang: 'en' },
  });
  const enButEnvSaysPt = run([enRoot], { env: { BRAIN_KIT_LANG: 'pt-BR' } });
  assert.equal(enButEnvSaysPt.status, EXIT.OK);
  assert.match(enButEnvSaysPt.stdout, /Specification, must/);
  assert.doesNotMatch(enButEnvSaysPt.stdout, /Especifica/);

  const ptRoot = makeVault({
    files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON },
    // Stated explicitly, not left to whatever the shared base fixture
    // (test/fixtures/config/valid.json) happens to declare for lang: an
    // empty override here used to pass only because that fixture was
    // itself pt-BR at the time, which meant this test proved nothing
    // about config.lang and everything about the fixture's own default.
    config: { lang: 'pt-BR' },
  });
  const ptButEnvSaysEn = run([ptRoot], { env: { BRAIN_KIT_LANG: 'en' } });
  assert.equal(ptButEnvSaysEn.status, EXIT.OK);
  assert.match(ptButEnvSaysEn.stdout, /Especifica/);
  assert.doesNotMatch(ptButEnvSaysEn.stdout, /Specification, must/);
});

// --- the three groups are a partition, not three filters --------------------

test('partitionFindings places a recognised finding in exactly one of must, should or house', () => {
  const combined = [
    { ruler: 'spec', id: 'a', check: 'x', level: 'must', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {} },
    { ruler: 'spec', id: 'b', check: 'x', level: 'should', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {} },
    { ruler: 'house', id: 'c', check: 'x', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {} },
  ];
  const { must, should, house, unexpected } = partitionFindings(combined);
  assert.equal(must.length, 1);
  assert.equal(should.length, 1);
  assert.equal(house.length, 1);
  assert.deepEqual(unexpected, []);
});

test('partitionFindings puts a finding with an unrecognised ruler/level combination in `unexpected`, never dropping it out of every group', () => {
  const bogus = { ruler: 'spec', id: 'x', check: 'y', level: 'somehow-else', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {} };
  const { must, should, house, unexpected } = partitionFindings([bogus]);
  assert.deepEqual(must, []);
  assert.deepEqual(should, []);
  assert.deepEqual(house, []);
  assert.deepEqual(unexpected, [bogus]);
});

test('a house finding that somehow carries a level also lands in unexpected, never silently accepted as house', () => {
  const bogus = { ruler: 'house', id: 'x', check: 'y', level: 'must', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {} };
  const { house, unexpected } = partitionFindings([bogus]);
  assert.deepEqual(house, []);
  assert.deepEqual(unexpected, [bogus]);
});

// --- the verdict reads the SAME predicate as the exit code -----------------

test('buildReport: a should-only run and a house-only run both block (exit 1) and both say so, never claiming the vault is simply fine', () => {
  const t = createTranslator('en');
  const shouldOnly = [{ ruler: 'spec', id: 'x', check: 'y', level: 'should', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {} }];
  const houseOnly = [{ ruler: 'house', id: 'x', check: 'y', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {} }];

  for (const combined of [shouldOnly, houseOnly]) {
    const report = buildReport(combined, [], { t });
    assert.equal(report.exitCode, EXIT.FAILURE);
    assert.equal(report.json.blocking, true);
    // the verdict (the last line) must never claim the run is clean
    // above a red build; "No findings in this group." on an unrelated,
    // genuinely-empty group is fine and expected, so check the verdict
    // line specifically, not the whole report.
    const verdictLine = report.text.trim().split('\n').pop();
    assert.doesNotMatch(verdictLine, /no findings/i);
    assert.match(verdictLine, /block this run/);
  }
});

test('buildReport: a must finding says broken; an all-warnings run says conformant with nothing blocking; an empty run says clean', () => {
  const t = createTranslator('en');

  const withMust = [{ ruler: 'spec', id: 'x', check: 'y', level: 'must', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {} }];
  const broken = buildReport(withMust, [], { t });
  assert.equal(broken.exitCode, EXIT.FAILURE);
  assert.match(broken.text, /not conformant to the format/);

  const allWarnings = [{ ruler: 'spec', id: 'x', check: 'y', level: 'should', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {}, warning: true }];
  const warningsOnly = buildReport(allWarnings, [], { t });
  assert.equal(warningsOnly.exitCode, EXIT.OK);
  assert.equal(warningsOnly.json.blocking, false);
  assert.match(warningsOnly.text, /nothing blocks this run/);

  const clean = buildReport([], [], { t });
  assert.equal(clean.exitCode, EXIT.OK);
  assert.match(clean.text, /no findings/i);
});

// --- a lineless finding prints its file alone, never a bare hyphen ---------

// Pinned down as an EXACT line, not a substring match: a looser regex
// (say, one that merely allows an optional trailing "-" or ":") would
// pass just the same whether this printed "people/broken.md" or
// "people/broken.md-", which is exactly the shape of test that let a
// bare hyphen on a lineless finding ship unnoticed before. `line: null`
// is the real, on-purpose shape a finding takes when there is no line
// to point at (type-required's own three "missing" branches, for
// instance): formatFinding's own ternary must render that as the file
// alone, with nothing standing in for the absent number.
test('buildReport: a finding with no line number prints its file alone, never a bare hyphen where a number would be', () => {
  const t = createTranslator('en');
  const lineless = [
    { ruler: 'spec', id: 'type-required', check: 'type-present', level: 'must', file: 'people/broken.md', line: null, messageKey: 'spec.type_required.no_type_key', params: {} },
  ];
  const report = buildReport(lineless, [], { t });
  const findingLine = report.text.split('\n').find((line) => line.includes('type-required'));
  assert.equal(findingLine, `people/broken.md  type-required  ${t('spec.type_required.no_type_key')}`);
});

test('buildReport: an unrecognised finding says the run cannot vouch for conformance, and still blocks', () => {
  const t = createTranslator('en');
  const bogus = [{ ruler: 'spec', id: 'x', check: 'y', level: 'somehow-else', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {} }];
  const report = buildReport(bogus, [], { t });
  assert.equal(report.exitCode, EXIT.FAILURE);
  assert.equal(report.json.counts.unexpected, 1);
  assert.match(report.text, /cannot say whether the vault is conformant/);
  assert.match(report.text, /Tool defect/);
});

// A fourth clause the round-2 audit found, alongside -h/second-arg/bad
// config: `unexpected` is checked FIRST in renderVerdict, ahead of
// `must`, and nothing had ever exercised both at once to prove that
// order matters. When both are present, the honest verdict is
// verdict_unexpected, not verdict_broken: a must finding sitting next
// to one the tool cannot classify is not something this run can vouch
// for as "definitely broken and nothing else in question", since the
// tool's own confusion casts doubt wider than the one finding it is
// actually about.
test('buildReport: a must finding alongside an unexpected one still says "cannot vouch", not "broken"', () => {
  const t = createTranslator('en');
  const both = [
    { ruler: 'spec', id: 'x', check: 'y', level: 'must', file: 'a.md', line: 1, messageKey: 'spec.type_required.empty', params: {} },
    { ruler: 'spec', id: 'z', check: 'y', level: 'somehow-else', file: 'b.md', line: 1, messageKey: 'spec.type_required.empty', params: {} },
  ];
  const report = buildReport(both, [], { t });
  assert.match(report.text, /cannot say whether the vault is conformant/);
  assert.doesNotMatch(report.text, /not conformant to the format/);
});

// formatDefect (the tool-defect section's own line formatter) takes `t`
// for exactly the same reason formatFinding does: this finding's own
// message is a key and params too, and nothing else in this file's
// tests ever reads the RENDERED text of a defect line, only the
// section heading around it. Pinned down as an exact line for the same
// reason the lineless-finding test above is: a substring check would
// have passed just the same against a formatDefect that forgot to
// render at all.
test('buildReport: a tool-defect line renders its own message through the pack too, not only the section around it', () => {
  const t = createTranslator('en');
  const bogus = [{ ruler: 'spec', id: 'x', check: 'y', level: 'somehow-else', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {} }];
  const report = buildReport(bogus, [], { t });
  const defectLine = report.text.split('\n').find((line) => line.startsWith('f.md'));
  assert.equal(defectLine, `f.md:1  ruler=spec id=x level=somehow-else  ${t('spec.type_required.empty')}`);
});

// --- clause 1: the full path set reaching the link checker -----------------

test('a link to a real, non-markdown attachment is not reported broken, because context.all carries the whole walk, attachments included', () => {
  const root = makeVault({
    files: {
      'index.md': INDEX,
      'memory/log.md': CLEAN_LOG,
      'attachments/diagram.png': 'not a real png, just needs to exist\n',
      'people/ana.md': LINKS_TO_ATTACHMENT,
    },
    config: { lang: 'en' },
  });
  const result = run([root, '--json']);
  assert.equal(result.status, EXIT.OK);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.findings, []);
});

// --- clause 2: the reader's normalisation, through the actual output -------

test('a log heading is still recognised through CRLF line endings and a leading byte-order mark, observed through the real report', () => {
  const root = makeVault({
    files: { 'index.md': INDEX, 'memory/log.md': CRLF_LOG_WITH_UNRECOGNISED_HEADING },
    config: { lang: 'en' },
  });
  const result = run([root, '--json']);
  assert.equal(result.status, EXIT.FAILURE); // heading-not-a-date is a real, expected should finding
  const parsed = JSON.parse(result.stdout);
  const heading = parsed.findings.find((f) => f.id === 'log-format' && f.check === 'heading-not-a-date');
  assert.ok(heading, `expected a heading-not-a-date finding; got ${JSON.stringify(parsed.findings)}`);
  // --json exposes the raw messageKey and params, never a formed
  // sentence (the same contract the rule modules themselves keep): the
  // heading text this finding is about is a PARAM, not a substring to
  // grep out of a rendered string.
  assert.equal(heading.messageKey, 'spec.log_format.heading_not_a_date');
  assert.equal(heading.params.heading, 'Notes');
});

// --- clause 3: the read cache ------------------------------------------------

test('makeReadFile caches: a file changed on disk after the first read still reads back as its first content', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'people/note.md': 'first content\n' } });
  const readFile = makeReadFile(root);
  const first = readFile('people/note.md');
  assert.equal(first, 'first content\n');
  writeFileSync(join(root, 'people', 'note.md'), 'second content, written after the first read\n');
  const second = readFile('people/note.md');
  assert.equal(second, first); // the on-disk change is not observed: this call was served from the cache
});

test('makeReadFile: the paired positive, two different paths are read correctly and independently', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'a.md': 'A content\n', 'b.md': 'B content\n' } });
  const readFile = makeReadFile(root);
  assert.equal(readFile('a.md'), 'A content\n');
  assert.equal(readFile('b.md'), 'B content\n');
  assert.equal(readFile('a.md'), 'A content\n'); // still itself, not clobbered by reading 'b.md' in between
});

// --- clause 4 (redesigned): the single walk, with no bypassable reference --

// src/cli.mjs owns the only reference to the real walkVault that ever
// reaches this module (see its own comment on BUILTIN_COMMANDS); this
// test supplies its OWN counting wrapper as that same, now-unbypassable
// parameter. Unlike round 0's version, there is no second, real
// walkVault reference left anywhere in src/commands/validate.mjs's
// module scope for a rogue second call to reach instead: the parameter
// is the only way in, so counting calls through it is no longer the
// weak instrument it was.
test('runValidate calls walkVault exactly once, and still finds real problems through the spy', async () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/broken.md': BROKEN_PERSON }, config: { lang: 'en' } });
  let calls = 0;
  const spy = (...args) => {
    calls += 1;
    return walkVault(...args);
  };
  const { io, stdout } = fakeIo();
  const t = createTranslator('en');
  const code = await runValidate([root], io, t, spy);
  assert.equal(calls, 1);
  assert.equal(code, EXIT.FAILURE);
  assert.match(stdout(), /people\/broken\.md/);
});

test('runValidate calls walkVault exactly once for a clean vault too', async () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON }, config: { lang: 'en' } });
  let calls = 0;
  const spy = (...args) => {
    calls += 1;
    return walkVault(...args);
  };
  const { io } = fakeIo();
  const t = createTranslator('en');
  const code = await runValidate([root], io, t, spy);
  assert.equal(calls, 1);
  assert.equal(code, EXIT.OK);
});

// --- fix round 2 --------------------------------------------------------------
//
// The coordinator's own correction, first: moving the real walkVault
// reference up into src/cli.mjs does not remove the ability to import a
// walk back into this module, only the bypass FROM THIS MODULE'S
// CURRENT SCOPE. A reviewer proved that by adding an aliased import and
// a second call, and every existing test (including both walkVault-spy
// tests above) still passed, because none of them can see an import
// statement. The fix is the same shape the anti-leak test already uses
// for the source tree: read the file's own text and assert about it
// directly, so a future import, aliased or not, shows up as a line in a
// diff AND as a failing test, not only as a line in a diff.

test('src/commands/validate.mjs imports no walk at all, from any module, under any name', () => {
  const source = readFileSync(join(KIT_ROOT, 'src', 'commands', 'validate.mjs'), 'utf8');
  const importLines = source.split('\n').filter((line) => /^\s*import\b/.test(line));
  // Catches `import { walkVault } from '...'` and any alias of it
  // (`import { walkVault as w } from '...'` or `import { real as
  // walkVault } from '...'`: either spelling puts the literal word
  // "walkVault" on the import line), from ANY module path, not only
  // '../vault.mjs' - a re-export from somewhere else would be just as
  // much of a second reference.
  const namedImportOfWalk = importLines.filter((line) => /\bwalkVault\b/.test(line));
  assert.deepEqual(namedImportOfWalk, [], `found an import naming walkVault: ${namedImportOfWalk.join(' | ')}`);
  // Catches `import * as anything from '.../vault.mjs'`, which would
  // reach walkVault as a property (`vaultModule.walkVault(...)`)
  // without the word "walkVault" ever appearing on the import line
  // itself.
  const namespaceImportOfVaultModule = importLines.filter((line) => /import\s*\*\s*as\s+\w+\s*from\s*['"][^'"]*\bvault\.mjs['"]/.test(line));
  assert.deepEqual(namespaceImportOfVaultModule, [], `found a namespace import of vault.mjs: ${namespaceImportOfVaultModule.join(' | ')}`);
});

// --- a `must` finding carrying `warning` is incoherent, not house-clean-away --

// The same one-forgetful-rule-away argument the round 1 partition fix
// accepted for a stray level: today only applyTimestampDeviation
// (src/rules/house.mjs) can ever set `warning`, and it is written to
// only ever touch a `should` finding. Trusting that guard alone, rather
// than also refusing the combination here, is exactly the shape that
// argument was about. A `must`+`warning` finding must never reach `must`
// (printed as non-conformant, excused from the count and the exit
// code); it goes to `unexpected`, and it still blocks.
test('a must-level finding that also carries `warning: true` is incoherent, and is routed to unexpected rather than trusted as a clean must finding', () => {
  const t = createTranslator('en');
  const bogus = [{ ruler: 'spec', id: 'x', check: 'y', level: 'must', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {}, warning: true }];
  const { must, unexpected } = partitionFindings(bogus);
  assert.deepEqual(must, []);
  assert.deepEqual(unexpected, bogus);

  const report = buildReport(bogus, [], { t });
  assert.equal(report.exitCode, EXIT.FAILURE); // still blocks, despite carrying warning: true
  assert.equal(report.json.blocking, true);
  assert.match(report.text, /cannot say whether the vault is conformant/);
});

// --- the tool-defect section is never hidden by --only-problems -------------

// Nothing tested this before: the existing "unrecognised finding" test
// never passed onlyProblems at all, so a regression that started
// treating the defect section like the other three groups (hidden when
// --only-problems is set, which for THIS section is never correct: it
// is never "clean", it either has nothing to report or names a real
// tool defect) would have shipped silently.
test('the tool-defect section is shown even with --only-problems, unlike the three ordinary groups', () => {
  const t = createTranslator('en');
  const bogus = [{ ruler: 'spec', id: 'x', check: 'y', level: 'somehow-else', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {} }];
  const report = buildReport(bogus, [], { onlyProblems: true, t });
  assert.match(report.text, /Tool defect/);
});

// --- staleness: an unparseable date makes no claim either way ----------------

test('a note whose stale_after cannot be parsed at all is never listed as stale, but the malformed shape is still caught elsewhere', () => {
  const GARBLED_STALE_AFTER = [
    '---',
    'type: person',
    'description: a note whose stale_after is not a date at all',
    'generated: { by: human:ana, at: 2026-09-18T09:30:00Z }',
    'stale_after: not-a-date-at-all',
    '---',
    '# Garbled',
    '',
  ].join('\n');
  const root = makeVault({
    files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/garbled.md': GARBLED_STALE_AFTER },
    config: { lang: 'en' },
  });
  const result = run([root, '--json']);
  const parsed = JSON.parse(result.stdout);
  // never a confident claim either way from the staleness section itself
  assert.deepEqual(parsed.stale, []);
  // the value's own malformed shape is spec.mjs's finding to make, not
  // this function's to guess at silently
  assert.ok(parsed.findings.some((f) => f.id === 'stale-after-format'), JSON.stringify(parsed.findings));
});

// --- staleness: the boundary itself, and the order of the result -------------

// deps.now was deleted in round 1 as dead weight (nothing called it with
// a real override); round 2 restores it as a real, exported parameter,
// specifically because THIS is the test that needed the seam: pinning
// the exact tie (stale_after equal to `now`, to the millisecond) is not
// reliably reachable through the real clock, and the round 1 rewrite
// left this boundary with no test either way. A note due AT `now` is
// stale (the day it expires, inclusive); one due one millisecond later
// is not yet. The three input files are deliberately out of alphabetical
// order, so this test also proves the result is sorted by file, not
// merely filtered: an accidental no-op sort would still pass a test that
// used already-sorted input.
test('computeStale: a note is stale exactly at its stale_after moment, not only strictly after it, and the result is sorted by file', () => {
  const now = new Date('2026-06-15T12:00:00.000Z');
  const contents = {
    'zebra.md': '---\nstale_after: 2026-06-15T12:00:00.000Z\n---\n', // exactly now: stale
    'apple.md': '---\nstale_after: 2026-06-15T12:00:00.001Z\n---\n', // 1ms later: not yet
    'mango.md': '---\nstale_after: 2020-01-01T00:00:00.000Z\n---\n', // long past: stale
  };
  const context = { readFile: (relPath) => contents[relPath] };
  const stale = computeStale(Object.keys(contents), context, now);
  assert.deepEqual(stale.map((entry) => entry.file), ['mango.md', 'zebra.md']); // sorted, and apple.md correctly excluded
});

// --- the order findings print in, within a group, is not incidental --------

// Scrambled input order on purpose: a sort that quietly became a no-op
// (or was removed) would still pass a test built from already-sorted
// input, which is exactly the gap here before this test existed.
test('buildReport prints findings within a group sorted by file then line, not in whatever order they arrived', () => {
  const t = createTranslator('en');
  const scrambled = [
    { ruler: 'spec', id: 'z', check: 'c', level: 'must', file: 'zebra.md', line: 5, messageKey: 'spec.type_required.empty', params: {} },
    { ruler: 'spec', id: 'a', check: 'c', level: 'must', file: 'apple.md', line: 9, messageKey: 'spec.type_required.empty', params: {} },
    { ruler: 'spec', id: 'a2', check: 'c', level: 'must', file: 'apple.md', line: 2, messageKey: 'spec.type_required.empty', params: {} },
  ];
  const report = buildReport(scrambled, [], { t });
  const fileOrder = report.text.split('\n').filter((line) => line.includes('.md') && line.includes('  ')).map((line) => line.split(':')[0]);
  assert.deepEqual(fileOrder, ['apple.md', 'apple.md', 'zebra.md']); // apple.md:2 before apple.md:9, both before zebra.md:5
});

// --- the totals line names every bucket, including unexpected --------------

test('the totals line names the unexpected count too, so the human-readable half agrees with --json\'s counts', () => {
  const t = createTranslator('en');
  const bogus = [{ ruler: 'spec', id: 'x', check: 'y', level: 'somehow-else', file: 'f.md', line: 1, messageKey: 'spec.type_required.empty', params: {} }];
  const report = buildReport(bogus, [], { t });
  assert.equal(report.json.counts.unexpected, 1);
  assert.match(report.text, /Totals:.*1 unclassified/);
});

// --- the clean verdict stays true beside a listed stale note ----------------

// --- three more clauses found by the same audit, fixed as cheaply -----------
//
// Deriving the clause list from the module as it stands (rather than
// from the fix-round message that started this pass) turned up three
// more gaps, none named above: `-h` as an alias for `--help`, a second
// positional argument, and an invalid vault config reaching this
// command specifically. All three were reachable, all three had zero
// test coverage (confirmed by mutating each and watching every test
// still pass before adding these), and all three were cheap to close.

test('-h is recognised as the same alias --help is, not treated as an unrecognized flag', () => {
  const help = run(['-h']);
  assert.equal(help.status, EXIT.OK);
  assert.match(help.stdout, /brain-kit validate/);
});

test('a second positional argument is a usage error, paired with the single-argument case that works', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON }, config: { lang: 'en' } });
  const twoArgs = run([root, 'unexpected-second-argument']);
  assert.equal(twoArgs.status, EXIT.USAGE);
  assert.match(twoArgs.stderr, /unexpected-second-argument/);

  const oneArg = run([root]);
  assert.equal(oneArg.status, EXIT.OK);
});

test('an invalid vault config reaching validate specifically exits 2 with a message, not a stack trace', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON }, config: { lang: 'not-a-real-language' } });
  const result = run([root]);
  assert.equal(result.status, EXIT.USAGE);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /at Object|\.mjs:\d+:\d+/);
});

test('the clean verdict does not claim "no departures" right below a stale note it just listed', () => {
  const t = createTranslator('en');
  const stale = [{ file: 'people/old.md', line: 4, staleAfter: '2020-06-01T00:00:00Z' }];
  const report = buildReport([], stale, { t });
  assert.equal(report.exitCode, EXIT.OK);
  const verdictLine = report.text.trim().split('\n').pop();
  assert.doesNotMatch(verdictLine, /no departures/);
  assert.match(verdictLine, /conformant/);

  // paired positive: with no stale notes either, the original wording still stands
  const fullyClean = buildReport([], [], { t });
  assert.match(fullyClean.text.trim().split('\n').pop(), /no departures/);
});
