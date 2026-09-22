// templates/githooks/pre-push: the version an ADOPTING vault installs, as
// opposed to .githooks/pre-push (this checkout's own maintainer gate,
// covered by test/pre-push-hook.test.mjs). This file proves the template's
// three jobs (task-7-brief.md): run validate, run lint, and refuse a push
// to the vault's own default branch made under its own configured
// automation identity. Every push here goes to a throwaway bare remote,
// exactly like test/pre-push-hook.test.mjs's own standing rule; the live
// gate is never bypassed to test it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs';
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

function git(cwd, args, { name = HUMAN_NAME, email = HUMAN_EMAIL, env = {} } = {}) {
  return spawnSync('git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// Builds a throwaway vault (makeVault) wired up exactly like an adopting
// vault would be: the template hook installed at .githooks/pre-push,
// core.hooksPath pointed at it, a bare remote, and a node_modules/.bin/
// brain-kit shim so the template's own `resolve_brain_kit` finds a real,
// working binary without needing brain-kit on PATH or a real npm install.
function setup({ config = {}, files = cleanFiles(), branch = 'main' } = {}) {
  const root = makeTempDir('brain-kit-prepush-template-');
  const bare = join(root, 'origin.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);

  const work = makeVault({ files, config });
  assert.equal(spawnSync('git', ['init', '-q', '-b', branch, work]).status, 0);

  mkdirSync(join(work, '.githooks'));
  copyFileSync(TEMPLATE_HOOK, join(work, '.githooks', 'pre-push'));
  chmodSync(join(work, '.githooks', 'pre-push'), 0o755);

  mkdirSync(join(work, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(work, 'node_modules', '.bin', 'brain-kit'), `#!/usr/bin/env bash\nexec node ${JSON.stringify(REAL_BIN)} "$@"\n`);
  chmodSync(join(work, 'node_modules', '.bin', 'brain-kit'), 0o755);

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
