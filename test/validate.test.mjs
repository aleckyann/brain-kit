// The `validate` command: the one piece that actually walks a vault and
// hands src/rules/spec.mjs and src/rules/house.mjs the shared { files,
// context } their own tests only ever built by hand. Driven mostly
// through the real binary (spawnSync), per this project's own standing
// rule that a command's tests exercise the thing a person actually
// runs, not only the function underneath it. One test near the bottom
// is the deliberate exception: proving the single walkVault call (the
// whole point of src/vault.mjs's ruler contract) needs to count calls
// made inside the process, which a child process's exit code and output
// alone cannot show; src/commands/validate.mjs's own `deps` parameter
// exists for exactly that one test.
//
// Example data: the fictional owner Ana and example.com throughout, and
// the actor human:ana, per this project's own standing rule against real
// personal or company names leaking through a fixture built to test the
// public engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { runValidate } from '../src/commands/validate.mjs';
import { walkVault } from '../src/vault.mjs';
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

// --- helpers -------------------------------------------------------------

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

function run(args, { cwd, input = '' } = {}) {
  return spawnSync(process.execPath, [BIN, 'validate', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LANG: 'en' },
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

  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON } });
  const insideResult = run([root]);
  assert.equal(insideResult.status, EXIT.OK);
  assert.match(insideResult.stdout, /no findings/i);
});

// Resolving from the working directory, not only from an explicit argument.
test('validate with no directory argument resolves the vault from the working directory', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON } });
  const result = run([], { cwd: root });
  assert.equal(result.status, EXIT.OK);
  assert.match(result.stdout, /no findings/i);
});

// --- a conforming vault --------------------------------------------------

test('a conforming vault exits 0 and says so', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON } });
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
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/broken.md': BROKEN_PERSON } });
  const result = run([root]);
  assert.equal(result.status, EXIT.FAILURE);

  const mustAt = result.stdout.indexOf('Specification, must');
  const shouldAt = result.stdout.indexOf('Specification, should');
  const houseAt = result.stdout.indexOf('House rules');
  assert.ok(mustAt >= 0 && shouldAt > mustAt && houseAt > shouldAt, result.stdout);

  const mustSection = result.stdout.slice(mustAt, shouldAt);
  const houseSection = result.stdout.slice(houseAt);
  assert.match(mustSection, /people\/broken\.md:[\d-]+ {2}type-required/);
  assert.match(houseSection, /people\/broken\.md:[\d-]+ {2}forbidden-fields/);
  // named under their OWN heading, never the other one
  assert.doesNotMatch(mustSection, /forbidden-fields/);
  assert.doesNotMatch(houseSection, /type-required/);
});

// --- --json carries the same counts as the text report ----------------------

test('--json prints one object with findings, stale, counts, parserLimits and the two ruler names, matching the text report', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/broken.md': BROKEN_PERSON } });
  const textResult = run([root]);
  const jsonResult = run([root, '--json']);
  assert.equal(jsonResult.status, textResult.status);
  assert.equal(jsonResult.status, EXIT.FAILURE);

  assert.doesNotThrow(() => JSON.parse(jsonResult.stdout));
  const parsed = JSON.parse(jsonResult.stdout);
  assert.equal(parsed.counts.must, 1);
  assert.equal(parsed.counts.should, 0);
  assert.equal(parsed.counts.house, 1);
  assert.equal(parsed.findings.length, 2);
  assert.ok(parsed.findings.some((f) => f.ruler === 'spec' && f.id === 'type-required' && f.level === 'must'));
  assert.ok(parsed.findings.some((f) => f.ruler === 'house' && f.id === 'forbidden-fields'));
  assert.deepEqual(parsed.stale, []);
  assert.ok(Array.isArray(parsed.parserLimits) && parsed.parserLimits.length > 0);
  assert.deepEqual(parsed.rulers, ['spec', 'house']);
});

test('--json prints nothing else on stdout', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON } });
  const result = run([root, '--json']);
  assert.equal(result.status, EXIT.OK);
  // exactly one line: the JSON object, newline-terminated
  const lines = result.stdout.split('\n');
  assert.equal(lines.length, 2); // the object's line, then the trailing empty string after the final \n
  assert.equal(lines[1], '');
  assert.doesNotThrow(() => JSON.parse(lines[0]));
});

// --- staleness is informational and never affects the exit code ------------

test('a note past its stale_after date exits 0 and lists it as informational; a note not yet due is never listed', () => {
  const root = makeVault({
    files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/old.md': STALE_OLD, 'people/fresh.md': FRESH_FUTURE },
  });
  const result = run([root]);
  assert.equal(result.status, EXIT.OK); // staleness never affects the exit code
  assert.match(result.stdout, /people\/old\.md.*2020-06-01T00:00:00Z/);
  assert.doesNotMatch(result.stdout, /people\/fresh\.md/);

  const jsonResult = run([root, '--json']);
  const parsed = JSON.parse(jsonResult.stdout);
  assert.equal(jsonResult.status, EXIT.OK);
  assert.deepEqual(parsed.findings, []);
  assert.equal(parsed.stale.length, 1);
  assert.equal(parsed.stale[0].file, 'people/old.md');
  assert.equal(parsed.stale[0].staleAfter, '2020-06-01T00:00:00Z');
});

// --- --only-problems omits the clean groups, and only those -----------------

test('--only-problems omits the clean groups; without it, a clean group is still shown and says so', () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/broken.md': BROKEN_PERSON } });

  const full = run([root]);
  assert.match(full.stdout, /Specification, should/);
  assert.match(full.stdout, /No findings in this group/);

  const onlyProblems = run([root, '--only-problems']);
  assert.equal(onlyProblems.status, EXIT.FAILURE);
  assert.doesNotMatch(onlyProblems.stdout, /Specification, should/);
  assert.match(onlyProblems.stdout, /Specification, must/);
  assert.match(onlyProblems.stdout, /House rules/);
});

// --- timestamp_deviation: downgrades should, never touches must ------------

test('validate.timestamp_deviation "allow" downgrades a should-level timestamp finding to a warning that does not affect the exit code; "forbid" (the default) does not', () => {
  const files = { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/migrating.md': MIGRATING_DATE };

  const forbidRoot = makeVault({ files }); // default config: validate.timestamp_deviation is "forbid"
  const forbidResult = run([forbidRoot, '--json']);
  assert.equal(forbidResult.status, EXIT.FAILURE);
  const forbidParsed = JSON.parse(forbidResult.stdout);
  assert.equal(forbidParsed.findings.length, 1);
  assert.equal(forbidParsed.findings[0].warning, undefined);

  const allowRoot = makeVault({ files, config: { validate: { timestamp_deviation: 'allow' } } });
  const allowResult = run([allowRoot, '--json']);
  assert.equal(allowResult.status, EXIT.OK); // the only finding is now a warning
  const allowParsed = JSON.parse(allowResult.stdout);
  assert.equal(allowParsed.findings.length, 1);
  assert.equal(allowParsed.findings[0].warning, true);
  assert.equal(allowParsed.counts.warnings, 1);
});

test('a must finding is untouched by timestamp_deviation "allow" even in the same run as a downgraded should finding', () => {
  const root = makeVault({
    files: {
      'index.md': INDEX,
      'memory/log.md': CLEAN_LOG,
      'people/migrating.md': MIGRATING_DATE,
      'people/missing-type.md': MISSING_TYPE_ONLY,
    },
    config: { validate: { timestamp_deviation: 'allow' } },
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
});

// --- bad usage, paired with the same flags used correctly -------------------

test('an unrecognized argument exits 2 with usage on stderr; the same vault with real flags exits cleanly', () => {
  const bad = run(['--not-a-real-flag']);
  assert.equal(bad.status, EXIT.USAGE);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /--not-a-real-flag/);

  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON } });
  const good = run([root, '--only-problems', '--json']);
  assert.equal(good.status, EXIT.OK);
  assert.doesNotThrow(() => JSON.parse(good.stdout));
});

// --- the single-walk contract: unit-level, since counting calls made inside
// a child process cannot be done from outside it. Every other test in this
// file drives the real binary; this is the one place src/commands/validate.mjs's
// `deps` parameter (never used by src/cli.mjs itself) is reached for.

test('runValidate calls walkVault exactly once, and still finds real problems through the spy', async () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/broken.md': BROKEN_PERSON } });
  let calls = 0;
  const spy = (...args) => {
    calls += 1;
    return walkVault(...args);
  };
  const { io, stdout } = fakeIo();
  const t = createTranslator('en');
  const code = await runValidate([root], io, t, { walkVault: spy });
  assert.equal(calls, 1);
  assert.equal(code, EXIT.FAILURE);
  assert.match(stdout(), /people\/broken\.md/);
});

// The paired positive: a clean vault through the same spy, exactly one call,
// exit 0.
test('runValidate calls walkVault exactly once for a clean vault too', async () => {
  const root = makeVault({ files: { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON } });
  let calls = 0;
  const spy = (...args) => {
    calls += 1;
    return walkVault(...args);
  };
  const { io } = fakeIo();
  const t = createTranslator('en');
  const code = await runValidate([root], io, t, { walkVault: spy });
  assert.equal(calls, 1);
  assert.equal(code, EXIT.OK);
});
