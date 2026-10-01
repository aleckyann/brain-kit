// `brain-kit curate` over a vault whose include_projects says `{vault}`: the
// project is the one Claude Code names for THIS clone's folder, so one
// configuration serves every clone and machine (the second stranger's
// F1/D2, 01/10/2026). The world is test/helpers/curate-world.mjs: a vault
// cloned from a bare remote, a fake claude, a transcripts folder of its own.
// A second clone of the same remote, at another path and with a machine file
// of its own, stands for the second machine (or a second clone on the first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { claudeProjectName } from '../src/sources/transcripts-claude-code.mjs';
import { git } from './helpers/git-repo.mjs';
import { BIN, makeCurateWorld, utcDay } from './helpers/curate-world.mjs';
import { assistant, user } from './helpers/transcripts-world.mjs';

const en = createTranslator('en');
const WAY_OUT = 'If this vault is also used on another machine, use {vault} instead of a project name so the same configuration works on both.';

const entry = (c) => {
  c.sources.transcripts.include_projects = ['{vault}'];
  // The world lives under the temporary directory, so the name of its project starts with -tmp-,
  // which the default exclude_path_patterns leave out: this world excludes nothing.
  c.sources.transcripts.exclude_path_patterns = [];
};

let sessions = 0;
// `count` sessions of yesterday in the project `name` of the world's projects folder.
function session(w, name, count = 1) {
  const dir = join(w.projects, name);
  mkdirSync(dir, { recursive: true });
  const at = `${utcDay(-1)}T12:00:00.000Z`;
  for (let i = 0; i < count; i += 1) {
    sessions += 1;
    const file = join(dir, `${String(sessions).padStart(8, '0')}-1111-4222-8333-444444444444.jsonl`);
    writeFileSync(file, `${[user(`Ana decides number ${sessions}`, at), assistant('Noted.', at)].map((l) => JSON.stringify(l)).join('\n')}\n`);
  }
}

// A clone of the world's vault: where it is, its state directory, the name of
// its project, and `curate` run on it from a folder that is neither clone.
function at(w, dir, state) {
  return {
    dir,
    state,
    own: claudeProjectName(realpathSync(dir)),
    curate(args = [], extraEnv = {}) {
      return spawnSync(process.execPath, [BIN, 'curate', ...args, dir], { cwd: w.base, env: { ...w.env, BRAIN_KIT_STATE_DIR: state, ...extraEnv }, encoding: 'utf8', timeout: 120000 });
    },
  };
}

// The second clone, at another path, with a machine file of its own and the
// same projects folder.
function clone(w, ...path) {
  const dir = join(w.base, ...path);
  mkdirSync(dirname(dir), { recursive: true });
  git(w.base, ['clone', '-q', w.remote, dir]);
  const state = join(w.base, `state-${path.join('-')}`);
  mkdirSync(state, { mode: 0o700 });
  const machine = { ...w.machine, canonical_path: dir, paths: { watermark: join(state, 'watermark.json'), last_run: join(state, 'last-run.json'), log_dir: join(state, 'logs') } };
  writeFileSync(join(state, 'machine.json'), `${JSON.stringify(machine, null, 2)}\n`, { mode: 0o600 });
  return at(w, dir, state);
}

const noSessions = (w, who, root = w.projects) => en('sources.transcripts.no_sessions_yet', { project: who.own, root });

// Rewrites the list of the world's own vault, committed and pushed (a real
// round syncs first).
function setList(w, names) {
  const file = join(w.vault, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.sources.transcripts.include_projects = names;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  git(w.vault, ['add', '-A']);
  git(w.vault, ['commit', '-q', '-m', 'list projects']);
  git(w.vault, ['push', '-q', 'origin', 'main']);
}

test('curate --dry on two clones of one vault at different paths, one configuration (the entry only): each reads the project of its own path, none refuses, and a folder made for B alone leaves A with no sessions yet', () => {
  const w = makeCurateWorld({ config: entry });
  const a = at(w, w.vault, w.state);
  const b = clone(w, 'Users', 'ana', 'my-brain');
  assert.notEqual(a.own, b.own);
  assert.equal(readFileSync(join(b.dir, 'brain-kit.config.json'), 'utf8'), readFileSync(join(a.dir, 'brain-kit.config.json'), 'utf8'), 'the one configuration');
  assert.ok(readFileSync(join(a.dir, 'brain-kit.config.json'), 'utf8').includes('"{vault}"'));

  // The world's own session sits in a project that is neither: no clone reads it.
  for (const me of [a, b]) {
    const dry = me.curate(['--dry']);
    assert.equal(dry.status, EXIT.OK, dry.stdout + dry.stderr);
    assert.ok(dry.stdout.includes(noSessions(w, me)), dry.stdout);
    assert.match(dry.stdout, /Source transcripts: 0 file\(s\) in the window/);
    assert.doesNotMatch(dry.stdout + dry.stderr, /not set up|would refuse|project_missing|no_projects|own_project_missing/);
  }

  session(w, b.own, 2);
  let dry = a.curate(['--dry']);
  assert.equal(dry.status, EXIT.OK, dry.stdout + dry.stderr);
  assert.ok(dry.stdout.includes(noSessions(w, a)), 'A still has no sessions yet');
  assert.match(dry.stdout, /Source transcripts: 0 file\(s\) in the window/);
  dry = b.curate(['--dry']);
  assert.equal(dry.status, EXIT.OK, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /Source transcripts: 2 file\(s\) in the window/);
  assert.ok(!dry.stdout.includes(noSessions(w, b)));

  session(w, a.own, 1);
  assert.match(a.curate(['--dry']).stdout, /Source transcripts: 1 file\(s\) in the window/);
  assert.match(b.curate(['--dry']).stdout, /Source transcripts: 2 file\(s\) in the window/);
});

test('a round reads the sessions of the project the entry stands for, and closes the day it read', () => {
  const w = makeCurateWorld({ config: entry });
  const own = claudeProjectName(realpathSync(w.vault));
  session(w, own, 1);
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.lastRun().sources.transcripts, { kept: 1, read: 1, advanced: true, noTimestamp: 0 });
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
});

test('a new vault whose list is the entry: its project has no folder yet, which is no fault; the round says so, exits 0 and closes the day empty, and nothing says to fix the configuration', () => {
  const w = makeCurateWorld({ config: entry });
  const me = at(w, w.vault, w.state);
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.ok(r.stderr.includes(noSessions(w, me)), r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /not set up|fix machine\.json|fix brain-kit\.config\.json/);
  assert.equal(w.lastRun().reasonCode, 'nothing_to_curate');
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
});

test('a new vault whose list is the entry, on a machine where Claude Code never ran: the default projects folder is not there either, and the round says the same, exit 0', () => {
  const w = makeCurateWorld({ config: entry });
  w.setMachine({ transcripts_dir: undefined });
  const me = at(w, w.vault, w.state);
  const env = { CLAUDE_CONFIG_DIR: '' };
  const folder = join(w.env.HOME, '.claude', 'projects');
  assert.ok(!existsSync(folder));
  const dry = me.curate(['--dry'], env);
  assert.equal(dry.status, EXIT.OK, dry.stdout + dry.stderr);
  assert.ok(dry.stdout.includes(noSessions(w, me, folder)), dry.stdout);
  const r = w.curate([], env);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'nothing_to_curate');
});

test('the entry beside a name: both are read, and the project with no sessions yet waits', () => {
  const w = makeCurateWorld({ config: (c) => { entry(c); c.sources.transcripts.include_projects = ['{vault}', '-home-ana-brain']; } });
  const me = at(w, w.vault, w.state);
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.ok(r.stderr.includes(noSessions(w, me)), r.stderr);
  assert.deepEqual(w.lastRun().sources.transcripts, { kept: 1, read: 1, advanced: true, noTimestamp: 0 });
});

const GUARDS = [
  ['a name that is not the vault\'s own beside the entry, nothing found', (w) => setList(w, ['{vault}', '-home-ana-typo']), /fix brain-kit\.config\.json sources\.transcripts\.include_projects/, {}],
  ['a projects folder named on purpose that is not there', (w) => w.setMachine({ transcripts_dir: join(w.base, 'nowhere') }), /fix machine\.json transcripts_dir/, {}],
  ['the default folder present without the vault\'s project, CLAUDE_CONFIG_DIR set and no folder named', (w) => {
    w.setMachine({ transcripts_dir: undefined });
    mkdirSync(join(w.env.HOME, '.claude', 'projects'), { recursive: true });
  }, /fix machine\.json transcripts_dir/, {}],
  ['the default folder absent, CLAUDE_CONFIG_DIR set and no folder named', (w) => {
    w.setMachine({ transcripts_dir: undefined });
  }, /fix machine\.json transcripts_dir/, {}],
  ['the entry beside a name that is not there, the default folder absent', (w) => {
    setList(w, ['{vault}', '-home-ana-typo']);
    w.setMachine({ transcripts_dir: undefined });
  }, /fix machine\.json transcripts_dir/, { CLAUDE_CONFIG_DIR: '' }],
  ['a broken link where the default folder should be', (w) => {
    w.setMachine({ transcripts_dir: undefined });
    mkdirSync(join(w.env.HOME, '.claude'), { recursive: true });
    symlinkSync(join(w.base, 'unmounted', 'volume'), join(w.env.HOME, '.claude', 'projects'));
  }, /fix machine\.json transcripts_dir/, { CLAUDE_CONFIG_DIR: '' }],
  ['a file where the default folder should be', (w) => {
    w.setMachine({ transcripts_dir: undefined });
    mkdirSync(join(w.env.HOME, '.claude'), { recursive: true });
    writeFileSync(join(w.env.HOME, '.claude', 'projects'), 'not a folder');
  }, /fix machine\.json transcripts_dir/, { CLAUDE_CONFIG_DIR: '' }],
];

for (const [label, prepare, setting, extraEnv] of GUARDS) {
  test(`the guards hold for the entry, dry and real alike: ${label} refuses with exit 1, moves no mark, and names the setting that can fix it`, () => {
    const w = makeCurateWorld({ config: entry });
    prepare(w);
    const dry = w.curate(['--dry'], extraEnv);
    assert.equal(dry.status, EXIT.FAILURE, dry.stdout + dry.stderr);
    assert.match(dry.stderr, /Dry run: a real round would refuse to run now \(exit 1\)\./);
    assert.match(dry.stderr, setting);
    const real = w.curate([], extraEnv);
    assert.equal(real.status, EXIT.FAILURE, real.stderr);
    assert.match(real.stderr, setting);
    assert.equal(w.watermark(), null);
    // The vault's own project is never offered as a name to correct in the shared file.
    if (setting.source.includes('machine')) assert.doesNotMatch(real.stderr, /fix brain-kit\.config\.json/);
  });
}

test('the vault\'s own project missing under CLAUDE_CONFIG_DIR beside a project that is there: the round goes on, reads that one and warns, exit 0 (the doctor warns and exits 0 too)', () => {
  const w = makeCurateWorld({ config: (c) => { entry(c); c.sources.transcripts.include_projects = ['{vault}', '-home-ana-brain']; } });
  w.setMachine({ transcripts_dir: undefined });
  // The default projects folder holds the world's other project, with its session, and not the vault's.
  const folder = join(w.env.HOME, '.claude', 'projects');
  mkdirSync(join(folder, '-home-ana-brain'), { recursive: true });
  writeFileSync(join(folder, '-home-ana-brain', 'bbbbbbbb-1111-4222-8333-444444444444.jsonl'), readFileSync(w.transcript));
  const me = at(w, w.vault, w.state);
  const dry = me.curate(['--dry']);
  assert.equal(dry.status, EXIT.OK, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /Source transcripts: 1 file\(s\) in the window/);
  assert.ok(dry.stdout.includes(en('sources.transcripts.problem_own_project_missing', { project: me.own, token: '{vault}', root: folder })), dry.stdout);
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.lastRun().sources.transcripts, { kept: 1, read: 1, advanced: true, noTimestamp: 0 });
});

test('a vault made before the entry, its configuration naming machine 1\'s project, run on a clone at another path: the round\'s diagnosis is today\'s, with the way out added; on machine 1 nothing changes', () => {
  const w = makeCurateWorld();
  const a = at(w, w.vault, w.state);
  setList(w, [a.own]);
  const b = clone(w, 'Users', 'ana', 'my-brain');
  // Machine 1: its own name, no sessions yet, nothing said about a way out.
  let dry = a.curate(['--dry']);
  assert.equal(dry.status, EXIT.OK, dry.stdout + dry.stderr);
  assert.ok(dry.stdout.includes(noSessions(w, a)));
  assert.doesNotMatch(dry.stdout + dry.stderr, /\{vault\}/);
  // The clone: machine 1's name is not a project here.
  dry = b.curate(['--dry']);
  assert.equal(dry.status, EXIT.FAILURE, dry.stdout + dry.stderr);
  assert.match(dry.stderr, /Dry run: a real round would refuse to run now \(exit 1\)\./);
  assert.match(dry.stderr, /fix brain-kit\.config\.json sources\.transcripts\.include_projects/);
  assert.ok(dry.stderr.includes(a.own));
  assert.ok(dry.stderr.includes(WAY_OUT), dry.stderr);
});

test('a name that is a typo, on the world\'s own vault: the refusal carries the way out, in the real round too', () => {
  const w = makeCurateWorld();
  setList(w, ['-home-ana-typo']);
  const real = w.curate();
  assert.equal(real.status, EXIT.FAILURE, real.stderr);
  assert.match(real.stderr, /fix brain-kit\.config\.json sources\.transcripts\.include_projects/);
  assert.ok(real.stderr.includes(WAY_OUT), real.stderr);
  // And in Portuguese.
  const pt = makeCurateWorld({ config: (c) => { c.lang = 'pt-BR'; c.sources.transcripts.include_projects = ['-home-ana-typo']; } });
  const dry = pt.curate(['--dry']);
  assert.equal(dry.status, EXIT.FAILURE, dry.stdout + dry.stderr);
  assert.ok(dry.stderr.includes('Se este vault também é usado em outra máquina, use {vault} no lugar de um nome de projeto, para que a mesma configuração sirva nas duas.'), dry.stderr);
});

test('a vault whose project cannot be named from its path refuses with its own reason, not "no project is listed"', () => {
  const w = makeCurateWorld({ config: entry });
  const long = join(w.base, 'v'.repeat(210));
  mkdirSync(long);
  git(w.base, ['clone', '-q', w.remote, join(long, 'vault')]);
  const dir = join(long, 'vault');
  assert.equal(claudeProjectName(realpathSync(dir)), null, 'the premise');
  const state = join(w.base, 'state-long');
  mkdirSync(state, { mode: 0o700 });
  const machine = { ...w.machine, canonical_path: dir, paths: { watermark: join(state, 'watermark.json'), last_run: join(state, 'last-run.json'), log_dir: join(state, 'logs') } };
  writeFileSync(join(state, 'machine.json'), `${JSON.stringify(machine, null, 2)}\n`, { mode: 0o600 });
  const dry = spawnSync(process.execPath, [BIN, 'curate', '--dry', dir], { cwd: w.base, env: { ...w.env, BRAIN_KIT_STATE_DIR: state }, encoding: 'utf8', timeout: 120000 });
  assert.equal(dry.status, EXIT.FAILURE, dry.stdout + dry.stderr);
  assert.match(dry.stderr, /Dry run: a real round would refuse to run now \(exit 1\)\./);
  assert.match(dry.stderr, /The Claude Code project of this vault cannot be told from its path .*, so \{vault\} in sources\.transcripts\.include_projects stands for nothing here/);
  assert.doesNotMatch(dry.stderr, /No project is listed/);
});
