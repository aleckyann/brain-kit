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
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { walkVault } from '../src/vault.mjs';
import { runLint, buildReport } from '../src/commands/lint.mjs';
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
  assert.match(ptResult.stdout, /não é alcançável a partir do index raiz/);
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
    assert.deepEqual(seen, { all: true }, 'the one walk this command makes must ask for every file');
    assert.equal(status, EXIT.FAILURE, 'the key inside the JSON attachment must be found');
  });
});

// --- fix round 3: the size ceiling announces itself -------------------------
//
// Reading every file in the vault means a vault may hand this rule
// something enormous. The rule declines to read it, and SAYS SO: this
// project's standing rule is that every ceiling reports how much it cut,
// and a file the scanner skipped in silence would be the exact shape of
// defect this whole fix round is about.
test('a file over the per-file scan ceiling is reported, never skipped in silence', () => {
  const big = 'x'.repeat(5 * 1024 * 1024);
  const root = makeVault({ files: { ...cleanFiles(), 'attachments/huge.bin': big }, config: NO_DOUBLE_COUNT_CONFIG });
  const result = run(['--base', 'all', root]);
  assert.match(result.stdout, /attachments\/huge\.bin {2}secrets\b/);
  assert.match(result.stdout, /was NOT scanned for secrets/);
  // A warning, not an error: the tool is reporting a gap in its own
  // coverage, not claiming to have found a credential. It is still enough
  // to keep the run from calling itself simply clean.
  assert.doesNotMatch(result.stdout, /Result: no findings\./);
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
  // And the claim about the secrets rule's own reach is bounded by the
  // walk, not stated as "every file in the vault".
  assert.match(result.stdout, /every file this vault's walk includes/);
});

test('a vault with no ignore_paths is not shown a caveat about an empty list', () => {
  const root = makeVault({ files: cleanFiles(), config: NO_DOUBLE_COUNT_CONFIG });
  const result = run(['--base', 'all', root]);
  assert.doesNotMatch(result.stdout, /ignore_paths/);
});
