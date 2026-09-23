// templates/githooks/pre-push: the version an ADOPTING vault installs, as
// opposed to .githooks/pre-push (this checkout's own maintainer gate,
// covered by test/pre-push-hook.test.mjs). This file proves the template's
// four jobs: run validate, run lint, run the object scan over what the
// push carries (brain-kit push-gate --patterns config), and refuse a push
// to the vault's own default branch made under its own configured
// automation identity. Every push here goes to a throwaway bare remote,
// exactly like test/pre-push-hook.test.mjs's own standing rule; the live
// gate is never bypassed to test it. brain-kit reaches the hook the one
// way the template allows, on PATH, through a shim to this checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { delimiter } from 'node:path';
import { join, dirname } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { makeVault } from './helpers/vault-fixture.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const TEMPLATE_HOOK = join(KIT_ROOT, 'templates', 'githooks', 'pre-push');
const REAL_BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');

// The smallest vault that passes both `validate` (the Open Knowledge
// Format and this project's own house rules) and `lint` at its default
// severities, taken from test/validate.test.mjs's own fixture: orphans and
// index-completeness default to 'warn', which never turns lint's own exit
// code non-zero, so index.md need not actually link to people/ana.md here.
const CLEAN_LOG = [
  '## 2026-09-18',
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
  '',
  '# Ana',
  '',
  'An example person, with nothing any rule here flags.',
  '',
].join('\n');

function cleanFiles() {
  return { 'index.md': INDEX, 'memory/log.md': CLEAN_LOG, 'people/ana.md': CLEAN_PERSON };
}

// The fixture config's own git.agent_identity (test/fixtures/config/valid.json):
// a fictional address, never a real one, per this project's own standing rule.
const AGENT_EMAIL = 'curator@example.invalid';
const HUMAN_NAME = 'A Human';
const HUMAN_EMAIL = 'human@example.invalid';

// PATH without any directory that already holds a brain-kit, so the only
// one a hook can find is the shim below (or none, where a test says so).
const PATH_WITHOUT_BRAIN_KIT = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '' && !existsSync(join(dir, 'brain-kit'))).join(delimiter);
// A directory with a space in its name, as a real one often has.
const SHIM_DIR = join(makeTempDir('brain-kit-template-shim-'), 'a bin dir');
mkdirSync(SHIM_DIR, { recursive: true });
writeFileSync(join(SHIM_DIR, 'brain-kit'), `#!/usr/bin/env bash\nexec node ${JSON.stringify(REAL_BIN)} "$@"\n`);
chmodSync(join(SHIM_DIR, 'brain-kit'), 0o755);
const PATH_WITH_BRAIN_KIT = `${SHIM_DIR}${delimiter}${PATH_WITHOUT_BRAIN_KIT}`;

// A throwaway personal list, set for every push: the template's gate must
// never read it (see "never reads the personal list" below), and if it
// did, this is the list it would find, never a real one.
const PERSONAL_PATTERNS = join(makeTempDir('brain-kit-template-personal-'), 'patterns.txt');
writeFileSync(PERSONAL_PATTERNS, 'zqxpersonalmark\n');

function git(cwd, args, { name = HUMAN_NAME, email = HUMAN_EMAIL, env = {} } = {}) {
  return spawnSync('git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: PATH_WITH_BRAIN_KIT, BRAIN_KIT_LEAK_PATTERNS: PERSONAL_PATTERNS, ...env },
  });
}

// Builds a throwaway vault (makeVault) wired up exactly like an adopting
// vault would be: the template hook installed at .githooks/pre-push,
// core.hooksPath pointed at it, and a bare remote. brain-kit comes from
// PATH (the shim above), never from inside the vault.
function setup({ config = {}, files = cleanFiles(), branch = 'main' } = {}) {
  const root = makeTempDir('brain-kit-prepush-template-');
  const bare = join(root, 'origin.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);

  const work = makeVault({ files, config });
  assert.equal(spawnSync('git', ['init', '-q', '-b', branch, work]).status, 0);

  mkdirSync(join(work, '.githooks'));
  copyFileSync(TEMPLATE_HOOK, join(work, '.githooks', 'pre-push'));
  chmodSync(join(work, '.githooks', 'pre-push'), 0o755);

  assert.equal(git(work, ['config', 'core.hooksPath', '.githooks']).status, 0);
  assert.equal(git(work, ['remote', 'add', 'origin', bare]).status, 0);
  return { root, work, bare };
}

function commitEverything(work, message, identity = {}) {
  assert.equal(git(work, ['add', '-A'], identity).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', message], identity).status, 0);
}

test('a clean vault, pushed to the default branch by a human, is accepted', () => {
  const { work } = setup();
  commitEverything(work, 'init');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  assert.equal(r.status, 0, r.stderr);
});

test('a vault that fails validate is refused before lint or the identity guard ever run', () => {
  // A person frontmatter with no `generated` field: valid.json requires it
  // (frontmatter.required), so this fails validate's own house rule.
  const files = { ...cleanFiles(), 'people/ana.md': '---\ntype: person\ndescription: missing generated\n---\n\n# Ana\n' };
  const { work } = setup({ files });
  commitEverything(work, 'init');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /brain-kit validate found a problem/);
});

test('a vault that fails lint (an error-severity finding) is refused', () => {
  // `style` only judges lines a change ADDED (src/git.mjs's own scope
  // contract), which is empty by construction for a single commit
  // already fully committed with nothing left in the worktree: there is
  // nothing "added" left to see by the time a push happens. `secrets`
  // used to work that way too and no longer does (fix round 3); it is
  // exercised on its own below. `privacy` (lint.privacy, error by
  // default in the fixture config) never had a scope: a link from OUTSIDE
  // a confidential directory (privacy.confidential_dirs: ["people/"])
  // INTO one is a whole-vault check, so it fires here regardless.
  const files = { ...cleanFiles(), 'index.md': `${INDEX}\n[Ana](people/ana.md)\n` };
  const { work } = setup({ files });
  commitEverything(work, 'init');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /brain-kit lint found a problem/);
});

test('the automation identity pushing straight to the default branch is refused', () => {
  const { work } = setup();
  commitEverything(work, 'init', { name: "Ana's Second Brain (curator)", email: AGENT_EMAIL });
  const r = git(work, ['push', '-q', 'origin', 'main'], { name: "Ana's Second Brain (curator)", email: AGENT_EMAIL });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing a push to the default branch/);
  assert.match(r.stderr, new RegExp(AGENT_EMAIL.replace('.', '\\.')));
});

test('the automation identity pushing to a non-default branch is accepted', () => {
  const { work } = setup();
  commitEverything(work, 'init', { name: "Ana's Second Brain (curator)", email: AGENT_EMAIL });
  assert.equal(git(work, ['checkout', '-q', '-b', 'bot/curate-2026-09-19']).status, 0);
  writeFileSync(join(work, 'people', 'ana.md'), `${CLEAN_PERSON}\nAn extra line, still clean.\n`);
  commitEverything(work, 'curated change', { name: "Ana's Second Brain (curator)", email: AGENT_EMAIL });
  const r = git(work, ['push', '-q', 'origin', 'bot/curate-2026-09-19'], { name: "Ana's Second Brain (curator)", email: AGENT_EMAIL });
  assert.equal(r.status, 0, r.stderr);
});

test('a human identity pushing to the default branch is accepted even though the vault has an automation identity configured', () => {
  const { work } = setup();
  commitEverything(work, 'init');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  assert.equal(r.status, 0, r.stderr);
});

test('forbid_agent_push_to_default: false turns the guard off', () => {
  const { work } = setup({ config: { git: { forbid_agent_push_to_default: false } } });
  commitEverything(work, 'init', { name: "Ana's Second Brain (curator)", email: AGENT_EMAIL });
  const r = git(work, ['push', '-q', 'origin', 'main'], { name: "Ana's Second Brain (curator)", email: AGENT_EMAIL });
  assert.equal(r.status, 0, r.stderr);
});

// --- which ref field the guard reads -------------------------------------
//
// Every test above pushes a branch to a branch of the SAME NAME, which is
// why reading the source ref instead of the destination survived a review
// round: the two agree in the ordinary case and only the destination is
// ever true. These four are the cases where they disagree.

const AGENT = { name: "Ana's Second Brain (curator)", email: AGENT_EMAIL };

test('the automation identity pushing a differently named branch INTO the default branch is refused', () => {
  const { work } = setup();
  commitEverything(work, 'init', AGENT);
  assert.equal(git(work, ['checkout', '-q', '-b', 'bot/curate-2026-09-19']).status, 0);
  writeFileSync(join(work, 'people', 'ana.md'), `${CLEAN_PERSON}\nAn extra line, still clean.\n`);
  commitEverything(work, 'curated change', AGENT);
  const r = git(work, ['push', '-q', 'origin', 'bot/curate-2026-09-19:main'], AGENT);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /refusing a push to the default branch/);
});

test('the automation identity pushing HEAD into the default branch by full reference is refused', () => {
  const { work } = setup();
  commitEverything(work, 'init', AGENT);
  assert.equal(git(work, ['checkout', '-q', '-b', 'bot/curate-2026-09-19']).status, 0);
  writeFileSync(join(work, 'people', 'ana.md'), `${CLEAN_PERSON}\nAn extra line, still clean.\n`);
  commitEverything(work, 'curated change', AGENT);
  const r = git(work, ['push', '-q', 'origin', 'HEAD:refs/heads/main'], AGENT);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /refusing a push to the default branch/);
});

test('the automation identity DELETING the default branch is refused', () => {
  // A deletion is a push to that destination too, and it skips the same
  // review. Git itself may also refuse to delete a remote's current branch,
  // so the assertion is on the guard's own message, not on the exit code
  // alone.
  const { work } = setup();
  commitEverything(work, 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main']).status, 0);
  const r = git(work, ['push', '-q', 'origin', ':main'], AGENT);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /refusing a push to the default branch/);
});

test('the automation identity pushing a tag is accepted: a tag is not a branch', () => {
  const { work } = setup();
  commitEverything(work, 'init', AGENT);
  assert.equal(git(work, ['tag', '-a', 'v1', '-m', 'v1'], AGENT).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'v1'], AGENT);
  assert.equal(r.status, 0, r.stderr);
});

// --- the three steps of the default-branch ladder ------------------------
//
// Each step is the ONLY one that can resolve in its own test, so removing
// it leaves the guard with no default branch to compare against and the
// push goes through. Step two (a local branch called main or master) is
// what every other test in this file exercises.

test('step one of the default-branch ladder: the remote HEAD symbolic reference', () => {
  const { work } = setup({ branch: 'trunk' });
  commitEverything(work, 'init', AGENT);
  assert.equal(git(work, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'trunk'], AGENT);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /refusing a push to the default branch \('trunk'\)/);
});

test('step three of the default-branch ladder: a remote-tracking main', () => {
  const { work } = setup({ branch: 'trunk' });
  commitEverything(work, 'init', AGENT);
  const head = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(git(work, ['update-ref', 'refs/remotes/origin/main', head]).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'trunk:main'], AGENT);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /refusing a push to the default branch \('main'\)/);
});

test('a ladder that resolves nothing says so instead of going quiet', () => {
  // The guard cannot run without a default branch to compare against. It
  // used to switch itself off in silence, which is indistinguishable from
  // a guard that is working.
  const { work } = setup({ branch: 'trunk' });
  commitEverything(work, 'init', AGENT);
  const r = git(work, ['push', '-q', 'origin', 'trunk'], AGENT);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /could not determine this vault's default branch/);
});

test('a human pushing into a vault with no resolvable default branch is not warned at all', () => {
  // The warning is about a guard that is not running, and the guard has
  // nothing to say about a human's push in the first place.
  const { work } = setup({ branch: 'trunk' });
  commitEverything(work, 'init');
  const r = git(work, ['push', '-q', 'origin', 'trunk']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /could not determine this vault's default branch/);
});

test('the ladder warning names the command that fixes it, not only the problem', () => {
  // A warning that says a guard is not running, without saying how to make
  // it run, is a warning a vault learns to scroll past. The remedy is part
  // of the message and is asserted as such.
  const { work } = setup({ branch: 'trunk' });
  commitEverything(work, 'init', AGENT);
  const r = git(work, ['push', '-q', 'origin', 'trunk'], AGENT);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /git remote set-head origin --auto/);
});

test('the ladder warning does NOT fire when the guard IS running, so it never becomes noise', () => {
  // The other half of the warning's own condition, and the half no test
  // reached: it warns when the default branch could not be DETERMINED, not
  // on every push an automation makes. Dropping the emptiness check makes
  // this vault, whose default branch resolves perfectly well, warn about a
  // guard that is running correctly on every single push, and a warning
  // that cries wolf on a healthy vault is worth less than no warning.
  const { work } = setup();
  commitEverything(work, 'init', AGENT);
  assert.equal(git(work, ['push', '-q', 'origin', 'main']).status, 0);
  assert.equal(git(work, ['checkout', '-q', '-b', 'agent/work'], AGENT).status, 0);
  writeFileSync(join(work, 'memory', 'log.md'), `${CLEAN_LOG}\nA second entry.\n`);
  commitEverything(work, 'more', AGENT);

  const r = git(work, ['push', '-q', 'origin', 'agent/work'], AGENT);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /could not determine this vault's default branch/);
});

// --- fix round 3: the two defects this template shipped to adopters -----------
//
// These two are the whole-slice review's findings A and B, driven where
// they actually bit: through the TEMPLATE gate, the one that ships in the
// tarball and refuses a push on a non-zero `lint` exit and nothing else.
// The maintainer's own gate (.githooks/pre-push) always covered both,
// because it scans blobs rather than notes; that difference is exactly
// why these two survived a whole slice of review.
//
// A fake credential, built at runtime from pieces, so no line of this
// repository ever holds something shaped like a real key.
const FAKE_AWS_KEY = `AKIA${'IOSFODNN7EXAMPL2'}`;

test('a credential committed in a NON-markdown file refuses the push, although no lint rule reads markdown from it', () => {
  // Before fix round 3 this push succeeded, silently: `lint` read
  // markdown and nothing else, reported zero errors, exited 0, and the
  // hook below has no other signal to read. The vault's own
  // privacy.secret_patterns and the shipped generic shapes both name this
  // key shape; neither could see the file it was in.
  const files = { ...cleanFiles(), 'deploy/secrets.env': `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n` };
  const { work } = setup({ files });
  commitEverything(work, 'init');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  assert.notEqual(r.status, 0, 'a credential in a .env file must refuse the push');
  assert.match(r.stderr, /brain-kit lint found a problem/);
});

test('one unrelated untracked scratch file cannot narrow the gate into accepting a committed secret', () => {
  // The exact reproduction from the review: the same vault refuses the
  // push, then a single unrelated untracked file appears and the same
  // push succeeds with exit 0. Two levers were closed for this, and both
  // are exercised here at once: the secrets rule no longer reads the
  // scope at all, and this hook now asks for `--base all` rather than the
  // default, which is the base a stray file can re-derive.
  const files = { ...cleanFiles(), 'people/ana.md': `${CLEAN_PERSON}\nKey: ${FAKE_AWS_KEY}\n` };
  const { work } = setup({ files });
  commitEverything(work, 'init');

  const before = git(work, ['push', '-q', 'origin', 'main']);
  assert.notEqual(before.status, 0, 'the committed secret must refuse the push');

  writeFileSync(join(work, 'scratch.tmp.txt'), 'an unrelated scratch file\n');
  const after = git(work, ['push', '-q', 'origin', 'main']);
  assert.notEqual(after.status, 0, 'one stray untracked file must not buy a push');
  assert.match(after.stderr, /brain-kit lint found a problem/);
});

test('the template asks lint for a base nothing in the working tree can re-derive', () => {
  // Read from the file itself, not inferred from behaviour: the base is
  // the one thing in this hook a person can change by accident and only
  // find out when a secret is already on a remote.
  const text = readFileSync(TEMPLATE_HOOK, 'utf8');
  assert.match(text, /"\$BRAIN_KIT" lint --base all/);
});

// --- final fix round 2: the whole-vault base as BEHAVIOUR, not as text ------
//
// The test above reads the base out of the file with a regular
// expression, and a review proved that is not enough: dropping `--base
// all` from the command while keeping the text in a comment kept the
// whole suite green, because every behavioural test used the secrets
// rule, which reads no base at all. This is the case that tells the two
// apart. A vault escalated `style` to error AFTER an old violation was
// already published; a push of an unrelated change from a feature branch
// must still be refused, because the gate judges what will exist on the
// remote. Under the interactive default the old line is not "added" by
// the branch, the rule sees nothing, and the push goes through.
test('a vault that escalated style to error refuses a feature-branch push over an old violation, because the gate lints the whole vault', () => {
  const dash = String.fromCharCode(0x2014);
  const files = { ...cleanFiles(), 'people/ana.md': `${CLEAN_PERSON}\nAn old line${dash}written before the rule was escalated.\n` };
  const { work } = setup({ files });
  commitEverything(work, 'init');
  const seeded = git(work, ['push', '-q', 'origin', 'main']);
  assert.equal(seeded.status, 0, `style is a warning here, so the first push is accepted: ${seeded.stderr}`);

  assert.equal(git(work, ['checkout', '-q', '-b', 'feature']).status, 0);
  const configPath = join(work, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.lint.style = { severity: 'error', forbidden_chars: [dash] };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeFileSync(join(work, 'memory', 'log.md'), `${CLEAN_LOG}\nAn unrelated, clean entry.\n`);
  commitEverything(work, 'escalate style, and an unrelated change');

  const r = git(work, ['push', '-q', 'origin', 'feature']);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /brain-kit lint found a problem/);
  assert.match(`${r.stdout}${r.stderr}`, /people\/ana\.md:\d+ {2}style\b/);
});

// --- final fix round 2: what the gate reads is what the push could publish ---

test('a committed .env refuses the push: the environment file itself, not a file merely named like one', () => {
  const files = { ...cleanFiles(), '.env': `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n` };
  const { work } = setup({ files });
  commitEverything(work, 'init');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  assert.notEqual(r.status, 0, 'a key in a committed .env must refuse the push');
  assert.match(`${r.stdout}${r.stderr}`, /\.env:1 {2}secrets\b/);
});

test('a credential in a file git ignores never refuses a push, because the push can never carry it', () => {
  const { work } = setup({ files: { ...cleanFiles(), '.gitignore': 'local-only/\n' } });
  mkdirSync(join(work, 'local-only'));
  writeFileSync(join(work, 'local-only', 'credentials'), `aws_access_key_id = ${FAKE_AWS_KEY}\n`);
  commitEverything(work, 'init');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  assert.equal(r.status, 0, r.stderr);
});

test('the configuration\'s own literal patterns no longer blank a real key out of it: a key pasted into a signature refuses the push', () => {
  const anthropicKey = `sk-ant-${'api03'}${'Q'.repeat(40)}`;
  const { work } = setup({ config: { curate: { signature: anthropicKey } } });
  commitEverything(work, 'init');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(`${r.stdout}${r.stderr}`, /brain-kit\.config\.json:\d+ {2}secrets\b/);
});

// --- final fix round 2: the ladder reads the remote's HEAD in full --------

test('a local branch named like the remote-tracking default does not switch the automation guard off', () => {
  // `git symbolic-ref --short` shortens to whatever is unambiguous, and a
  // local branch called "origin/main" makes that "remotes/origin/main",
  // which no strip of "origin/" undoes. The guard then compared every push
  // against a branch nothing can be pushed to, and this push went through
  // with exit 0 and no line from the hook.
  const { work } = setup();
  commitEverything(work, 'init', AGENT);
  const head = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(git(work, ['update-ref', 'refs/remotes/origin/main', head]).status, 0);
  assert.equal(git(work, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']).status, 0);
  assert.equal(git(work, ['branch', 'origin/main']).status, 0);
  assert.equal(git(work, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).stdout.trim(), 'remotes/origin/main', 'the ambiguity this test exists for');
  const r = git(work, ['push', '-q', 'origin', 'main'], AGENT);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /refusing a push to the default branch \('main'\)/);
});

test('a remote HEAD pointed at a local branch by hand still names that branch; one pointed anywhere else says the guard is not running', () => {
  const { work } = setup();
  commitEverything(work, 'init', AGENT);
  assert.equal(git(work, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/main']).status, 0);
  const refused = git(work, ['push', '-q', 'origin', 'main'], AGENT);
  assert.notEqual(refused.status, 0, refused.stderr);
  assert.match(refused.stderr, /refusing a push to the default branch \('main'\)/);

  assert.equal(git(work, ['tag', 'v-anchor']).status, 0);
  assert.equal(git(work, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/tags/v-anchor']).status, 0);
  const warned = git(work, ['push', '-q', 'origin', 'main'], AGENT);
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /could not determine this vault's default branch/);
});

// --- what the push CARRIES, not what the working tree shows --------------
//
// Until 22/09/2026 this template read the working tree and nothing else,
// and each of the first three cases below landed on a throwaway remote
// with the hook passing. Each is now refused by the object scan (brain-kit
// push-gate --patterns config), with the working tree clean of the match
// so that lint, which reads the working tree, passes and cannot be what
// refused.

// A literal the vault itself declares, the shape a person writes: a
// company name. Built at runtime like every other match in this suite.
const LITERAL = `zqx${'acmewidgets'}`;
const WITH_LITERAL = { privacy: { secret_patterns: ['ghp_[A-Za-z0-9]{20,}', LITERAL] } };

function landedRef(bare, ref) {
  return spawnSync('git', ['--git-dir', bare, 'rev-parse', '-q', '--verify', ref], { encoding: 'utf8' }).status === 0;
}

function holdsObject(bare, sha) {
  return spawnSync('git', ['--git-dir', bare, 'cat-file', '-e', sha]).status === 0;
}

function refusedByTheObjectScan(r) {
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /brain-kit push-gate refused what this push carries/);
  assert.doesNotMatch(r.stderr, /brain-kit lint found a problem/);
}

test('a credential committed and then deleted is refused, and the remote never receives either commit', () => {
  const { work, bare } = setup({ config: WITH_LITERAL });
  commitEverything(work, 'init');
  writeFileSync(join(work, 'people', 'ana.md'), `${CLEAN_PERSON}\nMet the ${LITERAL} team.\n`);
  commitEverything(work, 'a note');
  const leak = git(work, ['rev-parse', 'HEAD']).stdout.trim();
  writeFileSync(join(work, 'people', 'ana.md'), CLEAN_PERSON);
  commitEverything(work, 'remove it again');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  refusedByTheObjectScan(r);
  assert.match(r.stderr, /possible leak in people\/ana\.md \(CONTENT, at [0-9a-f]{7}\)/);
  assert.equal(landedRef(bare, 'refs/heads/main'), false);
  assert.equal(holdsObject(bare, leak), false);
});

test('a credential in the tip commit, hidden by an uncommitted edit that removes it, is refused', () => {
  const { work, bare } = setup({ config: WITH_LITERAL });
  writeFileSync(join(work, 'people', 'ana.md'), `${CLEAN_PERSON}\nMet the ${LITERAL} team.\n`);
  commitEverything(work, 'init');
  writeFileSync(join(work, 'people', 'ana.md'), CLEAN_PERSON);
  const r = git(work, ['push', '-q', 'origin', 'main']);
  refusedByTheObjectScan(r);
  assert.match(r.stderr, /possible leak in people\/ana\.md \(CONTENT/);
  assert.equal(landedRef(bare, 'refs/heads/main'), false);
});

test('a branch that is not checked out, carrying a credential, is refused', () => {
  const { work, bare } = setup({ config: WITH_LITERAL });
  commitEverything(work, 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main']).status, 0);
  assert.equal(git(work, ['checkout', '-q', '-b', 'side']).status, 0);
  writeFileSync(join(work, 'people', 'ana.md'), `${CLEAN_PERSON}\nMet the ${LITERAL} team.\n`);
  commitEverything(work, 'a note');
  assert.equal(git(work, ['checkout', '-q', 'main']).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'side']);
  refusedByTheObjectScan(r);
  assert.match(r.stderr, /possible leak in people\/ana\.md \(CONTENT/);
  assert.equal(landedRef(bare, 'refs/heads/side'), false);
});

test('a file whose NAME matches a configured pattern is refused on the PATH channel', () => {
  const files = { ...cleanFiles(), [`attachments/${LITERAL}-contract.txt`]: 'nothing in the text\n' };
  const { work, bare } = setup({ config: WITH_LITERAL, files });
  commitEverything(work, 'init');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  refusedByTheObjectScan(r);
  assert.match(r.stderr, /possible leak in a file name at [0-9a-f]{7} \(PATH, the name itself is withheld\)/);
  assert.equal(landedRef(bare, 'refs/heads/main'), false);
});

test('a commit message carrying a configured pattern is refused', () => {
  const { work, bare } = setup({ config: WITH_LITERAL });
  commitEverything(work, `init, after the ${LITERAL} call`);
  const r = git(work, ['push', '-q', 'origin', 'main']);
  refusedByTheObjectScan(r);
  assert.match(r.stderr, /possible leak in the message of commit [0-9a-f]{7} \(COMMIT MESSAGE\)/);
  assert.equal(landedRef(bare, 'refs/heads/main'), false);
});

// --- which configuration supplies the patterns ---------------------------

function withoutLiteralInConfig(work) {
  const configPath = join(work, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.privacy.secret_patterns = config.privacy.secret_patterns.filter((p) => p !== LITERAL);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// main declares the pattern and is published; the repository knows
// origin's default branch is main. A branch then deletes the pattern from
// its own configuration and violates it, and is checked out when pushed,
// so the working tree's configuration lacks the pattern too.
function setupBranchThatDropsThePattern() {
  const { work, bare } = setup({ config: WITH_LITERAL });
  commitEverything(work, 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main']).status, 0);
  assert.equal(git(work, ['remote', 'set-head', 'origin', 'main']).status, 0);
  assert.equal(git(work, ['checkout', '-q', '-b', 'drop-it']).status, 0);
  withoutLiteralInConfig(work);
  writeFileSync(join(work, 'people', 'ana.md'), `${CLEAN_PERSON}\nMet the ${LITERAL} team.\n`);
  commitEverything(work, 'drop the pattern, then use it');
  return { work, bare };
}

test('a branch whose own configuration deletes the pattern it then violates is refused: the default branch still declares it', () => {
  const { work, bare } = setupBranchThatDropsThePattern();
  const r = git(work, ['push', '-q', 'origin', 'drop-it']);
  refusedByTheObjectScan(r);
  assert.match(r.stderr, /from the default branch as this repository knows it \(origin\/main\)/);
  assert.match(r.stderr, /possible leak in people\/ana\.md \(CONTENT/);
  assert.equal(landedRef(bare, 'refs/heads/drop-it'), false);
});

test('the working tree\'s patterns count too: a pattern only the working tree declares refuses', () => {
  // The other half of the union. main is published WITHOUT the pattern and
  // is the default branch; the working tree adds it, uncommitted, and the
  // match sits in a commit.
  const { work, bare } = setup();
  writeFileSync(join(work, 'people', 'ana.md'), `${CLEAN_PERSON}\nMet the ${LITERAL} team.\n`);
  commitEverything(work, 'init');
  writeFileSync(join(work, 'people', 'ana.md'), CLEAN_PERSON);
  const configPath = join(work, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.privacy.secret_patterns.push(LITERAL);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  assert.equal(git(work, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']).status, 0);
  assert.equal(git(work, ['update-ref', 'refs/remotes/origin/main', 'HEAD']).status, 0);
  assert.doesNotMatch(git(work, ['show', 'origin/main:brain-kit.config.json']).stdout, new RegExp(LITERAL), 'the precondition: only the working tree declares it');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  refusedByTheObjectScan(r);
  assert.match(r.stderr, /possible leak in people\/ana\.md \(CONTENT/);
  assert.equal(landedRef(bare, 'refs/heads/main'), false);
});

test('with no default branch reference at all, the same branch is scanned with the working tree\'s and the tips\' patterns alone, the gate says so, and its remedy works', () => {
  // The stated exception, measured: with none of origin/HEAD, origin/main
  // or origin/master in this clone, a branch that drops its own pattern
  // is judged by its own configuration. The one line it prints names a
  // command, and running that command is what closes it.
  const { work, bare } = setupBranchThatDropsThePattern();
  assert.equal(spawnSync('git', ['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']).status, 0);
  assert.equal(git(work, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']).status, 0);
  assert.equal(git(work, ['update-ref', '-d', 'refs/remotes/origin/main']).status, 0);
  // A clean branch first, so the fallback is observed without landing the
  // leak.
  assert.equal(git(work, ['checkout', '-q', '-b', 'tidy', 'main']).status, 0);
  writeFileSync(join(work, 'memory', 'log.md'), `${CLEAN_LOG}\nA tidy entry.\n`);
  commitEverything(work, 'tidy');
  const tidy = git(work, ['push', '-q', 'origin', 'tidy']);
  assert.equal(tidy.status, 0, tidy.stderr);
  const said = tidy.stderr.match(/no default branch of remote 'origin' is known to this repository .* from the working tree's brain-kit\.config\.json and from the pushed tips alone\. To add the default branch's, run: (.+)$/m);
  assert.ok(said, tidy.stderr);
  assert.equal(said[1], 'git fetch origin && git remote set-head origin --auto');
  for (const step of said[1].split(' && ')) {
    const ran = git(work, step.split(' ').slice(1));
    assert.equal(ran.status, 0, `${step}: ${ran.stderr}`);
  }
  assert.equal(git(work, ['checkout', '-q', 'drop-it']).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'drop-it']);
  refusedByTheObjectScan(r);
  assert.equal(landedRef(bare, 'refs/heads/drop-it'), false);
});

test('a default branch that has no configuration yet says so and scans with the working tree\'s patterns', () => {
  const { work, bare } = setup({ config: WITH_LITERAL });
  commitEverything(work, 'init');
  // origin/main as this repository knows it: a commit with no configuration.
  const tree = spawnSync('git', ['mktree'], { cwd: work, input: '', encoding: 'utf8' }).stdout.trim();
  const empty = git(work, ['commit-tree', tree, '-m', 'before brain-kit']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(git(work, ['update-ref', 'refs/remotes/origin/main', empty.stdout.trim()]).status, 0);
  assert.equal(git(work, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'main']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /origin\/main, a default branch as this repository knows it, has no brain-kit\.config\.json/);
  assert.equal(landedRef(bare, 'refs/heads/main'), true);
});

// --- the vault's own configuration declares the patterns ------------------

test('a vault whose configuration declares a literal pattern pushes an edit to that configuration; the same literal in a note is refused', () => {
  const { work, bare } = setup({ config: WITH_LITERAL });
  commitEverything(work, 'init');
  const first = git(work, ['push', '-q', 'origin', 'main']);
  assert.equal(first.status, 0, first.stderr);
  const configPath = join(work, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.vault.title = "Ana's Second Brain, renamed";
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  commitEverything(work, 'rename the vault');
  const edit = git(work, ['push', '-q', 'origin', 'main']);
  assert.equal(edit.status, 0, edit.stderr);
  assert.match(edit.stderr, /leak gate ran/);

  assert.equal(git(work, ['checkout', '-q', '-b', 'note']).status, 0);
  writeFileSync(join(work, 'memory', 'log.md'), `${CLEAN_LOG}\nCall with ${LITERAL}.\n`);
  commitEverything(work, 'a note');
  writeFileSync(join(work, 'memory', 'log.md'), CLEAN_LOG);
  const note = git(work, ['push', '-q', 'origin', 'note']);
  refusedByTheObjectScan(note);
  assert.match(note.stderr, /possible leak in memory\/log\.md \(CONTENT/);
  assert.equal(landedRef(bare, 'refs/heads/note'), false);
});

test('the configuration is still read for credential shapes, and a copy of it at any other path for everything', () => {
  // A key pasted into the configuration and taken out again: lint, which
  // reads the working tree, has nothing to see; the object scan does.
  const { work, bare } = setup({ config: WITH_LITERAL });
  const configPath = join(work, 'brain-kit.config.json');
  const pasted = JSON.parse(readFileSync(configPath, 'utf8'));
  pasted.curate.signature = FAKE_AWS_KEY;
  writeFileSync(configPath, JSON.stringify(pasted, null, 2));
  commitEverything(work, 'init');
  pasted.curate.signature = 'Second brain curator (example)';
  writeFileSync(configPath, JSON.stringify(pasted, null, 2));
  commitEverything(work, 'take the key out');
  const key = git(work, ['push', '-q', 'origin', 'main']);
  refusedByTheObjectScan(key);
  assert.match(key.stderr, /possible leak in brain-kit\.config\.json \(CONTENT/);
  assert.equal(landedRef(bare, 'refs/heads/main'), false);

  // A copy elsewhere, taken out again, is an ordinary file.
  const { work: other, bare: otherBare } = setup({ config: WITH_LITERAL });
  mkdirSync(join(other, 'backup'));
  copyFileSync(join(other, 'brain-kit.config.json'), join(other, 'backup', 'brain-kit.config.json'));
  commitEverything(other, 'init');
  rmSync(join(other, 'backup'), { recursive: true });
  commitEverything(other, 'drop the copy');
  const copy = git(other, ['push', '-q', 'origin', 'main']);
  refusedByTheObjectScan(copy);
  assert.match(copy.stderr, /possible leak in backup\/brain-kit\.config\.json \(CONTENT/);
  assert.equal(landedRef(otherBare, 'refs/heads/main'), false);
});

test('the template\'s gate never reads the personal list: a personal pattern does not refuse, and a missing personal file does not either', () => {
  const files = { ...cleanFiles(), 'memory/log.md': `${CLEAN_LOG}\nzqxpersonalmark, which only the personal list names.\n` };
  const { work, bare } = setup({ files });
  commitEverything(work, 'init');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /leak gate ran/);
  assert.equal(landedRef(bare, 'refs/heads/main'), true);
  assert.equal(git(work, ['checkout', '-q', '-b', 'more']).status, 0);
  writeFileSync(join(work, 'memory', 'log.md'), `${CLEAN_LOG}\nA second entry.\n`);
  commitEverything(work, 'more');
  const missing = git(work, ['push', '-q', 'origin', 'more'], { env: { BRAIN_KIT_LEAK_PATTERNS: join(work, 'no such personal list.txt') } });
  assert.equal(missing.status, 0, missing.stderr);
  assert.doesNotMatch(missing.stderr, /leak patterns file/);
});

// --- the clean path, PATH, and the order of the steps ---------------------

test('a clean vault pushes, and the hook prints the gate\'s "ran" line', () => {
  const { work, bare } = setup();
  commitEverything(work, 'init');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /pre-push: brain-kit leak gate ran: scanned [1-9][0-9]* channel\(s\) across 1 reference\(s\) of this push; nothing matched\./);
  assert.equal(landedRef(bare, 'refs/heads/main'), true);
});

test('brain-kit absent from PATH refuses, names PATH, and never sends anyone to install it into the vault', () => {
  // A working brain-kit INSIDE the vault, where the template used to look
  // first, and none on PATH: the vault's copy must not be used.
  const { work, bare } = setup({ files: { ...cleanFiles(), '.gitignore': 'node_modules/\n' } });
  mkdirSync(join(work, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(work, 'node_modules', '.bin', 'brain-kit'), `#!/usr/bin/env bash\nexec node ${JSON.stringify(REAL_BIN)} "$@"\n`);
  chmodSync(join(work, 'node_modules', '.bin', 'brain-kit'), 0o755);
  commitEverything(work, 'init');
  const r = git(work, ['push', '-q', 'origin', 'main'], { env: { PATH: PATH_WITHOUT_BRAIN_KIT } });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /brain-kit was not found on PATH/);
  assert.doesNotMatch(r.stderr, /node_modules|dependenc|into (this|the) vault|of this vault/i);
  assert.equal(landedRef(bare, 'refs/heads/main'), false);
});

test('the template resolves brain-kit from PATH only, and hands push-gate the config list and git\'s own two arguments', () => {
  const text = readFileSync(TEMPLATE_HOOK, 'utf8');
  assert.doesNotMatch(text.replace(/^#.*$/gm, ''), /node_modules/);
  assert.match(text, /"\$BRAIN_KIT" push-gate "\$\{1:-\}" "\$\{2:-\}" --patterns config < "\$REF_LINES"/);
});

test('a push by url that carries a token prints it nowhere', () => {
  // git rewrites the typed url to the throwaway remote, and hands the hook
  // the url as typed for its first argument. The guard's warning and
  // push-gate's line about the default branch both name that argument.
  const { work, bare } = setup({ branch: 'trunk' });
  const token = 'tok3nzz91';
  const typed = `https://ana:${token}@example.invalid/vault.git`;
  assert.equal(git(work, ['config', `url.${bare}.insteadOf`, typed]).status, 0);
  commitEverything(work, 'init', AGENT);
  const r = git(work, ['push', '-q', typed, 'trunk'], AGENT);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, new RegExp(token));
  assert.match(r.stderr, /'https:\/\/example\.invalid\/vault\.git' is not the name of a remote, and no configured remote \(origin\) has a default branch/);
  // The guard's remedy names the push by remote name, not a set-head of a
  // url, which only fails.
  assert.match(r.stderr, /'https:\/\/example\.invalid\/vault\.git' is not the name of a remote: push by the remote's name/);
  assert.doesNotMatch(r.stderr, /set-head https:/);
  assert.equal(landedRef(bare, 'refs/heads/trunk'), true);
});

test('the template hands push-gate the url git pushes to: a pushurl that differs from the fetch url is scanned against the destination', () => {
  // The fetch url already holds a branch carrying the match; the push goes
  // to a pushurl that holds nothing. Asked about the fetch url, the gate
  // would exclude every commit of it.
  const { root, work } = setup({ config: WITH_LITERAL });
  commitEverything(work, 'init');
  assert.equal(git(work, ['checkout', '-q', '-b', 'leaky']).status, 0);
  writeFileSync(join(work, 'people', 'ana.md'), `${CLEAN_PERSON}\nMet the ${LITERAL} team.\n`);
  commitEverything(work, 'a note');
  writeFileSync(join(work, 'people', 'ana.md'), CLEAN_PERSON);
  const fetchUrl = join(root, 'fetch.git');
  assert.equal(spawnSync('git', ['clone', '-q', '--bare', work, fetchUrl]).status, 0);
  const destination = join(root, 'destination.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', destination]).status, 0);
  assert.equal(git(work, ['remote', 'set-url', 'origin', fetchUrl]).status, 0);
  assert.equal(git(work, ['config', 'remote.origin.pushurl', destination]).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'leaky']);
  refusedByTheObjectScan(r);
  assert.match(r.stderr, /possible leak in people\/ana\.md \(CONTENT/);
  assert.equal(landedRef(destination, 'refs/heads/leaky'), false);
});

// --- fix round 1: every source the union reads, by real push -------------

test('a new vault wired with remote add and a first push has no origin/HEAD; a pattern-dropping branch is still refused, through origin/main', () => {
  const { work, bare } = setup({ config: WITH_LITERAL });
  commitEverything(work, 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main']).status, 0);
  assert.notEqual(git(work, ['rev-parse', '-q', '--verify', 'refs/remotes/origin/HEAD']).status, 0, 'the precondition: no origin/HEAD');
  assert.equal(git(work, ['rev-parse', '-q', '--verify', 'refs/remotes/origin/main']).status, 0, 'the precondition: origin/main');
  assert.equal(git(work, ['checkout', '-q', '-b', 'drop-it']).status, 0);
  withoutLiteralInConfig(work);
  writeFileSync(join(work, 'people', 'ana.md'), `${CLEAN_PERSON}\nMet the ${LITERAL} team.\n`);
  commitEverything(work, 'drop the pattern, then use it');
  const r = git(work, ['push', '-q', 'origin', 'drop-it']);
  refusedByTheObjectScan(r);
  assert.match(r.stderr, /from the default branch as this repository knows it \(origin\/main\)/);
  // A default branch resolved, so the fallback line is not printed: a line
  // on every push is a line people stop reading.
  assert.doesNotMatch(r.stderr, /no default branch of remote|is not the name of a remote/);
  assert.equal(landedRef(bare, 'refs/heads/drop-it'), false);

  // The same branch pushed BY URL: every configured remote's default
  // branch is read.
  const byUrl = git(work, ['push', '-q', bare, 'drop-it']);
  refusedByTheObjectScan(byUrl);
  assert.match(byUrl.stderr, /from the default branch as this repository knows it \(origin\/main\)/);
  assert.equal(landedRef(bare, 'refs/heads/drop-it'), false);
});

test('a pattern the pushed branch adds is honoured while another branch is checked out', () => {
  const { work, bare } = setup();
  commitEverything(work, 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main']).status, 0);
  assert.equal(git(work, ['checkout', '-q', '-b', 'adds']).status, 0);
  const configPath = join(work, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.privacy.secret_patterns.push(LITERAL);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeFileSync(join(work, 'people', 'ana.md'), `${CLEAN_PERSON}\nMet the ${LITERAL} team.\n`);
  commitEverything(work, 'add a pattern and a match');
  writeFileSync(join(work, 'people', 'ana.md'), CLEAN_PERSON);
  commitEverything(work, 'take the match out again');
  assert.equal(git(work, ['checkout', '-q', 'main']).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'adds']);
  refusedByTheObjectScan(r);
  assert.match(r.stderr, /possible leak in people\/ana\.md \(CONTENT/);
  assert.equal(landedRef(bare, 'refs/heads/adds'), false);
});

test('a plain-text note saved as brain-kit.config.json is an ordinary file, read against every pattern', () => {
  const { work, bare } = setup({ config: WITH_LITERAL });
  commitEverything(work, 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main']).status, 0);
  assert.equal(git(work, ['checkout', '-q', '-b', 'notes']).status, 0);
  writeFileSync(join(work, 'brain-kit.config.json'), `Meeting notes: the ${LITERAL} renewal.\n`);
  assert.equal(git(work, ['add', '-A']).status, 0);
  assert.equal(git(work, ['commit', '-q', '-m', 'a note under that name']).status, 0);
  assert.equal(git(work, ['checkout', '-q', 'main']).status, 0);
  const r = git(work, ['push', '-q', 'origin', 'notes']);
  refusedByTheObjectScan(r);
  assert.match(r.stderr, /the brain-kit\.config\.json at reference #1 of this push could not be used/);
  assert.match(r.stderr, /possible leak in brain-kit\.config\.json \(CONTENT/);
  assert.equal(landedRef(bare, 'refs/heads/notes'), false);
});

test('a file named like the configuration in another case is an ordinary file', () => {
  // Byte for byte: Brain-Kit.Config.json at the vault root, a JSON object,
  // carrying the literal and taken out again. A comparison that folds case
  // would exempt it.
  const { work, bare } = setup({ config: WITH_LITERAL });
  commitEverything(work, 'init');
  writeFileSync(join(work, 'Brain-Kit.Config.json'), JSON.stringify({ note: `the ${LITERAL} contract` }));
  commitEverything(work, 'a lookalike');
  unlinkSync(join(work, 'Brain-Kit.Config.json'));
  commitEverything(work, 'gone again');
  const r = git(work, ['push', '-q', 'origin', 'main']);
  refusedByTheObjectScan(r);
  assert.match(r.stderr, /possible leak in Brain-Kit\.Config\.json \(CONTENT/);
  assert.equal(landedRef(bare, 'refs/heads/main'), false);
});

test('a local replace ref over the default branch\'s configuration does not change the patterns', () => {
  const { work, bare } = setupBranchThatDropsThePattern();
  const merged = git(work, ['rev-parse', 'origin/main:brain-kit.config.json']).stdout.trim();
  const dropped = git(work, ['rev-parse', 'drop-it:brain-kit.config.json']).stdout.trim();
  assert.notEqual(merged, dropped);
  assert.equal(git(work, ['replace', merged, dropped]).status, 0);
  assert.doesNotMatch(git(work, ['show', 'origin/main:brain-kit.config.json']).stdout, new RegExp(LITERAL), 'the precondition: an ordinary read now sees the replacement');
  const r = git(work, ['push', '-q', 'origin', 'drop-it']);
  refusedByTheObjectScan(r);
  assert.equal(landedRef(bare, 'refs/heads/drop-it'), false);
});

test('reference lines that cannot all be read refuse: a cat that stops after one line and fails', () => {
  // push-gate cross-checks what it is handed, so a truncation BEFORE it
  // agrees with itself. Only the hook's own read can catch it.
  const { root, work, bare } = setup({ config: WITH_LITERAL });
  commitEverything(work, 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main']).status, 0);
  assert.equal(git(work, ['branch', 'aaa-clean']).status, 0);
  assert.equal(git(work, ['checkout', '-q', '-b', 'zzz-leaky']).status, 0);
  writeFileSync(join(work, 'people', 'ana.md'), `${CLEAN_PERSON}\nMet the ${LITERAL} team.\n`);
  commitEverything(work, 'a note');
  writeFileSync(join(work, 'people', 'ana.md'), CLEAN_PERSON);
  commitEverything(work, 'take it out');
  assert.equal(git(work, ['checkout', '-q', 'main']).status, 0);
  const brokenBin = join(root, 'a broken cat');
  mkdirSync(brokenBin);
  writeFileSync(join(brokenBin, 'cat'), '#!/usr/bin/env bash\nIFS= read -r first\nprintf \'%s\\n\' "$first"\nexit 1\n');
  chmodSync(join(brokenBin, 'cat'), 0o755);
  const r = git(work, ['push', '-q', 'origin', 'aaa-clean', 'zzz-leaky'], { env: { PATH: `${brokenBin}${delimiter}${PATH_WITH_BRAIN_KIT}` } });
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /could not read the reference lines git sent for this push/);
  assert.equal(landedRef(bare, 'refs/heads/aaa-clean'), false);
  assert.equal(landedRef(bare, 'refs/heads/zzz-leaky'), false);
});
