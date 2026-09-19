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
import { mkdirSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs';
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
  // The `secrets` and `style` rules only judge lines a change ADDED
  // (src/git.mjs's own `auto` base), which is empty by construction for a
  // single commit that is already fully committed on the default branch
  // with nothing left in the worktree: there is nothing "added" left to
  // see by the time a push happens. `privacy` (lint.privacy, error by
  // default in the fixture config) has no such scope: a link from OUTSIDE
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
