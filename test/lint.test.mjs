// The `lint` command: the one piece that actually walks a vault and hands
// src/rules/lint.mjs the shared { files, context, scope } its own tests
// only ever built by hand. Mirrors test/validate.test.mjs's own shape and
// its own standing rule: a command's tests exercise the thing a person
// actually runs (spawnSync against the real binary) wherever that is
// practical, with a few unit-level tests (buildReport, the single-walk
// spy) where in-process access is the only way to observe the clause at
// all.
//
// Example data throughout: the fictional owner Ana, example.com, and the
// established second persona Bruno are never needed here, so only Ana and
// a "Ghost" note (deliberately unreachable, named for what it is) appear.
//
// Every secret-shaped fixture string below is built by runtime string
// concatenation, never as one contiguous literal, exactly as
// test/rules-lint.test.mjs's own header explains: this repository's own
// push gate scans every commit for exactly these shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { walkVault } from '../src/vault.mjs';
import { runLint, buildReport, buildSecretScan } from '../src/commands/lint.mjs';
import { MAX_SCAN_BYTES } from '../src/leak.mjs';
import { makeVault } from './helpers/vault-fixture.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');

// --- fixture content ---------------------------------------------------------

const INDEX_LINKING_PEOPLE = '# Welcome\n\n[People](people/)\n';
const PEOPLE_INDEX_LINKING_ANA = '# People\n\n[Ana](ana.md)\n';
const CLEAN_ANA = '# Ana\n\nAn example person, with nothing this ruler flags.\n';
const GHOST = '# Ghost\n'; // deliberately unreachable: no file ever links to it

function fakeAwsKey(suffix) {
  return 'AKIA' + suffix; // AKIA + 16 [0-9A-Z] chars, leak.mjs's own AWS access key id shape
}
const SECRET_LINE = `Draft credential, never real: ${fakeAwsKey('ABCD1234EFGH5678')}`;

// The example config's own privacy.secret_patterns (test/fixtures/config/valid.json)
// already lists this exact AWS shape alongside leak.mjs's own generic copy
// of it, which would otherwise double every count below; cleared here so
// every test in this file counts one match per real occurrence, exactly as
// test/rules-lint.test.mjs's own secrets tests already do for the same
// reason.
const NO_DOUBLE_COUNT_CONFIG = { privacy: { secret_patterns: [] } };

// A vault clean under all eight rules: index-completeness and orphans are
// both satisfied by the bare directory link and the index.md it leads to;
// columns and attribution have nothing configured or declared to check
// against; tables and style see no table and no forbidden character; and
// secrets/privacy see nothing to match or leak.
function cleanFiles() {
  return {
    'index.md': INDEX_LINKING_PEOPLE,
    'people/index.md': PEOPLE_INDEX_LINKING_ANA,
    'people/ana.md': CLEAN_ANA,
  };
}

// The same shape, plus one secret-shaped line (an error, severity 'error'
// by default) and one unreachable note (a warning, severity 'warn' by
// default): the smallest fixture that exercises both severity groups at
// once.
function oneErrorOneWarningFiles() {
  return {
    'index.md': INDEX_LINKING_PEOPLE,
    'people/index.md': PEOPLE_INDEX_LINKING_ANA,
    'people/ana.md': `${CLEAN_ANA}\n${SECRET_LINE}\n`,
    'people/ghost.md': GHOST,
  };
}

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

// BRAIN_KIT_LANG is fixed to English purely so this file's own assertions
// can match stable English substrings; once a vault is found the report
// itself follows config.lang, never this variable (validate.test.mjs's
// own `run` makes the identical point).
function run(args, { cwd, env } = {}) {
  return spawnSync(process.execPath, [BIN, 'lint', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LANG: 'en', ...env },
  });
}

function noVaultDir() {
  return makeTempDir('brain-kit-lint-novault-');
}

// --- a real git repository, for the scope tests only ------------------------

function git(cwd, args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
}

// Builds a vault exactly like makeVault, then git-initialises that SAME
// directory and commits every file it was given as one initial commit, on
// branch "main". The returned root is both a valid brain-kit vault and a
// real git repository with a real HEAD, the shape src/git.mjs's own
// resolveBase needs to tell "worktree" and "auto" apart from "all" at all.
function makeGitVault({ files, config = {} } = {}) {
  const root = makeVault({ files, config });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', root]).status, 0, 'git init');
  assert.equal(git(root, ['add', '-A']).status, 0, 'git add -A');
  const commit = git(root, ['commit', '-q', '-m', 'initial commit']);
  assert.equal(commit.status, 0, `git commit: ${commit.stderr}`);
  return root;
}

// --- outside a vault, and a path argument that names no real scope ---------

test('lint outside a vault exits 2 naming what is missing, never a stack trace', () => {
  const outside = noVaultDir();
  const result = run([outside]);
  assert.equal(result.status, EXIT.USAGE);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no brain-kit vault/);
  assert.doesNotMatch(result.stderr, /at Object|\.mjs:\d+:\d+/);
});

test('a path argument that does not exist exits 2 naming it', () => {
  const root = makeVault({ files: cleanFiles() });
  const typo = join(root, 'this-directory-does-not-exist');
  const result = run([typo]);
  assert.equal(result.status, EXIT.USAGE);
  assert.match(result.stderr, /does not exist/);
});

test('a path argument that is a file, not a directory, exits 2 naming it', () => {
  const root = makeVault({ files: cleanFiles() });
  const result = run([join(root, 'people', 'ana.md')]);
  assert.equal(result.status, EXIT.USAGE);
  assert.match(result.stderr, /not a directory/);
});

test('lint with no directory argument resolves the vault from the working directory', () => {
  const root = makeVault({ files: cleanFiles() });
  const result = run([], { cwd: root });
  assert.equal(result.status, EXIT.OK);
});

// loadConfig's own ConfigError (an invalid brain-kit.config.json reaching
// this command) is the one exception this module deliberately lets
// escape uncaught, exactly like validate.mjs's own identical call: the
// error boundary living in src/cli.mjs is what turns it into exit 2 with
// a clean message, never a stack trace on this command's own stderr.
test('an invalid vault config reaching lint exits 2 with a message, not a stack trace', () => {
  const root = makeVault({ files: cleanFiles(), config: { lang: 'not-a-real-language' } });
  const result = run([root]);
  assert.equal(result.status, EXIT.USAGE);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /at Object|\.mjs:\d+:\d+/);
});

test('-h is recognised as the same alias --help is, and prints usage mentioning lint without touching any vault', () => {
  const result = run(['-h']);
  assert.equal(result.status, EXIT.OK);
  assert.match(result.stdout, /brain-kit lint/);
});

test('an unrecognized flag is a usage error naming it, exit 2', () => {
  const root = makeVault({ files: cleanFiles() });
  const result = run(['--nonsense', root]);
  assert.equal(result.status, EXIT.USAGE);
  assert.match(result.stderr, /--nonsense/);
});

test('a second positional argument is a usage error, paired with the single-argument case that works', () => {
  const root = makeVault({ files: cleanFiles() });
  const single = run([root]);
  assert.equal(single.status, EXIT.OK);

  // The second argument is itself a real, valid vault: a mutation that
  // silently OVERWRITES `dir` with the last positional argument, instead
  // of refusing a second one, would make this exit 0 against the second
  // vault rather than fail with a usage error, which is exactly the
  // silent-misdirection shape this clause exists to prevent.
  const secondRoot = makeVault({ files: cleanFiles() });
  const two = run([root, secondRoot]);
  assert.equal(two.status, EXIT.USAGE);
  assert.match(two.stderr, new RegExp(secondRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('--rule or --base with no value following it is a usage error, not a crash reading past the end of argv', () => {
  const root = makeVault({ files: cleanFiles() });
  const missingRuleValue = run([root, '--rule']);
  assert.equal(missingRuleValue.status, EXIT.USAGE);
  assert.match(missingRuleValue.stderr, /--rule/);

  const missingBaseValue = run([root, '--base']);
  assert.equal(missingBaseValue.status, EXIT.USAGE);
  assert.match(missingBaseValue.stderr, /--base/);
});

// --- --base validation: a usage error, never the raw error resolveBase throws ---

test('an unknown --base value exits 2 listing the known bases, never a raw stack trace or exit 1', () => {
  const root = makeVault({ files: cleanFiles() });
  const result = run(['--base', 'nonsense', root]);
  assert.equal(result.status, EXIT.USAGE);
  assert.match(result.stderr, /nonsense/);
  for (const base of ['all', 'worktree', 'merge-base', 'auto']) assert.match(result.stderr, new RegExp(base));
  assert.doesNotMatch(result.stderr, /at Object|\.mjs:\d+:\d+/);
});

// --- --rule validation: a usage error listing the known ids, never a silent empty run ---

test('an unknown --rule id exits 2 listing every known rule id, never a silent empty run', () => {
  const root = makeVault({ files: oneErrorOneWarningFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  const result = run(['--rule', 'not-a-real-rule', root]);
  assert.equal(result.status, EXIT.USAGE);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /not-a-real-rule/);
  for (const id of ['index-completeness', 'orphans', 'columns', 'tables', 'style', 'secrets', 'privacy', 'attribution']) {
    assert.match(result.stderr, new RegExp(id));
  }
});

// --- a clean vault --------------------------------------------------------

test('a clean vault exits 0 and says so, with no rule skipped', () => {
  const root = makeVault({ files: cleanFiles() });
  const result = run([root]);
  assert.equal(result.status, EXIT.OK);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /no findings/i);
  // Grouped, deliberately: the alternation used to be ungrouped, so the
  // pattern was "skipped: index-completeness" OR the bare word "orphans"
  // OR the bare word "secrets" and so on, and any report that merely
  // MENTIONED one of those words tripped it. It caught nothing this test
  // is about and broke the moment the report gained an unrelated
  // sentence with the word "secrets" in it.
  assert.doesNotMatch(result.stdout, /skipped: (index-completeness|orphans|columns|tables|style|secrets|privacy|attribution)/);
});

// --- one error and one warning: grouped by severity, errors first ----------

test('a vault with one error and one warning exits 1, groups them under their own headings, errors before warnings, and never prints the matched secret text', () => {
  const root = makeVault({ files: oneErrorOneWarningFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  const result = run([root]);
  assert.equal(result.status, EXIT.FAILURE);

  const errorsAt = result.stdout.indexOf('== Errors ==');
  const warningsAt = result.stdout.indexOf('== Warnings ==');
  assert.ok(errorsAt >= 0 && warningsAt > errorsAt, result.stdout);

  const errorSection = result.stdout.slice(errorsAt, warningsAt);
  const warningSection = result.stdout.slice(warningsAt);
  assert.match(errorSection, /people\/ana\.md.*secrets/);
  assert.match(warningSection, /people\/ghost\.md.*orphans/);
  assert.doesNotMatch(errorSection, /ghost/);
  assert.doesNotMatch(warningSection, /ana\.md.*secrets|secrets.*ana\.md/);

  // The rule's own contract (src/rules/lint.mjs, "secrets"): the matched
  // credential text itself must never reach the screen, only the pattern
  // definition that matched it.
  assert.doesNotMatch(result.stdout, /ABCD1234EFGH5678/);
  // The VERDICT line specifically, not the (always-present) "Errors"
  // section explanation, which also contains the substring "this run
  // fails": a vault with both an error and a warning must reach the
  // failing verdict, never the "only warnings" one, whichever severity
  // this report happens to check first.
  assert.match(result.stdout, /^Result: this run fails because of the error\(s\) above\.$/m);
});

// --- only warnings: exits 0, and the verdict says why that is not "clean" ---

test('a vault with only warnings exits 0 and the verdict names them, distinct from a truly clean vault', () => {
  const root = makeVault({
    files: { 'index.md': INDEX_LINKING_PEOPLE, 'people/index.md': PEOPLE_INDEX_LINKING_ANA, 'people/ana.md': CLEAN_ANA, 'people/ghost.md': GHOST },
  });
  const result = run([root]);
  assert.equal(result.status, EXIT.OK);
  assert.match(result.stdout, /== Warnings ==[\s\S]*people\/ghost\.md/);
  assert.match(result.stdout, /only warnings/i);
  assert.doesNotMatch(result.stdout, /Result: no findings\.$/m);
  // The EMPTY group (errors, here) still shows and still says so
  // explicitly: a group with no findings and a group nobody reported on
  // (there is no per-rule inventory to tell those apart from) must never
  // look the same as a heading with no body at all.
  assert.match(result.stdout, /== Errors ==[\s\S]*No findings in this group\.[\s\S]*== Warnings ==/);
});

// --- a rule turned off in the vault's own configuration: skipped, not silent ---

test('a rule the vault turns off does not run even when it would have found something, and the summary says one rule was skipped', () => {
  const root = makeVault({
    files: { 'index.md': INDEX_LINKING_PEOPLE, 'people/index.md': PEOPLE_INDEX_LINKING_ANA, 'people/ana.md': CLEAN_ANA, 'people/ghost.md': GHOST },
    config: { lint: { orphans: 'off' } },
  });
  const result = run([root]);
  assert.equal(result.status, EXIT.OK); // the orphan finding never happens, so nothing blocks
  assert.doesNotMatch(result.stdout, /ghost/);
  assert.match(result.stdout, /1 rule\(s\) skipped/);
  assert.match(result.stdout, /orphans/);
  assert.match(result.stdout, /partial run/i);

  const jsonResult = run([root, '--json']);
  const parsed = JSON.parse(jsonResult.stdout);
  assert.equal(parsed.counts.skipped, 1);
  assert.deepEqual(parsed.skipped, ['orphans']);
  assert.deepEqual(parsed.findings, []);
});

// --- --rule restricts the run to the named rules ----------------------------

test('--rule restricts the report to the named rule, excluding a real finding from every other rule', () => {
  const root = makeVault({ files: oneErrorOneWarningFiles(), config: NO_DOUBLE_COUNT_CONFIG });

  const secretsOnly = run(['--rule', 'secrets', root]);
  assert.equal(secretsOnly.status, EXIT.FAILURE);
  assert.match(secretsOnly.stdout, /secrets/);
  assert.doesNotMatch(secretsOnly.stdout, /orphans/);
  assert.doesNotMatch(secretsOnly.stdout, /ghost/);

  const orphansOnly = run(['--rule', 'orphans', root]);
  assert.equal(orphansOnly.status, EXIT.OK); // the one error finding is excluded, so nothing left blocks
  assert.match(orphansOnly.stdout, /ghost/);
  assert.doesNotMatch(orphansOnly.stdout, /AKIA|secret-pattern/);

  // Excluding "orphans" via --rule is not the same as the vault turning it
  // off: the person who typed the flag already knows they excluded it, so
  // it must never show up in "skipped" (that word is reserved for a rule
  // that would have run, had the vault's own configuration not turned it
  // off). Only a genuinely off rule belongs there; a mutation that reuses
  // the exclusion set to also populate `skipped` would fail exactly here.
  const parsed = JSON.parse(run(['--rule', 'secrets', root, '--json']).stdout);
  assert.deepEqual(parsed.skipped, []);
  assert.equal(parsed.counts.skipped, 0);

  // The decisive version of the same clause: "orphans" here is not merely
  // excluded by --rule, the vault's OWN configuration also turns it off.
  // "skipped" must still stay empty, since --rule secrets never considers
  // orphans at all; a mutation that computes "skipped" from every rule id
  // instead of only the ones this run actually considered would report
  // "orphans" as skipped here, even though nobody asked this run about it.
  const orphansOffRoot = makeVault({ files: oneErrorOneWarningFiles(), config: { ...NO_DOUBLE_COUNT_CONFIG, lint: { orphans: 'off' } } });
  const restrictedWithUnrelatedOff = JSON.parse(run(['--rule', 'secrets', orphansOffRoot, '--json']).stdout);
  assert.deepEqual(restrictedWithUnrelatedOff.skipped, []);
  assert.equal(restrictedWithUnrelatedOff.counts.error, 1); // the secrets finding itself still runs and still reports
});

// A restriction that changes what a run FOUND (by construction: it
// changes which rules even execute) must also change what the run
// SAYS, in both halves of the report. Before this fix, --rule left no
// trace anywhere: a person reading the text report, or a consumer
// parsing --json days later with no memory of which flag produced it,
// had no way to tell "this vault has only one problem" apart from
// "this run only ever looked for one kind of problem". The JSON
// envelope already carries a version for exactly this reason (adding a
// field to a shape a consumer already parses is the breaking change a
// version exists to prevent); `restrictedTo` is that addition, additive
// and version-stable.
test('--rule leaves a visible trace of the restriction in both the text report and the JSON envelope', () => {
  const root = makeVault({ files: oneErrorOneWarningFiles(), config: NO_DOUBLE_COUNT_CONFIG });

  const restricted = run(['--rule', 'secrets', root]);
  assert.match(restricted.stdout, /Restricted to: secrets\./);

  const unrestricted = run([root]);
  assert.doesNotMatch(unrestricted.stdout, /Restricted to:/);

  const parsedRestricted = JSON.parse(run(['--rule', 'secrets', root, '--json']).stdout);
  assert.deepEqual(parsedRestricted.restrictedTo, ['secrets']);
  const parsedUnrestricted = JSON.parse(run([root, '--json']).stdout);
  assert.deepEqual(parsedUnrestricted.restrictedTo, []);
});

// buildRestrictedConfig must force every EXCLUDED rule's own setting off
// without disturbing anything else the vault configured, including a
// DIFFERENT top-level key (privacy) that the ALLOWED rule itself still
// needs to read. A mutation that returns only `{ lint }` (dropping the
// `...config` spread) would silently empty out every setting outside
// `lint` the moment --rule is used at all; GENERIC_PATTERNS alone would
// still catch the AWS-shaped fixture used elsewhere in this file, so this
// test deliberately uses a pattern that exists ONLY in privacy.secret_patterns,
// never in leak.mjs's own built-ins, to make that specific loss visible.
test('--rule restricts which rules run without discarding the rest of the vault\'s own configuration', () => {
  const customPattern = 'internal-token-[0-9]{6}';
  const root = makeVault({
    files: { ...cleanFiles(), 'people/ana.md': `${CLEAN_ANA}\nDraft, never real: internal-token-482913\n` },
    config: { privacy: { secret_patterns: [customPattern] } },
  });
  const result = run(['--rule', 'secrets', root]);
  assert.equal(result.status, EXIT.FAILURE, `expected the custom pattern to still apply under --rule secrets:\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /secrets/);
});

// A rule requested by name that the vault's OWN configuration already
// turns off still does not run: --rule narrows WHICH ids are considered,
// it does not override a vault's own 'off'. The summary still calls it
// skipped, since the person asked for a rule that turns out not to run,
// which is exactly the ambiguity this run's own "skipped" accounting
// exists to name rather than hide.
test('--rule for a rule the vault itself turns off still does not run, and is still reported as skipped', () => {
  const root = makeVault({ files: oneErrorOneWarningFiles(), config: { ...NO_DOUBLE_COUNT_CONFIG, lint: { secrets: 'off' } } });
  const result = run(['--rule', 'secrets', root]);
  assert.equal(result.status, EXIT.OK);
  assert.doesNotMatch(result.stdout, /AKIA|secret-pattern/);
  const parsed = JSON.parse(run(['--rule', 'secrets', root, '--json']).stdout);
  assert.deepEqual(parsed.skipped, ['secrets']);
  assert.deepEqual(parsed.findings, []);
});

// --- --json carries the same counts as the text report ----------------------

test('--json parses as one object carrying findings, counts, scope, skipped and a version, matching the text report', () => {
  const root = makeVault({ files: oneErrorOneWarningFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  const textResult = run([root]);
  const jsonResult = run([root, '--json']);
  assert.equal(jsonResult.status, textResult.status);
  assert.equal(jsonResult.status, EXIT.FAILURE);

  assert.doesNotThrow(() => JSON.parse(jsonResult.stdout));
  const parsed = JSON.parse(jsonResult.stdout);
  assert.equal(parsed.version, 'brain-kit.lint/1');
  assert.equal(parsed.counts.error, 1);
  assert.equal(parsed.counts.warn, 1);
  assert.equal(parsed.counts.skipped, 0);
  assert.equal(parsed.findings.length, 2);
  assert.ok(parsed.findings.some((f) => f.id === 'secrets' && f.severity === 'error'));
  assert.ok(parsed.findings.some((f) => f.id === 'orphans' && f.severity === 'warn'));
  assert.equal(parsed.scope.base, 'all'); // makeVault's own directory is never a git repository
  assert.equal(parsed.scope.reason, 'outside-repo');
  assert.equal(parsed.scope.linesRestricted, false);
  assert.equal(parsed.scope.files, 4);
  assert.deepEqual(parsed.skipped, []);
});

// scope.files counts the MARKDOWN files this run actually judged (the
// same list handed to runLintRules), never the vault's total walk: a
// non-markdown attachment is real content the walk finds (context.all
// needs it for link resolution) but not a file any lint rule reads or
// reports on. A mutation that reports `all.length` here instead of
// `files.length` would pass every other test in this file, since none of
// them adds a non-markdown file at all.
test('scope.files in --json counts only markdown files, not every file the walk found', () => {
  const root = makeVault({
    files: { ...cleanFiles(), 'attachments/diagram.png': 'not a real image, just a byte stand-in\n' },
  });
  const parsed = JSON.parse(run([root, '--json']).stdout);
  assert.equal(parsed.scope.files, 3); // index.md, people/index.md, people/ana.md; the .png is not counted
});

test('--json prints nothing else on stdout', () => {
  const root = makeVault({ files: cleanFiles() });
  const result = run([root, '--json']);
  assert.equal(result.status, EXIT.OK);
  const lines = result.stdout.split('\n');
  assert.equal(lines.length, 2); // the object's own line, then the trailing empty string after the final \n
  assert.equal(lines[1], '');
  assert.doesNotThrow(() => JSON.parse(lines[0]));
});

// --- the scope line: printed always, naming the base and why -------------------

test('outside a git repository the scope line says so, and every line of the vault is checked', () => {
  const root = makeVault({ files: cleanFiles() });
  const result = run([root]);
  assert.match(result.stdout, /not inside a git repository/i);
});

// --- git-backed scoping: --base auto sees only the new line, --base all sees both ---

// Fix round 3 (finding B): this test used to assert that `auto` reported
// ONLY the newly written key and not the one already committed. That is
// no longer true and was never a property worth having: the secrets rule
// ignores the scope entirely now (src/rules/lint.mjs's own fix-round-3
// header), so both keys are reported under every base. What this test
// still pins is the thing that made the old behaviour dangerous: the two
// bases must AGREE about secrets, whatever the scope line says.
test('a secret is reported under the default scope and under --base all alike, whether it was just written or committed long ago', () => {
  const root = makeGitVault({
    files: { ...cleanFiles(), 'people/ana.md': `${CLEAN_ANA}\nAlready committed before this change: ${fakeAwsKey('OLD1111111111OLD')}\n` },
    config: NO_DOUBLE_COUNT_CONFIG,
  });
  // A second key, written to the SAME tracked file but never staged or
  // committed: exactly what "a session about to propose" has in its own
  // worktree, the case --base auto's own header (src/git.mjs) exists for.
  const anaPath = join(root, 'people', 'ana.md');
  const current = readFileSync(anaPath, 'utf8');
  writeFileSync(anaPath, `${current}Drafted just now, not yet committed: ${fakeAwsKey('NEW1111111111NEW')}\n`);

  const autoResult = run([root]);
  assert.equal(autoResult.status, EXIT.FAILURE);
  assert.match(autoResult.stdout, /auto/);
  const autoMatches = autoResult.stdout.match(/people\/ana\.md:\d+ {2}secrets\b/g) ?? [];
  assert.equal(autoMatches.length, 2, `expected BOTH secrets under auto, got:\n${autoResult.stdout}`);

  const allResult = run(['--base', 'all', root]);
  assert.equal(allResult.status, EXIT.FAILURE);
  assert.match(allResult.stdout, /"all" was requested/);
  const allMatches = allResult.stdout.match(/people\/ana\.md:\d+ {2}secrets\b/g) ?? [];
  assert.equal(allMatches.length, 2, `expected both the old and the new secret under --base all, got:\n${allResult.stdout}`);
});

// --- CRITICAL, fix round 2: a person's first run must not answer "I checked nothing" ---
//
// Measured, not merely reasoned about: a vault whose only note carries an
// access key, committed on the default branch, with a clean tree and
// nothing untracked, is EXACTLY a person's first run. The previous round
// made `auto` an honest union of the branch, the worktree and whatever is
// untracked, which correctly reported "nothing changed" here, since
// nothing HAD changed; but "I checked nothing" is not a useful answer to
// "lint my vault", however honestly it is said. Where there is no change
// to scope to, the honest scope is everything, which is what the question
// means: `auto` now matches `--base all` in exactly this one shape.
test('a secret already committed on a clean default-branch checkout is caught by the default scope too, matching --base all', () => {
  const root = makeGitVault({
    files: { ...cleanFiles(), 'people/ana.md': `${CLEAN_ANA}\nAlready committed, on the default branch: ${fakeAwsKey('OLD1111111111OLD')}\n` },
    config: NO_DOUBLE_COUNT_CONFIG,
  });

  const autoResult = run([root]);
  assert.equal(autoResult.status, EXIT.FAILURE);
  assert.match(autoResult.stdout, /auto/);
  assert.match(autoResult.stdout, /people\/ana\.md:\d+ {2}secrets\b/);
  // The whole vault was genuinely checked here (kind "all" under the
  // hood, src/git.mjs's own auto-on-default-branch-clean), so the plain
  // failing verdict applies, not the hedged "partial run" one: this run
  // does not owe a caveat it did not earn.
  assert.doesNotMatch(autoResult.stdout, /partial run/i);

  const allResult = run(['--base', 'all', root]);
  assert.equal(allResult.status, EXIT.FAILURE);
  assert.match(allResult.stdout, /people\/ana\.md:\d+ {2}secrets\b/);
  assert.equal(
    autoResult.stdout.match(/people\/ana\.md:\d+ {2}secrets\b/g)?.length,
    allResult.stdout.match(/people\/ana\.md:\d+ {2}secrets\b/g)?.length,
  );
});

// The hedge fix round 2 keeps, still doing real work: a feature branch
// whose OWN commits never touch the line a secret sits on must still say
// so honestly. Here the secret predates the branch (it is already part of
// the shared history with the default branch), so a real, correctly
// scoped `auto` run has genuinely narrower information than `--base all`,
// unlike the fixed case above where there was nothing left to be narrower
// THAN. This is the run the "partial run is not the same as a clean
// vault" caveat exists for.
test('a secret that predates a feature branch is reported by the default scope anyway, even though the run is otherwise partial', () => {
  const root = makeGitVault({
    files: { ...cleanFiles(), 'people/ana.md': `${CLEAN_ANA}\nAlready shared with main before this branch existed: ${fakeAwsKey('PRE1111111111PRE')}\n` },
    config: NO_DOUBLE_COUNT_CONFIG,
  });
  assert.equal(git(root, ['checkout', '-q', '-b', 'feature']).status, 0);
  // Appended to an already-linked, already-clean file, never a brand new
  // unlinked one: this test is about the SECRETS rule's own scope, and a
  // new orphan file would also trigger the (unrelated) orphans warning,
  // muddying which caveat produced the "partial run" text below.
  const anaPath = join(root, 'people', 'ana.md');
  writeFileSync(anaPath, `${readFileSync(anaPath, 'utf8')}One more line this branch adds, nothing secret in it.\n`);
  assert.equal(git(root, ['add', '-A']).status, 0);
  assert.equal(git(root, ['commit', '-q', '-m', 'extend ana with an unrelated line']).status, 0);

  const autoResult = run([root]);
  // Fix round 3 (finding B). This used to be EXIT.OK with no secrets
  // finding at all, on the grounds that the branch's own commits never
  // touch the line the key sits on. That reading is what let one
  // unrelated untracked file drop an already-found committed secret to
  // exit 0 in an adopting vault whose gate reads only the exit code. The
  // run is still genuinely partial for style and tables, and still says
  // so in its scope line; the secrets rule is not part of what "partial"
  // can mean any more.
  assert.equal(autoResult.status, EXIT.FAILURE);
  assert.match(autoResult.stdout, /auto/);
  assert.match(autoResult.stdout, /people\/ana\.md:\d+ {2}secrets\b/);
  assert.match(autoResult.stdout, /never narrowed by the scope/i);

  const allResult = run(['--base', 'all', root]);
  assert.equal(allResult.status, EXIT.FAILURE);
  assert.match(allResult.stdout, /people\/ana\.md:\d+ {2}secrets\b/);
});

// --- CRITICAL: a rule that crashes degrades the run, names itself, and never hides the rest ---
//
// Before this fix, a rule that threw (loadPatterns, inside secrets,
// raises on purpose for a malformed privacy.secret_patterns entry) had
// nothing to catch it anywhere in this command: the exception reached
// src/cli.mjs's own generic error boundary, which prints one unlocalised
// line and exits 1, the SAME code this ruler's own contract defines as
// "a finding of severity error". Under --json that is exit 1 with
// EMPTY stdout, indistinguishable from a real error finding to a
// machine parsing it, precisely when it has the least information to
// tell the two apart.
test('a rule that crashes degrades the run (exit code 3, never 0 or the ordinary failure code 1), names itself and its error, and still shows every other rule\'s real findings', () => {
  const root = makeVault({
    files: { 'index.md': INDEX_LINKING_PEOPLE, 'people/index.md': PEOPLE_INDEX_LINKING_ANA, 'people/ana.md': CLEAN_ANA, 'people/ghost.md': GHOST },
    config: { privacy: { secret_patterns: ['[unterminated'] } },
  });
  const result = run([root]);
  assert.equal(result.status, EXIT.DEGRADED);
  assert.notEqual(result.status, EXIT.OK);
  assert.notEqual(result.status, EXIT.FAILURE);
  assert.match(result.stdout, /== Tool defects ==/);
  assert.match(result.stdout, /secrets/);
  assert.match(result.stdout, /could not compile/);
  // The orphan finding (people/ghost.md, a real result from a DIFFERENT
  // rule) must still reach the report: the crash is caught per rule,
  // not left to abort every rule that has not run yet.
  assert.match(result.stdout, /people\/ghost\.md/);
  assert.match(result.stdout, /degraded/i);
  // The crash has no one file to blame (`file: null`): the location
  // column must show a neutral marker, never the literal word "null".
  assert.match(result.stdout, /\(no file\)\s+secrets/);
  assert.doesNotMatch(result.stdout, /\bnull\b/);

  const parsed = JSON.parse(run([root, '--json']).stdout);
  assert.equal(parsed.counts.defect, 1);
  const defectFinding = parsed.findings.find((f) => f.defect === true);
  assert.ok(defectFinding);
  assert.equal(defectFinding.id, 'secrets');
  assert.equal(defectFinding.check, 'rule-crashed');
  assert.equal(defectFinding.file, null);
  assert.ok(parsed.findings.some((f) => f.id === 'orphans' && f.defect !== true));
  // The crashed rule's own synthetic finding must be counted ONCE, as a
  // defect, never ALSO as an ordinary error: it carries `severity:
  // 'error'` for other reasons (see runLintRules' own catch), and a
  // mutation that stopped excluding `defect: true` findings from the
  // error/warning partition would double-count it here and print it
  // twice, once under Tool defects and once under Errors.
  assert.equal(parsed.counts.error, 0);
  assert.equal(result.stdout.match(/rule crashed and produced no results/g)?.length, 1, 'the crash must be printed exactly once, in the defects section only');
});

// --- the single walk: exactly once, and no bypass of the injected seam ---------

test('runLint calls walkVault exactly once, and still finds a real problem through the spy', async () => {
  const root = makeVault({ files: oneErrorOneWarningFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  let calls = 0;
  const spy = (...args) => {
    calls += 1;
    return walkVault(...args);
  };
  const { io, stdout } = fakeIo();
  const t = createTranslator('en');
  const code = await runLint([root], io, t, spy);
  assert.equal(calls, 1);
  assert.equal(code, EXIT.FAILURE);
  assert.match(stdout(), /secrets/);
});

test('runLint calls walkVault exactly once for a clean vault too', async () => {
  const root = makeVault({ files: cleanFiles() });
  let calls = 0;
  const spy = (...args) => {
    calls += 1;
    return walkVault(...args);
  };
  const { io } = fakeIo();
  const t = createTranslator('en');
  const code = await runLint([root], io, t, spy);
  assert.equal(calls, 1);
  assert.equal(code, EXIT.OK);
});

// The same static-source guard validate.test.mjs's own "fix round 2"
// section applies to validate.mjs, applied here: a spy on the injected
// walkVault parameter cannot see a second, real reference reachable from
// this module's OWN scope (an aliased import, or a namespace import of
// vault.mjs used as `vaultModule.walkVault(...)`), so the seam is only as
// real as this source-text check proves it to be.
test('src/commands/lint.mjs imports no walk at all, from any module, under any name', () => {
  const source = readFileSync(join(KIT_ROOT, 'src', 'commands', 'lint.mjs'), 'utf8');
  const importLines = source.split('\n').filter((line) => /^\s*import\b/.test(line));

  const namedImportOfWalk = importLines.filter((line) => /\bwalkVault\b/.test(line));
  assert.deepEqual(namedImportOfWalk, [], `found an import naming walkVault: ${namedImportOfWalk.join(' | ')}`);

  const namespaceImportOfVaultModule = importLines.filter((line) => /import\s*\*\s*as\s+\w+\s*from\s*['"][^'"]*\bvault\.mjs['"]/.test(line));
  assert.deepEqual(namespaceImportOfVaultModule, [], `found a namespace import of vault.mjs: ${namespaceImportOfVaultModule.join(' | ')}`);
});

// The context-building half of the same promise: this module must build
// its reader and its markdown filter from validate.mjs's own exports,
// never a second, independently-drifting copy of either (validate.mjs's
// own header names this exact mistake for isMarkdown, once already made
// and fixed). A mutation that inlines a fresh readFileSync-based reader,
// or a second `.endsWith('.md')` check, here in lint.mjs, passes every
// behavioural fixture in this file (BOM/CRLF/cache are already exhaustively
// covered by test/validate.test.mjs's own tests for makeReadFile, which a
// silent reimplementation would not run against) while failing only this
// one, structural, check.
test('src/commands/lint.mjs reuses makeReadFile and isMarkdown from validate.mjs rather than rebuilding either', () => {
  const source = readFileSync(join(KIT_ROOT, 'src', 'commands', 'lint.mjs'), 'utf8');
  const importLines = source.split('\n').filter((line) => /^\s*import\b/.test(line));
  const fromValidate = importLines.filter((line) => /from\s*['"]\.\/validate\.mjs['"]/.test(line));
  assert.equal(fromValidate.length, 1, `expected exactly one import from ./validate.mjs, found: ${fromValidate.join(' | ')}`);
  assert.match(fromValidate[0], /\bmakeReadFile\b/);
  assert.match(fromValidate[0], /\bisMarkdown\b/);
});

// --- unit-level: buildReport's own grouping, verdict and JSON shape ---------

const T = createTranslator('en');

function baseAll() {
  return { kind: 'all', reason: 'all-explicit' };
}

test('buildReport: no findings and nothing skipped renders the plain clean verdict', () => {
  const { text, json, exitCode } = buildReport([], { t: T, base: baseAll(), fileCount: 3, skippedIds: [] });
  assert.equal(exitCode, EXIT.OK);
  assert.match(text, /Result: no findings\./);
  assert.equal(json.counts.error, 0);
  assert.equal(json.counts.warn, 0);
  assert.equal(json.counts.skipped, 0);
  assert.equal(json.version, 'brain-kit.lint/1');
});

test('buildReport: no findings but a skipped rule renders the distinct "partial run" verdict, never the plain clean one', () => {
  const { text, exitCode } = buildReport([], { t: T, base: baseAll(), fileCount: 3, skippedIds: ['orphans'] });
  assert.equal(exitCode, EXIT.OK);
  assert.match(text, /partial run is not the same as a clean vault/);
  assert.doesNotMatch(text, /Result: no findings\.$/m);
});

test('buildReport: any error finding fails the run regardless of how many warnings also exist', () => {
  const findings = [
    { id: 'secrets', file: 'a.md', line: 1, severity: 'error', messageKey: 'lint.secrets.pattern_matched_full', params: { pattern: 'x' } },
    { id: 'orphans', file: 'b.md', line: null, severity: 'warn', messageKey: 'lint.orphans.unreachable', params: {} },
  ];
  const { text, exitCode, json } = buildReport(findings, { t: T, base: baseAll(), fileCount: 2, skippedIds: [] });
  assert.equal(exitCode, EXIT.FAILURE);
  assert.equal(json.counts.error, 1);
  assert.equal(json.counts.warn, 1);
  // The verdict LINE itself, not merely the exit code: renderVerdict must
  // check errors before warnings, so a run with both never reaches the
  // "only warnings" text.
  assert.match(text, /^Result: this run fails because of the error\(s\) above\.$/m);
});

// A degraded run's exit is DEGRADED even when it also found an error: its
// error count cannot be trusted, since what failed might have found more.
test('buildReport: a defect outranks an error in the exit code', () => {
  const findings = [
    { id: 'secrets', file: 'a.md', line: 1, severity: 'error', messageKey: 'lint.secrets.pattern_matched_full', params: { pattern: 'x' } },
    { id: 'secrets', file: 'b.csv', line: null, severity: 'error', defect: true, check: 'file-read-failed', messageKey: 'lint.tool_defect.file_read_failed', params: { code: 'EACCES' } },
  ];
  assert.equal(buildReport(findings, { t: T, base: baseAll(), fileCount: 2, skippedIds: [] }).exitCode, EXIT.DEGRADED);
});

test('buildReport: only warnings never fails the run', () => {
  const findings = [{ id: 'orphans', file: 'b.md', line: null, severity: 'warn', messageKey: 'lint.orphans.unreachable', params: {} }];
  const { exitCode } = buildReport(findings, { t: T, base: baseAll(), fileCount: 1, skippedIds: [] });
  assert.equal(exitCode, EXIT.OK);
});

test('buildReport: findings within a group are sorted by file then line, not left in arrival order', () => {
  const findings = [
    { id: 'orphans', file: 'z.md', line: null, severity: 'warn', messageKey: 'lint.orphans.unreachable', params: {} },
    { id: 'orphans', file: 'a.md', line: null, severity: 'warn', messageKey: 'lint.orphans.unreachable', params: {} },
  ];
  const { text } = buildReport(findings, { t: T, base: baseAll(), fileCount: 2, skippedIds: [] });
  const warnSection = text.slice(text.indexOf('== Warnings =='));
  assert.ok(warnSection.indexOf('a.md') < warnSection.indexOf('z.md'), warnSection);
});

// The three sort clauses arrival order alone cannot exercise (same
// file, so the FILE clause is a tie every time): line, then id, then
// check. Each pair below differs in exactly ONE of the three, arrival
// order reversed from the expected result, so a mutation that dropped
// or inverted any single clause would still pass if the other two
// happened to agree with arrival order by coincidence; they do not
// here, on purpose.
test('buildReport: findings on the same file are sorted by line, then by rule id, then by check, not left in arrival order', () => {
  const findings = [
    { id: 'orphans', file: 'a.md', line: 9, severity: 'warn', messageKey: 'lint.orphans.unreachable', params: {} },
    { id: 'orphans', file: 'a.md', line: 2, severity: 'warn', messageKey: 'lint.orphans.unreachable', params: {} },
    { id: 'style', file: 'a.md', line: 5, severity: 'warn', check: 'forbidden-char', messageKey: 'lint.style.forbidden_char', params: { char: 'x' } },
    { id: 'index-completeness', file: 'a.md', line: 5, severity: 'warn', check: 'directory-has-index', messageKey: 'lint.index_completeness.missing_index', params: { dir: '.' } },
    { id: 'orphans', file: 'a.md', line: 5, severity: 'warn', check: 'zzz-check', messageKey: 'lint.orphans.unreachable', params: {} },
    { id: 'orphans', file: 'a.md', line: 5, severity: 'warn', check: 'aaa-check', messageKey: 'lint.orphans.unreachable', params: {} },
  ];
  const { text } = buildReport(findings, { t: T, base: baseAll(), fileCount: 1, skippedIds: [] });
  const warnSection = text.slice(text.indexOf('== Warnings =='));
  const lineAt = (needle) => warnSection.indexOf(needle);
  // Line clause: 2 before 5 before 9.
  assert.ok(lineAt('a.md:2') < lineAt('a.md:5') && lineAt('a.md:5') < lineAt('a.md:9'), warnSection);
  // Id clause, both at line 5: "index-completeness" < "orphans" < "style" alphabetically.
  const line5 = warnSection.slice(warnSection.indexOf('a.md:5'), warnSection.indexOf('a.md:9'));
  assert.ok(line5.indexOf('index-completeness') < line5.indexOf('orphans'), line5);
  assert.ok(line5.indexOf('orphans') < line5.indexOf('style'), line5);
  // The check clause (same file, same line, same id) is not visible in
  // the rendered TEXT at all (formatFinding never prints `check`); the
  // next test below exercises it directly through json.findings instead.
});

test('buildReport: json.findings is sorted exactly like the text report, not left in the order runLintRules produced', () => {
  const findings = [
    { id: 'orphans', file: 'a.md', line: 5, severity: 'warn', check: 'zzz-check', messageKey: 'lint.orphans.unreachable', params: {} },
    { id: 'orphans', file: 'a.md', line: 5, severity: 'warn', check: 'aaa-check', messageKey: 'lint.orphans.unreachable', params: {} },
    { id: 'orphans', file: 'a.md', line: 2, severity: 'warn', check: 'mid-check', messageKey: 'lint.orphans.unreachable', params: {} },
  ];
  const { json } = buildReport(findings, { t: T, base: baseAll(), fileCount: 1, skippedIds: [] });
  assert.deepEqual(
    json.findings.map((f) => `${f.line}:${f.check}`),
    ['2:mid-check', '5:aaa-check', '5:zzz-check'],
  );
});

// scope.linesRestricted follows the base's OWN kind, never merely whether
// this particular run happened to have any addedLines-scoped finding: a
// base kind other than "all" always means SOME line could have been
// excluded, whether or not this run's own findings happened to fall on one.
test('buildReport: scope.linesRestricted is true for every base kind except "all"', () => {
  for (const base of [
    { kind: 'all', reason: 'all-explicit' },
    { kind: 'worktree', reason: 'worktree-explicit' },
    { kind: 'auto', reason: 'auto-on-default-branch', anchor: 'HEAD' },
    { kind: 'merge-base', reason: 'merge-base-explicit', defaultBranch: 'main', mergeBaseSha: 'deadbeef' },
  ]) {
    const { json } = buildReport([], { t: T, base, fileCount: 0, skippedIds: [] });
    assert.equal(json.scope.linesRestricted, base.kind !== 'all', base.kind);
  }
});

// Every scope `reason` src/git.mjs's own resolveBase can return renders
// without throwing, and mentions something recognisable about what it
// means; a reason this file's own switch does not recognise throws
// instead of silently rendering nothing (or "undefined") on screen, which
// is exactly the kind of unnamed-return-value gap this task's own brief
// warns a mutation pass alone cannot find.
test('buildReport renders every scope reason resolveBase can produce, and throws on one it does not recognise', () => {
  const cases = [
    ['outside-repo', {}, /git repository/],
    ['all-explicit', {}, /"all"/],
    ['no-commits', {}, /no commit/],
    ['worktree-explicit', {}, /worktree/],
    ['merge-base-explicit', { defaultBranch: 'main' }, /merge base/],
    ['merge-base-unavailable', {}, /merge-base/],
    ['merge-base-same-as-current', {}, /already checked out/],
    ['auto-since-merge-base', { defaultBranch: 'main' }, /merge base/],
    ['auto-merge-base-unavailable', {}, /auto/],
    ['auto-no-default-branch', {}, /default branch/],
    ['auto-on-default-branch', {}, /default branch/],
    ['auto-on-default-branch-clean', {}, /default branch/],
  ];
  for (const [reason, extra, pattern] of cases) {
    const { text } = buildReport([], { t: T, base: { kind: 'x', reason, ...extra }, fileCount: 0, skippedIds: [] });
    assert.match(text, pattern, reason);
  }

  assert.throws(
    () => buildReport([], { t: T, base: { kind: 'x', reason: 'never-heard-of-this' }, fileCount: 0, skippedIds: [] }),
    /unrecognised scope reason/,
  );
});

// --- both language packs render this command's own messages ---------------

test("a finding's own message and the scope line both render through the vault's pack, in the vault's language", () => {
  const enRoot = makeVault({ files: oneErrorOneWarningFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  const enResult = run([enRoot]);
  assert.match(enResult.stdout, /not reachable by following links from the root index/);
  assert.doesNotMatch(enResult.stdout, /lint\.orphans\.unreachable/);

  const ptRoot = makeVault({ files: oneErrorOneWarningFiles(), config: { ...NO_DOUBLE_COUNT_CONFIG, lang: 'pt-BR' } });
  const ptResult = run([ptRoot]);
  assert.match(ptResult.stdout, /n\u00E3o \u00E9 alcan\u00E7\u00E1vel a partir do index raiz/);
  assert.doesNotMatch(ptResult.stdout, /lint\.orphans\.unreachable/);
  assert.doesNotMatch(ptResult.stdout, /not reachable by following links/);
});

// --- fix round 3, finding A: the vault is every file, not the markdown half ---
//
// The whole-slice review's live defect, driven end to end through the
// real binary. Nothing below is edited into the engine to make it fail;
// before fix round 3 every one of these runs printed zero errors and
// exited 0 while telling the reader the whole vault had been checked.

test('a credential committed in a non-markdown file is an error under --base all', () => {
  const root = makeVault({
    files: { ...cleanFiles(), 'deploy/secrets.env': `AWS_ACCESS_KEY_ID=${fakeAwsKey('OLD1111111111OLD')}\n` },
    config: NO_DOUBLE_COUNT_CONFIG,
  });
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  assert.match(result.stdout, /deploy\/secrets\.env:1 {2}secrets\b/);
});

test('a credential in a non-markdown file is an error under the DEFAULT scope too, with no base given', () => {
  const root = makeVault({
    files: { ...cleanFiles(), 'deploy/config.yml': `token: ${fakeAwsKey('NEW1111111111NEW')}\n` },
    config: NO_DOUBLE_COUNT_CONFIG,
  });
  const result = run([root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  assert.match(result.stdout, /deploy\/config\.yml:1 {2}secrets\b/);
});

// The SURVIVING CLAUSE of the whole-slice review (its mutation N8), now
// defended. Dropping `{ all: true }` from src/commands/lint.mjs's single
// walkVault call used to change nothing any test could observe; the lint
// ruler simply stopped seeing the non-markdown half of the vault, and
// `lint` and `validate` quietly disagreed about what the vault contained.
// This test is the input that tells the two variants apart: with the
// argument the key below is found, without it the walk hands the secrets
// rule markdown only and this run reports nothing at all.
test('the lint command walks EVERY file, not the markdown subset: the secrets rule reads what that walk returned', () => {
  const root = makeVault({
    files: { ...cleanFiles(), 'attachments/notes.json': `{"token": "${fakeAwsKey('WALK111111111ALL')}"}\n` },
    config: NO_DOUBLE_COUNT_CONFIG,
  });
  let seen = null;
  const io = { stdout: { write() {} }, stderr: { write() {} } };
  const spy = (dir, config, options) => {
    seen = options;
    return walkVault(dir, config, options);
  };
  const t = createTranslator('en');
  return runLint([root, '--base', 'all'], io, t, spy).then((status) => {
    // Outside a git repository the secrets rule's set IS this walk, so it
    // asks for dot-entries too (final fix round 2); the note rules get the
    // same walk with every dot-path dropped.
    assert.deepEqual(seen, { all: true, dotEntries: true }, 'the one walk this command makes must ask for every file, dot-entries included, outside a repository');
    assert.equal(status, EXIT.FAILURE, 'the key inside the JSON attachment must be found');
  });
});

// The other two cases of the same walk. Inside a repository the secrets
// rule reads git's own list, so the walk the note rules get is asked for no
// dot-entries at all; and with the secrets rule off nothing needs them, so
// they are not walked either. Walking them anyway reads directories no rule
// asked for, and an unreadable one of them fails the whole run.
test('the lint command walks dot-entries only when the secrets rule runs outside a repository', async () => {
  const spyOn = async (root, config) => {
    let seen = null;
    const io = { stdout: { write() {} }, stderr: { write() {} } };
    const spy = (dir, cfg, options) => {
      seen = options;
      return walkVault(dir, cfg, options);
    };
    await runLint([root, '--base', 'all'], io, createTranslator('en'), spy);
    return seen;
  };
  const inRepo = makeVault({ files: cleanFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  assert.equal(spawnSync('git', ['init', '-q', inRepo]).status, 0);
  assert.deepEqual(await spyOn(inRepo), { all: true, dotEntries: false }, 'inside a repository the secrets rule reads git\'s list, not the walk');
  const secretsOff = makeVault({ files: cleanFiles(), config: { ...NO_DOUBLE_COUNT_CONFIG, lint: { ...NO_DOUBLE_COUNT_CONFIG.lint, secrets: 'off' } } });
  assert.deepEqual(await spyOn(secretsOff), { all: true, dotEntries: false }, 'with the secrets rule off no rule reads a dot-entry');
});

// --- the size ceiling announces itself, and FAILS CLOSED --------------------
//
// Reading every file in the vault means a vault may hand this rule
// something enormous. The rule declines to read it, and SAYS SO: this
// project's standing rule is that every ceiling reports how much it cut,
// and a file the scanner skipped in silence would be the exact shape of
// defect this whole fix round is about.
//
// Final fix round 2 pins the two things the review proved nothing
// defended. The SEVERITY is an error, and the EXIT CODE is 1: a file the
// scanner could not read is something it should have read, so the run
// fails exactly like a run with a credential in it, and the adopting
// vault's gate, which reads only the exit code, refuses. Demoting this
// finding to a warning used to keep the whole suite green while a key on
// the last line of a large log reached a remote with exit 0; letting the
// too-large file fall through into a scan turned exit 1 into exit 3 and
// nothing noticed either. The comment that stood here said "a warning,
// not an error", which described the mutation, not the code.
//
// The file is SPARSE: its size is past the ceiling without a byte of it
// written, which is enough, because a file over the ceiling is measured
// and never read. The credential sits on its last line, the shape the
// review built.
function vaultWithOversizedLog() {
  const root = makeVault({ files: cleanFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  const log = join(root, 'attachments', 'export.log');
  mkdirSync(dirname(log), { recursive: true });
  const tail = `\naws_access_key_id = ${fakeAwsKey('TAIL1111TAIL2222')}\n`;
  writeFileSync(log, '');
  truncateSync(log, MAX_SCAN_BYTES + 64 - Buffer.byteLength(tail));
  appendFileSync(log, tail);
  return root;
}

test('a file over the per-file scan ceiling fails the run as an error with exit 1, and the verdict says it was too large to read', () => {
  const root = vaultWithOversizedLog();
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  assert.match(result.stdout, /attachments\/export\.log {2}secrets\b/);
  assert.match(result.stdout, /was NOT scanned for secrets/);
  // The remedy is named, and it is a configuration key a pull request shows.
  assert.match(result.stdout, /lint\.secrets\.exclude_paths/);
  assert.match(result.stdout, /^Result: this run fails because of the error\(s\) above, 1 of them a file too large to scan for secrets/m);

  const parsed = JSON.parse(run(['--base', 'all', root, '--json']).stdout);
  const tooLarge = parsed.findings.filter((f) => f.check === 'file-too-large');
  assert.equal(tooLarge.length, 1);
  assert.equal(tooLarge[0].severity, 'error');
  assert.equal(tooLarge[0].defect, false);
  assert.equal(parsed.counts.error, 1);
  assert.equal(parsed.counts.defect, 0);
});

// A file under the ceiling is read to its last byte. The too-large test
// only proves a file over it is refused, and the large CSV test only proves
// an ordinary one finishes in time; neither holds a key, so a scan that
// quietly stopped after its first megabyte kept both green. Just under the
// ceiling, with the key on the very last line: found, at that line. Written
// sparse, so it costs no disk; the zero bytes read as nothing.
test('a file just under the per-file ceiling is read to its end: a key on its last line is found, at that line', () => {
  const root = makeVault({ files: cleanFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  const log = join(root, 'attachments', 'export.log');
  mkdirSync(dirname(log), { recursive: true });
  const tail = `\naws_access_key_id = ${fakeAwsKey('ENDS1111ENDS2222')}\n`;
  writeFileSync(log, '');
  truncateSync(log, MAX_SCAN_BYTES - 64 - Buffer.byteLength(tail));
  appendFileSync(log, tail);
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  assert.deepEqual(secretLines(result.stdout), ['attachments/export.log:2']);
});

// A file holding NUL bytes is text with NUL bytes in it, never "binary"
// to be skipped: a UTF-16 export and a binary file with a credential in
// its bytes are both read.
test('a file holding NUL bytes is still read: a key in a UTF-16 export and a key inside a binary file are both found', () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`id,key\r\n1,${fakeAwsKey('UTF16111UTF16111')}\r\n`, 'utf16le')]);
  const binary = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]), Buffer.from(fakeAwsKey('BINARY11BINARY11'), 'latin1'), Buffer.from([0x00, 0xfe, 0x00])]);
  const root = makeVault({ files: cleanFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  mkdirSync(join(root, 'attachments'), { recursive: true });
  writeFileSync(join(root, 'attachments', 'export.csv'), utf16);
  writeFileSync(join(root, 'attachments', 'data.bin'), binary);
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  assert.deepEqual(secretLines(result.stdout), ['attachments/data.bin:1', 'attachments/export.csv:2']);
});

test('the too-large file is excluded by lint.secrets.exclude_paths, and the report says it was excluded rather than scanned', () => {
  const root = vaultWithOversizedLog();
  const config = JSON.parse(readFileSync(join(root, 'brain-kit.config.json'), 'utf8'));
  config.lint.secrets = { severity: 'error', exclude_paths: ['attachments/export.log'] };
  writeFileSync(join(root, 'brain-kit.config.json'), JSON.stringify(config, null, 2));
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.OK, result.stdout);
  assert.doesNotMatch(result.stdout, /attachments\/export\.log {2}secrets\b/);
  assert.match(result.stdout, /lint\.secrets\.exclude_paths excludes attachments\/export\.log, 1 file\(s\) in all/);
});

// An entry that excludes nothing is named apart from the ones that did.
// Listed among them, "./attachments/export.log" read as if that file had
// been left out, while git lists it as "attachments/export.log" and the
// rule read it: here it is too large, so the run still fails, and the
// report says why the exclusion did not take.
test('an exclusion that matches no published file is named as excluding nothing, never listed as if it had excluded the file', () => {
  const root = vaultWithOversizedLog();
  const config = JSON.parse(readFileSync(join(root, 'brain-kit.config.json'), 'utf8'));
  config.lint.secrets = { severity: 'error', exclude_paths: ['./attachments/export.log', 'index.md'] };
  writeFileSync(join(root, 'brain-kit.config.json'), JSON.stringify(config, null, 2));
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  assert.match(result.stdout, /attachments\/export\.log {2}secrets\b/);
  assert.match(result.stdout, /lint\.secrets\.exclude_paths excludes index\.md, 1 file\(s\) in all/);
  assert.match(result.stdout, /lint\.secrets\.exclude_paths names \.\/attachments\/export\.log, which match no file this vault would publish, so they exclude nothing/);
  const parsed = JSON.parse(run(['--base', 'all', root, '--json']).stdout);
  assert.deepEqual(parsed.secrets.excludeUnmatched, ['./attachments/export.log']);
  assert.deepEqual(parsed.secrets.excluded, ['index.md']);
});

// The vault's own configuration declares the very patterns this rule
// applies, so scanning it naively makes every vault report its own
// configuration as a leak on its first run. The exemption is exactly one
// thing wide, and this pins both halves of it.
test("the vault's own pattern list does not match itself, but a real credential elsewhere in the same file still does", () => {
  const key = fakeAwsKey('CONF11111111CONF');
  const root = makeVault({ files: cleanFiles(), config: { privacy: { secret_patterns: ['sk-ant-', 'internal-token-[0-9]{6}'] } } });
  const clean = run(['--base', 'all', root]);
  assert.doesNotMatch(clean.stdout, /brain-kit\.config\.json.* {2}secrets\b/);

  const leaky = makeVault({
    files: cleanFiles(),
    config: { privacy: { secret_patterns: ['sk-ant-'] }, curate: { signature: `curator ${key}` } },
  });
  const found = run(['--base', 'all', leaky]);
  assert.match(found.stdout, /brain-kit\.config\.json:\d+ {2}secrets\b/);
  assert.equal(found.status, EXIT.FAILURE);
});

// The one remaining way a file can stay away from the secrets rule, and
// it is the vault owner's own configured decision rather than this
// tool's. It used to be completely silent: a credential under an ignored
// prefix produced zero errors and exit 0, under a report that claimed
// every file had been scanned. The prefix is named now.
test('validate.ignore_paths still hides a path from every rule, and the report says so instead of claiming otherwise', () => {
  const root = makeVault({
    files: { ...cleanFiles(), 'build/out.env': `AWS_ACCESS_KEY_ID=${fakeAwsKey('IGNORED11IGNORED')}\n` },
    config: { ...NO_DOUBLE_COUNT_CONFIG, validate: { ignore_paths: ['build/'] } },
  });
  const result = run(['--base', 'all', root]);
  assert.doesNotMatch(result.stdout, /build\/out\.env/, 'an ignored path is not read by any rule, which is the configured behaviour');
  assert.match(result.stdout, /validate\.ignore_paths excludes build\//);
  // And the claim about the secrets rule's own reach names the set it
  // read: outside a git repository, the walk plus dot-files.
  assert.match(result.stdout, /this is not a git repository, so it read \d+ file\(s\), every one the vault walk includes plus dot-files/);
});

test('a vault with no ignore_paths is not shown a caveat about an empty list', () => {
  const root = makeVault({ files: cleanFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  const result = run(['--base', 'all', root]);
  assert.doesNotMatch(result.stdout, /ignore_paths/);
});

// --- final fix round 2: what the secrets rule reads is what a push publishes ---
//
// Every test below is a real run of the real binary. Inside a git
// repository the secrets rule reads what git tracks plus what it would
// add: dot-paths included, ignored files not, never .git. Each member the
// old walk-based set did not hold, or held wrongly, is built here in its
// adversarial shape, which is usually its most common one: the environment
// file is `.env` itself, not a file that merely has "env" in its name.

function commitAll(root, message) {
  assert.equal(git(root, ['add', '-A']).status, 0);
  const done = git(root, ['commit', '-q', '-m', message]);
  assert.equal(done.status, 0, done.stderr);
}

function secretLines(stdout) {
  return (stdout.match(/^\S+:\d+ {2}secrets\b/gm) ?? []).map((line) => line.split(/\s/)[0]).sort();
}

test('a committed .env, an .aws/credentials file and a workflow file are each read, where the walk skips every dot-path', () => {
  const root = makeGitVault({
    files: {
      ...cleanFiles(),
      '.env': `AWS_ACCESS_KEY_ID=${fakeAwsKey('DOTENV11DOTENV11')}\n`,
      'attachments/.aws/credentials': `[default]\naws_access_key_id = ${fakeAwsKey('AWSCRED1AWSCRED1')}\n`,
      '.github/workflows/deploy.yml': `env:\n  KEY: ${fakeAwsKey('WORKFLOW11111111')}\n`,
    },
    config: NO_DOUBLE_COUNT_CONFIG,
  });
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  assert.deepEqual(secretLines(result.stdout), ['.env:1', '.github/workflows/deploy.yml:2', 'attachments/.aws/credentials:2']);
  // The reach line names git's set and counts it: the three notes, the
  // configuration and the three dot-files.
  assert.match(result.stdout, /it read 7 file\(s\), every one git tracks or would add here, dot-files included/);
});

// A dot-file is read against everything the vault configured, not only the
// generic shapes. The three keys above are all generic, so reading dot-files
// against the shapes alone kept that test green while a committed .env
// holding a token shape only this vault's configuration names went through
// a real push, and the remote held it.
test('a committed .env is read against the patterns the vault configured, not the generic shapes alone', () => {
  const token = `acmetok_${'0123456789abcdef'.repeat(2)}`;
  const root = makeGitVault({
    files: { ...cleanFiles(), '.env': `ACME_TOKEN=${token}\n`, 'deploy/.env': `ACME_TOKEN=${token}\n` },
    config: { privacy: { secret_patterns: ['acmetok_[0-9a-f]{32}'] } },
  });
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  assert.deepEqual(secretLines(result.stdout), ['.env:1', 'deploy/.env:1']);
});

test('a file git ignores is never read, so a local credentials file cannot refuse a push, while an untracked file git would add is read', () => {
  const root = makeGitVault({
    files: { ...cleanFiles(), '.gitignore': 'local-only/\n' },
    config: NO_DOUBLE_COUNT_CONFIG,
  });
  writeFileSync(join(root, 'local-only-placeholder.md'), '# not linked, not secret\n');
  mkdirSync(join(root, 'local-only'));
  writeFileSync(join(root, 'local-only', 'credentials'), `aws_access_key_id = ${fakeAwsKey('IGNORED1IGNORED1')}\n`);
  const clean = run(['--base', 'all', root]);
  assert.equal(clean.status, EXIT.OK, clean.stdout);
  assert.doesNotMatch(clean.stdout, /local-only\/credentials/);

  // The same credential in a file git WOULD add is what a `git add -A`
  // publishes next, and it is read.
  writeFileSync(join(root, 'scratch.env'), `aws_access_key_id = ${fakeAwsKey('UNTRACKED1111111')}\n`);
  const found = run(['--base', 'all', root]);
  assert.equal(found.status, EXIT.FAILURE, found.stdout);
  assert.deepEqual(secretLines(found.stdout), ['scratch.env:1']);
});

test('the line about the secrets rule\'s reach is printed only when the rule ran, and never beside a run that skipped it', () => {
  const root = makeGitVault({ files: cleanFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  const ran = run(['--base', 'all', root]);
  assert.match(ran.stdout, /The secrets rule is never narrowed by the scope above/);

  const onlyTables = run(['--base', 'all', '--rule', 'tables', root]);
  assert.doesNotMatch(onlyTables.stdout, /secrets rule/);

  const off = makeGitVault({ files: cleanFiles(), config: { ...NO_DOUBLE_COUNT_CONFIG, lint: { secrets: 'off' } } });
  const offRun = run(['--base', 'all', off]);
  assert.match(offRun.stdout, /Skipped \(severity off, did not run\): secrets\./);
  assert.doesNotMatch(offRun.stdout, /The secrets rule/);
  assert.deepEqual(JSON.parse(run(['--base', 'all', off, '--json']).stdout).secrets, { ran: false });
});

test('inside a repository validate.ignore_paths no longer hides a published file from the secrets rule, and the report says the note rules alone skip it', () => {
  const root = makeGitVault({
    files: { ...cleanFiles(), 'build/out.env': `AWS_ACCESS_KEY_ID=${fakeAwsKey('BUILDDIR1BUILD11')}\n` },
    config: { ...NO_DOUBLE_COUNT_CONFIG, validate: { ignore_paths: ['build/'] } },
  });
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  assert.deepEqual(secretLines(result.stdout), ['build/out.env:1']);
  assert.match(result.stdout, /validate\.ignore_paths excludes build\/ from every rule but secrets/);
});

test('the configuration is read raw against the credential shapes: its own literal prefixes no longer blank a real key out of another field', () => {
  // The shipped example declares `sk-ant-` and `github_pat_` as literal
  // patterns. The blanking this replaced erased every occurrence of those
  // literals anywhere in the file, and with them the prefix of any real
  // key of those two kinds pasted into another field.
  const anthropicKey = `sk-ant-${'api03'}${'Q'.repeat(40)}`;
  const githubToken = `github_pat_${'11'}${'R'.repeat(40)}`;
  const root = makeVault({
    files: cleanFiles(),
    config: { curate: { signature: anthropicKey }, briefing: { signature: githubToken } },
  });
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  assert.equal(secretLines(result.stdout).filter((line) => line.startsWith('brain-kit.config.json:')).length, 2, result.stdout);
});

test('a pattern written for the owner\'s own domain or company flags a note, and never the owner\'s own identity in the configuration', () => {
  const root = makeVault({
    files: { ...cleanFiles(), 'people/ana.md': `${CLEAN_ANA}\nWrite to ana@example.com about the Example   Ltd contract.\n` },
    config: { privacy: { secret_patterns: ['@example\\.com', 'Example\\s+Ltd'] } },
  });
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  const lines = secretLines(result.stdout);
  assert.ok(lines.every((line) => !line.startsWith('brain-kit.config.json')), `the owner's own address and company were reported:\n${result.stdout}`);
  assert.deepEqual(lines, ['people/ana.md:5', 'people/ana.md:5']);
});

test('a copy of the configuration anywhere but the vault root is an ordinary file, read against every pattern', () => {
  const root = makeVault({
    files: { ...cleanFiles(), 'examples/brain-kit.config.json': '{ "note": "an internal-token-482913 left in an example" }\n' },
    config: { privacy: { secret_patterns: ['internal-token-[0-9]{6}'] } },
  });
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  assert.deepEqual(secretLines(result.stdout), ['examples/brain-kit.config.json:1']);
});

test('a configured pattern holding an accented letter matches the accented text it was written for', () => {
  // A regression the previous round introduced: content was decoded one
  // byte per character while patterns stayed UTF-8, so this matched at the
  // commit before and matched nothing after. Escapes keep this file ASCII.
  const root = makeVault({
    files: { ...cleanFiles(), 'people/ana.md': `${CLEAN_ANA}\nC\u00F3digo de acesso: 482913\n` },
    config: { privacy: { secret_patterns: ['C\u00F3digo de acesso: [0-9]{6}'] } },
  });
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  assert.deepEqual(secretLines(result.stdout), ['people/ana.md:5']);
});

test('a symbolic link is read as the link git publishes, never as whatever it points at', () => {
  // A link out of the vault to a credentials file publishes the link's
  // own text, not the file; reading the file would refuse a push over
  // something the push does not carry. A link whose own TEXT is shaped
  // like a credential publishes exactly that, and is reported.
  const outside = makeTempDir('brain-kit-lint-outside-');
  writeFileSync(join(outside, 'credentials'), `aws_access_key_id = ${fakeAwsKey('OUTSIDE1OUTSIDE1')}\n`);
  const root = makeGitVault({ files: cleanFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  symlinkSync(join(outside, 'credentials'), join(root, 'people', 'creds-link'));
  symlinkSync(fakeAwsKey('LINKTEXT1LINKTXT'), join(root, 'people', 'dangling-link'));
  commitAll(root, 'links');
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, result.stdout);
  assert.deepEqual(secretLines(result.stdout), ['people/dangling-link:1']);
});

test('a file git tracks that is missing from the working tree is not read, and the report says so rather than passing it in silence', () => {
  const root = makeGitVault({
    files: { ...cleanFiles(), 'people/old.md': `# Old\n\n${fakeAwsKey('DELETED1DELETED1')}\n` },
    config: NO_DOUBLE_COUNT_CONFIG,
  });
  rmSync(join(root, 'people', 'old.md'));
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.OK, result.stdout);
  assert.match(result.stdout, /Not scanned for secrets: 1 file\(s\) git tracks are missing from the working tree \(people\/old\.md\), so what a commit holds for them was not read\./);
  assert.deepEqual(JSON.parse(run(['--base', 'all', root, '--json']).stdout).secrets.absent, ['people/old.md']);
});

test('a tracked directory replaced by a link out of the vault is missing from the working tree: the file behind the link is never read', () => {
  const outside = makeTempDir('brain-kit-lint-outside-');
  mkdirSync(join(outside, 'notes'));
  writeFileSync(join(outside, 'notes', 'plan.md'), `${fakeAwsKey('BEHINDLINK111111')}\n`);
  const root = makeGitVault({ files: { ...cleanFiles(), 'notes/plan.md': '# Plan\n' }, config: NO_DOUBLE_COUNT_CONFIG });
  rmSync(join(root, 'notes'), { recursive: true });
  symlinkSync(join(outside, 'notes'), join(root, 'notes'));
  const result = run(['--base', 'all', root]);
  assert.doesNotMatch(result.stdout, /notes\/plan\.md:\d+ {2}secrets/, 'a file outside the vault was read through a symbolic link');
  assert.match(result.stdout, /missing from the working tree \(notes\/plan\.md\)/);
});

test('a directory holding a repository of its own is not read, and the report names it', () => {
  const root = makeGitVault({ files: cleanFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  const nested = join(root, 'vendor-notes');
  assert.equal(spawnSync('git', ['init', '-q', nested]).status, 0);
  writeFileSync(join(nested, 'inside.txt'), `${fakeAwsKey('NESTEDREPO111111')}\n`);
  const result = run(['--base', 'all', root]);
  assert.doesNotMatch(result.stdout, /inside\.txt/);
  assert.match(result.stdout, /Not scanned for secrets: vendor-notes, each a submodule or a repository of its own/);
});

test('a published file whose name is not valid UTF-8 cannot be read by name, so the run is degraded rather than passing it', { skip: process.platform !== 'linux' ? 'only Linux lets a file name hold arbitrary bytes' : false }, () => {
  const root = makeGitVault({ files: cleanFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  const name = Buffer.concat([Buffer.from(join(root, 'people', 'bad'), 'utf8'), Buffer.from([0xff]), Buffer.from('.txt')]);
  writeFileSync(name, `${fakeAwsKey('BADNAME1BADNAME1')}\n`);
  commitAll(root, 'an undecodable name');
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.DEGRADED, result.stdout);
  assert.match(result.stdout, /this file's name is not valid UTF-8/);
  assert.match(result.stdout, /1 file\(s\) could not be read/);
});

test('an ordinary large CSV of short lines is scanned in full and passes, rather than timing out and being called a crash', () => {
  // The review's own shape: about 3.9 MB of short lines and no secret,
  // which ran out of the old flat per-file budget and was reported as a
  // crashed rule.
  const row = '2026-09-22,17.4,0.51\n';
  const root = makeVault({ files: { ...cleanFiles(), 'attachments/sensor.csv': row.repeat(Math.ceil((3.9 * 1024 * 1024) / row.length)) }, config: NO_DOUBLE_COUNT_CONFIG });
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.OK, result.stdout);
  assert.doesNotMatch(result.stdout, /Tool defects|degraded|crashed/);
});

test('a file that cannot be read is reported without the absolute path the operating system named it by, in the text report and in --json', { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'root reads every file' : false }, () => {
  const root = makeVault({ files: { ...cleanFiles(), 'attachments/locked.txt': 'nothing\n' }, config: NO_DOUBLE_COUNT_CONFIG });
  chmodSync(join(root, 'attachments', 'locked.txt'), 0o000);
  try {
    const text = run(['--base', 'all', root]);
    assert.equal(text.status, EXIT.DEGRADED, text.stdout);
    assert.match(text.stdout, /attachments\/locked\.txt {2}secrets {2}this file could not be read at all \(error EACCES\)/);
    assert.ok(!text.stdout.includes(root), 'the report printed the vault\'s absolute path');
    const json = run(['--base', 'all', root, '--json']);
    assert.ok(!json.stdout.includes(root), 'the --json envelope carried the vault\'s absolute path');
  } finally {
    chmodSync(join(root, 'attachments', 'locked.txt'), 0o644);
  }
});

// --- final fix round 2: the verdict says what degraded or failed the run -----

test('buildReport: a degraded run names what degraded it, and a file that ran out of time is never called a crash', () => {
  const defect = (check) => ({ id: 'secrets', file: 'a.csv', line: null, severity: 'error', defect: true, check, messageKey: 'lint.tool_defect.file_scan_timed_out', params: { message: 'm' } });
  const timedOut = buildReport([defect('file-scan-timed-out')], { t: T, base: baseAll(), fileCount: 1, skippedIds: [] });
  assert.equal(timedOut.exitCode, EXIT.DEGRADED);
  assert.match(timedOut.text, /^Result: this run is degraded \(1 file\(s\) took too long to scan for secrets and timed out\)/m);
  assert.doesNotMatch(timedOut.text, /crash/);

  const all = buildReport(
    [defect('rule-crashed'), defect('file-scan-timed-out'), defect('file-scan-failed'), defect('file-read-failed'), defect('file-name-undecodable'), defect('publishable-list-failed'), defect('something-new')],
    { t: T, base: baseAll(), fileCount: 1, skippedIds: [] },
  );
  assert.match(
    all.text,
    /^Result: this run is degraded \(1 rule\(s\) crashed, 1 file\(s\) took too long to scan for secrets and timed out, 1 file\(s\) could not be scanned for secrets, 2 file\(s\) could not be read, git could not list the files this vault would publish, 1 other defect\(s\)\)/m,
  );
});

test('buildReport: the paths on a "not scanned" line are capped, and what the cap cut is counted', () => {
  const absent = Array.from({ length: 12 }, (_, i) => `notes/n${String(i).padStart(2, '0')}.md`);
  const secretScan = { source: 'git', files: [], excludePaths: [], excluded: [], excludeUnmatched: [], gitlinks: [], embedded: [], absent, undecodable: [], failure: null };
  const { text, json } = buildReport([], { t: T, base: baseAll(), fileCount: 0, skippedIds: [], secretScan });
  assert.match(text, /12 file\(s\) git tracks are missing from the working tree \(notes\/n00\.md, [^)]*notes\/n09\.md, and 2 more\)/);
  assert.doesNotMatch(text, /notes\/n10\.md/);
  assert.equal(json.secrets.absent.length, 12, 'the envelope keeps every path');
});

test('buildSecretScan: a listing git could not produce is a failure the rule reports, never a fallback to some other list', () => {
  const scan = buildSecretScan('/nonexistent', {}, { listing: { failure: { status: 128 } }, walked: ['a.md', '.env'] });
  assert.deepEqual(scan.files, []);
  assert.deepEqual(scan.failure, { status: 128 });
});

test('buildSecretScan: outside a repository the set is the walk, less what lint.secrets.exclude_paths names', () => {
  const config = { lint: { secrets: { exclude_paths: ['attachments/', 'big.csv'] } } };
  const scan = buildSecretScan('/nonexistent', config, { listing: { listed: null }, walked: ['.env', 'attachments/a.pdf', 'big.csv', 'big.csv.bak', 'index.md'] });
  assert.equal(scan.source, 'walk');
  assert.deepEqual(scan.files, ['.env', 'big.csv.bak', 'index.md']);
  assert.deepEqual(scan.excluded, ['attachments/a.pdf', 'big.csv']);
  assert.deepEqual(scan.excludePaths, ['attachments/', 'big.csv']);
  // A bare severity string carries no exclusions, and neither does an
  // entry that is not a non-empty string.
  assert.deepEqual(buildSecretScan('/nonexistent', { lint: { secrets: 'error' } }, { listing: { listed: null }, walked: ['big.csv'] }).files, ['big.csv']);
  assert.deepEqual(buildSecretScan('/nonexistent', { lint: { secrets: { exclude_paths: ['', 7] } } }, { listing: { listed: null }, walked: ['big.csv'] }).files, ['big.csv']);
});

test('buildSecretScan: a tracked file inside a directory that cannot be read stays in the set, so the read fails loudly, and is never quietly counted as missing', { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'root reads every directory' : false }, () => {
  // Only "no such entry" means missing from the working tree. Any other
  // failure to look (here, a directory with no permissions) keeps the file
  // in the set, so the secrets rule's own read fails and reports it: the
  // refusing direction. The vault walk itself stops at such a directory
  // before this is reached in a real run, which is a limit of the walk.
  const root = makeGitVault({ files: { ...cleanFiles(), 'vault-private/key.txt': 'x\n' }, config: NO_DOUBLE_COUNT_CONFIG });
  chmodSync(join(root, 'vault-private'), 0o000);
  try {
    const listed = { files: ['index.md', 'vault-private/key.txt'], gitlinks: [], embedded: [], undecodable: [] };
    const scan = buildSecretScan(root, {}, { listing: { listed }, walked: [] });
    assert.deepEqual(scan.files, ['index.md', 'vault-private/key.txt']);
    assert.deepEqual(scan.absent, []);
  } finally {
    chmodSync(join(root, 'vault-private'), 0o755);
  }
});

test('when git cannot list what the vault would publish, the run is degraded and says so, and the other rules still report', () => {
  const root = makeGitVault({ files: { ...cleanFiles(), 'people/ghost.md': GHOST }, config: { ...NO_DOUBLE_COUNT_CONFIG, lint: { secrets: { severity: 'error', exclude_paths: ['attachments/'] } } } });
  writeFileSync(join(root, '.git', 'index'), 'not an index');
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.DEGRADED, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /git could not list the files this vault would publish \(git exited \d+\), so the secrets rule read nothing at all/);
  assert.match(result.stdout, /people\/ghost\.md {2}orphans/);
  // No line claims a set was read, or had something left out of it, that
  // git never produced.
  assert.doesNotMatch(result.stdout, /The secrets rule is never narrowed/);
  assert.doesNotMatch(result.stdout, /exclude_paths/);
  assert.equal(JSON.parse(run(['--base', 'all', root, '--json']).stdout).secrets.listingFailed, true);
});

test('buildSecretScan: a name that cannot be decoded is left out when the vault excluded the prefix it sits under', () => {
  const root = makeGitVault({ files: cleanFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  const listed = { files: ['index.md'], gitlinks: [], embedded: [], undecodable: ['vendor/bad\u00ff.bin', 'notes/bad\u00ff.md'] };
  const scan = buildSecretScan(root, { lint: { secrets: { exclude_paths: ['vendor/', './notes'] } } }, { listing: { listed }, walked: [] });
  assert.deepEqual(scan.undecodable, ['notes/bad\u00ff.md']);
  assert.deepEqual(scan.files, ['index.md']);
  // Counted as excluded, so the report's count covers it and the entry
  // that left it out is not named as excluding nothing.
  assert.deepEqual(scan.excluded, ['vendor/bad\u00ff.bin']);
  // And an entry written the way git never lists a path excludes nothing,
  // and is named for it.
  assert.deepEqual(scan.excludeUnmatched, ['./notes']);
});

test('outside a repository the dot-entries walked for the secrets rule never become notes for the other seven rules', () => {
  const root = makeVault({ files: { ...cleanFiles(), '.brain-kit/prompts/curate.md': '# A prompt, not a note\n' }, config: NO_DOUBLE_COUNT_CONFIG });
  const parsed = JSON.parse(run(['--base', 'all', root, '--json']).stdout);
  assert.equal(parsed.scope.files, 3);
  assert.ok(!parsed.findings.some((f) => f.file === '.brain-kit/prompts/curate.md'), JSON.stringify(parsed.findings));
  assert.equal(parsed.secrets.scanned, 5, 'the secrets rule still read the prompt, and the configuration');
});

test('a configured pattern saved in another encoding still matches: the configuration is decoded the way content is', () => {
  // The pattern's accented letter is written as the one latin1 byte it is
  // in that encoding, which is not UTF-8. Read as UTF-8 it would become a
  // replacement character, and the pattern would match nothing.
  const root = makeVault({ files: { ...cleanFiles(), 'people/ana.md': `${CLEAN_ANA}\nCaf\u00e9 da manh\u00e3 com o cliente\n` } });
  const configPath = join(root, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.privacy.secret_patterns = ['CAFE-PLACEHOLDER da manh'];
  const [before, after] = JSON.stringify(config, null, 2).split('CAFE-PLACEHOLDER');
  writeFileSync(configPath, Buffer.concat([Buffer.from(before, 'utf8'), Buffer.from('Caf\u00e9', 'latin1'), Buffer.from(after, 'utf8')]));
  const result = run(['--base', 'all', root]);
  assert.equal(result.status, EXIT.FAILURE, `${result.stdout}${result.stderr}`);
  assert.deepEqual(secretLines(result.stdout), ['people/ana.md:5']);
});
